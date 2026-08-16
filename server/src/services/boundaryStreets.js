const TIGERWEB_TRANSPORTATION_URL =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer";
const ROAD_LAYERS = [0, 1, 2];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BOUNDARY_BUFFER_METERS = 75;
const MAJOR_ROAD_SEARCH_METERS = 3219;
const MAJOR_ROAD_INWARD_TOLERANCE_METERS = 350;
const MIN_MAJOR_ROAD_AADT = 10000;
const MIN_MAJOR_ROAD_ALIGNMENT = 0.72;
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

function trafficValue(feature) {
  const value = Number(feature?.attributes?.AADT ?? feature?.attributes?.current_aadt);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sideEdgeDistance(side, midpoint, bounds) {
  if (side === "north") return midpoint[1] - bounds.maxY;
  if (side === "south") return bounds.minY - midpoint[1];
  if (side === "east") return midpoint[0] - bounds.maxX;
  return bounds.minX - midpoint[0];
}

function confidenceForMajorRoad(top, second) {
  if (!top) return "unavailable";
  const separation = second ? top.score - second.score : 1;
  if (top.score >= 0.72 && separation >= 0.12) return "high";
  if (top.score >= 0.52 && separation >= 0.05) return "medium";
  return "low";
}

/**
 * Select one broad, traffic-backed perimeter road for each cardinal side.
 *
 * This intentionally does not consider local streets. A road must have a
 * measured TxDOT AADT of at least 10,000 vehicles/day, run in the expected
 * direction for the side, and sit outside (or immediately inside) the
 * analysis-area edge. AADT is the dominant factor; proximity and corridor
 * continuity keep a distant freeway from displacing the road that actually
 * borders the selected area.
 */
export function summarizeBusyCardinalBoundaries(features = [], ring = []) {
  const empty = Object.fromEntries(CARDINAL_SIDES.map((side) => [side, {
    primary_street: null,
    confidence: "unavailable",
    candidates: [],
  }]));
  if (!ring.length) return empty;

  const originLatitude = ring.reduce((sum, point) => sum + Number(point[1]), 0) / ring.length;
  const boundary = ring.map((point) => projectedPoint(point, originLatitude));
  const bounds = {
    minX: Math.min(...boundary.map((point) => point[0])),
    maxX: Math.max(...boundary.map((point) => point[0])),
    minY: Math.min(...boundary.map((point) => point[1])),
    maxY: Math.max(...boundary.map((point) => point[1])),
  };
  const center = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
  const grouped = new Map(CARDINAL_SIDES.map((side) => [side, new Map()]));

  for (const feature of features) {
    const name = normalizeBoundaryStreetNames([feature])[0];
    const aadt = trafficValue(feature);
    if (!name || aadt < MIN_MAJOR_ROAD_AADT) continue;
    for (const path of feature?.geometry?.paths || []) {
      for (let index = 1; index < path.length; index += 1) {
        const start = projectedPoint(path[index - 1], originLatitude);
        const end = projectedPoint(path[index], originLatitude);
        const deltaX = end[0] - start[0];
        const deltaY = end[1] - start[1];
        const length = Math.hypot(deltaX, deltaY);
        if (!length) continue;
        const midpoint = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        const horizontalAlignment = Math.abs(deltaX) / length;
        const verticalAlignment = Math.abs(deltaY) / length;
        const side = horizontalAlignment >= verticalAlignment
          ? (midpoint[1] >= center[1] ? "north" : "south")
          : (midpoint[0] >= center[0] ? "east" : "west");
        const alignment = side === "north" || side === "south"
          ? horizontalAlignment
          : verticalAlignment;
        if (alignment < MIN_MAJOR_ROAD_ALIGNMENT) continue;
        const signedEdgeDistance = sideEdgeDistance(side, midpoint, bounds);
        if (
          signedEdgeDistance < -MAJOR_ROAD_INWARD_TOLERANCE_METERS ||
          signedEdgeDistance > MAJOR_ROAD_SEARCH_METERS
        ) continue;

        const sideGroups = grouped.get(side);
        const current = sideGroups.get(name) || {
          name,
          max_aadt: 0,
          traffic_weighted_length: 0,
          length: 0,
          min_edge_distance_meters: Number.POSITIVE_INFINITY,
          source_date: feature?.attributes?.SOURCE_DATE || null,
        };
        current.max_aadt = Math.max(current.max_aadt, aadt);
        current.traffic_weighted_length += aadt * length;
        current.length += length;
        current.min_edge_distance_meters = Math.min(
          current.min_edge_distance_meters,
          Math.max(0, signedEdgeDistance),
        );
        current.source_date ||= feature?.attributes?.SOURCE_DATE || null;
        sideGroups.set(name, current);
      }
    }
  }

  return Object.fromEntries(CARDINAL_SIDES.map((side) => {
    const groups = [...grouped.get(side).values()];
    const maxAadt = Math.max(...groups.map((group) => group.max_aadt), 1);
    const maxLength = Math.max(...groups.map((group) => group.length), 1);
    const candidates = groups.map((group) => {
      const averageAadt = group.length
        ? group.traffic_weighted_length / group.length
        : group.max_aadt;
      const trafficScore = group.max_aadt / maxAadt;
      const proximityScore = 1 - Math.min(
        group.min_edge_distance_meters / MAJOR_ROAD_SEARCH_METERS,
        1,
      );
      const continuityScore = Math.min(group.length / maxLength, 1);
      return {
        name: group.name,
        score: Number((trafficScore * 0.65 + proximityScore * 0.25 + continuityScore * 0.10).toFixed(4)),
        annual_average_daily_traffic: Math.round(averageAadt),
        peak_segment_aadt: Math.round(group.max_aadt),
        distance_to_analysis_edge_miles: Number((group.min_edge_distance_meters / 1609.344).toFixed(2)),
        source_date: group.source_date,
      };
    }).sort((left, right) =>
      right.score - left.score ||
      right.peak_segment_aadt - left.peak_segment_aadt ||
      left.distance_to_analysis_edge_miles - right.distance_to_analysis_edge_miles,
    ).slice(0, 3);
    return [side, {
      primary_street: candidates[0]?.name || null,
      confidence: confidenceForMajorRoad(candidates[0], candidates[1]),
      candidates,
    }];
  }));
}

function trafficRoadFeature(row) {
  const geometry = row?.geometry;
  const paths = geometry?.type === "MultiLineString"
    ? geometry.coordinates
    : geometry?.type === "LineString"
      ? [geometry.coordinates]
      : [];
  if (!paths.length) return null;
  return {
    attributes: {
      NAME: row.name || row.route_name,
      BASENAME: row.base_name,
      AADT: row.current_aadt,
      SOURCE_DATE: row.source_date,
      TXDOT_ROUTE_NAME: row.route_name,
    },
    geometry: { paths },
  };
}

function boundaryStreetResult(features, ring, { source, now }) {
  const cardinalBoundaries = summarizeCardinalBoundaries(features, ring);
  return {
    street_names: [...new Set(CARDINAL_SIDES
      .map((side) => cardinalBoundaries[side].primary_street)
      .filter(Boolean))],
    cardinal_boundaries: cardinalBoundaries,
    summary: cardinalSummary(cardinalBoundaries),
    source,
    retrieved_at: now().toISOString(),
    boundary_buffer_meters: BOUNDARY_BUFFER_METERS,
    review_required: true,
  };
}

function trafficBoundaryStreetResult(features, ring, { now }) {
  const cardinalBoundaries = summarizeBusyCardinalBoundaries(features, ring);
  return {
    street_names: [...new Set(CARDINAL_SIDES
      .map((side) => cardinalBoundaries[side].primary_street)
      .filter(Boolean))],
    cardinal_boundaries: cardinalBoundaries,
    summary: cardinalSummary(cardinalBoundaries),
    source: "Local TxDOT AADT mirror with Census road names",
    retrieved_at: now().toISOString(),
    minimum_aadt: MIN_MAJOR_ROAD_AADT,
    major_road_search_meters: MAJOR_ROAD_SEARCH_METERS,
    review_required: true,
  };
}

async function queryLocalTrafficBoundaryRoads(pool, geometry) {
  const { rows } = await pool.query(
    `WITH boundary AS (
       SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS geom
     ), traffic AS (
       SELECT segment.route_name, segment.current_aadt, segment.source_date, segment.geom
       FROM gis.traffic_volume_segments segment
       CROSS JOIN boundary
       WHERE segment.current_aadt >= $2
         AND segment.geom && ST_Expand(
           ST_Envelope(boundary.geom),
           $3::double precision / 111320.0
         )
         AND ST_DWithin(
           segment.geom::geography,
           boundary.geom::geography,
           $3::double precision
         )
     )
     SELECT COALESCE(named.name, traffic.route_name) AS name,
            named.base_name,
            traffic.route_name,
            traffic.current_aadt,
            traffic.source_date,
            ST_AsGeoJSON(traffic.geom)::jsonb AS geometry
     FROM traffic
     LEFT JOIN LATERAL (
       SELECT road.name, road.base_name
       FROM gis.road_segments road
       WHERE road.road_class IN ('primary', 'secondary')
         AND road.name IS NOT NULL
         AND road.geom && ST_Expand(ST_Envelope(traffic.geom), 0.00125)
         AND ST_DWithin(road.geom::geography, traffic.geom::geography, 140)
       ORDER BY ST_Distance(road.geom::geography, traffic.geom::geography),
                CASE road.road_class WHEN 'primary' THEN 0 ELSE 1 END,
                road.source_object_id
       LIMIT 1
     ) named ON TRUE
     WHERE COALESCE(named.name, traffic.route_name) IS NOT NULL
     ORDER BY traffic.current_aadt DESC, COALESCE(named.name, traffic.route_name)
     LIMIT 6000`,
    [JSON.stringify(geometry), MIN_MAJOR_ROAD_AADT, MAJOR_ROAD_SEARCH_METERS],
  );
  return rows.map(trafficRoadFeature).filter(Boolean);
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
  const value = boundaryStreetResult(features, ring, {
    source: "U.S. Census Bureau TIGERweb Transportation",
    now,
  });
  cache.set(cacheKey, { cachedAt: now().getTime(), value });
  return value;
}

/**
 * Resolve automatic cardinal boundaries from the local TxDOT AADT mirror.
 * Census road geometry is used only to turn TxDOT route codes into readable
 * road names. The engine disables remote fallback so a data outage produces a
 * visible review warning instead of silently substituting a neighborhood road.
 */
export async function loadBoundaryStreetNames(
  pool,
  geometry,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    allowRemoteFallback = false,
  } = {},
) {
  const ring = normalizedRing(geometry);
  try {
    const features = await queryLocalTrafficBoundaryRoads(pool, geometry);
    if (features.length) {
      return {
        ...trafficBoundaryStreetResult(features, ring, { now }),
        served_from_local_mirror: true,
      };
    }
  } catch (error) {
    if (!allowRemoteFallback) throw error;
  }
  if (!allowRemoteFallback) throw new Error("local_txdot_boundary_roads_unavailable");
  const fallback = await fetchBoundaryStreetNames(geometry, { fetchImpl, now });
  return {
    ...fallback,
    served_from_local_mirror: false,
    fallback_reason: "local_boundary_roads_unavailable",
  };
}

