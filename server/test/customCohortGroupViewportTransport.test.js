import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortGroupViewportTransportRequest as prepare,
  presentCustomCohortGroupViewportTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortGroupViewportTransport.js';
import { selectionViewportFixture } from './fixtures/customCohortSelectionViewportFixture.js';

async function harness(t, { authenticated = true, enabled = true, parsed = false, respond, failure } = {}) {
  const f = await selectionViewportFixture(), calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003' };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy path')]));
  if (enabled) service.viewportRecordedGroupSelection = async (...args) => {
    calls.push(args); if (failure) throw failure; return respond ? respond(f) : f.result;
  };
  const app = express(); app.set('json spaces', 8);
  app.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) app.use(express.json({ limit: 10_000_000 }));
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (body = f.request) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/selection-viewport`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { ...f, calls, auth, post };
}

test('viewport syntax is closed and detached; neither a pan nor missing reference can replace membership', async () => {
  const f = await selectionViewportFixture(), original = structuredClone(f.request), r = prepare(f.request);
  f.request.viewport.west = -98; f.request.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64);
  assert.deepEqual(r, original); assert.ok(Object.isFrozen(r.viewport));
  for (const change of [{ selection_ref: null }, { viewport: { ...r.viewport, extra: 1 } }, { viewport: { ...r.viewport, north: Infinity } },
    { viewport: { ...r.viewport, east: r.viewport.west } }, { viewport: { ...r.viewport, east: r.viewport.west + 1.1 } },
    { account_ids: [] }, { included_recorded_group_ids: [] }, { auth: {} }, { source_rows: [] }])
    assert.throws(() => prepare({ ...r, ...change }), /invalid_input/);
  const accessor = Object.defineProperty({ ...r.viewport }, 'west', { enumerable: true, get() { assert.fail('getter'); } });
  assert.throws(() => prepare({ ...r, viewport: accessor }), /invalid_input/);
  assert.throws(() => prepare({ ...r, viewport: new Proxy(r.viewport, { getPrototypeOf() { assert.fail('proxy'); } }) }), /invalid_input/);
});

test('genuine exact projection keeps all captured counts and selected flags; clones, raw facts and foreign references are refused', async () => {
  const f = await selectionViewportFixture(), r = prepare(f.request), out = present(f.result, r, 'R-001');
  assert.equal(out.viewport_map.counts.captured_parcels, 3); assert.equal(out.viewport_map.counts.visible_parcels, 2);
  assert.deepEqual(out.viewport_map.geojson.features.map(p => p.properties.selected), [true, false]);
  assert.equal(f.summary.selected.account_count, 2, 'offscreen selected account stays in the whole analytical population');
  assert.ok(Object.isFrozen(out.viewport_map.geojson.features[0].geometry.coordinates[0]));
  for (const change of [{ authority: 'established' }, { status: 'applied' }, { source_rows: ['PRIVATE'] },
    { viewport_map: structuredClone(f.result.viewport_map) },
    { selection_ref: { ...r.selection_ref, manifest_ref: { ...r.selection_ref.manifest_ref, content_sha256: 'e'.repeat(64) } } }])
    assert.throws(() => present({ ...f.result, ...change }, r, 'R-001'), /invalid_response/);
  assert.throws(() => present(f.result, r, 'FOREIGN'), /invalid_response/);
  assert.throws(() => present(f.result, { ...r, viewport: { ...r.viewport, west: -97.006 } }, 'R-001'), /invalid_response/);
  const other = await selectionViewportFixture({ revision: 2 });
  assert.throws(() => present({ ...f.result, viewport_map: other.result.viewport_map }, r, 'R-001'), /invalid_response/);
  const empty = await selectionViewportFixture({ empty: true });
  assert.ok(present(empty.result, prepare(empty.request), 'R-001').viewport_map.geojson.features.every(p => !p.properties.selected));
});

test('optional authenticated display route uses exact identity, no-store and finite owner budget', async t => {
  const h = await harness(t), start = performance.now(), response = await h.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(h.result));
  assert.deepEqual(h.calls[0][0], { auth: h.auth, accountId: 'R-001', assignmentFileId: h.request.assignment_file_id,
    contextRef: h.request.context_ref, selectionRef: h.request.selection_ref, viewport: h.request.viewport });
  assert.ok(h.calls[0][1].signal instanceof AbortSignal);
  assert.ok(h.calls[0][1].deadline >= start + 60_000 && h.calls[0][1].deadline <= performance.now() + 60_000);
  const anonymous = await harness(t, { authenticated: false }); assert.equal((await anonymous.post()).status, 401);
  const old = await harness(t, { enabled: false }); assert.equal((await old.post()).status, 404);
});

test('member injection and UTF-8 request ceilings refuse before source I/O, including a pre-parsed body', async t => {
  for (const parsed of [false, true]) {
    const h = await harness(t, { parsed });
    for (const extra of [{ auth: {} }, { account_ids: [] }, { included_recorded_group_ids: [] }, { geometry: {} }])
      assert.equal((await h.post({ ...h.request, ...extra })).status, 400);
    assert.equal((await h.post({ ...h.request, viewport: 'é'.repeat(140_000) })).status, 413);
    assert.equal(h.calls.length, 0);
  }
});

test('stale, denied and interrupted display reads never leak raw output or become accepted report statistics', async t => {
  for (const [failure, status, error] of [
    [new TypeError('custom_cohort_group_selection_selection_changed'), 409, 'neighborhood_selection_changed'],
    [Object.assign(new Error('PRIVATE'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE'), { reason: 'cancelled' }), 503, 'neighborhood_request_interrupted'],
    [Object.assign(new Error('PRIVATE'), { reason: 'viewport_capacity_exceeded' }), 422, 'neighborhood_viewport_too_dense'],
  ]) {
    const h = await harness(t, { failure }), r = await h.post(); assert.equal(r.status, status);
    assert.deepEqual(await r.json(), { error });
  }
  const h = await harness(t, { respond: f => ({ ...f.result, private_rows: ['PRIVATE'] }) }), r = await h.post();
  assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'neighborhood_request_failed' });
});
