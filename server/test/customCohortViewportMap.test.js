import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCustomCohortViewport, projectCustomCohortViewportMap,
  registerCustomCohortPreparedViewportMap,
  visibleCustomCohortPreparedFeatures, presentCustomCohortSelectionViewportMap,
  isCustomCohortPresentedSelectionViewport } from '../src/services/neighborhoodAssessment/customCohortViewportMap.js';

const square = (id, account, x, selected = false) => ({ type: 'Feature', id: `gis.dcad_parcels:${id}`,
  properties: { object_id: String(id), account_id: account, selected },
  geometry: { type: 'Polygon', coordinates: [[[x, 32], [x + .001, 32], [x + .001, 32.001], [x, 32.001], [x, 32]]] } });
const preview = { status: 'preview', target: { account_id: 'subject', assignment_file_id: '4' },
  context_ref: { context_id: 'context', context_revision: '1', context_sha256: 'sha' },
  summary: { binding: { selection_sha256: 'a'.repeat(64) } },
  selection_revision: 2, parcel_map: { status: 'available',
    geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
    geojson: { type: 'FeatureCollection', features: [square(1, 'subject', -96.8, true), square(2, 'other', -96.9)] },
    counts: { parcels: 2 } } };

test('new exact-selection projection freezes only its own public path and refuses hitchhiking source fields or malformed geometry', () => {
  const bounds = { west: -96.805, south: 31.99, east: -96.79, north: 32.01 };
  const own = structuredClone(preview), result = presentCustomCohortSelectionViewportMap(own, bounds);
  assert.equal(isCustomCohortPresentedSelectionViewport(result), true);
  assert.equal(isCustomCohortPresentedSelectionViewport(structuredClone(result)), false);
  assert.ok(Object.isFrozen(result.geojson.features[0].properties));
  assert.ok(Object.isFrozen(result.geojson.features[0].geometry.coordinates[0]));
  assert.equal(Object.isFrozen(own.target), false, 'caller identity is not frozen');
  assert.equal(Object.isFrozen(own.context_ref), false, 'caller context is not frozen');
  assert.equal(Object.isFrozen(own.parcel_map.geojson.features[0]), false, 'actual supplied legacy feature is not frozen');
  assert.equal(Object.isFrozen(own.parcel_map.geojson.features[0].geometry.coordinates[0]), false, 'actual supplied legacy ring is not frozen');
  const expected = structuredClone(result);
  own.target.account_id = 'changed'; own.context_ref.context_sha256 = 'e'.repeat(64);
  own.parcel_map.geojson.features[0].properties.selected = false;
  own.parcel_map.geojson.features[0].geometry.coordinates[0][0][0] -= .001;
  assert.deepEqual(result, expected, 'later source mutation cannot change the witnessed public response');
  assert.equal(Object.isFrozen(preview.parcel_map.geojson.features[0]), false, 'legacy source remains mutable');
  for (const change of [v => { v.parcel_map.geojson.features[0].properties.raw = 'PRIVATE'; },
    v => { v.parcel_map.geojson.features[0].geometry.raw = 'PRIVATE'; },
    v => { v.parcel_map.geojson.features[0].geometry.coordinates[0][4] = [-96.799, 32]; },
    v => { v.parcel_map.geojson.features.push(structuredClone(v.parcel_map.geojson.features[0])); }]) {
    const v = structuredClone(preview); change(v);
    assert.throws(() => presentCustomCohortSelectionViewportMap(v, bounds), /invalid_input/);
  }
});

test('viewport delivers only visible captured geometry with explicit display-only scope', () => {
  const result = projectCustomCohortViewportMap(preview, { west: -96.805, south: 31.99, east: -96.79, north: 32.01 });
  assert.equal(result.display_only, true);
  assert.deepEqual(result.context_ref, preview.context_ref);
  assert.equal(result.selection_revision, 2);
  assert.equal(result.selection_sha256, 'a'.repeat(64));
  assert.deepEqual(result.target, preview.target);
  assert.equal(result.counts.captured_parcels, 2);
  assert.equal(result.counts.visible_parcels, 1);
  assert.equal(result.geojson.features[0].properties.selected, true);
  assert.equal(preview.parcel_map.geojson.features.length, 2);
});

test('viewport treats edge overlap as visible and never invents a parcel', () => {
  const result = projectCustomCohortViewportMap(preview, { west: -96.799, south: 32, east: -96.798, north: 32.001 });
  assert.equal(result.counts.visible_parcels, 1);
  assert.equal(result.geojson.features[0].properties.account_id, 'subject');
  const empty = projectCustomCohortViewportMap(preview, { west: -97.5, south: 32, east: -97.4, north: 32.01 });
  assert.equal(empty.counts.visible_parcels, 0);
  assert.equal(empty.counts.captured_parcels, 2);
});

test('mutable fallback geometry is not trusted as a cached spatial index', () => {
  const changed = structuredClone(preview);
  const bounds = { west: -96.805, south: 31.99, east: -96.79, north: 32.01 };
  assert.equal(projectCustomCohortViewportMap(changed, bounds).counts.visible_parcels, 1);
  changed.parcel_map.geojson.features[1].geometry.coordinates = square(2, 'other', -96.8).geometry.coordinates;
  assert.equal(projectCustomCohortViewportMap(changed, bounds).counts.visible_parcels, 2);
});

test('verified prepared geometry uses a bounded spatial index without changing exact parcel selection', () => {
  const source = [], selected = [];
  for (let i = 0; i < 10_000; i++) {
    const x = -96.9 + i % 100 * .001, y = 32 + Math.floor(i / 100) * .001;
    const geometry = Object.freeze({ type: 'Polygon', coordinates: Object.freeze([
      Object.freeze([Object.freeze([x, y]), Object.freeze([x + .0002, y]),
        Object.freeze([x + .0002, y + .0002]), Object.freeze([x, y + .0002]), Object.freeze([x, y])]),
    ]) });
    const id = `gis.dcad_parcels:${i}`;
    source.push(Object.freeze({ id, geometry, properties: Object.freeze({ account_id: String(i), selected: false }) }));
    selected.push(Object.freeze({ id, geometry, properties: Object.freeze({ account_id: String(i), selected: i % 2 === 0 }) }));
  }
  Object.freeze(source);
  let selectedReads = 0;
  const observed = new Proxy(selected, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/.test(property)) selectedReads++;
    return Reflect.get(target, property, receiver);
  } });
  Object.freeze(observed);
  const neutral = { geojson: { features: source } }, chosen = { geojson: { features: observed } };
  assert.equal(registerCustomCohortPreparedViewportMap(chosen, neutral), true);
  selectedReads = 0;
  const target = { ...preview, parcel_map: { ...preview.parcel_map,
    geojson: { type: 'FeatureCollection', features: observed }, counts: { parcels: 10_000 } } };
  const result = projectCustomCohortViewportMap(target,
    { west: -96.899, south: 32.001, east: -96.89, north: 32.01 });
  assert.ok(result.counts.visible_parcels > 0 && result.counts.visible_parcels < 200);
  assert.ok(selectedReads < 1000, 'a small tile does not traverse the full selected roster');
  assert.equal(result.geojson.features[0].properties.selected, false);
  assert.equal(result.geojson.features[1].properties.selected, true);

  const neutralViewport = visibleCustomCohortPreparedFeatures({ status: 'available',
    geojson: { features: source } },
  { west: -96.899, south: 32.001, east: -96.89, north: 32.01 },
  Array.from({ length: 10_000 }, (_, i) => i % 2 === 0 ? String(i) : null).filter(Boolean));
  assert.deepEqual(neutralViewport.map(feature => feature.id), result.geojson.features.map(feature => feature.id));
  assert.deepEqual(neutralViewport.map(feature => feature.properties.selected),
    result.geojson.features.map(feature => feature.properties.selected));
  assert.equal(neutralViewport[0].geometry, source[Number(neutralViewport[0].properties.account_id)].geometry,
    'the exact frozen geometry is shared rather than cloned');

  const reversed = Object.freeze([...selected].reverse());
  assert.equal(registerCustomCohortPreparedViewportMap({ geojson: { features: reversed } }, neutral), false);
});

test('a large multipart parcel remains visible even when its bounds exceed the index cell ceiling', () => {
  const geometry = Object.freeze({ type: 'MultiPolygon', coordinates: Object.freeze([
    Object.freeze([Object.freeze([Object.freeze([0, 0]), Object.freeze([1, 0]),
      Object.freeze([1, 1]), Object.freeze([0, 1]), Object.freeze([0, 0])])]),
    Object.freeze([Object.freeze([Object.freeze([2, 2]), Object.freeze([3, 2]),
      Object.freeze([3, 3]), Object.freeze([2, 3]), Object.freeze([2, 2])])]),
  ]) });
  const source = Object.freeze(Array.from({ length: 1000 }, (_, i) => Object.freeze({
    id: `gis.dcad_parcels:${i}`, geometry: i === 0 ? geometry : Object.freeze(square(i, String(i), -96.8).geometry),
    properties: Object.freeze({ account_id: String(i), selected: false }),
  })));
  const selected = Object.freeze(source.map(feature => Object.freeze({ ...feature,
    properties: Object.freeze({ ...feature.properties, selected: true }) })));
  assert.equal(registerCustomCohortPreparedViewportMap({ geojson: { features: selected } },
    { geojson: { features: source } }), true);
  const target = { ...preview, parcel_map: { ...preview.parcel_map,
    geojson: { type: 'FeatureCollection', features: selected }, counts: { parcels: 1000 } } };
  const inside = projectCustomCohortViewportMap(target, { west: .2, south: .2, east: .3, north: .3 });
  assert.deepEqual(inside.geojson.features.map(feature => feature.id), ['gis.dcad_parcels:0']);
  assert.equal(projectCustomCohortViewportMap(target,
    { west: 1.2, south: 1.2, east: 1.3, north: 1.3 }).counts.visible_parcels, 0);
});

test('a polygon bounding box cannot count an invisible parcel', () => {
  const triangle = structuredClone(preview);
  triangle.parcel_map.geojson.features = [{ ...square(3, 'triangle', 0),
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] } }];
  triangle.parcel_map.counts.parcels = 1;
  const result = projectCustomCohortViewportMap(triangle, { west: .8, south: .8, east: .9, north: .9 });
  assert.equal(result.counts.visible_parcels, 0);
  assert.equal(projectCustomCohortViewportMap(triangle, { west: .1, south: .1, east: .2, north: .2 }).counts.visible_parcels, 1);
});

test('holes do not count as parcel area; a viewport touching the retained boundary does', () => {
  const withHole = structuredClone(preview);
  withHole.parcel_map.geojson.features = [{ ...square(4, 'donut', 0), geometry: { type: 'Polygon', coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]],
  ] } }];
  withHole.parcel_map.counts.parcels = 1;
  assert.equal(projectCustomCohortViewportMap(withHole, { west: 4, south: 4, east: 5, north: 5 }).counts.visible_parcels, 0);
  assert.equal(projectCustomCohortViewportMap(withHole, { west: 7.5, south: 4, east: 8.5, north: 5 }).counts.visible_parcels, 1);
});

test('multipart parcels intersect when any actual polygon touches the viewport', () => {
  const multipart = structuredClone(preview);
  multipart.parcel_map.geojson.features = [{ ...square(5, 'multipart', 0), geometry: { type: 'MultiPolygon', coordinates: [
    [[[0, 0], [1, 0], [0, 1], [0, 0]]],
    [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]],
  ] } }];
  multipart.parcel_map.counts.parcels = 1;
  assert.equal(projectCustomCohortViewportMap(multipart, { west: .8, south: .8, east: .9, north: .9 }).counts.visible_parcels, 0);
  assert.equal(projectCustomCohortViewportMap(multipart, { west: 2.4, south: 2.4, east: 2.5, north: 2.5 }).counts.visible_parcels, 1);
});

test('viewport rejects broad, malformed, and non-finite bounds', () => {
  for (const value of [null, {}, { west: -97, south: 32, east: -95, north: 33 },
    { west: -97, south: 32, east: -96, north: 32 },
    { west: -97, south: 32, east: Infinity, north: 33 },
    { west: -97, south: 32, east: -96, north: 33, extra: 1 }]) {
    assert.throws(() => prepareCustomCohortViewport(value), error => error.reason === 'invalid_input');
  }
});

test('unavailable captured map remains unavailable; no substitute geometry is returned', () => {
  const result = projectCustomCohortViewportMap({ ...preview, parcel_map: { status: 'unavailable', reason: 'geometry_missing',
    geojson: null, geometry_semantics: preview.parcel_map.geometry_semantics } },
  { west: -97, south: 32, east: -96, north: 33 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.geojson, null);
  assert.equal(result.reason, 'geometry_missing');
});
