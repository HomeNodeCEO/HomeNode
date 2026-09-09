import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortSaleWitnessMeaningResolver as create, getCustomSaleWitnessMeaningProfile as profile,
  CUSTOM_COHORT_SALE_WITNESS_MEANING_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortSaleWitnessMeaningResolver.js';
import { createCustomCohortSaleMeaningResolver as createV2, getCustomSaleMeaningProfile as profileV2 } from '../src/services/neighborhoodAssessment/customCohortSaleMeaningResolver.js';
import { CACHED_SALE_WITNESS_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { saleWitnessMeaningFixture, syntheticSaleWitness } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';

const base = saleWitnessMeaningFixture();
const digest = text => createHash('sha256').update(text).digest('hex');
function resolve(fixture, recordId = fixture.recordId) {
  const resolver = create(fixture.input), ref = resolver.deriveEvidenceRef(fixture.sourceRef, recordId);
  return { resolver, ref, result: resolver.resolveMeaning(JSON.stringify(ref)) };
}
const withInput = async options => resolve(await saleWitnessMeaningFixture(options));
const currentPair = 'source_current_price_raw_current_price', closePair = 'canonical_sale_price_raw_close_price';

test('installed v3 witness profile is content-bound, closed over all 28 fields and immutable', () => {
  const value = profile(), definition = JSON.parse(value.definition_blob.canonical_json);
  assert.equal(definition.cached_mapping_version, 3); assert.equal(definition.witness_version, 1);
  assert.deepEqual(Object.keys(definition.witness_fields).sort(), [...CACHED_SALE_WITNESS_FIELDS].sort());
  assert.equal(value.profile_ref.content_sha256, digest(value.definition_blob.canonical_json));
  assert.equal(value.definition_blob.ref.content_sha256, value.profile_ref.content_sha256);
  assert.equal(definition.provider_meaning, 'not_established');
  assert.deepEqual(definition.limits, LIMITS);
  assert.equal(profile(), value); assert.ok(Object.isFrozen(value.definition_blob.ref));
  assert.throws(() => { value.profile_ref.id = 'caller-profile'; }, TypeError);
  assert.notEqual(value.profile_ref.id, profileV2().profile_ref.id);
});

test('actual retained mapping3 record resolves exact refs/literals without queries or authority promotion', async () => {
  const fixture = await base, before = json(fixture.input), { result, ref } = resolve(fixture);
  const source = fixture.input.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.id === fixture.sourceRef);
  const stored = source.payload.records.find(row => row.record_id === fixture.recordId).data.raw_projection;
  assert.deepEqual(result.evidence_ref, ref); assert.equal(Object.keys(ref).length, 7);
  assert.deepEqual(result.binding.context_ref, fixture.input.expected.context_ref);
  assert.deepEqual(result.profile_ref, profile().profile_ref);
  assert.deepEqual(result.witness, stored.source_raw_witness);
  assert.equal(result.typed_fields.source_mls_status.literal.value_text, 'Closed');
  assert.equal(result.typed_fields.source_row_number.literal.value_text, '42');
  assert.equal(result.typed_fields.source_row_number.stored_type, 'number');
  assert.equal(result.witness.fields.ClosePrice.value_text, '275000');
  assert.equal(result.witness.fields.ListPrice.value_text, '280000');
  assert.equal(result.witness.fields.PropertyAttachedYN.value_text, 'false');
  assert.equal(result.witness_interpretations.PropertyAttachedYN.status, 'observed');
  assert.equal(result.comparisons[currentPair].status, 'agree');
  assert.equal(result.comparisons[closePair].status, 'agree');
  assert.equal(result.comparisons.source_mls_status_raw_mls_status.status, 'agree');
  assert.equal(result.comparison_scope.evaluated_record_count, 1);
  assert.equal(result.status, 'observations_only'); assert.equal(result.authority, 'not_established');
  assert.equal(result.assessment, null); assert.equal(result.apply.status, 'blocked');
  assert.equal(result.witness.fields.Currency.value_text, 'USD');
  assert.equal(result.witness.fields.LivingAreaUnits.value_text, 'Square Feet');
  for (const key of ['currency', 'source_area_units', 'gla_at_sale', 'housing_taxonomy', 'sale_completion',
    'provider_field_meaning', 'market_eligibility', 'transaction_equivalence']) assert.equal(result.unavailable[key], 'not_established');
  for (const comparison of Object.values(result.comparisons)) {
    assert.equal(comparison.agreement_is_independent_confirmation, false);
    assert.equal(comparison.establishes_provider_meaning, false);
  }
  assert.match(result.unavailable.source_revision_lineage, /typed_columns_may_precede/);
  assert.equal(result.unavailable.original_file_bytes, 'not_retained_by_scalar_witness');
  assert.equal(json(fixture.input), before); assert.equal(fixture.f.state.calls.length, 0);
  assert.ok(Object.isFrozen(result.witness.fields.ClosePrice)); assert.ok(Object.isFrozen(result.comparisons));
});

test('v2 installed profile and complete default result bytes remain exactly unchanged', async () => {
  const fixture = await decisionEvidenceFixture(), resolver = createV2(fixture.input);
  const ref = resolver.deriveEvidenceRef(fixture.sourceRef, fixture.recordId);
  assert.equal(profileV2().profile_ref.content_sha256, '1eedaab8d13481b87e53d7b6766fd713455a70e5f0cd9d3930b8f1bffb62372b');
  assert.equal(digest(json(resolver.resolveMeaning(JSON.stringify(ref)))), '16d694b742e0b73c3700c0bcd81bbb238df77ddfbdd14e46e2443fc0355060cb');
  assert.throws(() => create(fixture.input), /mapping3_required/);
  const v3 = await base, old = createV2(v3.input), v3ref = old.deriveEvidenceRef(v3.sourceRef, v3.recordId);
  assert.throws(() => old.resolveMeaning(JSON.stringify(v3ref)), /unsupported_mapping_version/);
});

test('CurrentPrice, ClosePrice and ListPrice have distinct pairs, with no substitute-price fallback', async () => {
  const { result } = await withInput({ rawPayload: { CurrentPrice: '300000', ClosePrice: '270000', ListPrice: '275000' } });
  assert.equal(result.comparisons[currentPair].status, 'conflicting');
  assert.equal(result.comparisons[closePair].status, 'conflicting');
  assert.equal(result.witness.fields.ListPrice.value_text, '275000');
  assert.equal(Object.values(result.comparisons).some(pair => pair.witness_field === 'ListPrice'), false);
  const { result: missing } = await withInput({ rawPayload: { CurrentPrice: '275000', ListPrice: '275000' }, saleOverrides: { sale_price: null } });
  assert.equal(missing.comparisons[currentPair].status, 'agree');
  assert.equal(missing.comparisons[closePair].status, 'incomplete');
  assert.equal(missing.witness_interpretations.ClosePrice.presence, 'absent');
  assert.equal(missing.typed_fields.sale_price.presence, 'sql_null');
});

test('exact decimal scale and beyond-safe-integer numeric JSON text survive without float rounding', async () => {
  const witness = structuredClone(syntheticSaleWitness({ CurrentPrice: '9007199254740993.0100', ClosePrice: '9007199254740993.02' }));
  witness.fields.CurrentPrice.json_type = 'number';
  const { result } = await withInput({ witness, saleOverrides: { source_current_price: '9007199254740993.01', sale_price: '9007199254740993.01' } });
  assert.equal(result.witness.fields.CurrentPrice.value_text, '9007199254740993.0100');
  assert.equal(result.witness.fields.CurrentPrice.json_type, 'number');
  assert.equal(result.witness_interpretations.CurrentPrice.exact_decimal, '9007199254740993.01');
  assert.equal(result.comparisons[currentPair].status, 'agree');
  assert.equal(result.comparisons[currentPair].comparison_basis, 'exact_numeric_magnitude');
  assert.equal(result.comparisons[closePair].status, 'conflicting');
  assert.equal(result.typed_fields.sale_price.literal.value_text, '9007199254740993.01');
});

for (const value of ['1e3', '1,000', ' 1000 ', '+1000', '-1', '01', 'NaN', 'Infinity', '0'.repeat(257), false]) {
  test(`unsupported decimal literal ${JSON.stringify(value).slice(0, 40)} remains literal and invalid`, async () => {
    const { result } = await withInput({ rawPayload: { CurrentPrice: value } });
    assert.equal(result.witness.fields.CurrentPrice.value_text, String(value));
    assert.equal(result.witness_interpretations.CurrentPrice.status, 'invalid');
    assert.equal(result.witness_interpretations.CurrentPrice.exact_decimal, null);
    assert.equal(result.comparisons[currentPair].status, 'incomplete');
  });
}

test('typed numeric money is not reconstituted as exact SQL numeric text', async () => {
  const { result } = await withInput({ saleOverrides: { source_current_price: 275000 } });
  assert.equal(result.typed_fields.source_current_price.stored_type, 'number');
  assert.equal(result.typed_fields.source_current_price.status, 'invalid');
  assert.equal(result.typed_fields.source_current_price.reason, 'invalid_stored_type');
  assert.equal(result.typed_fields.source_current_price.exact_decimal, null);
  assert.equal(result.comparisons[currentPair].status, 'incomplete');
});

test('zero amounts/counts and false flags are observations, while zero living area is not a usable denominator', async () => {
  const { result } = await withInput({ rawPayload: { CurrentPrice: 0, ClosePrice: '0.00', DaysOnMarket: 0,
    LivingArea: '0', PropertyAttachedYN: false }, saleOverrides: { source_current_price: '0', sale_price: '0', source_days_on_market: 0 } });
  assert.equal(result.witness.fields.CurrentPrice.json_type, 'number');
  assert.equal(result.witness_interpretations.CurrentPrice.exact_decimal, '0');
  assert.equal(result.witness_interpretations.ClosePrice.status, 'observed');
  assert.equal(result.witness_interpretations.DaysOnMarket.exact_decimal, '0');
  assert.equal(result.comparisons.source_days_on_market_raw_days_on_market.status, 'agree');
  assert.equal(result.witness_interpretations.LivingArea.status, 'invalid');
  assert.equal(result.witness_interpretations.PropertyAttachedYN.status, 'observed');
  assert.equal(result.witness.fields.PropertyAttachedYN.value_text, 'false');
});

for (const [payload, root, type] of [[undefined, 'sql_null', null], [null, 'json_null', 'null'],
  [[], 'non_object', 'array'], ['root', 'non_object', 'string'], [false, 'non_object', 'boolean'], [0, 'non_object', 'number']]) {
  test(`unavailable payload root ${root}/${type} is not an empty source object or usable zero`, async () => {
    const { result } = await withInput({ rawPayload: payload });
    assert.equal(result.witness.root_state, root); assert.equal(result.witness.root_json_type, type);
    assert.equal(result.witness_status, 'retained');
    assert.equal(Object.keys(result.witness.fields).length, 28);
    for (const [key, cell] of Object.entries(result.witness.fields)) {
      assert.deepEqual(cell, { state: 'payload_unavailable', json_type: null, value_text: null, utf8_bytes: null });
      assert.equal(result.witness_interpretations[key].presence, 'payload_unavailable');
      assert.equal(result.witness_interpretations[key].status, 'unavailable');
    }
    assert.equal(result.comparisons[currentPair].status, 'incomplete');
  });
}

test('absent, explicit JSON null, blank, compound, oversize and literal false remain distinct', async () => {
  const { result } = await withInput({ rawPayload: { CloseDate: null, CurrentPrice: '', ClosePrice: ' \t', ListPrice: {},
    OriginalListPrice: [], Currency: 'x'.repeat(513), PropertyAttachedYN: false } });
  const expected = { MlsStatus: ['absent', 'absent'], CloseDate: ['json_null', 'json_null'],
    CurrentPrice: ['scalar', 'blank'], ClosePrice: ['scalar', 'blank'], ListPrice: ['non_scalar', 'non_scalar'],
    OriginalListPrice: ['non_scalar', 'non_scalar'], Currency: ['oversize', 'oversize'], PropertyAttachedYN: ['scalar', 'present'] };
  for (const [key, [state, presence]] of Object.entries(expected)) {
    assert.equal(result.witness.fields[key].state, state); assert.equal(result.witness_interpretations[key].presence, presence);
  }
  assert.equal(result.witness.fields.ClosePrice.value_text, ' \t');
  assert.equal(result.witness.fields.Currency.utf8_bytes, 513); assert.equal(result.witness.fields.Currency.value_text, null);
  assert.equal(result.witness.fields.ListPrice.json_type, 'object'); assert.equal(result.witness.fields.OriginalListPrice.json_type, 'array');
});

test('date and status pairings compare exact local values without normalizing or asserting Closed eligibility', async () => {
  const { result } = await withInput({ rawPayload: { CloseDate: '2024-03-02', MlsStatus: 'closed', StandardStatus: 'Closed' } });
  assert.equal(result.comparisons.source_close_date_raw_close_date.status, 'conflicting');
  assert.equal(result.comparisons.canonical_closing_date_raw_close_date.status, 'conflicting');
  assert.equal(result.comparisons.source_mls_status_raw_mls_status.status, 'conflicting');
  assert.equal(result.witness.fields.StandardStatus.value_text, 'Closed');
  assert.equal(Object.values(result.comparisons).some(pair => pair.witness_field === 'StandardStatus'), false);
  const { result: timestamp } = await withInput({ rawPayload: { CloseDate: '2024-03-01T00:00:00Z', MlsStatus: ' Closed ' } });
  assert.equal(timestamp.witness_interpretations.CloseDate.status, 'invalid');
  assert.equal(timestamp.comparisons.source_mls_status_raw_mls_status.status, 'conflicting');
});

for (const [value, presence] of [[null, 'sql_null'], ['', 'blank'], ['  ', 'blank']]) {
  test(`typed MLS status ${JSON.stringify(value)} is retained without a raw status fallback`, async () => {
    const { result } = await withInput({ saleOverrides: { source_mls_status: value } });
    assert.equal(result.typed_fields.source_mls_status.presence, presence);
    assert.equal(result.typed_fields.source_mls_status.literal?.value_text ?? null, value);
    assert.equal(result.comparisons.source_mls_status_raw_mls_status.status, 'incomplete');
    assert.equal(result.witness.fields.MlsStatus.value_text, 'Closed');
  });
}

for (const value of [-2_147_483_648, -1, 0, 2_147_483_647, null]) {
  test(`stored row number ${value} stays an observation, not original-file provenance`, async () => {
    const { result } = await withInput({ saleOverrides: { source_row_number: value } });
    const field = result.typed_fields.source_row_number;
    assert.equal(field.status, value === null ? 'unavailable' : 'observed');
    assert.equal(field.literal?.value_text ?? null, value === null ? null : String(value));
    assert.equal(result.unavailable.original_file_bytes, 'not_retained_by_scalar_witness');
    assert.match(result.unavailable.source_revision_lineage, /not_established/);
  });
}

test('all fields retain maximal bounded text, private raw keys stay excluded, and interpretation does not clip', async () => {
  const payload = Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key, 'é'.repeat(256)]));
  payload.provider_secret = 'private-not-retained'; payload.raw_payload = { secret: true };
  const { result } = await withInput({ rawPayload: payload });
  assert.equal(Object.keys(result.witness.fields).length, 28);
  for (const cell of Object.values(result.witness.fields)) assert.equal(cell.value_text, 'é'.repeat(256));
  assert.equal(json(result).includes('private-not-retained'), false); assert.equal(json(result).includes('provider_secret'), false);
  assert.ok(Buffer.byteLength(json(result)) <= LIMITS.output_utf8_bytes);
});

test('different retained events never join by matching price or supply missing raw fields', async () => {
  const account = (await base).accountIds[0];
  const fixture = await saleWitnessMeaningFixture({ rawPayload: {}, extraTransactions: [{ source_record_id: '11', sale_id: '21',
    primary_account_id: account, sale_account_id: account, source_record_hash: 'c'.repeat(64), record_type: 'closed_sale',
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01', sale_price: '275000', source_current_price: '275000',
    source_raw_witness: syntheticSaleWitness({ CurrentPrice: '275000', ClosePrice: '275000' }) }] });
  const { result } = resolve(fixture);
  assert.equal(result.comparison_scope.evaluated_record_count, 1);
  assert.equal(result.comparisons[currentPair].status, 'incomplete');
  assert.equal(result.witness.fields.CurrentPrice.state, 'absent');
});

test('actual canonical-only legacy capture has no fabricated witness or comparison fallback', async () => {
  const fixture = await saleWitnessMeaningFixture({ extraTransactions: [{ source_record_id: null, sale_id: '22',
    sale_account_id: 'R-001', sale_closing_date: '2024-04-01', sale_price: '300000', sale_source: 'synthetic',
    sale_loaded_at: '2026-09-05T00:00:00.000Z' }] });
  const source = fixture.input.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.id === fixture.sourceRef);
  const row = source.payload.records.find(record => record.data.data.source_record_id === null);
  assert.ok(row);
  for (const key of ['source_raw_witness', 'source_mls_status', 'source_row_number']) assert.equal(Object.hasOwn(row.data.raw_projection, key), false);
  const { result } = resolve(fixture, row.record_id);
  assert.equal(result.witness_status, 'source_record_unavailable'); assert.equal(result.witness, null);
  assert.equal(result.typed_fields.sale_price.literal.value_text, '300000');
  assert.equal(result.typed_fields.sale_closing_date.literal.value_text, '2024-04-01');
  assert.equal(result.typed_fields.source_mls_status.presence, 'absent');
  assert.equal(result.typed_fields.source_row_number.presence, 'absent');
  for (const observation of Object.values(result.witness_interpretations)) {
    assert.equal(observation.presence, 'source_record_unavailable'); assert.equal(observation.status, 'unavailable');
  }
  for (const comparison of Object.values(result.comparisons)) assert.equal(comparison.status, 'incomplete');
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
});

for (const value of ['12', false, 1.5, -1]) {
  test(`typed integer ${JSON.stringify(value)} never gains validity from matching raw text`, async () => {
    const { result } = await withInput({ saleOverrides: { source_days_on_market: value }, rawPayload: { DaysOnMarket: '12' } });
    assert.equal(result.typed_fields.source_days_on_market.status, 'invalid');
    assert.equal(result.typed_fields.source_days_on_market.literal.value_text, String(value));
    assert.equal(result.witness_interpretations.DaysOnMarket.status, 'observed');
    assert.equal(result.comparisons.source_days_on_market_raw_days_on_market.status, 'incomplete');
  });
}

for (const value of ['false', 'true', 0, 1]) {
  test(`raw attachment ${JSON.stringify(value)} retains original type without boolean coercion`, async () => {
    const { result } = await withInput({ rawPayload: { PropertyAttachedYN: value } });
    assert.equal(result.witness.fields.PropertyAttachedYN.value_text, String(value));
    assert.equal(result.witness.fields.PropertyAttachedYN.json_type, typeof value);
    assert.equal(result.witness_interpretations.PropertyAttachedYN.status, 'invalid');
    assert.equal(result.unavailable.housing_taxonomy, 'not_established');
  });
}

test('bounded decimal endpoints preserve all digits and reject overlong text without clipping', async () => {
  const maximum = '9'.repeat(LIMITS.decimal_utf8_bytes), overlong = `${maximum}9`;
  const { result } = await withInput({ rawPayload: { CurrentPrice: maximum, ClosePrice: overlong },
    saleOverrides: { source_current_price: maximum, sale_price: overlong } });
  assert.equal(result.witness.fields.CurrentPrice.value_text, maximum);
  assert.equal(result.witness_interpretations.CurrentPrice.exact_decimal, maximum);
  assert.equal(result.comparisons[currentPair].status, 'agree');
  assert.equal(result.witness.fields.ClosePrice.value_text, overlong);
  assert.equal(result.typed_fields.sale_price.literal.value_text, overlong);
  assert.equal(result.witness_interpretations.ClosePrice.status, 'invalid');
  assert.equal(result.typed_fields.sale_price.status, 'invalid');
});

test('invalid calendar dates stay literal; leap-day syntax alone does not prove closing', async () => {
  const { result } = await withInput({ rawPayload: { CloseDate: '2023-02-29' } });
  assert.equal(result.witness.fields.CloseDate.value_text, '2023-02-29');
  assert.equal(result.witness_interpretations.CloseDate.status, 'invalid');
  assert.equal(result.comparisons.source_close_date_raw_close_date.status, 'incomplete');
  const { result: leap } = await withInput({ rawPayload: { CloseDate: '2024-02-29' } });
  assert.equal(leap.witness_interpretations.CloseDate.status, 'observed');
  assert.equal(leap.unavailable.sale_completion, 'not_established');
});

test('altered seven-part references, non-sale roles and cross-context records fail closed', async () => {
  const fixture = await base, { resolver, ref } = resolve(fixture);
  for (const key of ['manifest_sha256', 'chunk_sha256', 'record_content_sha256']) {
    assert.throws(() => resolver.resolveMeaning(JSON.stringify({ ...ref, [key]: 'f'.repeat(64) })));
  }
  for (const [key, value] of [['capture_id', 'foreign'], ['capture_revision', '2'], ['chunk_id', 'foreign'], ['record_key', 'foreign']]) {
    assert.throws(() => resolver.resolveMeaning(JSON.stringify({ ...ref, [key]: value })));
  }
  const other = await saleWitnessMeaningFixture({ rawPayload: { CurrentPrice: 'different-context' } });
  const foreign = resolve(other).ref; assert.notDeepEqual(foreign, ref);
  assert.throws(() => resolver.resolveMeaning(JSON.stringify(foreign)));
  const source = fixture.input.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.payload.projection.definition.role === 'parcels');
  assert.throws(() => resolver.resolveMeaning(JSON.stringify(resolver.deriveEvidenceRef(source.id, source.payload.records[0].record_id))), /transactions_role_required/);
});

test('profile flags, wrong scope, relabeled/tampered graph and hostile objects cannot authorize meaning', async () => {
  const fixture = await base, { resolver, ref } = resolve(fixture);
  assert.throws(() => create(fixture.input, profile()), /arguments/);
  assert.throws(() => resolver.resolveMeaning(JSON.stringify(ref), { supported: true }), /arguments/);
  assert.throws(() => resolver.resolveMeaning(ref));
  for (const mutate of [input => { input.expected.target.account_id = 'OTHER'; },
    input => { input.expected.target.assignment_file_id = '2'; },
    input => { input.selection.supported = true; },
    input => { const source = input.retained_inputs.acquisition.capture_result.source_capture.sources.find(row => row.id === fixture.sourceRef);
      source.payload.records[0].data.raw_projection.source_raw_witness.fields.ClosePrice.value_text = '275001'; },
    input => { const acquisition = input.retained_inputs.acquisition, compact = JSON.parse(acquisition.compact_metadata_json);
      compact.mapping_version = 2; acquisition.compact_metadata_json = json(compact); }]) {
    const input = structuredClone(fixture.input); mutate(input); assert.throws(() => create(input));
  }
  let calls = 0;
  const input = structuredClone(fixture.input);
  Object.defineProperty(input, 'retained_inputs', { enumerable: true, get() { calls++; throw Error('getter'); } });
  assert.throws(() => create(input)); assert.equal(calls, 0);
  const proxy = new Proxy({}, { get() { calls++; throw Error('proxy'); }, ownKeys() { calls++; throw Error('proxy'); } });
  assert.throws(() => create(proxy)); assert.equal(calls, 0);
});

test('meaning is detached from caller mutation and output cannot be altered into ready facts', async () => {
  const fixture = await base, input = structuredClone(fixture.input), resolver = create(input);
  const ref = resolver.deriveEvidenceRef(fixture.sourceRef, fixture.recordId), before = resolver.resolveMeaning(JSON.stringify(ref));
  input.retained_inputs.acquisition.capture_result.source_capture.sources.length = 0;
  input.expected.context_ref.context_sha256 = 'f'.repeat(64);
  assert.deepEqual(resolver.resolveMeaning(JSON.stringify(ref)), before);
  assert.throws(() => { before.witness.fields.CurrentPrice.value_text = '0'; }, TypeError);
  assert.throws(() => { before.apply.status = 'ready'; }, TypeError);
});
