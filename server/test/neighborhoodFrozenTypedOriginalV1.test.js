import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compileNeighborhoodFrozenTypedOriginalV1 as compile, getNeighborhoodFrozenTypedOriginalV1Profile as profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
const base = { object_id: '1', account_id: 'A', residential_year_built: 1960,
  residential_area_sqft: '1000.000', parcel_area_sqft: '8000', current_market_value: '9007199254740993' };
const input = (payload = base, kind = 'parcels', row_key = '1') => ({ kind, row_key, payload_text: JSON.stringify(payload), effective_date: '2026-08-31' });
const witness = fields => ({ witness_version: 2, root_state: 'object', root_json_type: 'object',
  fields: Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(key => [key, Object.hasOwn(fields, key)
    ? { state: 'scalar', json_type: 'string', value_text: fields[key], utf8_bytes: Buffer.byteLength(fields[key]) }
    : { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }])) });

test('fixed typed-original profile retains exact decimals, reported labels and source-row provenance without floats', () => {
  const i = input(), r = compile(i), cells = r.observations;
  assert.equal(cells.reported_residential_area.exact_value, '1000'); assert.equal(cells.reported_residential_area.unit, 'reported_sqft');
  assert.equal(cells.reported_market_value.exact_value, '9007199254740993'); assert.equal(cells.reported_market_value.state, 'unsupported');
  assert.equal(cells.reported_market_value.reason, 'unit_not_established'); assert.equal(cells.reported_market_value.unit, null);
  assert.equal(cells.reported_year_built.exact_value, '1960'); assert.equal(r.authority, 'not_established');
  assert.equal(r.original.payload_sha256, createHash('sha256').update(i.payload_text).digest('hex'));
  assert.equal(r.coverage, 'one_original_only'); assert.ok(Object.isFrozen(r.observations));
  assert.deepEqual(r.interpretation_profile_ref, profile().profile_ref);
  assert.ok(profile().definition_blob.canonical_json.includes('no_statistics_or_report_update'));
});
test('numeric states distinguish missing, invalid, oversize and unsupported units without inventing zeros', () => {
  for (const [value, state, exact] of [[null, 'missing', null], ['', 'missing', null], ['0', 'invalid', null],
    ['-0', 'invalid', null], ['1e3', 'invalid', null], ['$1000', 'invalid', null], ['1,000', 'invalid', null],
    ['.5000', 'observed', '0.5'], ['+000123.45000', 'observed', '123.45'], ['1'.repeat(129), 'unsupported', null],
    [123, 'invalid', null], [true, 'invalid', null], [{ value: 1000 }, 'invalid', null],
    ['1.1234567890123', 'invalid', null], ['1'.repeat(31), 'invalid', null]]) {
    const c = compile(input({ ...base, residential_area_sqft: value })).observations.reported_residential_area;
    assert.equal(c.state, state, JSON.stringify(value)); assert.equal(c.exact_value, exact);
  }
  const absent = { ...base }; delete absent.residential_area_sqft;
  assert.equal(compile(input(absent)).observations.reported_residential_area.raw.state, 'absent');
  for (const year of [1599, 2027, -0, 1960.5, '1960']) assert.equal(compile(input({ ...base, residential_year_built: year })).observations.reported_year_built.state, 'invalid');
});
test('numeric diagnostics slice original JSON tokens, including wrong-type rounded values and integer impostors', () => {
  const i = input(); i.payload_text = i.payload_text.replace('"1000.000"', '9007199254740993');
  const c = compile(i).observations.reported_residential_area;
  assert.equal(c.state, 'invalid'); assert.equal(c.raw.value_text, '9007199254740993');
  for (const token of ['1960.0000000000000001', '-0', '1e3', '9007199254740993']) {
    const raw = input(); raw.payload_text = raw.payload_text.replace('1960', token);
    const year = compile(raw).observations.reported_year_built;
    assert.equal(year.state, 'invalid'); assert.equal(year.raw.value_text, token);
  }
});
test('single same-payload witness interpretation keeps exact prices, incompatible units and conflicting currencies explicit', () => {
  const row = { id: '501', primary_account_id: 'A', current_price: '9007199254740993',
    living_area: '1000', year_built: 1960, bedrooms_total: 3, garage_spaces: '2.5',
    source_raw_witness: witness({ ClosePrice: '9007199254740993', ClosePriceCurrency: 'USD', Currency: 'CAD',
      LivingArea: '1000', LivingAreaUnits: 'sqm', YearBuilt: '1960', MlsStatus: 'Closed', CloseDate: '8/31/2026' }) };
  const r = compile(input(row, 'source_records', '501'));
  assert.equal(r.observations.normalized_living_area.state, 'unsupported');
  assert.equal(r.observations.normalized_garage_spaces.exact_value, '2.5'); assert.equal(r.observations.normalized_bedrooms.exact_value, '3');
  assert.equal(r.same_payload_reported_sale.observations.reported_close_price.state, 'conflicting');
  assert.equal(r.same_payload_reported_sale.observations.reported_close_price.exact_value, '9007199254740993');
  assert.equal(r.same_payload_reported_sale.observations.reported_living_area.unit, 'sqm');
  assert.equal(r.same_payload_reported_sale.close_date.exact_value, '2026-08-31');
  assert.equal(r.source_record_id, '501');
  assert.throws(() => compile(input({ ...row, source_raw_witness: null }, 'source_records', '501')), /witness_unavailable/);
  assert.throws(() => compile(input({ ...row, source_raw_witness: { ...row.source_raw_witness, witness_version: 1 } }, 'source_records', '501')), /WITNESS|witness/i);
});
test('dates preserve future valid calendar dates and never substitute loaded timestamps or capture time', () => {
  for (const [closing_date, state, exact] of [['2024-02-29', 'observed', '2024-02-29'], ['2026-02-29', 'invalid', null],
    ['2027-01-01', 'observed', '2027-01-01'], ['2026-08-31T00:00:00Z', 'invalid', null], [null, 'missing', null],
    ['0000-01-01', 'invalid', null], ['2026-13-01', 'invalid', null]]) {
    const r = compile(input({ id: '1', account_id: null, source_record_id: null, closing_date,
      sale_price: '0', loaded_at: '2026-08-31T00:00:00Z' }, 'sales'));
    assert.equal(r.dates.closing_date.state, state); assert.equal(r.dates.closing_date.exact_value, exact);
    assert.equal(r.observations.recorded_sale_price.exact_value, '0'); assert.equal(r.observations.recorded_sale_price.state, 'unsupported');
  }
});
test('all seven original kinds preserve native identity/null associations without assuming additional CAD properties', () => {
  for (const [kind, row_key, row] of [['accounts', 'A', { account_id: 'A', county: 'Dallas' }],
    ['sale_links', '2', { id: '2', account_id: null, source_record_id: '501', source_position: 1, parcel_sequence: 2, is_resolved: null }],
    ['sync_state', 'dcad_parcels', { source_key: 'dcad_parcels', status: 'complete' }],
    ['sync_runs', '70000000-0000-4000-8000-000000000001', { id: '70000000-0000-4000-8000-000000000001', status: 'complete' }]]) {
    const r = compile(input(row, kind, row_key)); assert.deepEqual(r.observations, {});
    assert.equal(r.original.row_key, row_key); assert.equal(r.source_freshness, 'not_established');
  }
  const r = compile(input({ ...base, subdivision_name: 'A'.repeat(5000), built_up: false }));
  assert.equal(r.markers.subdivision_name.state, 'oversize'); assert.equal(r.markers.subdivision_name.value_text, null);
  assert.equal(r.markers.subdivision_name.utf8_bytes, 5000); assert.equal(r.markers.built_up.value_text, 'false');
});
test('malformed originals, duplicate keys, foreign identities, getters/proxies and oversized input refuse', () => {
  for (const patch of [{ kind: 'anything' }, { row_key: '2' }, { payload_text: '{"object_id":"1","object_id":"2"}' },
    { payload_text: '[' }, { payload_text: '[]' }, { effective_date: '2026-02-29' }, { payload_text: ' '.repeat(1000001) }, { extra: true }])
    assert.throws(() => compile({ ...input(), ...patch }));
  let invoked = false; const getter = input(); Object.defineProperty(getter, 'kind', { enumerable: true, get() { invoked = true; return 'parcels'; } });
  assert.throws(() => compile(getter), /invalid_input/); assert.equal(invoked, false);
  assert.throws(() => compile(new Proxy(input(), {})), /invalid_input/);
  assert.throws(() => compile(input({ ...base, account_id: ' A' })), /identity_mismatch/);
});
test('typed SQL read-model migration is additive, indexed, immutable and registered without a live dispatcher', () => {
  const name = '20261109_custom_cohort_frozen_typed_originals.sql';
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  const registry = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.ok(registry.includes(name)); assert.match(sql, /generation_id,kind,row_key/);
  assert.match(sql, /neighborhood_cohort_typed_original_account_idx/); assert.match(sql, /FOR SHARE OF header NOWAIT/);
  assert.match(sql, /OLD.status<>'building'/); assert.match(sql, /WHERE header.status<>'building'/);
  assert.doesNotMatch(sql, /DROP |DISABLE |TRUNCATE app\.|DELETE FROM|UPDATE app\.|CONCURRENTLY/);
});
