import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSfrepPreview, createSfrepTransport, SFREP_FORM_ID, sfrepDownloadFilename, sfrepNoticeText } from '../src/features/sfrep/sfrepTransport.ts';

const selection = { accountId: 'R-1/#', assignmentFileId: 12, documentIds: [21], includeDocuments: true };
const digest = 'a'.repeat(64);
const preview = () => ({ ok: true, preview_digest: digest, formId: SFREP_FORM_ID, filename: 'HomeNode-SFREP-file-12.rpti',
  fields: [{ sourceField: 'contract_price', fieldId: 'SalePriceAmount', value: '200000', documentId: 21, candidateId: null, type: 'TextField' }],
  conflicts: [], omitted: [], warnings: [], documents: [{ id: 21, title: 'Contract', file_name: 'contract.pdf', file_size_bytes: 100, processing_status: 'reviewed' }] });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function harness(request = async () => json(preview())) {
  const calls = [], controller = new AbortController();
  const api = createSfrepTransport({ urlFor: path => `https://example.invalid${path}`, request: (url, init) => { calls.push({ url, init }); return request(url, init); } });
  return { calls, api, controller, io: { signal: controller.signal, editorKey: 'test-editor' } };
}

test('preview and export use scoped authenticated POSTs with exact selections and a reviewed digest', async () => {
  const h = harness(async (_url, init) => init.headers.accept === 'application/json' ? json(preview())
    : new Response('rpti-fixture', { headers: { 'content-type': 'application/octet-stream' } }));
  const result = await h.api.preview(selection, h.io);
  assert.equal(result.fields[0].candidateId, null);
  assert.equal(h.calls[0].url, 'https://example.invalid/api/accounts/R-1%2F%23/sfrep/preview');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: 12, document_ids: [21], include_documents: true, form_id: SFREP_FORM_ID });
  assert.equal(h.calls[0].init.headers['x-homenode-editor-key'], 'test-editor');
  assert.equal(h.calls[0].init.signal, h.controller.signal); assert.equal(h.calls[0].init.cache, 'no-store');
  assert.equal(await (await h.api.export(selection, result.preview_digest, h.io)).text(), 'rpti-fixture');
  assert.equal(JSON.parse(h.calls[1].init.body).preview_digest, digest);
  assert.match(h.calls[1].url, /\/sfrep\/export$/); assert.equal(h.calls.length, 2);
});

test('invalid selection, absent digest and already-aborted calls do not issue a request', async () => {
  const h = harness();
  for (const documentIds of [[], [21, 21], [NaN], Array.from({ length: 11 }, (_, i) => i + 1)]) {
    await assert.rejects(h.api.preview({ ...selection, documentIds }, h.io));
  }
  await assert.rejects(h.api.export(selection, '', h.io));
  h.controller.abort(); await assert.rejects(h.api.preview(selection, h.io), { name: 'AbortError' });
  assert.equal(h.calls.length, 0);
});

test('HTTP failures including busy/stale refusals never become a successful preview or download and never retry', async () => {
  for (const [status, code, expected] of [[401, 'authentication_required', /authentication_required/],
    [409, 'sfrep_preview_changed', /changed after your preview/], [429, 'sfrep_export_busy', /Another SFREP export/], [500, 'failed', /failed/]]) {
    const h = harness(async () => json({ error: code }, status));
    await assert.rejects(h.api.preview(selection, h.io), expected);
    await assert.rejects(h.api.export(selection, digest, h.io), expected);
    assert.equal(h.calls.length, 2);
  }
});

test('malformed schemas, unexpected form versions, HTML responses and empty exports fail closed', async () => {
  for (const change of [{ ok: false }, { formId: 'UAD-3.6' }, { preview_digest: 'unbound' }, { fields: [{}] },
    { conflicts: [{}] }, { omitted: [{}] }, { warnings: [{}] }, { documents: [{}] }]) {
    assert.throws(() => checkSfrepPreview({ ...preview(), ...change }), /invalid/);
  }
  const html = harness(async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(html.api.preview(selection, html.io), /Unexpected/);
  await assert.rejects(html.api.export(selection, digest, html.io), /Unexpected/);
  const empty = harness(async () => new Response('', { headers: { 'content-type': 'application/octet-stream' } }));
  await assert.rejects(empty.api.export(selection, digest, empty.io), /empty/);
});

test('oversized responses are refused before body download', async () => {
  const h = harness(async () => new Response('small', { headers: { 'content-type': 'application/octet-stream', 'content-length': String(52 * 1024 * 1024) } }));
  await assert.rejects(h.api.export(selection, digest, h.io), /too large/);
});

test('preview sources must exactly match selected document IDs', async () => {
  for (const change of [{ documents: [] }, { documents: [preview().documents[0], preview().documents[0]] },
    { fields: [{ ...preview().fields[0], documentId: 22 }] },
    { conflicts: [{ sourceField: 'contract_price', documentIds: [22], values: ['1', '2'] }] },
    { omitted: [{ sourceField: 'seller_name', documentId: 22, candidateId: null, reason: 'unsupported' }] }]) {
    const h = harness(async () => json({ ...preview(), ...change }));
    await assert.rejects(h.api.preview(selection, h.io), /does not match/);
  }
});

test('cancellation settles pending authentication and disposes of a late response', async () => {
  let resolve, cancelled = 0;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const pending = h.api.preview(selection, h.io);
  await Promise.resolve(); await Promise.resolve(); h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolve(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  await Promise.resolve(); await Promise.resolve(); assert.equal(cancelled, 1);
});

test('cancellation while receiving the body never returns partial data', async () => {
  let cancelled = 0, started;
  const ready = new Promise(r => { started = r; });
  const h = harness(async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/octet-stream' } }));
  const pending = h.api.export(selection, digest, h.io); await ready; await Promise.resolve(); h.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, 1);
});

test('download names remove path and control characters, notices remain plain strings', () => {
  assert.equal(sfrepDownloadFilename('../../folder/file.rpti'), 'file.rpti');
  assert.equal(sfrepDownloadFilename('C:\\folder\\file\n.rpti'), 'file_.rpti');
  assert.equal(sfrepDownloadFilename('bad.html'), 'HomeNode-SFREP.rpti');
  assert.equal(sfrepNoticeText('<script>text</script>'), '<script>text</script>');
  assert.match(sfrepNoticeText({ sourceField: 'contract_price', values: ['1', '2'], documentIds: [21, 22] }), /contract price: 1 \/ 2/);
  assert.match(sfrepNoticeText({ sourceField: 'seller_name', documentId: 21, candidateId: null, reason: 'not_mapped' }), /seller name: not mapped/);
});
