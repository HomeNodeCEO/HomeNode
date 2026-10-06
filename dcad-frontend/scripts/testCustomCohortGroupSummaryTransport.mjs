import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { selectionSummaryTransportFixture } from '../../server/test/fixtures/customCohortSelectionSummaryTransportFixture.js';

const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
async function harness(respond) {
  const f = await selectionSummaryTransportFixture({ accountId: 'R-001/#1' }), calls = [], paths = [], abort = new AbortController();
  const transport = createCustomCohortRecordedGroupTransport({ urlFor: p => { paths.push(p); return `https://example.invalid${p}`; },
    request: async (url, init) => { calls.push({ url, init }); return respond ? respond(f) : json(f.result); } });
  const input = () => ({ accountId: 'R-001/#1', assignmentFileId: f.request.assignment_file_id,
    contextRef: structuredClone(f.request.context_ref), selectionRef: structuredClone(f.request.selection_ref) });
  return { ...f, calls, paths, abort, input, preview: value => transport.preview(value ?? input(), { signal: abort.signal }) };
}

test('exact summary uses a small reference-only authenticated request and preserves whole-population statistics', async () => {
  const h = await harness(), result = await h.preview();
  assert.deepEqual(result.summary, h.result.summary); assert.equal(result.summary.selected.account_count, 2);
  assert.equal(result.summary.all.account_count, 3); assert.deepEqual(result.selection_ref, h.request.selection_ref);
  assert.equal(result.binding.selectionFingerprint, h.request.selection_ref.selection_sha256);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request);
  assert.equal(h.paths[0], '/api/accounts/R-001%2F%231/neighborhood-cohort/selection-preview');
  assert.ok(new TextEncoder().encode(h.calls[0].init.body).length < 1000);
  assert.equal(h.calls[0].init.cache, 'no-store'); assert.equal(h.calls[0].init.signal, h.abort.signal);
  assert.ok(Object.isFrozen(result.summary.selected.stock.metrics)); assert.ok(Object.isFrozen(result.selection_ref.manifest_ref));
  assert.equal(result.apply.status, 'blocked'); assert.equal(Object.hasOwn(result, 'parcel_map'), false);
  assert.doesNotMatch(JSON.stringify(result), /"account_ids"|"members"|"source_rows"/);
});

test('reference and target are copied before authentication; later caller mutations cannot rebind a summary', async () => {
  let complete; const h = await harness(() => new Promise(resolve => { complete = resolve; })), input = h.input();
  const pending = h.preview(input);
  input.selectionRef.manifest_ref.content_sha256 = 'd'.repeat(64); input.contextRef.context_sha256 = 'e'.repeat(64);
  while (!complete) await Promise.resolve(); complete(json(h.result));
  const result = await pending; assert.deepEqual(result.selection_ref, h.request.selection_ref);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request); assert.equal(h.calls.length, 1);
});

test('only exact reference syntax is admitted before URL/token I/O, never absent/default or replacement choice arrays', async () => {
  const h = await harness(), input = h.input();
  for (const changed of [{ selectionRef: null }, { includedRecordedGroupIds: [] }, { account_ids: [] },
    { source_rows: [] }, { auth: {} }, { include_map: true }, { selection: { pockets: [] } },
    { assignmentFileId: '9223372036854775808' }, { accountId: 'R\u0000' },
    { selectionRef: { ...input.selectionRef, extra: true } },
    { selectionRef: { ...input.selectionRef, manifest_ref: { ...input.selectionRef.manifest_ref, canonical_utf8_bytes: '750001' } } }])
    await assert.rejects(h.preview({ ...input, ...changed }), /invalid_custom_cohort/);
  const accessor = Object.defineProperty(structuredClone(input.selectionRef), 'selection_revision',
    { enumerable: true, get() { assert.fail('getter executed'); } });
  await assert.rejects(h.preview({ ...input, selectionRef: accessor }), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 0); assert.equal(h.paths.length, 0);
});

test('context/revision/digest/manifest/target and authority cannot be substituted; geometry never enters this result', async () => {
  const changes = [r => { r.authority = 'established'; }, r => { r.target.account_id = 'other'; },
    r => { r.selection_revision++; }, r => { r.selection_ref.selection_revision++; },
    r => { r.selection_ref.selection_sha256 = 'e'.repeat(64); }, r => { r.selection_ref.manifest_ref.content_sha256 = 'e'.repeat(64); },
    r => { r.context_ref.context_sha256 = 'e'.repeat(64); }, r => { r.summary.binding.selection_sha256 = 'e'.repeat(64); },
    r => { r.summary.binding.selection_revision++; }, r => { r.subject_freshness = 'changed'; },
    r => { r.parcel_map = { status: 'available', geojson: { features: [] } }; }, r => { r.apply.status = 'ready'; },
    r => { r.summary.apply.status = 'ready'; }, r => { r.raw = 'PRIVATE'; }, r => { r.map_manifest = {}; },
    r => { r.private_sales = { rows: ['PRIVATE'] }; }];
  for (const change of changes) {
    const h = await harness(f => { const r = structuredClone(f.result); change(r); return json(r); });
    await assert.rejects(h.preview(), /invalid_custom_cohort/); assert.equal(h.calls.length, 1);
  }
});

test('a deliberate empty selection retains exact zero statistics rather than becoming an all-groups response', async () => {
  const f = await selectionSummaryTransportFixture({ accountId: 'R-001/#1', revision: 2, empty: true });
  const h = await harness(() => json(f.result));
  const result = await h.preview({ ...h.input(), selectionRef: f.request.selection_ref });
  assert.equal(result.summary.selected.account_count, 0); assert.equal(result.summary.selected.stock.metrics.gla_sqft.median, null);
  assert.equal(result.summary.all.account_count, 3); assert.equal(result.binding.selectionRevision, 2);
});

test('numeric response budget is separate from unchanged small intent and request limits, including declared length', async () => {
  const calls = [], t = createCustomCohortJsonTransport({ urlFor: p => p,
    request: async (url, init) => { calls.push({ url, init }); return json('x'.repeat(300_000)); } });
  const io = { signal: new AbortController().signal };
  assert.equal((await t('R', 'selection-preview', {}, io)).length, 300_000);
  await assert.rejects(t('R', 'group-selection', {}, io), /too large/);
  await assert.rejects(t('R', 'selection-preview', { large: 'é'.repeat(140_000) }, io), /too large/);
  assert.equal(calls.length, 2);
  let size = 4_100_000;
  const declared = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => json({}, { 'content-length': String(size) }) });
  assert.deepEqual(await declared('R', 'selection-preview', {}, io), {});
  size++; await assert.rejects(declared('R', 'selection-preview', {}, io), /too large/);
  const oversized = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => json('é'.repeat(2_050_000)) });
  await assert.rejects(oversized('R', 'selection-preview', {}, io), /too large/);
});

test('caller cancellation terminates hung authentication and cancels a late body, without retries', async () => {
  let complete, cancelled = 0;
  const h = await harness(() => new Promise(resolve => { complete = resolve; })), pending = h.preview();
  while (!complete) await Promise.resolve(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 12; i++) await Promise.resolve(); assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});
