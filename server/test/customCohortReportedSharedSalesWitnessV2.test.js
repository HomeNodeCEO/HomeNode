import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson as canonical } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortReportedSharedSales as legacy,
  buildCustomCohortReportedSharedSalesWitnessV2 as build } from '../src/services/neighborhoodAssessment/customCohortReportedSharedSales.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const payload = (overrides = {}) => ({ MlsStatus: 'Closed', CloseDate: '2024-03-01',
  ClosePrice: '300001.000000000001', ClosePriceCurrency: 'USD', CurrentPrice: '299999', CurrentPriceCurrency: 'USD',
  LivingArea: '180.5', LivingAreaUnits: 'Square Meters', LotSizeArea: '0.25', LotSizeUnits: 'Acres',
  YearBuilt: '1999', DaysOnMarket: '12', ...overrides });
const fixture = (options = {}) => cadEvidenceFixture({ mappingVersion: 5, rawPayload: payload(), ...options });
const retained = f => f.input.retained_inputs;
const accounts = f => retained(f).spatial.account_ids;
const run = (f, selected = accounts(f)) => build({ retained_inputs: retained(f), selected_account_ids: selected });
const observation = (output, key, index = 0) => output.rows[index].data.observations[key];
const extra = (number, overrides = {}) => ({ source_record_id: String(10 + number), sale_id: String(20 + number),
  primary_account_id: '0000123456789', sale_account_id: '0000123456789', source_record_hash: 'c'.repeat(64),
  record_type: 'closed_sale', source_close_date: '2024-03-01', sale_closing_date: '2024-03-01',
  source_current_price: '888888', sale_price: '777777', source_living_area: '2222',
  source_year_built: 2002, source_days_on_market: 91, ...overrides });
const countFields = ['observed_count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'];
function conserve(output, expected = output.rows.length) {
  assert.equal(output.rows.length, expected);
  assert.equal(output.disposition_counts.included, expected);
  for (const metric of Object.values(output.metrics)) {
    assert.equal(countFields.reduce((sum, key) => sum + metric[key], 0), expected);
    for (const key of countFields) assert.ok(Number.isSafeInteger(metric[key]) && metric[key] >= 0);
  }
  for (const count of Object.values(output.disposition_counts)) assert.ok(Number.isSafeInteger(count) && count >= 0);
}
function empty(output) {
  conserve(output, 0);
  for (const metric of Object.values(output.metrics)) {
    assert.equal(metric.low, null); assert.equal(metric.median, null); assert.equal(metric.high, null);
  }
}
function frozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen);
  }
}
function transactions(input) {
  return input.acquisition.capture_result.source_capture.sources
    .filter(source => source.payload.projection.definition.role === 'transactions')
    .flatMap(source => source.payload.records);
}

// These literal goldens were recorded before the production refactor. They
// cover the default entry point, not a new result used as its own oracle.
for (const [version, produce, expected] of [
  [2, () => decisionEvidenceFixture({ effectiveDate: '2026-09-06' }), '5fe9fd4a2070649950a23354f9369ae8da89f1d2ae23c7ed3d6520544cc87a8f'],
  [3, () => saleWitnessMeaningFixture({ effectiveDate: '2026-09-06' }), '4f47430a4b098ad5b8ed780ba59195b6807534fc0a1599618e48084461ac0b26'],
  [4, () => cadEvidenceFixture(), '9d9bfa406865cb9c767af0b49059e4fd2b4a749b146609f8d51d33256f610b18'],
  [5, () => cadEvidenceFixture({ mappingVersion: 5 }), 'cd05a3dc5d790eb3bac195eec15621d629f070c8221512efe515fc4649ea1e8b'],
]) test(`default mapping${version} full canonical output retains its pre-refactor hash`, async () => {
  const f = await produce(), input = retained(f), before = JSON.stringify(input);
  const output = legacy({ retained_inputs: input, selected_account_ids: accounts(f) });
  assert.equal(hash(canonical(output)), expected);
  assert.equal(Object.hasOwn(output, 'interpretation_profile_ref'), false);
  assert.equal(JSON.stringify(input), before);
  if (version !== 5) assert.throws(() => run(f), /mapping5_required/);
});

test('explicit original mapping5 reopen uses only same-witness values, not old typed or canonical measurements', async () => {
  const f = await fixture({ saleOverrides: { source_current_price: '12', source_living_area: '34',
    source_lot_size_area: '56', source_year_built: 1980, source_days_on_market: 90, sale_price: '999999' } });
  const before = JSON.stringify(f.input), output = run(f); conserve(output, 1);
  for (const [key, exact_value, unit] of [
    ['reported_close_price', '300001.000000000001', 'USD'], ['reported_current_price', '299999', 'USD'],
    ['reported_living_area', '180.5', 'sqm'], ['reported_site_area', '0.25', 'acre'],
    ['reported_year_built', '1999', 'year'], ['reported_days_on_market', '12', 'days'],
  ]) assert.deepEqual(observation(output, key), { state: 'observed', exact_value, unit, reason: null });
  assert.equal(output.rows[0].data.mapping_version, 5);
  assert.equal(output.rows[0].data.reported_close_date, '2024-03-01');
  assert.equal(output.rows[0].data.observation_basis, 'same_payload_scalar_witness_reported_not_verified');
  assert.equal(output.rows[0].data.association_completeness, 'not_established');
  assert.equal(JSON.stringify(f.input), before);
  assert.equal(transactions(retained(f))[0].data.raw_projection.source_current_price, '12');
  assert.equal(transactions(retained(f))[0].data.raw_projection.source_raw_witness.fields.CurrentPrice.value_text, '299999');
  const old = legacy({ retained_inputs: retained(f), selected_account_ids: accounts(f) });
  assert.equal(observation(old, 'reported_current_price').exact_value, '12');
  assert.equal(observation(old, 'reported_close_price').state, 'unsupported', 'default mapping5 remains dormant');
  assert.equal(observation(old, 'reported_living_area').unit, null, 'old typed values cannot inherit newer raw units');
});

test('literal units without their same-witness values cannot decorate surviving typed/CAD measurements', async () => {
  const f = await fixture({ rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01',
    ClosePriceCurrency: 'USD', CurrentPriceCurrency: 'USD', LivingAreaUnits: 'Square Feet', LotSizeUnits: 'Acres' } });
  const output = run(f); conserve(output, 1);
  for (const [key, metric] of Object.entries(output.metrics)) {
    assert.equal(metric.missing_count, 1); assert.equal(metric.median, null);
    assert.deepEqual(observation(output, key), { state: 'missing', exact_value: null, unit: null, reason: 'raw_value_absent' });
  }
});

test('CurrentPrice and generic USD never fill absent ClosePrice or absent field-specific currencies', async () => {
  const f = await fixture({ rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01',
    CurrentPrice: '700000', Currency: 'USD', PriceCurrency: 'USD' } }), output = run(f);
  assert.deepEqual(observation(output, 'reported_close_price'),
    { state: 'missing', exact_value: null, unit: null, reason: 'raw_value_absent' });
  assert.deepEqual(observation(output, 'reported_current_price'),
    { state: 'unsupported', exact_value: '700000', unit: null, reason: 'raw_unit_missing' });
  assert.equal(output.metrics.reported_current_price.median, null); conserve(output, 1);
});

test('other-price currency is not borrowed and contradictory generic currency prevents aggregation', async () => {
  const f = await fixture({ rawPayload: payload({ CurrentPriceCurrency: 'CAD' }) }), output = run(f);
  assert.equal(observation(output, 'reported_close_price').state, 'observed');
  assert.equal(observation(output, 'reported_current_price').state, 'unsupported');
  assert.equal(output.metrics.reported_current_price.median, null);
  const conflict = run(await fixture({ rawPayload: payload({ Currency: 'CAD' }) }));
  for (const key of ['reported_close_price', 'reported_current_price']) {
    assert.equal(observation(conflict, key).state, 'conflicting');
    assert.equal(observation(conflict, key).reason, 'raw_currency_conflict');
    assert.equal(conflict.metrics[key].median, null); assert.equal(conflict.metrics[key].conflicting_count, 1);
  }
});

test('raw status/date control inclusion even when the surviving typed source/canonical values disagree', async () => {
  const f = await fixture({ rawPayload: payload({ MlsStatus: ' CLOSED ', CloseDate: ' 3/2/2024 ' }),
    saleOverrides: { record_type: 'listing', source_close_date: '2025-02-01', sale_closing_date: '2025-03-01' } });
  const output = run(f); conserve(output, 1);
  assert.equal(output.rows[0].data.reported_close_date, '2024-03-02');
  empty(legacy({ retained_inputs: retained(f), selected_account_ids: accounts(f) }));
});

for (const [label, raw, reason] of [
  ['missing MlsStatus despite closed StandardStatus', { StandardStatus: 'Closed', CloseDate: '2024-03-01' }, 'unknown_record_type'],
  ['unknown MlsStatus despite closed StandardStatus', { MlsStatus: 'Provider mystery', StandardStatus: 'Closed', CloseDate: '2024-03-01' }, 'unknown_record_type'],
  ['raw listing despite typed closed sale', { MlsStatus: 'Pending', CloseDate: '2024-03-01' }, 'nonclosed'],
  ['recognized opposite statuses', { MlsStatus: 'Closed', StandardStatus: 'Active', CloseDate: '2024-03-01' }, 'conflicting_record_type'],
  ['unknown secondary status', { MlsStatus: 'Closed', StandardStatus: 'Unmapped', CloseDate: '2024-03-01' }, 'unknown_record_type'],
  ['missing raw date despite surviving typed dates', { MlsStatus: 'Closed' }, 'missing_close_date'],
  ['blank raw date', { MlsStatus: 'Closed', CloseDate: '  ' }, 'missing_close_date'],
  ['impossible calendar date', { MlsStatus: 'Closed', CloseDate: '2024-02-30' }, 'invalid_close_date'],
  ['timestamp is not a local calendar date', { MlsStatus: 'Closed', CloseDate: '2024-03-01T00:00:00Z' }, 'invalid_close_date'],
  ['earlier than observation period', { MlsStatus: 'Closed', CloseDate: '2023-06-30' }, 'outside_period'],
  ['later than observation period', { MlsStatus: 'Closed', CloseDate: '2024-07-01' }, 'outside_period'],
  ['future date', { MlsStatus: 'Closed', CloseDate: '2027-03-01' }, 'outside_period'],
]) test(`${label} does not use typed status/date fallback`, async () => {
  const f = await fixture({ rawPayload: raw }), output = run(f); empty(output);
  assert.equal(output.disposition_counts[reason], 1);
  assert.equal(legacy({ retained_inputs: retained(f), selected_account_ids: accounts(f) }).rows.length, 1);
});

test('reported dates at both inclusive endpoints remain inspectable without claiming retrospective stock support', async () => {
  for (const CloseDate of ['2023-07-01', '2024-06-30']) {
    const f = await fixture({ effectiveDate: '2024-06-30', rawPayload: payload({ CloseDate }) }), output = run(f);
    conserve(output, 1); assert.equal(output.rows[0].data.reported_close_date, CloseDate);
    assert.equal(Object.hasOwn(output, 'historical_stock_supported'), false);
    assert.equal(Object.hasOwn(output, 'apply'), false);
  }
});

test('oversize raw CloseDate remains excluded with its original unavailable witness state retained', async () => {
  const f = await fixture({ rawPayload: payload({ CloseDate: 'x'.repeat(513) }) }), output = run(f);
  empty(output); assert.equal(output.disposition_counts.unsupported_close_date, 1);
  assert.equal(output.disposition_counts.invalid_close_date, 0);
  assert.deepEqual(transactions(retained(f))[0].data.raw_projection.source_raw_witness.fields.CloseDate,
    { state: 'oversize', json_type: 'string', value_text: null, utf8_bytes: 513 });
  assert.equal(Object.hasOwn(legacy({ retained_inputs: retained(f), selected_account_ids: accounts(f) }).disposition_counts,
    'unsupported_close_date'), false, 'the additional disposition belongs only to the explicit new interpreter');
});

test('genuine multiple sources retain exact >Number precision and a 13-place even median', async () => {
  const f = await fixture({ extraTransactions: [extra(1)],
    rawPayload: payload({ ClosePrice: '9007199254740993.000000000001', LivingArea: '100.000000000001' }),
    saleWitnessesBySourceId: { '11': { rawPayload: payload({ ClosePrice: '9007199254740993.000000000002',
      LivingArea: '100.000000000002', YearBuilt: '2000', DaysOnMarket: '13' }) } } });
  const output = run(f); conserve(output, 2);
  assert.deepEqual(output.rows.map(row => row.data.source_record_id), ['10', '11']);
  assert.equal(output.metrics.reported_close_price.low, '9007199254740993.000000000001');
  assert.equal(output.metrics.reported_close_price.high, '9007199254740993.000000000002');
  assert.equal(output.metrics.reported_close_price.median, '9007199254740993.0000000000015');
  assert.equal(output.metrics.reported_living_area.median, '100.0000000000015');
  assert.equal(output.metrics.reported_year_built.median, '1999.5');
  assert.equal(output.metrics.reported_days_on_market.median, '12.5');
});

test('unlike observed area units preserve every source but have no pooled statistic or preferred subset', async () => {
  const f = await fixture({ extraTransactions: [extra(1)], rawPayload: payload({ LivingArea: '100', LotSizeArea: '1' }),
    saleWitnessesBySourceId: { '11': { rawPayload: payload({ LivingArea: '2000', LivingAreaUnits: 'sq ft',
      LotSizeArea: '43560', LotSizeUnits: 'sqft' }) } } }), output = run(f);
  conserve(output, 2);
  for (const key of ['reported_living_area', 'reported_site_area']) {
    assert.equal(output.metrics[key].observed_count, 2);
    assert.equal(output.metrics[key].unit, null); assert.equal(output.metrics[key].median, null);
    assert.equal(output.metrics[key].low, null); assert.equal(output.metrics[key].high, null);
    assert.equal(observation(output, key, 0).state, 'observed'); assert.equal(observation(output, key, 1).state, 'observed');
  }
  assert.deepEqual(output.rows.map(row => row.data.observations.reported_living_area.unit), ['sqm', 'sqft']);
  assert.equal(output.metrics.reported_close_price.unit, 'USD');
  assert.equal(output.metrics.reported_close_price.observed_count, 2);
});

test('all five measurement states remain in the full included-source denominator', async () => {
  const f = await fixture({ extraTransactions: [1, 2, 3, 4].map(n => extra(n)),
    saleWitnessesBySourceId: {
      '11': { rawPayload: payload({ ClosePrice: null }) },
      '12': { rawPayload: payload({ ClosePrice: '-1' }) },
      '13': { rawPayload: payload({ Currency: 'CAD' }) },
      '14': { rawPayload: payload({ ClosePriceCurrency: 'EUR' }) },
    } }), output = run(f);
  conserve(output, 5);
  for (const key of countFields) assert.equal(output.metrics.reported_close_price[key], 1);
  assert.equal(output.metrics.reported_close_price.median, '300001.000000000001');
  assert.equal(output.metrics.reported_close_price.unit, 'USD');
});

test('all 41 original source records participate without top-30 or price-ratio sampling', async () => {
  const extraTransactions = Array.from({ length: 40 }, (_, index) => extra(index + 1));
  const saleWitnessesBySourceId = Object.fromEntries(extraTransactions.map((row, index) => [row.source_record_id,
    { rawPayload: payload({ ClosePrice: String(index + 1), DaysOnMarket: String(index + 1) }) }]));
  const f = await fixture({ extraTransactions, saleWitnessesBySourceId,
    rawPayload: payload({ ClosePrice: '0', DaysOnMarket: '0' }) }), output = run(f);
  conserve(output, 41);
  assert.equal(output.metrics.reported_close_price.low, '0'); assert.equal(output.metrics.reported_close_price.median, '20');
  assert.equal(output.metrics.reported_close_price.high, '40'); assert.equal(output.metrics.reported_days_on_market.median, '20');
  assert.equal(new Set(output.rows.map(row => row.id)).size, 41);
});

test('full original associations, outside-discovery links and unresolved evidence are retained without allocation', async () => {
  const f = await fixture(), output = run(f, [accounts(f)[0]]), row = output.rows[0];
  assert.equal(accounts(f).includes('R-LINKED-ONLY'), false);
  assert.deepEqual(row.accounts, [accounts(f)[0], 'R-LINKED-ONLY']);
  assert.equal(row.data.unresolved_link_count, 1);
  assert.ok(row.data.capability_gaps.includes('parcel_link_resolution_unavailable'));
  assert.ok(row.data.capability_gaps.includes('parcel_price_allocation_unavailable'));
  assert.equal(Object.hasOwn(row.data, 'allocated_price'), false);
  const capture = retained(f).acquisition.capture_result.source_capture;
  const expected = capture.sources.flatMap(source => source.payload.records
    .filter(record => ['transactions', 'sale_links'].includes(source.payload.projection.definition.role)
      && record.data.data.source_record_id === '10')
    .map(record => ({ source_ref: source.id, record_id: record.record_id })))
    .sort((a, b) => a.source_ref.localeCompare(b.source_ref) || a.record_id.localeCompare(b.record_id));
  assert.deepEqual(row.data.retained_source_references, expected);
  for (const source of capture.sources) assert.ok(source.id.endsWith(`:${hash(canonical(source.payload))}`));
});

test('canonical association selects a source without discarding its distinct original primary account', async () => {
  const f = await fixture({ extraTransactions: [extra(1, { primary_account_id: 'R-001' })] });
  const output = run(f, [accounts(f)[0]]), row = output.rows.find(row => row.data.source_record_id === '11');
  conserve(output, 2);
  assert.deepEqual(row.accounts, [accounts(f)[0], 'R-001']);
  assert.ok(row.data.capability_gaps.includes('canonical_source_account_conflict'));
  assert.equal(row.data.observations.reported_close_price.state, 'observed');
});

test('explicit empty and unrelated selections remain empty; source-less canonical rows are not invented as witnesses', async () => {
  const f = await fixture({ legacy: true });
  for (const selected of [[], [accounts(f)[1]]]) {
    const output = run(f, selected); empty(output);
    assert.equal(output.disposition_counts.outside_selection, 1);
    assert.equal(output.disposition_counts.legacy_source_record_unavailable, 1);
  }
  const output = run(f); conserve(output, 1);
  assert.equal(output.disposition_counts.legacy_source_record_unavailable, 1);
});

// Current SQL/reader permits only one canonical wrapper per source ID. These
// duplicate-wrapper cases exercise the pure consumer's defense on a detached
// graph, NOT owner admission, original hash proof or acquisition completeness.
function duplicateWrapper(f) {
  const input = structuredClone(retained(f)), capture = input.acquisition.capture_result.source_capture;
  const source = capture.sources.find(source => source.payload.projection.definition.role === 'transactions');
  const row = structuredClone(source.payload.records[0]);
  row.record_id = 'synthetic-second-wrapper:10';
  row.data.data.canonical_transaction_id = '21'; row.data.raw_projection.sale_id = '21';
  source.payload.records.push(row);
  const route = capture.references.find(route => route.record_sources.some(ref => ref.source_ref === source.id));
  route.record_sources.push({ source_ref: source.id, record_id: row.record_id });
  return { input, row };
}
test('pure consumer collapses equal-witness canonical wrappers to one source with complete references', async () => {
  const f = await fixture(), { input } = duplicateWrapper(f);
  const before = JSON.stringify(input), output = build({ retained_inputs: input, selected_account_ids: accounts(f) });
  conserve(output, 1);
  assert.deepEqual(output.rows[0].data.canonical_transaction_ids, ['20', '21']);
  assert.equal(output.rows[0].data.retained_source_references.length, 3);
  assert.equal(output.metrics.reported_close_price.observed_count, 1);
  assert.equal(JSON.stringify(input), before);
});

for (const key of ['ClosePrice', 'ClosePriceCurrency', 'LivingAreaUnits', 'CloseDate', 'MlsStatus', 'ListingId']) {
  test(`pure consumer refuses unequal complete source witnesses (${key}) rather than combining wrappers`, async () => {
    const f = await fixture(), { input, row } = duplicateWrapper(f), value_text = `different-${key}`;
    row.data.raw_projection.source_raw_witness.fields[key] = { state: 'scalar', json_type: 'string', value_text,
      utf8_bytes: Buffer.byteLength(value_text) };
    assert.throws(() => build({ retained_inputs: input, selected_account_ids: accounts(f) }), /source_witness_mismatch/);
    assert.throws(() => build({ retained_inputs: input, selected_account_ids: [] }), /source_witness_mismatch/,
      'a selection filter cannot excuse internally inconsistent original wrappers');
  });
}

test('fixed profile references bind every member and output without leaking unrelated raw witness fields', async () => {
  const f = await fixture({ rawPayload: payload({ ListingId: 'SYNTHETIC-DO-NOT-PRESENT', ModificationTimestamp: '2026-09-01T01:02:03Z' }) });
  const before = JSON.stringify(f.input), output = run(f), profile = getCustomCohortReportedSaleWitnessV2Profile();
  assert.equal(profile.definition_blob.ref.content_sha256, hash(profile.definition_blob.canonical_json));
  assert.equal(profile.profile_ref.content_sha256, profile.definition_blob.ref.content_sha256);
  assert.deepEqual(output.interpretation_profile_ref, profile.profile_ref);
  assert.deepEqual(output.rows[0].data.interpretation_profile_ref, profile.profile_ref);
  assert.equal(JSON.stringify(output).includes('SYNTHETIC-DO-NOT-PRESENT'), false);
  assert.equal(Object.hasOwn(output.rows[0].data, 'raw_fields'), false);
  frozen(output); assert.equal(JSON.stringify(f.input), before);
  assert.throws(() => { output.rows[0].data.observations.reported_close_price.unit = 'CAD'; }, TypeError);
  assert.deepEqual(run(f, [...accounts(f)].reverse()), output);
  assert.deepEqual(run(f), output, 'one invocation does not alter a later invocation');
});

test('explicit path retains original projection, scope, routing, selection and period refusals', async () => {
  const f = await fixture();
  assert.throws(() => run(f, ['UNKNOWN']), /selection/);
  assert.throws(() => run(f, [accounts(f)[0], accounts(f)[0]]), /selection/);
  for (const mutate of [
    input => { input.acquisition.capture_result.query_complete = false; },
    input => { input.spatial.query_complete = false; },
    input => { input.acquisition.capture_result.source_capture.scope.account_id = 'foreign'; },
    input => { input.acquisition.capture_result.source_capture.references = []; },
    input => { input.acquisition.captured_query_request.account_ids = []; },
    input => { input.study.observation_period.end_date = '2027-01-01'; },
    input => { const metadata = JSON.parse(input.acquisition.compact_metadata_json); metadata.mapping_version = 6;
      input.acquisition.compact_metadata_json = JSON.stringify(metadata); },
    input => { transactions(input)[0].data.raw_projection.source_raw_witness.witness_version = 1; },
  ]) {
    const input = structuredClone(retained(f)); mutate(input);
    assert.throws(() => build({ retained_inputs: input, selected_account_ids: accounts(f) }));
  }
});
