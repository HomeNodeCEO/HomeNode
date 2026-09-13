import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCustomCohortReportedAssessment as legacy,
  buildCustomCohortReportedAssessmentBatched as legacyBatched,
  buildCustomCohortReportedAssessmentWitnessV2 as witness,
  buildCustomCohortReportedAssessmentWitnessV2Batched as witnessBatched } from '../src/services/neighborhoodAssessment/customCohortReportedAssessment.js';
import { assessmentEvidenceDigest as digest } from '../src/services/neighborhoodAssessment/contract.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { customCohortReportedAssessmentFixture } from './fixtures/customCohortReportedAssessmentFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';

const GENERIC = 'custom_neighborhood_report_incomplete_assessment';
const CARDINALS = 'manual_cardinal_descriptions_required', POINT = 'recorded_subject_point_not_covered';
const rawPayload = { MlsStatus: 'Closed', CloseDate: '2024-03-01', ClosePrice: '280000', ClosePriceCurrency: 'USD',
  LivingArea: '1800', LivingAreaUnits: 'Square Feet', LotSizeArea: '0.25', LotSizeUnits: 'Acres' };
const outside = { covers_recorded_subject_point: false, contains_recorded_subject_point: false };
const blank = { neighborhood_boundary_north: '' };
const issuesOf = codes => codes.map(code => ({ code }));
const mutable = input => ({ ...structuredClone(input), report_geography: input.report_geography });

// Genuine synthetic capture/retention/reopen. Reuse only the process-admitted
// geography after checking identical subjects, never relabel source originals.
async function fixture(useWitness, options = {}) {
  const base = await customCohortReportedAssessmentFixture({ effectiveDate: '2026-09-06', ...options });
  if (!useWitness) return base.input;
  const capture = await cadEvidenceFixture({ assignmentFileId: '41', mappingVersion: 5,
    effectiveDate: options.effectiveDate ?? '2026-09-06', rawPayload });
  assert.deepEqual(capture.input.retained_inputs.subject, base.input.retained_inputs.subject);
  return { ...base.input, context_ref: capture.input.expected.context_ref,
    retained_inputs: { ...capture.input.retained_inputs,
      ...(base.input.retained_inputs.private_sales ? { private_sales: base.input.retained_inputs.private_sales } : {}) },
    selection: { revision: 1, included_recorded_group_ids: options.emptySelection ? [] : [
      ...capture.catalog.pockets.map(p => p.id), ...(capture.catalog.unassigned.member_count ? ['discovery:unassigned'] : [])] } };
}

// Captured BEFORE the diagnostic change from adffc056d79db181238f57f84e4a8a42046874bb.
// These hash every result field except the intentionally expanded outer issues;
// assessment, publication, candidate (including its original issues) and binding
// remain covered in full. Ready goldens include the entire result, issues too.
const CASES = [
  ['blank cardinals', { geographyChanges: blank }, [CARDINALS],
    'f291d68d29455af6c47e916cfa7b5bcbfdecad2c0a288c7a6c6c1a3206506161',
    '902ff1519b9fcf769c8328612f5cd50838dd4809dce7b705636ea23be9351c5e'],
  ['uncovered point', { oracleChanges: outside }, [POINT],
    'b0d4d14d5951be1ffff77829e739225b7824505b462e6f88cb3d6b6727dd582c',
    '42557c998817e0c565088055c6159b1fd20242d7b8c77a310e79aa11d098ac85'],
  ['both checked reasons', { geographyChanges: blank, oracleChanges: outside }, [CARDINALS, POINT],
    '997f7c86c292974491495ec7868f8bf5b8246247ae2ea0c8cae26936a26ce7de',
    '80b84d496effd6d195a45266ccb884c5dc8261c44387331b36dc8166d141a5b4'],
  ['legacy manual intent', { geographyChanges: { neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' } },
    ['legacy_manual_intent_unverified', CARDINALS, POINT],
    '5e61fd84377b5f11d511845c81a01a7d904118bc8844b15bf1fc79b21f94de33',
    '025dab4542e37582ac6787a6216e9508ed00dcebcb5bb2c2c0a1219b77264ae2'],
  ['absent manual geometry', { geographyChanges: { neighborhood_boundary_geometry: null, neighborhood_boundary_source: null } },
    [CARDINALS, 'manual_geometry_absent', POINT],
    '3beb3fc9dce3722cadd734a1db32f8aa2dcfb1972f6ebc62beb2a63ab6a76076',
    'ec1d7ba550faa678a93a8eea0d37b57a897ea07a79349c13123d971f1a5509f8'],
];

for (const [name, useWitness, build, batched, readyHash, emptyHash, privateHash] of [
  ['legacy', false, legacy, legacyBatched,
    '65b4101eac35ff3ec88174c7f1e35260fb35e661011d64811ff9cd2561aed18c',
    'b1731ce762f4b83180a727b58269607615c2c7d1e567ad9d3ac50c582b7c0b74',
    '66759071d51a6cc75454ec9576ee65ef9b0cf77aaf2cbed5b7ba0e8543d38a16'],
  ['witness2', true, witness, witnessBatched,
    'caea9449fca2b70dfec5adfaf035ff2c43535ad07bd986f48ac839c59ae4eac5',
    '1bb6c4ff71c2e6a75070770d5162ae45817803c567c7af044fa78782127d861a',
    'aafb53e21c16764b42f8e9ad89488f0886b21bf09302862bf24d5a2c0bc94ca6'],
]) {
  for (const [caseName, options, reasons, oldHash, witnessHash] of CASES) {
    test(`${name}: ${caseName} appends only checked reasons without changing any report evidence`, async () => {
      const input = await fixture(useWitness, options), before = JSON.stringify(input), result = build(input);
      const { issues, ...unchanged } = result;
      assert.equal(digest(unchanged), useWitness ? witnessHash : oldHash);
      assert.equal(result.status, 'incomplete');
      assert.equal(result.assessment.contract_version, 2);
      assert.equal(result.assessment.application_group.status, 'incomplete');
      assert.equal(result.assessment.geographic_neighborhood.status, 'incomplete');
      assert.deepEqual(result.assessment.geographic_neighborhood.reasons, reasons);
      assert.deepEqual(result.candidate.issues, issuesOf([GENERIC]));
      assert.deepEqual(result.candidate.suggestions, []);
      assert.deepEqual(issues, issuesOf([GENERIC, ...reasons]));
      assert.equal(new Set(issues.map(issue => issue.code)).size, issues.length);
      assert.ok(Object.isFrozen(issues) && issues.every(Object.isFrozen));
      assert.ok(result.publication_bundle.members.length > 0 && result.publication_bundle.sources.length > 0);
      assert.deepEqual(await batched(input), result);
      assert.equal(JSON.stringify(input), before);
    });
  }

  test(`${name}: all missing/blank cardinals produce one diagnostic, not one per direction`, async () => {
    const input = await fixture(useWitness, { geographyChanges: { neighborhood_boundary_north: null,
      neighborhood_boundary_east: '', neighborhood_boundary_south: '   ', neighborhood_boundary_west: null } });
    const result = build(input);
    assert.deepEqual(result.issues, issuesOf([GENERIC, CARDINALS]));
    assert.deepEqual(result.assessment.geographic_neighborhood.reasons, [CARDINALS]);
    assert.deepEqual(await batched(input), result);
  });

  test(`${name}: disallowed saved text exposes its checked reason, never the raw value`, async () => {
    const input = await fixture(useWitness, { geographyChanges: { neighborhood_boundary_north: 'private\tinvalid' } });
    const result = build(input);
    assert.deepEqual(result.issues, issuesOf([GENERIC, CARDINALS, POINT, 'saved_field_type_or_limit']));
    assert.equal(JSON.stringify(result.issues).includes('private'), false);
    assert.deepEqual(await batched(input), result);
  });

  test(`${name}: complete, explicit-empty and private ready outputs keep pre-change full hashes`, async () => {
    for (const [options, expected] of [[{}, readyHash], [{ emptySelection: true }, emptyHash], [{ privateRows: [{}] }, privateHash]]) {
      const input = await fixture(useWitness, options), result = build(input);
      assert.equal(result.status, 'ready'); assert.deepEqual(result.issues, []);
      assert.equal(digest(result), expected); assert.equal(digest(await batched(input)), expected);
    }
  });

  test(`${name}: a non-geography candidate failure receives no new diagnostic`, async () => {
    const input = await fixture(useWitness);
    input.preparation_identity = { ...input.preparation_identity, attachment_id: 'invalid-attachment' };
    const result = build(input);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.assessment.application_group.status, 'ready');
    assert.deepEqual(result.assessment.geographic_neighborhood.reasons, []);
    assert.ok(result.issues.length > 0); assert.equal(result.issues, result.candidate.issues);
    assert.deepEqual(await batched(input), result);
  });

  test(`${name}: retrospective refusal remains exact even with incomplete geography`, async () => {
    const input = await fixture(useWitness, { effectiveDate: '2024-07-01', geographyChanges: blank });
    const expected = { status: 'incomplete', assessment: null, publication_bundle: null, candidate: null,
      issues: issuesOf(['historical_stock_evidence_required']) };
    assert.deepEqual(build(input), expected); assert.deepEqual(await batched(input), expected);
  });

  test(`${name}: incomplete geography cannot hide source, selection, target or admission failures`, async () => {
    const good = await fixture(useWitness, { emptySelection: true });
    const incomplete = await fixture(useWitness, { emptySelection: true, geographyChanges: blank });
    for (const change of [
      input => { input.retained_inputs.acquisition.capture_result.query_complete = false; },
      input => { input.retained_inputs.acquisition.capture_result.source_capture.sources.at(-1).payload.records[0].data.data.cached_mapping_version = 99; },
      input => { input.selection.included_recorded_group_ids = ['unknown-group']; },
      input => { input.target.scope.account_id = 'foreign'; },
      input => { input.report_geography = structuredClone(input.report_geography); },
    ]) {
      const baseline = mutable(good), changed = mutable(incomplete); change(baseline); change(changed);
      let original;
      assert.throws(() => build(baseline), error => { original = error; return true; });
      const exactError = error => error.constructor === original.constructor && error.message === original.message
        && error.code === original.code && error.reason === original.reason;
      assert.throws(() => build(changed), exactError);
      await assert.rejects(batched(changed), exactError);
    }
  });

  test(`${name}: cancellation at initial and final checks never returns partial readiness diagnostics`, async () => {
    const input = await fixture(useWitness, { geographyChanges: blank }); let total = 0;
    const expected = await batched(input, { check() { total++; } });
    assert.ok(total > 8 && total % 2 === 0);
    for (const stop of [1, 4, total - 1, total]) {
      let count = 0; const controller = new AbortController(), cancelled = new Error(`readiness-cancel-${stop}`);
      await assert.rejects(batched(input, { check() {
        if (++count === stop) controller.abort(cancelled);
        controller.signal.throwIfAborted();
      } }), error => error === cancelled);
      assert.equal(count, stop);
    }
    assert.deepEqual(await batched(input), expected);
  });
}

// Existing real owner and retained graph with SQL-result doubles only. These
// are response/fence tests, not database, native topology or grant-oracle proof.
async function ownerFixture(useWitness) {
  if (!useWitness) return reportedReplacementOwnerFixture();
  const captureFixture = await cadEvidenceFixture({ assignmentFileId: '41', effectiveDate: '2026-09-06', mappingVersion: 5,
    rawPayload, reportedSaleInterpretation: structuredClone(getCustomCohortReportedSaleWitnessV2Profile().profile_ref) });
  return reportedReplacementOwnerFixture({ captureFixture });
}
function missingCardinals(f) {
  const boundary = f.state.db.boundary, saved = JSON.parse(boundary.projected_json);
  saved.neighborhood_boundary_north = '';
  const text = JSON.stringify(saved);
  Object.assign(boundary, { projected_json: text, projected_utf8_bytes: Buffer.byteLength(text),
    projected_sha256: createHash('sha256').update(text).digest('hex') });
}
function noPublication(f) {
  for (const key of ['jobs', 'assessments', 'attachments', 'acceptances', 'histories']) assert.equal(f.state.db[key].size, 0);
  assert.equal(f.state.db.section, null);
  assert.ok(!f.state.calls.some(call => /\b(?:INSERT INTO|UPDATE) app\.(?:neighborhood_|custom_)/.test(call.text)));
}

for (const useWitness of [false, true]) {
  test(`owner ${useWitness ? 'witness2' : 'legacy'} forwards bounded diagnostic codes only after final fences, without writes`, async () => {
    const f = await ownerFixture(useWitness); missingCardinals(f);
    f.state.afterQuery = (text, _values, result) => {
      if (text.includes('report-geography-topology')) Object.assign(result.rows[0], outside);
    };
    const result = await f.service.prepareReportedObservations(f.input);
    assert.equal(result.status, 'incomplete'); assert.equal(result.attachment_ref, null); assert.equal(result.assessment, null);
    assert.deepEqual(result.issues, issuesOf([GENERIC, CARDINALS, POINT]));
    assert.equal(f.state.commits, 2);
    assert.ok(f.state.reportCalls.some(call => call.phase === 2));
    assert.ok(f.state.marketCalls.some(call => call.phase === 2));
    assert.ok(result.issues.length <= 128 && result.issues.every(issue => Object.keys(issue).join() === 'code'
      && issue.code.length <= 200 && /^[a-zA-Z0-9_:.-]+$/.test(issue.code)));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 524288);
    for (const privateKey of ['source_payload', 'raw_projection', 'member_data', 'canonical_json', 'actor_user_id']) {
      assert.equal(JSON.stringify(result).includes(privateKey), false);
    }
    noPublication(f);
  });

  test(`owner ${useWitness ? 'witness2' : 'legacy'} saved ready proposal replay stays identical and read-only`, async () => {
    const f = await ownerFixture(useWitness), first = await f.service.prepareReportedObservations(f.input);
    const before = structuredClone(f.state.db), count = f.state.calls.length;
    const replay = await f.service.prepareReportedObservations(f.input);
    assert.equal(first.status, 'proposed'); assert.deepEqual(first.issues, []);
    assert.equal(replay.reused, true); assert.deepEqual({ ...replay, reused: false }, first);
    assert.deepEqual(f.state.db, before);
    assert.ok(!f.state.calls.slice(count).some(call => /\b(?:INSERT INTO|UPDATE) app\./.test(call.text)));
  });
}

for (const fence of ['boundary', 'report rights', 'market rights']) {
  test(`incomplete geography still loses to a final ${fence} change`, async () => {
    const f = await ownerFixture(true); missingCardinals(f);
    if (fence === 'boundary') f.state.afterCommit = () => { if (f.state.commits === 1) f.state.db.boundary.assignment_revision++; };
    else if (fence === 'report rights') f.state.reportPolicy = () => f.state.phases === 2 ? { allowed: false }
      : { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' };
    else f.state.marketPolicy = () => f.state.phases === 2 ? { allowed: false }
      : { allowed: true, ...f.f.input.retained_inputs.acquisition.captured_query_request.market_decision };
    await assert.rejects(f.service.prepareReportedObservations(f.input), error => fence === 'boundary'
      ? error.reason === 'report_geography_changed' : /access_denied/.test(error.reason));
    assert.equal(f.state.calls.at(-1).text, 'ROLLBACK'); noPublication(f);
  });
}
