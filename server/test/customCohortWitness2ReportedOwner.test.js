import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { describeNeighborhoodCachedMarketDataPurpose, describeNeighborhoodSaleWitnessMarketDataPurpose,
  describeNeighborhoodCombinedEvidenceMarketDataPurpose } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';

const PROFILE = getCustomCohortReportedSaleWitnessV2Profile();
const MODES = ['cad4', 'combined-witness2-v1'];
const SHARED = 'selected-shared-source-records';
const rawPayload = { MlsStatus: 'Closed', CloseDate: '2024-03-01', ClosePrice: '312345.125', ClosePriceCurrency: 'USD',
  CurrentPrice: '329000', CurrentPriceCurrency: 'USD', LivingArea: '180.5', LivingAreaUnits: 'Square Meters',
  LotSizeArea: '0.25', LotSizeUnits: 'Acres', YearBuilt: '1999', DaysOnMarket: '12' };
const copy = value => structuredClone(value);
const publicationWrites = calls => calls.filter(c => /\bINSERT INTO app\.neighborhood_|\bUPDATE app\.neighborhood_/.test(c.text));
const reportWrites = calls => calls.filter(c => /\bINSERT INTO app\.custom_|\bUPDATE app\.(?:custom_|assignment_files)/.test(c.text));
const readsHash = (call, hash) => /neighborhood-cohort-blob:read \*/.test(call.text) ? call.values[1] === hash
  : /neighborhood-cohort-blob:read-batch \*/.test(call.text) && call.values[1].includes(hash);
const sourceReads = f => {
  const hashes = f.f.input.retained_inputs.acquisition.capture_result.source_capture.source_snapshots.map(s => s.content_sha256);
  return f.state.calls.filter(c => hashes.some(hash => readsHash(c, hash)));
};
const sourceStatement = f => f.state.calls.find(c => c.text.includes('/* neighborhood:source */') && c.values[2] === `${SHARED}:observations`);
const sourcePayload = f => JSON.parse(sourceStatement(f).values[6]);
const assessment = f => f.state.db.assessments.get(f.state.db.head.current_revision);
const metric = (value, name) => value.statistics.find(s => s.id === `${SHARED}:${name}:median`);
const grant = f => ({ allowed: true, ...f.f.input.retained_inputs.acquisition.captured_query_request.market_decision });
const captureRequest = f => ({ auth: f.input.auth, accountId: f.input.accountId, assignmentFileId: f.input.assignmentFileId,
  operationId: f.input.contextRef.context_id, observationPeriod: f.f.input.expected.observation_period });

// Actual acquisition/prepare/persist/reopen, report assembler, publication and
// Apply validators. The shared owner SQL double is not a native concurrency or
// source-rights oracle; none of these tests performs production queries.
async function fixture({ marked = true, mappingVersion = 5, sourceMode, effectiveDate = '2026-09-06', payload = rawPayload } = {}) {
  const captureFixture = await cadEvidenceFixture({ assignmentFileId: '41', effectiveDate, mappingVersion,
    ...(mappingVersion === 5 ? { rawPayload: payload } : {}),
    ...(marked ? { reportedSaleInterpretation: copy(PROFILE.profile_ref) } : {}) });
  return reportedReplacementOwnerFixture({ captureFixture, sourceMode });
}

test('trusted owner source mode is closed and rejected before pool inspection; caller requests cannot select it', async () => {
  for (const sourceMode of [null, '', 'combined', 'combined-witness2-v2', 5, {}, ['cad4']]) {
    const pool = { get connect() { assert.fail('invalid source mode must fail before pool inspection'); } };
    assert.throws(() => createCustomCohortContextCapture({ pool, sourceMode, authorizeMarketData() {} }),
      { message: 'custom_cohort_capture_source_mode_invalid' });
  }
  const f = await fixture();
  for (const extra of [{ sourceMode: 'combined-witness2-v1' }, { reported_sale_interpretation: PROFILE.profile_ref },
    { source_projection: { mapping_version: 5 } }]) {
    await assert.rejects(f.service.capture({ ...captureRequest(f), ...extra }), { reason: 'invalid_input' });
    await assert.rejects(f.service.prepareReportedObservations({ ...f.input, ...extra }), /invalid_input|invalid_reported_input/);
  }
  assert.equal(f.state.phases, 0);
});

for (const sourceMode of MODES) for (const marked of [false, true]) {
  test(`${sourceMode} report uses ${marked ? 'pinned Witness2' : 'legacy unmarked mapping5'} semantics, never today\'s producer mode`, async () => {
    const f = await fixture({ sourceMode, marked }), before = json(f.f.input.retained_inputs);
    const result = await f.service.prepareReportedObservations(f.input);
    assert.equal(result.status, 'proposed'); assert.equal(result.reused, false);
    const stored = assessment(f), payload = sourcePayload(f), statement = sourceStatement(f);
    assert.equal(stored.contract_version, 2);
    assert.equal(statement.values[4], assessmentEvidenceDigest(payload));
    assert.deepEqual(payload.binding.context_ref, f.input.contextRef);
    assert.equal(stored.diagnostics.authority, 'not_established');
    assert.equal(f.state.db.section, null); assert.equal(f.state.db.acceptances.size, 0);
    assert.equal(reportWrites(f.state.calls).length, 0, 'proposal is not implicit report adoption');
    assert.equal(Object.hasOwn(payload, 'interpretation'), marked);
    if (marked) {
      assert.deepEqual(payload.interpretation, PROFILE);
      for (const [name, value, unit] of [['reported_close_price', '312345.125', 'USD'],
        ['reported_current_price', '329000', 'USD'], ['reported_living_area', '180.5', 'sqm'], ['reported_site_area', '0.25', 'acre']]) {
        assert.equal(metric(stored, name).status, 'ready'); assert.equal(metric(stored, name).value, value);
        assert.equal(metric(stored, name).unit, unit);
      }
      const firstDefinitionRead = f.state.calls.findIndex(c => readsHash(c, PROFILE.profile_ref.content_sha256));
      assert.ok(firstDefinitionRead >= 0);
      assert.ok(firstDefinitionRead < f.state.calls.indexOf(sourceReads(f)[0]), 'actual definition precedes any source payload');
    } else {
      for (const name of ['reported_close_price', 'reported_current_price', 'reported_living_area', 'reported_site_area']) {
        assert.equal(metric(stored, name).value, null); assert.equal(metric(stored, name).unit, null);
      }
    }
    const purpose = describeNeighborhoodCombinedEvidenceMarketDataPurpose(f.f.input.retained_inputs.acquisition.captured_query_request);
    assert.ok(f.state.marketCalls.length >= 3, 'initial, recheck and publication fences independently authorize');
    for (const call of f.state.marketCalls) assert.deepEqual(call.purpose, purpose);
    for (const call of f.state.reportCalls) {
      assert.deepEqual(call.purpose.shared_source_purpose, purpose);
      assert.deepEqual(call.requested, { retention: true, exposure: 'custom_report_observations' });
    }
    assert.equal(json(f.f.input.retained_inputs), before);
    for (const forbidden of ['source_payload', 'raw_projection', 'member_data', 'canonical_json', 'actor_user_id']) {
      assert.equal(JSON.stringify(result).includes(forbidden), false, 'bounded public proposal does not expose originals');
    }
  });
}

test('default owner and explicit combined owner keep a genuine CAD4 registered report on the old purpose and interpretation', async () => {
  const f = await fixture({ marked: false, mappingVersion: 4 });
  const first = await f.service.prepareReportedObservations(f.input), original = copy(assessment(f));
  assert.equal(Object.hasOwn(sourcePayload(f), 'interpretation'), false);
  const offset = f.state.calls.length;
  const replay = await f.rebuildService('combined-witness2-v1').prepareReportedObservations(f.input);
  assert.deepEqual({ ...replay, reused: false }, first); assert.equal(replay.reused, true);
  assert.deepEqual(assessment(f), original); assert.equal(publicationWrites(f.state.calls.slice(offset)).length, 0);
  const purpose = describeNeighborhoodCachedMarketDataPurpose(f.f.input.retained_inputs.acquisition.captured_query_request);
  for (const call of f.state.marketCalls) assert.deepEqual(call.purpose, purpose);
});

for (const [mappingVersion, capture, purposeOf] of [[2, decisionEvidenceFixture, describeNeighborhoodCachedMarketDataPurpose],
  [3, saleWitnessMeaningFixture, describeNeighborhoodSaleWitnessMarketDataPurpose]]) {
  test(`old mapping${mappingVersion} registered capture and report preserve their exact purpose across the new mode`, async () => {
    const original = await capture({ assignmentFileId: '41', effectiveDate: '2026-09-06' });
    const f = await reportedReplacementOwnerFixture({ captureFixture: { input: original.input, base: original }, sourceMode: 'cad4' });
    const firstCapture = await f.service.capture(captureRequest(f));
    const firstReport = await f.service.prepareReportedObservations(f.input), before = copy(f.state.db), count = f.state.calls.length;
    const newMode = f.rebuildService('combined-witness2-v1');
    assert.deepEqual(await newMode.capture(captureRequest(f)), firstCapture);
    const replay = await newMode.prepareReportedObservations(f.input);
    assert.deepEqual({ ...replay, reused: false }, firstReport); assert.equal(replay.reused, true);
    assert.equal(Object.hasOwn(sourcePayload(f), 'interpretation'), false);
    assert.deepEqual(f.state.db, before); assert.equal(publicationWrites(f.state.calls.slice(count)).length, 0);
    assert.equal(f.state.calls.some(c => /neighborhood-(?:cache|closure|membership):/.test(c.text)), false);
    const purpose = purposeOf(original.input.retained_inputs.acquisition.captured_query_request);
    for (const call of f.state.marketCalls) assert.deepEqual(call.purpose, purpose);
  });
}

for (const [mappingVersion, marked, firstMode, secondMode] of [
  [4, false, 'cad4', 'combined-witness2-v1'], [5, false, 'cad4', 'combined-witness2-v1'],
  [5, true, 'combined-witness2-v1', 'cad4'],
]) test(`registered mapping${mappingVersion}/${marked ? 'marked' : 'unmarked'} capture replays across ${firstMode} to ${secondMode} without new acquisition`, async () => {
  const f = await fixture({ mappingVersion, marked, sourceMode: firstMode });
  const blobCount = f.f.base.f.state.db.size;
  const request = captureRequest(f), first = await f.service.capture(request), count = f.state.calls.length;
  const replay = await f.rebuildService(secondMode).capture(request);
  assert.equal(first.status, 'registered'); assert.equal(first.reused, true);
  assert.deepEqual(replay, first); assert.deepEqual(replay.context_ref, f.input.contextRef);
  assert.equal(publicationWrites(f.state.calls).length, 0); assert.equal(reportWrites(f.state.calls).length, 0);
  assert.equal(f.state.calls.some(c => /neighborhood-(?:cache|closure|membership):/.test(c.text)), false);
  assert.equal(f.state.calls.slice(count).some(c => /\bINSERT\s+INTO|\bUPDATE\s+(?:app|core|gis)\.|\bDELETE\s+FROM/.test(c.text)), false);
  assert.equal(f.f.base.f.state.db.size, blobCount, 'existing subject/assignment row locks do not create new evidence');
  assert.ok(f.state.calls.slice(count).some(c => c.text.includes('existing-context')));
  assert.equal(f.state.db.jobs.size, 0);
});

for (const marked of [false, true]) test(`${marked ? 'marked' : 'unmarked'} mapping5 stored proposal survives cross-mode retry without semantic upgrade or republishing`, async () => {
  const firstMode = marked ? 'combined-witness2-v1' : 'cad4', nextMode = marked ? 'cad4' : 'combined-witness2-v1';
  const f = await fixture({ marked, sourceMode: firstMode });
  const first = await f.service.prepareReportedObservations(f.input), saved = copy(f.state.db), count = f.state.calls.length;
  const replay = await f.rebuildService(nextMode).prepareReportedObservations(f.input);
  assert.deepEqual({ ...replay, reused: false }, first); assert.equal(replay.reused, true);
  assert.deepEqual(f.state.db, saved); assert.equal(publicationWrites(f.state.calls.slice(count)).length, 0);
  assert.equal(f.state.db.jobs.size, 1);
});

test('marked proposal, first Apply, replacement and lost-ACK replay retain their exact original report across source modes', async () => {
  const f = await fixture({ sourceMode: 'combined-witness2-v1' });
  const proposal = await f.service.prepareReportedObservations(f.input), apply = f.applyInput(f.input, proposal);
  const alternate = f.rebuildService('cad4'), accepted = await alternate.applyReportedObservations(apply);
  assert.equal(accepted.status, 'accepted'); assert.equal(f.state.db.histories.size, 1);
  const firstHistory = copy(f.state.db.histories.get(1)), firstAssessment = copy(f.state.db.assessments.get(1));
  const request = f.replacementInput(), next = await alternate.prepareReportedObservations(request), nextApply = f.applyInput(request, next);
  assert.equal(next.status, 'proposed');
  assert.equal(metric(f.state.db.assessments.get(2), 'reported_close_price').value, '312345.125');
  const beforeReplay = f.state.calls.length;
  assert.equal((await f.service.prepareReportedObservations(request)).reused, true);
  assert.equal(publicationWrites(f.state.calls.slice(beforeReplay)).length, 0);
  let lost = false;
  f.state.afterCommit = () => { if (!lost) { lost = true; throw new Error('synthetic lost COMMIT ACK'); } };
  await assert.rejects(f.service.applyReportedObservations(nextApply), error => error.outcome_unknown === true);
  assert.equal(f.state.db.histories.size, 2);
  const committed = copy(f.state.db), offset = f.state.calls.length;
  const replay = await alternate.applyReportedObservations(nextApply);
  assert.equal(replay.reused, true); assert.equal(replay.accepted_editor_revision, 2);
  assert.deepEqual(f.state.db, committed); assert.equal(reportWrites(f.state.calls.slice(offset)).length, 0);
  assert.deepEqual(f.state.db.histories.get(1), firstHistory); assert.deepEqual(f.state.db.assessments.get(1), firstAssessment);
});

for (const marked of [false, true]) test(`${marked ? 'marked' : 'unmarked'} retained mapping5 cannot use a narrower legacy permission`, async () => {
  const f = await fixture({ marked, sourceMode: 'cad4' });
  f.state.marketPolicy = (_client, _auth, _context, purpose) => Object.hasOwn(purpose, 'source_projection') ? { allowed: false } : grant(f);
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'market_data_access_denied' });
  assert.equal(f.state.marketCalls.length, 1); assert.equal(f.state.reportCalls.length, 0);
  assert.equal(sourceReads(f).length, 0); assert.equal(f.state.db.jobs.size, 0);
  assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});

for (const stage of ['source-denied', 'source-revision-changed', 'report-denied']) test(`marked report publication rechecks ${stage} after pure assembly`, async () => {
  const f = await fixture(), initial = copy(f.state.db);
  if (stage.startsWith('source')) f.state.marketPolicy = () => f.state.commits === 0 ? grant(f)
    : stage === 'source-denied' ? { allowed: false } : { ...grant(f), policy_revision: 'changed-after-first-transaction' };
  else f.state.reportPolicy = () => f.state.commits === 0 ? { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' } : { allowed: false };
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: stage === 'source-denied' ? 'market_data_access_denied'
    : stage === 'source-revision-changed' ? 'market_policy_changed' : 'report_observation_access_denied' });
  assert.deepEqual(f.state.db, initial); assert.equal(f.state.db.jobs.size, 0);
  assert.equal(publicationWrites(f.state.calls).length, 0); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});

test('source-policy failure after actual replacement save rolls back and cannot leave a partial accepted successor', async () => {
  const f = await fixture(), first = await f.acceptFirst(), request = f.replacementInput();
  const proposal = await f.service.prepareReportedObservations(request), apply = f.applyInput(request, proposal);
  const before = copy(f.state.db); let deny = false;
  f.state.afterQuery = text => { if (text.includes('custom-neighborhood-acceptance:insert')) deny = true; };
  f.state.marketPolicy = () => deny ? { allowed: false } : grant(f);
  await assert.rejects(f.rebuildService('combined-witness2-v1').applyReportedObservations(apply), { reason: 'market_data_access_denied' });
  assert.equal(deny, true, 'failure follows the actual save/acceptance path');
  assert.deepEqual(f.state.db, before); assert.equal(f.state.db.histories.size, 1);
  assert.ok(f.state.db.acceptances.has(first.apply.operationId)); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});

for (const missing of ['definition', 'intent']) test(`retained marked ${missing} original is mandatory before any market source page or policy callback`, async () => {
  const f = await fixture(), retained = f.f.input.retained_inputs;
  const ref = missing === 'definition' ? PROFILE.definition_blob.ref : retained.acquisition_intent.reference;
  f.f.base.f.state.db.delete(`${f.target.organization_id}:${ref.content_sha256}`);
  await assert.rejects(f.service.prepareReportedObservations(f.input), /operation_conflict|retained_inputs_unavailable/);
  assert.equal(sourceReads(f).length, 0); assert.equal(f.state.marketCalls.length, 0); assert.equal(f.state.reportCalls.length, 0);
  assert.equal(publicationWrites(f.state.calls).length, 0);
});

test('historical stock refusal remains intact under the new marker and does not publish a partial report', async () => {
  const f = await fixture({ effectiveDate: '2024-06-30' });
  const result = await f.service.prepareReportedObservations(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.assessment, null); assert.equal(result.attachment_ref, null);
  assert.ok(result.issues.some(issue => issue.code === 'historical_stock_evidence_required'));
  assert.equal(f.state.db.jobs.size, 0); assert.equal(publicationWrites(f.state.calls).length, 0);
});

test('exact stored malformed marker refuses before source reads rather than falling back to unmarked mapping5', async () => {
  const captureFixture = await cadEvidenceFixture({ mappingVersion: 5, assignmentFileId: '41', effectiveDate: '2026-09-06',
    rawPayload, reportedSaleInterpretation: copy(PROFILE.profile_ref) });
  const header = JSON.parse(captureFixture.input.context_header_json), store = captureFixture.base.store;
  const study = JSON.parse(await store.get(header.study_input.content_sha256, header.study_input.canonical_utf8_bytes));
  study.reported_sale_interpretation.profile_ref.revision = 'unknown';
  header.study_input = await store.put(json(study));
  const headerJson = json(header), context = prepareCustomCohortContextHeader(headerJson).context_ref;
  // Deliberate malformed stored graph with its own consistent outer hash. The
  // original admitted capture is unchanged and is not represented as reissued.
  const malformed = { ...captureFixture, input: { ...captureFixture.input, context_header_json: headerJson,
    expected: { ...captureFixture.input.expected, context_ref: context } } };
  const f = await reportedReplacementOwnerFixture({ captureFixture: malformed, sourceMode: 'combined-witness2-v1' });
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'operation_conflict' });
  assert.equal(sourceReads(f).length, 0); assert.equal(f.state.marketCalls.length, 0); assert.equal(f.state.reportCalls.length, 0);
  assert.equal(publicationWrites(f.state.calls).length, 0);
});
