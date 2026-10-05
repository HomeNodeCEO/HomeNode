import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCustomCohortViewportMap } from '../src/features/neighborhood/customCohortViewportLoader.ts';

const context = { context_id: '71fe3e95-778b-42a8-bf4c-5dfc96de3bd7', context_revision: '1', context_sha256: 'a'.repeat(64) };
const viewport = { west: -97, south: 32, east: -96.875, north: 32.125 };
const group = { binding: { accountId: 'A', assignmentFileId: '4', contextRef: context,
  selectionRevision: 4, selectionFingerprint: 'b'.repeat(64) },
request: { accountId: 'A', assignmentFileId: '4', contextRef: context,
  selection: { revision: 4, pockets: [{ id: 'recorded-cad:one', label: 'One', account_ids: ['A'] }] } },
map_manifest: { status: 'available', counts: { captured_parcels: 100_000, captured_accounts: 2 } } };
const catalog = { pockets: [{ id: 'recorded-cad:one', account_ids: ['A'] }], unassigned: { account_ids: ['B'] } };
const ring = () => [[-96.96, 32], [-96.95, 32], [-96.95, 32.01], [-96.96, 32]];
const feature = (id = '1') => ({ type: 'Feature', id: `gis.dcad_parcels:${id}`,
  properties: { object_id: id, account_id: 'A', selected: true },
  geometry: { type: 'Polygon', coordinates: [ring()] } });
const response = (bounds, features = [feature()], captured = 100_000) => ({ status: 'available', display_only: true,
  target: { account_id: 'A', assignment_file_id: '4' }, context_ref: context,
  selection_revision: 4, selection_sha256: 'b'.repeat(64), viewport: bounds,
  geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
  geojson: { type: 'FeatureCollection', features }, counts: { visible_parcels: features.length, captured_parcels: captured } });
const dense = () => Object.assign(new Error('density'), { status: 422, errorCode: 'neighborhood_viewport_too_dense' });
const capacity = error => error?.code === 'viewport_detail_capacity_exceeded';
const load = (request, bounds = viewport, extra = {}) => loadCustomCohortViewportMap(group, catalog, bounds,
  { signal: new AbortController().signal, request, ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('normal successful viewport stays on the one-response path without copying or serializing geometry', async () => {
  const original = response(viewport); let calls = 0;
  Object.defineProperty(original.geojson.features[0].geometry.coordinates, 'toJSON', {
    value() { assert.fail('geometry must not be serialized again'); },
  });
  const checked = await load(async bounds => { calls++; assert.deepEqual(bounds, viewport); return original; });
  assert.equal(calls, 1); assert.equal(checked.status, 'available');
  assert.equal(checked.features[0].geometry.coordinates, original.geojson.features[0].geometry.coordinates);
  assert.equal(Object.isFrozen(checked.features[0].geometry.coordinates), false, 'no extra freeze/count pass for a normal pan');
});

test('exact public 422 density response triggers sequential complete tiles, without publishing a prefix', async () => {
  const last = deferred(); const calls = []; let pending = 0, maximumPending = 0, settled = false;
  const work = load(async (bounds, signal) => {
    assert.equal(signal.aborted, false); calls.push(bounds); pending++; maximumPending = Math.max(maximumPending, pending);
    try {
      if (calls.length === 1) throw dense();
      if (calls.length === 2) return response(bounds, [feature('1')]);
      await last.promise; return response(bounds, [feature('2')]);
    } finally { pending--; }
  }).then(result => { settled = true; return result; });
  await flush();
  assert.equal(calls.length, 3); assert.equal(settled, false); assert.equal(maximumPending, 1);
  assert.deepEqual(calls[1], { ...viewport, east: -96.9375 });
  assert.deepEqual(calls[2], { ...viewport, west: -96.9375 });
  last.resolve();
  const checked = await work;
  assert.equal(checked.status, 'available'); assert.deepEqual(checked.features.map(f => f.id), ['gis.dcad_parcels:1', 'gis.dcad_parcels:2']);
});

test('every other HTTP/status/code failure stops immediately rather than causing subdivision', async () => {
  for (const failure of [
    { status: 422, errorCode: 'viewport_capacity_exceeded' },
    { status: 422, errorCode: 'neighborhood_preview_capacity_exceeded' },
    { status: 422, reason: 'viewport_capacity_exceeded' },
    { status: 413, errorCode: 'neighborhood_viewport_too_dense' },
    { status: 429, errorCode: 'neighborhood_viewport_too_dense' },
    { status: 503, errorCode: 'neighborhood_viewport_too_dense' },
    { status: '422', errorCode: 'neighborhood_viewport_too_dense' },
    new TypeError('invalid_custom_cohort_viewport'),
  ]) {
    let calls = 0;
    await assert.rejects(load(async () => { calls++; throw failure; }), error => error === failure);
    assert.equal(calls, 1);
  }
});

test('larger valid camera spans are exactly partitioned before calling the 1-degree endpoint', async () => {
  const bounds = { west: -98, south: 31, east: -96, north: 33 }, calls = [];
  const checked = await load(async tile => { calls.push(tile); return response(tile, []); }, bounds);
  assert.equal(checked.status, 'available'); assert.equal(calls.length, 4);
  assert.deepEqual(calls, [
    { west: -98, south: 31, east: -97, north: 32 }, { west: -98, south: 32, east: -97, north: 33 },
    { west: -97, south: 31, east: -96, north: 32 }, { west: -97, south: 32, east: -96, north: 33 },
  ]);
});

test('a dense broad retained map starts with exact tiles instead of repeated oversized parent requests', async () => {
  const broad = structuredClone(group);
  broad.map_manifest.bounds = [[viewport.west, viewport.south], [viewport.east, viewport.north]];
  broad.map_manifest.counts.captured_parcels = 38_000;
  const calls = [];
  const checked = await loadCustomCohortViewportMap(broad, catalog, viewport, {
    signal: new AbortController().signal,
    request: async bounds => { calls.push(bounds); return response(bounds, [], 38_000); },
  });
  assert.equal(checked.status, 'available');
  assert.equal(calls.length, 8);
  assert.ok(calls.every(bounds => (bounds.east - bounds.west) * (bounds.north - bounds.south)
    === (viewport.east - viewport.west) * (viewport.north - viewport.south) / 8));
  assert.equal(calls.some(bounds => JSON.stringify(bounds) === JSON.stringify(viewport)), false);
  calls.length = 0;
  await loadCustomCohortViewportMap(broad, catalog, { ...viewport, east: viewport.west + 0.01 }, {
    signal: new AbortController().signal,
    request: async bounds => { calls.push(bounds); return response(bounds, [], 38_000); },
  });
  assert.equal(calls.length, 1, 'small camera requests remain on the one-response path');
});

test('invalid or wrapped camera bounds never reach the transport', async () => {
  for (const bounds of [null, { ...viewport, west: NaN }, { ...viewport, east: Infinity },
    { ...viewport, west: -181 }, { ...viewport, north: 91 }, { ...viewport, south: -91 },
    { ...viewport, east: 181 }, { ...viewport, east: viewport.west }, { ...viewport, north: viewport.south },
    { ...viewport, west: 170, east: -170 }, { ...viewport, extra: 1 }]) {
    let calls = 0;
    await assert.rejects(load(async () => { calls++; }, bounds), /invalid_custom_cohort_viewport/);
    assert.equal(calls, 0);
  }
});

test('overlap parcels retain all original multipart rings and coordinates exactly once', async () => {
  const source = feature(); source.geometry = { type: 'MultiPolygon', coordinates: [[ring(), ring()], [ring()]] };
  const untouched = structuredClone(source); let calls = 0;
  const checked = await load(async bounds => {
    if (++calls === 1) throw dense();
    return response(bounds, [calls === 2 ? source : structuredClone(untouched)]);
  });
  assert.equal(checked.features.length, 1); assert.deepEqual(checked.features[0], untouched);
  assert.equal(checked.features[0].geometry.coordinates, source.geometry.coordinates);
  assert.equal(Object.isFrozen(checked.features), true);
  assert.equal(Object.isFrozen(checked.features[0].geometry.coordinates[0][0][0]), true);
});

test('duplicate parcel IDs with different account, type, ring structure or exact coordinates fail closed', async () => {
  for (const change of [
    f => { f.properties.account_id = 'B'; f.properties.selected = false; },
    f => { f.geometry = { type: 'MultiPolygon', coordinates: [f.geometry.coordinates] }; },
    f => { f.geometry.coordinates.push(ring()); },
    f => { f.geometry.coordinates[0].splice(1, 0, [-96.951, 32]); },
    f => { f.geometry.coordinates[0][1][0] = -96.951; },
  ]) {
    let calls = 0;
    await assert.rejects(load(async bounds => {
      if (++calls === 1) throw dense();
      const f = feature(); if (calls === 3) change(f); return response(bounds, [f]);
    }), /invalid_custom_cohort_viewport/);
    assert.equal(calls, 3);
  }
});

test('an unavailable child discards all earlier detail and prevents later requests', async () => {
  let calls = 0;
  const checked = await load(async bounds => {
    if (++calls <= 2) throw dense();
    const body = response(bounds);
    if (calls === 4) { body.status = 'unavailable'; body.geojson = null; delete body.counts; body.reason = 'geometry_missing'; }
    return body;
  });
  assert.equal(calls, 4); assert.deepEqual(checked, { status: 'unavailable', features: [], reason: 'geometry_missing' });
});

test('a malformed or mismatched child cannot publish an otherwise successful prefix', async () => {
  for (const change of [
    body => { body.selection_sha256 = 'c'.repeat(64); },
    body => { body.context_ref = { ...context, context_sha256: 'c'.repeat(64) }; },
    body => { body.target.assignment_file_id = '5'; },
    body => { body.viewport = viewport; },
    body => { body.counts.visible_parcels++; },
  ]) {
    let calls = 0;
    await assert.rejects(load(async bounds => {
      if (++calls === 1) throw dense();
      const body = response(bounds); if (calls === 3) change(body); return body;
    }), /invalid_custom_cohort_viewport/);
    assert.equal(calls, 3);
  }
});

test('combined unique parcels cannot exceed the captured roster even when each tile fits', async () => {
  const small = structuredClone(group); small.map_manifest.counts.captured_parcels = 1; let calls = 0;
  await assert.rejects(loadCustomCohortViewportMap(small, catalog, viewport, {
    signal: new AbortController().signal,
    request: async bounds => { if (++calls === 1) throw dense(); return response(bounds, [feature(String(calls))], 1); },
  }), /invalid_custom_cohort_viewport/);
});

test('cancellation settles promptly even if a child ignores its signal; late detail cannot resume subdivision', async () => {
  const controller = new AbortController(), late = deferred(); let calls = 0;
  const work = load(async () => { if (++calls === 1) throw dense(); return late.promise; }, viewport, { signal: controller.signal });
  const rejected = assert.rejects(work, error => error?.name === 'AbortError');
  await flush(); assert.equal(calls, 2); controller.abort(); await rejected;
  late.reject(dense()); await flush(); assert.equal(calls, 2);
});

test('already aborted and synchronously aborted requests cannot publish or schedule children', async () => {
  const first = new AbortController(); first.abort(); let calls = 0;
  await assert.rejects(load(async () => { calls++; }, viewport, { signal: first.signal }), error => error?.name === 'AbortError');
  assert.equal(calls, 0);
  const second = new AbortController();
  await assert.rejects(load(async bounds => { calls++; second.abort(); return response(bounds); }, viewport,
    { signal: second.signal }), error => error?.name === 'AbortError');
  assert.equal(calls, 1);
});

test('a persistently dense tiny viewport stops at the fixed subdivision depth', async () => {
  let calls = 0;
  await assert.rejects(load(async () => { calls++; throw dense(); }), capacity);
  assert.equal(calls, 9);
});

test('dense branching and whole-world spans cannot create unbounded tiles or requests', async () => {
  let calls = 0, accepted = 0;
  await assert.rejects(load(async bounds => {
    calls++;
    if ((bounds.east - bounds.west) * (bounds.north - bounds.south) > 0.125 ** 2 / 64) throw dense();
    accepted++; return response(bounds, []);
  }), capacity);
  assert.ok(calls <= 63); assert.ok(accepted <= 32); assert.ok(accepted > 0);
  calls = 0;
  await assert.rejects(load(async bounds => { calls++; return response(bounds, []); },
    { west: -180, south: -90, east: 180, north: 90 }), capacity);
  assert.equal(calls, 0, 'impossible whole-world partition is bounded before network traffic');
});

function largeFeature(id, points, coordinate) {
  const f = feature(id);
  f.geometry.coordinates = [Array.from({ length: points }, () => [...coordinate])];
  return f;
}
test('tiled coordinate budget matches the 1-million full-map ceiling, without relaxing per-tile checks', async () => {
  let calls = 0, leaf = 0;
  await assert.rejects(load(async bounds => {
    calls++;
    if ((bounds.east - bounds.west) * (bounds.north - bounds.south) > 0.125 ** 2 / 8) throw dense();
    return response(bounds, [largeFeature(String(++leaf), 180_000, [-96, 32])]);
  }), capacity);
  assert.equal(leaf, 6); assert.ok(calls <= 15);
  await assert.rejects(load(async bounds => response(bounds, [largeFeature('1', 200_001, [-96, 32])])),
    /invalid_custom_cohort_viewport/);
});

test('tiled compact GeoJSON bytes enforce 32 MB even before reaching the coordinate ceiling', async () => {
  let leaf = 0;
  await assert.rejects(load(async bounds => {
    if ((bounds.east - bounds.west) * (bounds.north - bounds.south) > 0.125 ** 2 / 16) throw dense();
    const f = largeFeature(String(++leaf), 90_000, [-96.12345678901234, 32.123456789012345]);
    assert.ok(Buffer.byteLength(JSON.stringify(response(bounds, [f]))) < 4_000_000, 'each fixture fits the unchanged transport guard');
    return response(bounds, [f]);
  }), capacity);
  assert.equal(leaf, 9, '810,000 coordinates exceed the exact 32 MB aggregate before the 1m coordinate ceiling');
});
