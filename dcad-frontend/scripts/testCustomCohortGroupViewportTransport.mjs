import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { selectionViewportFixture } from '../../server/test/fixtures/customCohortSelectionViewportFixture.js';

const A = `recorded-cad:${'a'.repeat(64)}`;
const json = (value, headers = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } });
async function harness({ respond, empty = false } = {}) {
  const f = await selectionViewportFixture({ accountId: 'R-001/#1', empty }), calls = [], abort = new AbortController();
  const transport = createCustomCohortRecordedGroupTransport({ urlFor: p => `https://example.invalid${p}`,
    request: async (url, init) => { calls.push({ url, init }); return respond ? respond(f) : json(f.result); } });
  const saved = { status: 'selected', authority: 'not_established', context_ref: f.request.context_ref,
    selection_ref: f.request.selection_ref, included_recorded_group_ids: empty ? [] : [A] };
  const catalog = { binding: { context_ref: f.request.context_ref, selection_revision: 1 },
    pockets: [{ id: A, account_ids: ['10000000000000000', '10000000000000001'] }],
    unassigned: { account_ids: ['10000000000000002'] } };
  const input = () => ({ accountId: 'R-001/#1', assignmentFileId: f.request.assignment_file_id,
    contextRef: structuredClone(f.request.context_ref), selectionRef: structuredClone(f.request.selection_ref),
    viewport: structuredClone(f.request.viewport) });
  const view = (r = input(), receipt = saved, c = catalog) => transport.viewport(r, receipt, c, 3, { signal: abort.signal });
  return { ...f, input, view, saved, catalog, calls, abort };
}

test('exact-reference pan sends no memberships; selected offscreen property stays in the numeric population', async () => {
  const h = await harness(), out = await h.view();
  assert.deepEqual(out.selection_ref, h.request.selection_ref);
  assert.deepEqual(out.map.features.map(f => f.properties.selected), [true, false]);
  assert.equal(out.map.features.length, 2); assert.equal(h.summary.selected.account_count, 2);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request);
  assert.ok(h.calls[0].url.endsWith('/api/accounts/R-001%2F%231/neighborhood-cohort/selection-viewport'));
  assert.equal(h.calls[0].init.cache, 'no-store'); assert.equal(h.calls[0].init.signal, h.abort.signal);
  assert.ok(new TextEncoder().encode(h.calls[0].init.body).length < 1000);
  assert.doesNotMatch(h.calls[0].init.body, /account_ids|included_recorded_group_ids|source_rows/);
  assert.equal(Object.hasOwn(out, 'summary'), false);
  const written = { ...h.saved, status: 'stored', operation_id: '70000000-0000-4000-8000-000000000009' };
  assert.deepEqual(await h.view(h.input(), written), out, 'an already accepted save receipt retains exactly the same choice');
});

test('viewport, reference and local membership lookups are detached before authentication', async () => {
  let complete; const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) }), r = h.input();
  const pending = h.view(r);
  r.viewport.west = -98; r.selectionRef.manifest_ref.content_sha256 = 'd'.repeat(64);
  h.saved.included_recorded_group_ids.length = 0; h.catalog.pockets[0].account_ids.length = 0;
  while (!complete) await Promise.resolve(); complete(json(h.result));
  assert.equal((await pending).map.features[0].properties.selected, true);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request); assert.equal(h.calls.length, 1);
});

test('missing, foreign, unknown or malformed selection/viewport never obtains a token or chooses all', async () => {
  const h = await harness(), r = h.input();
  for (const change of [{ selectionRef: null }, { account_ids: [] }, { includedRecordedGroupIds: [] },
    { viewport: { ...r.viewport, extra: true } }, { viewport: { ...r.viewport, east: r.viewport.west } },
    { viewport: { ...r.viewport, north: NaN } }, { viewport: { ...r.viewport, east: r.viewport.west + 1.1 } }])
    await assert.rejects(h.view({ ...r, ...change }), /invalid_custom_cohort/);
  await assert.rejects(h.view(r, { ...h.saved, status: 'absent', selection_ref: null, included_recorded_group_ids: null }), /invalid_custom_cohort/);
  await assert.rejects(h.view(r, { ...h.saved, included_recorded_group_ids: [`recorded-cad:${'e'.repeat(64)}`] }), /invalid_custom_cohort/);
  await assert.rejects(h.view(r, { ...h.saved, selection_ref: { ...h.saved.selection_ref,
    manifest_ref: { ...h.saved.selection_ref.manifest_ref, content_sha256: 'e'.repeat(64) } } }), /invalid_custom_cohort/);
  await assert.rejects(h.view(r, h.saved, { ...h.catalog, binding: { context_ref: { ...r.contextRef, context_sha256: 'e'.repeat(64) } } }), /invalid_custom_cohort/);
  const accessor = Object.defineProperty({ ...r.viewport }, 'west', { enumerable: true, get() { assert.fail('getter'); } });
  await assert.rejects(h.view({ ...r, viewport: accessor }), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 0);
});

test('late/foreign/partial geometry, wrong flags and extra source data cannot paint another selection', async () => {
  const changes = [r => { r.authority = 'established'; }, r => { r.status = 'applied'; }, r => { r.raw = 'PRIVATE'; },
    r => { r.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64); }, r => { r.viewport_map.target.assignment_file_id = '8'; },
    r => { r.viewport_map.context_ref.context_sha256 = 'd'.repeat(64); }, r => { r.viewport_map.selection_revision++; },
    r => { r.viewport_map.selection_sha256 = 'd'.repeat(64); }, r => { r.viewport_map.viewport.west -= .001; },
    r => { r.viewport_map.status = 'partial'; }, r => { r.viewport_map.display_only = false; },
    r => { r.viewport_map.geojson.features[0].properties.selected = false; },
    r => { r.viewport_map.geojson.features[0].properties.account_id = 'FOREIGN'; },
    r => { r.viewport_map.geojson.features[0].properties.raw = 'PRIVATE'; },
    r => { r.viewport_map.geojson.features[0].geometry.coordinates[0][4] = [-97.001, 32]; },
    r => { r.viewport_map.counts.visible_parcels++; }, r => { r.viewport_map.counts.captured_parcels++; }];
  for (const change of changes) {
    const h = await harness({ respond: f => { const result = structuredClone(f.result); change(result); return json(result); } });
    await assert.rejects(h.view(), /invalid_custom_cohort/); assert.equal(h.calls.length, 1);
  }
});

test('saved empty selection leaves all visible parcels unselected, never defaulting to all', async () => {
  const h = await harness({ empty: true }), out = await h.view();
  assert.ok(out.map.features.every(f => !f.properties.selected));
  assert.equal(h.summary.selected.account_count, 0);
});

test('viewport byte ceiling stays 4MB decoded; reference-only request retains 262144 byte ceiling', async () => {
  let size = 4_000_000, calls = 0;
  const t = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => { calls++; return json({}, { 'content-length': String(size) }); } });
  const io = { signal: new AbortController().signal };
  assert.deepEqual(await t('R', 'selection-viewport', {}, io), {});
  size++; await assert.rejects(t('R', 'selection-viewport', {}, io), /too large/);
  await assert.rejects(t('R', 'selection-viewport', { extra: 'é'.repeat(140000) }, io), /too large/);
  assert.equal(calls, 2);
  const stream = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => json('é'.repeat(2_000_000)) });
  await assert.rejects(stream('R', 'selection-viewport', {}, io), /too large/);
});

test('caller cancellation ends hung authentication and cancels late geometry without retry', async () => {
  let complete, cancelled = 0; const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) }), pending = h.view();
  while (!complete) await Promise.resolve(); h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  complete(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(cancelled, 1); assert.equal(h.calls.length, 1);
});
