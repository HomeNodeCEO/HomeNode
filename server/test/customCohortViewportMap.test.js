import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCustomCohortViewport, projectCustomCohortViewportMap } from '../src/services/neighborhoodAssessment/customCohortViewportMap.js';

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
