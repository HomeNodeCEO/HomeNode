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

test('transport-owned parsed geometry is checked without reserializing the payload', () => {
  const value = response();
  Object.defineProperty(value, 'toJSON', { value() { assert.fail('viewport validation must not stringify parsed geometry'); } });
  assert.equal(checkCustomCohortViewportResponse(value, group, catalog, viewport).features.length, 1);
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function countedAccounts(values, onRead) {
  const accounts = [...values];
  Object.defineProperty(accounts, Symbol.iterator, { value: function* () { onRead(); yield* values; } });
  return accounts;
}
test('immutable catalog and request lookup sets are prepared once across viewport checks, independently replaced', () => {
  let memberReads = 0, selectedReads = 0;
  const nextCatalog = structuredClone(catalog), nextGroup = structuredClone(group);
  nextCatalog.pockets[0].account_ids = countedAccounts(['A'], () => memberReads++);
  nextGroup.request.selection.pockets[0].account_ids = countedAccounts(['A'], () => selectedReads++);
  freeze(nextCatalog); freeze(nextGroup);
  for (let i = 0; i < 3; i++) checkCustomCohortViewportResponse(response(), nextGroup, nextCatalog, viewport);
  assert.equal(memberReads, 1); assert.equal(selectedReads, 1);
  const unselectedGroup = freeze({ ...nextGroup, request: { ...nextGroup.request,
    selection: { ...nextGroup.request.selection, pockets: [] } } });
  assert.throws(() => checkCustomCohortViewportResponse(response(), unselectedGroup, nextCatalog, viewport), /invalid_custom_cohort_viewport/);
  const unselected = response(); unselected.geojson.features[0].properties.selected = false;
  checkCustomCohortViewportResponse(unselected, unselectedGroup, nextCatalog, viewport);
  assert.equal(memberReads, 1, 'a changed selection reuses only the unchanged catalog index');
  const replacedCatalog = freeze({ ...nextCatalog, pockets: [], unassigned: { account_ids: ['B'] } });
  assert.throws(() => checkCustomCohortViewportResponse(response(), nextGroup, replacedCatalog, viewport), /invalid_custom_cohort_viewport/);
});

test('mutable fallback inputs do not retain stale membership or selection lookup sets', () => {
  const nextCatalog = structuredClone(catalog), nextGroup = structuredClone(group);
  checkCustomCohortViewportResponse(response(), nextGroup, nextCatalog, viewport);
  nextGroup.request.selection.pockets.length = 0;
  assert.throws(() => checkCustomCohortViewportResponse(response(), nextGroup, nextCatalog, viewport), /invalid_custom_cohort_viewport/);
  nextGroup.request.selection.pockets = structuredClone(group.request.selection.pockets);
  nextCatalog.pockets.length = 0;
  assert.throws(() => checkCustomCohortViewportResponse(response(), nextGroup, nextCatalog, viewport), /invalid_custom_cohort_viewport/);
});

test('partial, count-mismatched and manifest-unavailable detail is never admitted as complete', () => {
  for (const change of [value => { value.status = 'partial'; }, value => { value.partial = true; },
    value => { value.counts.visible_parcels++; }, value => { value.counts.captured_parcels = null; }]) {
    const value = response(); change(value);
    assert.throws(() => checkCustomCohortViewportResponse(value, group, catalog, viewport), /invalid_custom_cohort_viewport/);
  }
  assert.throws(() => checkCustomCohortViewportResponse(response(), { ...group, map_manifest: { status: 'unavailable' } }, catalog, viewport),
    /invalid_custom_cohort_viewport/);
});
