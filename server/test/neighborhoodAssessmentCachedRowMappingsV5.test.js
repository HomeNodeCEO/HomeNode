import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { CACHED_ROW_MAPPING_VERSION, mapCachedSaleRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { CACHED_WITNESS_MAPPING_VERSION, mapWitnessSaleRow } from '../src/services/neighborhoodAssessment/cachedRowMappingsV3.js';
import { CACHED_CAD_EVIDENCE_FIELDS, CACHED_CAD_EVIDENCE_MAPPING_VERSION, mapCadEvidenceParcelRow,
  mapCadEvidenceAccountRow, mapCadEvidenceSaleRow, mapCadEvidenceSaleLinkRow,
  hasOriginalPrimitiveCadMappingReceipt } from '../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { CACHED_COMBINED_EVIDENCE_MAPPING_VERSION, mapCombinedEvidenceParcelRow,
  mapCombinedEvidenceAccountRow, mapCombinedEvidenceSaleRow, mapCombinedEvidenceSaleLinkRow,
  hasOriginalPrimitiveCombinedMappingReceipt } from '../src/services/neighborhoodAssessment/cachedRowMappingsV5.js';
import { CACHED_SALE_WITNESS_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitness.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';

const A = 'R-0001-001', EXTRA = ['source_mls_status', 'source_row_number', 'source_raw_witness'];
const scalar = value => ({ state: 'scalar', json_type: 'string', value_text: value, utf8_bytes: Buffer.byteLength(value) });
const witness = (version = 2) => ({ witness_version: version, root_state: 'object', root_json_type: 'object',
  fields: Object.fromEntries((version === 2 ? CACHED_SALE_WITNESS_V2_FIELDS : CACHED_SALE_WITNESS_FIELDS)
    .map(key => [key, { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }])) });
const parcel = () => ({ object_id: '9007199254740993', account_id: A, residential_year_built: 2004,
  residential_area_sqft: '1800.125', parcel_area_sqft: '8000', current_market_value: '300000',
  land_use_category: 'one_unit', stored_geometry_ewkb: '010203', class_code: ' 01 ',
  class_description: 'Single family residence', use_description: '', structure_type: null, built_up: false });
const account = () => ({ account_id: A, county: 'Collin', subdivision: '  Name  ', legal_description: null });
const saleBase = () => ({ source_record_id: '10', sale_id: '20', primary_account_id: A, sale_account_id: A,
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  sale_price: '300000.00', source_current_price: '325000.00', source_living_area: '1800.125',
  source_days_on_market: 0, data_quality_flags: [] });
const sale = (version = 2) => ({ ...saleBase(), source_mls_status: ' Closed ', source_row_number: 3, source_raw_witness: witness(version) });
const link = () => ({ parcel_link_id: '99', source_record_id: '10', account_id: A, source_position: 1,
  parcel_sequence: 1, is_resolved: true, match_method: 'exact', parcel_role: 'primary' });
const common = row => Object.fromEntries(Object.entries(row.data).filter(([key]) => !['cached_mapping_version', 'cached_projection_sha256'].includes(key)));
const failure = reason => error => error.code === 'NEIGHBORHOOD_CACHED_COMBINED_EVIDENCE_ROW_INVALID' && error.reason === reason;
const frozen = value => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } };

for (const [kind, make, previous, next] of [
  ['parcel', parcel, mapCadEvidenceParcelRow, mapCombinedEvidenceParcelRow],
  ['account', account, mapCadEvidenceAccountRow, mapCombinedEvidenceAccountRow],
  ['sale_link', link, mapCadEvidenceSaleLinkRow, mapCombinedEvidenceSaleLinkRow],
]) test(`combined ${kind} reuses CAD4 observations unchanged and binds only its new version`, () => {
  const input = make(), before = previous(input), result = next(input);
  assert.equal(result.record_id, before.record_id); assert.deepEqual(result.raw_projection, before.raw_projection);
  assert.deepEqual(common(result), common(before)); assert.deepEqual(result.capability_gaps, before.capability_gaps);
  assert.equal(result.data.cached_mapping_version, 5);
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 5, projection_kind: kind, raw_projection: result.raw_projection }));
  assert.notEqual(result.data.cached_projection_sha256, before.data.cached_projection_sha256);
  assert.deepEqual(previous(input), before); assert.deepEqual(next(result.raw_projection), result); frozen(result);
});

test('combined sale retains all raw aliases without currency, unit, date or price precedence', () => {
  const input = sale();
  for (const [key, value] of Object.entries({ ClosePrice: '9007199254740993.123400', CurrentPrice: '100',
    CloseDate: '2026-09-01', Currency: 'USD', PriceCurrency: 'CAD', CurrentPriceCurrency: ' EUR ', ClosePriceCurrency: '',
    LivingArea: '170.5', LivingAreaUnits: 'Square Meters' })) input.source_raw_witness.fields[key] = scalar(value);
  const before = mapCadEvidenceSaleRow(saleBase()), result = mapCombinedEvidenceSaleRow(input);
  assert.deepEqual(common(result), common(before)); assert.deepEqual(result.capability_gaps, before.capability_gaps);
  assert.deepEqual(Object.keys(result.raw_projection).sort(), [...Object.keys(before.raw_projection), ...EXTRA].sort());
  assert.deepEqual(result.raw_projection.source_raw_witness, input.source_raw_witness);
  assert.equal(result.data.sale_price, 300000); assert.equal(result.data.sale_date, '2024-03-01');
  assert.equal(result.data.gla_sqft_at_sale, null); assert.equal(result.data.market_eligible, null);
  assert.equal(result.data.historical_support, 'unknown'); assert.equal(Object.hasOwn(result.data, 'currency'), false);
  assert.equal(result.data.cached_projection_sha256, assessmentEvidenceDigest({ mapping_version: 5, projection_kind: 'sale', raw_projection: result.raw_projection }));
  assert.deepEqual(mapCombinedEvidenceSaleRow(result.raw_projection), result); frozen(result);
  input.source_raw_witness.fields.PriceCurrency.value_text = 'AUD'; input.data_quality_flags.push('later');
  assert.equal(result.raw_projection.source_raw_witness.fields.PriceCurrency.value_text, 'CAD');
  assert.deepEqual(result.raw_projection.data_quality_flags, []);
});

test('old v2/v3/v4 wrappers and default remain exact and never upgrade in place', () => {
  assert.deepEqual([CACHED_ROW_MAPPING_VERSION, CACHED_WITNESS_MAPPING_VERSION, CACHED_CAD_EVIDENCE_MAPPING_VERSION,
    CACHED_COMBINED_EVIDENCE_MAPPING_VERSION], [2, 3, 4, 5]);
  for (const [mapper, input] of [[mapCachedSaleRow, saleBase()], [mapWitnessSaleRow, sale(1)], [mapCadEvidenceParcelRow, parcel()]]) {
    const before = JSON.stringify(mapper(input)); mapCombinedEvidenceParcelRow(parcel()); mapCombinedEvidenceSaleRow(sale());
    assert.equal(JSON.stringify(mapper(input)), before);
  }
  assert.throws(() => mapCombinedEvidenceSaleRow(sale(1)), /invalid_cached_sale_witness/);
  assert.throws(() => mapWitnessSaleRow(sale()), /invalid_cached_sale_witness/);
});

test('canonical-only sale preserves source absence instead of manufacturing witness cells', () => {
  const legacy = { sale_id: '12', sale_account_id: A, sale_price: '200000', sale_closing_date: '2020-01-01' };
  const result = mapCombinedEvidenceSaleRow(legacy);
  assert.equal(result.data.source_record_id, null); assert.ok(result.capability_gaps.includes('source_record_unavailable'));
  assert.deepEqual(result.raw_projection, mapCadEvidenceSaleRow(legacy).raw_projection);
  for (const field of EXTRA) {
    assert.equal(Object.hasOwn(result.raw_projection, field), false);
    assert.throws(() => mapCombinedEvidenceSaleRow({ ...legacy, [field]: sale()[field] }), failure('legacy_source_witness'));
    const missing = sale(); delete missing[field];
    assert.throws(() => mapCombinedEvidenceSaleRow(missing), failure('source_witness_fields_required'));
  }
});

test('CAD4 required-field, Unicode and boolean rules carry forward without another implementation', () => {
  for (const field of CACHED_CAD_EVIDENCE_FIELDS) {
    const input = parcel(); delete input[field]; assert.throws(() => mapCombinedEvidenceParcelRow(input), /cad_fields_required/);
  }
  for (const built_up of ['false', 0, 1]) assert.throws(() => mapCombinedEvidenceParcelRow({ ...parcel(), built_up }));
  for (const class_code of ['\u0000', '\ud800', 'é'.repeat(2049)]) assert.throws(() => mapCombinedEvidenceParcelRow({ ...parcel(), class_code }));
  assert.equal(mapCombinedEvidenceParcelRow({ ...parcel(), class_code: 'é'.repeat(2048) }).raw_projection.class_code.length, 2048);
});

test('unknown private descriptors remain unvisited; selected getters and proxies cannot execute', () => {
  let calls = 0; const run = () => { calls++; throw Error('must not execute'); };
  const proxy = new Proxy({}, { ownKeys: run, getPrototypeOf: run, get: run });
  const input = sale(); Object.defineProperty(input, 'PrivateRemarks', { enumerable: true, get: run });
  input.raw_payload = proxy; input.toJSON = run;
  const result = mapCombinedEvidenceSaleRow(input);
  assert.ok(result.capability_gaps.includes('projection_fields_not_retained'));
  assert.doesNotMatch(JSON.stringify(result), /PrivateRemarks|raw_payload|toJSON/);
  assert.throws(() => mapCombinedEvidenceSaleRow(proxy), failure('projection_object'));
  for (const key of [...EXTRA, 'sale_price']) {
    const hostile = sale(); Object.defineProperty(hostile, key, { enumerable: true, get: run });
    assert.throws(() => mapCombinedEvidenceSaleRow(hostile));
  }
  assert.throws(() => mapCombinedEvidenceSaleRow({ ...sale(), source_raw_witness: proxy }));
  assert.throws(() => mapCombinedEvidenceSaleRow({ ...sale(), data_quality_flags: [proxy] }));
  const hidden = sale(); Object.defineProperty(hidden, 'source_mls_status', { enumerable: false, value: 'Closed' });
  assert.throws(() => mapCombinedEvidenceSaleRow(hidden), failure('data_properties_required'));
  assert.equal(calls, 0);
});

test('stored status and row number are exact bounded observations without coercion', () => {
  for (const status of [null, '', ' ', 'closed', 'é'.repeat(256)]) assert.equal(mapCombinedEvidenceSaleRow({ ...sale(), source_mls_status: status }).raw_projection.source_mls_status, status);
  for (const number of [null, -2147483648, -1, 0, 2147483647]) assert.equal(mapCombinedEvidenceSaleRow({ ...sale(), source_row_number: number }).raw_projection.source_row_number, number);
  for (const status of [1, {}, false, 'é'.repeat(257), '\u0000', '\ud800']) assert.throws(() => mapCombinedEvidenceSaleRow({ ...sale(), source_mls_status: status }), failure('source_mls_status'));
  for (const number of ['1', -0, 1.5, 2147483648, -2147483649, NaN]) assert.throws(() => mapCombinedEvidenceSaleRow({ ...sale(), source_row_number: number }), failure('source_row_number'));
});

test('combined primitive replay receipts are identity-only, version-specific and exclude unretained fields', () => {
  const mapped = mapCombinedEvidenceParcelRow(parcel());
  assert.equal(hasOriginalPrimitiveCombinedMappingReceipt(mapped, 'parcel', 5), true);
  assert.equal(hasOriginalPrimitiveCadMappingReceipt(mapped, 'parcel', 4), false);
  for (const candidate of [structuredClone(mapped), mapCadEvidenceParcelRow(parcel()), mapCombinedEvidenceParcelRow({ ...parcel(), private_column: true })]) {
    assert.equal(hasOriginalPrimitiveCombinedMappingReceipt(candidate, 'parcel', 5), false);
  }
  assert.equal(hasOriginalPrimitiveCombinedMappingReceipt(mapped, 'parcel', 4), false);
  assert.equal(hasOriginalPrimitiveCombinedMappingReceipt(mapped, 'account', 5), false);
  assert.equal(hasOriginalPrimitiveCombinedMappingReceipt(mapCombinedEvidenceSaleRow(sale()), 'sale', 5), false);
});

test('legacy v2/v3 mapper sources remain byte-identical apart from checkout line endings', () => {
  const dir = new URL('../src/services/neighborhoodAssessment/', import.meta.url);
  const digest = filename => createHash('sha256').update(readFileSync(new URL(filename, dir), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  assert.equal(digest('cachedRowMappings.js'), '484eb6caa1cbee21fd91b7765701e810a3db0fd3d8dcf1c670303a5cf213fa98');
  assert.equal(digest('cachedRowMappingsV3.js'), '9eef4ec1d2cc40715ab13736c787b40f9cf42533837261599b58ca1a77776a61');
});
