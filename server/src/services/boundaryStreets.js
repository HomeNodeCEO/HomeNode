const TIGERWEB_TRANSPORTATION_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";
const ROAD_LAYERS = [0, 1, 2];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_BUFFER_METERS = 75;
const CARDINAL_SIDES = ["north", "east", "south", "west"];
const LAYER_WEIGHTS = new Map([[0, 1.55], [1, 1.3], [2, 1]]);
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

function boundarySide(start, end, center) {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    return midpoint[1] >= center[1] ? "north" : "south";
  }
  return midpoint[0] >= center[0] ? "east" : "west";
}

function confidenceFor(top, second) {
  if (!top) return "unavailable";
  const separation = second ? top.score / Math.max(second.score, 1) : Number.POSITIVE_INFINITY;
  if (top.score >= 250 && separation >= 1.45) return "high";
  if (top.score >= 90 && separation >= 1.15) return "medium";
  return "low";
}

export function summarizeCardinalBoundaries(features = [], ring = []) {
  const empty = Object.fromEntries(CARDINAL_SIDES.map((side) => [side, {
    primary_street: null,
    confidence: "unavailable",
    candidates: [],
  }]));
  if (!ring.length) return empty;
  const originLatitude = ring.reduce((sum, point) => sum + Number(point[1]), 0) / ring.length;
  const boundary = ring.map((point) => projectedPoint(point, originLatitude));
  const center = [
    (Math.min(...boundary.map((point) => point[0])) + Math.max(...boundary.map((point) => point[0]))) / 2,
    (Math.min(...boundary.map((point) => point[1])) + Math.max(...boundary.map((point) => point[1]))) / 2,
  ];
  const boundarySegments = [];
  for (let index = 1; index < boundary.length; index += 1) {
    const start = boundary[index - 1];
    const end = boundary[index];
    if (start[0] === end[0] && start[1] === end[1]) continue;
    boundarySegments.push({ start, end, side: boundarySide(start, end, center) });
  }
  const networkLengthByName = new Map();
  for (const feature of features) {
    const name = normalizeBoundaryStreetNames([feature])[0];
    if (!name) continue;
    let featureLength = 0;
    for (const path of feature?.geometry?.paths || []) {
      for (let index = 1; index < path.length; index += 1) {
        const start = projectedPoint(path[index - 1], originLatitude);
        const end = projectedPoint(path[index], originLatitude);
        featureLength += Math.hypot(end[0] - start[0], end[1] - start[1]);
      }
    }
    networkLengthByName.set(name, (networkLengthByName.get(name) || 0) + featureLength);
  }
  const scoresBySide = new Map(CARDINAL_SIDES.map((side) => [side, new Map()]));
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
        let best = { distance: Number.POSITIVE_INFINITY, alignment: 0, side: null };
        for (const boundarySegment of boundarySegments) {
          const candidate = segmentDistanceAndAlignment(
            midpoint,
            roadVector,
            boundarySegment.start,
            boundarySegment.end,
          );
          if (candidate.distance < best.distance) {
            best = { ...candidate, side: boundarySegment.side };
          }
        }
        if (best.side && best.distance <= BOUNDARY_BUFFER_METERS && best.alignment >= 0.78) {
          const proximity = 1 - best.distance / BOUNDARY_BUFFER_METERS;
          const layerWeight = LAYER_WEIGHTS.get(Number(feature.road_layer)) || 1;
          const networkLength = Math.min(Math.max(networkLengthByName.get(name) || roadLength, 100), 15000);
          const continuityWeight = (networkLength / 100) ** 0.55;
          const score = roadLength * best.alignment * proximity * layerWeight * continuityWeight;
          const sideScores = scoresBySide.get(best.side);
          sideScores.set(name, (sideScores.get(name) || 0) + score);
        }
      }
    }
  }
  return Object.fromEntries(CARDINAL_SIDES.map((side) => {
    const candidates = [...scoresBySide.get(side).entries()]
      .filter(([, score]) => score >= 35)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([name, score]) => ({ name, score: Math.round(score) }));
    return [side, {
      primary_street: candidates[0]?.name || null,
      confidence: confidenceFor(candidates[0], candidates[1]),
      candidates,
    }];
  }));
}

export function rankBoundaryStreetNames(features = [], ring = []) {
  const cardinal = summarizeCardinalBoundaries(features, ring);
  return [...new Set(CARDINAL_SIDES.map((side) => cardinal[side].primary_street).filter(Boolean))];
}

function cardinalSummary(cardinal) {
  return CARDINAL_SIDES
    .filter((side) => cardinal[side]?.primary_street)
    .map((side) => `${side[0].toUpperCase()}${side.slice(1)}: ${cardinal[side].primary_street}`)
    .join("; ");
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
  return Array.isArray(payload?.features)
    ? payload.features.map((feature) => ({ ...feature, road_layer: layer }))
    : [];
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
  const cardinalBoundaries = summarizeCardinalBoundaries(features, ring);
  const value = {
    street_names: [...new Set(CARDINAL_SIDES
      .map((side) => cardinalBoundaries[side].primary_street)
      .filter(Boolean))],
    cardinal_boundaries: cardinalBoundaries,
    summary: cardinalSummary(cardinalBoundaries),
    source: "U.S. Census Bureau TIGERweb Transportation",
    retrieved_at: now().toISOString(),
    boundary_buffer_meters: BOUNDARY_BUFFER_METERS,
    review_required: true,
  };
  cache.set(cacheKey, { cachedAt: now().getTime(), value });
  return value;
}
