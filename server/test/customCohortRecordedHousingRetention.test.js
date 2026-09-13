import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs as prepare, prepareCustomCohortCaptureInputsBatched as prepareBatched,
  persistCustomCohortCaptureInputs as persist, loadCustomCohortCaptureInputs as load } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { getCustomCohortRecordedHousingInterpretation as interpretation } from '../src/services/neighborhoodAssessment/customCohortRecordedHousingProfiles.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { buildCustomCohortRecordedHousing } from '../src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './fixtures/customCohortRepositoryFixture.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';

const copy = value => structuredClone(value), marker = 'recorded_housing_interpretation';
const REPORTED = getCustomCohortReportedSaleWitnessV2Profile();
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const read = (f, ref) => f.store.get(ref.content_sha256, ref.canonical_utf8_bytes).then(JSON.parse);
const writes = calls => calls.filter(call => ['insert', 'insert-batch'].includes(call.tag));
const readsHash = (call, hash) => call.tag === 'read' ? call.params[1] === hash
  : call.tag === 'read-batch' && call.params[1].includes(hash);
const ownerReadsHash = (call, hash) => /neighborhood-cohort-blob:read \*/.test(call.text) ? call.values[1] === hash
  : /neighborhood-cohort-blob:read-batch \*/.test(call.text) && call.values[1].includes(hash);
const sourceHashes = f => f.retained.acquisition.capture_result.source_capture.source_snapshots.map(s => s.content_sha256);

// A distinct synthetic private supplement exercises the existing intent bits;
// it does not grant shared-source rights or provide housing classifications.
function privateSupplement() {
  const target = customCohortScopeOf(customCohortRepositoryFixture().state.input);
  const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from(
    'ListingId,CloseDate,ClosePrice,ParcelNumber,MlsStatus,LivingArea\nPRIVATE1,2024-03-01,275000,R-001,Closed,1800'));
  return { capture: { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1', target,
    batch: { batch_id: '20000000-0000-4000-8000-000000000001', source_sha256: header.source_sha256,
      preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: 1, head_review_id: '30000000-0000-4000-8000-000000000001', source_review_id: '30000000-0000-4000-8000-000000000001' },
    source_interpretation: { source_name: 'Synthetic private source', provenance_note: '', currency: 'USD', living_area_unit: 'sqft',
      site_area_unit: null, consideration_field: 'close_price', marketing_time_field: null, source_use_confirmed: true },
    captured_at: '2026-09-06T08:00:00.123456Z', rows: rows.map(record_data => ({
      receipt_id: '40000000-0000-4000-8000-000000000001', source_row_number: record_data.source_row_number, record_data,
      review: { review_id: '30000000-0000-4000-8000-000000000001', revision: 1,
        decision: 'confirm_proposed_match', account_ids: ['R-001'], note: '' } })) },
  authorization: { decision_id: 'synthetic-private', policy_revision: 'synthetic-private-v1' } };
}

async function fixture({ mappingVersion = 4, marked = true, reported = false, privateSales = false, ...options } = {}) {
  const profile = interpretation(mappingVersion, 2);
  const capture = await cadEvidenceFixture({ mappingVersion,
    ...(marked ? { recordedHousingInterpretation: copy(profile.profile_ref) } : {}),
    ...(reported ? { reportedSaleInterpretation: copy(REPORTED.profile_ref) } : {}),
    ...(privateSales ? { privateSales: privateSupplement() } : {}), ...options });
  return { ...capture, profile, retained: capture.originalRetained, refs: prepare(capture.originalRetained).refs,
    state: capture.base.f.state, store: capture.base.store, client: capture.base.client, scopeJson: capture.base.scopeJson };
}

for (const [mappingVersion, expected] of [[4, '0a57fa378c4dc1766ae4c17fd179a857a9a340b7daf6fe067622ec55a644b320'],
  [5, 'dd9b3eafec3085d57c104b451062a461fd4c3be4f0a4628cbd22deebb4ae1c58']]) {
  test(`unmarked mapping${mappingVersion} retains the pre-housing-change complete prepared graph golden`, async () => {
    const f = await fixture({ mappingVersion, marked: false });
    assert.equal(digest(prepare(f.retained)), expected);
    assert.equal(f.retained.acquisition_intent.body.intent_version, 1);
    assert.equal((await read(f, f.refs.study_input)).study_input_version, 1);
    assert.equal(Object.hasOwn(f.retained, marker), false);
    assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).retained_inputs, f.retained);
  });
}

for (const [mappingVersion, reported] of [[4, false], [5, false], [5, true]]) for (const privateSales of [false, true]) {
  test(`original mapping${mappingVersion} reported=${reported} private=${privateSales} pins exact housing definition and versions`, async () => {
    const f = await fixture({ mappingVersion, reported, privateSales });
    const old = await fixture({ mappingVersion, reported, privateSales, marked: false });
    const before = json(f.retained), study = await read(f, f.refs.study_input), selection = await read(f, f.refs.selection_input);
    const intent = await read(f, selection.acquisition_intent), profile = f.profile;
    assert.equal(study.study_input_version, reported ? 4 : 3);
    assert.equal(intent.intent_version, (privateSales ? 2 : 1) + (reported ? 2 : 0) + 4);
    assert.equal((await read(old, old.refs.study_input)).study_input_version, reported ? 2 : 1);
    assert.equal(old.retained.acquisition_intent.body.intent_version, (privateSales ? 2 : 1) + (reported ? 2 : 0));
    assert.equal(Object.hasOwn(old.retained, marker), false);
    assert.deepEqual(study[marker], { profile_ref: profile.profile_ref, definition_blob: profile.definition_blob.ref });
    assert.deepEqual(intent[marker], profile.profile_ref); assert.deepEqual(intent, f.retained.acquisition_intent.body);
    assert.equal(await f.store.get(profile.definition_blob.ref.content_sha256, profile.definition_blob.ref.canonical_utf8_bytes),
      profile.definition_blob.canonical_json);
    assert.equal(profile.profile_ref.content_sha256, digest(JSON.parse(profile.definition_blob.canonical_json)));
    assert.deepEqual(JSON.parse(profile.definition_blob.canonical_json).cad_county_aliases, ['DALLAS', 'DALLAS COUNTY']);
    assert.deepEqual(f.retained.acquisition, old.retained.acquisition, 'no source projection, authorization, or source literal is relabeled');
    assert.deepEqual(f.retained.study, old.retained.study);
    assert.deepEqual(f.marketPurposes, old.marketPurposes); assert.equal(f.queryCalls.length, old.queryCalls.length);
    assert.deepEqual(f.refs.snapshot_evidence, old.refs.snapshot_evidence);
    assert.deepEqual(f.refs.subject_dependencies, old.refs.subject_dependencies);
    assert.notDeepEqual(f.refs.study_input, old.refs.study_input); assert.notDeepEqual(f.refs.selection_input, old.refs.selection_input);
    assert.notEqual(f.input.expected.context_ref.context_sha256, old.input.expected.context_ref.context_sha256);
    assert.equal(selection.selection_input_version, privateSales ? 2 : 1);
    assert.equal(Object.hasOwn(selection, 'private_sales'), privateSales);
    if (privateSales) assert.deepEqual(f.retained.private_sales, old.retained.private_sales);
    if (reported) assert.deepEqual(study.reported_sale_interpretation, (await read(old, old.refs.study_input)).reported_sale_interpretation);
    assert.deepEqual(await prepareBatched(copy(f.retained)), prepare(f.retained));
    f.state.calls.length = 0;
    const opened = await load(f.client, f.scopeJson, f.refs);
    assert.deepEqual(opened.retained_inputs, f.retained); assert.deepEqual(opened.refs, f.refs);
    const firstProfile = f.state.calls.findIndex(c => readsHash(c, profile.profile_ref.content_sha256));
    const firstSource = f.state.calls.findIndex(c => sourceHashes(f).some(hash => readsHash(c, hash)));
    assert.ok(firstProfile >= 0 && firstSource > firstProfile, 'retained exact definition is read before source payloads');
    assert.equal(writes(f.state.calls).length, 0);
    assert.ok(Object.isFrozen(opened.retained_inputs[marker])); assert.ok(Object.isFrozen(opened.acquisition_intent.body[marker]));
    assert.equal(json(f.retained), before);
  });
}

for (const mappingVersion of [4, 5]) test(`actual original/reopened mapping${mappingVersion} county semantics depend only on its retained marker`, async () => {
  const options = { mappingVersion, accountOverridesByIndex: [{ county: 'DALLAS COUNTY' }, { county: 'DALLAS COUNTY' }],
    parcelOverrides: { class_code: 'A11', class_description: null, use_description: null, structure_type: null, built_up: null } };
  const old = await fixture({ ...options, marked: false }), fresh = await fixture(options);
  const housing = f => buildCustomCohortRecordedHousing({ retained_inputs: f.input.retained_inputs, preview: f.preview,
    groups: [...f.catalog.pockets, ...(f.catalog.unassigned.member_count ? [{ id: 'discovery:unassigned', account_ids: f.catalog.unassigned.account_ids }] : [])] });
  assert.deepEqual(fresh.retained.acquisition, old.retained.acquisition);
  const before = housing(old), after = housing(fresh);
  assert.equal(before.housing_version, 1); assert.equal(after.housing_version, 2);
  assert.ok(before.accounts.some(a => a.state === 'unknown')); assert.ok(after.accounts.some(a => a.state === 'observed'));
  assert.deepEqual(after.accounts.map(a => a.account_id), before.accounts.map(a => a.account_id));
  assert.deepEqual((await load(old.client, old.scopeJson, old.refs)).retained_inputs, old.retained);
  assert.deepEqual(housing(old), before, 'opening a new marked capture cannot upgrade an older retained one');
});

for (const [name, mutate] of [
  ['null marker', input => { input[marker] = null; }],
  ['undefined marker', input => { input[marker] = undefined; }],
  ['unknown ID', input => { input[marker].id = 'other'; }],
  ['string revision', input => { input[marker].revision = '3'; }],
  ['wrong hash', input => { input[marker].content_sha256 = 'f'.repeat(64); }],
  ['caller definition', input => { input[marker].definition = {}; }],
  ['missing retained marker', input => { delete input[marker]; }],
  ['missing intent marker', input => { delete input.acquisition_intent.body[marker]; }],
  ['old intent version', input => { input.acquisition_intent.body.intent_version = 1; }],
  ['inconsistent intent marker', input => { input.acquisition_intent.body[marker].revision = 4; }],
]) test(`preparation rejects ${name} with no downgrade or database writes`, async () => {
  const f = await fixture(), input = copy(f.retained); mutate(input); f.state.calls.length = 0;
  assert.throws(() => prepare(input), /custom_cohort_capture_inputs_/);
  await assert.rejects(prepareBatched(input), /custom_cohort_capture_inputs_|invalid|unsupported/);
  assert.equal(f.state.calls.length, 0);
});

test('a mapping5 housing profile cannot be attached to original mapping4 even with a newly hashed matching intent', async () => {
  const f = await fixture(), input = copy(f.retained);
  input[marker] = copy(interpretation(5, 2).profile_ref); input.acquisition_intent.body[marker] = copy(input[marker]);
  input.acquisition_intent.reference = await f.store.put(json(input.acquisition_intent.body)); f.state.calls.length = 0;
  assert.throws(() => prepare(input), /housing_interpretation_mismatch/);
  await assert.rejects(prepareBatched(input), /housing_interpretation_mismatch/);
  assert.equal(f.state.calls.length, 0);
});

for (const [name, mutate] of [
  ['missing original', (state, key) => state.db.delete(key)],
  ['corrupt original bytes', (state, key) => state.db.set(key, { ...state.db.get(key), canonical_utf8: '{}' })],
  ['foreign organization original only', (state, key) => { state.db.set(`foreign:${key}`, state.db.get(key)); state.db.delete(key); }],
]) test(`reopen refuses ${name} before source payloads after an earlier successful open`, async () => {
  const f = await fixture(), key = `${JSON.parse(f.scopeJson).organization_id}:${f.profile.profile_ref.content_sha256}`;
  await load(f.client, f.scopeJson, f.refs); mutate(f.state, key); f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, f.refs), /missing_evidence|storage_conflict/);
  assert.ok(f.state.calls.some(c => readsHash(c, f.profile.profile_ref.content_sha256)));
  assert.equal(f.state.calls.some(c => sourceHashes(f).some(hash => readsHash(c, hash))), false);
  assert.equal(writes(f.state.calls).length, 0);
});

for (const [name, mutate] of [
  ['missing marker', study => { delete study[marker]; }],
  ['legacy study version', study => { study.study_input_version = 1; }],
  ['wrong study version', study => { study.study_input_version = 4; }],
  ['old housing profile', study => { study[marker].profile_ref = copy(interpretation(4, 1).profile_ref); }],
  ['wrong definition hash', study => { study[marker].definition_blob.content_sha256 = 'f'.repeat(64); }],
  ['wrong definition byte length', study => { study[marker].definition_blob.canonical_utf8_bytes = '1'; }],
]) test(`a newly hashed stored study rejects ${name} rather than reinterpreting old sources`, async () => {
  const f = await fixture(), study = await read(f, f.refs.study_input); mutate(study);
  const changed = { ...f.refs, study_input: await f.store.put(json(study)) }; f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, changed), /(?:housing|reported)_interpretation_mismatch/);
  assert.equal(f.state.calls.some(c => sourceHashes(f).some(hash => readsHash(c, hash))), false);
  assert.equal(writes(f.state.calls).length, 0);
  assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).refs, f.refs);
});

test('a real different canonical definition cannot substitute broader county semantics', async () => {
  const f = await fixture(), study = await read(f, f.refs.study_input), definition = JSON.parse(f.profile.definition_blob.canonical_json);
  definition.cad_county_aliases.push('COLLIN');
  study[marker].definition_blob = await f.store.put(json(definition));
  const changed = { ...f.refs, study_input: await f.store.put(json(study)) }; f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, changed), /housing_interpretation_mismatch/);
  assert.equal(f.state.calls.some(c => sourceHashes(f).some(hash => readsHash(c, hash))), false);
});

for (const side of ['study', 'intent']) test(`a consistent ${side}-only downgrade still conflicts with the other original marker`, async () => {
  const f = await fixture(), refs = { ...f.refs };
  if (side === 'study') {
    const study = await read(f, refs.study_input); study.study_input_version = 1; delete study[marker];
    refs.study_input = await f.store.put(json(study));
  } else {
    const selection = await read(f, refs.selection_input), intent = await read(f, selection.acquisition_intent);
    intent.intent_version = 1; delete intent[marker]; selection.acquisition_intent = await f.store.put(json(intent));
    refs.selection_input = await f.store.put(json(selection));
  }
  f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, refs), /invalid_shape|binding_mismatch/);
  assert.equal(writes(f.state.calls).length, 0);
  assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).refs, f.refs);
});

test('cooperative preparation seals markers and cancellation never issues a partial persistence authority', async () => {
  const f = await fixture(), input = copy(f.retained), expected = prepare(input); let total = 0;
  const pending = prepareBatched(input, { check() { total++; } });
  assert.ok(Object.isFrozen(input[marker])); assert.ok(Object.isFrozen(input.acquisition_intent.body[marker]));
  assert.deepEqual(await pending, expected); assert.ok(total > 2);
  for (const stop of [1, Math.ceil(total / 2), total]) {
    const failure = new Error('synthetic housing cancellation'); let checks = 0; f.state.calls.length = 0;
    await assert.rejects(prepareBatched(copy(f.retained), { check() { if (++checks === stop) throw failure; } }), error => error === failure);
    assert.equal(f.state.calls.length, 0);
  }
  await assert.rejects(persist(f.client, f.scopeJson, copy(expected)), /original_preparation_required/);
});

test('browser fields cannot choose or disable the internally selected housing profile', async () => {
  const service = createCustomCohortContextCapture({ pool: { connect() { assert.fail('deny before connection'); } },
    authorizeMarketData() { assert.fail('deny before authorization'); } });
  const request = { auth: { userId: '80000000-0000-4000-8000-000000000001', organizations: [] }, accountId: '0000123456789',
    assignmentFileId: '41', operationId: '70000000-0000-4000-8000-000000000001',
    observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } };
  for (const extra of [{ [marker]: interpretation(4, 2).profile_ref }, { [marker]: null },
    { recordedHousingInterpretation: interpretation(4, 1).profile_ref }, { housingVersion: 1 }]) {
    await assert.rejects(service.capture({ ...request, ...extra }), /invalid_input/);
  }
});

for (const [sourceMode, mappingVersion, intentVersion] of [['cad4', 4, 5], ['combined-witness2-v1', 5, 7]]) {
  test(`new ${sourceMode} owner attempt retains its internal housing marker before source acquisition`, async () => {
    const original = await fixture({ marked: false, assignmentFileId: '41', effectiveDate: '2026-09-06' });
    const f = await reportedReplacementOwnerFixture({ captureFixture: original, sourceMode });
    const operationId = '70000000-0000-4000-8000-000000000099';
    const stop = new Error('synthetic stop before source transaction');
    f.state.beforeQuery = text => { if (f.state.phases === 2 && text.startsWith('BEGIN ')) throw stop; };
    original.state.calls.length = 0;
    await assert.rejects(f.service.capture({ auth: f.input.auth, accountId: f.input.accountId,
      assignmentFileId: f.input.assignmentFileId, operationId, observationPeriod: original.input.expected.observation_period }),
    error => error === stop);
    const intentWrites = original.state.calls.filter(c => c.tag === 'insert')
      .map(c => ({ call: c, body: JSON.parse(c.params[3]) })).filter(({ body }) => body.operation_id === operationId);
    assert.equal(intentWrites.length, 1);
    const { body, call } = intentWrites[0], profile = interpretation(mappingVersion, 2);
    assert.equal(body.intent_version, intentVersion); assert.deepEqual(body[marker], profile.profile_ref);
    assert.equal(Object.hasOwn(body, 'reported_sale_interpretation'), mappingVersion === 5);
    if (mappingVersion === 5) assert.deepEqual(body.reported_sale_interpretation, REPORTED.profile_ref);
    assert.deepEqual(body.target, original.retained.subject.target);
    assert.deepEqual(body.subject_inputs, original.retained.subject_reference);
    assert.deepEqual(body.study, original.retained.study);
    assert.equal(call.params[1], digest(body)); assert.equal(call.params[2], String(Buffer.byteLength(json(body))));
    assert.equal(f.state.commits, 1, 'original subject/intent transaction completed before the refused source transaction');
    assert.equal(f.state.marketCalls.length, 0);
    assert.equal(f.state.calls.some(c => /neighborhood-(?:cache|closure|membership):/.test(c.text)), false);
    assert.equal(f.state.db.jobs.size, 0); assert.equal(f.state.db.section, null);
    assert.equal(Object.hasOwn(original.retained, marker), false, 'existing retained graph remains unmarked');
  });
}

for (const [mappingVersion, reported] of [[4, false], [5, false], [5, true]]) test(`owner replay validates mapping${mappingVersion} reported=${reported} retained housing definition before source pages without changing report statistics`, async () => {
  const old = await fixture({ mappingVersion, reported, marked: false, assignmentFileId: '41', effectiveDate: '2026-09-06' });
  const fresh = await fixture({ mappingVersion, reported, assignmentFileId: '41', effectiveDate: '2026-09-06' });
  const before = await reportedReplacementOwnerFixture({ captureFixture: old });
  const after = await reportedReplacementOwnerFixture({ captureFixture: fresh });
  assert.equal((await before.service.prepareReportedObservations(before.input)).status, 'proposed');
  const result = await after.service.prepareReportedObservations(after.input);
  assert.equal(result.status, 'proposed');
  const assessment = f => f.state.db.assessments.get(f.state.db.head.current_revision);
  assert.ok(assessment(after).statistics.length > 0); assert.equal(assessment(after).methodology.version, 'reported-observations-v2');
  assert.deepEqual(assessment(after).statistics, assessment(before).statistics);
  assert.deepEqual(assessment(after).methodology, assessment(before).methodology);
  assert.equal(after.state.db.section, null); assert.equal(after.state.db.acceptances.size, 0, 'proposal never applies the report');
  assert.deepEqual(after.state.db.unrelated, before.state.db.unrelated);
  const firstDefinition = after.state.calls.findIndex(c => ownerReadsHash(c, fresh.profile.profile_ref.content_sha256));
  const firstSource = after.state.calls.findIndex(c => sourceHashes(fresh).some(hash => ownerReadsHash(c, hash)));
  assert.ok(firstDefinition >= 0 && firstSource > firstDefinition);
  const original = copy(assessment(after)), offset = after.state.calls.length;
  const repeated = await after.rebuildService('combined-witness2-v1').prepareReportedObservations(after.input);
  assert.equal(repeated.reused, true); assert.deepEqual(assessment(after), original);
  assert.ok(after.state.calls.slice(offset).some(c => ownerReadsHash(c, fresh.profile.profile_ref.content_sha256)));
  const key = `${JSON.parse(fresh.scopeJson).organization_id}:${fresh.profile.profile_ref.content_sha256}`;
  fresh.state.db.delete(key); after.state.calls.length = 0;
  await assert.rejects(after.service.prepareReportedObservations(after.input), /operation_conflict/);
  assert.equal(after.state.calls.some(c => sourceHashes(fresh).some(hash => ownerReadsHash(c, hash))), false);
});
