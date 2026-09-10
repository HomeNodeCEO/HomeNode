import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortReportedSharedSales as build } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { mapCachedSaleLinkRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const run = (fixture, selected = fixture.accountIds) => build({ retained_inputs: fixture.input.retained_inputs, selected_account_ids: selected });
const fixture = options => decisionEvidenceFixture({ effectiveDate: '2026-09-06', ...options });
const cell = (result, key) => result.rows[0].data.observations[key];
const transaction = (number, overrides = {}) => ({ source_record_id: String(10 + number), sale_id: String(20 + number),
  primary_account_id: '0000123456789', sale_account_id: '0000123456789', source_record_hash: 'c'.repeat(64),
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  source_current_price: '300000', source_living_area: '2000', source_year_built: 2000, source_days_on_market: 1, ...overrides });
const allZero = metric => {
  assert.equal(metric.observed_count + metric.missing_count + metric.invalid_count + metric.conflicting_count + metric.unsupported_count, 0);
  assert.equal(metric.low, null); assert.equal(metric.median, null); assert.equal(metric.high, null);
};

test('actual original mapping2 capture/persist/reopen yields source-record observations, not canonical transaction values', async () => {
  const f = await fixture(), before = JSON.stringify(f.input), output = run(f);
  assert.equal(output.captured_at, f.input.retained_inputs.acquisition.capture_result.captured_at);
  assert.equal(output.rows.length, 1); assert.equal(output.rows[0].id, 'core.sales_source_records:10');
  assert.deepEqual(output.rows[0].accounts, [f.accountIds[0], 'R-LINKED-ONLY']);
  assert.equal(output.rows[0].data.reported_close_date, '2024-03-01');
  assert.equal(output.rows[0].data.association_completeness, 'not_established');
  assert.ok(output.rows[0].data.retained_source_references.some(ref => ref.record_id === f.recordId && ref.source_ref === f.sourceRef));
  assert.equal(output.rows[0].data.basis, 'locally_stored_source_reported_observations');
  assert.equal(cell(output, 'reported_close_price').exact_value, null);
  assert.equal(cell(output, 'reported_current_price').exact_value, '275000');
  assert.equal(output.metrics.reported_days_on_market.median, '0');
  assert.equal(output.metrics.reported_year_built.median, '2001');
  assert.equal(output.disposition_counts.included, 1); assert.equal(JSON.stringify(f.input), before);
  assert.ok(Object.isFrozen(output.rows[0].accounts)); assert.ok(Object.isFrozen(output.metrics.reported_year_built));
  assert.equal(Object.hasOwn(output.rows[0].data, 'source_refs'), false, 'publication owner assigns its own retained source reference');
});

test('the original full associated account set is retained, including accounts outside discovery', async () => {
  const f = await fixture(), output = run(f, [f.accountIds[0]]);
  assert.equal(f.accountIds.includes('R-LINKED-ONLY'), false);
  assert.deepEqual(output.rows[0].accounts, [f.accountIds[0], 'R-LINKED-ONLY']);
  assert.equal(output.rows[0].data.unresolved_link_count, 1);
  assert.ok(output.rows[0].data.capability_gaps.includes('parcel_price_allocation_unavailable'));
  assert.equal(Object.hasOwn(output.rows[0].data, 'allocated_price'), false);
});

test('explicit empty selection and an unrelated selected account remain empty without default-all', async () => {
  const f = await fixture();
  for (const selected of [[], [f.accountIds[1]]]) {
    const output = run(f, selected); assert.deepEqual(output.rows, []); assert.equal(output.disposition_counts.outside_selection, 1);
    Object.values(output.metrics).forEach(allZero);
  }
});

test('a canonical associated account may select a source record without replacing its distinct source account', async () => {
  const f = await fixture({ extraTransactions: [transaction(1, { primary_account_id: 'R-001' })] });
  const output = run(f, [f.accountIds[0]]), extra = output.rows.find(row => row.id.endsWith(':11'));
  assert.deepEqual(extra.accounts, [f.accountIds[0], 'R-001']);
  assert.ok(extra.data.capability_gaps.includes('canonical_source_account_conflict'));
});

for (const [name, overrides, reason] of [
  ['listing', { record_type: 'listing' }, 'nonclosed'],
  ['unknown kind', { record_type: 'not-a-sale-kind' }, 'unknown_record_type'],
  ['null kind', { record_type: null }, 'unknown_record_type'],
  ['missing source date despite canonical date', { source_close_date: null }, 'missing_close_date'],
  ['invalid calendar date despite canonical date', { source_close_date: '2024-02-30' }, 'invalid_close_date'],
  ['ambiguous source date', { source_close_date: '3/1/2024' }, 'invalid_close_date'],
  ['too early source date', { source_close_date: '2023-06-30' }, 'outside_period'],
  ['too late source date', { source_close_date: '2024-07-01' }, 'outside_period'],
  ['future source date', { source_close_date: '2027-03-01' }, 'outside_period'],
]) test(`${name} is excluded using raw source fields, never canonical fallback`, async () => {
  const f = await fixture({ saleOverrides: overrides }), output = run(f);
  assert.deepEqual(output.rows, []); assert.equal(output.disposition_counts[reason], 1);
  Object.values(output.metrics).forEach(allZero);
});

test('raw closing date wins only as reported source meaning when canonical date disagrees', async () => {
  const f = await fixture({ saleOverrides: { source_close_date: '2024-04-01', sale_closing_date: '2025-01-01' } });
  const output = run(f); assert.equal(output.rows[0].data.reported_close_date, '2024-04-01');
  assert.ok(output.rows[0].data.capability_gaps.includes('canonical_source_date_conflict'));
});

test('source study endpoints are inclusive and date-only reported history does not become current stock support', async () => {
  for (const source_close_date of ['2023-07-01', '2024-06-30']) {
    const f = await decisionEvidenceFixture({ effectiveDate: '2024-06-30', saleOverrides: { source_close_date } });
    const output = run(f); assert.equal(output.rows.length, 1); assert.equal(output.rows[0].data.reported_close_date, source_close_date);
    assert.equal(Object.hasOwn(output, 'historical_stock_supported'), false); assert.equal(Object.hasOwn(output, 'apply'), false);
  }
});

test('raw typed decimal precision remains exact while unknown currency/area units remain unsupported', async () => {
  const f = await fixture({ saleOverrides: { source_current_price: '9007199254740993.123456789012',
    sale_price: '1', source_living_area: '01850.12500', source_lot_size_area: '0.000000000001' } }), output = run(f);
  assert.equal(cell(output, 'reported_current_price').exact_value, '9007199254740993.123456789012');
  assert.equal(cell(output, 'reported_living_area').exact_value, '1850.125');
  assert.equal(cell(output, 'reported_site_area').exact_value, '0.000000000001');
  for (const key of ['reported_current_price', 'reported_living_area', 'reported_site_area']) {
    assert.equal(output.metrics[key].unsupported_count, 1); assert.equal(output.metrics[key].unit, null);
    assert.equal(output.metrics[key].median, null); assert.equal(output.metrics[key].observed_count, 0);
  }
});

test('invalid, absent, zero and valid physical cells have distinct dispositions without CAD fallback', async () => {
  const f = await fixture({ saleOverrides: { source_current_price: 'NaN', source_living_area: '0',
    source_lot_size_area: null, source_year_built: null, source_days_on_market: 0 } }), output = run(f);
  assert.equal(output.metrics.reported_current_price.invalid_count, 1); assert.equal(output.metrics.reported_living_area.invalid_count, 1);
  assert.equal(output.metrics.reported_site_area.missing_count, 1); assert.equal(output.metrics.reported_year_built.missing_count, 1);
  assert.equal(output.metrics.reported_year_built.median, null, 'retained CAD year exists but is not borrowed');
  assert.equal(output.metrics.reported_days_on_market.observed_count, 1); assert.equal(output.metrics.reported_days_on_market.median, '0');
});

for (const invalid of ['1e6', '-1', '1.1234567890123', '9'.repeat(31), true, 'Infinity']) {
  test(`invalid reported numeric form ${String(invalid)} is not silently rounded/coerced`, async () => {
    const f = await fixture({ saleOverrides: { source_current_price: invalid } }), output = run(f);
    assert.equal(output.metrics.reported_current_price.invalid_count, 1); assert.equal(cell(output, 'reported_current_price').exact_value, null);
  });
}

test('all in-period source records contribute: there is no top-30, uniqueness or price-ratio sampling', async () => {
  const extraTransactions = Array.from({ length: 40 }, (_, index) => transaction(index + 1, { source_days_on_market: index + 1 }));
  const f = await fixture({ extraTransactions }), output = run(f);
  assert.equal(output.rows.length, 41); assert.equal(output.disposition_counts.included, 41);
  assert.equal(output.metrics.reported_days_on_market.low, '0'); assert.equal(output.metrics.reported_days_on_market.high, '40');
  assert.equal(output.metrics.reported_days_on_market.median, '20');
  for (const metric of Object.values(output.metrics)) assert.equal(metric.observed_count + metric.missing_count
    + metric.invalid_count + metric.conflicting_count + metric.unsupported_count, 41);
});

test('even-sample medians are exact and mixed listings never enter a reported closed-source population', async () => {
  const f = await fixture({ extraTransactions: [transaction(1), transaction(2, { record_type: 'listing', source_days_on_market: 100 })] }), output = run(f);
  assert.equal(output.rows.length, 2); assert.equal(output.metrics.reported_days_on_market.median, '0.5');
  assert.equal(output.metrics.reported_year_built.median, '2000.5'); assert.equal(output.disposition_counts.nonclosed, 1);
});

test('mapping3 original witness capture remains readable but latest raw units/prices are never paired with older typed values', async () => {
  const f = await saleWitnessMeaningFixture({ effectiveDate: '2026-09-06', rawPayload: { CurrentPrice: '999999', ClosePrice: '888888',
    Currency: 'USD', LivingArea: '2', LivingAreaUnits: 'Square Meters', MlsStatus: 'Closed', CloseDate: '2024-03-01' } }), output = run(f);
  assert.equal(output.rows[0].data.mapping_version, 3);
  assert.equal(cell(output, 'reported_current_price').exact_value, '275000');
  assert.equal(cell(output, 'reported_living_area').exact_value, '1850.125');
  assert.equal(output.metrics.reported_current_price.unit, null); assert.equal(output.metrics.reported_living_area.unit, null);
  assert.equal(cell(output, 'reported_close_price').exact_value, null);
  assert.equal(output.metrics.reported_close_price.unsupported_count, 1);
  assert.equal(cell(output, 'reported_close_price').reason, 'raw_witness_close_price_not_interpreted_by_this_profile');
  assert.equal(JSON.stringify(output).includes('999999'), false);
});

test('mapping3 explicit witness absence/null/blank differs from retained but uninterpreted ClosePrice', async () => {
  for (const rawPayload of [{}, { ClosePrice: null }, { ClosePrice: '  ' }]) {
    const f = await saleWitnessMeaningFixture({ effectiveDate: '2026-09-06', rawPayload }), output = run(f);
    assert.equal(output.metrics.reported_close_price.missing_count, 1);
    assert.equal(cell(output, 'reported_close_price').reason, 'raw_witness_close_price_missing');
  }
  const f = await saleWitnessMeaningFixture({ effectiveDate: '2026-09-06', rawPayload: null }), output = run(f);
  assert.equal(output.metrics.reported_close_price.unsupported_count, 1, 'missing payload does not prove the field is absent');
});

test('legacy canonical-only rows remain explicitly unavailable, not fabricated source records', async () => {
  const f = await saleWitnessMeaningFixture({ effectiveDate: '2026-09-06', extraTransactions: [transaction(1, { source_record_id: null })] });
  const output = run(f); assert.equal(output.rows.length, 1); assert.equal(output.disposition_counts.legacy_source_record_unavailable, 1);
});

test('same exact source input and selection order yield identical detached output', async () => {
  const f = await fixture(), output = run(f), reversed = run(f, [...f.accountIds].reverse());
  assert.deepEqual(output, reversed);
  assert.throws(() => { output.rows[0].data.observations.reported_year_built.exact_value = '1900'; }, TypeError);
});

test('local pure-consumer selection, period, profile and routing consistency guards fail closed', async () => {
  const f = await fixture();
  assert.throws(() => run(f, ['unknown-account']), /selection/);
  assert.throws(() => run(f, [f.accountIds[0], f.accountIds[0]]), /selection/);
  for (const mutate of [
    value => { value.study.observation_period.end_date = '2027-01-01'; },
    value => { value.acquisition.capture_result.query_complete = false; },
    value => { value.acquisition.capture_result.source_capture.scope.account_id = 'wrong'; },
    value => { value.acquisition.capture_result.source_capture.references = []; },
    value => { const metadata = JSON.parse(value.acquisition.compact_metadata_json); metadata.mapping_version = 9;
      value.acquisition.compact_metadata_json = JSON.stringify(metadata); },
  ]) {
    const copied = structuredClone(f.input.retained_inputs); mutate(copied);
    assert.throws(() => build({ retained_inputs: copied, selected_account_ids: f.accountIds }), /custom_cohort/);
  }
});

test('pure-consumer resource guard retains the complete >5 association set and refuses >1000 without clipping', async () => {
  // These rows test the downstream bounded consumer only. This is deliberately
  // not claimed to be an owner-admitted/rehashed capture or a publication test.
  const f = await fixture(), copied = structuredClone(f.input.retained_inputs), capture = copied.acquisition.capture_result.source_capture;
  const source = capture.sources.find(value => value.payload.projection.definition.role === 'sale_links');
  const route = capture.references.find(value => value.record_sources.some(ref => ref.source_ref === source.id));
  function add(index) {
    const record_id = `synthetic-link:${index}`, data = mapCachedSaleLinkRow({ source_record_id: '10', parcel_link_id: String(index + 1000),
      account_id: `EXTRA-${String(index).padStart(4, '0')}`, is_resolved: true, match_method: 'exact' });
    source.payload.records.push({ record_id, data }); route.record_sources.push({ source_ref: source.id, record_id });
  }
  for (let i = 0; i < 8; i++) add(i);
  const output = build({ retained_inputs: copied, selected_account_ids: [f.accountIds[0]] });
  assert.equal(output.rows[0].accounts.length, 10);
  for (let i = 8; i < 999; i++) add(i);
  assert.throws(() => build({ retained_inputs: copied, selected_account_ids: f.accountIds }), /account_set_limit/);
});
