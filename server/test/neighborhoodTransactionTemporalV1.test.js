import assert from 'node:assert/strict';
import test from 'node:test';
import { compileNeighborhoodFrozenTypedOriginalV2, getNeighborhoodFrozenTypedOriginalV2Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from '../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { projectNeighborhoodTransactionTemporalV1, prepareNeighborhoodTransactionRetainedPeriodV1,
  getNeighborhoodTransactionTemporalV1Profile, NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS }
  from '../src/services/neighborhoodAssessment/neighborhoodTransactionTemporalV1.js';

const effective = '2026-10-07', period = { start_date: '2025-01-01', end_date: effective };
function witness(overrides = {}) {
  const values = { MlsStatus: 'closed', CloseDate: '2025-01-01', ClosePrice: '9007199254740993.01',
    ClosePriceCurrency: 'USD', LivingArea: '1000.001', LivingAreaUnits: 'sqft', YearBuilt: '2050', ...overrides };
  const fields = Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(key => {
    if (!Object.hasOwn(values, key) || values[key] === undefined)
      return [key, { state: 'absent', json_type: null, value_text: null, utf8_bytes: null }];
    const value = values[key];
    if (value === null) return [key, { state: 'json_null', json_type: 'null', value_text: null, utf8_bytes: null }];
    const type = Array.isArray(value) ? 'array' : typeof value, text = type === 'string' ? value : JSON.stringify(value);
    const scalar = ['string', 'number', 'boolean'].includes(type), bytes = Buffer.byteLength(text);
    if (!scalar) return [key, { state: 'non_scalar', json_type: type, value_text: null, utf8_bytes: null }];
    return [key, { state: scalar ? bytes > 512 ? 'oversize' : 'scalar' : 'non_scalar', json_type: type,
      value_text: bytes > 512 ? null : text, utf8_bytes: bytes }];
  }));
  return { witness_version: 2, root_state: 'object', root_json_type: 'object', fields };
}
function row(kind = 'source_records', payload = {}, reported = {}) {
  const raw = { id: '10', ...(kind === 'source_records' ? {
    primary_account_id: 'OUTSIDE', year_built: 2050, current_price: '0.01', close_date: '2025-01-01',
    listing_contract_date: '2010-01-01', record_type: 'closed', source_raw_witness: witness(reported),
  } : { account_id: kind === 'sales' ? 'STOCK-A' : null, source_record_id: kind === 'sales' ? null : '10',
    ...(kind === 'sales' ? { sale_price: '0.01', closing_date: '2012-01-01' } : { source_position: 1, parcel_sequence: 1, is_resolved: false }) }), ...payload };
  const typed = compileNeighborhoodFrozenTypedOriginalV2({ kind, row_key: '10', payload_text: JSON.stringify(raw) });
  return { kind, row_key: '10', account_id: typed.account_id, source_record_id: typed.source_record_id,
    original_payload_sha256: typed.original.payload_sha256, typed };
}
const project = r => projectNeighborhoodTransactionTemporalV1(r, effective, period);

test('retained effective year runs before normalized/reported resolution, with exact prices and neutral originals unchanged', () => {
  const original = row(), before = JSON.stringify(original), p = project(original);
  for (const cell of [p.normalized.observations.normalized_year_built, p.same_payload_reported_sale.observations.reported_year_built])
    assert.deepEqual(cell, { state: 'invalid', exact_value: null, unit: null, reason: 'year_after_retained_effective_year' });
  assert.equal(original.typed.observations.normalized_year_built.exact_value, '2050');
  assert.equal(original.typed.same_payload_reported_sale.observations.reported_year_built.exact_value, '2050');
  assert.equal(p.normalized.observations.normalized_current_price.state, 'unsupported');
  assert.equal(p.normalized.observations.normalized_current_price.exact_value, '0.01');
  assert.deepEqual(p.same_payload_reported_sale.observations.reported_close_price,
    { state: 'observed', exact_value: '9007199254740993.01', unit: 'USD', reason: null });
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(project(row('source_records', { year_built: 1960 }, { YearBuilt: '1960' })).normalized.observations.normalized_year_built,
    { state: 'observed', exact_value: '1960', unit: 'year', reason: null });
  assert.equal(project(row('source_records', { year_built: 2026 }, { YearBuilt: '2026' })).same_payload_reported_sale.observations.reported_year_built.state, 'observed');
});

test('both exact closing dates use inclusive retained period bounds without dropping old/future evidence', () => {
  for (const [date, state] of [['2024-12-31', 'outside_period'], ['2025-01-01', 'in_period'],
    ['2026-10-07', 'in_period'], ['2026-10-08', 'outside_period'], ['9999-12-31', 'outside_period']]) {
    const p = project(row('source_records', { close_date: date }, { CloseDate: date }));
    for (const d of [p.normalized.period_disposition, p.same_payload_reported_sale.period_disposition]) {
      assert.equal(d.state, state); assert.equal(d.exact_date, date);
    }
    assert.equal(p.normalized.dates.listing_contract_date.exact_value, '2010-01-01', 'contract date is retained but not closing-date fallback');
    assert.equal(p.same_payload_reported_sale.closed_record_disposition, state === 'in_period' ? 'closed_in_period_syntax_only' : 'outside_period');
  }
  assert.equal(project(row('source_records', {}, { CloseDate: '1/1/2025' })).same_payload_reported_sale.close_date.exact_value, '2025-01-01');
  const leap = projectNeighborhoodTransactionTemporalV1(row('source_records', { close_date: '2024-02-29' }, { CloseDate: '2/29/2024' }),
    '2024-02-29', { start_date: '2024-02-29', end_date: '2024-02-29' });
  assert.equal(leap.same_payload_reported_sale.period_disposition.state, 'in_period');
});

test('normalized and same-payload closing dates/status/currency stay independent, with no cross-field fallback', () => {
  const disagreement = project(row('source_records', { close_date: '2010-01-01' }, { CloseDate: '2025-01-01' }));
  assert.equal(disagreement.normalized.period_disposition.state, 'outside_period');
  assert.equal(disagreement.same_payload_reported_sale.period_disposition.state, 'in_period');
  const normalizedMissing = project(row('source_records', { close_date: null }));
  assert.equal(normalizedMissing.normalized.period_disposition.state, 'missing');
  assert.equal(normalizedMissing.same_payload_reported_sale.period_disposition.state, 'in_period');
  const reportedMissing = project(row('source_records', {}, { CloseDate: null, ClosePriceCurrency: null }));
  assert.equal(reportedMissing.same_payload_reported_sale.closed_record_disposition, 'missing_close_date');
  assert.equal(reportedMissing.same_payload_reported_sale.observations.reported_close_price.state, 'unsupported');
  for (const [markers, expected] of [[{ MlsStatus: undefined }, 'unknown_record_type'],
    [{ MlsStatus: 'active' }, 'nonclosed'], [{ StandardStatus: 'active' }, 'conflicting_record_type'],
    [{ StandardStatus: 'invented' }, 'unknown_record_type']])
    assert.equal(project(row('source_records', {}, markers)).same_payload_reported_sale.closed_record_disposition, expected);
});

test('missing, invalid and unsupported dates retain distinct dispositions; source-less sales/links mint no dates or witnesses', () => {
  for (const [date, state] of [[null, 'missing'], [' ', 'missing'], ['2025-02-29', 'invalid'],
    ['2025-01-01T00:00:00Z', 'invalid'], [[], 'invalid'], ['x'.repeat(1024), 'unsupported']]) {
    const p = project(row('source_records', { close_date: date }, { CloseDate: date }));
    assert.equal(p.normalized.period_disposition.state, state); assert.equal(p.same_payload_reported_sale.period_disposition.state, state);
    assert.equal(p.same_payload_reported_sale.closed_record_disposition, `${state}_close_date`);
  }
  const sale = project(row('sales'));
  assert.equal(sale.source_record_id, null); assert.equal(sale.same_payload_reported_sale, null);
  assert.equal(sale.normalized.period_disposition.state, 'outside_period');
  assert.equal(sale.normalized.observations.recorded_sale_price.exact_value, '0.01');
  assert.equal(sale.normalized.observations.recorded_sale_price.state, 'unsupported');
  const link = project(row('sale_links'));
  assert.equal(link.account_id, null); assert.equal(link.same_payload_reported_sale, null);
  assert.deepEqual(link.normalized.period_disposition,
    { state: 'unsupported', exact_date: null, reason: 'date_not_present_in_link_original' });
  assert.deepEqual(link.normalized.observations, {});
  assert.equal(link.markers.is_resolved.value_text, 'false');
  assert.equal(link.markers.source_position.value_text, '1');
  for (const r of [sale, link]) { assert.equal(r.transaction_eligibility, 'not_established'); assert.equal(r.association_resolution, 'not_established'); }
});

test('retained periods and typed originals refuse hostile or forged inputs without executing accessors', () => {
  for (const p of [{ start_date: '2026-10-08', end_date: effective }, { start_date: period.start_date, end_date: '2026-10-08' },
    { ...period, date_basis: 'contract_date' }, { ...period, grant: true }, new Proxy(period, {}),
    { ...period, get start_date() { assert.fail('getter'); } }])
    assert.throws(() => projectNeighborhoodTransactionTemporalV1(row(), effective, p), /invalid_period|future_or_reversed_period/);
  assert.throws(() => projectNeighborhoodTransactionTemporalV1(row(), '2025-02-29', period), /invalid_neighborhood_assessment/);
  assert.throws(() => projectNeighborhoodTransactionTemporalV1(row(), effective, period, { authority: true }), /invalid_arguments/);
  assert.throws(() => project(new Proxy(row(), {})), /invalid_data/);
  const forged = structuredClone(row()); forged.typed.observations.normalized_year_built.exact_value = '1960';
  assert.throws(() => project(forged), /invalid_cell/);
  const hostile = structuredClone(row()); Object.defineProperty(hostile.typed.dates.close_date, 'exact_value',
    { enumerable: true, get() { assert.fail('nested getter'); } });
  assert.throws(() => project(hostile), /invalid_data/);
});

test('compact projections remain immutable, bounded and bound to retained date/period plus unchanged original/profile', () => {
  const source = row(), p = project(source), alternate = projectNeighborhoodTransactionTemporalV1(source, '2051-01-01',
    { start_date: '2025-01-01', end_date: '2051-01-01' });
  assert.equal(alternate.normalized.observations.normalized_year_built.state, 'observed', 'DATA-only alternative is not an authorized report-date change');
  assert.deepEqual(p.original, source.typed.original); assert.equal(p.original.payload_sha256, source.original_payload_sha256);
  assert.equal(p.account_id, 'OUTSIDE'); assert.equal(p.report_update, 'none');
  assert.ok(Object.isFrozen(p.normalized.period_disposition)); assert.ok(Object.isFrozen(p.same_payload_reported_sale.observations));
  assert.ok(Buffer.byteLength(JSON.stringify(p)) < NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS.row_utf8_bytes);
  const originalPeriod = { ...period }, copied = prepareNeighborhoodTransactionRetainedPeriodV1(originalPeriod, effective);
  originalPeriod.start_date = '2010-01-01'; assert.equal(copied.start_date, '2025-01-01');
  const profile = getNeighborhoodTransactionTemporalV1Profile(), definition = JSON.parse(profile.definition_blob.canonical_json);
  assert.deepEqual(definition.shared_typed_profile, getNeighborhoodFrozenTypedOriginalV2Profile());
  assert.equal(definition.period.basis, 'closing_date_only');
  assert.equal(definition.authority, 'not_established'); assert.equal(p.historical_stock, 'not_established');
});
