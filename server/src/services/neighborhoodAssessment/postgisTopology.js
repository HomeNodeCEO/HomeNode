import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonicalAssessmentJson } from "./contract.js";
import { prepareNeighborhoodLinework } from "./graphPreparation.js";

export const POSTGIS_TOPOLOGY_VERSION = "postgis-planar-v3";
export const POSTGIS_TOPOLOGY_LIMITS = Object.freeze({
  input_parts: 512, input_coordinates: 8192, cells: 1024, edges: 8192,
  primitive_segments: 512, candidate_pairs: 4096,
  source_references: 16384, output_bytes: 32_000_000, row_bytes: 128_000,
  statement_ms: 5000, duration_ms: 20_000, connect_ms: 3000,
});
// Failure controls use a separate fixed envelope: an output limit of one byte
// cannot encode even a reason. No geometry/source descriptor escapes this cap.
export const POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES = 16_384;
const METRIC_SRID = 26914;
// Conservative v1 projection-support window only: not a jurisdiction boundary,
// a survey-grade accuracy guarantee, or permission to fabricate closure edges.
const SUPPORTED_PROJECTION_WINDOW = Object.freeze([-98.5, 31, -95.5, 34.5]);
const MINIMUM_CELL_AREA_M2 = 1;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hashPattern = /^[a-f0-9]{64}$/;
const DIAGNOSTICS = ["invalid_source_count", "nonsimple_source_count", "noded_coordinate_count", "edge_count", "cell_count",
  "node_count", "source_reference_count", "source_point_incidence_count", "source_chain_count", "invalid_source_witness_count", "ambiguous_source_order_count",
  "invalid_cell_count", "sliver_cell_count", "unattributed_edge_count", "uncovered_source_segment_count", "ambiguous_source_edge_count",
  "invalid_incidence_count", "unsupported_boundary_count", "overlapping_cell_count", "multisource_edge_count",
  "unused_edge_count", "dangle_node_count"];
function invalid(field) { throw new TypeError(`invalid_neighborhood_topology:${field}`); }
// Driver/pool exceptions may carry arbitrary properties. Only privately issued
// errors can supply a classified reason; never inspect external error messages,
// prototypes, codes or getters when constructing a public failure response.
const INTERNAL_FAILURES = new WeakMap();
function internalFailure(reason) {
  const error = new Error('neighborhood_topology_incomplete');
  INTERNAL_FAILURES.set(error, reason);
  return error;
}
function stop(code) { throw internalFailure(code); }
function releaseSafely(client, error) {
  try {
    const result = client.release(error);
    // pg release is synchronous. Consume an unexpected asynchronous rejection
    // without waiting on an unbounded custom cleanup implementation or claiming
    // that the connection was synchronously returned to its pool.
    if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {});
      return false;
    }
    return true;
  } catch { return false; }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function limitsOf(requested = {}) {
  const limits = { ...POSTGIS_TOPOLOGY_LIMITS };
  for (const [key, value] of Object.entries(requested)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) invalid("limits");
    limits[key] = value;
  }
  return limits;
}
function inProjectionWindow([longitude, latitude]) {
  const [west, south, east, north] = SUPPORTED_PROJECTION_WINDOW;
  return longitude >= west && longitude <= east && latitude >= south && latitude <= north;
}
async function connect(pool, timeout) {
  let expired = false, timer;
  const pending = Promise.resolve().then(() => pool.connect()).then(client => {
    if (expired) { releaseSafely(client); stop("connection_timeout"); }
    return client;
  });
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(internalFailure("connection_timeout")); }, timeout);
    })]);
  } finally { clearTimeout(timer); }
}

const VERSION_SQL = `SELECT postgis_lib_version() AS postgis_version,
  postgis_geos_version() AS geos_version, postgis_proj_version() AS proj_version,
  s.auth_name,s.auth_srid,s.proj4text,s.srtext,
  EXISTS(SELECT 1 FROM pg_proc WHERE proname='st_dumpsegments') AS dump_segments_available
  FROM spatial_ref_sys s WHERE s.srid=26914`;

// ST_Transform changes the endpoint chords, so candidate boxes must be measured
// in the same projected plane as ST_Node, never inferred from geographic boxes.
// At most512 primitives means at most130816 unordered bbox comparisons. A LIMIT
// bounds retained matching pairs before any noding/polygonization can run.
function admissionSql(limits) {
  return `WITH parts AS MATERIALIZED (
    SELECT p.feature_id,p.source_part_index,
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(p.geometry),4326),26914) AS geom
    FROM jsonb_to_recordset($1::jsonb) AS p(feature_id text,source_part_index integer,geometry jsonb)
  ), primitives AS MATERIALIZED (
    SELECT p.feature_id,p.source_part_index,d.path[1] AS source_segment_index,d.geom
    FROM parts p CROSS JOIN LATERAL ST_DumpSegments(p.geom) d
  ), candidates AS MATERIALIZED (
    SELECT 1 FROM primitives a JOIN primitives b
      ON (a.feature_id,a.source_part_index,a.source_segment_index)<(b.feature_id,b.source_part_index,b.source_segment_index)
      AND a.geom && b.geom LIMIT ${limits.candidate_pairs + 1}
  ) SELECT (SELECT count(*)::integer FROM primitives) AS primitive_segments,
    (SELECT count(*)::integer FROM candidates) AS candidate_pairs`;
}

function nodingAdmission(primitiveCount, coordinateCount, pairs, limits) {
  // Each candidate pair of straight original primitives contributes at most
  // four conservative split-piece/source-occurrence contributions (including
  // overlap endpoints). Do not discount adjacent, same-part or duplicate lines.
  const result = { policy: 'projected-primitive-bbox-v1', primitive_segments: primitiveCount,
    original_coordinates: coordinateCount, candidate_pairs: pairs,
    candidate_pairs_complete: pairs <= limits.candidate_pairs,
    split_pieces_upper_bound: pairs <= limits.candidate_pairs ? primitiveCount + 4 * pairs : null,
    noded_coordinates_upper_bound: pairs <= limits.candidate_pairs ? coordinateCount + 8 * pairs : null };
  result.admitted = result.candidate_pairs_complete && result.split_pieces_upper_bound <= limits.edges &&
    result.split_pieces_upper_bound <= limits.source_references && result.noded_coordinates_upper_bound <= limits.edges * 4;
  return result;
}

// No ST_Snap, ST_MakeLine, buffer, hull, envelope edge or repair fallback.
// ST_Node dissolves overlapping linework but source_matches retains every
// original primitive occurrence. Attribution compares existing edge endpoints
// with consecutive source-local endpoint/intersection witnesses. It does not
// interpolate or create linework, and does not claim the rounded GEOS witness
// is exactly collinear with its original primitives. ST_Polygonize yields planar
// faces, not a claim that holes/land uses should belong to one neighborhood.
function topologySql(limits, admission) {
  const pointIncidenceBudget = 2 * admission.primitive_segments + 4 * admission.candidate_pairs;
  const chainBudget = admission.split_pieces_upper_bound;
  return `WITH source_parts AS MATERIALIZED (
    SELECT p.feature_id,p.source_part_index,
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(p.geometry),4326),26914) AS geom
    FROM jsonb_to_recordset($1::jsonb) AS p(feature_id text,source_part_index integer,geometry jsonb)
  ), source_checks AS (
    SELECT count(*) FILTER(WHERE NOT ST_IsValid(geom) OR ST_IsEmpty(geom) OR ST_Length(geom)<=0)::integer AS invalid_sources,
      count(*) FILTER(WHERE NOT ST_IsSimple(geom))::integer AS nonsimple_sources FROM source_parts
  ), source_segments AS MATERIALIZED (
    SELECT p.feature_id,p.source_part_index,d.path[1] AS source_segment_index,d.geom
    FROM source_parts p CROSS JOIN LATERAL ST_DumpSegments(p.geom) d
    WHERE ST_Length(d.geom)>0
  ), source_pairs AS MATERIALIZED (
    SELECT a.feature_id AS a_feature,a.source_part_index AS a_part,a.source_segment_index AS a_segment,a.geom AS a_geom,
      b.feature_id AS b_feature,b.source_part_index AS b_part,b.source_segment_index AS b_segment,b.geom AS b_geom
    FROM source_segments a JOIN source_segments b
      ON (a.feature_id,a.source_part_index,a.source_segment_index)<(b.feature_id,b.source_part_index,b.source_segment_index)
      AND a.geom && b.geom LIMIT ${admission.candidate_pairs + 1}
  ), source_pair_count AS (SELECT count(*)::integer AS count FROM source_pairs),
  pair_intersections AS MATERIALIZED (
    SELECT p.*,ST_Intersection(ST_Normalize(a_geom),ST_Normalize(b_geom)) AS geom
    FROM source_pairs p WHERE (SELECT count FROM source_pair_count)<=${admission.candidate_pairs}
  ), checked_intersections AS MATERIALIZED (
    SELECT p.*,ST_IsEmpty(geom) AS empty,
      ST_IsValid(geom) AND ST_SRID(geom)=26914 AND ST_NDims(geom)=2 AND
      ((GeometryType(geom)='POINT' AND ST_NPoints(geom)=1) OR
       (GeometryType(geom)='LINESTRING' AND ST_NPoints(geom)=2 AND ST_Length(geom)>0)) AS valid_witness
    FROM pair_intersections p
  ), invalid_witnesses AS (
    SELECT (count(*) FILTER(WHERE empty IS DISTINCT FROM true AND valid_witness IS DISTINCT FROM true)+
      CASE WHEN (SELECT count FROM source_pair_count)>${admission.candidate_pairs} THEN 1 ELSE 0 END)::integer AS count
    FROM checked_intersections
  ), pair_points AS MATERIALIZED (
    SELECT p.a_feature,p.a_part,p.a_segment,p.b_feature,p.b_part,p.b_segment,
      ST_AsEWKB(w.geom,'NDR') AS point_bytes
    FROM checked_intersections p CROSS JOIN LATERAL (
      SELECT p.geom WHERE GeometryType(p.geom)='POINT'
      UNION ALL SELECT ST_StartPoint(p.geom) WHERE GeometryType(p.geom)='LINESTRING'
      UNION ALL SELECT ST_EndPoint(p.geom) WHERE GeometryType(p.geom)='LINESTRING'
    ) w(geom) WHERE NOT p.empty AND p.valid_witness
  ), source_point_incidences AS MATERIALIZED (
    SELECT feature_id,source_part_index,source_segment_index,ST_AsEWKB(ST_StartPoint(geom),'NDR') AS point_bytes FROM source_segments
    UNION ALL SELECT feature_id,source_part_index,source_segment_index,ST_AsEWKB(ST_EndPoint(geom),'NDR') FROM source_segments
    UNION ALL SELECT a_feature,a_part,a_segment,point_bytes FROM pair_points
    UNION ALL SELECT b_feature,b_part,b_segment,point_bytes FROM pair_points
    LIMIT ${pointIncidenceBudget + 1}
  ), source_point_count AS (SELECT count(*)::integer AS count FROM source_point_incidences),
  unique_source_points AS MATERIALIZED (
    SELECT DISTINCT feature_id,source_part_index,source_segment_index,point_bytes FROM source_point_incidences
    WHERE (SELECT count FROM source_point_count)<=${pointIncidenceBudget} AND (SELECT count FROM invalid_witnesses)=0
  ), located_source_points AS MATERIALIZED (
    SELECT w.*,p.start_bytes,p.end_bytes,
      CASE WHEN w.point_bytes=p.start_bytes THEN 0::double precision
        WHEN w.point_bytes=p.end_bytes THEN 1::double precision
        WHEN abs(p.dx)>=abs(p.dy) THEN (ST_X(ST_GeomFromEWKB(w.point_bytes))-p.x0)/p.dx
        ELSE (ST_Y(ST_GeomFromEWKB(w.point_bytes))-p.y0)/p.dy END AS order_fraction
    FROM unique_source_points w JOIN (
      SELECT s.*,ST_AsEWKB(ST_StartPoint(geom),'NDR') AS start_bytes,ST_AsEWKB(ST_EndPoint(geom),'NDR') AS end_bytes,
        ST_X(ST_StartPoint(geom)) AS x0,ST_Y(ST_StartPoint(geom)) AS y0,
        ST_X(ST_EndPoint(geom))-ST_X(ST_StartPoint(geom)) AS dx,
        ST_Y(ST_EndPoint(geom))-ST_Y(ST_StartPoint(geom)) AS dy FROM source_segments s
    ) p USING(feature_id,source_part_index,source_segment_index)
  ), source_order AS MATERIALIZED (
    SELECT feature_id,source_part_index,source_segment_index,
      count(*)>=2 AND count(DISTINCT order_fraction)=count(*) AND min(order_fraction)=0 AND max(order_fraction)=1 AND
      bool_and((point_bytes=start_bytes AND order_fraction=0) OR (point_bytes=end_bytes AND order_fraction=1) OR
        (point_bytes<>start_bytes AND point_bytes<>end_bytes AND order_fraction>0 AND order_fraction<1)) AS valid_order
    FROM located_source_points GROUP BY feature_id,source_part_index,source_segment_index
  ), ordered_source_points AS (
    SELECT p.feature_id,p.source_part_index,p.source_segment_index,p.point_bytes,p.order_fraction,
      lead(p.point_bytes) OVER w AS next_point_bytes,lead(p.order_fraction) OVER w AS next_fraction
    FROM located_source_points p JOIN source_order o USING(feature_id,source_part_index,source_segment_index)
    WHERE o.valid_order WINDOW w AS (PARTITION BY p.feature_id,p.source_part_index,p.source_segment_index ORDER BY p.order_fraction)
  ), source_chains AS MATERIALIZED (
    SELECT * FROM ordered_source_points WHERE next_point_bytes IS NOT NULL LIMIT ${chainBudget + 1}
  ), source_chain_count AS (SELECT count(*)::integer AS count FROM source_chains),
  source_chain_budget AS (
    SELECT (SELECT count FROM source_chain_count)<=${chainBudget} AS allowed
  ), noded AS MATERIALIZED (
    SELECT ST_Node(ST_Collect(ST_Normalize(geom) ORDER BY encode(ST_AsEWKB(ST_Normalize(geom)),'hex'),feature_id,source_part_index)) AS geom
    FROM source_parts WHERE (SELECT invalid_sources FROM source_checks)=0
  ), node_size AS (
    SELECT COALESCE(ST_NPoints(geom),0)::integer AS noded_coordinate_count FROM noded
  ), segments AS MATERIALIZED (
    SELECT DISTINCT ST_Normalize(d.geom) AS geom FROM noded
    CROSS JOIN LATERAL ST_DumpSegments(noded.geom) d
    WHERE (SELECT noded_coordinate_count FROM node_size)<=${limits.edges * 4}
    LIMIT ${limits.edges + 1}
  ), edge_count AS (SELECT count(*)::integer AS count FROM segments),
  edges AS MATERIALIZED (
    SELECT 'edge:'||encode(sha256(ST_AsEWKB(geom)),'hex') AS id,geom,
      'node:'||encode(sha256(ST_AsEWKB(ST_StartPoint(geom))),'hex') AS from_node_id,
      'node:'||encode(sha256(ST_AsEWKB(ST_EndPoint(geom))),'hex') AS to_node_id,
      ST_AsEWKB(ST_StartPoint(geom),'NDR') AS start_bytes,ST_AsEWKB(ST_EndPoint(geom),'NDR') AS end_bytes
    FROM segments WHERE (SELECT count FROM edge_count)<=${limits.edges}
  ), polygonized AS (
    SELECT ST_Polygonize(geom) AS geom FROM noded
    WHERE (SELECT count FROM edge_count)<=${limits.edges}
      AND (SELECT noded_coordinate_count FROM node_size)<=${limits.edges * 4}
  ), face_parts AS MATERIALIZED (
    SELECT ST_Normalize(d.geom) AS geom FROM polygonized
    CROSS JOIN LATERAL ST_Dump(polygonized.geom) d LIMIT ${limits.cells + 1}
  ), face_count AS (SELECT count(*)::integer AS count FROM face_parts),
  faces AS MATERIALIZED (
    SELECT 'cell:'||encode(sha256(ST_AsEWKB(geom)),'hex') AS id,geom,
      ST_Area(geom) AS area_m2,ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AS valid
    FROM face_parts WHERE (SELECT count FROM face_count)<=${limits.cells}
  ), matched_source_chains AS MATERIALIZED (
    SELECT c.*,e.id AS edge_id,
      CASE WHEN e.start_bytes=c.point_bytes THEN c.order_fraction ELSE c.next_fraction END AS start_fraction,
      CASE WHEN e.end_bytes=c.next_point_bytes THEN c.next_fraction ELSE c.order_fraction END AS end_fraction
    FROM source_chains c LEFT JOIN edges e ON ST_NPoints(e.geom)=2 AND
      LEAST(e.start_bytes,e.end_bytes)=LEAST(c.point_bytes,c.next_point_bytes) AND
      GREATEST(e.start_bytes,e.end_bytes)=GREATEST(c.point_bytes,c.next_point_bytes)
    WHERE (SELECT allowed FROM source_chain_budget)
  ), source_matches AS MATERIALIZED (
    SELECT edge_id,feature_id,source_part_index,source_segment_index,start_fraction,end_fraction
    FROM matched_source_chains WHERE edge_id IS NOT NULL
    ORDER BY edge_id,feature_id,source_part_index,source_segment_index LIMIT ${limits.source_references + 1}
  ), source_ref_count AS (SELECT count(*)::integer AS count FROM source_matches),
  incompatible_source_pairs AS MATERIALIZED (
    SELECT a_feature,a_part,a_segment,b_feature,b_part,b_segment FROM source_pairs
    WHERE NOT ST_Relate(a_geom,b_geom,'1********')
  ), ambiguous_edges AS (
    SELECT DISTINCT a.edge_id FROM incompatible_source_pairs p
    JOIN source_matches a ON (a.feature_id,a.source_part_index,a.source_segment_index)=(p.a_feature,p.a_part,p.a_segment)
    JOIN source_matches b ON b.edge_id=a.edge_id
      AND (b.feature_id,b.source_part_index,b.source_segment_index)=(p.b_feature,p.b_part,p.b_segment)
  ), source_coverage AS (
    SELECT feature_id,source_part_index,source_segment_index,
      min(order_fraction)=0 AND max(next_fraction)=1 AND bool_and(edge_id IS NOT NULL) AS fully_covered
    FROM matched_source_chains GROUP BY feature_id,source_part_index,source_segment_index
  ),
  edge_faces AS MATERIALIZED (
    SELECT e.id AS edge_id,f.id AS cell_id FROM edges e JOIN faces f
      ON e.geom && f.geom AND ST_CoveredBy(e.geom,ST_Boundary(f.geom))
  ), edge_data AS MATERIALIZED (
    SELECT e.*,ST_Length(e.geom) AS length_meters,
      COALESCE((SELECT jsonb_agg(ef.cell_id ORDER BY ef.cell_id) FROM edge_faces ef WHERE ef.edge_id=e.id),'[]'::jsonb) AS cell_ids,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('feature_id',s.feature_id,'source_part_index',s.source_part_index,
        'source_segment_index',s.source_segment_index,'source_fraction_basis','source_segment',
        'start_fraction',s.start_fraction,'end_fraction',s.end_fraction) ORDER BY s.feature_id,s.source_part_index,s.source_segment_index)
        FROM source_matches s WHERE s.edge_id=e.id),'[]'::jsonb) AS source_parts
    FROM edges e
  ), face_data AS MATERIALIZED (
    SELECT f.*,
      COALESCE((SELECT jsonb_agg(ef.edge_id ORDER BY ef.edge_id) FROM edge_faces ef WHERE ef.cell_id=f.id),'[]'::jsonb) AS boundary_edge_ids,
      COALESCE((SELECT ST_CoveredBy(ST_Boundary(f.geom),ST_Collect(e.geom)) FROM edge_faces ef
        JOIN edges e ON e.id=ef.edge_id WHERE ef.cell_id=f.id),false) AS boundary_supported
    FROM faces f
  ), endpoints AS (
    SELECT from_node_id AS id,ST_StartPoint(geom) AS geom FROM edges
    UNION ALL SELECT to_node_id,ST_EndPoint(geom) FROM edges
  ), nodes AS MATERIALIZED (
    SELECT id,geom,count(*)::integer AS degree FROM endpoints GROUP BY id,geom
  ), diagnostics AS (
    SELECT (SELECT invalid_sources FROM source_checks) AS invalid_source_count,
      (SELECT nonsimple_sources FROM source_checks) AS nonsimple_source_count,
      (SELECT noded_coordinate_count FROM node_size) AS noded_coordinate_count,
      (SELECT count FROM edge_count) AS edge_count,(SELECT count FROM face_count) AS cell_count,
      (SELECT count(*)::integer FROM nodes) AS node_count,(SELECT count FROM source_ref_count) AS source_reference_count,
      (SELECT count FROM source_point_count) AS source_point_incidence_count,(SELECT count FROM source_chain_count) AS source_chain_count,
      (SELECT count FROM invalid_witnesses) AS invalid_source_witness_count,
      (SELECT count(*)::integer FROM source_order WHERE valid_order IS DISTINCT FROM true) AS ambiguous_source_order_count,
      (SELECT count(*)::integer FROM face_data WHERE NOT valid OR NOT ST_IsValid(ST_Transform(geom,4326))) AS invalid_cell_count,
      (SELECT count(*)::integer FROM face_data WHERE area_m2<${MINIMUM_CELL_AREA_M2}) AS sliver_cell_count,
      (SELECT count(*)::integer FROM edge_data WHERE jsonb_array_length(source_parts)=0) AS unattributed_edge_count,
      (SELECT count(*)::integer FROM source_segments s LEFT JOIN source_coverage c
        USING(feature_id,source_part_index,source_segment_index) WHERE c.fully_covered IS DISTINCT FROM true) AS uncovered_source_segment_count,
      (SELECT count(*)::integer FROM ambiguous_edges) AS ambiguous_source_edge_count,
      (SELECT count(*)::integer FROM edge_data WHERE jsonb_array_length(cell_ids)>2 OR length_meters<=0) AS invalid_incidence_count,
      (SELECT count(*)::integer FROM face_data WHERE NOT boundary_supported) AS unsupported_boundary_count,
      (SELECT count(*)::integer FROM faces a JOIN faces b ON a.id<b.id AND a.geom && b.geom AND ST_Relate(a.geom,b.geom,'2********')) AS overlapping_cell_count,
      (SELECT count(*)::integer FROM edge_data e WHERE (SELECT count(DISTINCT s.feature_id) FROM source_matches s WHERE s.edge_id=e.id)>1) AS multisource_edge_count,
      (SELECT count(*)::integer FROM edge_data WHERE jsonb_array_length(cell_ids)=0) AS unused_edge_count,
      (SELECT count(*)::integer FROM nodes WHERE degree=1) AS dangle_node_count
  ), records AS (
    SELECT 'diagnostics'::text AS kind,'diagnostics'::text AS id,to_jsonb(diagnostics) AS payload FROM diagnostics
    UNION ALL SELECT 'cell',id,jsonb_build_object('id',id,'area_m2',area_m2,
      'geometry_validated',valid AND ST_IsValid(ST_GeomFromGeoJSON(ST_AsGeoJSON(ST_Transform(geom,4326),15))),
      'geometry',ST_AsGeoJSON(ST_Transform(geom,4326),15)::jsonb,'geometry_ewkb',encode(ST_AsEWKB(geom),'hex'),
      'metric_srid',26914,'boundary_edge_ids',boundary_edge_ids,'interior_ring_count',ST_NumInteriorRings(geom)) FROM face_data
    UNION ALL SELECT 'edge',id,jsonb_build_object('id',id,'from_node_id',from_node_id,'to_node_id',to_node_id,
      'length_meters',length_meters,'geometry_validated',ST_IsValid(geom) AND NOT ST_IsEmpty(geom),
      'geometry',ST_AsGeoJSON(ST_Transform(geom,4326),15)::jsonb,'geometry_ewkb',encode(ST_AsEWKB(geom),'hex'),
      'metric_srid',26914,'cell_ids',cell_ids,'source_parts',source_parts) FROM edge_data
    UNION ALL SELECT 'node',id,jsonb_build_object('id',id,'degree',degree,'geometry',ST_AsGeoJSON(ST_Transform(geom,4326),15)::jsonb,
      'geometry_ewkb',encode(ST_AsEWKB(geom),'hex'),'metric_srid',26914) FROM nodes
  ), sized AS (
    SELECT *,octet_length(payload::text) AS row_bytes FROM records
  ), bounded AS (
    SELECT *,sum(row_bytes) OVER() AS total_bytes FROM sized
  ) SELECT kind,id,row_bytes,total_bytes::text,
    CASE WHEN row_bytes<=${limits.row_bytes} AND total_bytes<=${limits.output_bytes} THEN payload ELSE NULL END AS payload
    FROM bounded ORDER BY kind COLLATE "C",id COLLATE "C"`;
}

function versionsOf(row) {
  if (!row || row.auth_name !== "EPSG" || row.auth_srid !== METRIC_SRID || row.dump_segments_available !== true ||
      typeof row.proj4text !== "string" || !/(?:^|\s)\+proj=utm(?:\s|$)/.test(row.proj4text) ||
      !/(?:^|\s)\+zone=14(?:\s|$)/.test(row.proj4text) || !/(?:^|\s)\+units=m(?:\s|$)/.test(row.proj4text) ||
      !/(?:^|\s)\+datum=NAD83(?:\s|$)/.test(row.proj4text) ||
      typeof row.srtext !== "string" || !/UNIT\["(?:metre|meter)",1(?:\]|,)/i.test(row.srtext)) stop("unsupported_projection_policy");
  for (const value of [row.postgis_version, row.geos_version, row.proj_version]) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) stop("engine_version_unavailable");
  }
  return { postgis: row.postgis_version, geos: row.geos_version, proj: row.proj_version,
    spatial_reference_sha256: createHash("sha256").update(canonicalAssessmentJson({ proj4text: row.proj4text, srtext: row.srtext })).digest("hex") };
}

/** Recompute the bounded content manifest, not an authenticity signature or a
 * geometry validator. Consumers must bind the returned revision AND captured
 * source hashes to trusted server evidence; caller-supplied booleans or a newly
 * self-computed hash cannot authorize report use. The manifest intentionally
 * excludes only status/revision bookkeeping and includes descriptive provenance.
 */
export function neighborhoodTopologyRevision(result) {
  if (!result || result.topology_version !== POSTGIS_TOPOLOGY_VERSION || result.metric_srid !== METRIC_SRID ||
      result.display_srid !== 4326 || !hashPattern.test(result.source_capture_sha256) ||
      !hashPattern.test(result.linework_content_sha256) || !result.engine_versions || !result.performed_policy) invalid("manifest");
  const limits = limitsOf(result.limits), digest = createHash("sha256");
  let bytes = 0;
  const append = value => {
    const encoded = canonicalAssessmentJson(value);
    // Bound manifest hashing work, including provenance. The full returned JSON
    // envelope has an additional exact byte check before it can become ready.
    bytes += Buffer.byteLength(encoded) + 1;
    if (bytes > limits.output_bytes) stop("topology_limit_exceeded");
    digest.update(encoded).update("\n");
  };
  append({ version: result.topology_version, metric_srid: result.metric_srid, display_srid: result.display_srid,
    capture: result.source_capture_sha256, content: result.linework_content_sha256, engine_versions: result.engine_versions,
    policy: result.performed_policy, source_coverage: result.source_coverage, source_limitations: result.source_limitations,
    diagnostics: result.diagnostics, noding_admission: result.noding_admission,
    travel_connectivity: result.travel_connectivity, limits });
  for (const [key, max, idKey] of [["source_features", 2000, "feature_id"], ["source_aliases", 5000, "normalized_alias"],
    ["cells", limits.cells, "id"], ["edges", limits.edges, "id"], ["nodes", limits.edges * 2, "id"]]) {
    if (!Array.isArray(result[key]) || result[key].length > max) invalid("manifest_rows");
    append({ collection: key, count: result[key].length });
    // Only bounded row references are copied; payloads are charged/hash-streamed
    // individually, not assembled into a second giant canonical object.
    const rows = [...result[key]].sort((a, b) => compare(a[idKey], b[idKey]) ||
      (key === "source_aliases" ? compare(a.corridor_key, b.corridor_key) : 0));
    for (const row of rows) append(row);
  }
  return `topology:${digest.digest("hex")}`;
}

// Exact UTF-8 JSON size without allocating a second full graph string. Top-level
// collections are already row-bounded; include keys, punctuation, metadata and
// status/revision fields rather than confusing the digest stream with output.
function serializedOutputBytes(output) {
  let bytes = 2, keys = 0;
  for (const [key, value] of Object.entries(output)) {
    bytes += (keys++ ? 1 : 0) + Buffer.byteLength(JSON.stringify(key)) + 1;
    if (Array.isArray(value)) {
      bytes += 2;
      for (let i = 0; i < value.length; i++) bytes += (i ? 1 : 0) + Buffer.byteLength(JSON.stringify(value[i]));
    } else bytes += Buffer.byteLength(JSON.stringify(value));
  }
  return bytes;
}

/** Inject an already-bounded pool. Its own connectionTimeoutMillis must also be
 * configured: our deadline releases late arrivals but cannot cancel pg's queue.
 * No schema setup, providers, persistent writes or report/assignment authority.
 * Coverage is captured-reader evidence, not proof derived from a request body.
 * Callers must obtain the input through the trusted cached source reader.
 * Geometry IDs describe normalized projected bytes; exact capture/version hashes
 * separately bind source order/provenance and the performed zero-snap policy.
 */
export function createNeighborhoodPostgisTopology(pool, { limits: requested } = {}) {
  if (typeof pool?.connect !== "function") invalid("pool");
  const limits = limitsOf(requested);
  return { async build(input) {
    const prepared = prepareNeighborhoodLinework(input);
    const output = { status: "incomplete", topology_validated: false, topology_revision: null,
      topology_version: POSTGIS_TOPOLOGY_VERSION, metric_srid: METRIC_SRID, display_srid: 4326,
      source_capture_sha256: prepared.capture_sha256, linework_content_sha256: prepared.linework_content_sha256,
      source_coverage: { query_coverage: prepared.capture.coverage, provider_coverage: "unknown", historical_coverage: "unknown" },
      engine_versions: null, performed_policy: null, cells: [], edges: [], nodes: [], source_features: prepared.features,
      source_aliases: prepared.aliases,
      diagnostics: {}, noding_admission: null, incomplete_reasons: [], source_limitations: prepared.limitations, travel_connectivity: "not_evaluated", limits };
    const finish = reasons => {
      output.incomplete_reasons = [...new Set(reasons.map(reason => typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason)
        ? reason : 'source_query_unavailable'))].sort(compare).slice(0, 32);
      if (reasons.length) {
        output.status = "incomplete";
        output.cells = []; output.edges = []; output.nodes = []; output.topology_revision = null; output.topology_validated = false;
        output.metadata_not_returned = true;
        output.source_metadata_counts = { features: output.source_features.length, aliases: output.source_aliases.length, limitations: output.source_limitations.length };
        output.source_features = []; output.source_aliases = []; output.source_limitations = [];
        const diagnostics = {};
        for (const key of DIAGNOSTICS) if (Number.isSafeInteger(output.diagnostics[key]) && output.diagnostics[key] >= 0) diagnostics[key] = output.diagnostics[key];
        if (Array.isArray(output.diagnostics.source_preparation)) {
          diagnostics.source_preparation_reason_count = output.diagnostics.source_preparation.length;
        }
        output.diagnostics = diagnostics;
        output.failure_control_budget_bytes = POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES;
        if (Buffer.byteLength(JSON.stringify(output)) > POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES) {
          output.diagnostics = {}; output.engine_versions = null; output.performed_policy = null; output.noding_admission = null;
          output.failure_metadata_reduced = true;
        }
        // Everything remaining is fixed-shape bounded scalar control metadata.
        if (Buffer.byteLength(JSON.stringify(output)) > POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES) invalid('failure_control_bytes');
      }
      else {
        output.status = "ready"; output.topology_validated = true;
        if (serializedOutputBytes(output) > limits.output_bytes) return finish(["topology_limit_exceeded"]);
      }
      return freeze(output);
    };
    if (prepared.status !== "ready_for_preprocessing") {
      output.diagnostics.source_preparation = prepared.incomplete_reasons;
      return finish(["source_preparation_incomplete"]);
    }
    if (prepared.policy.metric_srid !== METRIC_SRID || prepared.policy.snap_tolerance_meters !== 0) return finish(["unsupported_projection_policy"]);
    if (prepared.line_parts.length > limits.input_parts || prepared.counts.coordinates > limits.input_coordinates) return finish(["input_limit_exceeded"]);
    const [west, south, east, north] = prepared.query.envelope;
    if (!inProjectionWindow([west, south]) || !inProjectionWindow([east, north]) ||
        prepared.line_parts.some(part => part.geometry.coordinates.some(point => !inProjectionWindow(point)))) return finish(["unsupported_projection_extent"]);
    const primitiveCount = prepared.line_parts.reduce((count, part) => count + part.geometry.coordinates.length - 1, 0);
    if (primitiveCount > limits.primitive_segments) {
      output.noding_admission = { policy: 'projected-primitive-bbox-v1', primitive_segments: primitiveCount,
        candidate_pairs: null, candidate_pairs_complete: false, admitted: false };
      return finish(['pre_noding_limit_exceeded']);
    }
    const inputParts = prepared.line_parts.map(({ feature_id, source_part_index, geometry }) => ({ feature_id, source_part_index, geometry }));
    const partSegments = new Map(inputParts.map(row => [`${row.feature_id}:${row.source_part_index}`, row.geometry.coordinates.length - 1]));
    const payload = canonicalAssessmentJson(inputParts);
    let client, begun = false, releaseError;
    let failureReasons = [];
    const started = performance.now();
    const check = () => { if (performance.now() - started > limits.duration_ms) stop("duration_limit"); };
    const query = async (tag, text, values = []) => {
      check();
      const result = await client.query({ text: `/* neighborhood-topology:${tag} */ ${text}`, values, query_timeout: limits.statement_ms + 1000 });
      check(); return result.rows;
    };
    try {
      client = await connect(pool, limits.connect_ms);
      begun = true;
      await query("begin", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await query("settings", `SET LOCAL statement_timeout='${limits.statement_ms}ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'`);
      const versions = await query("versions", VERSION_SQL);
      if (versions.length !== 1) stop("unsupported_projection_policy");
      output.engine_versions = versionsOf(versions[0]);
      const admissionRows = await query('admission', admissionSql(limits), [payload]);
      if (admissionRows.length !== 1 || admissionRows[0].primitive_segments !== primitiveCount ||
          !Number.isSafeInteger(admissionRows[0].candidate_pairs) || admissionRows[0].candidate_pairs < 0 ||
          admissionRows[0].candidate_pairs > Math.min(limits.candidate_pairs + 1, primitiveCount * (primitiveCount - 1) / 2)) stop('invalid_topology_result');
      output.noding_admission = nodingAdmission(primitiveCount, prepared.counts.coordinates, admissionRows[0].candidate_pairs, limits);
      if (!output.noding_admission.admitted) stop('pre_noding_limit_exceeded');
      output.performed_policy = { version: POSTGIS_TOPOLOGY_VERSION, requested_policy_version: prepared.policy.version,
        metric_srid: METRIC_SRID, snap_tolerance_meters: 0,
        source_attribution: "exact_original_endpoint_and_pair_intersection_witness_chains_v1", source_fraction_basis: "source_segment",
        source_fraction_interpretation: "dominant_axis_signed_order_coordinate_v1",
        source_occurrence_coverage: "complete_consecutive_witness_chain_coverage_v1",
        source_witness_budgets: "point_incidences_2S_plus_4P_chains_S_plus_4P_v1",
        ambiguous_source_policy: "require_original_primitive_positive_length_overlap_v1",
        supported_projection_window: SUPPORTED_PROJECTION_WINDOW,
        noding_admission_policy: output.noding_admission.policy,
        minimum_cell_area_m2: MINIMUM_CELL_AREA_M2, geometry_repair: "none", travel_graph: "not_generated" };
      const records = await query("build", topologySql(limits, output.noding_admission), [payload]);
      if (records.length > 1 + limits.cells + limits.edges * 3) stop("topology_limit_exceeded");
      let seenDiagnostics = false, receivedBytes = 0, reportedBytes;
      for (const record of records) {
        check();
        if (!Number.isSafeInteger(record.row_bytes) || record.row_bytes <= 0 || record.row_bytes > limits.row_bytes ||
            !/^\d+$/.test(record.total_bytes) || BigInt(record.total_bytes) > BigInt(limits.output_bytes) || !record.payload) stop("topology_limit_exceeded");
        if (reportedBytes !== undefined && reportedBytes !== record.total_bytes) stop("invalid_topology_result");
        reportedBytes = record.total_bytes; receivedBytes += record.row_bytes;
        if (record.kind === "diagnostics") {
          if (seenDiagnostics) stop("invalid_topology_result");
          seenDiagnostics = true; output.diagnostics = record.payload; continue;
        }
        const row = record.payload, collection = record.kind === "cell" ? output.cells : record.kind === "edge" ? output.edges : record.kind === "node" ? output.nodes : null;
        if (!collection || typeof row.id !== "string" || row.id !== record.id || !row.id.startsWith(`${record.kind}:`) ||
            !hashPattern.test(row.id.slice(row.id.indexOf(":") + 1)) || row.metric_srid !== METRIC_SRID ||
            typeof row.geometry_ewkb !== "string" || !/^(?:[0-9a-f]{2})+$/.test(row.geometry_ewkb) || !row.geometry) stop("invalid_topology_result");
        collection.push(row);
      }
      if (!seenDiagnostics || BigInt(receivedBytes) !== BigInt(reportedBytes)) stop("invalid_topology_result");
      const d = output.diagnostics;
      if (Object.keys(d).length !== DIAGNOSTICS.length) stop("invalid_topology_result");
      for (const key of DIAGNOSTICS) if (!Number.isSafeInteger(d[key]) || d[key] < 0) stop("invalid_topology_result");
      const reasons = [];
      if (d.edge_count > limits.edges || d.cell_count > limits.cells || d.source_reference_count > limits.source_references || d.noded_coordinate_count > limits.edges * 4) reasons.push("topology_limit_exceeded");
      if (d.source_point_incidence_count > 2 * primitiveCount + 4 * output.noding_admission.candidate_pairs ||
          d.source_chain_count > output.noding_admission.split_pieces_upper_bound) reasons.push("topology_limit_exceeded");
      if (d.invalid_source_witness_count) reasons.push("unsupported_source_witness");
      if (d.ambiguous_source_order_count) reasons.push("ambiguous_source_order");
      if (!d.cell_count) reasons.push("no_closed_cells");
      if (d.invalid_source_count) reasons.push("invalid_source_geometry");
      if (d.invalid_cell_count || output.cells.some(row => row.geometry_validated !== true || !Number.isFinite(row.area_m2) || row.area_m2 <= 0)) reasons.push("invalid_cell_geometry");
      if (d.sliver_cell_count) reasons.push("sliver_cells");
      if (d.unattributed_edge_count) reasons.push("unattributed_source_edges");
      if (d.uncovered_source_segment_count) reasons.push("uncovered_source_segments");
      if (d.ambiguous_source_edge_count) reasons.push("ambiguous_source_attribution");
      if (d.invalid_incidence_count) reasons.push("invalid_edge_incidence");
      if (d.unsupported_boundary_count) reasons.push("unsupported_cell_boundary");
      if (d.overlapping_cell_count) reasons.push("overlapping_cells");
      if (!reasons.length) {
        if (d.source_chain_count !== d.source_reference_count) stop("invalid_topology_result");
        if (d.cell_count !== output.cells.length || d.edge_count !== output.edges.length || d.node_count !== output.nodes.length) stop("invalid_topology_result");
        const cellIds = new Set(output.cells.map(row => row.id)), edgeIds = new Set(output.edges.map(row => row.id)), nodeIds = new Set(output.nodes.map(row => row.id));
        if (cellIds.size !== output.cells.length || edgeIds.size !== output.edges.length || nodeIds.size !== output.nodes.length) stop("invalid_topology_result");
        const cellById = new Map(output.cells.map(row => [row.id, row])), degrees = new Map();
        for (const cell of output.cells) if (!Array.isArray(cell.boundary_edge_ids) || !cell.boundary_edge_ids.length ||
            new Set(cell.boundary_edge_ids).size !== cell.boundary_edge_ids.length || cell.boundary_edge_ids.some(id => !edgeIds.has(id)) ||
            !Number.isSafeInteger(cell.interior_ring_count) || cell.interior_ring_count < 0) stop("invalid_topology_result");
        let references = 0;
        for (const edge of output.edges) {
          if (!nodeIds.has(edge.from_node_id) || !nodeIds.has(edge.to_node_id) || edge.from_node_id === edge.to_node_id || edge.geometry_validated !== true ||
              !Number.isFinite(edge.length_meters) || edge.length_meters <= 0 || !Array.isArray(edge.cell_ids) || edge.cell_ids.length > 2 || edge.cell_ids.some(id => !cellIds.has(id)) ||
              !Array.isArray(edge.source_parts) || !edge.source_parts.length) stop("invalid_topology_result");
          if (new Set(edge.cell_ids).size !== edge.cell_ids.length || edge.cell_ids.some(id => !cellById.get(id).boundary_edge_ids.includes(edge.id))) stop("invalid_topology_result");
          degrees.set(edge.from_node_id, (degrees.get(edge.from_node_id) || 0) + 1);
          degrees.set(edge.to_node_id, (degrees.get(edge.to_node_id) || 0) + 1);
          const sourceOccurrences = new Set();
          for (const source of edge.source_parts) {
            references++;
            const count = partSegments.get(`${source.feature_id}:${source.source_part_index}`);
            const occurrence = `${source.feature_id}:${source.source_part_index}:${source.source_segment_index}`;
            if (!count || !Number.isSafeInteger(source.source_segment_index) || source.source_segment_index < 1 || source.source_segment_index > count ||
                source.source_fraction_basis !== "source_segment" || !Number.isFinite(source.start_fraction) || !Number.isFinite(source.end_fraction) ||
                source.start_fraction < 0 || source.start_fraction > 1 || source.end_fraction < 0 || source.end_fraction > 1 ||
                source.start_fraction === source.end_fraction || sourceOccurrences.has(occurrence)) stop("invalid_topology_result");
            sourceOccurrences.add(occurrence);
          }
        }
        if (references !== d.source_reference_count) stop("invalid_topology_result");
        const edgeById = new Map(output.edges.map(row => [row.id, row]));
        if (output.nodes.some(node => degrees.get(node.id) !== node.degree) ||
            output.cells.some(cell => cell.boundary_edge_ids.some(id => !edgeById.get(id).cell_ids.includes(cell.id)))) stop("invalid_topology_result");
      }
      await query("commit", "COMMIT"); begun = false;
      if (reasons.length) failureReasons = reasons;
      else {
        for (const rows of [output.cells, output.edges, output.nodes]) {
          rows.sort((a, b) => compare(a.id, b.id));
        }
        output.topology_revision = neighborhoodTopologyRevision(output);
        check();
      }
    } catch (error) {
      if (begun && client) {
        try { await client.query({ text: "ROLLBACK", query_timeout: limits.statement_ms + 1000 }); }
        catch { releaseError = new Error("neighborhood_topology_rollback_failed"); }
      }
      failureReasons = [INTERNAL_FAILURES.get(error) || "source_query_unavailable"];
    } finally {
      // Release each acquired client once. Cleanup cannot override a primary
      // failure, throw raw driver details, or leave a successful graph exposed
      // after the connection's return/destruction could not be confirmed.
      if (client && !releaseSafely(client, releaseError) && !failureReasons.length) {
        failureReasons = ["connection_release_failed"];
      }
    }
    return finish(failureReasons);
  } };
}
