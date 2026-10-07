import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as blob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortPreparedCatalogRequest as prepare, presentCustomCohortPreparedCatalogResponse as present }
  from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogTransport.js';
import { customCohortPreparedCatalogSqlFixture as fixture } from './fixtures/customCohortPreparedCatalogSqlFixture.js';

async function artifacts() {
  const h = fixture(); await h.make().prepare();
  const body = { assignment_file_id: h.f.scope.assignment_file_id, context_ref: h.f.context };
  const envelope = { status: 'available', authority: 'not_established', context_ref: h.f.context,
    target: { account_id: h.f.scope.account_id, assignment_file_id: body.assignment_file_id } };
  const directory = { ...envelope, catalog: await h.make().open() };
  const page = { ...envelope, page_index: 0, catalog: await h.make().page(0) };
  return { h, body, directory, page };
}

test('closed prepared-catalog syntax rejects roots, membership, auth, accessors and proxy claims', () => {
  const body = { assignment_file_id: '8', context_ref: { context_id: '70000000-0000-4000-8000-000000000001',
    context_revision: '1', context_sha256: 'a'.repeat(64) } };
  const request = prepare(body); body.context_ref.context_sha256 = 'b'.repeat(64);
  assert.equal(request.context_ref.context_sha256, 'a'.repeat(64)); assert.equal(Object.isFrozen(request), true);
  for (const extra of [{ auth: {} }, { manifest_ref: {} }, { source_rows: [] }, { account_ids: [] }, { prepare: true },
    { selection_ref: {} }, { viewport: {} }, { include_map: true }, { page_index: 0 }])
    assert.throws(() => prepare({ ...body, ...extra }), /invalid_input/);
  for (const index of [-1, 21, 0.1, '0', null]) assert.throws(() => prepare({ ...body, page_index: index }, true));
  const getter = Object.defineProperty({ ...body }, 'context_ref', { enumerable: true, get() { assert.fail('getter invoked'); } });
  assert.throws(() => prepare(getter));
  assert.throws(() => prepare(new Proxy(body, { ownKeys() { assert.fail('proxy invoked'); } })));
});

test('transport admits ACTUAL compiled retained directory/page originals, not full members or alternate target/context', async () => {
  const f = await artifacts(), request = prepare(f.body), pageRequest = prepare({ ...f.body, page_index: 0 }, true);
  assert.deepEqual(present(f.directory, request, f.h.f.scope.account_id), f.directory);
  assert.deepEqual(present(f.page, pageRequest, f.h.f.scope.account_id, true), f.page);
  assert.deepEqual(present({ ...f.directory, status: 'not_prepared', catalog: null }, request, f.h.f.scope.account_id).catalog, null);
  for (const out of [{ ...f.directory, authority: 'established' }, { ...f.directory, source_rows: [] },
    { ...f.directory, status: 'applied' }, { ...f.directory, status: 'not_prepared' },
    { ...f.directory, context_ref: { ...request.context_ref, context_sha256: '0'.repeat(64) } },
    { ...f.directory, target: { ...f.directory.target, account_id: 'FOREIGN' } },
    { ...f.directory, catalog: { ...f.directory.catalog, account_ids: [] } },
    { ...f.directory, catalog: { ...f.directory.catalog, manifest_json: '{}' } }])
    assert.throws(() => present(out, request, f.h.f.scope.account_id), /invalid_response/);
  assert.throws(() => present({ ...f.page, page_index: 1 }, pageRequest, f.h.f.scope.account_id, true), /invalid_response/);
  const leaky = structuredClone(f.page), raw = JSON.parse(leaky.catalog.page_json);
  raw.groups[0].account_ids = ['PRIVATE']; leaky.catalog.page_json = json(raw); leaky.catalog.page_ref = blob(leaky.catalog.page_json);
  assert.throws(() => present(leaky, pageRequest, f.h.f.scope.account_id, true), /invalid_response/);
  const directory = structuredClone(f.directory), metadata = JSON.parse(directory.catalog.metadata_json);
  metadata.source_rows = ['PRIVATE']; directory.catalog.metadata_json = json(metadata);
  const root = JSON.parse(directory.catalog.manifest_json); root.metadata_ref = blob(directory.catalog.metadata_json);
  directory.catalog.manifest_json = json(root); directory.catalog.manifest_ref = blob(directory.catalog.manifest_json);
  assert.throws(() => present(directory, request, f.h.f.scope.account_id), /invalid_response/);
});

async function app(t, { enabled = true, authenticated = true, parsed = false, failure = null, leaky = false } = {}) {
  const f = await artifacts(), calls = [], auth = { userId: '70000000-0000-4000-8000-000000000001', organizations: [] };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy source replay')]));
  service.openPreparedRecordedCatalog = async (...args) => { calls.push(args); if (failure) throw failure;
    return leaky ? { ...f.directory, private_rows: [] } : f.directory; };
  service.pagePreparedRecordedCatalog = async (...args) => { calls.push(args); if (failure) throw failure; return f.page; };
  service.prepareRecordedCatalog = () => assert.fail('browser preparation must not be mounted');
  const application = express(); application.set('json spaces', 8);
  application.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) application.use(express.json({ limit: 10_000_000 }));
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: service,
    ...(enabled ? { preparedRecordedCatalogReads: true } : {}), logger: {} }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (action, body = f.body) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/${f.h.f.scope.account_id}/neighborhood-cohort/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...f, calls, auth, post };
}

test('optional routes use only middleware identity and a finite gate; no-store bounded bytes ignore app indentation', async t => {
  const f = await app(t), before = performance.now(), response = await f.post('prepared-catalog');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(f.directory));
  assert.deepEqual(f.calls[0][0], { auth: f.auth, accountId: f.h.f.scope.account_id,
    assignmentFileId: f.body.assignment_file_id, contextRef: f.body.context_ref });
  assert.ok(f.calls[0][1].signal instanceof AbortSignal); assert.ok(f.calls[0][1].deadline >= before + 60_000);
  assert.equal((await f.post('prepared-catalog-page', { ...f.body, page_index: 0 })).status, 200);
  assert.equal(f.calls[1][0].pageIndex, 0);
  assert.equal((await f.post('prepare-recorded-catalog')).status, 404);
  const disabled = await app(t, { enabled: false }); assert.equal((await disabled.post('prepared-catalog')).status, 404);
  assert.equal(disabled.calls.length, 0);
  const anonymous = await app(t, { authenticated: false }); assert.equal((await anonymous.post('prepared-catalog')).status, 401);
  assert.equal(anonymous.calls.length, 0);
});

test('unparsed and pre-parsed requests refuse injected authority and original-byte overflow before any owner work', async t => {
  for (const parsed of [false, true]) {
    const f = await app(t, { parsed });
    for (const extra of [{ auth: {} }, { manifest_ref: {} }, { account_ids: [] }, { page_index: 21 }])
      assert.equal((await f.post('prepared-catalog', { ...f.body, ...extra })).status, 400);
    const response = await f.post('prepared-catalog', { ...f.body, context_ref: { ...f.body.context_ref, context_sha256: 'x'.repeat(2048) } });
    assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'neighborhood_request_too_large' });
    assert.equal(f.calls.length, 0);
  }
});

test('current-rights, private-context and corrupted-result refusals remain sanitized and never return source diagnostics', async t => {
  for (const [failure, status, error] of [[new TypeError('custom_cohort_job_actor_access_revoked'), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE'), { reason: 'prepared_catalog_private_source_unsupported' }), 422, 'neighborhood_source_unavailable'],
    [new TypeError('custom_cohort_prepared_catalog_registry_storage_conflict'), 500, 'neighborhood_request_failed']]) {
    const f = await app(t, { failure }), response = await f.post('prepared-catalog');
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
  }
  const f = await app(t, { leaky: true }), response = await f.post('prepared-catalog');
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'neighborhood_request_failed' });
});

test('half-installed or nonboolean route configuration is refused without changing the default surface', () => {
  const cohortService = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(k => [k, () => {}]));
  assert.throws(() => createCustomNeighborhoodCohortRouter({ cohortService, preparedRecordedCatalogReads: true }), /dependencies_required/);
  assert.throws(() => createCustomNeighborhoodCohortRouter({ cohortService, preparedRecordedCatalogReads: 'true' }), /dependencies_required/);
});
