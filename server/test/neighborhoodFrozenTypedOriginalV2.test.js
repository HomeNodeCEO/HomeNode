import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { compileNeighborhoodFrozenTypedOriginalV1 as legacy, compileNeighborhoodFrozenTypedOriginalV2 as compile,
  getNeighborhoodFrozenTypedOriginalV1Profile as legacyProfile, getNeighborhoodFrozenTypedOriginalV2Profile as profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { getCustomCohortReportedSaleWitnessV2Profile as oldWitnessProfile,
  getCustomCohortDateNeutralReportedSaleWitnessV1Profile as neutralWitnessProfile,
  interpretCustomCohortDateNeutralReportedSaleWitnessV1 as neutralWitness }
  from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { CACHED_SALE_WITNESS_V2_FIELDS as fields } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';

const parcel = { object_id: '1', account_id: 'A', residential_year_built: 1960,
  residential_area_sqft: '1000.000', parcel_area_sqft: '8000', current_market_value: '9007199254740993' };
const input = (payload = parcel, kind = 'parcels', row_key = '1') => ({ kind, row_key, payload_text: JSON.stringify(payload) });
const witness = values => ({ witness_version: 2, root_state: 'object', root_json_type: 'object',
  fields: Object.fromEntries(fields.map(key => [key, Object.hasOwn(values, key)
    ? { state: 'scalar', json_type: 'string', value_text: values[key], utf8_bytes: Buffer.byteLength(values[key]) }
    : { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }])) });
const source = (values = {}) => ({ id: '501', primary_account_id: 'A', year_built: 1960, living_area: '1000',
  source_raw_witness: witness({ ClosePrice: '9007199254740993', ClosePriceCurrency: 'USD',
    LivingArea: '1000', LivingAreaUnits: 'sqft', YearBuilt: '1960', MlsStatus: 'Closed', CloseDate: '8/31/2026', ...values }) });
function comparable(row) {
  const result = structuredClone(row);
  delete result.effective_date; delete result.temporal_basis; delete result.typed_original_version;
  delete result.interpretation_profile_ref;
  if (result.same_payload_reported_sale) delete result.same_payload_reported_sale.interpretation_profile_ref;
  return result;
}

test('retained V1 original and reported-witness profiles keep their exact existing content hashes', () => {
  assert.equal(legacyProfile().profile_ref.content_sha256, '1912d3047cdaf95335e129a46bbde71da03797c3e0a8df3a6e12ce1d7ec0c8d6');
  assert.equal(oldWitnessProfile().profile_ref.content_sha256, '831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e');
  assert.notEqual(profile().profile_ref.content_sha256, legacyProfile().profile_ref.content_sha256);
  assert.notEqual(neutralWitnessProfile().profile_ref.content_sha256, oldWitnessProfile().profile_ref.content_sha256);
  for (const p of [profile(), neutralWitnessProfile()]) {
    assert.equal(createHash('sha256').update(p.definition_blob.canonical_json).digest('hex'), p.profile_ref.content_sha256);
    const definition = JSON.parse(p.definition_blob.canonical_json);
    assert.equal(definition.temporal.effective_date, 'not_accepted_not_cached');
    assert.equal(definition.authority, 'not_established');
    assert.match(definition.temporal.consumer_duty, /before_aggregation|before_resolution_and_aggregation/);
    assert.ok(Object.isFrozen(p.definition_blob));
  }
});

test('V2 is date-neutral exact syntax for all seven original kinds, not a V1 cast or date-selected default', () => {
  const rows = [input(), input({ account_id: 'A', county: 'Dallas' }, 'accounts', 'A'),
    input(source(), 'source_records', '501'), input({ id: '1', account_id: null, source_record_id: null,
      sale_price: '0', closing_date: '2027-01-01' }, 'sales'),
    input({ id: '2', account_id: null, source_record_id: '501' }, 'sale_links', '2'),
    input({ source_key: 'dcad_parcels', status: 'complete' }, 'sync_state', 'dcad_parcels'),
    input({ id: '70000000-0000-4000-8000-000000000001' }, 'sync_runs', '70000000-0000-4000-8000-000000000001')];
  for (const i of rows) {
    const r = compile(i);
    assert.equal(r.typed_original_version, 2); assert.equal(r.temporal_basis, 'date_neutral_original_syntax');
    assert.equal(Object.hasOwn(r, 'effective_date'), false); assert.deepEqual(r.interpretation_profile_ref, profile().profile_ref);
    for (const effective_date of ['2020-01-01', '2026-08-31', '2030-12-31'])
      assert.deepEqual(comparable(r), comparable(legacy({ ...i, effective_date })));
    assert.equal(r.authority, 'not_established'); assert.equal(r.source_freshness, 'not_established');
    assert.equal(r.coverage, 'one_original_only'); assert.ok(Object.isFrozen(r.observations));
    assert.equal(r.original.payload_sha256, createHash('sha256').update(i.payload_text).digest('hex'));
  }
});

test('future years remain syntax-only in V2 and are still invalid for a prior V1 appraisal date', () => {
  for (const year of [1600, 2027, 9999]) {
    const i = input({ ...parcel, residential_year_built: year }), r = compile(i);
    assert.equal(r.observations.reported_year_built.state, 'observed');
    assert.equal(r.observations.reported_year_built.exact_value, String(year));
    const prior = legacy({ ...i, effective_date: '2026-08-31' }).observations.reported_year_built;
    assert.equal(prior.state, year > 2026 ? 'invalid' : 'observed');
  }
  for (const year of [1599, 10000, 2147483647, -0, 1960.5, '1960', null]) {
    const r = compile(input({ ...parcel, residential_year_built: year })).observations.reported_year_built;
    assert.equal(r.state, year === null ? 'missing' : 'invalid');
  }
  const i = input({ ...source({ YearBuilt: '2027' }), year_built: 2027 }, 'source_records', '501');
  const r = compile(i), old = legacy({ ...i, effective_date: '2026-08-31' });
  for (const cell of [r.observations.normalized_year_built, r.same_payload_reported_sale.observations.reported_year_built])
    assert.equal(cell.exact_value, '2027');
  assert.equal(old.observations.normalized_year_built.state, 'invalid');
  assert.equal(old.same_payload_reported_sale.observations.reported_year_built.state, 'invalid');
  assert.deepEqual(r.same_payload_reported_sale.interpretation_profile_ref, neutralWitnessProfile().profile_ref);
});

test('exact wrong-type original tokens, numeric states and unit/currency conflicts are not widened', () => {
  for (const token of ['1960.0000000000000001', '-0', '1e3', '9007199254740993']) {
    const i = input(); i.payload_text = i.payload_text.replace('1960', token);
    const c = compile(i).observations.reported_year_built;
    assert.equal(c.state, 'invalid'); assert.equal(c.raw.value_text, token);
  }
  for (const [value, state] of [[null, 'missing'], ['', 'missing'], ['-0', 'invalid'], ['1e3', 'invalid'],
    ['1'.repeat(129), 'unsupported'], [1000, 'invalid'], ['0', 'invalid'], ['.5', 'observed']])
    assert.equal(compile(input({ ...parcel, residential_area_sqft: value })).observations.reported_residential_area.state, state);
  const r = compile(input(source({ Currency: 'CAD', LivingAreaUnits: 'sqm' }), 'source_records', '501'));
  assert.equal(r.same_payload_reported_sale.observations.reported_close_price.state, 'conflicting');
  assert.equal(r.same_payload_reported_sale.observations.reported_close_price.exact_value, '9007199254740993');
  assert.equal(r.same_payload_reported_sale.observations.reported_living_area.unit, 'sqm');
  assert.equal(r.observations.normalized_living_area.state, 'unsupported');
});

test('calendar dates, missing witnesses and malformed/getter/proxy inputs keep fail-closed admission', () => {
  for (const [closing_date, state] of [['2024-02-29', 'observed'], ['2026-02-29', 'invalid'],
    ['9999-12-31', 'observed'], ['2026-08-31T00:00:00Z', 'invalid']]) {
    const r = compile(input({ id: '1', account_id: null, source_record_id: null, closing_date }, 'sales'));
    assert.equal(r.dates.closing_date.state, state);
  }
  for (const patch of [{ effective_date: '2026-08-31' }, { policy: {} }, { kind: 'anything' }, { row_key: '2' },
    { payload_text: '{"object_id":"1","object_id":"2"}' }, { payload_text: '[]' }, { payload_text: ' '.repeat(1_000_001) }])
    assert.throws(() => compile({ ...input(), ...patch }));
  assert.throws(() => compile(input(), '2026-08-31'), /invalid_input/);
  let invoked = false; const i = input(); Object.defineProperty(i, 'kind', { enumerable: true, get() { invoked = true; return 'parcels'; } });
  assert.throws(() => compile(i), /invalid_input/); assert.equal(invoked, false);
  assert.throws(() => compile(new Proxy(input(), {})), /invalid_input/);
  assert.throws(() => compile(input({ ...source(), source_raw_witness: null }, 'source_records', '501')), /witness_unavailable/);
  assert.throws(() => neutralWitness(witness({}), '2026-08-31'), /arguments/);
  assert.throws(() => neutralWitness(new Proxy(witness({}), {})), /shape/);
});
