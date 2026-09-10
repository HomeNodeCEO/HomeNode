import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { createHash } from 'node:crypto';
import * as helpers from '../src/features/neighborhood/customCohortPrivateSales.ts';
import { checkCustomCohortSummaryResponse, createCustomCohortPreviewController, fingerprintCustomCohortSelection } from '../src/features/neighborhood/customCohortPreviewController.ts';
import { checkCustomCohortPocketCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { prepareAssignmentSalesCsv } from '../../server/src/services/assignmentSalesCsv/prepare.js';
import { digestPreparedSalesParts } from '../../server/src/services/assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../../server/src/services/assignmentSalesCsv/review.js';
import { buildCustomCohortPrivateSalesObservations, presentCustomCohortPrivateSalesObservations } from '../../server/src/services/neighborhoodAssessment/customCohortPrivateSales.js';

const uuid = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, clone = v => structuredClone(v);
const A = '00000000000000001', B = '00000000000000002', C = '00000000000000003';
const context = { context_id: uuid(1), context_revision: '1', context_sha256: 'a'.repeat(64) };
const period = { start_date: '2026-01-01', end_date: '2026-09-10' };
const inputFor = (revision = 1, accounts = [A]) => ({ accountId: A, assignmentFileId: '10', contextRef: context,
  selection: { revision, pockets: accounts.length ? [{ id: 'selected', label: 'Selected', account_ids: accounts }] : [] } });
const quote = text => /[",\n\r]/.test(String(text)) ? `"${String(text).replaceAll('"', '""')}"` : String(text);
// Real CSV preparation, exact digest and pure retained supplement/public
// projection. Synthetic source/reviewer identity is not production permission.
async function fixture({ records = [{}], decisions, interpretation = {}, input = inputFor() } = {}) {
  const defaults = { ListingId: 'S1', CloseDate: '2026-07-01', ClosePrice: '282500', CurrentPrice: '285000', ParcelNumber: A,
    County: 'Dallas', MlsStatus: 'Closed', LivingArea: '1800', LotSizeArea: '0.2', YearBuilt: '1985', DaysOnMarket: '12' };
  const actual = records.map((row, i) => ({ ...defaults, ListingId: `S${i + 1}`, ...row }));
  const headers = [...new Set([Object.keys(defaults), ...actual.map(Object.keys)].flat())];
  const csv = [headers, ...actual.map(row => headers.map(key => row[key] ?? ''))].map(row => row.map(quote).join(',')).join('\n');
  const { rows, ...header } = prepareAssignmentSalesCsv(Buffer.from(csv));
  const source = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, row_decisions: [], source_interpretation: {
    source_name: 'Synthetic private CSV', provenance_note: 'PRIVATE NOTE NOT PUBLIC', currency: 'USD', living_area_unit: 'sqft', site_area_unit: 'acre',
    consideration_field: 'close_price', marketing_time_field: 'days_on_market', source_use_confirmed: true, ...interpretation } }).source_interpretation;
  const supplement = { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1',
    target: { organization_id: uuid(2), report_file_id: uuid(3), assignment_file_id: '10', account_id: A },
    batch: { batch_id: uuid(4), source_sha256: header.source_sha256, preparation_sha256: digestPreparedSalesParts(header, rows) },
    review: { revision: 3, head_review_id: uuid(5), source_review_id: uuid(5) }, source_interpretation: source, captured_at: '2026-09-10T12:00:00.123456Z',
    rows: rows.map((record_data, i) => ({ receipt_id: uuid(100 + i), source_row_number: i + 2, record_data,
      review: decisions?.[i] === null || !['prepared', 'needs_review'].includes(record_data.preparation_disposition) ? null : {
        review_id: uuid(5), revision: 3, decision: 'confirm_proposed_match', account_ids: [A], note: 'PRIVATE ROW NOTE', ...decisions?.[i] } })) };
  const hash = await fingerprintCustomCohortSelection(input);
  const observations = buildCustomCohortPrivateSalesObservations({ supplement, context_ref: input.contextRef, effective_date: '2026-09-10',
    observation_period: period, selection: { revision: input.selection.revision, account_ids: [...new Set(input.selection.pockets.flatMap(p => p.account_ids))] } });
  const raw = presentCustomCohortPrivateSalesObservations({ observations, binding: { context_ref: input.contextRef, selection_revision: input.selection.revision, selection_sha256: hash } });
  return { raw, input, hash, checked: helpers.checkCustomCohortPrivateSales(raw, input, hash) };
}
function response(f, addon = true) {
  return { status: 'preview', target: { account_id: f.input.accountId, assignment_file_id: f.input.assignmentFileId }, context_ref: f.input.contextRef,
    selection_revision: f.input.selection.revision, subject_freshness: 'matched', summary: {
      presentation_version: 1, preview_version: 1, status: 'observations_only', members_included: false, contents: 'population_summaries_only',
      binding: { context_ref: f.input.contextRef, selection_revision: f.input.selection.revision, selection_sha256: f.hash },
      effective_date: '2026-09-10', observation_period: period, captured_at: '2026-09-10T11:59:00.000Z',
      all: {}, selected: {}, apply: { status: 'blocked', reasons: ['observation_preview_only'] } },
    parcel_map: { status: 'unavailable', reason: 'synthetic_geometry_unavailable', geojson: null,
      geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary' },
    apply: { status: 'blocked', reasons: ['observation_preview_only'] }, ...(addon ? { private_sales: f.raw } : {}) };
}
function catalogResponse(f) {
  return { ...response(f), status: 'catalog', catalog: { catalog_version: 1, status: 'review_only',
    binding: { context_ref: f.input.contextRef, selection_revision: f.input.selection.revision, selection_sha256: f.hash }, pockets: [],
    unassigned: { account_ids: [A, B], member_count: 2, reason_counts: [] },
    coverage: { discovery_member_count: 2, assigned_account_count: 0, unassigned_account_count: 2 },
    subject_membership: { account_id: A, assigned_pocket_id: null, status: 'unassigned', recorded_label_match_only: true },
    limitations: [], apply: { status: 'blocked' } } };
}
const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript'), React = requireRuntime('react');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
function compile(name, imports) {
  const file = new URL(`../src/features/neighborhood/components/${name}.tsx`, import.meta.url), module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Script(`(function(require,module,exports){${code}\n})`, { filename: file.pathname }).runInThisContext()(key => {
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    assert.ok(Object.hasOwn(imports, key), `Unexpected side-effect import ${key}`); return imports[key];
  }, module, module.exports); return module.exports;
}
const privateComponent = compile('CustomCohortPrivateSalesStatistics', { '../customCohortPrivateSales': helpers });
const Statistics = compile('CustomCohortStatistics', { './CustomCohortPrivateSalesStatistics': privateComponent }).default;
const render = (f, props = {}) => renderToStaticMarkup(React.createElement(Statistics, { group: checkCustomCohortSummaryResponse(response(f), f.input, f.hash), freshness: 'current', ...props }));

test('actual prepared retained CSV/public presenter passes the closed browser decoder, detached and frozen', async () => {
  const f = await fixture(), before = JSON.stringify(f.raw);
  assert.deepEqual(f.checked, f.raw); assert.notEqual(f.checked, f.raw); assert.ok(Object.isFrozen(f.checked.all.metrics.current_price));
  assert.equal(f.checked.selected.metrics.current_price.median, '285000'); assert.equal(f.checked.selected.metrics.close_price.median, '282500');
  assert.deepEqual(f.checked.limitations, helpers.PRIVATE_SALES_OBSERVATION_LIMITATIONS);
  assert.doesNotMatch(JSON.stringify(f.checked), /PRIVATE NOTE|PRIVATE ROW NOTE|raw_cells|"rows"|source_use_confirmed|provenance_note|receipt_id|account_ids/);
  assert.equal(JSON.stringify(f.raw), before);
});
test('exact larger-than-Number decimals display commas/two places, preserving thirteen-place median in title', async () => {
  const f = await fixture({ records: [{ ClosePrice: '9007199254740993.123456789012' }, { ClosePrice: '9007199254740993.123456789013' }] });
  assert.equal(f.checked.selected.metrics.close_price.median, '9007199254740993.1234567890125');
  const html = render(f); assert.match(html, /title="Exact reported statistic: 9007199254740993\.1234567890125"/);
  assert.match(html, />9,007,199,254,740,993\.12<\/td>/); assert.doesNotMatch(html, /9007199254740994/);
  assert.match(html, /CurrentPrice and ClosePrice remain separate/); assert.match(html, /No unit conversion, price allocation, CAD fallback/);
});
for (const [raw, display] of [[null, 'Unavailable'], ['0', '0'], ['0.004', '0'], ['0.005', '0.01'],
  ['999.999', '1,000'], ['282500', '282,500'], ['1990.5', '1,990.5'], ['9007199254740993.125', '9,007,199,254,740,993.13']])
  test(`exact string formatting ${raw} -> ${display}`, () => assert.equal(helpers.formatPrivateSalesObservedDecimal(raw), display));
test('year labels omit thousands grouping while preserving a fractional median', () => {
  assert.equal(helpers.formatPrivateSalesObservedDecimal('1990.5', false), '1990.5');
});
test('package and outside-discovery rows retain upload-wide vs selected denominators and no allocation', async () => {
  const f = await fixture({ records: [{ ClosePrice: '1000' }, { ClosePrice: '5000', ParcelNumber2: B }, { ClosePrice: '3000', ParcelNumber: C }],
    decisions: [{}, { account_ids: [A, B] }, { account_ids: [C] }] });
  assert.equal(f.checked.all.included_source_record_count, 3); assert.equal(f.checked.selected.included_source_record_count, 2);
  assert.equal(f.checked.selected.metrics.reported_transaction_price.median, '3000');
  assert.equal(f.checked.selected.metrics.reported_single_property_price.median, '1000');
  const html = render(f); assert.match(html, /including matches outside mapped discovery/); assert.match(html, /1 multi-account records only partly intersect/);
});
test('empty selection stays empty; inspector shows only its requested selected private population', async () => {
  const f = await fixture({ input: inputFor(2, []) }); assert.equal(f.checked.selected.included_source_record_count, 0);
  assert.equal(f.checked.all.included_source_record_count, 1);
  const html = render(f, { selectedOnly: true }); assert.match(html, /0 included source records/);
  assert.doesNotMatch(html, /All retained private observations|1 included source records/);
});
test('source names are React-escaped; no action or automatic analysis control is introduced', async () => {
  const f = await fixture({ interpretation: { source_name: '<img src=x onerror=alert(1)>' } }), html = render(f);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(html, /<img|<button|<input|<textarea/);
  assert.match(html, /cannot be applied to the report/); assert.match(html, /Old sales alone do not establish historical stock/);
});
test('unknown interpretation never defaults to USD/square feet or CurrentPrice as consideration', async () => {
  const f = await fixture({ interpretation: { currency: null, living_area_unit: null, site_area_unit: null, consideration_field: null, marketing_time_field: null } });
  assert.equal(f.checked.all.metrics.reported_transaction_price.unsupported_count, 1);
  const html = render(f); assert.match(html, /Unit not established/); assert.match(html, /Designated total: not established/);
  assert.match(html, /no field designated/); assert.doesNotMatch(html, /USD \(reviewer|sq ft \(reported/);
});
test('invalid, conflicting, missing and cumulative-DOM fields stay separated and visible', async () => {
  const f = await fixture({ records: [{ ClosePrice: 'invalid', CurrentPrice: '', LivingAreaUnits: 'sqm' }], interpretation: { marketing_time_field: 'cumulative_days_on_market' } });
  const m = f.checked.selected.metrics; assert.equal(m.close_price.invalid_count, 1); assert.equal(m.current_price.missing_count, 1);
  assert.equal(m.reported_living_area.conflicting_count, 1); assert.equal(m.reported_days_on_market.unsupported_count, 1);
  const html = render(f); assert.match(html, /1 invalid/); assert.match(html, /1 conflicting/); assert.match(html, /cumulative days on market is not retained/);
});
test('legacy absent addons keep exact checked shape; null or malformed presence is not silently dropped', async () => {
  const f = await fixture(), r = response(f, false), checked = checkCustomCohortSummaryResponse(r, f.input, f.hash);
  assert.deepEqual(Object.keys(checked).sort(), ['apply', 'binding', 'summary']);
  const c = catalogResponse(f); delete c.private_sales;
  assert.equal(Object.hasOwn(checkCustomCohortPocketCatalog(c, f.input), 'private_sales'), false);
  for (const invalid of [null, undefined, {}]) {
    assert.throws(() => checkCustomCohortSummaryResponse({ ...r, private_sales: invalid }, f.input, f.hash));
    assert.throws(() => checkCustomCohortPocketCatalog({ ...c, private_sales: invalid }, f.input));
  }
});
test('catalog retains the same checked context-bound summary without rendering it as active preview', async () => {
  const f = await fixture(), c = checkCustomCohortPocketCatalog(catalogResponse(f), f.input);
  assert.deepEqual(c.private_sales, f.raw); assert.ok(Object.isFrozen(c.private_sales));
});
for (const [label, mutate] of [
  ['foreign account', v => { v.binding.target.account_id = B; }], ['foreign assignment', v => { v.binding.target.assignment_file_id = '11'; }],
  ['context', v => { v.binding.context_ref.context_id = uuid(9); }], ['context hash', v => { v.binding.context_ref.context_sha256 = 'b'.repeat(64); }],
  ['selection revision', v => { v.binding.selection_revision++; }], ['selection hash', v => { v.binding.selection_sha256 = 'b'.repeat(64); }],
  ['batch digest', v => { v.binding.batch.source_sha256 = 'bad'; }], ['review zero', v => { v.binding.review.revision = 0; }],
  ['authority', v => { v.authority = 'verified'; }], ['Apply', v => { v.apply.status = 'ready'; }],
  ['source private note', v => { v.source_interpretation.provenance_note = 'private'; }], ['rows', v => { v.rows = []; }],
  ['unavailable date', v => { v.effective_date = '2026-02-30'; }], ['capture precision', v => { v.captured_at = '2026-09-10T12:00:00.123Z'; }],
  ['period reversal', v => { v.observation_period.start_date = '2027-01-01'; }],
  ['missing denominator', v => { delete v.selected.metrics.current_price.member_count; }],
  ['denominator', v => { v.selected.metrics.current_price.member_count++; }],
  ['count partition', v => { v.selected.metrics.current_price.missing_count++; }],
  ['negative count', v => { v.selected.metrics.close_price.invalid_count = -1; }],
  ['numeric price', v => { v.selected.metrics.current_price.median = 285000; }],
  ['decimal exponent', v => { v.selected.metrics.current_price.low = '2.85e5'; }],
  ['wrong median', v => { v.selected.metrics.current_price.median = '1'; }],
  ['unit mismatch', v => { v.selected.metrics.current_price.unit = 'CAD'; }],
  ['fake coverage', v => { v.all.included_source_record_count = 0; }],
  ['unknown disposition', v => { v.selected.disposition_counts.accepted = 0; }],
  ['sparse limitations', v => { delete v.limitations[0]; }], ['limitations extension', v => { v.limitations.extra = 'claim'; }],
]) test(`closed private summary refuses ${label}`, async () => {
  const f = await fixture(), raw = clone(f.raw); mutate(raw);
  assert.throws(() => helpers.checkCustomCohortPrivateSales(raw, f.input, f.hash), /invalid_custom_cohort_private_sales_summary/);
});
test('present-but-stale private dates reject the whole summary, independent capture clock is allowed', async () => {
  const f = await fixture(); assert.doesNotThrow(() => checkCustomCohortSummaryResponse(response(f), f.input, f.hash));
  for (const alter of [r => { r.summary.effective_date = '2026-09-11'; }, r => { r.summary.observation_period = { ...period, start_date: '2025-01-01' }; }]) {
    const r = response(f); alter(r); assert.throws(() => checkCustomCohortSummaryResponse(r, f.input, f.hash));
  }
});
test('descriptor-only admission rejects getters without executing private payload access', async () => {
  const f = await fixture(), raw = clone(f.raw); let invoked = 0;
  Object.defineProperty(raw.limitations, '0', { enumerable: true, get() { invoked++; return helpers.PRIVATE_SALES_OBSERVATION_LIMITATIONS[0]; } });
  assert.throws(() => helpers.checkCustomCohortPrivateSales(raw, f.input, f.hash)); assert.equal(invoked, 0);
});
test('unsupported currencies/fields cannot carry counterfeit observed metrics', async () => {
  const f = await fixture(), raw = clone(f.raw); raw.source_interpretation.consideration_field = null;
  assert.throws(() => helpers.checkCustomCohortPrivateSales(raw, f.input, f.hash));
});
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test('failed newer private response preserves preceding map/main/private group; old target completion is ignored', async () => {
  const calls = [], timers = new Map(); let id = 0;
  const controller = createCustomCohortPreviewController({ fingerprint: async text => createHash('sha256').update(text).digest('hex'),
    timer: { set(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clear(key) { timers.delete(key); } },
    transport: (request, { signal }) => new Promise(resolve => calls.push({ request, signal, resolve })) });
  const tick = async () => { for (const [key, item] of timers) if (item.ms === 250) { timers.delete(key); item.fn(); } await drain(); };
  const first = await fixture(); controller.setSelection(first.input); await tick(); calls[0].resolve(response(first)); await drain();
  const preceding = controller.getState().group; assert.ok(preceding.private_sales);
  const second = await fixture({ input: inputFor(2, []) }); controller.setSelection(second.input); await tick();
  const wrong = clone(response(second)); wrong.private_sales.binding.selection_sha256 = first.hash; calls[1].resolve(wrong); await drain();
  assert.equal(controller.getState().status, 'failed'); assert.equal(controller.getState().freshness, 'stale'); assert.equal(controller.getState().group, preceding);
  assert.match(render(first, { freshness: 'stale' }), /preceding CSV results remain with the preceding map/);
  controller.setSelection(inputFor(3, [])); await tick(); const call = calls.at(-1); controller.setSelection(null); call.resolve(response(second)); await drain();
  assert.equal(call.signal.aborted, true); assert.equal(controller.getState().group, null); controller.dispose();
});
