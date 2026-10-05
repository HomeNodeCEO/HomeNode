// A viewport is a display-only projection of the already authorized, captured
// parcel map. It never changes the selected observation population or the
// statistics bound to that selection.
const MAX_VIEWPORT_SPAN = 1;
const MAX_RESPONSE_BYTES = 4_000_000;
const GRID_DEGREES = 0.01;
const MAX_INDEX_REFERENCES = 300_000;
const MAX_FEATURE_CELLS = 64;
const MAX_QUERY_CELLS = 20_000;
// Prepared maps are deeply frozen and retained briefly by the verified preview
// cache. Keep their parcel bounds for repeated pans without retaining a second
// copy of coordinates or trusting mutable fallback geometry.
const frozenBounds = new WeakMap();
const preparedSources = new WeakMap();
const preparedIndexes = new WeakMap();

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

function inViewport([x, y], box) {
  return x >= box.west && x <= box.east && y >= box.south && y <= box.north;
}

// Liang–Barsky clipping decides whether one retained ring segment touches the
// viewport. A bounding-box overlap alone is insufficient for concave parcels.
function segmentTouchesViewport([x, y], [endX, endY], box) {
  const dx = endX - x, dy = endY - y;
  const edges = [[-dx, x - box.west], [dx, box.east - x], [-dy, y - box.south], [dy, box.north - y]];
  let enter = 0, leave = 1;
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return false;
  }
  return true;
}

function ringContains([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)
      && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return 'boundary';
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function polygonTouchesViewport(polygon, box) {
  for (const ring of polygon) {
    for (let i = 1; i < ring.length; i++) {
      if (inViewport(ring[i], box) && ring === polygon[0]) return true;
      if (segmentTouchesViewport(ring[i - 1], ring[i], box)) return true;
    }
  }
  // No edge crosses the viewport. The remaining possible intersection is a
  // viewport wholly inside filled polygon area (but not inside a hole).
  for (const corner of [[box.west, box.south], [box.west, box.north],
    [box.east, box.south], [box.east, box.north]]) {
    const outer = ringContains(corner, polygon[0]);
    if (outer === 'outside') continue;
    if (outer === 'boundary') return true;
    let inHole = false;
    for (let i = 1; i < polygon.length; i++) {
      const position = ringContains(corner, polygon[i]);
      if (position === 'boundary') return true;
      if (position === 'inside') { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function intersects(geometry, viewport) {
  const { west, south, east, north } = boundsOf(geometry);
  if (west > viewport.east || east < viewport.west || south > viewport.north || north < viewport.south) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(polygon => polygonTouchesViewport(polygon, viewport));
}

const cell = value => Math.floor(value / GRID_DEGREES);
const key = (x, y) => `${x}:${y}`;
function buildIndex(features) {
  const cells = new Map(), broad = [];
  let references = 0;
  for (let index = 0; index < features.length; index++) {
    const bounds = boundsOf(features[index].geometry);
    if (![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite)) return null;
    const left = cell(bounds.west), right = cell(bounds.east), bottom = cell(bounds.south), top = cell(bounds.north);
    const count = (right - left + 1) * (top - bottom + 1);
    if (!Number.isSafeInteger(count) || count < 1) return null;
    if (count > MAX_FEATURE_CELLS) { broad.push(index); continue; }
    if ((references += count) > MAX_INDEX_REFERENCES) return null;
    for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) {
      const id = key(x, y);
      if (!cells.has(id)) cells.set(id, []);
      cells.get(id).push(index);
    }
  }
  return { cells, broad };
}

/** Associate a freshly selected, deeply frozen map with its verified neutral
 * geometry. The source and selection remain scoped to the existing hot read
 * model; only integer positions are indexed and WeakMaps retain no authority. */
export function registerCustomCohortPreparedViewportMap(selectedMap, neutralMap) {
  const selected = selectedMap?.geojson?.features, source = neutralMap?.geojson?.features;
  if (!Array.isArray(selected) || !Array.isArray(source) || selected.length !== source.length
    || !Object.isFrozen(selected) || !Object.isFrozen(source)) return false;
  for (let index = 0; index < source.length; index++) {
    if (selected[index]?.id !== source[index]?.id || selected[index]?.geometry !== source[index]?.geometry
      || !Object.isFrozen(source[index].geometry)) return false;
  }
  preparedSources.set(selected, source);
  return true;
}

function candidates(features, viewport) {
  const source = preparedSources.get(features);
  if (!source || source.length < 1000) return features;
  let index = preparedIndexes.get(source);
  if (index === undefined) {
    index = buildIndex(source);
    preparedIndexes.set(source, index);
  }
  if (!index) return features;
  const left = cell(viewport.west), right = cell(viewport.east);
  const bottom = cell(viewport.south), top = cell(viewport.north);
  if ((right - left + 1) * (top - bottom + 1) > MAX_QUERY_CELLS) return features;
  const found = new Set(index.broad);
  for (let x = left; x <= right; x++) for (let y = bottom; y <= top; y++) {
    for (const position of index.cells.get(key(x, y)) ?? []) found.add(position);
  }
  return [...found].sort((a, b) => a - b).map(position => features[position]);
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
    ? candidates(map.geojson.features, viewport).filter(feature => intersects(feature.geometry, viewport)) : [];
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
