import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { CACHED_ROW_MAPPING_VERSION, CACHED_ROW_PROJECTION_FIELDS, mapCachedParcelRow, mapCachedAccountRow,
  mapCachedSaleRow, mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { CACHED_WITNESS_MAPPING_VERSION, mapWitnessParcelRow, mapWitnessAccountRow,
  mapWitnessSaleRow, mapWitnessSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV3.js';
import { CACHED_SALE_WITNESS_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';

const EXTRA = ['source_mls_status', 'source_row_number', 'source_raw_witness'];
const absent = () => ({ state: 'absent', json_type: null, value_text: null, utf8_bytes: null });
function witness(root = 'object') {
  return { witness_version: 1, root_state: root, root_json_type: root === 'sql_null' ? null : root === 'json_null' ? 'null' : 'object',
    fields: Object.fromEntries(CACHED_SALE_WITNESS_FIELDS.map(key => [key, root === 'object' ? absent()
      : { state: 'payload_unavailable', json_type: null, value_text: null, utf8_bytes: null }])) };
}
function scalar(value, kind = 'string') {
  return { state: 'scalar', json_type: kind, value_text: value, utf8_bytes: Buffer.byteLength(value) };
}
const parcel = () => ({ object_id: '9007199254740993', account_id: 'R-0001-001', low_parcel_id: '0001001',
  residential_year_built: 2004, residential_area_sqft: '2000.125', parcel_area_sqft: '0', current_market_value: '300000',
  land_use_category: 'one_unit', subdivision_name: 'Recorded Label',
  stored_geometry_geojson: { type: 'MultiPolygon', coordinates: [[[[-96.8, 32.8], [-96.7, 32.8], [-96.8, 32.9], [-96.8, 32.8]]]] } });
const account = () => ({ account_id: 'R-0001-001', county: 'Collin', subdivision: '  Name  ', legal_description: null });
const saleBase = () => ({ source_record_id: '9007199254740993', sale_id: '9007199254740995', sale_account_id: 'R-0001-001',
  primary_account_id: 'R-0001-001', record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
  sale_price: '300000.00', source_current_price: '300000.00', source_living_area: '2000.125', source_days_on_market: 0,
  source_garage_yn: false, source_housing_type: 'Single Family', data_quality_flags: [], source_sha256: 'a'.repeat(64) });
const sale = () => ({ ...saleBase(), source_mls_status: 'Closed', source_row_number: 3, source_raw_witness: witness() });
const link = () => ({ parcel_link_id: '99', source_record_id: '9007199254740993', account_id: 'R-0001-001', source_position: 1,
  parcel_sequence: 1, is_resolved: true, match_method: 'exact', parcel_role: 'primary' });
const common = row => Object.fromEntries(Object.entries(row.data).filter(([key]) => !['cached_mapping_version', 'cached_projection_sha256'].includes(key)));
const v3Error = reason => error => error.code === 'NEIGHBORHOOD_CACHED_WITNESS_ROW_INVALID' && error.reason === reason;

for (const [kind, make, previous, next] of [
  ['parcel', parcel, mapCachedParcelRow, mapWitnessParcelRow],
  ['account', account, mapCachedAccountRow, mapWitnessAccountRow],
  ['sale_link', link, mapCachedSaleLinkRow, mapWitnessSaleLinkRow],
]) test(`${kind} wrapper only versions the digest, preserving v2 raw values, normalized data and gaps`, () => {
  const input = make(), before = previous(input), result = next(input);
  assert.equal(result.record_id, before.record_id);
  assert.deepEqual(result.raw_projection, before.raw_projection);
  assert.deepEqual(common(result), common(before)); assert.deepEqual(result.capability_gaps, before.capability_gaps);
  assert.equal(result.data.cached_mapping_version, 3);
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 3, projection_kind: kind,
    raw_projection: result.raw_projection }));
  assert.notEqual(result.data.cached_projection_sha256, before.data.cached_projection_sha256);
  assert.deepEqual(previous(input), before, 'v3 invocation cannot mutate v2 behavior/input');
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.raw_projection));
});

test('v2 remains the default version and never retains any of the additive witness aliases', () => {
  assert.equal(CACHED_ROW_MAPPING_VERSION, 2); assert.equal(CACHED_WITNESS_MAPPING_VERSION, 3);
  const before = mapCachedSaleRow(saleBase()); mapWitnessSaleRow(sale());
  assert.deepEqual(mapCachedSaleRow(saleBase()), before);
  const old = mapCachedSaleRow(sale());
  assert.equal(old.data.cached_mapping_version, 2);
  assert.equal(old.data.cached_projection_sha256, before.data.cached_projection_sha256);
  for (const field of EXTRA) { assert.equal(CACHED_ROW_PROJECTION_FIELDS.sale.includes(field), false); assert.equal(Object.hasOwn(old.raw_projection, field), false); }
  assert.ok(old.capability_gaps.includes('projection_fields_not_retained'));
});

test('sale adds only exact fixed validated witness fields and hashes the complete v3 projection', () => {
  const input = sale(); input.source_raw_witness.fields.ClosePrice = scalar('9007199254740993.123400', 'number');
  input.source_raw_witness.fields.MlsStatus = scalar(' Closed ');
  input.source_raw_witness.fields.Currency = scalar(' USD ');
  input.source_raw_witness.fields.LivingAreaUnits = scalar('Square Feet');
  const previous = mapCachedSaleRow(saleBase()), result = mapWitnessSaleRow(input);
  assert.deepEqual(Object.keys(result.raw_projection).sort(), [...Object.keys(previous.raw_projection), ...EXTRA].sort());
  assert.deepEqual(common(result), common(previous)); assert.deepEqual(result.capability_gaps, previous.capability_gaps);
  assert.equal(result.raw_projection.source_mls_status, 'Closed'); assert.equal(result.raw_projection.source_row_number, 3);
  assert.deepEqual(result.raw_projection.source_raw_witness, input.source_raw_witness);
  assert.equal(result.raw_projection.source_raw_witness.fields.ClosePrice.value_text, '9007199254740993.123400');
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 3,
    projection_kind: 'sale', raw_projection: result.raw_projection }));
  assert.ok(Object.isFrozen(result.raw_projection.source_raw_witness.fields.ClosePrice));
  input.source_raw_witness.fields.ClosePrice.value_text = '0'; input.data_quality_flags.push('later');
  assert.equal(result.raw_projection.source_raw_witness.fields.ClosePrice.value_text, '9007199254740993.123400');
  assert.deepEqual(result.raw_projection.data_quality_flags, []);
  assert.equal(result.data.market_eligible, null); assert.equal(result.data.gla_sqft_at_sale, null);
  assert.equal(Object.hasOwn(result.data, 'currency'), false); assert.equal(result.data.historical_support, 'unknown');
  assert.ok(result.capability_gaps.includes('sale_price_meaning_unverified'));
});

test('v3 projection ordering and ignored private data cannot alter the retained witness/hash', () => {
  const input = sale(), first = mapWitnessSaleRow(input), reversed = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(mapWitnessSaleRow(reversed), first);
  const privateRow = mapWitnessSaleRow({ ...input, raw_payload: { PrivateRemarks: 'do not retain this' },
    source_files: [{ secret: true }], market_eligible: true, gla_sqft_at_sale: 2000, currency: 'USD', verified: true });
  assert.deepEqual(privateRow.raw_projection, first.raw_projection);
  assert.equal(privateRow.data.cached_projection_sha256, first.data.cached_projection_sha256);
  assert.deepEqual(common(privateRow), common(first));
  assert.ok(privateRow.capability_gaps.includes('projection_fields_not_retained'));
  assert.doesNotMatch(JSON.stringify(privateRow), /do not retain this|PrivateRemarks|source_files|"verified":true/);
});

test('SQL NULL raw payload, JSON null root, empty object and null field stay distinct, never absent witness aliases', () => {
  const inputs = ['sql_null', 'json_null', 'object'].map(root => ({ ...sale(), source_mls_status: null,
    source_row_number: null, source_raw_witness: witness(root) }));
  const nullField = sale(); nullField.source_raw_witness.fields.ClosePrice = { state: 'json_null', json_type: 'null', value_text: null, utf8_bytes: null };
  inputs.push(nullField);
  const results = inputs.map(mapWitnessSaleRow);
  assert.equal(new Set(results.map(r => r.data.cached_projection_sha256)).size, 4);
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(results[i].raw_projection.source_mls_status, inputs[i].source_mls_status);
    assert.equal(results[i].raw_projection.source_row_number, inputs[i].source_row_number);
    assert.deepEqual(results[i].raw_projection.source_raw_witness, inputs[i].source_raw_witness);
  }
  assert.equal(results[0].raw_projection.source_raw_witness.fields.ClosePrice.state, 'payload_unavailable');
  assert.equal(results[2].raw_projection.source_raw_witness.fields.ClosePrice.state, 'absent');
});

test('source-only row still lacks canonical price/date; canonical legacy has no source witness fields', () => {
  const source = mapWitnessSaleRow({ ...sale(), sale_id: null, sale_account_id: null, sale_price: null, sale_closing_date: null });
  assert.equal(source.data.canonical_transaction_id, null); assert.equal(source.data.sale_price, null); assert.equal(source.data.sale_date, null);
  assert.ok(source.capability_gaps.includes('canonical_sale_identity_unavailable'));
  for (const sourceIdentity of [null, undefined]) {
    const input = { sale_id: '12', sale_account_id: 'R-0001-001', sale_price: '300000.00', sale_closing_date: '2024-03-01' };
    if (sourceIdentity === null) input.source_record_id = null;
    const legacy = mapWitnessSaleRow(input);
    assert.equal(legacy.record_id, 'core.sales:12'); assert.equal(legacy.data.source_record_id, null);
    assert.ok(legacy.capability_gaps.includes('source_record_unavailable'));
    for (const field of EXTRA) assert.equal(Object.hasOwn(legacy.raw_projection, field), false);
    assert.deepEqual(common(legacy), common(mapCachedSaleRow(input)));
  }
});

for (const field of EXTRA) test(`source-backed row requires own ${field}; legacy cannot claim it`, () => {
  const missing = sale(); delete missing[field];
  assert.throws(() => mapWitnessSaleRow(missing), v3Error('source_witness_fields_required'));
  const undef = sale(); undef[field] = undefined;
  assert.throws(() => mapWitnessSaleRow(undef), v3Error('data_properties_required'));
  assert.throws(() => mapWitnessSaleRow({ sale_id: '12', source_record_id: null, [field]: sale()[field] }), v3Error('legacy_source_witness'));
});

test('literal status preserves null, blank, whitespace and UTF8 boundary without closed-sale inference', () => {
  const values = [null, '', ' ', ' closed ', 'CLOSED', 'é'.repeat(256)];
  const results = values.map(source_mls_status => mapWitnessSaleRow({ ...sale(), record_type: 'listing', source_mls_status }));
  assert.equal(new Set(results.map(r => r.data.cached_projection_sha256)).size, values.length);
  for (let i = 0; i < values.length; i++) {
    assert.equal(results[i].raw_projection.source_mls_status, values[i]);
    assert.equal(results[i].data.record_type, 'listing'); assert.equal(results[i].data.market_eligible, null);
  }
  for (const value of [false, 1, {}, 'x'.repeat(513), 'é'.repeat(257), '\u0000', '\ud800']) {
    assert.throws(() => mapWitnessSaleRow({ ...sale(), source_mls_status: value }), v3Error('source_mls_status'));
  }
});

test('row number is exact SQL int32/null observation without string coercion or provenance inference', () => {
  for (const value of [null, -2_147_483_648, -1, 0, 1, 2_147_483_647]) {
    const result = mapWitnessSaleRow({ ...sale(), source_row_number: value });
    assert.equal(result.raw_projection.source_row_number, value);
    assert.equal(result.data.historical_support, 'unknown');
  }
  for (const value of ['1', '', false, -0, 1.5, 2_147_483_648, -2_147_483_649, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => mapWitnessSaleRow({ ...sale(), source_row_number: value }), v3Error('source_row_number'));
  }
});

test('witness validator is actually reused; overflow sentinel and unknown/private witness keys fail closed', () => {
  assert.throws(() => mapWitnessSaleRow({ ...sale(), source_raw_witness: null }), error => error.code === 'CACHED_SALE_WITNESS_INVALID' && error.reason === 'witness_byte_limit');
  const extra = sale(); extra.source_raw_witness.fields.PrivateRemarks = scalar('private');
  assert.throws(() => mapWitnessSaleRow(extra), /invalid_cached_sale_witness/);
  const invalid = sale(); invalid.source_raw_witness.fields.ClosePrice = scalar('1.00', 'number');
  invalid.source_raw_witness.fields.ClosePrice.utf8_bytes = 1;
  assert.throws(() => mapWitnessSaleRow(invalid), /invalid_cached_sale_witness/);
  const oversize = sale(); oversize.source_raw_witness.fields.ClosePrice = { state: 'oversize', json_type: 'number', value_text: null, utf8_bytes: 513 };
  const mapped = mapWitnessSaleRow(oversize);
  assert.equal(mapped.raw_projection.source_raw_witness.fields.ClosePrice.state, 'oversize');
  assert.equal(mapped.data.sale_price, 300000); assert.equal(mapped.data.market_eligible, null);
});

test('all existing date/price/account/package conflict gaps survive v3 without witness repair', () => {
  const input = sale(); Object.assign(input, { source_close_date: '2024-03-02', source_current_price: '900000',
    primary_account_id: 'OTHER', has_multiple_parcel_numbers: true, multi_parcel_status: 'possible',
    has_unresolved_parcel: true, requires_additional_review: true });
  input.source_raw_witness.fields.CloseDate = scalar('2024-03-01');
  input.source_raw_witness.fields.ClosePrice = scalar('300000', 'number');
  const baseline = mapCachedSaleRow(Object.fromEntries(Object.entries(input).filter(([key]) => !EXTRA.includes(key))));
  const result = mapWitnessSaleRow(input);
  assert.deepEqual(common(result), common(baseline)); assert.deepEqual(result.capability_gaps, baseline.capability_gaps);
  for (const dimension of ['account', 'price', 'date']) assert.ok(result.capability_gaps.includes(`canonical_source_${dimension}_conflict`));
  assert.equal(result.data.parcel_links_complete, null); assert.equal(result.data.gla_sqft_at_sale, null);
});

test('no top-level or nested getter/proxy/toJSON is executed, including ignored private fields', () => {
  let calls = 0; const run = () => { calls++; throw new Error('must not execute'); };
  const proxy = new Proxy({}, { get: run, getPrototypeOf: run, ownKeys: run, getOwnPropertyDescriptor: run });
  for (const mapper of [mapWitnessParcelRow, mapWitnessAccountRow, mapWitnessSaleRow, mapWitnessSaleLinkRow]) {
    assert.throws(() => mapper(proxy), v3Error('projection_object'));
  }
  for (const field of ['sale_price', ...EXTRA]) {
    const input = sale(); Object.defineProperty(input, field, { enumerable: true, get: run });
    assert.throws(() => mapWitnessSaleRow(input), v3Error('data_properties_required'));
  }
  const nested = sale(); nested.data_quality_flags = [{ get value() { return run(); } }];
  assert.throws(() => mapWitnessSaleRow(nested), v3Error('plain_data_required'));
  assert.throws(() => mapWitnessSaleRow({ ...sale(), data_quality_flags: [proxy] }), v3Error('plain_data_required'));
  assert.throws(() => mapWitnessSaleRow({ ...sale(), source_raw_witness: proxy }), /invalid_cached_sale_witness/);
  const custom = sale(); custom.data_quality_flags = [{ toJSON: run }];
  assert.throws(() => mapWitnessSaleRow(custom), v3Error('plain_data_required'));
  const unknown = sale(); Object.defineProperty(unknown, 'raw_payload', { enumerable: true, get: run });
  unknown.private_proxy = proxy; unknown.toJSON = run;
  assert.ok(mapWitnessSaleRow(unknown).capability_gaps.includes('projection_fields_not_retained'));
  assert.equal(calls, 0);
});

test('malformed selected JSON, cycles, unsafe IDs and alias accounts remain rejected', () => {
  const cycle = []; cycle.push(cycle);
  for (const data_quality_flags of [cycle, Array(2), [new Date()], [Infinity]]) {
    assert.throws(() => mapWitnessSaleRow({ ...sale(), data_quality_flags }));
  }
  for (const source_record_id of ['01', ' 1', '9223372036854775808', 9007199254740992]) {
    assert.throws(() => mapWitnessSaleRow({ ...sale(), source_record_id }));
  }
  assert.throws(() => mapWitnessSaleRow({ ...sale(), sale_account_id: ' R-0001-001' }));
  const missing = sale(); delete missing.source_mls_status; missing.MlsStatus = 'Closed';
  assert.throws(() => mapWitnessSaleRow(missing), v3Error('source_witness_fields_required'));
  assert.throws(() => mapWitnessSaleRow({ ...sale(), source_filename: 'x'.repeat(1_000_001) }), v3Error('projection_limit'));
});

test('non-sale wrappers cannot retain additive sale fields or fabricate support', () => {
  for (const [make, mapper] of [[parcel, mapWitnessParcelRow], [account, mapWitnessAccountRow], [link, mapWitnessSaleLinkRow]]) {
    const result = mapper({ ...make(), source_mls_status: 'Closed', source_row_number: 1, source_raw_witness: witness(), supported: true });
    for (const field of EXTRA) assert.equal(Object.hasOwn(result.raw_projection, field), false);
    assert.equal(result.data.historical_support, 'unknown');
    assert.ok(result.capability_gaps.includes('projection_fields_not_retained'));
    assert.ok(!canonicalAssessmentJson(result).includes('"supported":true'));
  }
});
