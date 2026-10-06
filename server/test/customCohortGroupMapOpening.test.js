import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { presentCustomCohortGroupMapOpening as project, prepareCustomCohortGroupMapOpeningTransportRequest as prepare,
  presentCustomCohortGroupMapOpeningTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';
import { selectionMapOpeningFixture } from './fixtures/customCohortSelectionMapOpeningFixture.js';

async function harness(t, { authenticated = true, enabled = true, parsed = false, respond, failure } = {}) {
  const f = await selectionMapOpeningFixture(), calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003' };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy route')]));
  if (enabled) service.openRecordedGroupSelectionMap = async (...args) => {
    calls.push(args); if (failure) throw failure; return respond ? respond(f) : f.result;
  };
  const app = express(); app.set('json spaces', 8);
  app.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) app.use(express.json({ limit: 10_000_000 }));
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (body = f.request) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/${f.accountId}/neighborhood-cohort/selection-map-opening`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { ...f, calls, auth, post };
}

test('exact opening keeps whole bounds, every label and subject anchor independently of nonempty or empty choices', async () => {
  const f = await selectionMapOpeningFixture(), empty = await selectionMapOpeningFixture({ empty: true, revision: 2 });
  assert.deepEqual(f.result.map_opening.manifest, empty.result.map_opening.manifest);
  const out = present(f.result, prepare(f.request), f.accountId);
  assert.equal(out.map_opening.manifest.labels.features.length, 2);
  assert.equal(out.map_opening.manifest.subject_parcels.length, 1);
  assert.equal(out.map_opening.manifest.counts.captured_accounts, 3);
  assert.equal(Object.hasOwn(out, 'summary'), false); assert.equal(Object.hasOwn(out, 'account_ids'), false);
  assert.ok(Object.isFrozen(out.map_opening.manifest.labels.features[0].geometry.coordinates));
  f.projection.manifest.labels.features[0].properties.label = 'mutated later';
  assert.equal(out.map_opening.manifest.labels.features[0].properties.label, 'One');
});

test('public shape is closed and whole catalog binding is checked; partial/foreign/raw/malformed displays refuse', async () => {
  const f = await selectionMapOpeningFixture();
  for (const mutate of [m => { m.raw = 'PRIVATE'; }, m => { m.labels.features.pop(); }, m => { m.counts.captured_accounts--; },
    m => { m.subject_parcels = []; }, m => { m.labels.features[0].properties.account_id = 'FOREIGN'; },
    m => { m.labels.features[0].properties.label = 'Wrong'; }, m => { m.labels.features[0].properties.raw = 'PRIVATE'; },
    m => { m.subject_parcels[0].coordinates = [0, 0]; }, m => { m.context_ref.context_sha256 = 'd'.repeat(64); },
    m => { m.bounds = [[-97, 32]]; }, m => { m.geometry_semantics = 'legal_boundary'; }]) {
    const manifest = structuredClone(f.projection.manifest); mutate(manifest);
    assert.throws(() => project({ ...f.projection, manifest }), /invalid_projection|storage_conflict/);
  }
  const withGetter = Object.defineProperty(structuredClone(f.projection.manifest), 'bounds', { enumerable: true, get() { assert.fail('getter'); } });
  assert.throws(() => project({ ...f.projection, manifest: withGetter }), /invalid_projection/);
  assert.throws(() => project({ ...f.projection, manifest: new Proxy(f.projection.manifest, { getPrototypeOf() { assert.fail('proxy'); } }) }), /invalid_projection/);
});

test('transport accepts only the actual exact-reference witness; clones and mismatches cannot disclose a map', async () => {
  const f = await selectionMapOpeningFixture(), request = prepare(f.request);
  for (const change of [{ status: 'applied' }, { authority: 'established' }, { summary: {} },
    { map_opening: structuredClone(f.result.map_opening) },
    { selection_ref: { ...f.result.selection_ref, manifest_ref: { ...f.result.selection_ref.manifest_ref, content_sha256: 'd'.repeat(64) } } }])
    assert.throws(() => present({ ...f.result, ...change }, request, f.accountId), /invalid_projection/);
  assert.throws(() => present(f.result, request, 'FOREIGN'), /invalid_projection/);
  assert.throws(() => present(f.result, { ...request, assignment_file_id: '8' }, f.accountId), /invalid_projection/);
});

test('original unavailable geometry remains a display refusal, not a partial accepted area', async () => {
  const f = await selectionMapOpeningFixture();
  const map = project({ ...f.projection, manifest: { status: 'unavailable', context_ref: f.request.context_ref,
    geometry_semantics: f.projection.manifest.geometry_semantics, reason: 'geometry_missing' } });
  const out = present({ ...f.result, map_opening: map }, prepare(f.request), f.accountId);
  assert.equal(out.map_opening.manifest.reason, 'geometry_missing'); assert.equal(out.map_opening.display_only, true);
});

test('optional authenticated no-store opening route admits only current exact identity and finite budget', async t => {
  const h = await harness(t), start = performance.now(), response = await h.post();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(h.result));
  assert.deepEqual(h.calls[0][0], { auth: h.auth, accountId: h.accountId, assignmentFileId: h.request.assignment_file_id,
    contextRef: h.request.context_ref, selectionRef: h.request.selection_ref });
  assert.ok(h.calls[0][1].signal instanceof AbortSignal);
  assert.ok(h.calls[0][1].deadline >= start + 60_000 && h.calls[0][1].deadline <= performance.now() + 60_000);
  assert.equal((await (await harness(t, { authenticated: false })).post()).status, 401);
  assert.equal((await (await harness(t, { enabled: false })).post()).status, 404);
});

test('source/selection/area injection and UTF-8 request ceiling fail before I/O with either JSON parser', async t => {
  for (const parsed of [false, true]) {
    const h = await harness(t, { parsed });
    for (const extra of [{ auth: {} }, { account_ids: [] }, { included_recorded_group_ids: [] },
      { viewport: {} }, { source_rows: [] }, { include_map: true }, { selection_ref: null }])
      assert.equal((await h.post({ ...h.request, ...extra })).status, 400);
    assert.equal((await h.post({ ...h.request, selection_ref: 'é'.repeat(140_000) })).status, 413);
    assert.equal(h.calls.length, 0);
  }
});

test('current selection/access/interruption refusals are sanitized; raw output cannot reach the response', async t => {
  for (const [failure, status, error] of [
    [new TypeError('custom_cohort_group_selection_selection_changed'), 409, 'neighborhood_selection_changed'],
    [Object.assign(new Error('PRIVATE'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE'), { reason: 'cancelled' }), 503, 'neighborhood_request_interrupted'],
  ]) {
    const h = await harness(t, { failure }), response = await h.post();
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
  }
  const h = await harness(t, { respond: f => ({ ...f.result, private_rows: ['PRIVATE'] }) }), response = await h.post();
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'neighborhood_request_failed' });
});
