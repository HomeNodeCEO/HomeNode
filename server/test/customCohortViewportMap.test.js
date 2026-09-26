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
