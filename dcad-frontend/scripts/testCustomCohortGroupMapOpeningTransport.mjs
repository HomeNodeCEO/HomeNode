import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupTransport } from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomCohortJsonTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { selectionMapOpeningFixture } from '../../server/test/fixtures/customCohortSelectionMapOpeningFixture.js';
import { presentCustomCohortGroupMapOpening } from '../../server/src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function harness(options = {}) {
  const f = await selectionMapOpeningFixture(options), calls = [], abort = new AbortController();
  const transport = createCustomCohortRecordedGroupTransport({ urlFor: p => `https://example.invalid${p}`,
    request: async (url, init) => { calls.push({ url, init }); return options.respond ? options.respond(f) : json(f.result); } });
  const input = () => ({ accountId: f.accountId, assignmentFileId: f.request.assignment_file_id,
    contextRef: structuredClone(f.request.context_ref), selectionRef: structuredClone(f.request.selection_ref) });
  const open = (r = input(), saved = f.saved, catalog = f.catalog) => transport.opening(r, saved, catalog, { signal: abort.signal });
  return { ...f, calls, abort, input, open };
}

test('compact opening sends only exact reference; all groups/offscreen anchors remain despite selected subset', async () => {
  const h = await harness(), out = await h.open();
  assert.deepEqual(out.selection_ref, h.request.selection_ref); assert.deepEqual(out.manifest, h.result.map_opening.manifest);
  assert.equal(out.manifest.labels.features.length, 2); assert.equal(out.manifest.subject_parcels.length, 1);
  assert.equal(h.summary.selected.account_count, 2); assert.equal(h.summary.all.account_count, 3);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request);
  assert.ok(h.calls[0].url.endsWith('/neighborhood-cohort/selection-map-opening'));
  assert.equal(h.calls[0].init.cache, 'no-store'); assert.equal(h.calls[0].init.signal, h.abort.signal);
  assert.doesNotMatch(h.calls[0].init.body, /account_ids|included_recorded_group_ids|source_rows|viewport/);
  assert.ok(Object.isFrozen(out.manifest.subject_parcels[0].coordinates));
  assert.ok(Object.isFrozen(out.manifest.labels.features[0].properties));
  assert.equal(Object.hasOwn(out, 'summary'), false);
});

test('saved empty and already acknowledged write references open the same neutral display without choosing all', async () => {
  const empty = await harness({ empty: true }), selected = await harness();
  assert.deepEqual((await empty.open()).manifest, (await selected.open()).manifest);
  assert.equal(empty.summary.selected.account_count, 0);
  const write = { ...selected.saved, status: 'stored', operation_id: '70000000-0000-4000-8000-000000000009' };
  assert.deepEqual(await selected.open(selected.input(), write), await selected.open());
});

test('request, saved intent, display names and membership are pinned before authentication/network awaits', async () => {
  let complete;
  const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) }), r = h.input();
  const pending = h.open(r);
  r.selectionRef.manifest_ref.content_sha256 = 'd'.repeat(64); r.contextRef.context_sha256 = 'e'.repeat(64);
  h.saved.included_recorded_group_ids.length = 0; h.catalog.pockets[0].label = 'Later edit';
  h.catalog.pockets[0].account_ids.length = 0;
  while (!complete) await Promise.resolve(); complete(json(h.result));
  assert.equal((await pending).manifest.labels.features[0].properties.label, 'One');
  assert.deepEqual(JSON.parse(h.calls[0].init.body), h.request);
});

test('missing, unknown, foreign or injected selections never obtain authentication or a default population', async () => {
  const h = await harness(), r = h.input();
  for (const change of [{ selectionRef: null }, { account_ids: [] }, { includedRecordedGroupIds: [] }, { viewport: {} }])
    await assert.rejects(h.open({ ...r, ...change }), /invalid_custom_cohort/);
  await assert.rejects(h.open(r, { ...h.saved, status: 'absent', selection_ref: null, included_recorded_group_ids: null }), /invalid_custom_cohort/);
  await assert.rejects(h.open(r, { ...h.saved, included_recorded_group_ids: [`recorded-cad:${'e'.repeat(64)}`] }), /invalid_custom_cohort/);
  await assert.rejects(h.open(r, h.saved, { ...h.catalog, subject_membership: { account_id: 'FOREIGN' } }), /invalid_custom_cohort/);
  await assert.rejects(h.open(r, h.saved, { ...h.catalog, catalog_version: 2 }), /invalid_custom_cohort/);
  assert.equal(h.calls.length, 0);
});

test('partial/foreign/unbound/raw/wrong-name opening metadata cannot paint the current catalog', async () => {
  for (const change of [r => { r.status = 'applied'; }, r => { r.authority = 'established'; }, r => { r.summary = {}; },
    r => { r.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64); }, r => { r.map_opening.raw = 'PRIVATE'; },
    r => { r.map_opening.display_only = false; }, r => { r.map_opening.target.assignment_file_id = '8'; },
    r => { r.map_opening.context_ref.context_sha256 = 'd'.repeat(64); }, r => { r.map_opening.selection_revision++; },
    r => { r.map_opening.selection_sha256 = 'd'.repeat(64); }, r => { r.map_opening.manifest.context_ref.context_sha256 = 'd'.repeat(64); },
    r => { r.map_opening.manifest.labels.features.pop(); }, r => { r.map_opening.manifest.subject_parcels = []; },
    r => { r.map_opening.manifest.counts.captured_accounts--; },
    r => { r.map_opening.manifest.labels.features[0].properties.label = 'Wrong'; },
    r => { r.map_opening.manifest.labels.features[0].properties.account_id = 'FOREIGN'; },
    r => { r.map_opening.manifest.labels.features[0].properties.parcel_id = 'somewhere'; },
    r => { r.map_opening.manifest.labels.features[0].properties.raw = 'PRIVATE'; },
    r => { r.map_opening.manifest.subject_parcels[0].coordinates = [0, 0]; },
    r => { r.map_opening.manifest.subject_parcels[0].parcel_id = 'fake'; }]) {
    const h = await harness({ respond: f => { const r = structuredClone(f.result); change(r); return json(r); } });
    await assert.rejects(h.open(), /invalid_custom_cohort/); assert.equal(h.calls.length, 1);
  }
});

test('original unavailable geometry is retained without inventing labels or numerical readiness', async () => {
  const h = await harness({ respond: f => json({ ...f.result, map_opening: presentCustomCohortGroupMapOpening({ ...f.projection,
    manifest: { status: 'unavailable', context_ref: f.request.context_ref, geometry_semantics: f.projection.manifest.geometry_semantics,
      reason: 'geometry_missing' } }) }) });
  const out = await h.open(); assert.equal(out.manifest.status, 'unavailable'); assert.equal(out.manifest.reason, 'geometry_missing');
});

test('compact opening decoded response and request ceilings are independent of full-map limits', async () => {
  let length = 4_100_000, calls = 0;
  const post = createCustomCohortJsonTransport({ urlFor: p => p, request: async () => {
    calls++; return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(length) } });
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await post('A', 'selection-map-opening', {}, { signal }), {});
  length++; await assert.rejects(post('A', 'selection-map-opening', {}, { signal }), /too large/);
  await assert.rejects(post('A', 'selection-map-opening', { text: 'é'.repeat(140_000) }, { signal }), /too large/);
  assert.equal(calls, 2);
});

test('exact stale/access/interruption errors are not retried; ignored late requests cannot display after cancellation', async () => {
  for (const [status, error] of [[409, 'neighborhood_selection_changed'], [403, 'neighborhood_access_denied'], [503, 'neighborhood_request_interrupted']]) {
    const h = await harness({ respond: () => json({ error }, status) });
    await assert.rejects(h.open(), err => err.status === status && err.errorCode === error); assert.equal(h.calls.length, 1);
  }
  let complete;
  const h = await harness({ respond: () => new Promise(resolve => { complete = resolve; }) });
  const pending = h.open(); while (!complete) await Promise.resolve();
  h.abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); complete(json(h.result));
  assert.equal(h.calls.length, 1);
});
