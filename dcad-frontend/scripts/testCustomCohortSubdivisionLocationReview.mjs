import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomCohortSubdivisionFamilies as build } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { buildCustomCohortSubdivisionFamilyLocationReview as review } from '../src/features/neighborhood/customCohortSubdivisionLocationReview.ts';

const context = { context_id: '30000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const id = n => `recorded-cad:${String(n).padStart(64, '0')}`;
const polygon = (x, y, width = 1) => ({ type: 'Polygon', coordinates: [
  [[x, y], [x + width, y], [x + width, y + width], [x, y + width], [x, y]],
] });
const feature = (objectId, accountId, geometry) => ({ type: 'Feature', id: `gis.dcad_parcels:${objectId}`,
  properties: { object_id: objectId, account_id: accountId, selected: false }, geometry });
function counts(features) {
  const coordinates = features.reduce((sum, f) => sum + (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .reduce((n, p) => n + p.reduce((m, ring) => m + ring.length, 0), 0), 0);
  return { parcels: features.length, accounts: new Set(features.map(f => f.properties.account_id)).size,
    selected_accounts: 0, coordinates, geometry_bytes: 1000, geojson_bytes: 2000 };
}
// Bounded semantic shapes already admitted by the controller in production.
// Native polygon validity, geographic distance and source authority are NOT
// asserted by this pure advisory fixture.
function fixture() {
  const catalog = { catalog_version: 2, status: 'review_only', binding: { context_ref: context, selection_revision: 7 },
    pockets: [{ id: id(1), label: 'Park 1', county: 'Dallas', account_ids: ['A', 'B'], member_count: 2 },
      { id: id(2), label: 'Park 4', county: 'Dallas', account_ids: ['C'], member_count: 1 },
      { id: id(3), label: 'Other', county: 'Dallas', account_ids: ['D'], member_count: 1 }],
    unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
    coverage: { discovery_member_count: 4, assigned_account_count: 4, unassigned_account_count: 0 },
    subject_membership: { account_id: 'A', assigned_pocket_id: id(1), status: 'recorded_label_matched', recorded_label_match_only: true }, limitations: [] };
  const features = [feature('1', 'A', polygon(-97, 32)), feature('2', 'B', polygon(-95, 34)),
    feature('3', 'C', { type: 'MultiPolygon', coordinates: [polygon(-93, 33).coordinates, polygon(-90, 36).coordinates] }),
    feature('4', 'D', polygon(10, 10))];
  const group = { binding: { accountId: 'A', assignmentFileId: '1', contextRef: context, selectionRevision: 8, selectionFingerprint: 'b'.repeat(64) },
    summary: {}, apply: { status: 'blocked', reasons: [] }, parcel_map: { status: 'available',
      geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary',
      geojson: { type: 'FeatureCollection', features }, counts: counts(features) } };
  const families = build(catalog), familyId = families.family_id_by_pocket_id[id(1)];
  return { families, catalog, group, familyId };
}

test('all-coordinate retained extents cover every family account and component, not unrelated geometry', () => {
  const f = fixture(), before = JSON.stringify(f), result = review(f);
  assert.equal(result.status, 'available'); assert.equal(result.reason, null); assert.equal(result.basis, 'retained_geometry_extent_review');
  assert.equal(result.child_count, 2); assert.equal(result.complete_child_count, 2); assert.equal(result.missing_child_count, 0);
  assert.equal(result.account_count, 3); assert.equal(result.represented_account_count, 3);
  assert.deepEqual(result.child_extents.map(c => [c.pocket_id, c.account_count, c.represented_account_count, c.parcel_count, c.polygon_component_count]),
    [[id(1), 2, 2, 2, 2], [id(2), 1, 1, 1, 2]]);
  assert.deepEqual(result.child_extents[0].extent, { west: -97, south: 32, east: -94, north: 35 });
  assert.deepEqual(result.child_extents[1].extent, { west: -93, south: 33, east: -89, north: 37 });
  assert.deepEqual(result.combined_extent, { west: -97, south: 32, east: -89, north: 37 });
  assert.equal(JSON.stringify(f), before);
  assert.ok(result.limitations.includes('bounding_extents_not_parcel_distance_or_adjacency'));
  assert.ok(result.limitations.includes('multiple_parcels_and_polygon_components_may_be_disconnected'));
  assert.ok(result.limitations.includes('no_location_or_year_built_inclusion_exclusion'));
  assert.equal(Object.hasOwn(result, 'distance_metres'), false); assert.equal(Object.hasOwn(result, 'confirmed'), false);
});

test('every parcel for one account and every ring contributes without double-counting accounts', () => {
  const f = fixture(), features = f.group.parcel_map.geojson.features;
  // Secondary rings must be inspected too. This intentionally tests the checked
  // coordinate representation, not a claim that its topology is native-valid.
  features[0].geometry.coordinates.push(polygon(-98, 30).coordinates[0]);
  features.push(feature('5', 'A', polygon(-99, 29)));
  f.group.parcel_map.counts = counts(features);
  const result = review(f), child = result.child_extents[0];
  assert.equal(result.status, 'available'); assert.equal(child.represented_account_count, 2);
  assert.equal(child.parcel_count, 3); assert.equal(child.polygon_component_count, 3);
  assert.deepEqual(child.extent, { west: -99, south: 29, east: -94, north: 35 });
});

test('incomplete child coverage reports all children and withholds partial child/combined extents', () => {
  const f = fixture(), features = f.group.parcel_map.geojson.features.filter(feature => feature.properties.account_id !== 'B');
  f.group.parcel_map.geojson.features = features; f.group.parcel_map.counts = counts(features);
  const result = review(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'incomplete_geometry');
  assert.equal(result.child_count, 2); assert.equal(result.complete_child_count, 1); assert.equal(result.missing_child_count, 1);
  assert.equal(result.child_extents[0].status, 'partial'); assert.equal(result.child_extents[0].represented_account_count, 1);
  assert.equal(result.child_extents[0].extent, null); assert.equal(result.combined_extent, null);
  assert.notEqual(result.child_extents[1].extent, null);
});

test('entirely missing child geometry stays distinct from complete and does not remove the phase', () => {
  const f = fixture(), features = f.group.parcel_map.geojson.features.filter(feature => feature.properties.account_id !== 'C');
  f.group.parcel_map.geojson.features = features; f.group.parcel_map.counts = counts(features);
  const result = review(f);
  assert.equal(result.child_extents[1].status, 'missing'); assert.equal(result.child_count, 2);
  assert.equal(result.account_count, 3); assert.equal(result.represented_account_count, 2);
  assert.equal(result.combined_extent, null);
});

for (const [label, mutate, reason] of [
  ['wrong model context', f => { f.families = { ...f.families, context_ref: { ...context, context_sha256: 'c'.repeat(64) } }; }, 'context_mismatch'],
  ['wrong map context', f => { f.group.binding.contextRef = { ...context, context_sha256: 'c'.repeat(64) }; }, 'context_mismatch'],
  ['wrong map subject', f => { f.group.binding.accountId = 'FOREIGN'; }, 'context_mismatch'],
  ['unknown family', f => { f.familyId = 'unknown'; }, 'family_mismatch'],
  ['changed child membership', f => { f.families = structuredClone(f.families); f.families.families.find(item => item.id === f.familyId).pocket_ids.pop(); }, 'family_mismatch'],
  ['wrong index', f => { f.families = structuredClone(f.families); f.families.family_id_by_pocket_id[id(1)] = 'foreign'; }, 'family_mismatch'],
  ['incomplete catalog', f => { f.catalog.status = 'incomplete'; }, 'catalog_incomplete'],
  ['no map', f => { f.group = null; }, 'map_unavailable'],
  ['unavailable map', f => { f.group.parcel_map = { status: 'unavailable', reason: 'capacity_exceeded', geojson: null }; }, 'map_unavailable'],
]) test(`${label} cannot produce a bound location assertion`, () => {
  const f = fixture(); mutate(f); const result = review(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason); assert.equal(result.combined_extent, null);
});

test('selection-only revision changes do not change fixed complete retained geometry evidence', () => {
  const f = fixture(), before = review(f);
  f.group.binding.selectionRevision = 99; f.group.binding.selectionFingerprint = 'f'.repeat(64);
  f.group.parcel_map.geojson.features.forEach(feature => { feature.properties.selected = true; });
  assert.deepEqual(review(f), before);
});

test('wrapped individual polygon and individually unwrapped dateline-separated children are unavailable', () => {
  const a = fixture();
  a.group.parcel_map.geojson.features[0].geometry = { type: 'Polygon', coordinates: [[[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]]] };
  assert.equal(review(a).reason, 'dateline_or_wrapped_extent'); assert.equal(review(a).child_extents[0].extent, null);
  const b = fixture();
  b.group.parcel_map.geojson.features[0].geometry = polygon(178, 0);
  b.group.parcel_map.geojson.features[1].geometry = polygon(178, 1);
  b.group.parcel_map.geojson.features[2].geometry = polygon(-179, 0);
  const result = review(b);
  assert.equal(result.reason, 'dateline_or_wrapped_extent'); assert.equal(result.combined_extent, null);
});

for (const [label, mutate, reason] of [
  ['duplicate parcel', features => { features.push(features[0]); }, 'map_catalog_mismatch'],
  ['foreign account', features => { features[0].properties.account_id = 'FOREIGN'; }, 'map_catalog_mismatch'],
  ['non-finite coordinate', features => { features[0].geometry.coordinates[0][0][0] = NaN; }, 'invalid_geometry'],
  ['invalid longitude', features => { features[0].geometry.coordinates[0][0][0] = 181; }, 'invalid_geometry'],
  ['missing coordinate', features => { features[0].geometry.coordinates[0][0].pop(); }, 'invalid_geometry'],
]) test(`malformed ${label} never produces partial successful location evidence`, () => {
  const f = fixture(); mutate(f.group.parcel_map.geojson.features); const result = review(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason); assert.equal(result.combined_extent, null);
  assert.ok(result.child_extents.every(child => child.status === 'unavailable' && child.extent === null));
});

test('complete family within an incomplete overall map does not claim complete checked map coverage', () => {
  const f = fixture(), features = f.group.parcel_map.geojson.features.slice(0, 3);
  f.group.parcel_map.geojson.features = features; f.group.parcel_map.counts = counts(features);
  assert.equal(review(f).reason, 'map_catalog_mismatch');
});

test('dense coordinate budget is bounded at one million while the feature limit remains unchanged', () => {
  const f = fixture(); f.group.parcel_map.counts.coordinates = 1_000_001;
  assert.equal(review(f).reason, 'capacity_exceeded');
  const g = fixture(); g.group.parcel_map.geojson.features = Array(100_001).fill(g.group.parcel_map.geojson.features[0]);
  assert.equal(review(g).reason, 'capacity_exceeded');
});

test('result is detached and deeply immutable, and feature order has no effect', () => {
  const f = fixture(), a = review(f); f.group.parcel_map.geojson.features.reverse(); const b = review(f);
  assert.deepEqual(a, b);
  for (const value of [a, a.context_ref, a.child_extents, ...a.child_extents, ...a.child_extents.map(child => child.extent),
    a.combined_extent, a.limitations]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { a.combined_extent.west = 0; }, TypeError);
  assert.throws(() => a.child_extents.pop(), TypeError);
  assert.notEqual(a.context_ref, f.catalog.binding.context_ref);
});

test('coordinates outside the inspected family still consume the actual map budget', () => {
  const f = fixture();
  f.group.parcel_map.geojson.features[3].geometry.coordinates = [Array(1_000_001).fill([10, 10])];
  f.group.parcel_map.counts.coordinates = 1_000_000;
  const result = review(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'capacity_exceeded');
  assert.equal(result.combined_extent, null);
});

for (const [label, mutate] of [
  ['unrelated invalid coordinate', f => { f.group.parcel_map.geojson.features[3].geometry.coordinates[0][0] = [NaN, 10]; }],
  ['unrelated invalid geometry', f => { f.group.parcel_map.geojson.features[3].geometry = null; }],
  ['missing features', f => { f.group.parcel_map.geojson.features = null; }],
  ['missing counts', f => { f.group.parcel_map.counts = null; }],
  ['invalid declared count', f => { f.group.parcel_map.counts.coordinates = NaN; }],
]) test(`${label} fails safely without partial family evidence`, () => {
  const f = fixture(); mutate(f);
  const result = review(f);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'invalid_geometry');
  assert.equal(result.combined_extent, null);
});
