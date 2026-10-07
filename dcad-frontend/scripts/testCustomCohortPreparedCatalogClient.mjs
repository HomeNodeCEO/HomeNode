import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortPreparedCatalogClient as client }
  from '../src/features/neighborhood/customCohortPreparedCatalogClient.ts';
import { createCustomCohortJsonTransport as transport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { requireCustomCohortPagedCatalog as requireCatalog } from '../src/features/neighborhood/customCohortPagedCatalog.ts';
import { customCohortPreparedCatalogSqlFixture as fixture } from '../../server/test/fixtures/customCohortPreparedCatalogSqlFixture.js';
import { customCohortPreparedCatalogRegistryFixture as originals } from '../../server/test/fixtures/customCohortPreparedCatalogRegistryFixture.js';
import { prepareCustomCohortPreparedCatalogRequest as prepare, presentCustomCohortPreparedCatalogResponse as present }
  from '../../server/src/services/neighborhoodAssessment/customCohortPreparedCatalogTransport.js';

const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 30_000 });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const bytes = v => new TextEncoder().encode(v);
async function harness(options, hook) {
  const h = fixture(options ? originals(options) : undefined), calls = [], paths = []; await h.make().prepare();
  const request = { accountId: h.f.scope.account_id, assignmentFileId: h.f.scope.assignment_file_id, contextRef: h.f.context };
  const response = async body => {
    const paged = Object.hasOwn(body, 'page_index');
    const value = { status: 'available', authority: 'not_established',
      target: { account_id: request.accountId, assignment_file_id: request.assignmentFileId }, context_ref: request.contextRef,
      catalog: paged ? await h.make().page(body.page_index) : await h.make().open(), ...(paged ? { page_index: body.page_index } : {}) };
    return present(value, prepare(body, paged), request.accountId, paged);
  };
  const run = client({ urlFor: path => { paths.push(path); return `https://example.invalid${path}`; },
    request: async (url, init) => {
      const body = JSON.parse(init.body), action = url.slice(url.lastIndexOf('/') + 1);
      const call = { url, init, body, action }; calls.push(call);
      return hook ? hook({ h, calls, call, response }) : json(await response(body));
    } });
  return { h, request, calls, paths, run, response };
}

test('fixed authenticated HTTP client loads all ACTUAL registered originals and delivers only the issued complete display', async () => {
  const h = await harness(), options = io(), result = await h.run(h.request, options);
  const original = await h.h.make().reopen();
  assert.equal(result.status, 'available'); assert.equal(requireCatalog(result.catalog), result.catalog);
  assert.deepEqual(result.catalog.groups, original.groups); assert.equal(result.catalog.account_count, 501);
  assert.deepEqual(h.calls.map(c => c.action), ['prepared-catalog',
    'prepared-catalog-page', 'prepared-catalog-page', 'prepared-catalog-page', 'prepared-catalog']);
  assert.deepEqual(h.calls.filter(c => c.action.endsWith('-page')).map(c => c.body.page_index), [0, 1, 2]);
  for (const c of h.calls) {
    assert.equal(c.init.signal, options.signal); assert.equal(c.init.cache, 'no-store'); assert.equal(c.init.method, 'POST');
    assert.deepEqual(Object.keys(c.body).sort(), c.action.endsWith('-page')
      ? ['assignment_file_id', 'context_ref', 'page_index'] : ['assignment_file_id', 'context_ref']);
    assert.deepEqual(c.body.context_ref, h.request.contextRef);
    assert.equal(bytes(c.init.body).length < 2048, true);
    assert.equal(c.url, `https://example.invalid/api/accounts/${h.request.accountId}/neighborhood-cohort/${c.action}`);
  }
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.catalog.groups));
  assert.equal(result.catalog.authority, 'not_established'); assert.equal(Object.hasOwn(result.catalog, 'pockets'), false);
  assert.equal(JSON.stringify(result).includes('"account_ids":'), false);
  assert.throws(() => requireCatalog({ ...result.catalog }), /invalid_custom_cohort_paged_catalog/);
});

test('actual empty and wholly unresolved catalogs remain exact without radius, recommendation or fabricated defaults', async () => {
  for (const count of [0, 11]) {
    const h = await harness({ count, groupCount: 0 }), result = await h.run(h.request, io());
    assert.equal(result.status, 'available'); assert.equal(result.catalog.account_count, count);
    assert.equal(result.catalog.unassigned_account_count, count);
    assert.equal(result.catalog.groups.reduce((n, g) => n + g.member_count, 0), count);
    assert.equal(h.calls.filter(c => c.action === 'prepared-catalog').length, 2);
    assert.equal(h.calls.filter(c => c.action.endsWith('-page')).length, count ? 1 : 0);
  }
});

test('cache miss makes one authorized read and never performs a synchronous fallback or preparation', async () => {
  const h = await harness(undefined, async ({ response, call }) => json({ ...(await response(call.body)), status: 'not_prepared', catalog: null }));
  assert.deepEqual(await h.run(h.request, io()), { status: 'not_prepared' }); assert.equal(h.calls.length, 1);
});

test('the one-shot beginning directory is verified before pages and is never reused by a later operation', async () => {
  const broken = await harness(undefined, async ({ response, call }) => {
    const value = await response(call.body);
    return json(call.action === 'prepared-catalog'
      ? { ...value, catalog: { ...value.catalog, manifest_json: value.catalog.manifest_json + ' ' } } : value);
  });
  await assert.rejects(broken.run(broken.request, io()), /invalid_custom_cohort_paged_catalog/);
  assert.equal(broken.calls.length, 1);
  let denied = false;
  const h = await harness(undefined, async ({ response, call }) => denied
    ? json({ error: 'neighborhood_access_denied' }, 403) : json(await response(call.body)));
  assert.equal((await h.run(h.request, io())).status, 'available');
  const before = h.calls.length; denied = true;
  await assert.rejects(h.run(h.request, io()), { status: 403, errorCode: 'neighborhood_access_denied' });
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1).action, 'prepared-catalog');
});

test('current-owner refusal or lost preparation at the ending check discards every pending page', async () => {
  for (const late of ['denied', 'missing', 'changed']) {
    let opens = 0;
    const h = await harness(undefined, async ({ response, call }) => {
      const value = await response(call.body);
      if (call.action === 'prepared-catalog' && ++opens === 2) {
        if (late === 'denied') return json({ error: 'neighborhood_access_denied' }, 403);
        if (late === 'missing') return json({ ...value, status: 'not_prepared', catalog: null });
        return json({ ...value, catalog: { ...value.catalog, metadata_json: value.catalog.metadata_json + ' ' } });
      }
      return json(value);
    });
    await assert.rejects(h.run(h.request, io()), late === 'denied' ? { status: 403, errorCode: 'neighborhood_access_denied' } : undefined);
    assert.equal(opens, 2); assert.equal(h.calls.filter(c => c.action.endsWith('-page')).length, 3);
  }
});

test('foreign target/context, extra authority, wrong page/hash and missing final page cannot produce a partial catalog', async () => {
  for (const broken of ['target', 'context', 'extra', 'page', 'hash', 'last']) {
    const h = await harness(undefined, async ({ response, call }) => {
      const value = await response(call.body);
      if (broken === 'target') value.target = { ...value.target, assignment_file_id: '99' };
      if (broken === 'context') value.context_ref = { ...value.context_ref, context_sha256: 'f'.repeat(64) };
      if (broken === 'extra') return json({ ...value, account_ids: ['PRIVATE'] });
      if (call.action.endsWith('-page')) {
        if (broken === 'page') return json({ ...value, page_index: 1 });
        if (broken === 'hash') return json({ ...value, catalog: { ...value.catalog, page_ref: {
          ...value.catalog.page_ref, content_sha256: 'f'.repeat(64) } } });
        if (broken === 'last' && call.body.page_index === 2) return json({ error: 'neighborhood_request_failed' }, 500);
      }
      return json(value);
    });
    await assert.rejects(h.run(h.request, io()));
    assert.equal(h.calls.length <= 5, true);
  }
});

test('caller aliases and accessors cannot redirect an authentication-suspended operation or add source/root claims', async () => {
  let entered, release;
  const ready = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const h = await harness(undefined, async ({ response, call, calls }) => {
    if (calls.length === 1) { entered(); await held; } return json(await response(call.body));
  });
  const value = structuredClone(h.request), options = io(), pending = h.run(value, options);
  await ready; value.accountId = 'foreign'; value.assignmentFileId = '99'; value.contextRef.context_sha256 = 'f'.repeat(64);
  options.deadline = 0; release(); const result = await pending;
  assert.equal(result.catalog.request.accountId, h.request.accountId); assert.equal(h.calls.length, 5);
  let getters = 0; const bad = Object.defineProperty({ ...h.request }, 'contextRef', {
    enumerable: true, get() { getters++; return h.request.contextRef; } });
  await assert.rejects(h.run(bad, io())); assert.equal(getters, 0);
  for (const extra of [{ catalogRef: {} }, { account_ids: [] }, { role: 'owner' }, { prepare: true }])
    await assert.rejects(h.run({ ...h.request, ...extra }, io()));
  assert.equal(h.calls.length, 5);
});

test('finite caller deadline and cancellation fence slow authentication, late HTTP bodies and late hash settlement', async () => {
  const h = await harness(); await assert.rejects(h.run(h.request, { ...io(), deadline: performance.now() - 1 }), /custom_workspace_deadline/);
  for (const deadline of [NaN, Infinity, undefined]) await assert.rejects(h.run(h.request, { ...io(), deadline }), /custom_workspace_deadline/);
  assert.equal(h.calls.length, 0);
  let entered, release, cancelled = false;
  const ready = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const controller = new AbortController(), delayed = client({ urlFor: p => p, request: async () => {
    entered(); await held; return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/json' } });
  } });
  const pending = delayed(h.request, { signal: controller.signal, deadline: performance.now() + 30_000 });
  await ready; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); release();
  for (let i = 0; i < 12; i++) await Promise.resolve(); assert.equal(cancelled, true);
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle), late = new AbortController();
  try {
    Object.defineProperty(globalThis.crypto.subtle, 'digest', { configurable: true, value: async (...args) => {
      const value = await digest(...args); late.abort(); return value;
    } });
    await assert.rejects(h.run(h.request, { signal: late.signal, deadline: performance.now() + 30_000 }), { name: 'AbortError' });
  } finally { delete globalThis.crypto.subtle.digest; }
});

test('prepared operations alone enforce original UTF-8 request and streamed response bounds before decoding', async () => {
  const signal = new AbortController().signal;
  for (const action of ['prepared-catalog', 'prepared-catalog-page']) {
    let calls = 0;
    const post = transport({ urlFor: p => p, request: async () => { calls++; return json(null); } });
    await assert.rejects(post('R', action, { value: 'é'.repeat(1020) }, { signal }), /too large/); assert.equal(calls, 0);
    for (const mode of ['stream', 'length', 'utf8']) {
      let cancelled = false, sent = false;
      const oversized = transport({ urlFor: p => p, request: async () => new Response(new ReadableStream({
        pull(c) { if (!sent) { sent = true; c.enqueue(mode === 'utf8' ? new Uint8Array([0xff]) : bytes(`"${'é'.repeat(256000)}"`)); } },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'application/json', ...(mode === 'length' ? { 'content-length': '512001' } : {}) } }) });
      await assert.rejects(oversized('R', action, {}, { signal })); assert.equal(cancelled, true);
    }
  }
});
