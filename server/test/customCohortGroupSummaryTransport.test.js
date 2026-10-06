import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortGroupSummaryTransportRequest as prepare,
  presentCustomCohortGroupSummaryTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupTransport.js';
import { selectionSummaryTransportFixture } from './fixtures/customCohortSelectionSummaryTransportFixture.js';

async function app(t, { authenticated = true, enabled = true, parsed = false, respond, failure } = {}) {
  const f = await selectionSummaryTransportFixture(), calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003' };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy path called')]));
  if (enabled) service.previewRecordedGroupSelection = async (...args) => {
    calls.push(args); if (failure) throw failure; return respond ? respond(f) : f.result;
  };
  const application = express(); application.set('json spaces', 8);
  application.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) application.use(express.json({ limit: 10_000_000 }));
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {} }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (body = f.request) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/selection-preview`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { ...f, calls, auth, post };
}

test('exact-reference requests are closed, detached and immutable; null cannot become default all', async () => {
  const f = await selectionSummaryTransportFixture(), original = structuredClone(f.request), request = prepare(f.request);
  f.request.context_ref.context_sha256 = 'd'.repeat(64); f.request.selection_ref.manifest_ref.content_sha256 = 'e'.repeat(64);
  assert.deepEqual(request, original); assert.ok(Object.isFrozen(request.selection_ref.manifest_ref));
  for (const change of [{ selection_ref: null }, { selection_ref: { ...original.selection_ref, extra: true } },
    { selection_ref: { ...original.selection_ref, manifest_ref: { ...original.selection_ref.manifest_ref, extra: true } } },
    { auth: {} }, { included_recorded_group_ids: [] }, { selection: { pockets: [] } }, { source_rows: [] }, { include_map: true }])
    assert.throws(() => prepare({ ...original, ...change }), { message: 'invalid_input' });
  const accessor = Object.defineProperty(structuredClone(original.selection_ref), 'selection_revision',
    { enumerable: true, get() { assert.fail('accessor ran'); } });
  assert.throws(() => prepare({ ...original, selection_ref: accessor }), /invalid_input/);
  assert.throws(() => prepare(new Proxy(original, { getPrototypeOf() { assert.fail('proxy ran'); } })), /invalid_input/);
});

test('only actual bound public projections leave the numeric path; raw/cloned facts and geometry are refused', async () => {
  const f = await selectionSummaryTransportFixture(), request = prepare(f.request);
  const result = present(f.result, request, 'R-001');
  assert.deepEqual(result, f.result); assert.equal(result.summary.selected.account_count, 2);
  assert.equal(result.summary.all.account_count, 3); assert.ok(Object.isFrozen(result.apply.reasons));
  for (const change of [{ authority: 'established' }, { status: 'applied' }, { source_rows: ['PRIVATE'] },
    { summary: structuredClone(f.result.summary) }, { private_sales: { rows: ['PRIVATE'] } },
    { parcel_map: { status: 'available', geojson: { features: [] } } }, { apply: { status: 'ready', reasons: [] } },
    { target: { account_id: 'other', assignment_file_id: request.assignment_file_id } },
    { selection_ref: { ...f.result.selection_ref, manifest_ref: { ...f.result.selection_ref.manifest_ref, content_sha256: 'd'.repeat(64) } } },
    { selection_revision: 2 }, { subject_freshness: 'changed' }])
    assert.throws(() => present({ ...f.result, ...change }, request, 'R-001'), /invalid_response/);
  const foreign = await selectionSummaryTransportFixture({ revision: 2 });
  assert.throws(() => present({ ...f.result, summary: foreign.result.summary }, request, 'R-001'), /invalid_response/);
  const empty = await selectionSummaryTransportFixture({ revision: 2, empty: true });
  assert.equal(present(empty.result, prepare(empty.request), 'R-001').summary.selected.account_count, 0);
});

test('optional authenticated numeric route passes only exact identity and finite budget, without JSON expansion', async t => {
  const f = await app(t), before = performance.now(), response = await f.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(f.result));
  assert.deepEqual(f.calls[0][0], { auth: f.auth, accountId: 'R-001', assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selectionRef: f.request.selection_ref });
  assert.ok(f.calls[0][1].signal instanceof AbortSignal);
  assert.ok(f.calls[0][1].deadline >= before + 60_000 && f.calls[0][1].deadline <= performance.now() + 60_000);
  const anonymous = await app(t, { authenticated: false });
  assert.equal((await anonymous.post()).status, 401); assert.equal(anonymous.calls.length, 0);
  const old = await app(t, { enabled: false }); assert.equal((await old.post()).status, 404); assert.equal(old.calls.length, 0);
});

test('source/member/actor/geometry injection and oversized UTF-8 fail before owner work under either parser', async t => {
  for (const parsed of [false, true]) {
    const f = await app(t, { parsed });
    for (const extra of [{ auth: {} }, { actor_user_id: 'fake' }, { account_ids: [] }, { included_recorded_group_ids: [] },
      { selection: { pockets: [] } }, { source_rows: [] }, { include_map: true }]) {
      const r = await f.post({ ...f.request, ...extra }); assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'invalid_neighborhood_request' });
    }
    const large = await f.post({ ...f.request, selection_ref: 'é'.repeat(140_000) });
    assert.equal(large.status, 413); assert.deepEqual(await large.json(), { error: 'neighborhood_request_too_large' });
    assert.equal(f.calls.length, 0);
  }
});

test('refusal never discloses raw owner output; stale, access, capacity and cancellation remain distinct', async t => {
  for (const [failure, status, error] of [
    [new TypeError('custom_cohort_group_selection_selection_changed'), 409, 'neighborhood_selection_changed'],
    [Object.assign(new Error('PRIVATE'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [new TypeError('custom_cohort_recorded_group_owner_summary_account_limit'), 422, 'neighborhood_preview_capacity_exceeded'],
    [Object.assign(new Error('PRIVATE'), { reason: 'cancelled' }), 503, 'neighborhood_request_interrupted'],
  ]) {
    const f = await app(t, { failure }), r = await f.post(); assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error }); assert.equal(f.calls.length, 1);
  }
  const f = await app(t, { respond: f => ({ ...f.result, raw: 'PRIVATE' }) }), r = await f.post();
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'neighborhood_request_failed' });
});
