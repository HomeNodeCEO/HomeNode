import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { CACHED_SALE_WITNESS_V2_FIELDS as FIELDS, prepareCachedSaleWitnessV2 } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { interpretCustomCohortReportedSaleWitnessV2 as interpret, getCustomCohortReportedSaleWitnessV2Profile as profile,
  CUSTOM_COHORT_REPORTED_SALE_WITNESS_V2_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { normalizeAssignmentSalesObservations } from '../src/services/assignmentSalesCsv/observations.js';
import { getCustomSaleWitnessMeaningProfile } from '../src/services/neighborhoodAssessment/customCohortSaleWitnessMeaningResolver.js';

const EFFECTIVE = '2026-09-12';
const entry = (state = 'absent', json_type = null, value_text = null, utf8_bytes = null) => ({ state, json_type, value_text, utf8_bytes });
const scalar = (text, kind = 'string') => entry('scalar', kind, text, Buffer.byteLength(text, 'utf8'));
function witness(values = {}) {
  return { witness_version: 2, root_state: 'object', root_json_type: 'object',
    fields: Object.fromEntries(FIELDS.map(key => [key, Object.hasOwn(values, key) ? values[key] : entry()])) };
}
function fixture(values = {}) {
  return witness({ ClosePrice: scalar('9007199254740993.0100', 'number'), ClosePriceCurrency: scalar(' USD '),
    CurrentPrice: scalar('+00000000100.5000'), CurrentPriceCurrency: scalar('usd'),
    LivingArea: scalar(' 001850.1250 '), LivingAreaUnits: scalar(' SQ FT '),
    LotSizeArea: scalar('0'), LotSizeUnits: scalar('acres'), YearBuilt: scalar('2000', 'number'), DaysOnMarket: scalar('0', 'number'),
    MlsStatus: scalar(' Closed '), CloseDate: scalar('9/12/2026'), ...values });
}
const read = (values = {}, effective = EFFECTIVE) => interpret(fixture(values), effective);
const cell = (state, exact_value = null, unit = null, reason = null) => ({ state, exact_value, unit, reason });
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const MEASUREMENTS = [
  ['reported_close_price', 'ClosePrice'], ['reported_current_price', 'CurrentPrice'], ['reported_living_area', 'LivingArea'],
  ['reported_site_area', 'LotSizeArea'], ['reported_year_built', 'YearBuilt'], ['reported_days_on_market', 'DaysOnMarket'],
];
const UNIT_FIELDS = [['ClosePriceCurrency', 'reported_close_price'], ['CurrentPriceCurrency', 'reported_current_price'],
  ['LivingAreaUnits', 'reported_living_area'], ['LotSizeUnits', 'reported_site_area']];

test('fixed profile is canonical, content-addressed and deeply frozen with complete interpretation/caller duties', () => {
  const p = profile(), definition = JSON.parse(p.definition_blob.canonical_json);
  assert.equal(profile(), p);
  assert.equal(p.definition_blob.canonical_json, canonicalAssessmentJson(definition));
  assert.deepEqual(p.definition_blob.ref, prepareNeighborhoodCohortBlob(p.definition_blob.canonical_json));
  assert.deepEqual(p.profile_ref, { id: 'custom-local-reported-sale-witness-v2', revision: '1',
    content_sha256: '831e8a1eced98b9cc8dcee3a7f4b85ec182241ff44c8de355523c0a21609283e' });
  assert.equal(p.profile_ref.content_sha256, hash(p.definition_blob.canonical_json));
  assert.equal(p.definition_blob.ref.canonical_utf8_bytes, '9055');
  for (const value of [p, p.profile_ref, p.definition_blob, p.definition_blob.ref, LIMITS]) assert.ok(Object.isFrozen(value));
  assert.equal(definition.cached_mapping_version, 5); assert.equal(definition.witness_version, 2);
  assert.equal(definition.authority, 'not_established'); assert.equal(definition.provider_meaning, 'not_established');
  assert.deepEqual(Object.keys(definition.fields).sort(), MEASUREMENTS.map(([name]) => name).sort());
  assert.deepEqual(definition.witness_admission.fields, FIELDS);
  assert.deepEqual(definition.witness_admission.limits, { scalar_utf8_bytes: 512, witness_utf8_bytes: 24_576 });
  assert.deepEqual(definition.states.exhaustive, ['observed', 'missing', 'invalid', 'conflicting', 'unsupported']);
  assert.equal(definition.units.generic_currency_policy, 'veto_only_never_affirmative_or_fallback');
  assert.equal(definition.scalar.token_length_before_trim, false);
  assert.deepEqual(definition.close_date.unsupported, ['payload_unavailable', 'oversize']);
  assert.equal(definition.close_date.unsupported_reason, 'unsupported_close_date');
  assert.equal(definition.close_date.future_raw_date, 'preserved_valid_calendar_date_then_caller_outside_period');
  assert.equal(definition.caller_resources.selected_accounts, 50000);
  assert.equal(definition.caller_resources.maximum_dense_total_records, 200000);
  assert.match(definition.duplicate_source_rule, /whole_result_source_witness_mismatch/);
  assert.ok(definition.caller_obligations.includes('historical_stock_gate'));
  const old = getCustomSaleWitnessMeaningProfile();
  assert.equal(JSON.parse(old.definition_blob.canonical_json).cached_mapping_version, 3);
  assert.notEqual(old.profile_ref.content_sha256, p.profile_ref.content_sha256);
  assert.throws(() => { p.profile_ref.revision = '2'; }, TypeError);
});

test('all six raw measurements retain exact magnitude and have usable units only when observed', () => {
  const result = read();
  assert.equal(result.interpretation_profile_ref, profile().profile_ref);
  assert.equal(result.observation_basis, 'same_payload_scalar_witness_reported_not_verified');
  assert.deepEqual(result.observations, {
    reported_close_price: cell('observed', '9007199254740993.01', 'USD'),
    reported_current_price: cell('observed', '100.5', 'USD'),
    reported_living_area: cell('observed', '1850.125', 'sqft'), reported_site_area: cell('observed', '0', 'acre'),
    reported_year_built: cell('observed', '2000', 'year'), reported_days_on_market: cell('observed', '0', 'days'),
  });
  assert.deepEqual(result.record_type, { state: 'closed', reason: null });
  assert.deepEqual(result.close_date, { state: 'observed', exact_value: EFFECTIVE, reason: null });
});

for (const [metric, field] of MEASUREMENTS) test(`${field} classifies all original states/types without collapsing missing and unavailable`, () => {
  const states = [
    [entry(), 'missing', 'absent'], [entry('json_null', 'null'), 'missing', 'json_null'],
    [scalar(''), 'missing', 'blank'], [scalar(' \t\r\n '), 'missing', 'blank'],
    [entry('oversize', 'string', null, 513), 'unsupported', 'oversize'],
    [entry('oversize', 'number', null, 999), 'unsupported', 'oversize'],
    [entry('non_scalar', 'array'), 'invalid', 'non_scalar'], [entry('non_scalar', 'object'), 'invalid', 'non_scalar'],
    [scalar('true', 'boolean'), 'invalid', 'type_invalid'], [scalar('false', 'boolean'), 'invalid', 'type_invalid'],
    [scalar('not-a-number'), 'invalid', 'invalid'],
  ];
  for (const [raw, state, reason] of states) {
    const result = read({ [field]: raw });
    assert.deepEqual(result.observations[metric], cell(state, null, null, `raw_value_${reason}`));
    assert.deepEqual(result.diagnostics.raw_fields[field], raw);
  }
});

for (const [root, type] of [['sql_null', null], ['json_null', 'null'],
  ...['array', 'string', 'number', 'boolean'].map(kind => ['non_object', kind])]) test(`unavailable ${root}/${type} root is unsupported, never absent`, () => {
  const input = witness(); input.root_state = root; input.root_json_type = type;
  for (const field of FIELDS) input.fields[field] = entry('payload_unavailable');
  const result = interpret(input, EFFECTIVE);
  for (const [metric] of MEASUREMENTS) assert.deepEqual(result.observations[metric], cell('unsupported', null, null, 'raw_value_payload_unavailable'));
  assert.deepEqual(result.record_type, { state: 'unknown', reason: 'unknown_record_type' });
  assert.deepEqual(result.close_date, { state: 'unsupported', exact_value: null, reason: 'unsupported_close_date' });
  assert.equal(result.diagnostics.root_state, root); assert.equal(result.diagnostics.root_json_type, type);
  assert.equal(result.diagnostics.raw_fields.CloseDate.state, 'payload_unavailable');
});

test('decimal grammar is bounded after trim and exact canonicalization, without Number rounding', () => {
  for (const [text, exact] of [['+0001.2300', '1.23'], ['.5', '0.5'], ['1.', '1'], [' +.500 ', '0.5'], ['000.000', '0'],
    ['9'.repeat(30), '9'.repeat(30)], ['9'.repeat(18) + '.' + '1'.repeat(12), '9'.repeat(18) + '.' + '1'.repeat(12)],
    ['0.' + '0'.repeat(11) + '1', '0.' + '0'.repeat(11) + '1'], ['0'.repeat(127) + '1', '1'],
    ['1.' + '0'.repeat(126), '1'], [' '.repeat(127) + '1', '1'], [' '.repeat(511) + '1', '1'],
    [' '.repeat(192) + '0'.repeat(127) + '1' + ' '.repeat(192), '1'],
    ['1.' + '1'.repeat(12) + '0'.repeat(13), '1.' + '1'.repeat(12)]]) {
    assert.deepEqual(read({ ClosePrice: scalar(text) }).observations.reported_close_price, cell('observed', exact, 'USD'), text);
  }
  for (const text of ['-0', '-1', '1e3', '1E+3', '$1', '1,000', 'NaN', 'Infinity', '+', '.', '1 2', '١', '1\n2',
    '9'.repeat(31), '9'.repeat(19) + '.' + '1'.repeat(12), '.0000000000001', '0'.repeat(128) + '1', ' ' + '0'.repeat(128) + '1' + ' ']) {
    assert.deepEqual(read({ ClosePrice: scalar(text) }).observations.reported_close_price, cell('invalid', null, null, 'raw_value_invalid'), text);
  }
  for (const text of ['9007199254740993.123456789012', '0.000000000001']) {
    assert.equal(read({ ClosePrice: scalar(text, 'number') }).observations.reported_close_price.exact_value, text);
  }
  for (const text of ['-0', '1e999', '1.2300E-1000']) {
    const result = read({ ClosePrice: scalar(text, 'number') });
    assert.equal(result.observations.reported_close_price.state, 'invalid');
    assert.equal(result.diagnostics.raw_fields.ClosePrice.value_text, text);
    assert.equal(result.diagnostics.raw_fields.ClosePrice.json_type, 'number');
  }
});

test('zero, nonnegative int32 DOM and effective-year limits are explicit local policies', () => {
  const result = read(Object.fromEntries(MEASUREMENTS.map(([, field]) => [field, scalar('+000.000')])));
  for (const name of ['reported_close_price', 'reported_current_price', 'reported_site_area', 'reported_days_on_market']) {
    assert.equal(result.observations[name].state, 'observed'); assert.equal(result.observations[name].exact_value, '0');
  }
  for (const name of ['reported_living_area', 'reported_year_built']) assert.equal(result.observations[name].state, 'invalid');
  for (const text of ['2147483647', '+0002147483647.000']) assert.equal(read({ DaysOnMarket: scalar(text) }).observations.reported_days_on_market.exact_value, '2147483647');
  for (const text of ['2147483648', '-1', '1.5']) assert.equal(read({ DaysOnMarket: scalar(text) }).observations.reported_days_on_market.state, 'invalid');
  for (const text of ['1600', '2026', '+002026.000']) assert.equal(read({ YearBuilt: scalar(text) }).observations.reported_year_built.state, 'observed');
  for (const text of ['1599', '2027', '9999', '2000.5']) assert.equal(read({ YearBuilt: scalar(text) }).observations.reported_year_built.state, 'invalid');
  assert.equal(read({ YearBuilt: scalar('2000') }, '1999-12-31').observations.reported_year_built.state, 'invalid');
  assert.equal(read({ YearBuilt: scalar('1600') }, '1599-12-31').observations.reported_year_built.state, 'invalid');
});

for (const [field, metric] of UNIT_FIELDS) test(`${field} must establish this measurement's unit; missing/invalid/unavailable metadata is not repaired`, () => {
  const exact = read().observations[metric].exact_value;
  for (const [raw, state, reason] of [[entry(), 'unsupported', 'raw_unit_missing'], [entry('json_null', 'null'), 'unsupported', 'raw_unit_missing'],
    [scalar(' \t '), 'unsupported', 'raw_unit_missing'], [entry('oversize', 'string', null, 513), 'unsupported', 'raw_unit_unavailable'],
    [entry('non_scalar', 'array'), 'invalid', 'raw_unit_invalid'], [entry('non_scalar', 'object'), 'invalid', 'raw_unit_invalid'],
    [scalar('1', 'number'), 'invalid', 'raw_unit_invalid'], [scalar('false', 'boolean'), 'invalid', 'raw_unit_invalid'],
    [scalar('UNKNOWN'), 'unsupported', 'raw_unit_unsupported']]) {
    assert.deepEqual(read({ [field]: raw }).observations[metric], cell(state, state === 'invalid' ? null : exact, null, reason));
  }
});

test('only fixed unit aliases are usable; no acre living area, exchange rate or conversion exists', () => {
  const aliases = { sqft: ['sqft', 'sq ft', 'square feet'], sqm: ['sqm', 'sq m', 'square meters', 'square metres'], acre: ['acre', 'acres'] };
  for (const [unit, tokens] of Object.entries(aliases)) for (const token of tokens) {
    const result = read({ LotSizeUnits: scalar(` ${token.toUpperCase()} `), LivingAreaUnits: scalar(token) });
    assert.deepEqual(result.observations.reported_site_area, cell('observed', '0', unit));
    assert.equal(result.observations.reported_living_area.state, unit === 'acre' ? 'unsupported' : 'observed');
    if (unit !== 'acre') assert.equal(result.observations.reported_living_area.unit, unit);
  }
  for (const text of ['ft2', 'sq. ft.', 'square foot', 'm²', 'acreage']) assert.equal(read({ LotSizeUnits: scalar(text) }).observations.reported_site_area.state, 'unsupported');
  for (const text of ['USD', 'usd', ' UsD ']) assert.equal(read({ ClosePriceCurrency: scalar(text) }).observations.reported_close_price.unit, 'USD');
  for (const text of ['$', 'CAD', 'EUR', 'US Dollar', '840']) assert.deepEqual(read({ ClosePriceCurrency: scalar(text) }).observations.reported_close_price,
    cell('unsupported', '9007199254740993.01', null, 'raw_unit_unsupported'));
});

test('each price consults only its own specific currency, while generic fields are veto-only', () => {
  const split = read({ CurrentPriceCurrency: scalar('CAD') });
  assert.equal(split.observations.reported_close_price.state, 'observed'); assert.equal(split.observations.reported_current_price.state, 'unsupported');
  for (const generic of ['Currency', 'PriceCurrency']) {
    assert.deepEqual(read({ [generic]: scalar('CAD') }).observations.reported_close_price, cell('conflicting', '9007199254740993.01', null, 'raw_currency_conflict'));
    assert.equal(read({ [generic]: scalar(' usd ') }).observations.reported_close_price.state, 'observed');
    assert.deepEqual(read({ [generic]: scalar('USD'), ClosePriceCurrency: entry() }).observations.reported_close_price,
      cell('unsupported', '9007199254740993.01', null, 'raw_unit_missing'));
    for (const neutral of [entry(), entry('json_null', 'null'), scalar(' \t ')]) assert.equal(read({ [generic]: neutral }).observations.reported_close_price.state, 'observed');
    for (const invalid of [scalar('1', 'number'), scalar('false', 'boolean'), entry('non_scalar', 'array')]) assert.deepEqual(read({ [generic]: invalid }).observations.reported_close_price,
      cell('invalid', null, null, 'raw_currency_invalid'));
    assert.deepEqual(read({ [generic]: entry('oversize', 'string', null, 513) }).observations.reported_close_price,
      cell('unsupported', '9007199254740993.01', null, 'raw_currency_unavailable'));
  }
  assert.equal(read({ Currency: scalar('CAD'), PriceCurrency: scalar('cad'), ClosePriceCurrency: scalar(' CAD ') }).observations.reported_close_price.reason, 'raw_unit_unsupported');
  assert.equal(read({ CurrentPriceCurrency: entry('non_scalar', 'array') }).observations.reported_close_price.state, 'observed');
  assert.equal(read({ ClosePriceCurrency: entry('oversize', 'string', null, 513) }).observations.reported_current_price.state, 'observed');
});

test('multiple failures have fixed value-before-metadata and generic invalid/unavailable/conflict precedence', () => {
  assert.equal(read({ ClosePrice: entry(), Currency: scalar('CAD') }).observations.reported_close_price.reason, 'raw_value_absent');
  assert.equal(read({ ClosePrice: scalar('bad'), ClosePriceCurrency: entry() }).observations.reported_close_price.reason, 'raw_value_invalid');
  assert.equal(read({ ClosePriceCurrency: entry(), Currency: scalar('false', 'boolean') }).observations.reported_close_price.reason, 'raw_unit_missing');
  assert.equal(read({ Currency: scalar('CAD'), PriceCurrency: scalar('false', 'boolean') }).observations.reported_close_price.reason, 'raw_currency_invalid');
  assert.equal(read({ Currency: scalar('CAD'), PriceCurrency: entry('oversize', 'string', null, 513) }).observations.reported_close_price.reason, 'raw_currency_unavailable');
  assert.equal(read({ Currency: scalar('USD'), ClosePriceCurrency: scalar('CAD') }).observations.reported_close_price.reason, 'raw_currency_conflict');
});

test('MlsStatus is primary and StandardStatus is only a recognized-class consistency check', () => {
  const nonclosed = ['active', 'active option contract', 'active contingent', 'active kick out', 'active under contract',
    'pending', 'coming soon', 'hold', 'withdrawn', 'expired', 'canceled', 'cancelled', 'temp off market', 'temporarily off market', 'incomplete'];
  for (const text of nonclosed) {
    assert.deepEqual(read({ MlsStatus: scalar(` ${text.toUpperCase()} `) }).record_type, { state: 'nonclosed', reason: 'nonclosed' });
    assert.deepEqual(read({ MlsStatus: scalar(text), StandardStatus: scalar('Closed') }).record_type, { state: 'conflicting', reason: 'conflicting_record_type' });
    assert.deepEqual(read({ StandardStatus: scalar(text) }).record_type, { state: 'conflicting', reason: 'conflicting_record_type' });
    assert.equal(read({ MlsStatus: scalar(text), StandardStatus: scalar('Pending') }).record_type.state, 'nonclosed');
    assert.equal(normalizeAssignmentSalesObservations({ MlsStatus: text }).values.record_type, 'listing');
  }
  for (const raw of [entry(), entry('json_null', 'null'), scalar('')]) {
    assert.equal(read({ MlsStatus: raw, StandardStatus: scalar('Closed') }).record_type.state, 'unknown');
    assert.equal(read({ StandardStatus: raw }).record_type.state, 'closed');
  }
  for (const raw of [scalar('Sold'), scalar('Active - Pending'), scalar('true', 'boolean'), scalar('1', 'number'),
    entry('non_scalar', 'object'), entry('oversize', 'string', null, 513)]) {
    for (const field of ['MlsStatus', 'StandardStatus']) {
      const result = read({ [field]: raw });
      assert.deepEqual(result.record_type, { state: 'unknown', reason: 'unknown_record_type' });
      assert.deepEqual(result.diagnostics.raw_fields[field], raw);
    }
  }
  assert.equal(read({ StandardStatus: scalar(' cLoSeD ') }).record_type.state, 'closed');
  assert.equal(read({ MlsStatus: entry() }).diagnostics.status_interpretations.MlsStatus.reason, 'raw_status_absent');
});

test('raw CloseDate uses the installed ISO/US calendar syntax, not typed dates or timestamps', () => {
  const valid = [['2026-09-12', EFFECTIVE], [' 9/12/2026 ', EFFECTIVE], ['09/2/2026', '2026-09-02'], ['9/02/2026', '2026-09-02'],
    ['2000-02-29', '2000-02-29'], ['2/29/1600', '1600-02-29'], ['0001-01-01', '0001-01-01'], ['9999-12-31', '9999-12-31']];
  for (const [raw, expected] of valid) {
    assert.deepEqual(read({ CloseDate: scalar(raw) }).close_date, { state: 'observed', exact_value: expected, reason: null });
    assert.equal(normalizeAssignmentSalesObservations({ CloseDate: raw }).values.close_date, expected);
  }
  for (const raw of ['1900-02-29', '2100-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00',
    '0000-01-01', '26-09-12', '2026-9-12', '12/31/26', '31/12/2026', '2026-09-12T00:00:00Z', '2026-09-12Z']) {
    assert.deepEqual(read({ CloseDate: scalar(raw) }).close_date, { state: 'invalid', exact_value: null, reason: 'invalid_close_date' });
    assert.equal(normalizeAssignmentSalesObservations({ CloseDate: raw }).values.close_date, null);
  }
  for (const raw of [entry(), entry('json_null', 'null'), scalar(' \n ')]) {
    const result = read({ CloseDate: raw });
    assert.deepEqual(result.close_date, { state: 'missing', exact_value: null, reason: 'missing_close_date' });
    assert.deepEqual(result.diagnostics.raw_fields.CloseDate, raw);
  }
  for (const raw of [scalar('20260912', 'number'), scalar('false', 'boolean'), entry('non_scalar', 'array')]) {
    const result = read({ CloseDate: raw }); assert.equal(result.close_date.state, 'invalid'); assert.deepEqual(result.diagnostics.raw_fields.CloseDate, raw);
  }
  for (const raw of [entry('oversize', 'string', null, 513), entry('oversize', 'number', null, 999)]) {
    const result = read({ CloseDate: raw });
    assert.deepEqual(result.close_date, { state: 'unsupported', exact_value: null, reason: 'unsupported_close_date' });
    assert.deepEqual(result.diagnostics.raw_fields.CloseDate, raw);
  }
  assert.equal(read({ CloseDate: scalar('2026-09-13') }).close_date.exact_value, '2026-09-13', 'future reported dates remain observations; caller applies period gates');
});

test('alternate fields, generic currency and StandardStatus cannot fill absent primary observations', () => {
  const input = witness({ ListPrice: scalar('10'), OriginalListPrice: scalar('11'), AboveGradeFinishedArea: scalar('2000'),
    AboveGradeFinishedAreaUnits: scalar('sqft'), LotSizeSquareFeet: scalar('10000'), LotSizeAcres: scalar('1'),
    CumulativeDaysOnMarket: scalar('20'), ModificationTimestamp: scalar(EFFECTIVE), StandardStatus: scalar('Closed'),
    Currency: scalar('USD'), PriceCurrency: scalar('USD'), ListingId: scalar('UNRELATED_ID'), ListingKey: scalar('UNRELATED_KEY') });
  const result = interpret(input, EFFECTIVE);
  for (const [metric] of MEASUREMENTS) assert.equal(result.observations[metric].state, 'missing');
  assert.equal(result.record_type.state, 'unknown'); assert.equal(result.close_date.state, 'missing');
  assert.doesNotMatch(JSON.stringify(result), /UNRELATED_ID|UNRELATED_KEY|ListPrice|AboveGradeFinishedArea|ModificationTimestamp/);
});

test('interpretation preserves exact scalar UTF8 states/bounds through the full witness2 validator', () => {
  for (const unit of ['a', 'é', '💵']) {
    const text = unit.repeat(512 / Buffer.byteLength(unit)), raw = scalar(text), result = read({ PriceCurrency: raw });
    assert.deepEqual(result.diagnostics.raw_fields.PriceCurrency, raw); assert.equal(result.observations.reported_close_price.state, 'conflicting');
    assert.throws(() => read({ PriceCurrency: scalar(`${text}a`) }), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'scalar_mismatch' });
  }
  for (const value of ['e\u0301', ' CAD\n\t', '\u0001', '<b>USD</b>']) assert.equal(read({ PriceCurrency: scalar(value) }).diagnostics.raw_fields.PriceCurrency.value_text, value);
  assert.throws(() => read({ ClosePrice: scalar('01', 'number') }), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'scalar_type_mismatch' });
  assert.throws(() => read({ PriceCurrency: scalar('\u0000') }), { code: 'CACHED_SALE_WITNESS_INVALID' });
  assert.throws(() => read({ PriceCurrency: scalar('\ud800') }), { code: 'CACHED_SALE_WITNESS_INVALID' });
});

function witnessBytes(target) {
  const input = witness(); for (const key of FIELDS) input.fields[key] = scalar('a'.repeat(512));
  const delta = target - Buffer.byteLength(JSON.stringify(input));
  let controls = Math.floor(delta / 5), newlines = delta % 5;
  for (const key of FIELDS) {
    const n = Math.min(512, controls); controls -= n; const lines = Math.min(512 - n, newlines); newlines -= lines;
    input.fields[key] = scalar('\u0001'.repeat(n) + '\n'.repeat(lines) + 'a'.repeat(512 - n - lines));
  }
  assert.equal(controls, 0); assert.equal(newlines, 0); assert.equal(Buffer.byteLength(JSON.stringify(input)), target); return input;
}
test('whole witness bound is checked before interpretation even for unused fields', () => {
  const exact = witnessBytes(24_576); assert.doesNotThrow(() => interpret(exact, EFFECTIVE));
  assert.throws(() => interpret(witnessBytes(24_577), EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'witness_byte_limit' });
  assert.throws(() => interpret(null, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID', reason: 'witness_byte_limit' });
});

test('every result is detached and deeply frozen; no successful validation or caller mutation becomes a cache', () => {
  const input = fixture(), before = JSON.stringify(input), prepared = prepareCachedSaleWitnessV2(input), result = interpret(input, EFFECTIVE);
  const expected = JSON.stringify(result); assert.equal(JSON.stringify(input), before); assert.equal(Object.isFrozen(input), false);
  function checkFrozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(checkFrozen); } }
  checkFrozen(result);
  for (const [field, raw] of Object.entries(result.diagnostics.raw_fields)) { assert.notEqual(raw, input.fields[field]); assert.deepEqual(raw, input.fields[field]); }
  assert.deepEqual(interpret(prepared, EFFECTIVE), result);
  input.fields.ClosePrice.value_text = '1'; input.fields.ClosePrice.utf8_bytes = 1;
  assert.equal(JSON.stringify(result), expected); assert.equal(interpret(input, EFFECTIVE).observations.reported_close_price.exact_value, '1');
  assert.throws(() => { result.observations.reported_close_price.unit = 'CAD'; }, TypeError);
  const forged = structuredClone(prepared); forged.fields.ListingId.utf8_bytes = 1;
  assert.throws(() => interpret(forged, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID' });
});

test('forged shape/version/policies and hostile getters/proxies reject without execution or fallback', () => {
  for (const mutate of [value => { value.witness_version = 1; }, value => { value.witness_version = '2'; },
    value => { delete value.fields.PriceCurrency; }, value => { value.fields.PrivateRemarks = entry(); },
    value => { value.policy = 'trust_USD'; }, value => { value.fields.ListingId.extra = true; }]) {
    const input = fixture(); mutate(input); assert.throws(() => interpret(input, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID' });
  }
  assert.throws(() => interpret(fixture(), EFFECTIVE, { authority: true }), { code: 'CUSTOM_COHORT_REPORTED_SALE_WITNESS_V2_INVALID', reason: 'arguments' });
  for (const date of [null, undefined, 2026, '9/12/2026', '2026-02-29', `${EFFECTIVE}T00:00:00Z`]) assert.throws(() => interpret(fixture(), date), TypeError);
  let executed = 0;
  for (const [path, key] of [[[], 'fields'], [['fields'], 'ListingId'], [['fields', 'ClosePrice'], 'value_text']]) {
    const input = fixture(); let target = input; for (const key of path) target = target[key];
    Object.defineProperty(target, key, { enumerable: true, get() { executed++; throw new Error('getter ran'); } });
    assert.throws(() => interpret(input, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID' });
  }
  const handler = Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor'].map(key => [key, () => { executed++; throw new Error('trap ran'); }]));
  const revoked = Proxy.revocable({}, handler); revoked.revoke();
  for (const proxy of [new Proxy({}, handler), revoked.proxy]) {
    assert.throws(() => interpret(proxy, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID' });
    const input = fixture(); input.fields.ListingId = proxy; assert.throws(() => interpret(input, EFFECTIVE), { code: 'CACHED_SALE_WITNESS_INVALID' });
    assert.throws(() => interpret(fixture(), proxy), TypeError);
  }
  assert.equal(executed, 0);
});
