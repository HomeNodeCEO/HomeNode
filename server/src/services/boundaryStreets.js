const TIGERWEB_TRANSPORTATION_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";
const ROAD_LAYERS = [0, 1, 2];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_BUFFER_METERS = 45;
const cache = new Map();

function normalizedRing(geometry) {
  if (!geometry || typeof geometry !== "object" || geometry.type !== "Polygon") {
    throw new Error("invalid_boundary_geometry");
  }
  const ring = geometry.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > 501) {
    throw new Error("invalid_boundary_geometry");
  }
  const normalized = ring.map((point) => {
    const longitude = Number(point?.[0]);
    const latitude = Number(point?.[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error("invalid_boundary_geometry");
    }
    return [longitude, latitude];
  });
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error("invalid_boundary_geometry");
  }
  return normalized;
}

export function normalizeBoundaryStreetNames(features = []) {
  const names = new Set();
  for (const feature of features) {
    const attributes = feature?.attributes || {};
    const name = String(attributes.NAME || attributes.BASENAME || "")
      .replace(/\s+/g, " ")
      .trim();
    if (name && !/^unnamed$/i.test(name)) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

async function queryRoadLayer(layer, ring, fetchImpl) {
  const url = new URL(`${TIGERWEB_TRANSPORTATION_URL}/${layer}/query`);
  url.search = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: JSON.stringify({
      paths: [ring],
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryPolyline",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(BOUNDARY_BUFFER_METERS),
    units: "esriSRUnit_Meter",
    outFields: "NAME,BASENAME",
    returnGeometry: "false",
    returnDistinctValues: "true",
    resultRecordCount: "2000",
  }).toString();
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`tigerweb_http_${response.status}`);
  const payload = await response.json();
  if (payload?.error) throw new Error("tigerweb_query_failed");
  return Array.isArray(payload?.features) ? payload.features : [];
}

export async function fetchBoundaryStreetNames(
  geometry,
  { fetchImpl = globalThis.fetch, now = () => new Date() } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("boundary_street_fetch_unavailable");
  const ring = normalizedRing(geometry);
  const cacheKey = JSON.stringify(ring);
  const cached = cache.get(cacheKey);
  if (cached && now().getTime() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const results = await Promise.allSettled(
    ROAD_LAYERS.map((layer) => queryRoadLayer(layer, ring, fetchImpl)),
  );
  const features = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!features.length && results.every((result) => result.status === "rejected")) {
    throw new Error("boundary_street_lookup_failed");
  }
  const value = {
    street_names: normalizeBoundaryStreetNames(features),
    source: "U.S. Census Bureau TIGERweb Transportation",
    retrieved_at: now().toISOString(),
    boundary_buffer_meters: BOUNDARY_BUFFER_METERS,
    review_required: true,
  };
  cache.set(cacheKey, { cachedAt: now().getTime(), value });
  return value;
}

