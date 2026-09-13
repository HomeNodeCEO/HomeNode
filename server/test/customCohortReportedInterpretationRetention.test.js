import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortCaptureInputs as prepare, prepareCustomCohortCaptureInputsBatched as prepareBatched,
  persistCustomCohortCaptureInputs as persist, loadCustomCohortCaptureInputs as load } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { prepareCustomCohortContextHeader } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { customCohortRepositoryFixture, customCohortScopeOf } from './fixtures/customCohortRepositoryFixture.js';

const PROFILE = getCustomCohortReportedSaleWitnessV2Profile();
const HASH = '831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e';
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const clone = value => structuredClone(value);
const hasMarker = value => Object.hasOwn(value, 'reported_sale_interpretation');
const read = (f, ref) => f.store.get(ref.content_sha256, ref.canonical_utf8_bytes).then(JSON.parse);
const writes = state => state.calls.filter(call => ['insert', 'insert-batch'].includes(call.tag));
const readsHash = (call, hash) => call.tag === 'read' ? call.params[1] === hash
  : call.tag === 'read-batch' && call.params[1].includes(hash);

// Synthetic private supplement, separate from shared source permission. It uses
// actual CSV preparation and receipt digests, not real appraisal/import data.
function privateSupplement() {
  const target = customCohortScopeOf(customCohortRepositoryFixture().state.input);
  const source = prepareAssignmentSalesCsv(Buffer.from('ListingId,CloseDate,ClosePrice,ParcelNumber,MlsStatus,LivingArea\nPRIVATE1,2024-03-01,275000,R-001,Closed,1800'));
  const { rows, ...header } = source;
  return { capture: { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1', target,
    batch: { batch_id: '20000000-0000-4000-8000-000000000001', source_sha256: source.source_sha256,
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

async function fixture({ marked = true, privateSales = false, parcelCount } = {}) {
  const result = await cadEvidenceFixture({ mappingVersion: 5, ...(parcelCount ? { parcelCount } : {}),
    ...(marked ? { reportedSaleInterpretation: clone(PROFILE.profile_ref) } : {}),
    ...(privateSales ? { privateSales: privateSupplement() } : {}) });
  const f = result.base;
  const refs = prepare(result.originalRetained).refs;
  return { ...f, ...result, state: f.f.state, retained: result.originalRetained, refs };
}

// Captured from the untouched reported-witness-v2 worktree before this retention
// change. Hashes cover the entire canonical prepared result (refs/counts/summary),
// not merely a renamed mapping/version property.
for (const [version, factory, expected] of [
  [2, () => decisionEvidenceFixture(), '2652a4cda01f6b48a911e2390987cf17c0cd57562d61ea8712b8c4634145f1cc'],
  [3, () => saleWitnessMeaningFixture(), '078e918be97c72bc7716436aeba072c76ed36ffe32f15f5539273802bb97c3fb'],
  [4, () => cadEvidenceFixture(), '0a57fa378c4dc1766ae4c17fd179a857a9a340b7daf6fe067622ec55a644b320'],
  [5, () => cadEvidenceFixture({ mappingVersion: 5 }), 'dd9b3eafec3085d57c104b451062a461fd4c3be4f0a4628cbd22deebb4ae1c58'],
]) test(`unmarked mapping${version} preserves original graph, counts and intent1 canonical hashes`, async () => {
  const result = await factory(), input = result.input.retained_inputs;
  const f = result.base ?? result;
  assert.equal(digest(prepare(input)), expected);
  assert.equal(digest(input.acquisition_intent.body), 'e3e65cfe64bcdb5ed834895d9cca407b0ddbbcdcfd4be736b5940fbcad5cfa3f');
  assert.equal(hasMarker(input), false);
  const study = await read(f, prepare(input).refs.study_input);
  assert.equal(study.study_input_version, 1); assert.equal(hasMarker(study), false);
  assert.equal(prepare(input).refs.study_input.content_sha256, '0d7113435304bd037313e927e3730673816da4e9b8caa02aeda3c37e0882989a');
  assert.deepEqual(await prepareBatched(clone(input)), prepare(input));
});

for (const privateSales of [false, true]) test(`marked ${privateSales ? 'private intent4' : 'shared intent3'} retains exact profile original and replays without changing source bytes`, async () => {
  const f = await fixture({ privateSales }), old = await fixture({ marked: false, privateSales });
  const before = json(f.retained), prepared = prepare(f.retained);
  const study = await read(f, f.refs.study_input), selection = await read(f, f.refs.selection_input);
  assert.deepEqual(PROFILE.profile_ref, { id: 'custom-local-reported-sale-witness-v2', revision: '1', content_sha256: HASH });
  assert.equal(PROFILE.definition_blob.ref.canonical_utf8_bytes, '9055');
  assert.equal(study.study_input_version, 2);
  assert.deepEqual(study.reported_sale_interpretation, { profile_ref: PROFILE.profile_ref, definition_blob: PROFILE.definition_blob.ref });
  assert.equal(await f.store.get(HASH, '9055'), PROFILE.definition_blob.canonical_json);
  assert.equal(f.retained.acquisition_intent.body.intent_version, privateSales ? 4 : 3);
  assert.deepEqual(f.retained.acquisition_intent.body.reported_sale_interpretation, PROFILE.profile_ref);
  assert.deepEqual(await read(f, f.retained.acquisition_intent.reference), f.retained.acquisition_intent.body);
  assert.equal(selection.selection_input_version, privateSales ? 2 : 1);
  assert.equal(Object.hasOwn(selection, 'private_sales'), privateSales);
  assert.deepEqual(f.retained.acquisition, old.retained.acquisition, 'profile is not a new source value, query or permission');
  assert.deepEqual(f.retained.study, old.retained.study);
  assert.deepEqual(f.refs.snapshot_evidence, old.refs.snapshot_evidence);
  assert.deepEqual(f.refs.subject_dependencies, old.refs.subject_dependencies);
  assert.notDeepEqual(f.refs.study_input, old.refs.study_input);
  assert.notDeepEqual(f.refs.selection_input, old.refs.selection_input, 'new original intent is bound in selection');
  assert.equal(f.input.expected.context_ref.context_id, old.input.expected.context_ref.context_id);
  assert.notEqual(f.input.expected.context_ref.context_sha256, old.input.expected.context_ref.context_sha256);
  assert.equal(f.queryCalls.length, old.queryCalls.length, 'fixed profile adds no source query');
  assert.deepEqual(f.marketPurposes, old.marketPurposes);
  if (privateSales) assert.deepEqual(f.retained.private_sales, old.retained.private_sales);
  const refs = await persist(f.client, f.scopeJson, prepared);
  f.state.calls.length = 0;
  const opened = await load(f.client, f.scopeJson, refs);
  assert.deepEqual(opened.retained_inputs, f.retained);
  assert.deepEqual(opened.refs, prepared.refs);
  assert.ok(f.state.calls.some(call => readsHash(call, HASH)), 'compiled profile never excuses an original blob read');
  assert.equal(writes(f.state).length, 0);
  assert.equal(Object.isFrozen(opened.retained_inputs.reported_sale_interpretation), true);
  assert.equal(Object.isFrozen(opened.acquisition_intent.body.reported_sale_interpretation), true);
  assert.equal(json(f.retained), before);
});

test('unmarked private intent2 retains old study1 and does not inherit shared profile from private currency', async () => {
  const f = await fixture({ marked: false, privateSales: true });
  assert.equal(f.retained.acquisition_intent.body.intent_version, 2);
  // The same old intent1 plus this fixed private import, hashed in the untouched
  // prior worktree before enabling the fixture option.
  assert.equal(digest(f.retained.acquisition_intent.body), '84048bc4f00d48dab2e2fa4f13aeb590aea84addd553c3fb870e6f18cc2ac661');
  assert.equal(hasMarker(f.retained), false); assert.equal(hasMarker(f.retained.acquisition_intent.body), false);
  assert.equal((await read(f, f.refs.study_input)).study_input_version, 1);
  assert.equal(f.refs.study_input.content_sha256, '0d7113435304bd037313e927e3730673816da4e9b8caa02aeda3c37e0882989a');
  assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).retained_inputs, f.retained);
});

for (const [name, mutate] of [
  ['missing private supplement', input => { delete input.private_sales; }],
  ['missing import intent', input => { delete input.acquisition_intent.body.private_sales_import; }],
  ['shared intent version', input => { input.acquisition_intent.body.intent_version = 3; }],
]) test(`marked private intent4 still refuses ${name} without writes`, async () => {
  const f = await fixture({ privateSales: true }), input = clone(f.retained); mutate(input);
  f.state.calls.length = 0;
  assert.throws(() => prepare(input), /invalid_shape|binding_mismatch/);
  await assert.rejects(prepareBatched(input), /invalid_shape|binding_mismatch/);
  assert.equal(f.state.calls.length, 0);
});

test('cooperative profile preparation seals caller descendants immediately and remains exactly synchronous', async () => {
  const f = await fixture({ parcelCount: 251 }), input = clone(f.retained), before = json(input), expected = prepare(input);
  let checks = 0;
  const pending = prepareBatched(input, { check() { checks++; } });
  assert.equal(Object.isFrozen(input.reported_sale_interpretation), true);
  assert.equal(Object.isFrozen(input.acquisition_intent.body.reported_sale_interpretation), true);
  assert.throws(() => { input.reported_sale_interpretation.revision = '2'; }, TypeError);
  assert.throws(() => { input.acquisition_intent.body.reported_sale_interpretation.id = 'other'; }, TypeError);
  assert.deepEqual(await pending, expected); assert.ok(checks > 2);
  assert.equal(json(input), before);
  await assert.rejects(persist(f.client, f.scopeJson, clone(expected)), /original_preparation_required/);
});

test('cooperative cancellation at every check preserves the same thrown error with no writes or partial result', async () => {
  const f = await fixture(); let count = 0;
  await prepareBatched(clone(f.retained), { check() { count++; } });
  assert.ok(count > 2);
  for (let stop = 1; stop <= count; stop++) {
    const abort = new Error(`synthetic cancellation ${stop}`); let at = 0;
    f.state.calls.length = 0;
    await assert.rejects(prepareBatched(clone(f.retained), { check() { if (++at === stop) throw abort; } }), error => error === abort);
    assert.equal(f.state.calls.length, 0);
  }
});

for (const [name, mutate] of [
  ['null marker', input => { input.reported_sale_interpretation = null; }],
  ['own undefined marker', input => { input.reported_sale_interpretation = undefined; }],
  ['unknown profile ID', input => { input.reported_sale_interpretation.id = 'uninstalled'; }],
  ['numeric revision', input => { input.reported_sale_interpretation.revision = 1; }],
  ['different profile hash', input => { input.reported_sale_interpretation.content_sha256 = 'f'.repeat(64); }],
  ['caller definition field', input => { input.reported_sale_interpretation.definition = {}; }],
  ['marker omitted from input only', input => { delete input.reported_sale_interpretation; }],
  ['marker omitted from intent only', input => { delete input.acquisition_intent.body.reported_sale_interpretation; }],
  ['foreign intent marker', input => { input.acquisition_intent.body.reported_sale_interpretation.revision = '2'; }],
  ['old intent version with marker', input => { input.acquisition_intent.body.intent_version = 1; }],
  ['private intent version without import', input => { input.acquisition_intent.body.intent_version = 4; }],
  ['tampered raw witness', input => { input.acquisition.capture_result.source_capture.sources.find(s => s.payload.projection.definition.role === 'transactions')
    .payload.records[0].data.raw_projection.source_raw_witness.fields.ClosePrice = { state: 'scalar', json_type: 'string', value_text: '1', utf8_bytes: 1 }; }],
  ['tampered routing', input => { input.acquisition.capture_result.source_capture.references[0].record_sources[0].source_ref = 'foreign'; }],
]) test(`profile preparation refuses ${name} without fallback or database writes`, async () => {
  const f = await fixture(), input = clone(f.retained); mutate(input);
  f.state.calls.length = 0;
  assert.throws(() => prepare(input), /custom_cohort_capture_inputs_|cached_/);
  await assert.rejects(prepareBatched(input), /custom_cohort_capture_inputs_|cached_/);
  assert.equal(f.state.calls.length, 0);
});

for (const [version, factory] of [[2, decisionEvidenceFixture], [3, saleWitnessMeaningFixture], [4, cadEvidenceFixture]]) {
  test(`fixed interpretation cannot be attached to genuine original mapping${version}`, async () => {
    const result = await factory(), f = result.base ?? result, input = clone(result.input.retained_inputs);
    input.reported_sale_interpretation = clone(PROFILE.profile_ref);
    input.acquisition_intent.body.intent_version = 3;
    input.acquisition_intent.body.reported_sale_interpretation = clone(PROFILE.profile_ref);
    input.acquisition_intent.reference = await f.store.put(json(input.acquisition_intent.body));
    f.f.state.calls.length = 0;
    assert.throws(() => prepare(input), /reported_interpretation_mapping_required/);
    await assert.rejects(prepareBatched(input), /reported_interpretation_mapping_required/);
    assert.equal(f.f.state.calls.length, 0);
  });
}

for (const [name, mutate] of [
  ['missing original', (state, key) => { state.db.delete(key); }],
  ['corrupt canonical original', (state, key) => { state.db.set(key, { ...state.db.get(key), canonical_utf8: '{}' }); }],
  ['foreign tenant original only', (state, key) => { state.db.set(`foreign:${HASH}`, state.db.get(key)); state.db.delete(key); }],
]) test(`reopen refuses ${name} before full source payloads and does not reuse earlier successful reads`, async () => {
  const f = await fixture(), key = `${JSON.parse(f.scopeJson).organization_id}:${HASH}`;
  await load(f.client, f.scopeJson, f.refs);
  mutate(f.state, key); f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, f.refs), /missing_evidence|storage_conflict/);
  const sourceHashes = f.retained.acquisition.capture_result.source_capture.source_snapshots.map(s => s.content_sha256);
  assert.ok(f.state.calls.some(call => readsHash(call, HASH)));
  assert.equal(f.state.calls.some(call => sourceHashes.some(hash => readsHash(call, hash))), false);
  assert.equal(writes(f.state).length, 0);
});

for (const [name, mutate] of [
  ['missing marker in study2', study => { delete study.reported_sale_interpretation; }],
  ['new marker in study1', study => { study.study_input_version = 1; }],
  ['unknown study version', study => { study.study_input_version = 3; }],
  ['foreign profile reference', study => { study.reported_sale_interpretation.profile_ref.id = 'other-profile'; }],
  ['foreign definition reference', study => { study.reported_sale_interpretation.definition_blob.content_sha256 = 'f'.repeat(64); }],
  ['wrong definition bytes', study => { study.reported_sale_interpretation.definition_blob.canonical_utf8_bytes = '9054'; }],
]) test(`canonical stored study refuses ${name} without silently opening legacy semantics`, async () => {
  const f = await fixture(), study = await read(f, f.refs.study_input); mutate(study);
  const changed = { ...f.refs, study_input: await f.store.put(json(study)) };
  f.state.calls.length = 0;
  await assert.rejects(load(f.client, f.scopeJson, changed), /reported_interpretation_mismatch/);
  assert.equal(writes(f.state).length, 0);
  assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).refs, f.refs, 'original remains recoverable');
});

test('a genuine different definition blob cannot become the installed profile by changing its stored reference', async () => {
  const f = await fixture(), study = await read(f, f.refs.study_input);
  const definition = JSON.parse(PROFILE.definition_blob.canonical_json);
  definition.fields.reported_close_price.units = ['CAD'];
  study.reported_sale_interpretation.definition_blob = await f.store.put(json(definition));
  const changed = { ...f.refs, study_input: await f.store.put(json(study)) };
  await assert.rejects(load(f.client, f.scopeJson, changed), /reported_interpretation_mismatch/);
});

test('canonical stored intent substitution cannot discard the already bound study interpretation', async () => {
  const f = await fixture(), selection = await read(f, f.refs.selection_input);
  const intent = await read(f, selection.acquisition_intent);
  intent.intent_version = 1; delete intent.reported_sale_interpretation;
  selection.acquisition_intent = await f.store.put(json(intent));
  const changed = { ...f.refs, selection_input: await f.store.put(json(selection)) };
  await assert.rejects(load(f.client, f.scopeJson, changed), /invalid_shape|binding_mismatch/);
  assert.deepEqual((await load(f.client, f.scopeJson, f.refs)).refs, f.refs);
});

test('a stored study downgrade cannot silently discard an original intent3 marker', async () => {
  const f = await fixture(), study = await read(f, f.refs.study_input);
  study.study_input_version = 1; delete study.reported_sale_interpretation;
  const changed = { ...f.refs, study_input: await f.store.put(json(study)) };
  await assert.rejects(load(f.client, f.scopeJson, changed), /invalid_shape|binding_mismatch/);
  const header = JSON.parse(f.input.context_header_json);
  const replacementContext = prepareCustomCohortContextHeader(json({ ...header, ...changed }));
  assert.notEqual(replacementContext.context_ref.context_sha256, f.input.expected.context_ref.context_sha256,
    'even a separately consistent changed graph could not preserve the original public context binding');
});

test('persist requires the original intent3 bytes and keeps caller transaction ownership', async () => {
  const f = await fixture(), prepared = prepare(f.retained);
  const key = `${JSON.parse(f.scopeJson).organization_id}:${f.retained.acquisition_intent.reference.content_sha256}`;
  f.state.db.delete(key); f.state.calls.length = 0;
  await assert.rejects(persist(f.client, f.scopeJson, prepared), /missing_original_input/);
  assert.equal(writes(f.state).length, 0);
  assert.ok(f.state.calls.every(call => !/\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(call.sql)));
});
