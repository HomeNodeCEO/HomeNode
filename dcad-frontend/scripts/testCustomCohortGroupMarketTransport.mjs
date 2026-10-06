import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortGroupMarketTransport as create, prepareCustomCohortGroupMarketWindow as window, checkCustomCohortGroupMarketResponse as check }
  from '../src/features/neighborhood/customCohortGroupMarketTransport.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { completeCalendarMonthWindow } from '../../server/src/services/marketConditions.js';
import { prepareCustomCohortRecordedGroupMarketRequest as serverRequest }
  from '../../server/src/services/neighborhoodAssessment/customCohortRecordedGroupMarketAnalysis.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const ref = { selection_version: 1, selection_revision: 7, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '1000' } };
const input = () => ({ accountId: 'R-001/#1', assignmentFileId: '9007199254740993',
  contextRef: structuredClone(context), selectionRef: structuredClone(ref), asOf: '2026-10-31', periodMonths: 12, contextOverride: null });
function response(value = input(), count = 3) {
  const period = completeCalendarMonthWindow(value.asOf, value.periodMonths);
  return { subject: { account_id: value.accountId }, analyses: [{ market: { key: 'exploration', scope: 'exploration' },
    period: { start: period.start, end: period.end }, population: { eligible_sale_count: count, mapped_sale_count: count },
    filters: { record_type: 'closed_sale', period_months: period.periodMonths, analysis_as_of: period.analysisAsOf,
      complete_calendar_months: true, partial_as_of_month_excluded: period.partialMonthExcluded },
    statistics: { reliability_score: null }, summary: {}, series: {}, map_sales: [] }],
    recommendation: { conclusion: count ? 'stable' : 'insufficient' }, unavailable_areas: [], independence_notice: 'Independent market study.',
    exploration_binding: { context_ref: structuredClone(value.contextRef), selection_revision: value.selectionRef.selection_revision,
      selection_sha256: value.selectionRef.selection_sha256 }, exploration_selection_ref: structuredClone(value.selectionRef) };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal });
const drain = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function harness(reply = () => json(response())) {
  const calls = [], paths = [];
  const run = create({ urlFor: p => { paths.push(p); return `https://example.invalid${p}`; },
    request: (url, init) => { calls.push({ url, init }); return reply(url, init); } });
  return { run, calls, paths };
}

test('exact market wire is accepted by the real server grammar, uses no-store/current signal and never uploads a member/viewport list', async () => {
  const h = harness(), options = io(), result = await h.run(input(), options);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.signal, options.signal);
  assert.equal(h.calls[0].init.method, 'POST'); assert.equal(h.calls[0].init.cache, 'no-store');
  assert.equal(h.paths[0], '/api/accounts/R-001%2F%231/neighborhood-cohort/selection-market-analysis');
  const body = JSON.parse(h.calls[0].init.body);
  assert.deepEqual(body, { assignment_file_id: input().assignmentFileId, context_ref: context, selection_ref: ref,
    area_keys: ['exploration'], as_of: '2026-10-31', period_months: 12, context_override: null });
  assert.deepEqual(serverRequest(body), body);
  assert.doesNotMatch(h.calls[0].init.body, /account_ids|included_recorded_group_ids|pockets|viewport|geometry/);
  assert.equal(Object.hasOwn(body, 'selection_sha256'), false, 'No fake legacy selection envelope');
  assert.deepEqual(result, response());
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.exploration_selection_ref.manifest_ref)
    && Object.isFrozen(result.analyses[0].filters));
});

test('chosen dates use the real complete-calendar-month semantics, independent of retained appraisal dates', async () => {
  for (const asOf of ['2024-02-29', '2024-02-28', '2026-10-31', '2026-10-06', '2020-01-01']) {
    for (const periodMonths of [12, 24, 36]) {
      const value = { ...input(), asOf, periodMonths }, h = harness(() => json(response(value)));
      const result = await h.run(value, io());
      assert.equal(result.analyses[0].filters.analysis_as_of, asOf);
      assert.equal(JSON.parse(h.calls[0].init.body).period_months, periodMonths);
    }
  }
});

test('an explicitly empty saved selection stays an insufficient empty study without another area request', async () => {
  const h = harness(() => json(response(input(), 0))), result = await h.run(input(), io());
  assert.equal(result.analyses[0].population.eligible_sale_count, 0); assert.equal(result.recommendation.conclusion, 'insufficient');
  assert.equal(h.calls.length, 1); assert.deepEqual(JSON.parse(h.calls[0].init.body).selection_ref, ref);
});

test('foreign, truncated or changed references, subjects, calendar periods and area keys cannot become a completed response', async () => {
  for (const change of [v => { v.subject.account_id = 'OTHER'; },
    v => { v.exploration_selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64); },
    v => { v.exploration_selection_ref.manifest_ref.canonical_utf8_bytes = '1001'; },
    v => { v.exploration_binding.context_ref.context_sha256 = 'd'.repeat(64); },
    v => { v.exploration_binding.selection_revision++; }, v => { v.exploration_binding.selection_sha256 = 'd'.repeat(64); },
    v => { delete v.exploration_selection_ref; }, v => { v.accountIds = ['A']; },
    v => { v.analyses[0].market.key = 'zip'; }, v => { v.analyses[0].market.scope = 'radius'; },
    v => { v.analyses.push(structuredClone(v.analyses[0])); }, v => { v.analyses = []; },
    v => { v.analyses[0].period.start = '2020-01-01'; }, v => { v.analyses[0].period.end = '2026-08-31'; },
    v => { v.analyses[0].filters.analysis_as_of = '2026-08-31'; }, v => { v.analyses[0].filters.period_months = 24; },
    v => { v.analyses[0].filters.record_type = 'listing'; }, v => { v.analyses[0].filters.partial_as_of_month_excluded = true; },
    v => { v.analyses[0].population.eligible_sale_count = -1; }, v => { v.analyses[0].population.mapped_sale_count = 4; },
    v => { v.unavailable_areas.push({ key: 'exploration' }); }, v => { v.recommendation = []; }]) {
    const h = harness(() => { const value = response(); change(value); return json(value); });
    await assert.rejects(h.run(input(), io()), /invalid_custom_cohort_group_market/); assert.equal(h.calls.length, 1);
  }
});

test('missing dates, unsafe/number IDs, invented selection fields, private authority and malformed override values fail before URL/network', async () => {
  const h = harness();
  for (const change of [{ accountId: '../ bad\u0000' }, { assignmentFileId: 15 }, { assignmentFileId: '9223372036854775808' },
    { selectionRef: null }, { selection: {} }, { viewport: {} }, { account_ids: [] }, { auth: {} },
    { asOf: '' }, { asOf: '2026-02-29' }, { asOf: '2026-10-31 ' }, { asOf: '0099-01-01' },
    { periodMonths: '12' }, { periodMonths: 13 }, { contextOverride: undefined }, { contextOverride: { source: 'other' } },
    { contextOverride: { source: 'manual', unknown: 'x' } }, { contextOverride: { source: 'manual', latitude: '32.1' } },
    { contextOverride: { source: 'manual', county: 'x'.repeat(1001) } }])
    await assert.rejects(h.run({ ...input(), ...change }, io()));
  let getters = 0;
  const values = [input(), input(), input(), input()];
  Object.defineProperty(values[0], 'contextRef', { enumerable: true, get() { getters++; return context; } });
  Object.defineProperty(values[1].selectionRef.manifest_ref, 'content_sha256', { enumerable: true, get() { getters++; return ref.manifest_ref.content_sha256; } });
  Object.defineProperty(values[2], 'asOf', { enumerable: true, get() { getters++; return '2026-10-31'; } });
  values[3].contextOverride = Object.defineProperty({ source: 'manual' }, 'city', { enumerable: true, get() { getters++; return 'Garland'; } });
  values.push({ ...input(), periodMonths: { valueOf() { getters++; return 12; } } },
    { ...input(), contextOverride: { source: { toString() { getters++; return 'manual'; } } } });
  for (const value of values) await assert.rejects(h.run(value, io()));
  assert.equal(getters, 0); assert.equal(h.calls.length, 0); assert.equal(h.paths.length, 0);
});

test('authentication settlement cannot rebind caller-mutated dates, target, exact original or overrides', async () => {
  let release; const h = harness(() => new Promise(resolve => { release = resolve; }));
  const value = input(); value.contextOverride = { source: 'manual', city: 'Garland', latitude: 32.9, longitude: -96.6 };
  const before = structuredClone(value), operation = h.run(value, io());
  value.accountId = 'OTHER'; value.assignmentFileId = '99'; value.asOf = '2020-01-01';
  value.selectionRef.manifest_ref.content_sha256 = 'd'.repeat(64); value.contextOverride.city = 'Changed';
  await drain(); release(json(response(before))); await operation;
  const body = JSON.parse(h.calls[0].init.body);
  assert.equal(body.as_of, before.asOf); assert.equal(body.context_override.city, 'Garland');
  assert.deepEqual(body.selection_ref, before.selectionRef); assert.equal(body.assignment_file_id, before.assignmentFileId);
  assert.equal(Object.isFrozen(value.contextOverride), false, 'The owner does not freeze caller state');
});

test('transport response is detached immutable JSON, not raw caller state or executable data', () => {
  assert.throws(() => window({ asOf: '2026-10-31', periodMonths: 12, contextOverride: null, extra: true }));
  const value = window({ asOf: '2026-10-31', periodMonths: 12, contextOverride: { source: 'dcad_related_parcel', source_account_id: 'A' } });
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.contextOverride));
  const raw = response(), admitted = check(raw, input()); raw.analyses[0].filters.period_months = 24;
  assert.equal(admitted.analyses[0].filters.period_months, 12); assert.equal(Object.isFrozen(raw), false);
  assert.equal(check(admitted, input()), admitted, 'A checked immutable receipt needs no second 4MB copy');
  assert.throws(() => check(admitted, { ...input(), contextOverride: { source: 'manual', city: 'Changed' } }));
  let getters = 0;
  const poisoned = response(); Object.defineProperty(poisoned.analyses[0].summary, 'price', { enumerable: true, get() { getters++; return 100; } });
  assert.throws(() => check(poisoned, input())); assert.equal(getters, 0);
  const bad = response(); bad.analyses[0].statistics.bad = Infinity;
  assert.throws(() => check(bad, input()));
  const sparse = response(); sparse.analyses[0].map_sales = new Array(2);
  assert.throws(() => check(sparse, input()));
});

test('aborted or delayed authentication settles cancellation once and cancels any late response body', async () => {
  const aborted = new AbortController(); aborted.abort(); const early = harness();
  await assert.rejects(early.run(input(), { signal: aborted.signal }), { name: 'AbortError' }); assert.equal(early.calls.length, 0);
  let release, cancelled = 0;
  const h = harness(() => new Promise(resolve => { release = resolve; })), controller = new AbortController();
  const running = h.run(input(), { signal: controller.signal }); await drain(); controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  release(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await drain(); assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});

test('the closed exact-market action keeps its 262144-byte request/4MB response ceiling and never opens arbitrary URLs', async () => {
  let requested = 0, routed = 0;
  const transport = createCustomCohortJsonTransport({ urlFor: p => { routed++; return p; },
    request: async () => { requested++; return json(response()); } });
  await assert.rejects(transport('A', 'selection-market-analysis', { x: 'a'.repeat(262144) }, io()), /too large/);
  await assert.rejects(transport('A', 'https://example.invalid', {}, io()), /Invalid neighborhood request/);
  assert.equal(requested, 0); assert.equal(routed, 0);
  for (const declared of [true, false]) {
    let cancelled = 0;
    const oversized = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(`"${'x'.repeat(4_000_000)}"`)); }, cancel() { cancelled++; },
    }), { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': '4000001' } : {}) } }) });
    await assert.rejects(oversized('A', 'selection-market-analysis', {}, io()), /too large/); assert.equal(cancelled, 1);
  }
});

test('current authorization errors remain sanitized server refusals, without a retry or legacy fallback', async () => {
  for (const [status, errorCode] of [[401, 'authentication_required'], [403, 'neighborhood_access_denied'],
    [409, 'neighborhood_workspace_changed'], [503, 'neighborhood_service_busy']]) {
    const h = harness(() => json({ error: errorCode }, status));
    await assert.rejects(h.run(input(), io()), err => err.status === status && err.errorCode === errorCode);
    assert.equal(h.calls.length, 1);
  }
});
