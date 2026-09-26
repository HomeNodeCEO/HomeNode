import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortMapManifest } from '../src/services/neighborhoodAssessment/customCohortMapManifest.js';

const ref = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const catalog = { binding: { context_ref: ref }, subject_membership: { account_id: 'A' },
  pockets: [{ id: 'recorded-cad:one', label: 'One', county: 'Dallas', account_ids: ['A', 'B'] },
    { id: 'recorded-cad:two', label: 'Two', county: 'Dallas', account_ids: ['C'] }],
  unassigned: { account_ids: ['D'] } };
const feature = (id, account, x) => ({ type: 'Feature', id: `gis.dcad_parcels:${id}`,
  properties: { object_id: String(id), account_id: account, selected: false },
  geometry: { type: 'Polygon', coordinates: [[[x, 32], [x + .01, 32], [x + .01, 32.01], [x, 32.01], [x, 32]]] } });
const map = { status: 'available', geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
  geojson: { type: 'FeatureCollection', features: [feature(2, 'B', -96.7), feature(1, 'A', -96.8),
    feature(3, 'C', -96.9), feature(4, 'D', -97)] }, counts: { parcels: 4, accounts: 4 } };

test('manifest keeps exact capture bounds, subject marker, and one retained anchor per named group', () => {
  const result = buildCustomCohortMapManifest(catalog, map);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.context_ref, ref);
  assert.deepEqual(result.bounds, [[-97, 32], [-96.69, 32.01]]);
  assert.deepEqual(result.counts, { captured_parcels: 4, captured_accounts: 4 });
  assert.deepEqual(result.labels.features.map(label => label.properties.pocket_id), ['recorded-cad:one', 'recorded-cad:two']);
  assert.equal(result.labels.features[0].properties.account_id, 'A');
  assert.deepEqual(result.labels.features[0].geometry.coordinates, [-96.8, 32]);
  assert.deepEqual(result.subject_parcels, [{ parcel_id: 'gis.dcad_parcels:1', account_id: 'A', coordinates: [-96.8, 32],
    anchor_basis: 'retained_exterior_ring_vertex' }]);
  assert.deepEqual(result.unlabelled_group_ids, []);
  assert.equal(map.geojson.features.length, 4);
});

test('manifest uses the exterior ring for labels but includes holes in the full captured bounds', () => {
  const changed = structuredClone(map);
  changed.geojson.features[1].geometry.coordinates.push([[-96.795, 32.002], [-96.792, 32.002],
    [-96.792, 32.004], [-96.795, 32.004], [-96.795, 32.002]]);
  const result = buildCustomCohortMapManifest(catalog, changed);
  assert.deepEqual(result.labels.features[0].geometry.coordinates, [-96.8, 32]);
  assert.deepEqual(result.bounds, [[-97, 32], [-96.69, 32.01]]);
});

test('manifest refuses a catalog/map membership mismatch instead of inventing labels', () => {
  const changed = structuredClone(map);
  changed.geojson.features[0].properties.account_id = 'OTHER';
  assert.equal(buildCustomCohortMapManifest(catalog, changed).reason, 'catalog_geometry_mismatch');
});

test('unavailable captured geometry remains unavailable', () => {
  const result = buildCustomCohortMapManifest(catalog, { status: 'unavailable', reason: 'geometry_missing',
    geometry_semantics: map.geometry_semantics, geojson: null });
  assert.deepEqual(result, { status: 'unavailable', context_ref: ref,
    geometry_semantics: map.geometry_semantics, reason: 'geometry_missing' });
});

test('a subject outside the captured roster has no invented subject marker', () => {
  const changed = structuredClone(catalog);
  changed.subject_membership.account_id = 'OUTSIDE';
  const result = buildCustomCohortMapManifest(changed, map);
  assert.deepEqual(result.subject_parcels, []);
  assert.equal(result.counts.captured_accounts, 4);
});
