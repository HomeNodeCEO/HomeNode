// A viewport is a display-only projection of the already authorized, captured
// parcel map. It never changes the selected observation population or the
// statistics bound to that selection.
const MAX_VIEWPORT_SPAN = 1;
const MAX_RESPONSE_BYTES = 4_000_000;
// Prepared maps are deeply frozen and retained briefly by the verified preview
// cache. Keep their parcel bounds for repeated pans without retaining a second
// copy of coordinates or trusting mutable fallback geometry.
const frozenBounds = new WeakMap();

function invalid() { throw Object.assign(new TypeError('invalid_input'), { reason: 'invalid_input' }); }

export function prepareCustomCohortViewport(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 4
    || !['west', 'south', 'east', 'north'].every(key => Object.hasOwn(value, key)
      && typeof value[key] === 'number' && Number.isFinite(value[key]))) invalid();
  const { west, south, east, north } = value;
  if (west < -180 || east > 180 || south < -90 || north > 90
    || east <= west || north <= south
    || east - west > MAX_VIEWPORT_SPAN || north - south > MAX_VIEWPORT_SPAN) invalid();
  return Object.freeze({ west, south, east, north });
}

function boundsOf(geometry) {
  const cached = Object.isFrozen(geometry) ? frozenBounds.get(geometry) : null;
  if (cached) return cached;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) {
    west = Math.min(west, point[0]); south = Math.min(south, point[1]);
    east = Math.max(east, point[0]); north = Math.max(north, point[1]);
  }
  const bounds = { west, south, east, north };
  if (Object.isFrozen(geometry)) frozenBounds.set(geometry, bounds);
  return bounds;
}

function intersects(geometry, viewport) {
  const { west, south, east, north } = boundsOf(geometry);
  return west <= viewport.east && east >= viewport.west
    && south <= viewport.north && north >= viewport.south;
}

export function projectCustomCohortViewportMap(preview, requestedViewport) {
  const viewport = prepareCustomCohortViewport(requestedViewport);
  if (!preview || preview.status !== 'preview' || !preview.context_ref
    || !Number.isSafeInteger(preview.selection_revision)
    || typeof preview.summary?.binding?.selection_sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(preview.summary.binding.selection_sha256)
    || typeof preview.target?.account_id !== 'string' || typeof preview.target?.assignment_file_id !== 'string'
    || !preview.parcel_map || !['available', 'unavailable'].includes(preview.parcel_map.status)) invalid();
  const map = preview.parcel_map;
  const features = map.status === 'available'
    ? map.geojson.features.filter(feature => intersects(feature.geometry, viewport)) : [];
  const result = { status: map.status, display_only: true,
    target: preview.target, context_ref: preview.context_ref, selection_revision: preview.selection_revision,
    selection_sha256: preview.summary.binding.selection_sha256,
    viewport, geometry_semantics: map.geometry_semantics,
    ...(map.status === 'available'
      ? { geojson: { type: 'FeatureCollection', features },
        counts: { visible_parcels: features.length, captured_parcels: map.counts.parcels } }
      : { geojson: null, reason: map.reason }) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
    throw Object.assign(new TypeError('viewport_capacity_exceeded'), { reason: 'viewport_capacity_exceeded' });
  }
  return result;
}
