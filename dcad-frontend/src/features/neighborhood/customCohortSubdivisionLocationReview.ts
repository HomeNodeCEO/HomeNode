import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortPreviewGroup } from './customCohortPreviewController';
import { buildCustomCohortSubdivisionFamilies } from './customCohortSubdivisionFamilies.ts';
import type { CustomCohortSubdivisionFamilies, CustomCohortSubdivisionFamily } from './customCohortSubdivisionFamilies';

export interface CustomCohortSubdivisionExtent {
  readonly west: number; readonly south: number; readonly east: number; readonly north: number;
}
export interface CustomCohortSubdivisionChildExtent {
  readonly pocket_id: string;
  readonly account_count: number; readonly represented_account_count: number;
  readonly parcel_count: number; readonly polygon_component_count: number;
  readonly status: 'complete' | 'partial' | 'missing' | 'unavailable';
  readonly reason: string | null;
  readonly extent: CustomCohortSubdivisionExtent | null;
}
export interface CustomCohortSubdivisionLocationReview {
  readonly review_version: 1; readonly basis: 'retained_geometry_extent_review';
  readonly context_ref: CustomCohortSubdivisionFamilies['context_ref']; readonly family_id: string;
  readonly status: 'available' | 'unavailable'; readonly reason: string | null;
  readonly child_count: number; readonly complete_child_count: number; readonly missing_child_count: number;
  readonly account_count: number; readonly represented_account_count: number;
  readonly child_extents: readonly CustomCohortSubdivisionChildExtent[];
  readonly combined_extent: CustomCohortSubdivisionExtent | null;
  readonly limitations: readonly string[];
}
const LIMITATIONS = Object.freeze(['bounding_extents_not_parcel_distance_or_adjacency',
  'overlapping_extents_do_not_establish_nearby_properties', 'multiple_parcels_and_polygon_components_may_be_disconnected',
  'polygon_topology_not_verified_here', 'name_family_not_verified_subdivision_identity',
  'no_location_or_year_built_inclusion_exclusion']);
const sameContext = (a: CustomCohortSubdivisionFamilies['context_ref'], b: CustomCohortSubdivisionFamilies['context_ref']) =>
  a.context_id === b.context_id && a.context_revision === b.context_revision && a.context_sha256 === b.context_sha256;
type MutableExtent = { west: number; south: number; east: number; north: number };
type Child = { pocket_id: string; account_count: number; represented: Set<string>; parcel_count: number;
  polygon_component_count: number; extent: MutableExtent | null; wrapped: boolean };
const grow = (a: MutableExtent | null, b: CustomCohortSubdivisionExtent): MutableExtent => a
  ? { west: Math.min(a.west, b.west), south: Math.min(a.south, b.south), east: Math.max(a.east, b.east), north: Math.max(a.north, b.north) }
  : { ...b };
function sameFamily(a: CustomCohortSubdivisionFamily, b: CustomCohortSubdivisionFamily) {
  return a.id === b.id && a.label === b.label && a.county === b.county && a.basis === b.basis
    && a.member_count === b.member_count && a.pocket_ids.length === b.pocket_ids.length
    && a.pocket_ids.every((id, i) => id === b.pocket_ids[i]);
}

/** Optional, click-time advisory over the SAME complete checked retained map.
 * Memoize by families/catalog/group/familyId at the inspector boundary, not by
 * render count. Validate every retained coordinate; compute extents only for this family.
 * do not borrow label anchors, centroids, age scores, current data or map pixels.
 * Envelopes are descriptive angular bounds, NOT a distance/identity threshold.
 */
export function buildCustomCohortSubdivisionFamilyLocationReview({ families, catalog, group, familyId }: {
  families: CustomCohortSubdivisionFamilies; catalog: CheckedPocketCatalog;
  group: CustomCohortPreviewGroup | null; familyId: string;
}): CustomCohortSubdivisionLocationReview {
  const context_ref = Object.freeze({ ...catalog.binding.context_ref });
  const children: Child[] = [];
  const output = (reason: string | null, child_extents: readonly CustomCohortSubdivisionChildExtent[],
    combined_extent: CustomCohortSubdivisionExtent | null = null): CustomCohortSubdivisionLocationReview => Object.freeze({
    review_version: 1, basis: 'retained_geometry_extent_review', context_ref, family_id: familyId,
    status: reason ? 'unavailable' : 'available', reason, child_count: child_extents.length,
    complete_child_count: child_extents.filter(child => child.status === 'complete').length,
    // "Missing" means not fully represented, including unavailable/wrapped
    // geometry. The per-child reason keeps this distinct from no stored parcel.
    missing_child_count: child_extents.filter(child => child.status !== 'complete').length,
    account_count: child_extents.reduce((sum, child) => sum + child.account_count, 0),
    represented_account_count: child_extents.reduce((sum, child) => sum + child.represented_account_count, 0),
    child_extents: Object.freeze(child_extents), combined_extent: combined_extent && Object.freeze(combined_extent), limitations: LIMITATIONS,
  });
  const unavailable = (reason: string) => output(reason, children.map(child => Object.freeze({ pocket_id: child.pocket_id,
    account_count: child.account_count, represented_account_count: 0, parcel_count: 0, polygon_component_count: 0,
    status: 'unavailable' as const, reason, extent: null })));
  if (families.profile_version !== 1 || !sameContext(families.context_ref, context_ref)) return unavailable('context_mismatch');
  if (catalog.status !== 'review_only') return unavailable('catalog_incomplete');
  // The public family has no authority receipt. Reconstruct its exact leaf
  // membership from the checked catalog before touching potentially large maps.
  const expected = buildCustomCohortSubdivisionFamilies(catalog).families.find(item => item.id === familyId);
  const family = families.families.find(item => item.id === familyId);
  if (!expected || !family || !sameFamily(family, expected)
    || family.pocket_ids.some(id => families.family_id_by_pocket_id[id] !== familyId)) return unavailable('family_mismatch');
  const pockets = new Map(catalog.pockets.map(pocket => [pocket.id, pocket]));
  const childByAccount = new Map<string, Child>();
  for (const id of family.pocket_ids) {
    const pocket = pockets.get(id)!;
    const child: Child = { pocket_id: id, account_count: pocket.member_count, represented: new Set(),
      parcel_count: 0, polygon_component_count: 0, extent: null, wrapped: false };
    children.push(child); for (const account of pocket.account_ids) childByAccount.set(account, child);
  }
  if (!group) return unavailable('map_unavailable');
  if (!sameContext(group.binding.contextRef, context_ref) || group.binding.accountId !== catalog.subject_membership.account_id) return unavailable('context_mismatch');
  const map = group.parcel_map;
  if (!map || map.status !== 'available') return unavailable('map_unavailable');
  if (!map.geojson || map.geojson.type !== 'FeatureCollection' || !Array.isArray(map.geojson.features)
    || !map.counts || !Number.isSafeInteger(map.counts.coordinates) || map.counts.coordinates < 0) return unavailable('invalid_geometry');
  if (map.geojson.features.length > 100_000 || map.counts.coordinates > 1_000_000) return unavailable('capacity_exceeded');
  const seenParcels = new Set<string>(), allAccounts = new Set<string>();
  const wantedAccounts = new Set([...catalog.pockets.flatMap(pocket => [...pocket.account_ids]), ...catalog.unassigned.account_ids]);
  let coordinates = 0;
  try {
    function polygon(value: unknown, child: Child | undefined) {
      if (!Array.isArray(value) || !value.length) throw new Error('invalid_geometry');
      if (child) child.polygon_component_count++;
      for (const ring of value) {
        if (!Array.isArray(ring) || ring.length < 4) throw new Error('invalid_geometry');
        let previousLongitude: number | null = null;
        for (const point of ring) {
          if (++coordinates > 1_000_000) throw new Error('capacity_exceeded');
          if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number'
            || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error('invalid_geometry');
          const [longitude, latitude] = point;
          if (child && previousLongitude !== null && Math.abs(longitude - previousLongitude) > 180) child.wrapped = true;
          previousLongitude = longitude;
          // One mutable private accumulator per child, not two temporary extent
          // objects per coordinate of a large retained map. Freeze only output.
          if (!child) continue;
          if (child.extent) {
            child.extent.west = Math.min(child.extent.west, longitude); child.extent.east = Math.max(child.extent.east, longitude);
            child.extent.south = Math.min(child.extent.south, latitude); child.extent.north = Math.max(child.extent.north, latitude);
          } else child.extent = { west: longitude, south: latitude, east: longitude, north: latitude };
        }
      }
    }
    for (const feature of map.geojson.features) {
      const { object_id: objectId, account_id: accountId } = feature.properties;
      if (seenParcels.has(objectId) || !wantedAccounts.has(accountId)) throw new Error('map_catalog_mismatch');
      seenParcels.add(objectId); allAccounts.add(accountId);
      const child = childByAccount.get(accountId);
      if (child) { child.parcel_count++; child.represented.add(accountId); }
      if (feature.geometry.type === 'Polygon') polygon(feature.geometry.coordinates, child);
      else if (feature.geometry.type === 'MultiPolygon' && Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length) {
        for (const component of feature.geometry.coordinates) polygon(component, child);
      } else throw new Error('invalid_geometry');
    }
    if (map.counts.parcels !== seenParcels.size || map.counts.accounts !== allAccounts.size) throw new Error('map_catalog_mismatch');
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return unavailable(['invalid_geometry', 'capacity_exceeded', 'map_catalog_mismatch'].includes(reason) ? reason : 'invalid_geometry');
  }
  const child_extents = children.map(child => {
    const represented = child.represented.size;
    const wrapped = child.wrapped || Boolean(child.extent && child.extent.east - child.extent.west > 180);
    const status = wrapped ? 'unavailable' : !represented ? 'missing' : represented < child.account_count ? 'partial' : 'complete';
    return Object.freeze({ pocket_id: child.pocket_id, account_count: child.account_count, represented_account_count: represented,
      parcel_count: child.parcel_count, polygon_component_count: child.polygon_component_count, status,
      reason: wrapped ? 'dateline_or_wrapped_extent' : status === 'complete' ? null : 'incomplete_geometry',
      extent: status === 'complete' && child.extent ? Object.freeze(child.extent) : null });
  });
  if (child_extents.some(child => child.status !== 'complete')) return output(
    child_extents.some(child => child.reason === 'dateline_or_wrapped_extent') ? 'dateline_or_wrapped_extent' : 'incomplete_geometry', child_extents);
  if (allAccounts.size !== wantedAccounts.size) return output('map_catalog_mismatch', child_extents);
  const combined = child_extents.reduce<MutableExtent | null>((extent, child) => grow(extent, child.extent!), null);
  if (!combined) return output('incomplete_geometry', child_extents);
  if (combined.east - combined.west > 180) return output('dateline_or_wrapped_extent', child_extents);
  return output(null, child_extents, combined);
}
