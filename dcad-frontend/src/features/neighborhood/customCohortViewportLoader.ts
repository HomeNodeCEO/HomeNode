import { checkCustomCohortViewportResponse } from './customCohortViewportClient.ts';
import type { CheckedViewportMap, CustomCohortViewportBounds } from './customCohortViewportClient';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';
import type { CustomCohortPreviewGroup } from './customCohortPreviewController';

type Feature = CheckedViewportMap['features'][number];
interface Options {
  readonly signal: AbortSignal;
  readonly request: (bounds: CustomCohortViewportBounds, signal: AbortSignal) => Promise<unknown>;
}
// Match the complete dense-map contract, not a larger map/API allowance.
// Each authenticated response still has the independent 4 MB transport guard.
const LIMITS = { leaves: 32, requests: 63, depth: 8, features: 100_000,
  coordinates: 1_000_000, geojsonBytes: 32_000_000 };
const utf8 = new TextEncoder();
const capacity = () => { throw Object.assign(new Error('viewport_detail_capacity_exceeded'),
  { code: 'viewport_detail_capacity_exceeded' }); };
const invalid = () => { throw new TypeError('invalid_custom_cohort_viewport'); };
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Viewport detail request aborted', 'AbortError');
}
function active(signal: AbortSignal) { if (signal.aborted) throw abortReason(signal); }
function checkedBounds(value: CustomCohortViewportBounds): CustomCohortViewportBounds {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 4
    || !['west', 'south', 'east', 'north'].every(key => Object.hasOwn(value, key)
      && typeof value[key as keyof CustomCohortViewportBounds] === 'number'
      && Number.isFinite(value[key as keyof CustomCohortViewportBounds]))) invalid();
  const { west, south, east, north } = value;
  if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south) invalid();
  return Object.freeze({ west, south, east, north });
}
function denseResponse(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const failure = error as { status?: unknown; errorCode?: unknown };
  // The router's public code differs from its internal viewport_capacity_exceeded reason.
  return failure.status === 422 && failure.errorCode === 'neighborhood_viewport_too_dense';
}
function split(bounds: CustomCohortViewportBounds): readonly CustomCohortViewportBounds[] {
  const { west, south, east, north } = bounds;
  if (east - west >= north - south) {
    const middle = west + (east - west) / 2;
    if (middle <= west || middle >= east) capacity();
    return [Object.freeze({ west, south, east: middle, north }), Object.freeze({ west: middle, south, east, north })];
  }
  const middle = south + (north - south) / 2;
  if (middle <= south || middle >= north) capacity();
  return [Object.freeze({ west, south, east, north: middle }), Object.freeze({ west, south: middle, east, north })];
}
/** An ignored transport signal must not keep the owner pending or start later tiles. */
function requestTile(bounds: CustomCohortViewportBounds, { signal, request }: Options): Promise<unknown> {
  active(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { active(signal); return request(bounds, signal); }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(abortReason(signal)); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(signal.aborted ? abortReason(signal) : error);
    });
  });
}
function sameCoordinates(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return Object.is(a, b);
  return a.length === b.length && a.every((value, index) => sameCoordinates(value, b[index]));
}
function sameFeature(a: Feature, b: Feature): boolean {
  return a.id === b.id && a.properties.object_id === b.properties.object_id
    && a.properties.account_id === b.properties.account_id && a.properties.selected === b.properties.selected
    && a.geometry.type === b.geometry.type && sameCoordinates(a.geometry.coordinates, b.geometry.coordinates);
}
// Exact compact JSON bytes, without allocating a serialized geometry copy.
// The checker already admitted only finite two-number positions. String(number)
// matches JSON's number tokens, including the canonical zero token for -0.
function coordinateBytes(values: readonly unknown[], budget: { coordinates: number }): number {
  let bytes = 2 + Math.max(0, values.length - 1);
  if (typeof values[0] === 'number' && ++budget.coordinates > LIMITS.coordinates) capacity();
  for (const value of values) bytes += Array.isArray(value) ? coordinateBytes(value, budget) : String(value).length;
  Object.freeze(values);
  return bytes;
}
function featureBytes(feature: Feature, budget: { coordinates: number }): number {
  const bytes = coordinateBytes(feature.geometry.coordinates, budget)
    + utf8.encode(JSON.stringify({ ...feature, geometry: { type: feature.geometry.type, coordinates: [] } })).length - 2;
  Object.freeze(feature.geometry); Object.freeze(feature.properties); Object.freeze(feature);
  return bytes;
}

/** Load an exact, complete display for one camera. A dense response is bisected
 * spatially; no geometry is clipped, simplified, inferred or published early.
 * All leaves are checked against the same immutable preview/catalog binding. */
export async function loadCustomCohortViewportMap(group: CustomCohortPreviewGroup, catalog: CheckedPocketCatalog,
  viewport: CustomCohortViewportBounds, options: Options): Promise<CheckedViewportMap> {
  active(options.signal);
  const pending = [{ bounds: checkedBounds(viewport), depth: 0 }];
  const features = new Map<string, Feature>();
  const budget = { coordinates: 0 };
  let leaves = 1, requests = 0;
  let bytes = utf8.encode(JSON.stringify({ type: 'FeatureCollection', features: [] })).length;
  const subdivide = (tile: typeof pending[number]) => {
    if (leaves >= LIMITS.leaves || tile.depth >= LIMITS.depth) capacity();
    leaves++;
    const [first, second] = split(tile.bounds);
    pending.push({ bounds: second, depth: tile.depth + 1 }, { bounds: first, depth: tile.depth + 1 });
  };
  // A broad, dense retained map cannot fit the four-MB response ceiling.
  // Start with exact spatial tiles rather than paying for several doomed
  // whole-view projections before the normal density-split path takes over.
  // This is display-only: every leaf must still be checked and merged before
  // any parcel detail is published as complete.
  const manifest = group.map_manifest;
  if (manifest?.status === 'available' && manifest.counts.captured_parcels >= 30_000
    && Array.isArray(manifest.bounds) && manifest.bounds.length === 2) {
    const [[west, south], [east, north]] = manifest.bounds;
    const capturedArea = (east - west) * (north - south);
    const requestedArea = (viewport.east - viewport.west) * (viewport.north - viewport.south);
    if (capturedArea > 0 && requestedArea >= capturedArea / 2) {
      for (let level = 0; level < 3; level++) {
        const current = pending.splice(0);
        for (const tile of current) subdivide(tile);
      }
    }
  }
  while (pending.length) {
    active(options.signal);
    const tile = pending.pop()!;
    if (tile.bounds.east - tile.bounds.west > 1 || tile.bounds.north - tile.bounds.south > 1) {
      subdivide(tile); continue;
    }
    if (++requests > LIMITS.requests) capacity();
    let response: unknown;
    try { response = await requestTile(tile.bounds, options); }
    catch (error) {
      active(options.signal);
      if (!denseResponse(error)) throw error;
      subdivide(tile); continue;
    }
    active(options.signal);
    const checked = checkCustomCohortViewportResponse(response, group, catalog, tile.bounds);
    if (checked.status === 'unavailable') return checked;
    // Normal pans stay on the existing one-pass checker/4 MB transport path.
    if (leaves === 1) return checked;
    for (const feature of checked.features) {
      const previous = features.get(feature.id);
      if (previous) { if (!sameFeature(previous, feature)) invalid(); continue; }
      if (features.size >= LIMITS.features) capacity();
      const captured = group.map_manifest?.status === 'available' ? group.map_manifest.counts.captured_parcels : 0;
      if (features.size >= captured) invalid();
      bytes += featureBytes(feature, budget) + Number(features.size > 0);
      if (bytes > LIMITS.geojsonBytes) capacity();
      features.set(feature.id, feature);
    }
  }
  active(options.signal);
  return Object.freeze({ status: 'available', features: Object.freeze([...features.values()]) });
}
