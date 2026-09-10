import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareAssignmentSalesCsv } from '../src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../src/services/assignmentSalesCsv/review.js';
import { prepareCustomCohortPrivateSalesSupplement as prepare, buildCustomCohortPrivateSalesObservations as build,
  presentCustomCohortPrivateSalesObservations as present, CUSTOM_COHORT_PRIVATE_SALES_PROFILE,
  CUSTOM_COHORT_PRIVATE_SALES_LIMITS } from '../src/services/neighborhoodAssessment/customCohortPrivateSales.js';

const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const A = '00000000000000001', B = '00000000000000002', C = '00000000000000003';
const context = { context_id: uuid(1), context_revision: '1', context_sha256: 'a'.repeat(64) };
const source = changes => validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, row_decisions: [],
  source_interpretation: { source_name: ' Synthetic export ', provenance_note: '', currency: 'USD', living_area_unit: 'sqft',
    site_area_unit: 'acre', consideration_field: 'close_price', marketing_time_field: 'days_on_market', source_use_confirmed: true, ...changes },
}).source_interpretation;
const quote = text => /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
function fixture({ records = [{}], decisions, interpretation = {} } = {}) {
  const defaults = { ListingId: 'S1', CloseDate: '2026-07-01', ClosePrice: '282500', CurrentPrice: '285000', ParcelNumber: A,
    County: 'Dallas', MlsStatus: 'Closed', LivingArea: '1800', LotSizeArea: '0.2', YearBuilt: '1985', DaysOnMarket: '12',
    SellerContributions: '0', BuyerFinancing: 'Conventional', StructuralStyle: 'Single Detached' };
  const actual = records.map((record, i) => ({ ...defaults, ListingId: `S${i + 1}`, ...record }));
  const headers = [...new Set([Object.keys(defaults), ...actual.map(Object.keys)].flat())];
  const csv = [headers, ...actual.map(row => headers.map(key => row[key] ?? ''))].map(row => row.map(quote).join(',')).join('\n');
  const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from(csv));
  return structuredClone({
    private_sales_capture_version: 1, profile_id: CUSTOM_COHORT_PRIVATE_SALES_PROFILE,
    target: { organization_id: uuid(2), report_file_id: uuid(3), assignment_file_id: '10', account_id: A },
    batch: { batch_id: uuid(4), source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: 1, head_review_id: uuid(5), source_review_id: uuid(5) },
    source_interpretation: source(interpretation), captured_at: '2026-09-10T12:00:00.123456Z',
    rows: rows.map((record_data, i) => ({ receipt_id: uuid(100 + i), source_row_number: i + 2, record_data,
      review: decisions ? decisions[i] === null ? null : { review_id: uuid(5), revision: 1, decision: 'confirm_proposed_match', account_ids: [A], note: '', ...decisions[i] }
        : ['prepared', 'needs_review'].includes(record_data.preparation_disposition)
          ? { review_id: uuid(5), revision: 1, decision: 'confirm_proposed_match', account_ids: [A], note: '' } : null })),
  });
}
const run = (supplement = fixture(), changes = {}) => build({ supplement, context_ref: context,
  effective_date: '2026-09-10', observation_period: { start_date: '2026-01-01', end_date: '2026-09-10' },
  selection: { revision: 1, account_ids: [A] }, ...changes });
const invalid = reason => ({ code: 'CUSTOM_COHORT_PRIVATE_SALES_INVALID', ...(reason ? { reason } : {}) });

test('real normalized closed CSV produces detached retained supplement and useful private observations', () => {
  const original = fixture(), admitted = prepare(original), result = run(original), metrics = result.selected.metrics;
  assert.deepEqual(admitted, original); assert.notEqual(admitted.rows[0].record_data, original.rows[0].record_data);
  assert.ok(Object.isFrozen(admitted.rows[0].record_data.raw_cells)); assert.ok(Object.isFrozen(admitted.source_interpretation));
  assert.equal(metrics.reported_transaction_price.low, '282500'); assert.equal(metrics.reported_transaction_price.median, '282500');
  assert.equal(metrics.reported_transaction_price.high, '282500'); assert.equal(metrics.reported_transaction_price.unit, 'USD');
  assert.equal(metrics.current_price.median, '285000'); assert.equal(metrics.close_price.median, '282500');
  assert.equal(metrics.reported_living_area.median, '1800'); assert.equal(metrics.reported_living_area.unit, 'sqft');
  assert.equal(metrics.reported_site_area.median, '0.2'); assert.equal(metrics.reported_site_area.unit, 'acre');
  assert.equal(metrics.reported_year_built.median, '1985'); assert.equal(metrics.reported_days_on_market.median, '12');
  assert.equal(result.status, 'observations_only'); assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.equal(result.selected.included_source_record_count, 1); assert.equal(result.selected.disposition_counts.included, 1);
  original.rows[0].record_data.values.living_area = '9999'; assert.equal(admitted.rows[0].record_data.values.living_area, '1800');
});

test('exact decimals larger than Number-safe range and half-fraction medians never round', () => {
  const result = run(fixture({ records: [{ ClosePrice: '9007199254740993.123456789012' }, { ClosePrice: '9007199254740993.123456789013' }] }));
  const m = result.selected.metrics.reported_transaction_price;
  assert.equal(m.low, '9007199254740993.123456789012'); assert.equal(m.high, '9007199254740993.123456789013');
  assert.equal(m.median, '9007199254740993.1234567890125'); assert.equal(m.count, 2);
});

test('all retained observations contribute to exact order statistics, without a top-30 target', () => {
  const result = run(fixture({ records: Array.from({ length: 101 }, (_, n) => ({ ClosePrice: String(1000 + n) })) }));
  assert.equal(result.rows.length, 101); assert.equal(result.selected.metrics.reported_transaction_price.count, 101);
  assert.equal(result.selected.metrics.reported_transaction_price.median, '1050');
});

test('package totals and single-account reported prices have separate denominators, preserving full sets', () => {
  const supplement = fixture({ records: [{ ClosePrice: '1000' }, { ClosePrice: '5000', ParcelNumber2: B }, { ClosePrice: '3000', ParcelNumber: C }],
    decisions: [{}, { account_ids: [A, B] }, { account_ids: [C] }] });
  const result = run(supplement, { selection: { revision: 5, account_ids: [A, C] } }), p = result.selected;
  assert.equal(p.included_source_record_count, 3); assert.equal(p.included_full_account_count, 3);
  assert.equal(p.partially_selected_full_account_set_count, 1); assert.equal(p.multi_account_source_record_count, 1);
  assert.equal(p.metrics.reported_transaction_price.median, '3000'); assert.equal(p.metrics.reported_transaction_price.member_count, 3);
  assert.equal(p.metrics.reported_single_property_price.median, '2000'); assert.equal(p.metrics.reported_single_property_price.member_count, 2);
  assert.deepEqual(result.rows[1].confirmed_account_ids, [A, B]); assert.ok(!('allocated_price' in result.rows[1]));
});

test('explicit empty and disjoint selections do not default to all captured matched rows', () => {
  const supplement = fixture();
  for (const account_ids of [[], [B]]) {
    const result = run(supplement, { selection: { revision: 2, account_ids } });
    assert.equal(result.selected.included_source_record_count, 0); assert.equal(result.selected.metrics.reported_transaction_price.median, null);
    assert.equal(result.all.included_source_record_count, 1); assert.equal(result.rows[0].disposition, 'outside_selection');
  }
});

test('same account union order has stable binding; context, revision and selected union remain distinct', () => {
  const a = run(fixture(), { selection: { revision: 2, account_ids: [A, B] } });
  const b = run(fixture(), { selection: { revision: 2, account_ids: [B, A] } });
  assert.deepEqual(a.binding, b.binding);
  const changed = run(fixture(), { selection: { revision: 3, account_ids: [A] }, context_ref: { ...context, context_id: uuid(9) } });
  assert.notEqual(a.binding.selected_account_set_sha256, changed.binding.selected_account_set_sha256);
  assert.notEqual(a.binding.context_ref.context_id, changed.binding.context_ref.context_id); assert.equal(changed.binding.selection_revision, 3);
});

test('CurrentPrice choice is explicit and does not rewrite ClosePrice or create a fallback', () => {
  const result = run(fixture({ interpretation: { consideration_field: 'current_price' } }));
  assert.equal(result.selected.metrics.reported_transaction_price.median, '285000');
  assert.equal(result.selected.metrics.close_price.median, '282500');
  const missing = run(fixture({ records: [{ ClosePrice: '' }] }));
  assert.equal(missing.selected.metrics.reported_transaction_price.median, null);
  assert.equal(missing.selected.metrics.reported_transaction_price.missing_count, 1);
  assert.equal(missing.selected.metrics.current_price.median, '285000');
  const unknown = run(fixture({ interpretation: { consideration_field: null } }));
  assert.equal(unknown.selected.metrics.reported_transaction_price.unsupported_count, 1);
});

test('zero DOM is observed and cumulative DOM remains unavailable rather than aliasing ordinary DOM', () => {
  const zero = run(fixture({ records: [{ DaysOnMarket: '0' }, { DaysOnMarket: '1' }] }));
  assert.equal(zero.selected.metrics.reported_days_on_market.low, '0'); assert.equal(zero.selected.metrics.reported_days_on_market.median, '0.5');
  for (const marketing_time_field of [null, 'cumulative_days_on_market']) {
    const result = run(fixture({ interpretation: { marketing_time_field } }));
    assert.equal(result.selected.metrics.reported_days_on_market.unsupported_count, 1);
    assert.equal(result.selected.metrics.reported_days_on_market.median, null);
  }
});

test('unknown currency and area units do not generate dollar/square-foot assumptions', () => {
  const result = run(fixture({ interpretation: { currency: null, living_area_unit: null, site_area_unit: null } }));
  for (const field of ['reported_transaction_price', 'current_price', 'close_price', 'reported_living_area', 'reported_site_area']) {
    assert.equal(result.selected.metrics[field].unit, null); assert.equal(result.selected.metrics[field].unsupported_count, 1);
    assert.equal(result.selected.metrics[field].median, null);
  }
});

test('compatible explicit units remain unconverted; conflicting row declarations block only their metric', () => {
  const result = run(fixture({ records: [{ LivingAreaUnits: 'Square Feet', LotSizeUnits: 'Acres', Currency: 'USD' },
    { LivingAreaUnits: 'sqm', LotSizeUnits: 'sqft', ClosePriceCurrency: 'CAD', CurrentPriceCurrency: 'USD' }] }));
  const metrics = result.selected.metrics;
  for (const field of ['reported_living_area', 'reported_site_area', 'reported_transaction_price', 'close_price']) {
    assert.equal(metrics[field].count, 1); assert.equal(metrics[field].conflicting_count, 1);
  }
  assert.equal(metrics.current_price.count, 2); assert.equal(metrics.reported_year_built.count, 2);
  const sqm = run(fixture({ interpretation: { living_area_unit: 'sqm', site_area_unit: 'sqm' },
    records: [{ LivingAreaUnits: 'square metres', LotSizeUnits: 'sq m' }] }));
  assert.equal(sqm.selected.metrics.reported_living_area.median, '1800'); assert.equal(sqm.selected.metrics.reported_living_area.unit, 'sqm');
});

test('unrecognized explicit units/currency are not silently ignored in favor of batch choices', () => {
  const result = run(fixture({ records: [{ LivingAreaUnits: 'unknown provider unit', PriceCurrency: '$' }] }));
  assert.equal(result.selected.metrics.reported_living_area.conflicting_count, 1);
  assert.equal(result.selected.metrics.reported_transaction_price.conflicting_count, 1);
});

test('invalid and absent measurements are neither zero-filled nor taken from current CAD', () => {
  const result = run(fixture({ records: [{ LivingArea: '0', LotSizeArea: '-1', ClosePrice: '-50', DaysOnMarket: '-1', YearBuilt: '2099' },
    { LivingArea: '', LotSizeArea: '', ClosePrice: '', DaysOnMarket: '', YearBuilt: '' }] }));
  for (const field of ['reported_transaction_price', 'reported_living_area', 'reported_site_area', 'reported_days_on_market', 'reported_year_built']) {
    const m = result.selected.metrics[field]; assert.equal(m.invalid_count, 1, field); assert.equal(m.missing_count, 1, field);
    assert.equal(m.count, 0); assert.equal(m.median, null);
  }
});

test('failed source normalization is counted invalid, not missing or zero', () => {
  const result = run(fixture({ records: [{ LivingArea: 'NaN', LotSizeArea: 'abc', ClosePrice: '1e6', DaysOnMarket: '0.5', YearBuilt: 'garbage' }] }));
  for (const field of ['reported_transaction_price', 'reported_living_area', 'reported_site_area', 'reported_days_on_market', 'reported_year_built']) {
    assert.equal(result.selected.metrics[field].invalid_count, 1, field);
    assert.equal(result.selected.metrics[field].missing_count, 0, field);
    assert.equal(result.selected.metrics[field].median, null, field);
  }
});

test('an older reported closing date can be observed after later upload without certifying historical stock', () => {
  const result = run(fixture({ records: [{ CloseDate: '2020-02-29' }] }), {
    effective_date: '2020-06-30', observation_period: { start_date: '2020-01-01', end_date: '2020-06-30' } });
  assert.equal(result.selected.included_source_record_count, 1); assert.equal(result.captured_at, '2026-09-10T12:00:00.123456Z');
  assert.ok(result.limitations.includes('historical_stock_not_established')); assert.equal(result.apply.status, 'blocked');
});

test('closed, nonclosed, unknown, undated, future and outside-period records retain their separate reasons', () => {
  const result = run(fixture({ records: [{}, { MlsStatus: 'Active' }, { MlsStatus: 'Sold?' }, { CloseDate: '' },
    { CloseDate: '2026-12-01' }, { CloseDate: '2025-12-01' }] }));
  assert.deepEqual(result.rows.map(row => row.disposition), ['included', 'nonclosed_listing', 'unknown_record_type',
    'closing_date_unavailable', 'future_closing_date', 'outside_observation_period']);
  assert.equal(result.selected.included_source_record_count, 1);
  assert.equal(Object.values(result.selected.disposition_counts).reduce((sum, n) => sum + n, 0), 6);
});

test('unreviewed, clear, and excluded records remain visible without contributing measurements', () => {
  const result = run(fixture({ records: [{}, {}, {}, {}], decisions: [null,
    { decision: 'clear', account_ids: [] }, { decision: 'exclude', account_ids: [], note: 'not used' }, {}] }));
  assert.deepEqual(result.rows.map(row => row.disposition), ['unreviewed', 'cleared', 'explicitly_excluded', 'included']);
  assert.equal(result.selected.metrics.reported_transaction_price.count, 1); assert.equal(result.rows.length, 4);
});

test('genuine preparation duplicates/conflicts remain in the roster and never contribute measurements', () => {
  const duplicate = fixture({ records: [{ ListingId: 'same' }, { ListingId: 'same' }] });
  assert.equal(duplicate.rows[1].record_data.preparation_disposition, 'duplicate');
  const d = run(duplicate); assert.equal(d.selected.metrics.reported_transaction_price.count, 1);
  assert.equal(d.rows[1].disposition, 'duplicate'); assert.equal(d.rows.length, 2);
  const conflict = run(fixture({ records: [{ ListingId: 'same', ClosePrice: '1000' }, { ListingId: 'same', ClosePrice: '2000' }] }));
  assert.equal(conflict.selected.included_source_record_count, 0); assert.deepEqual(conflict.rows.map(row => row.disposition), ['identity_conflict', 'identity_conflict']);
});

test('a complete zero-row capture stays empty, not absent', () => {
  const result = run(fixture({ records: [] }));
  assert.equal(result.all.retained_row_count, 0); assert.equal(result.selected.included_source_record_count, 0);
  assert.deepEqual(result.rows, []); assert.equal(result.selected.metrics.reported_transaction_price.median, null);
});

for (const [label, mutate] of [
  ['unknown profile', s => { s.profile_id = 'arbitrary-supported-profile'; }],
  ['version relabel', s => { s.private_sales_capture_version = 2; }],
  ['added authority', s => { s.supported = true; }],
  ['target extra key', s => { s.target.account_ids = [A]; }],
  ['invalid target UUID', s => { s.target.organization_id = 'other'; }],
  ['noncanonical assignment', s => { s.target.assignment_file_id = '01'; }],
  ['batch digest', s => { s.batch.source_sha256 = 'not-a-hash'; }],
  ['no source review', s => { s.review.source_review_id = null; }],
  ['zero review revision', s => { s.review.revision = 0; }],
  ['future row review', s => { s.rows[0].review.revision = 2; }],
  ['unsorted confirmed accounts', s => { s.rows[0].review.account_ids = [B, A]; }],
  ['duplicate confirmed accounts', s => { s.rows[0].review.account_ids = [A, A]; }],
  ['empty confirmation', s => { s.rows[0].review.account_ids = []; }],
  ['unconfirmed source use', s => { s.source_interpretation.source_use_confirmed = false; }],
  ['missing source choice', s => { delete s.source_interpretation.currency; }],
  ['unnormalized source name', s => { s.source_interpretation.source_name = ' not trimmed '; }],
  ['capture precision mismatch', s => { s.captured_at = '2026-09-10T12:00:00.123Z'; }],
  ['invalid calendar capture', s => { s.captured_at = '2026-09-31T12:00:00.123456Z'; }],
  ['row gap', s => { s.rows[0].source_row_number = 3; }],
  ['rewritten preparation flag', s => { s.rows[0].record_data.persisted = true; }],
  ['damaged raw cell hash', s => { s.rows[0].record_data.raw_cells[2] = '1'; }],
  ['unknown normalized value', s => { s.rows[0].record_data.values.eligible = true; }],
  ['number price instead of decimal', s => { s.rows[0].record_data.values.close_price = 282500; }],
  ['noncanonical decimal', s => { s.rows[0].record_data.values.close_price = '01.00'; }],
]) {
  test(`closed retained supplement rejects ${label}`, () => {
    const s = fixture(); mutate(s); assert.throws(() => prepare(s));
  });
}

test('getters/proxies/sparse arrays reject without executing accessors', () => {
  let invoked = 0; const s = fixture();
  Object.defineProperty(s.rows[0].record_data.values, 'close_price', { enumerable: true, get() { invoked++; return '999'; } });
  assert.throws(() => prepare(s), invalid()); assert.equal(invoked, 0);
  const proxy = new Proxy(fixture(), { ownKeys() { invoked++; return []; } });
  assert.throws(() => prepare(proxy), invalid()); assert.equal(invoked, 0);
  const sparse = fixture(); sparse.rows.length = 2; assert.throws(() => prepare(sparse), invalid());
});

test('oversized supplements and malformed selection bounds reject without truncating data', () => {
  const many = fixture(); many.rows = Array(CUSTOM_COHORT_PRIVATE_SALES_LIMITS.rows + 1).fill(many.rows[0]);
  assert.throws(() => prepare(many), invalid('array'));
  for (const selection of [{ revision: 0, account_ids: [A] }, { revision: 1, account_ids: [A, A] },
    { revision: 1, account_ids: [' bad '] }, { revision: 1, account_ids: [A], include_all: true }]) assert.throws(() => run(fixture(), { selection }));
});

test('all metric denominators account for every reported member, including unavailable values', () => {
  const r = run(fixture({ records: [{}, { ClosePrice: '', LivingArea: '0' }, { Currency: 'CAD', LivingAreaUnits: 'sqm' }] }));
  for (const group of [r.all, r.selected]) for (const m of Object.values(group.metrics)) {
    assert.equal(m.member_count, m.count + m.missing_count + m.invalid_count + m.conflicting_count + m.unsupported_count);
    assert.equal(m.count === 0, m.median === null);
  }
  assert.equal(JSON.stringify(r).includes('raw_cells'), false); assert.equal(JSON.stringify(r).includes('buyer_financing'), false);
});

const previewBinding = (changes = {}) => ({ context_ref: context, selection_revision: 1, selection_sha256: 'b'.repeat(64), ...changes });
test('public projection accepts every actual marketing-time basis without treating unavailable cumulative DOM as ordinary DOM', () => {
  for (const marketing_time_field of ['days_on_market', 'cumulative_days_on_market', null]) {
    const observations = run(fixture({ interpretation: { marketing_time_field }, records: [{ DaysOnMarket: '0' }] }));
    const output = present({ observations, binding: previewBinding() });
    for (const population of ['all', 'selected']) {
      const metric = output[population].metrics.reported_days_on_market;
      assert.deepEqual(metric, observations[population].metrics.reported_days_on_market);
      assert.equal(metric.median, marketing_time_field === 'days_on_market' ? '0' : null);
      assert.equal(metric.unsupported_count, marketing_time_field === 'days_on_market' ? 0 : 1);
      assert.equal(metric.basis, marketing_time_field === 'cumulative_days_on_market'
        ? 'cumulative_days_on_market_not_retained_by_v1_preparation' : 'reviewer_designated_source_days_on_market');
    }
    assert.equal(output.apply.status, 'blocked');
  }
});

test('public projection admits only the fixed basis vocabulary for each metric', () => {
  for (const basis of ['unrecognized_basis_v1', 'reviewer_designated_source_days_on_market']) {
    const observations = structuredClone(run()); observations.all.metrics.close_price.basis = basis;
    assert.throws(() => present({ observations, binding: previewBinding() }), invalid('presentation'));
  }
});

test('public projection preserves exact aggregates and coherent preview binding without member/receipt/provenance data', () => {
  const observations = run(fixture({ interpretation: { provenance_note: 'PRIVATE PROVENANCE' }, decisions: [{ account_ids: [A, B] }] }));
  const output = present({ observations, binding: previewBinding() });
  assert.deepEqual(output.all, observations.all); assert.deepEqual(output.selected, observations.selected);
  assert.equal(output.binding.selection_sha256, 'b'.repeat(64));
  assert.equal(output.binding.selected_account_set_sha256, observations.binding.selected_account_set_sha256);
  assert.equal(output.binding.batch.batch_id, observations.binding.batch.batch_id);
  assert.deepEqual(Object.keys(output.source_interpretation).sort(), ['source_name', 'currency', 'living_area_unit',
    'site_area_unit', 'consideration_field', 'marketing_time_field'].sort());
  const text = JSON.stringify(output);
  for (const privateKey of ['rows', 'raw_cells', 'confirmed_account_ids', 'receipt_id', 'provenance_note', 'source_use_confirmed']) assert.equal(Object.hasOwn(output, privateKey), false);
  assert.equal(text.includes('PRIVATE PROVENANCE'), false); assert.equal(text.includes(B), false);
  assert.ok(Object.isFrozen(output.selected.metrics.reported_transaction_price));
});

test('public projection rejects another context/revision and malformed binding without changing observations', () => {
  const observations = run();
  for (const binding of [previewBinding({ context_ref: { ...context, context_sha256: 'f'.repeat(64) } }),
    previewBinding({ selection_revision: 2 }), previewBinding({ selection_sha256: 'invalid' }), previewBinding({ extra: true })]) {
    assert.throws(() => present({ observations, binding }));
  }
  assert.equal(observations.binding.selection_revision, 1); assert.equal(Object.hasOwn(observations.binding, 'selection_sha256'), false);
});

test('public projection cannot leak newly added internal population, metric, source or binding fields', () => {
  for (const mutate of [value => { value.all.account_ids = [A]; }, value => { value.all.metrics.close_price.raw_cells = ['private']; },
    value => { value.all.metrics.close_price.low = { raw_cells: ['private'] }; }, value => { value.binding.target.raw_cells = ['private']; },
    value => { value.source_interpretation.private_note = 'private'; }, value => { value.binding.raw_records = ['private']; },
    value => { value.all.disposition_counts.private_note = 'private'; }]) {
    const observations = structuredClone(run()); mutate(observations);
    assert.throws(() => present({ observations, binding: previewBinding() }));
  }
});

test('public projection ignores omitted member arrays without reading them; getters on public fields reject', () => {
  let invoked = 0;
  const observations = structuredClone(run());
  observations.rows = new Proxy([], { ownKeys() { invoked++; throw new Error('private rows must not be read'); } });
  assert.equal(present({ observations, binding: previewBinding() }).selected.included_source_record_count, 1);
  assert.equal(invoked, 0);
  Object.defineProperty(observations.selected.metrics.close_price, 'median', { enumerable: true, get() { invoked++; return '1'; } });
  assert.throws(() => present({ observations, binding: previewBinding() })); assert.equal(invoked, 0);
});

test('public projection retains explicit empty selection and blocks false ready/apply claims', () => {
  const observations = run(fixture(), { selection: { revision: 7, account_ids: [] } });
  const output = present({ observations, binding: previewBinding({ selection_revision: 7 }) });
  assert.equal(output.selected.included_source_record_count, 0); assert.equal(output.all.included_source_record_count, 1);
  for (const mutate of [value => { value.status = 'ready'; }, value => { value.authority = 'established'; },
    value => { value.apply.status = 'ready'; }, value => { value.apply.reasons = []; }]) {
    const changed = structuredClone(observations); mutate(changed);
    assert.throws(() => present({ observations: changed, binding: previewBinding({ selection_revision: 7 }) }));
  }
});
