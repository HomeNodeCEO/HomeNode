import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import * as loader from '../src/features/neighborhood/customCohortViewportLoader.ts';
import * as marketTransport from '../src/features/neighborhood/customCohortGroupMarketTransport.ts';
import { createCustomWorkspaceRequestLane } from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { selectionMapOpeningFixture } from '../../server/test/fixtures/customCohortSelectionMapOpeningFixture.js';
import { selectionSummaryTransportFixture } from '../../server/test/fixtures/customCohortSelectionSummaryTransportFixture.js';
import { selectionViewportFixture } from '../../server/test/fixtures/customCohortSelectionViewportFixture.js';
import { presentCustomCohortSelectionViewportMap } from '../../server/src/services/neighborhoodAssessment/customCohortViewportMap.js';
import { presentCustomCohortGroupMapOpening } from '../../server/src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';

const load = (name, dependencies) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(dependencies, key), `unexpected map import ${key}`); return dependencies[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
const displayModule = load('customCohortGroupDisplay', { './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection });
const mapView = load('customCohortGroupMapView', { './customCohortGroupDisplay.ts': displayModule, './customCohortViewportLoader.ts': loader });
const marketView = load('customCohortGroupMarketView', { './customCohortGroupDisplay.ts': displayModule, './customCohortGroupMarketTransport.ts': marketTransport });
const presentation = load('customCohortMapPresentation', { './customCohortPocketCatalog.ts': catalogHelpers });
const legacy = load('customWorkspaceApi', { './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport });
const { createCustomCohortGroupWorkspaceApi: createApi } = load('customCohortGroupWorkspaceApi', {
  './customWorkspaceApi.ts': legacy, './customCohortPreviewTransport.ts': transport,
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customCohortGroupDisplay.ts': displayModule, './customCohortGroupMapView.ts': mapView,
  './customCohortGroupMarketView.ts': marketView, './customCohortGroupMarketTransport.ts': marketTransport,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = () => new Promise(resolve => setImmediate(resolve));
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const dense = () => Object.assign(new Error('density'), { status: 422, errorCode: 'neighborhood_viewport_too_dense' });
async function fixture(options = {}) {
  options = { assignmentFileId: '37', ...options };
  const f = await selectionMapOpeningFixture(options), summary = await selectionSummaryTransportFixture({ accountId: f.accountId, ...options });
  const v = await selectionViewportFixture({ accountId: f.accountId, ...options });
  const rawCatalog = { status: 'catalog', subject_freshness: 'matched', target: { account_id: f.accountId, assignment_file_id: f.request.assignment_file_id },
    context_ref: f.request.context_ref, selection_revision: f.request.selection_ref.selection_revision, apply: { status: 'blocked' },
    catalog: { ...f.catalog, binding: { ...f.catalog.binding, selection_revision: f.request.selection_ref.selection_revision },
      pockets: f.catalog.pockets.map(p => ({ ...p, disposition: 'needs_review' })), unassigned: { ...f.catalog.unassigned, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 3, unassigned_account_count: 0 }, limitations: [] } };
  const catalog = catalogHelpers.checkCustomCohortPocketCatalog(rawCatalog, { accountId: f.accountId,
    assignmentFileId: f.request.assignment_file_id, contextRef: f.request.context_ref,
    selection: { revision: f.request.selection_ref.selection_revision, pockets: [] } });
  const value = { target: { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id, sessionKey: 'test-map-session' },
    workspaceRevision: 5, checkpoint: { workspace_version: 7, pending_capture: null,
      active: { context_ref: f.request.context_ref, selection_ref: f.request.selection_ref, observation_period: summary.result.summary.observation_period } },
    catalog, selected: f.saved };
  const calls = [];
  const api = createApi({ urlFor: path => `https://example.invalid${path}`, editorKeyForSave: () => { assert.fail('no generic writer'); },
    request: async (url, init) => {
      const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push({ action, body, signal: init.signal });
      if (action === 'selection-preview') return json(summary.result);
      if (action === 'selection-map-opening') {
        return json(options.unavailable ? { ...f.result, map_opening: presentCustomCohortGroupMapOpening({ ...f.projection,
          manifest: { status: 'unavailable', context_ref: f.request.context_ref, geometry_semantics: f.projection.manifest.geometry_semantics,
            reason: 'geometry_missing' } }) } : f.result);
      }
      if (action === 'selection-viewport') return options.respond ? options.respond(v, body, init, calls)
        : json({ ...v.result, viewport_map: { ...v.result.viewport_map, viewport: body.viewport } });
      assert.fail(`unexpected map request ${action}`);
    } });
  return { ...f, v, numerical: summary.result, value, api, calls, display: await api.display(value, io()) };
}

test('exact map projection uses the composed display and original labels/scores with no fabricated legacy request', async () => {
  const f = await fixture(), view = mapView.prepareCustomCohortGroupMapView(f.display);
  assert.equal(view, mapView.prepareCustomCohortGroupMapView(f.display));
  assert.equal(view.display, f.display); assert.equal(view.group.binding, f.display.observations.binding);
  assert.equal(view.group.map_manifest, f.display.manifest);
  assert.deepEqual(Object.keys(view.group).sort(), ['binding', 'map_manifest', 'parcel_map']);
  assert.equal(Object.hasOwn(view.group, 'request'), false);
  assert.deepEqual(view.included_recorded_group_ids, f.saved.included_recorded_group_ids);
  assert.equal(view.isSelectedAccount('10000000000000000'), true); assert.equal(view.isSelectedAccount('10000000000000001'), true);
  assert.equal(view.isSelectedAccount('10000000000000002'), false); assert.equal(view.isSelectedAccount('FOREIGN'), false);
  const shown = presentation.buildCustomCohortMapPresentation({ group: view.group, catalog: f.display.catalog });
  assert.equal(shown.status, 'available'); assert.deepEqual(shown.labels, f.display.manifest.labels);
  assert.deepEqual(shown.bounds, f.display.manifest.bounds); assert.equal(f.display.observations.summary.selected.account_count, 2);
  assert.equal(f.calls.length, 2); assert.ok(Object.isFrozen(view) && Object.isFrozen(view.group));
  assert.throws(() => mapView.prepareCustomCohortGroupMapView(structuredClone(f.display)), /invalid_custom_cohort_group_display/);
});

test('one exact-reference pan sends no memberships and freezes every original ring without limiting the analytical population', async () => {
  const f = await fixture(), before = f.display.observations, options = io();
  const map = await f.api.map(f.display, f.v.request.viewport, options);
  assert.deepEqual(map.features.map(p => p.properties.selected), [true, false]);
  assert.equal(map.features.length, 2); assert.equal(before.summary.selected.account_count, 2);
  assert.equal(before.summary.all.account_count, 3); assert.equal(f.display.observations, before);
  assert.deepEqual(map.features, f.v.result.viewport_map.geojson.features);
  const sent = f.calls.at(-1); assert.equal(sent.action, 'selection-viewport');
  assert.deepEqual(sent.body, f.v.request); assert.equal(sent.signal, options.signal);
  assert.doesNotMatch(JSON.stringify(sent.body), /account_ids|included_recorded_group_ids|operation_id/);
  assert.ok(Object.isFrozen(map.features) && Object.isFrozen(map.features[0]) && Object.isFrozen(map.features[0].properties)
    && Object.isFrozen(map.features[0].geometry.coordinates[0][0]));
});

test('deliberate empty has no selected outlines and preserves the complete map labels and subject', async () => {
  const f = await fixture({ empty: true }), view = mapView.prepareCustomCohortGroupMapView(f.display);
  const map = await f.api.map(f.display, f.v.request.viewport, io());
  assert.ok(map.features.every(p => !p.properties.selected)); assert.deepEqual(view.included_recorded_group_ids, []);
  assert.equal(view.isSelectedAccount(f.accountId), false); assert.equal(view.group.map_manifest.subject_parcels.length, 1);
  assert.equal(view.group.map_manifest.labels.features.length, 2); assert.equal(f.display.observations.summary.selected.account_count, 0);
});

test('clones, raw envelopes, invalid bounds/getters and nonfinite owner deadlines never reach map I/O', async () => {
  const f = await fixture(), read = mapView.createCustomCohortGroupMapReader({ viewport() { assert.fail('map I/O'); } });
  for (const value of [null, structuredClone(f.display), f.result]) await assert.rejects(read(value, f.v.request.viewport, io()));
  for (const bounds of [{ ...f.v.request.viewport, west: NaN }, { ...f.v.request.viewport, east: 181 },
    { ...f.v.request.viewport, extra: true }, Object.defineProperty({ ...f.v.request.viewport }, 'west',
      { enumerable: true, get() { assert.fail('getter'); } })]) await assert.rejects(read(f.display, bounds, io()));
  for (const options of [{ ...io(), deadline: Infinity }, { ...io(), deadline: 0 }, { ...io(), signal: null }])
    await assert.rejects(read(f.display, f.v.request.viewport, options));
  assert.equal(f.calls.length, 2);
});

test('unavailable original geometry returns honest absence without a viewport fetch or a synthetic outline', async () => {
  const f = await fixture({ unavailable: true });
  const map = await f.api.map(f.display, f.v.request.viewport, io());
  assert.deepEqual(map, { status: 'unavailable', features: [], reason: 'geometry_missing' });
  assert.equal(f.calls.length, 2); assert.equal(f.display.observations.summary.selected.account_count, 2);
});

test('the normal API retains the exact density distinction and serially merges complete leaves before publishing', async () => {
  const gate = deferred(); let started = 0, settled = false;
  const f = await fixture({ respond: async (v, body) => {
    if (++started === 1) return json({ error: 'neighborhood_viewport_too_dense' }, 422);
    if (started === 2) await gate.promise;
    return json({ ...v.result, viewport_map: { ...v.result.viewport_map, viewport: body.viewport } });
  } });
  const work = f.api.map(f.display, f.v.request.viewport, io()).then(r => { settled = true; return r; });
  for (let i = 0; i < 100 && started < 2; i++) await drain();
  assert.equal(started, 2); assert.equal(settled, false);
  gate.resolve(); const map = await work;
  assert.equal(started, 3); assert.equal(map.features.length, 2); assert.deepEqual(map.features, f.v.result.viewport_map.geojson.features);
  assert.ok(f.calls.slice(2).every(c => JSON.stringify(c.body.selection_ref) === JSON.stringify(f.request.selection_ref)));
});

test('foreign references, counts, membership, flags and incomplete child maps never become a complete map', async () => {
  for (const change of [r => { r.selection_ref.selection_revision++; }, r => { r.viewport_map.counts.captured_parcels++; },
    r => { r.viewport_map.geojson.features[0].properties.selected = false; }, r => { r.viewport_map.status = 'partial'; },
    r => { r.viewport_map.target.assignment_file_id = '8'; }, r => { r.viewport_map.geojson.features[0].properties.account_id = 'FOREIGN'; }]) {
    const f = await fixture({ respond: v => { const r = structuredClone(v.result); change(r); return json(r); } });
    await assert.rejects(f.api.map(f.display, f.v.request.viewport, io())); assert.equal(f.calls.length, 3);
  }
});

test('only exact density is split; generic errors, authorization, conflict and wrong-status lookalikes stop once', async () => {
  for (const [status, error] of [[403, 'neighborhood_access_denied'], [409, 'neighborhood_workspace_changed'],
    [503, 'neighborhood_service_busy'], [422, 'other_error'], [503, 'neighborhood_viewport_too_dense']]) {
    const f = await fixture({ respond: () => json({ error }, status) });
    await assert.rejects(f.api.map(f.display, f.v.request.viewport, io())); assert.equal(f.calls.length, 3);
  }
});

test('exhausted exact geometry budgets keep a sanitized detail-capacity signal, never a partial successful map', async () => {
  const f = await fixture({ respond: () => json({ error: 'neighborhood_viewport_too_dense' }, 422) });
  await assert.rejects(f.api.map(f.display, f.v.request.viewport, io()), error => error.code === 'viewport_detail_capacity_exceeded'
    && error.workspaceCode === 'viewport_detail_capacity_exceeded' && error.status === 422);
  assert.ok(f.calls.length > 3 && f.calls.length <= 65); assert.equal(f.display.observations.summary.selected.account_count, 2);
});

test('shared host lane keeps an ignored pan quarantined after subscriber cancellation and before save/flush', async () => {
  const gate = deferred(), f = await fixture({ respond: async v => { await gate.promise; return json(v.result); } });
  const lane = createCustomWorkspaceRequestLane(), subscriber = new AbortController(); let finished = false, next = false;
  try {
    const work = lane.run(inner => f.api.map(f.display, f.v.request.viewport, { ...inner, deadline: performance.now() + 60_000 }),
      { signal: subscriber.signal });
    for (let i = 0; i < 100 && f.calls.length < 3; i++) await drain();
    assert.equal(f.calls.length, 3); subscriber.abort(); await assert.rejects(work, { name: 'AbortError' });
    const following = lane.run(async () => { next = true; return 'following'; }, io());
    const flushing = lane.flush().then(() => { finished = true; }); await drain();
    assert.equal(next, false); assert.equal(finished, false); assert.equal(lane.isIdle(), false);
    gate.resolve(); assert.equal(await following, 'following'); await flushing;
    assert.equal(finished, true); assert.equal(lane.isIdle(), true);
  } finally { lane.dispose(); }
});

test('ignored port cancellation does not settle the exact tile owner or schedule a sibling until actual settlement', async () => {
  const f = await fixture(), gate = deferred(), controller = new AbortController(); let calls = 0, settled = false;
  const read = mapView.createCustomCohortGroupMapReader({ viewport: async () => { calls++; await gate.promise;
    return { selection_ref: f.display.active.selection_ref, map: Object.freeze({ status: 'available', features: [] }) }; } });
  const work = read(f.display, f.v.request.viewport, { ...io(), signal: controller.signal }).finally(() => { settled = true; });
  const failure = assert.rejects(work, { name: 'AbortError' });
  await drain(); assert.equal(calls, 1); controller.abort(); await drain(); assert.equal(settled, false);
  gate.resolve(); await failure; assert.equal(calls, 1);
});

test('readonly int64 and maximum selection revisions remain exact; no writer or UUID is used', async () => {
  const f = await fixture({ assignmentFileId: '9007199254740993', revision: 2147483647 });
  const map = await f.api.map(f.display, f.v.request.viewport, io()); assert.equal(map.status, 'available');
  assert.ok(f.calls.every(c => c.body.assignment_file_id === '9007199254740993'));
  assert.ok(f.calls.every(c => c.body.selection_ref.selection_revision === 2147483647));
});

test('multi-tile overlaps preserve exact holes and multipart coordinates once, but any changed duplicate refuses the whole view', async () => {
  for (const altered of [false, true]) {
    let calls = 0; const f = await fixture();
    const source = structuredClone(f.v.result.viewport_map.geojson.features[0]);
    source.geometry = { type: 'MultiPolygon', coordinates: [[source.geometry.coordinates[0], source.geometry.coordinates[0]],
      [source.geometry.coordinates[0]]] };
    const read = mapView.createCustomCohortGroupMapReader({ viewport: async () => {
      if (++calls === 1) throw dense();
      const feature = structuredClone(source); if (altered && calls === 3) feature.geometry.coordinates[0][0][1][0] += .00001;
      return { selection_ref: f.display.active.selection_ref, map: Object.freeze({ status: 'available', features: [feature] }) };
    } });
    if (altered) await assert.rejects(read(f.display, f.v.request.viewport, io()), /invalid_custom_cohort_viewport/);
    else {
      const result = await read(f.display, f.v.request.viewport, io());
      assert.deepEqual(result.features, [source]); assert.equal(Object.isFrozen(result.features[0].geometry.coordinates[0][0][0]), true);
    }
    assert.equal(calls, 3);
  }
});

test('shared kernel preserves legacy ceilings and refuses one-over before ports; broad exact reads have only one tile in flight', async () => {
  const bounds = { west: -97, south: 32, east: -96.9, north: 32.1 }, gate = deferred(); let active = 0, maximum = 0, started = 0;
  const manifest = Object.freeze({ status: 'available', counts: { captured_parcels: 38000, captured_accounts: 38000 },
    bounds: [[bounds.west, bounds.south], [bounds.east, bounds.north]] });
  const work = loader.loadCustomCohortCheckedViewportTiles(manifest, bounds, { ...io(), request: async () => {
    started++; active++; maximum = Math.max(maximum, active);
    try { await gate.promise; return Object.freeze({ status: 'available', features: [] }); } finally { active--; }
  } });
  await drain(); assert.equal(started, 1); gate.resolve(); assert.equal((await work).status, 'available');
  assert.equal(started, 8); assert.equal(maximum, 1);
  await assert.rejects(loader.loadCustomCohortCheckedViewportTiles(Object.freeze({ ...manifest,
    counts: { captured_parcels: 100001 } }), bounds, { ...io(), request() { assert.fail('one-over port'); } }), /invalid_custom_cohort_viewport/);
});

test('actual retained viewport producer accepts exact complete leaf union without changing stock or summary', async () => {
  const f = await fixture(); let calls = 0;
  const full = f.v.result.viewport_map.geojson;
  const read = mapView.createCustomCohortGroupMapReader({ viewport: async (input, saved, catalog, count, options) => {
    assert.deepEqual(input.selectionRef, f.request.selection_ref); assert.equal(saved, f.display.selected);
    assert.equal(catalog, f.display.catalog); assert.equal(count, 3); assert.ok(options.signal instanceof AbortSignal);
    if (++calls === 1) throw dense();
    const raw = presentCustomCohortSelectionViewportMap({ ...f.numerical,
      parcel_map: { status: 'available', geometry_semantics: f.v.result.viewport_map.geometry_semantics, geojson: full, counts: { parcels: 3 } } }, input.viewport);
    const t = selection.createCustomCohortRecordedGroupTransport({ urlFor: p => p,
      request: async () => json({ status: 'viewport', authority: 'not_established', selection_ref: f.request.selection_ref, viewport_map: raw }) });
    return t.viewport(input, saved, catalog, count, options);
  } });
  const before = JSON.stringify(f.display.observations); const map = await read(f.display, f.v.request.viewport, io());
  assert.deepEqual(map.features, full.features); assert.equal(JSON.stringify(f.display.observations), before); assert.equal(calls, 3);
});
