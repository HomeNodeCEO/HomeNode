import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomCohortMemberContinuation } from '../src/features/neighborhood/customCohortMemberPage.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { selectionMemberFixture } from '../../server/test/fixtures/customCohortSelectionMemberFixture.js';

const A = `recorded-cad:${'a'.repeat(64)}`;
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
async function harness({ respond, empty = false, accountCount = 3 } = {}) {
  const f = await selectionMemberFixture({ accountId: 'R-001/#1', empty, accountCount }), calls = [], abort = new AbortController();
  const transport = createCustomCohortRecordedGroupTransport({ urlFor: p => `https://example.invalid${p}`,
    request: async (url, init) => {
      calls.push({ url, init }); const r = JSON.parse(init.body);
      return respond ? respond(f, r) : json(f.resultFor(r.population, r.page));
    } });
  const saved = { status: 'selected', authority: 'not_established', context_ref: f.request.context_ref,
    selection_ref: f.request.selection_ref, included_recorded_group_ids: empty ? [] : [A] };
  const catalog = { binding: { context_ref: f.request.context_ref, selection_revision: 1 },
    pockets: [{ id: A, account_ids: f.accounts.slice(0, accountCount - 1) }],
    unassigned: { account_ids: f.accounts.slice(accountCount - 1) } };
  const input = (population = f.request.population, page = f.request.page) => ({ accountId: 'R-001/#1',
    assignmentFileId: f.request.assignment_file_id, contextRef: structuredClone(f.request.context_ref),
    selectionRef: structuredClone(f.request.selection_ref), population: structuredClone(population), page: structuredClone(page) });
  const expected = p => ({ ...p, total_count: p.kind === 'omitted_transactions'
    ? f.summary[p.group].transactions.omitted_inspection.total_count : f.summary[p.group][p.kind].inspection.total_count });
  const inspect = (r = input(), previous, receipt = saved, c = catalog, e = expected(r.population)) =>
    transport.members(r, receipt, c, e, { signal: abort.signal }, previous);
  return { ...f, calls, abort, saved, catalog, input, expected, inspect };
}

test('exact-reference member request carries only page syntax and preserves all/selected population totals', async () => {
  const h = await harness();
  for (const group of ['all', 'selected']) for (const kind of ['stock', 'transactions', 'omitted_transactions', 'source_reported']) {
    const r = h.input({ group, kind }), result = await h.inspect(r);
    assert.deepEqual(result.selection_ref, h.request.selection_ref);
    assert.equal(result.members.page.total_count, h.expected(r.population).total_count);
    assert.equal(result.members.page.returned_count, Math.min(1, result.members.page.total_count));
    assert.ok(Object.isFrozen(result.members.page));
    const call = h.calls.at(-1), sent = JSON.parse(call.init.body);
    assert.deepEqual(sent, { ...h.request, population: r.population, page: r.page });
    assert.ok(call.url.endsWith('/api/accounts/R-001%2F%231/neighborhood-cohort/selection-members'));
    assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.signal, h.abort.signal);
    assert.ok(new TextEncoder().encode(call.init.body).length < 1000);
    assert.doesNotMatch(call.init.body, /account_ids|included_recorded_group_ids|source_rows/);
  }
  const written = { ...h.saved, status: 'stored', operation_id: '70000000-0000-4000-8000-000000000009' };
  assert.equal((await h.inspect(h.input(), undefined, written)).members.page.total_count, 2);
});

test('101 real projections traverse exact compact continuation and refuse cloned/replayed/foreign predecessors', async () => {
  const h = await harness({ accountCount: 101 }), population = { group: 'all', kind: 'stock' };
  let r = h.input(population, { limit: 50, after_member_id: null }), previous, ids = [];
  do {
    const out = await h.inspect(r, previous); ids.push(...out.members.page.members.map(m => m.account_id));
    previous = { selection_ref: out.selection_ref, members: createCustomCohortMemberContinuation(out.members) };
    if (!out.members.page.has_more) break;
    r = h.input(population, { limit: 50, after_member_id: out.members.page.next_after_member_id });
  } while (true);
  assert.deepEqual(ids, h.accounts); assert.equal(new Set(ids).size, 101);
  const f = await h.inspect(h.input(population, { limit: 1, after_member_id: null }));
  const next = h.input(population, { limit: 1, after_member_id: f.members.page.next_after_member_id });
  await assert.rejects(h.inspect(next, structuredClone(f)), /invalid_custom_cohort_member_page/);
  await assert.rejects(h.inspect(next, { ...f, selection_ref: { ...f.selection_ref,
    manifest_ref: { ...f.selection_ref.manifest_ref, content_sha256: 'd'.repeat(64) } } }), /invalid_custom_cohort/);
  await assert.rejects(h.inspect(next), /invalid_custom_cohort/);
  const wrongPopulation = h.input({ group: 'selected', kind: 'stock' }, next.page);
  await assert.rejects(h.inspect(wrongPopulation, f), /Neighborhood preview request failed/);
});

test('reference, population, cursor, counts and lookup accounts detach before authenticated I/O', async () => {
  let complete; const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) }), r = h.input();
  const expected = h.expected(r.population), pending = h.inspect(r, undefined, h.saved, h.catalog, expected);
  r.population.group = 'all'; r.page.limit = 50; r.selectionRef.manifest_ref.content_sha256 = 'd'.repeat(64);
  h.saved.included_recorded_group_ids.length = 0; h.catalog.pockets[0].account_ids.length = 0; expected.total_count = 0;
  while (!complete) await Promise.resolve(); complete(json(h.result));
  assert.equal((await pending).members.page.total_count, 2);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request); assert.equal(h.calls.length, 1);
});

test('missing or malformed choices/page/expected total never obtain a token or fall back to all', async () => {
  const h = await harness(), r = h.input();
  for (const change of [{ selectionRef: null }, { account_ids: [] }, { includedRecordedGroupIds: [] },
    { population: { group: 'pocket', kind: 'stock', pocket_id: A } }, { page: { limit: 51, after_member_id: null } },
    { page: { limit: 1, after_member_id: 'PRIVATE' } }, { page: { limit: 1, after_member_id: null, extra: true } }])
    await assert.rejects(h.inspect({ ...r, ...change }, undefined, h.saved, h.catalog, h.expected(r.population)), /invalid_custom_cohort/);
  await assert.rejects(h.inspect(r, undefined, { ...h.saved, status: 'absent', selection_ref: null, included_recorded_group_ids: null }), /invalid_custom_cohort/);
  await assert.rejects(h.inspect(r, undefined, { ...h.saved, included_recorded_group_ids: [`recorded-cad:${'e'.repeat(64)}`] }), /invalid_custom_cohort/);
  await assert.rejects(h.inspect(r, undefined, h.saved, h.catalog, { group: 'selected', kind: 'stock', total_count: 1 }), /invalid_custom_cohort/);
  const accessor = Object.defineProperty({ ...r.page }, 'limit', { enumerable: true, get() { assert.fail('getter'); } });
  await assert.rejects(h.inspect({ ...r, page: accessor }), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 0);
});

test('wrong current reference, scope, totals, members, semantics and raw payload cannot be accepted', async () => {
  for (const change of [r => { r.authority = 'established'; }, r => { r.raw = 'PRIVATE'; },
    r => { r.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64); }, r => { r.target.assignment_file_id = '8'; },
    r => { r.context_ref.context_sha256 = 'd'.repeat(64); }, r => { r.selection_revision++; },
    r => { r.page.binding.selection_sha256 = 'd'.repeat(64); }, r => { r.page.members[0].account_id = 'FOREIGN'; },
    r => { r.page.total_count++; }, r => { r.page.start_index++; }, r => { r.page.members[0].raw = 'PRIVATE'; },
    r => { r.page.members[0].observations.year_built.value = Infinity; }, r => { r.apply.status = 'applied'; },
    r => { r.page.is_full_population = true; }, r => { r.private_sales = {}; }]) {
    const h = await harness({ respond: f => { const r = structuredClone(f.result); change(r); return json(r); } });
    await assert.rejects(h.inspect(), /invalid_custom_cohort/); assert.equal(h.calls.length, 1);
  }
  const empty = await harness({ empty: true }), out = await empty.inspect();
  assert.equal(out.members.page.total_count, 0); assert.deepEqual(out.members.page.members, []);
  assert.equal(out.members.page.is_full_population, true); assert.equal(out.members.page.has_more, false);
});

test('member transport retains 262144 request bytes and independently bounds the combined decoded page', async () => {
  let bytes = 2_360_000, calls = 0;
  const t = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => { calls++; return json({}, { 'content-length': String(bytes) }); } });
  const io = { signal: new AbortController().signal };
  assert.deepEqual(await t('R', 'selection-members', {}, io), {});
  bytes++; await assert.rejects(t('R', 'selection-members', {}, io), /too large/);
  await assert.rejects(t('R', 'selection-members', { extra: 'é'.repeat(140000) }, io), /too large/);
  assert.equal(calls, 2);
  const stream = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => json('é'.repeat(1_180_000)) });
  await assert.rejects(stream('R', 'selection-members', {}, io), /too large/);
});

test('caller cancellation ends hung authentication and cancels a late member body without retry', async () => {
  let complete, cancelled = 0;
  const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) }), pending = h.inspect();
  while (!complete) await Promise.resolve(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});
