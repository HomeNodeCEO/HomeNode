import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortPreviewGroup } from './customCohortPreviewController';

export interface CustomCohortViewportBounds { readonly west: number; readonly south: number; readonly east: number; readonly north: number }
export interface CheckedViewportMap {
  readonly status: 'available' | 'unavailable'; readonly features: readonly {
    readonly type: 'Feature'; readonly id: string;
    readonly properties: { readonly object_id: string; readonly account_id: string; readonly selected: boolean };
    readonly geometry: { readonly type: 'Polygon' | 'MultiPolygon'; readonly coordinates: number[][][] | number[][][][] };
  }[];
  readonly reason?: string;
}
const SEMANTICS = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
// Checked catalogs and accepted controller requests are immutable. Weak keys
// reuse membership admission on pans without retaining a departed capture.
const catalogMembers = new WeakMap<CheckedPocketCatalog, ReadonlySet<string>>();
const requestMembers = new WeakMap<CustomCohortPreviewGroup['request'], ReadonlySet<string>>();
function memberLookups(catalog: CheckedPocketCatalog, request: CustomCohortPreviewGroup['request']) {
  const cacheCatalog = Object.isFrozen(catalog), cacheRequest = Object.isFrozen(request);
  let members = cacheCatalog ? catalogMembers.get(catalog) : undefined;
  let selected = cacheRequest ? requestMembers.get(request) : undefined;
  if (!members) {
    const index = new Set<string>();
    for (const pocket of catalog.pockets) for (const account of pocket.account_ids) index.add(account);
    for (const account of catalog.unassigned.account_ids) index.add(account);
    members = index; if (cacheCatalog) catalogMembers.set(catalog, members);
  }
  if (!selected) {
    const index = new Set<string>();
    for (const pocket of request.selection.pockets) for (const account of pocket.account_ids) index.add(account);
    selected = index; if (cacheRequest) requestMembers.set(request, selected);
  }
  return { members, selected };
}
const fail = () => { throw new TypeError('invalid_custom_cohort_viewport'); };
const check: (ok: unknown) => asserts ok = ok => { if (!ok) fail(); };
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype); return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: readonly string[]) {
  check(Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)));
}
function text(value: unknown, max: number): string {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value);
  for (let i = 0; i < value.length; i++) check(value.charCodeAt(i) >= 32 && value.charCodeAt(i) !== 127);
  return value;
}
function coordinate(value: unknown): asserts value is [number, number] {
  check(Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
    && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90);
}
function polygon(value: unknown, remaining: { count: number }): asserts value is number[][][] {
  check(Array.isArray(value) && value.length > 0 && value.length <= 50_000);
  for (const rawRing of value) {
    check(Array.isArray(rawRing) && rawRing.length >= 4 && rawRing.length <= 200_000);
    for (const raw of rawRing) { coordinate(raw); check(++remaining.count <= 200_000); }
    const first = rawRing[0] as [number, number], last = rawRing.at(-1) as [number, number];
    check(first[0] === last[0] && first[1] === last[1]);
  }
}
/** Viewport parcels are display-only. The summary and membership are accepted
 * separately, and exact target/context/revision/hash prevent late pan results
 * from being painted over a different saved selection. */
export function checkCustomCohortViewportResponse(value: unknown, group: CustomCohortPreviewGroup,
  catalog: CheckedPocketCatalog, viewport: CustomCohortViewportBounds): CheckedViewportMap {
  const body = record(value);
  // The authenticated viewport transport enforces 4 MB on the decoded byte
  // stream before JSON.parse. Do not serialize the entire geometry again here.
  const required = ['status', 'display_only', 'target', 'context_ref', 'selection_revision', 'selection_sha256',
    'viewport', 'geometry_semantics', 'geojson', body.status === 'available' ? 'counts' : 'reason'];
  exact(body, required);
  const target = record(body.target); exact(target, ['account_id', 'assignment_file_id']);
  const context = record(body.context_ref); exact(context, ['context_id', 'context_revision', 'context_sha256']);
  const request = group.request, ref = group.binding.contextRef;
  check(body.display_only === true && body.geometry_semantics === SEMANTICS
    && target.account_id === request.accountId && target.assignment_file_id === request.assignmentFileId
    && context.context_id === ref.context_id && context.context_revision === ref.context_revision
    && context.context_sha256 === ref.context_sha256
    && body.selection_revision === group.binding.selectionRevision
    && body.selection_sha256 === group.binding.selectionFingerprint);
  const extent = record(body.viewport); exact(extent, ['west', 'south', 'east', 'north']);
  check(Object.keys(viewport).every(key => extent[key] === viewport[key as keyof CustomCohortViewportBounds]));
  if (body.status === 'unavailable') {
    check(body.geojson === null);
    return Object.freeze({ status: 'unavailable', features: [], reason: text(body.reason, 200) });
  }
  check(body.status === 'available');
  const geo = record(body.geojson); exact(geo, ['type', 'features']);
  check(geo.type === 'FeatureCollection' && Array.isArray(geo.features) && geo.features.length <= 100_000);
  const counts = record(body.counts); exact(counts, ['visible_parcels', 'captured_parcels']);
  check(counts.visible_parcels === geo.features.length);
  const captured = group.map_manifest?.status === 'available' ? group.map_manifest.counts.captured_parcels : null;
  check(captured !== null && counts.captured_parcels === captured && geo.features.length <= captured);
  const { members, selected } = memberLookups(catalog, request);
  const ids = new Set<string>(), remaining = { count: 0 };
  const features = geo.features.map(raw => {
    const f = record(raw); exact(f, ['type', 'id', 'properties', 'geometry']);
    const props = record(f.properties); exact(props, ['object_id', 'account_id', 'selected']);
    const account = text(props.account_id, 100), objectId = text(props.object_id, 30), id = text(f.id, 100);
    check(f.type === 'Feature' && members.has(account) && id === `gis.dcad_parcels:${objectId}` && !ids.has(id)
      && props.selected === selected.has(account)); ids.add(id);
    const geometry = record(f.geometry); exact(geometry, ['type', 'coordinates']);
    if (geometry.type === 'Polygon') polygon(geometry.coordinates, remaining);
    else {
      check(geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0);
      geometry.coordinates.forEach(part => polygon(part, remaining));
    }
    return { type: 'Feature' as const, id,
      properties: { object_id: objectId, account_id: account, selected: Boolean(props.selected) },
      geometry: { type: geometry.type as 'Polygon' | 'MultiPolygon',
        coordinates: geometry.coordinates as number[][][] | number[][][][] } };
  });
  return Object.freeze({ status: 'available', features });
}
