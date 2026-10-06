import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMemberViewFixture as fixture, memberView, json, io } from './customCohortGroupMemberViewFixture.mjs';
import { createCustomWorkspaceRequestLane } from '../src/features/neighborhood/customWorkspaceRequestLane.ts';

test('selected inspection uses the same display receipt and all four complete summary descriptors, with no flat selection or local hash', async () => {
  const f = await fixture(), view = memberView.prepareCustomCohortGroupMemberView(f.display), before = f.display.observations;
  assert.equal(view, memberView.prepareCustomCohortGroupMemberView(f.display)); assert.ok(Object.isFrozen(view));
  for (const kind of ['stock', 'transactions', 'omitted_transactions', 'source_reported']) {
    const options = io(), page = { limit: 50, after_member_id: null };
    const result = await f.reader(f.display, kind, page, options);
    assert.equal(result.members.page.total_count, view[kind].total_count);
    assert.deepEqual(result.members.page.population, { group: 'selected', kind });
    assert.ok(Object.isFrozen(result.members.page));
    const sent = f.calls.at(-1);
    assert.deepEqual(sent.body, { ...f.request, population: { group: 'selected', kind }, page });
    assert.equal(sent.signal, options.signal);
    assert.doesNotMatch(JSON.stringify(sent.body), /account_ids|included_recorded_group_ids|operation_id|source_rows/);
  }
  assert.equal(f.display.observations, before); assert.equal(before.summary.all.account_count, 3);
});

test('101 selected accounts page exactly with decoder-owned compact predecessors and refetched Back', async () => {
  const f = await fixture({ accountCount: 102 }), page = { limit: 50, after_member_id: null }, seen = [];
  let next = page, previous;
  do {
    const result = await f.reader(f.display, 'stock', next, io(), previous);
    seen.push(...result.members.page.members.map(m => m.account_id));
    previous = memberView.createCustomCohortGroupMemberViewContinuation(result);
    assert.ok(Object.isFrozen(previous)); assert.equal(Object.hasOwn(previous.members, 'page'), false);
    if (!result.members.page.has_more) break;
    next = { limit: 50, after_member_id: result.members.page.next_after_member_id };
  } while (true);
  assert.deepEqual(seen, f.selected); assert.equal(new Set(seen).size, 101);
  const first = await f.reader(f.display, 'stock', page, io());
  assert.deepEqual(first.members.page.members.map(m => m.account_id), seen.slice(0, 50));
});

test('invalid display clones, kind/page/deadline and forged continuation fail before request admission', async () => {
  const f = await fixture(), p = { limit: 1, after_member_id: null };
  for (const display of [null, structuredClone(f.display), f.result]) await assert.rejects(f.reader(display, 'stock', p, io()));
  for (const kind of ['unknown', null]) await assert.rejects(f.reader(f.display, kind, p, io()));
  for (const options of [{ ...io(), deadline: NaN }, { ...io(), deadline: 0 }, { ...io(), signal: null }])
    await assert.rejects(f.reader(f.display, 'stock', p, options));
  for (const page of [{ limit: 51, after_member_id: null }, { ...p, extra: true }, { limit: 1, after_member_id: 'raw-record' }])
    await assert.rejects(f.reader(f.display, 'stock', page, io()));
  assert.equal(f.calls.length, 2);
  const first = await f.reader(f.display, 'stock', p, io()), next = { limit: 1, after_member_id: first.members.page.next_after_member_id };
  const prior = memberView.createCustomCohortGroupMemberViewContinuation(first), count = f.calls.length;
  await assert.rejects(f.reader(f.display, 'stock', next, io(), structuredClone(prior)));
  await assert.rejects(f.reader(f.display, 'stock', next, io(), { ...prior, selection_ref: { ...prior.selection_ref, selection_revision: 2 } }));
  assert.equal(f.calls.length, count);
});

test('deliberate empty stays the exact selected empty population and never silently requests all', async () => {
  const f = await fixture({ empty: true }), view = memberView.prepareCustomCohortGroupMemberView(f.display);
  assert.ok(Object.values(view).every(p => p.total_count === 0));
  const result = await f.reader(f.display, 'stock', { limit: 50, after_member_id: null }, io());
  assert.equal(result.members.page.total_count, 0); assert.deepEqual(result.members.page.members, []);
  assert.equal(f.calls.at(-1).body.population.group, 'selected'); assert.equal(f.display.observations.summary.all.account_count, 3);
});

test('foreign reference, count, account, period and private aggregate are never substituted into a checked page', async () => {
  for (const change of [r => { r.selection_ref.selection_revision++; }, r => { r.page.total_count++; },
    r => { r.page.members[0].account_id = 'FOREIGN'; }, r => { r.page.observation_period.end_date = '2024-06-29'; },
    r => { r.private_sales.binding.target.account_id = 'FOREIGN'; }]) {
    const f = await fixture({ privateSales: true, respond: (f, body) => { const r = structuredClone(f.resultFor(body.population, body.page)); change(r); return json(r); } });
    await assert.rejects(f.reader(f.display, 'stock', { limit: 50, after_member_id: null }, io()));
    assert.equal(f.calls.length, 3); assert.equal(f.display.observations.summary.selected.account_count, 2);
  }
});

test('read-only max revision/int64 and genuine private aggregate keep exact receipt without exposing raw rows', async () => {
  const f = await fixture({ privateSales: true, assignmentFileId: '9223372036854775807', revision: 2147483647 });
  const result = await f.reader(f.display, 'stock', { limit: 1, after_member_id: null }, io());
  assert.deepEqual(result.members.private_sales, f.result.private_sales);
  assert.equal(f.calls.at(-1).body.assignment_file_id, '9223372036854775807');
  assert.equal(f.calls.at(-1).body.selection_ref.selection_revision, 2147483647);
  assert.equal(Object.hasOwn(result.members.private_sales, 'rows'), false);
});

test('current auth/conflict/source refusal is one explicit request, with no retry or broader population', async () => {
  for (const [status, error] of [[401, 'authentication_required'], [403, 'neighborhood_access_denied'],
    [409, 'neighborhood_workspace_changed'], [503, 'neighborhood_service_busy']]) {
    const f = await fixture({ respond: () => json({ error }, status) });
    await assert.rejects(f.reader(f.display, 'stock', { limit: 50, after_member_id: null }, io()));
    assert.equal(f.calls.length, 3);
  }
});

test('an ignored member cancellation retains the caller lane until actual settlement and cannot publish late records', async () => {
  let settle, entered; const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(), read = f.readerFrom(async () => { entered(); return new Promise(resolve => { settle = resolve; }); });
  const lane = createCustomWorkspaceRequestLane(), abort = new AbortController();
  const pending = lane.run(({ signal }) => read(f.display, 'stock', { limit: 50, after_member_id: null }, { signal, deadline: performance.now() + 65000 }),
    { signal: abort.signal, timeoutMs: 65000 });
  await started; abort.abort(); await assert.rejects(pending);
  assert.equal(lane.isIdle(), false); let flushed = false; const flush = lane.flush().then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  settle(json(f.resultFor({ group: 'selected', kind: 'stock' }, { limit: 50, after_member_id: null })));
  await flush; assert.equal(lane.isIdle(), true); lane.dispose();
});
