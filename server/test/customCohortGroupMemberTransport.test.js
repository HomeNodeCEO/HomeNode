import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortGroupMemberTransportRequest as prepare,
  presentCustomCohortGroupMemberTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortGroupMemberTransport.js';
import { selectionMemberFixture } from './fixtures/customCohortSelectionMemberFixture.js';

async function harness(t, { authenticated = true, enabled = true, parsed = false, respond, failure } = {}) {
  const f = await selectionMemberFixture(), calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003' };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy path')]));
  if (enabled) service.inspectRecordedGroupSelection = async (...args) => {
    calls.push(args); if (failure) throw failure; return respond ? respond(f) : f.result;
  };
  const app = express(); app.set('json spaces', 8);
  app.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) app.use(express.json({ limit: 10_000_000 }));
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (body = f.request) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/selection-members`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { ...f, calls, auth, post };
}

test('member syntax is closed and detached; inspection/cursor cannot replace the whole selected union', async () => {
  const f = await selectionMemberFixture(), original = structuredClone(f.request), r = prepare(f.request);
  f.request.page.limit = 50; f.request.population.group = 'all'; f.request.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64);
  assert.deepEqual(r, original); assert.ok(Object.isFrozen(r.page));
  for (const change of [{ selection_ref: null }, { population: { group: 'pocket', kind: 'stock', pocket_id: 'discovery:selected' } },
    { population: { group: 'selected', kind: 'raw' } }, { page: { limit: 51, after_member_id: null } },
    { page: { limit: 1, after_member_id: 'canonical:PRIVATE' } }, { page: { limit: 1, after_member_id: null, offset: 1 } },
    { account_ids: [] }, { source_rows: [] }, { auth: {} }]) assert.throws(() => prepare({ ...r, ...change }), /invalid_input/);
  const accessor = Object.defineProperty({ ...r.page }, 'limit', { enumerable: true, get() { assert.fail('getter'); } });
  assert.throws(() => prepare({ ...r, page: accessor }), /invalid_input/);
  assert.throws(() => prepare({ ...r, page: new Proxy(r.page, { getPrototypeOf() { assert.fail('proxy'); } }) }), /invalid_input/);
});

test('genuine page retains exact totals and continuation without private IDs, raw facts or report authority', async () => {
  const f = await selectionMemberFixture(), r = prepare(f.request), out = present(f.result, r, 'R-001');
  assert.equal(out.page.total_count, 2); assert.equal(out.page.returned_count, 1); assert.equal(out.page.has_more, true);
  assert.ok(Object.isFrozen(out.page.members[0]));
  const next = { limit: 1, after_member_id: out.page.next_after_member_id };
  const second = present(f.resultFor(r.population, next), prepare({ ...r, page: next }), 'R-001');
  assert.equal(second.page.start_index, 1); assert.equal(second.page.has_more, false);
  for (const change of [{ authority: 'established' }, { source_rows: ['PRIVATE'] }, { page: structuredClone(f.result.page) },
    { private_sales: {} }, { selection_ref: { ...r.selection_ref, manifest_ref: { ...r.selection_ref.manifest_ref, content_sha256: 'd'.repeat(64) } } }])
    assert.throws(() => present({ ...f.result, ...change }, r, 'R-001'), /invalid_response/);
  assert.throws(() => present(f.result, r, 'FOREIGN'), /invalid_response/);
  assert.throws(() => present(f.result, { ...r, population: { group: 'all', kind: 'stock' } }, 'R-001'), /invalid_response/);
  assert.throws(() => present(f.result, { ...r, page: { ...r.page, limit: 2 } }, 'R-001'), /invalid_response/);
  assert.throws(() => present(f.result, { ...r, page: { ...r.page, after_member_id: out.page.next_after_member_id } }, 'R-001'), /invalid_response/);
  const empty = await selectionMemberFixture({ empty: true });
  assert.equal(present(empty.result, prepare(empty.request), 'R-001').page.total_count, 0);
  assert.equal(empty.result.page.is_full_population, true);
});

test('optional current-authenticated member route keeps no-store, exact identity and finite budget', async t => {
  const h = await harness(t), start = performance.now(), response = await h.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(h.result));
  assert.deepEqual(h.calls[0][0], { auth: h.auth, accountId: 'R-001', assignmentFileId: h.request.assignment_file_id,
    contextRef: h.request.context_ref, selectionRef: h.request.selection_ref, population: h.request.population, page: h.request.page });
  assert.ok(h.calls[0][1].signal instanceof AbortSignal);
  assert.ok(h.calls[0][1].deadline >= start + 60_000 && h.calls[0][1].deadline <= performance.now() + 60_000);
  const anon = await harness(t, { authenticated: false }); assert.equal((await anon.post()).status, 401);
  const old = await harness(t, { enabled: false }); assert.equal((await old.post()).status, 404);
});

test('member injection and decoded UTF-8 request cap refuse before source I/O even on a pre-parsed body', async t => {
  for (const parsed of [false, true]) {
    const h = await harness(t, { parsed });
    for (const extra of [{ auth: {} }, { account_ids: [] }, { included_recorded_group_ids: [] }, { geometry: {} }])
      assert.equal((await h.post({ ...h.request, ...extra })).status, 400);
    assert.equal((await h.post({ ...h.request, page: 'é'.repeat(140_000) })).status, 413);
    assert.equal(h.calls.length, 0);
  }
});

test('stale, independently denied and interrupted inspections never leak raw errors or become a report', async t => {
  for (const [failure, status, error] of [
    [new TypeError('custom_cohort_group_selection_selection_changed'), 409, 'neighborhood_selection_changed'],
    [Object.assign(new Error('PRIVATE'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE'), { reason: 'cancelled' }), 503, 'neighborhood_request_interrupted'],
  ]) {
    const h = await harness(t, { failure }), r = await h.post(); assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error });
  }
  const h = await harness(t, { respond: f => ({ ...f.result, raw: 'PRIVATE' }) }), r = await h.post();
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'neighborhood_request_failed' });
});
