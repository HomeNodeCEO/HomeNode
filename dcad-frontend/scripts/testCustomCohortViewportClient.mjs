import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCustomCohortViewportResponse } from '../src/features/neighborhood/customCohortViewportClient.ts';

const context = { context_id: '71fe3e95-778b-42a8-bf4c-5dfc96de3bd7', context_revision: '1', context_sha256: 'a'.repeat(64) };
const viewport = { west: -97, south: 32, east: -96.9, north: 32.1 };
const selected = { revision: 4, pockets: [{ id: 'recorded-cad:one', label: 'One', account_ids: ['A'] }] };
const group = { binding: { accountId: 'A', assignmentFileId: '4', contextRef: context,
  selectionRevision: 4, selectionFingerprint: 'b'.repeat(64) },
request: { accountId: 'A', assignmentFileId: '4', contextRef: context, selection: selected },
  map_manifest: { status: 'available', counts: { captured_parcels: 2, captured_accounts: 2 } } };
const catalog = { pockets: [{ id: 'recorded-cad:one', account_ids: ['A'] }], unassigned: { account_ids: ['B'] } };
const feature = (account = 'A', selected = true) => ({ type: 'Feature', id: 'gis.dcad_parcels:1',
  properties: { object_id: '1', account_id: account, selected },
  geometry: { type: 'Polygon', coordinates: [[[-96.96, 32], [-96.95, 32], [-96.95, 32.01], [-96.96, 32]]] } });
const response = () => ({ status: 'available', display_only: true, target: { account_id: 'A', assignment_file_id: '4' },
  context_ref: context, selection_revision: 4, selection_sha256: 'b'.repeat(64), viewport,
  geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
  geojson: { type: 'FeatureCollection', features: [feature()] }, counts: { visible_parcels: 1, captured_parcels: 2 } });

test('visible detail is bound to the same captured context, selection and catalog accounts', () => {
  const checked = checkCustomCohortViewportResponse(response(), group, catalog, viewport);
  assert.equal(checked.status, 'available'); assert.equal(checked.features.length, 1);
  for (const change of [
    value => { value.selection_sha256 = 'c'.repeat(64); },
    value => { value.selection_revision++; },
    value => { value.viewport.west = -96.99; },
    value => { value.geojson.features[0].properties.account_id = 'FOREIGN'; },
    value => { value.geojson.features[0].properties.selected = false; },
    value => { value.counts.captured_parcels = 3; },
    value => { value.geojson.features[0].geometry.coordinates[0][3] = [-96.95, 32]; },
  ]) {
    const changed = structuredClone(response()); change(changed);
    assert.throws(() => checkCustomCohortViewportResponse(changed, group, catalog, viewport),
      /invalid_custom_cohort_viewport/);
  }
});

test('unavailable detail does not invent outlines', () => {
  const value = response(); value.status = 'unavailable'; value.geojson = null;
  value.reason = 'geometry_missing'; delete value.counts;
  assert.deepEqual(checkCustomCohortViewportResponse(value, group, catalog, viewport),
    { status: 'unavailable', features: [], reason: 'geometry_missing' });
});
