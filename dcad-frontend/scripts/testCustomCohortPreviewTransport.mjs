import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCustomCohortJsonTransport, createCustomCohortPreviewTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';

const input = () => ({ accountId: 'R-001/#1', assignmentFileId: '9007199254740993',
  contextRef: { context_id: '71fe3e95-778b-42a8-bf4c-5dfc96de3bd7', context_revision: '1', context_sha256: 'a'.repeat(64) },
  selection: { revision: 1, pockets: [] }, include_map: true });
const json = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(request = async () => json({ status: 'preview' })) {
  const calls = [], paths = [], abort = new AbortController();
  const transport = createCustomCohortPreviewTransport({ request: (url, init) => { calls.push({ url, init }); return request(url, init); },
    urlFor: path => { paths.push(path); return `https://example.invalid${path}`; } });
  return { calls, paths, abort, run: value => transport(value ?? input(), { signal: abort.signal }) };
}
function stream(parts, { hanging = false, onCancel = () => {} } = {}) {
  let i = 0;
  return new ReadableStream({ pull(controller) {
    if (i < parts.length) controller.enqueue(parts[i++]); else if (!hanging) controller.close();
  }, cancel: onCancel });
}
const responseStream = (body, headers = {}, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
const encoded = text => new TextEncoder().encode(text);

test('catalog/member/capture operations share cancellation and smaller response limits', async () => {
  for (const operation of ['catalog', 'members', 'capture']) {
    let path, count = 0;
    const transport = createCustomCohortJsonTransport({ urlFor: p => { path = p; return p; }, request: async () => {
      count++; return responseStream(stream([encoded(`"${'x'.repeat(4_000_000)}"`)]));
    } });
    await assert.rejects(transport('R-1', operation, { operation_id: 'unchanged' }, { signal: new AbortController().signal }), /too large/);
    assert.equal(count, 1); assert.equal(path, `/api/accounts/R-1/neighborhood-cohort/${operation}`);
  }
});

test('dense map preview has a bounded 27MB envelope, not an unbounded download', async () => {
  let cancelled = false;
  const transport = createCustomCohortPreviewTransport({ urlFor: p => p,
    request: async () => responseStream(stream([encoded(`"${'x'.repeat(27_000_000)}"`)], {
      onCancel: () => { cancelled = true; }, hanging: true })) });
  await assert.rejects(transport(input(), { signal: new AbortController().signal }), /too large/);
  assert.equal(cancelled, true);
});

test('generic cohort transport refuses arbitrary operation paths before network access', async () => {
  const transport = createCustomCohortJsonTransport({ urlFor: () => { throw new Error('must not route'); }, request: async () => json({}) });
  await assert.rejects(transport('R-1', '../admin', {}, { signal: new AbortController().signal }), /Invalid neighborhood request/);
});

test('posts the exact body to the encoded account URL with the caller signal and no cache', async () => {
  const h = harness(), value = input(); const pending = h.run(value); value.selection.pockets.push({ id: 'changed-later' });
  assert.deepEqual(await pending, { status: 'preview' }); assert.equal(h.calls.length, 1);
  assert.equal(h.paths[0], '/api/accounts/R-001%2F%231/neighborhood-cohort/preview');
  assert.equal(h.calls[0].init.signal, h.abort.signal); assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.cache, 'no-store');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: '9007199254740993', context_ref: input().contextRef,
    selection: { revision: 1, pockets: [] }, include_map: true });
  assert.deepEqual(h.calls[0].init.headers, { accept: 'application/json', 'content-type': 'application/json' });
});
test('an already-aborted operation never calls the URL builder or transport', async () => {
  const h = harness(); h.abort.abort(); await assert.rejects(h.run(), { name: 'AbortError' });
  assert.equal(h.calls.length, 0); assert.equal(h.paths.length, 0);
});
test('abort before the scheduled transport call never sends a request', async () => {
  const h = harness(); const pending = h.run(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
});
test('abort during a hung token/transport promise settles promptly and cancels a late response', async () => {
  let resolve, cancelled = 0; const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.run(); await drain(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  resolve(responseStream(stream([], { hanging: true, onCancel: () => cancelled++ }))); await drain(); assert.equal(cancelled, 1);
});
test('late request rejection after abort is handled and never retried', async () => {
  let reject; const h = harness(() => new Promise((_resolve, r) => { reject = r; }));
  const pending = h.run(); await drain(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  reject(new Error('late failure')); await drain(); assert.equal(h.calls.length, 1);
});
test('abort during streamed response cancels its reader even if it never closes', async () => {
  let cancelled = 0; const h = harness(async () => responseStream(stream([encoded('{"value":')], { hanging: true, onCancel: () => cancelled++ })));
  const pending = h.run(); await drain(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, 1);
});
test('streaming JSON preserves UTF-8 codepoints split across network chunks', async () => {
  const bytes = encoded('{"label":"Élément 🌳"}'); const h = harness(async () => responseStream(stream([...bytes].map(b => new Uint8Array([b])))));
  assert.deepEqual(await h.run(), { label: 'Élément 🌳' });
});
test('oversized declared success response is cancelled without reading the body', async () => {
  let cancelled = 0; const h = harness(async () => responseStream(stream([], { hanging: true, onCancel: () => cancelled++ }), { 'content-length': '27000001' }));
  await assert.rejects(h.run(), /too large/); assert.equal(cancelled, 1);
});
test('actual decoded bytes are capped even when content-length is missing or false', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    let cancelled = 0;
    const h = harness(async () => responseStream(stream([encoded('"'), new Uint8Array(27_000_000).fill(65)],
      { hanging: true, onCancel: () => cancelled++ }), headers));
    await assert.rejects(h.run(), /too large/); assert.equal(cancelled, 1);
  }
});
test('the 27MB preview limit is applied to UTF-8 bytes, not character count', async () => {
  let cancelled = 0;
  const h = harness(async () => responseStream(stream([encoded(`"${'界'.repeat(9_000_000)}"`)], { hanging: true, onCancel: () => cancelled++ })));
  await assert.rejects(h.run(), /too large/); assert.equal(cancelled, 1);
});
test('non-JSON success responses are cancelled without exposing HTML', async () => {
  let cancelled = 0; const h = harness(async () => new Response(stream([], { hanging: true, onCancel: () => cancelled++ }),
    { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(h.run(), /Expected a JSON/); assert.equal(cancelled, 1);
});
test('invalid JSON, UTF-8, and empty bodies do not become successful previews', async () => {
  for (const make of [() => responseStream(stream([encoded('{broken')])), () => responseStream(stream([new Uint8Array([0xff])])),
    () => responseStream(null)]) {
    const h = harness(async () => make()); await assert.rejects(h.run()); assert.equal(h.calls.length, 1);
  }
});
test('safe server errors are capped at 500 characters and 429 never retries', async () => {
  const h = harness(async () => json({ error: `please\n${'x'.repeat(1000)}` }, { status: 429,
    headers: { 'content-type': 'application/problem+json', 'retry-after': '1' } }));
  await assert.rejects(h.run(), error => error.message.length === 500 && !error.message.includes('\n'));
  assert.equal(h.calls.length, 1);
});
test('oversized JSON errors use a short HTTP fallback and cancel the remaining body', async () => {
  let cancelled = 0; const h = harness(async () => responseStream(stream([encoded(`{"error":"${'x'.repeat(16_001)}`)],
    { hanging: true, onCancel: () => cancelled++ }), {}, 500));
  await assert.rejects(h.run(), /HTTP 500/); assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});
test('HTML errors are never copied into user-facing error messages', async () => {
  let cancelled = 0; const h = harness(async () => new Response(stream([encoded('<html>private details</html>')],
    { hanging: true, onCancel: () => cancelled++ }), { status: 502, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(h.run(), error => error.message.includes('HTTP 502') && !error.message.includes('private'));
  assert.equal(cancelled, 1);
});
test('abort during an error body stays an abort instead of becoming an HTTP error', async () => {
  const h = harness(async () => responseStream(stream([], { hanging: true }), {}, 401));
  const pending = h.run(); await drain(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
test('network exceptions are not retried or copied with potentially private URL details', async () => {
  const h = harness(async () => { throw new TypeError('sensitive URL and token'); });
  await assert.rejects(h.run(), error => error.message === 'Neighborhood preview request failed'); assert.equal(h.calls.length, 1);
});
test('oversized posted body is rejected before network use', async () => {
  const h = harness(), value = input(); value.selection.pockets = [{ id: 'huge', label: 'x'.repeat(4_000_001), account_ids: [] }];
  await assert.rejects(h.run(value), /selection is too large/); assert.equal(h.calls.length, 0);
});
test('the production wrapper reuses established authentication and URL configuration without fetchJSON', () => {
  const source = readFileSync(new URL('../src/features/neighborhood/customCohortPreviewApi.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ fetchWithApplicationAuthentication, makeUrl \} from '@\/lib\/api'/);
  assert.match(source, /request: fetchWithApplicationAuthentication/); assert.match(source, /urlFor: makeUrl/);
  assert.doesNotMatch(source, /fetchJSON\(/); assert.doesNotMatch(source, /localStorage|sessionStorage|authorization:|credentials:/);
});
