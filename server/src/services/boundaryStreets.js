const TIGERWEB_TRANSPORTATION_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";
const ROAD_LAYERS = [0, 1, 2];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_BUFFER_METERS = 75;
const MAX_BOUNDARY_STREETS = 40;
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

function projectedPoint(point, originLatitude) {
  const radians = originLatitude * Math.PI / 180;
  return [
    Number(point[0]) * 111320 * Math.cos(radians),
    Number(point[1]) * 110540,
  ];
}

function segmentDistanceAndAlignment(point, roadVector, boundaryStart, boundaryEnd) {
  const boundaryVector = [
    boundaryEnd[0] - boundaryStart[0],
    boundaryEnd[1] - boundaryStart[1],
  ];
  const boundaryLengthSquared = boundaryVector[0] ** 2 + boundaryVector[1] ** 2;
  if (!boundaryLengthSquared) return { distance: Number.POSITIVE_INFINITY, alignment: 0 };
  const projection = Math.max(0, Math.min(1,
    ((point[0] - boundaryStart[0]) * boundaryVector[0] +
      (point[1] - boundaryStart[1]) * boundaryVector[1]) / boundaryLengthSquared,
  ));
  const nearest = [
    boundaryStart[0] + projection * boundaryVector[0],
    boundaryStart[1] + projection * boundaryVector[1],
  ];
  const distance = Math.hypot(point[0] - nearest[0], point[1] - nearest[1]);
  const roadLength = Math.hypot(roadVector[0], roadVector[1]);
  const boundaryLength = Math.sqrt(boundaryLengthSquared);
  const alignment = roadLength
    ? Math.abs(roadVector[0] * boundaryVector[0] + roadVector[1] * boundaryVector[1]) /
      (roadLength * boundaryLength)
    : 0;
  return { distance, alignment };
}

export function rankBoundaryStreetNames(features = [], ring = []) {
  if (!ring.length) return normalizeBoundaryStreetNames(features).slice(0, MAX_BOUNDARY_STREETS);
  const originLatitude = ring.reduce((sum, point) => sum + Number(point[1]), 0) / ring.length;
  const boundary = ring.map((point) => projectedPoint(point, originLatitude));
  const scores = new Map();
  for (const feature of features) {
    const name = normalizeBoundaryStreetNames([feature])[0];
    if (!name) continue;
    for (const path of feature?.geometry?.paths || []) {
      for (let index = 1; index < path.length; index += 1) {
        const start = projectedPoint(path[index - 1], originLatitude);
        const end = projectedPoint(path[index], originLatitude);
        const roadVector = [end[0] - start[0], end[1] - start[1]];
        const roadLength = Math.hypot(roadVector[0], roadVector[1]);
        if (!roadLength) continue;
        const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        let best = { distance: Number.POSITIVE_INFINITY, alignment: 0 };
        for (let boundaryIndex = 1; boundaryIndex < boundary.length; boundaryIndex += 1) {
          const candidate = segmentDistanceAndAlignment(
            midpoint,
            roadVector,
            boundary[boundaryIndex - 1],
            boundary[boundaryIndex],
          );
          if (candidate.distance < best.distance) best = candidate;
        }
        if (best.distance <= BOUNDARY_BUFFER_METERS && best.alignment >= 0.78) {
          const proximity = 1 - best.distance / BOUNDARY_BUFFER_METERS;
          scores.set(name, (scores.get(name) || 0) + roadLength * best.alignment * proximity);
        }
      }
    }
  }
  const ranked = [...scores.entries()]
    .filter(([, score]) => score >= 35)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_BOUNDARY_STREETS)
    .map(([name]) => name);
  return ranked.length
    ? ranked.sort((left, right) => left.localeCompare(right))
    : normalizeBoundaryStreetNames(features).slice(0, MAX_BOUNDARY_STREETS);
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
    returnGeometry: "true",
    outSR: "4326",
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
    street_names: rankBoundaryStreetNames(features, ring),
    source: "U.S. Census Bureau TIGERweb Transportation",
    retrieved_at: now().toISOString(),
    boundary_buffer_meters: BOUNDARY_BUFFER_METERS,
    review_required: true,
  };
  cache.set(cacheKey, { cachedAt: now().getTime(), value });
  return value;
}
