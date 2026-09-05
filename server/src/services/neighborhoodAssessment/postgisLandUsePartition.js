import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

// This kernel computes supplied geometry. Neither caller-provided classifications
// nor these content digests authenticate evidence or authorize report use.
export const LAND_USE_PARTITION_VERSION = "postgis-land-use-partition-v1";
export const LAND_USE_KNOWN_CATEGORIES = Object.freeze([
  "one_unit", "two_to_four_unit", "multifamily", "commercial", "other_vacant",
  "park_open_space", "water", "transportation", "civic_institutional", "mixed_use", "other_known",
]);
const UNKNOWN = ["unknown_uncovered", "unknown_classification", "unknown_conflict"];
const CATEGORIES = [...LAND_USE_KNOWN_CATEGORIES, ...UNKNOWN];
export const LAND_USE_PARTITION_LIMITS = Object.freeze({
  input_features: 512, source_snapshots: 16, source_records: 4096, input_coordinates: 16384,
  geometry_coordinates: 16384, input_bytes: 4_000_000, output_bytes: 4_000_000,
  intermediate_coordinates: 131072, intermediate_components: 8192,
  class_pairs: 55, reference_candidates: 8192, source_references: 8192,
  statement_ms: 5000, duration_ms: 20000, connect_ms: 3000, cleanup_ms: 1000,
});
export const LAND_USE_PARTITION_HARD_LIMITS = Object.freeze({
  ...LAND_USE_PARTITION_LIMITS, input_features: 2048, source_snapshots: 32,
  source_records: 8192, input_coordinates: 65536, input_bytes: 8_000_000,
  intermediate_coordinates: 524288, intermediate_components: 32768,
  reference_candidates: 32768, source_references: 32768,
  statement_ms: 15000, duration_ms: 60000, connect_ms: 5000, cleanup_ms: 3000,
});
const WINDOW = Object.freeze([-98.5, 31, -95.5, 34.5]);
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_KEYS = ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
const internalErrors = new WeakMap();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function invalid(field) { throw new TypeError(`invalid_neighborhood_land_use:${field}`); }
function failure(code) { const error = new Error(code); internalErrors.set(error, code); return error; }
function stop(code) { throw failure(code); }
function reason(error) { return error && internalErrors.has(error) ? internalErrors.get(error) : "source_query_unavailable"; }
function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
}
function exact(value, keys, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}
function string(value, field, max = 200) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}
function digest(value, field) { if (typeof value !== "string" || !SHA.test(value)) invalid(field); return value; }
function date(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(field);
  return value;
}
function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field);
  return value;
}
function list(value, maximum, field) {
  if (!Array.isArray(value)) invalid(field);
  if (value.length > maximum) stop("input_limit_exceeded");
  return value;
}

// Inspect before serialization: declared array counts, depth, accessors, cycles,
// string bytes and aggregate work are bounded even for malicious pure JS inputs.
function canonical(value, maximum = LAND_USE_PARTITION_HARD_LIMITS.input_bytes) {
  let nodes = 0, rawBytes = 0;
  const ancestors = new WeakSet();
  const visit = (item, depth) => {
    if (++nodes > 250000 || depth > 28) stop("input_limit_exceeded");
    if (typeof item === "string") {
      if (item.length > maximum) stop("input_limit_exceeded");
      rawBytes += Buffer.byteLength(item); if (rawBytes > maximum) stop("input_limit_exceeded");
      return JSON.stringify(item);
    }
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { if (!Number.isFinite(item)) invalid("json_number"); return JSON.stringify(item); }
    if (!item || typeof item !== "object" || ancestors.has(item)) invalid("json_value");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) invalid("json_object");
    if (Object.getOwnPropertySymbols(item).length) invalid("json_symbol");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 250000 || Object.keys(descriptors).length !== item.length + 1) invalid("json_array");
      result = `[${Array.from({ length: item.length }, (_, i) => {
        if (!descriptors[i] || !Object.hasOwn(descriptors[i], "value")) invalid("json_accessor");
        return visit(descriptors[i].value, depth + 1);
      }).join(",")}]`;
    } else {
      const keys = Object.keys(descriptors).sort(compare);
      if (keys.length > 250000) stop("input_limit_exceeded");
      result = `{${keys.map(key => {
        if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) invalid("json_accessor");
        rawBytes += Buffer.byteLength(key); if (rawBytes > maximum) stop("input_limit_exceeded");
        return `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`;
      }).join(",")}}`;
    }
    ancestors.delete(item);
    if (Buffer.byteLength(result) > maximum) stop("input_limit_exceeded");
    return result;
  };
  return visit(value, 0);
}
export function landUseEvidenceDigest(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function landUseGeometryDigest(hex) {
  if (typeof hex !== "string" || !hex.length || hex.length > 3_000_000 || !/^(?:[a-f0-9]{2})+$/.test(hex)) invalid("geometry_hex");
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}
function limitsOf(options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) invalid("limits");
  const result = { ...LAND_USE_PARTITION_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < (key === "output_bytes" ? 4096 : 1) || value > LAND_USE_PARTITION_HARD_LIMITS[key]) invalid("limits");
    result[key] = value;
  }
  return result;
}
function scopeOf(value) {
  exact(value, SCOPE_KEYS, "scope");
  return Object.fromEntries(SCOPE_KEYS.map(key => {
    const item = string(value[key], "scope", key === "account_id" ? 100 : 36);
    if (key !== "account_id" && !UUID.test(item)) invalid("scope");
    return [key, key === "account_id" ? item : item.toLowerCase()];
  }));
}
function temporal(value) {
  const validity = exact(value.fact_validity, ["valid_from", "valid_to"], "fact_validity");
  const from = validity.valid_from === null ? null : date(validity.valid_from, "fact_validity");
  const to = validity.valid_to === null ? null : date(validity.valid_to, "fact_validity");
  if (from && to && from > to) invalid("fact_validity");
  const available = exact(value.historical_availability, ["status", "available_at"], "historical_availability");
  if (!["supported", "unknown"].includes(available.status) ||
      (available.status === "unknown" && available.available_at !== null) ||
      (available.status === "supported" && available.available_at === null)) invalid("historical_availability");
  return { fact_validity: { valid_from: from, valid_to: to }, historical_availability: {
    status: available.status, available_at: available.available_at === null ? null : timestamp(available.available_at, "historical_availability"),
  } };
}
function support(value, effectiveDate, cutoff) {
  const { valid_from: from, valid_to: to } = value.fact_validity, availability = value.historical_availability;
  if ((from && from > effectiveDate) || (to && to < effectiveDate) || (availability.available_at && availability.available_at > cutoff)) return "unsupported";
  return from && availability.status === "supported" ? "supported" : "unknown";
}
function refsOf(value, maximum) {
  const refs = list(value, maximum, "source_refs").map(ref => {
    exact(ref, ["source_ref", "source_record_id"], "source_ref");
    return { source_ref: string(ref.source_ref, "source_ref"), source_record_id: string(ref.source_record_id, "source_record_id") };
  }).sort((a, b) => compare(a.source_ref, b.source_ref) || compare(a.source_record_id, b.source_record_id));
  const keys = refs.map(ref => canonical(ref));
  if (new Set(keys).size !== keys.length) invalid("duplicate_source_ref");
  return refs;
}
function geometryOf(value, limits, counter) {
  exact(value, ["srid", "ewkb", "content_sha256"], "geometry");
  if (value.srid !== 4326 || landUseGeometryDigest(value.ewkb) !== digest(value.content_sha256, "geometry_digest")) invalid("geometry_digest_or_srid");
  const bytes = Buffer.from(value.ewkb, "hex"); let offset = 0, coordinates = 0;
  const need = size => { if (offset + size > bytes.length) invalid("ewkb_length"); };
  const uint = little => { need(4); const number = little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset); offset += 4; return number; };
  const number = little => { need(8); const number = little ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset); offset += 8; return number; };
  const polygon = (root, depth) => {
    if (depth > 1) invalid("ewkb_type");
    need(1); const order = bytes[offset++]; if (order !== 0 && order !== 1) invalid("ewkb_byte_order");
    const type = uint(order === 1), base = type & 0x1fffffff;
    if ((type & 0xc0000000) !== 0 || ![3, 6].includes(base) || (!root && base !== 3)) invalid("ewkb_type");
    const hasSrid = (type & 0x20000000) !== 0;
    if ((root && !hasSrid) || (hasSrid && uint(order === 1) !== 4326)) invalid("ewkb_srid");
    const count = uint(order === 1);
    if (count < 1) invalid("ewkb_empty");
    if (count > limits.geometry_coordinates || count > Math.floor((bytes.length - offset) / (base === 6 ? 9 : 4))) stop("input_limit_exceeded");
    if (base === 6) { for (let i = 0; i < count; i++) polygon(false, depth + 1); return; }
    for (let ring = 0; ring < count; ring++) {
      const points = uint(order === 1);
      if (points < 4) invalid("ewkb_ring");
      if (points > Math.floor((bytes.length - offset) / 16)) invalid("ewkb_length");
      coordinates += points;
      if (coordinates > limits.geometry_coordinates || counter.count + coordinates > limits.input_coordinates) stop("input_limit_exceeded");
      let first, last;
      for (let i = 0; i < points; i++) {
        const x = number(order === 1), y = number(order === 1);
        if (!Number.isFinite(x) || !Number.isFinite(y)) invalid("ewkb_coordinate");
        if (x < WINDOW[0] || x > WINDOW[2] || y < WINDOW[1] || y > WINDOW[3]) stop("unsupported_projection_extent");
        if (i === 0) first = [x, y]; last = [x, y];
      }
      if (first[0] !== last[0] || first[1] !== last[1]) invalid("ewkb_ring_closure");
    }
  };
  polygon(true, 0); if (offset !== bytes.length) invalid("ewkb_trailing_bytes");
  counter.count += coordinates;
  return { srid: 4326, ewkb: value.ewkb, content_sha256: value.content_sha256 };
}

function normalize(input, limits) {
  const detached = JSON.parse(canonical(input, limits.input_bytes));
  exact(detached, ["partition_version", "scope", "effective_date", "knowledge_cutoff", "boundary", "source_snapshots", "features", "policy"], "input");
  if (detached.partition_version !== LAND_USE_PARTITION_VERSION) invalid("partition_version");
  const scope = scopeOf(detached.scope), effectiveDate = date(detached.effective_date, "effective_date");
  const cutoff = timestamp(detached.knowledge_cutoff, "knowledge_cutoff"), counter = { count: 0 };
  const policy = exact(detached.policy, ["version", "metric_srid", "overlap", "numerical_tolerance_version"], "policy");
  string(policy.version, "policy_version");
  if (policy.metric_srid !== 26914 || policy.overlap !== "unresolved_conflict" || policy.numerical_tolerance_version !== "area-conservation-v1") invalid("policy");
  let recordCount = 0;
  const snapshots = list(detached.source_snapshots, limits.source_snapshots, "source_snapshots").map(source => {
    exact(source, ["id", "revision", "scope", "captured_at", "state", "records", "content_sha256"], "source_snapshot");
    const sourceScope = scopeOf(source.scope);
    if (SCOPE_KEYS.some(key => sourceScope[key] !== scope[key])) invalid("source_scope");
    if (!["complete", "incomplete", "absent"].includes(source.state)) invalid("source_state");
    const records = list(source.records, limits.source_records, "source_records").map(record => {
      exact(record, ["source_record_id", "record_sha256", "geometry_sha256", "context_sha256"], "source_record");
      if (++recordCount > limits.source_records) stop("input_limit_exceeded");
      if ((record.geometry_sha256 === null) !== (record.context_sha256 === null)) invalid("source_record_projection");
      return { source_record_id: string(record.source_record_id, "source_record_id"), record_sha256: digest(record.record_sha256, "record_digest"),
        geometry_sha256: record.geometry_sha256 === null ? null : digest(record.geometry_sha256, "record_geometry_digest"),
        context_sha256: record.context_sha256 === null ? null : digest(record.context_sha256, "record_context_digest") };
    }).sort((a, b) => compare(a.source_record_id, b.source_record_id));
    if (new Set(records.map(record => record.source_record_id)).size !== records.length) invalid("duplicate_source_record");
    if (source.state === "absent" && (source.revision !== null || records.length)) invalid("absent_source");
    const normalized = { id: string(source.id, "source_id"), revision: source.state === "absent" ? null : string(source.revision, "source_revision", 500),
      scope: sourceScope, captured_at: timestamp(source.captured_at, "source_captured_at"), state: source.state, records };
    if (landUseEvidenceDigest(normalized) !== digest(source.content_sha256, "source_digest")) invalid("source_digest");
    return { ...normalized, content_sha256: source.content_sha256 };
  }).sort((a, b) => compare(a.id, b.id));
  if (!snapshots.length || new Set(snapshots.map(source => source.id)).size !== snapshots.length) invalid("source_snapshots");
  const sourceMap = new Map(snapshots.map(source => [source.id, new Map(source.records.map(record => [record.source_record_id, record]))]));
  const resolve = ref => {
    const row = sourceMap.get(ref.source_ref)?.get(ref.source_record_id);
    if (!row) invalid("source_reference_closure");
    return row;
  };
  exact(detached.boundary, ["role", "revision", "geometry", "source_refs", "selection_evidence_sha256", "fact_validity", "historical_availability"], "boundary");
  if (detached.boundary.role !== "geographic_neighborhood") invalid("boundary_role");
  const boundary = { role: "geographic_neighborhood", revision: string(detached.boundary.revision, "boundary_revision", 500),
    geometry: geometryOf(detached.boundary.geometry, limits, counter), source_refs: refsOf(detached.boundary.source_refs, limits.source_records),
    selection_evidence_sha256: digest(detached.boundary.selection_evidence_sha256, "selection_digest"), ...temporal(detached.boundary) };
  if (!boundary.source_refs.length) invalid("boundary_sources"); boundary.source_refs.forEach(resolve);
  const features = list(detached.features, limits.input_features, "features").map(feature => {
    exact(feature, ["id", "source_ref", "source_record_id", "geometry", "semantics", "classification", "fact_validity", "historical_availability"], "feature");
    if (!["observed_use", "zoning"].includes(feature.semantics)) invalid("semantics");
    const classification = exact(feature.classification, ["status", "category", "policy_version", "evidence_refs"], "classification");
    if (!["supported", "unknown"].includes(classification.status) ||
        (classification.status === "supported" ? !LAND_USE_KNOWN_CATEGORIES.includes(classification.category) : classification.category !== null)) invalid("classification");
    const normalized = { id: string(feature.id, "feature_id"), source_ref: string(feature.source_ref, "feature_source"),
      source_record_id: string(feature.source_record_id, "feature_record"), geometry: geometryOf(feature.geometry, limits, counter), semantics: feature.semantics,
      classification: { status: classification.status, category: classification.category, policy_version: string(classification.policy_version, "classification_policy"),
        evidence_refs: refsOf(classification.evidence_refs, limits.source_records) }, ...temporal(feature) };
    if (classification.status === "supported" && !normalized.classification.evidence_refs.length) invalid("classification_evidence");
    normalized.classification.evidence_refs.forEach(resolve);
    const record = resolve(normalized);
    const context = { semantics: normalized.semantics, classification: normalized.classification,
      fact_validity: normalized.fact_validity, historical_availability: normalized.historical_availability };
    if (record.geometry_sha256 !== normalized.geometry.content_sha256 || record.context_sha256 !== landUseEvidenceDigest(context)) invalid("feature_record_projection");
    return normalized;
  }).sort((a, b) => compare(a.id, b.id));
  if (new Set(features.map(feature => feature.id)).size !== features.length) invalid("duplicate_feature");
  return frozen({ partition_version: LAND_USE_PARTITION_VERSION, scope, effective_date: effectiveDate, knowledge_cutoff: cutoff,
    boundary, source_snapshots: snapshots, features, policy: { ...policy } });
}

const VERSION_SQL = `SELECT postgis_lib_version() AS postgis_version,postgis_geos_version() AS geos_version,
  postgis_proj_version() AS proj_version,s.auth_name,s.auth_srid,s.proj4text,s.srtext
  FROM spatial_ref_sys s WHERE s.srid=26914`;
const GEOMETRY_CTES = `boundary_input AS MATERIALIZED (SELECT ST_GeomFromEWKB(decode($1::text,'hex')) AS geom),
  feature_input AS MATERIALIZED (SELECT f.id,f.category,f.semantics,ST_GeomFromEWKB(decode(f.ewkb,'hex')) AS geom
    FROM jsonb_to_recordset($2::jsonb) AS f(id text,category text,semantics text,ewkb text))`;
const VALIDATE_SQL = `WITH ${GEOMETRY_CTES} SELECT
  (SELECT ST_SRID(geom)=4326 AND GeometryType(geom) IN ('POLYGON','MULTIPOLYGON') AND ST_IsValid(geom)
    AND NOT ST_IsEmpty(geom) AND ST_IsValid(ST_Transform(geom,26914)) AND ST_Area(ST_Transform(geom,26914))>0 FROM boundary_input) AS boundary_valid,
  (SELECT COALESCE(bool_and(ST_SRID(geom)=4326 AND GeometryType(geom) IN ('POLYGON','MULTIPOLYGON')
    AND ST_IsValid(geom) AND NOT ST_IsEmpty(geom) AND ST_IsValid(ST_Transform(geom,26914)) AND ST_Area(ST_Transform(geom,26914))>0),true) FROM feature_input) AS features_valid`;

function partitionSql(limits) {
  // Category pairs are fixed and capped before pair intersections. Geometry
  // complexity is checked between overlay stages; DB/worker deadlines still
  // bound individual native GEOS operations, not an invented operation count.
  const empty = "ST_GeomFromText('MULTIPOLYGON EMPTY',26914)";
  const categories = LAND_USE_KNOWN_CATEGORIES.map(category => `('${category}')`).join(",");
  const cap = alias => `${alias}.coordinates<=${limits.intermediate_coordinates} AND ${alias}.components<=${limits.intermediate_components}`;
  return `WITH ${GEOMETRY_CTES}, boundary AS MATERIALIZED (SELECT ST_Transform(geom,26914) AS geom FROM boundary_input),
  features AS MATERIALIZED (SELECT id,category,semantics,ST_Transform(geom,26914) AS geom FROM feature_input),
  raw_clips AS MATERIALIZED (SELECT f.id,f.category,ST_CollectionExtract(ST_Intersection(f.geom,b.geom),3) AS geom
    FROM features f CROSS JOIN boundary b WHERE f.semantics='observed_use' AND f.geom && b.geom),
  clip_stats AS (SELECT COALESCE(sum(ST_NPoints(geom)),0)::integer AS coordinates,
    COALESCE(sum(ST_NumGeometries(geom)),0)::integer AS components FROM raw_clips),
  clips AS MATERIALIZED (SELECT r.* FROM raw_clips r CROSS JOIN clip_stats s WHERE ${cap("s")} AND ST_Area(r.geom)>0),
  raw_known AS MATERIALIZED (SELECT category,ST_UnaryUnion(ST_Collect(geom ORDER BY id COLLATE "C")) AS geom
    FROM clips WHERE category IS NOT NULL GROUP BY category),
  known_stats AS (SELECT COALESCE(sum(ST_NPoints(geom)),0)::integer AS coordinates,
    COALESCE(sum(ST_NumGeometries(geom)),0)::integer AS components FROM raw_known),
  known AS MATERIALIZED (SELECT k.* FROM raw_known k CROSS JOIN known_stats s WHERE ${cap("s")}),
  pair_candidates AS MATERIALIZED (SELECT a.category AS a,b.category AS b FROM known a JOIN known b
    ON a.category COLLATE "C"<b.category COLLATE "C" AND a.geom && b.geom LIMIT ${limits.class_pairs + 1}),
  pair_count AS (SELECT count(*)::integer AS count FROM pair_candidates),
  pair_intersections AS MATERIALIZED (SELECT ST_CollectionExtract(ST_Intersection(a.geom,b.geom),3) AS geom
    FROM pair_candidates p JOIN known a ON a.category=p.a JOIN known b ON b.category=p.b
    WHERE (SELECT count FROM pair_count)<=${limits.class_pairs}),
  pair_stats AS (SELECT COALESCE(sum(ST_NPoints(geom)),0)::integer AS coordinates,
    COALESCE(sum(ST_NumGeometries(geom)),0)::integer AS components FROM pair_intersections),
  unions AS MATERIALIZED (SELECT
    COALESCE((SELECT ST_UnaryUnion(ST_Collect(geom ORDER BY category COLLATE "C")) FROM known),${empty}) AS known_geom,
    COALESCE((SELECT ST_UnaryUnion(ST_Collect(p.geom ORDER BY encode(ST_AsEWKB(ST_Normalize(p.geom),'NDR'),'hex') COLLATE "C"))
      FROM pair_intersections p CROSS JOIN pair_stats s WHERE ${cap("s")} AND ST_Area(p.geom)>0),${empty}) AS conflict_geom,
    COALESCE((SELECT ST_UnaryUnion(ST_Collect(geom ORDER BY id COLLATE "C")) FROM clips),${empty}) AS observed_geom,
    COALESCE((SELECT ST_UnaryUnion(ST_Collect(geom ORDER BY id COLLATE "C")) FROM clips WHERE category IS NULL),${empty}) AS unknown_geom),
  union_stats AS (SELECT (ST_NPoints(known_geom)+ST_NPoints(conflict_geom)+ST_NPoints(observed_geom)+ST_NPoints(unknown_geom))::integer AS coordinates,
    (ST_NumGeometries(known_geom)+ST_NumGeometries(conflict_geom)+ST_NumGeometries(observed_geom)+ST_NumGeometries(unknown_geom))::integer AS components FROM unions),
  bounded_unions AS MATERIALIZED (SELECT u.* FROM unions u CROSS JOIN union_stats s WHERE ${cap("s")}),
  raw_buckets AS MATERIALIZED (
    SELECT c.category,ST_CollectionExtract(ST_Difference(COALESCE(k.geom,${empty}),u.conflict_geom),3) AS geom
      FROM (VALUES ${categories}) c(category) LEFT JOIN known k ON k.category=c.category CROSS JOIN bounded_unions u
    UNION ALL SELECT 'unknown_conflict',conflict_geom FROM bounded_unions
    UNION ALL SELECT 'unknown_classification',ST_CollectionExtract(ST_Difference(unknown_geom,known_geom),3) FROM bounded_unions
    UNION ALL SELECT 'unknown_uncovered',ST_CollectionExtract(ST_Difference(b.geom,u.observed_geom),3) FROM boundary b CROSS JOIN bounded_unions u),
  bucket_stats AS (SELECT COALESCE(sum(ST_NPoints(geom)),0)::integer AS coordinates,
    COALESCE(sum(ST_NumGeometries(geom)),0)::integer AS components FROM raw_buckets),
  buckets AS MATERIALIZED (SELECT r.* FROM raw_buckets r CROSS JOIN bucket_stats s WHERE ${cap("s")}),
  ref_candidates AS MATERIALIZED (SELECT b.category,c.id FROM buckets b JOIN clips c ON b.geom && c.geom
    WHERE (b.category=c.category OR (b.category='unknown_conflict' AND c.category IS NOT NULL)
      OR (b.category='unknown_classification' AND c.category IS NULL)) LIMIT ${limits.reference_candidates + 1}),
  ref_candidate_count AS (SELECT count(*)::integer AS count FROM ref_candidates),
  refs AS MATERIALIZED (SELECT r.category,r.id FROM ref_candidates r JOIN buckets b ON b.category=r.category JOIN clips c ON c.id=r.id
    WHERE (SELECT count FROM ref_candidate_count)<=${limits.reference_candidates}
      AND ST_Area(ST_Intersection(b.geom,c.geom))>0 LIMIT ${limits.source_references + 1}),
  bucket_values AS (SELECT b.category,ST_Area(b.geom) AS area_m2,
    COALESCE((SELECT jsonb_agg(r.id ORDER BY r.id COLLATE "C") FROM refs r WHERE r.category=b.category),'[]'::jsonb) AS source_feature_ids FROM buckets b),
  partition_union AS (SELECT COALESCE(ST_UnaryUnion(ST_Collect(geom ORDER BY category COLLATE "C")),${empty}) AS geom FROM buckets),
  size_diagnostics AS (SELECT GREATEST(c.coordinates,k.coordinates,p.coordinates,u.coordinates,b.coordinates)::integer AS intermediate_coordinate_count,
    GREATEST(c.components,k.components,p.components,u.components,b.components)::integer AS intermediate_component_count
    FROM clip_stats c CROSS JOIN known_stats k CROSS JOIN pair_stats p CROSS JOIN union_stats u CROSS JOIN bucket_stats b),
  payload AS (SELECT jsonb_build_object('boundary_area_m2',ST_Area(b.geom),
    'buckets',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.category COLLATE "C") FROM bucket_values v),'[]'::jsonb),
    'diagnostics',jsonb_build_object('observed_area_m2',ST_Area(u.observed_geom),
      'raw_observed_feature_area_sum_m2',COALESCE((SELECT sum(ST_Area(geom)) FROM clips),0),
      'raw_known_feature_area_sum_m2',COALESCE((SELECT sum(ST_Area(geom)) FROM clips WHERE category IS NOT NULL),0),
      'dissolved_known_class_area_sum_m2',COALESCE((SELECT sum(ST_Area(geom)) FROM known),0),
      'classified_area_m2',COALESCE((SELECT sum(area_m2) FROM bucket_values WHERE category NOT IN ('unknown_uncovered','unknown_classification','unknown_conflict')),0),
      'conflict_area_m2',ST_Area(u.conflict_geom),
      'unclassified_area_m2',COALESCE((SELECT area_m2 FROM bucket_values WHERE category='unknown_classification'),0),
      'uncovered_area_m2',COALESCE((SELECT area_m2 FROM bucket_values WHERE category='unknown_uncovered'),0),
      'partition_sum_m2',COALESCE((SELECT sum(area_m2) FROM bucket_values),0),'partition_union_m2',ST_Area(p.geom),
      'overlap_area_m2',GREATEST(0,COALESCE((SELECT sum(area_m2) FROM bucket_values),0)-ST_Area(p.geom)),
      'symmetric_difference_area_m2',ST_Area(ST_SymDifference(b.geom,p.geom)),
      'intermediate_coordinate_count',s.intermediate_coordinate_count,'intermediate_component_count',s.intermediate_component_count,
      'class_pair_count',(SELECT count FROM pair_count),'reference_candidate_count',(SELECT count FROM ref_candidate_count),
      'source_reference_count',(SELECT count(*)::integer FROM refs),
      'observed_feature_ids',COALESCE((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM clips),'[]'::jsonb))) AS value
    FROM boundary b CROSS JOIN unions u CROSS JOIN partition_union p CROSS JOIN size_diagnostics s),
  sized AS (SELECT value,octet_length(value::text)::integer AS payload_bytes FROM payload)
  SELECT CASE WHEN payload_bytes<=${limits.output_bytes} THEN value ELSE NULL END AS payload,payload_bytes FROM sized`;
}

function versionsOf(row) {
  exact(row, ["postgis_version", "geos_version", "proj_version", "auth_name", "auth_srid", "proj4text", "srtext"], "engine_metadata");
  if (row.auth_name !== "EPSG" || row.auth_srid !== 26914 || typeof row.proj4text !== "string" || row.proj4text.length > 4000 ||
      !/(?:^|\s)\+proj=utm(?:\s|$)/.test(row.proj4text) || !/(?:^|\s)\+zone=14(?:\s|$)/.test(row.proj4text) ||
      !/(?:^|\s)\+datum=NAD83(?:\s|$)/.test(row.proj4text) || !/(?:^|\s)\+units=m(?:\s|$)/.test(row.proj4text) ||
      typeof row.srtext !== "string" || row.srtext.length > 16000 || !/UNIT\["(?:metre|meter)",1(?:\]|,)/i.test(row.srtext)) stop("unsupported_projection_policy");
  for (const value of [row.postgis_version, row.geos_version, row.proj_version]) {
    if (typeof value !== "string" || !value.trim() || value.length > 256) stop("engine_version_unavailable");
  }
  return { postgis: row.postgis_version, geos: row.geos_version, proj: row.proj_version,
    spatial_reference_sha256: landUseEvidenceDigest({ proj4text: row.proj4text, srtext: row.srtext }) };
}
const AREA_DIAGNOSTICS = ["observed_area_m2", "classified_area_m2", "conflict_area_m2", "unclassified_area_m2", "uncovered_area_m2",
  "partition_sum_m2", "partition_union_m2", "overlap_area_m2", "symmetric_difference_area_m2",
  "raw_observed_feature_area_sum_m2", "raw_known_feature_area_sum_m2", "dissolved_known_class_area_sum_m2"];
const COUNT_DIAGNOSTICS = ["intermediate_coordinate_count", "intermediate_component_count", "class_pair_count", "reference_candidate_count", "source_reference_count"];
function partitionOf(record, input, limits) {
  if (!record || !Number.isSafeInteger(record.payload_bytes) || record.payload_bytes < 1 || record.payload_bytes > limits.output_bytes || !record.payload) stop("output_limit_exceeded");
  const payload = JSON.parse(canonical(record.payload, limits.output_bytes));
  exact(payload, ["boundary_area_m2", "buckets", "diagnostics"], "partition_result");
  const d = exact(payload.diagnostics, [...AREA_DIAGNOSTICS, ...COUNT_DIAGNOSTICS, "observed_feature_ids"], "partition_diagnostics");
  for (const key of AREA_DIAGNOSTICS) if (!Number.isFinite(d[key]) || d[key] < 0) stop("invalid_partition_result");
  for (const key of COUNT_DIAGNOSTICS) if (!Number.isSafeInteger(d[key]) || d[key] < 0) stop("invalid_partition_result");
  if (d.intermediate_coordinate_count > limits.intermediate_coordinates || d.intermediate_component_count > limits.intermediate_components ||
      d.class_pair_count > limits.class_pairs || d.reference_candidate_count > limits.reference_candidates || d.source_reference_count > limits.source_references) stop("partition_limit_exceeded");
  const area = payload.boundary_area_m2;
  if (!Number.isFinite(area) || area <= 0) stop("invalid_boundary_area");
  if (!Array.isArray(payload.buckets) || payload.buckets.length !== CATEGORIES.length) stop("invalid_partition_result");
  const features = new Map(input.features.map(feature => [feature.id, feature]));
  const eligible = feature => feature?.semantics === "observed_use" && feature.classification.status === "supported" &&
    support(feature, input.effective_date, input.knowledge_cutoff) === "supported" ? feature.classification.category : null;
  if (!Array.isArray(d.observed_feature_ids) || d.observed_feature_ids.length > input.features.length ||
      new Set(d.observed_feature_ids).size !== d.observed_feature_ids.length ||
      d.observed_feature_ids.some(id => features.get(id)?.semantics !== "observed_use")) stop("invalid_partition_result");
  const observed = new Set(d.observed_feature_ids), buckets = [], categories = new Set(); let references = 0;
  for (const row of payload.buckets) {
    exact(row, ["category", "area_m2", "source_feature_ids"], "partition_bucket");
    if (!CATEGORIES.includes(row.category) || categories.has(row.category) || !Number.isFinite(row.area_m2) || row.area_m2 < 0 ||
        !Array.isArray(row.source_feature_ids) || row.source_feature_ids.length > input.features.length ||
        new Set(row.source_feature_ids).size !== row.source_feature_ids.length) stop("invalid_partition_result");
    categories.add(row.category); references += row.source_feature_ids.length;
    if (references > limits.source_references || (row.area_m2 === 0 && row.source_feature_ids.length) ||
        (row.area_m2 > 0 && row.category !== "unknown_uncovered" && !row.source_feature_ids.length)) stop("invalid_partition_result");
    for (const id of row.source_feature_ids) {
      const feature = features.get(id), category = eligible(feature);
      if (!observed.has(id) || row.category === "unknown_uncovered" ||
          (row.category === "unknown_conflict" ? category === null : row.category === "unknown_classification" ? category !== null : category !== row.category)) stop("invalid_partition_result");
    }
    buckets.push({ category: row.category, area_m2: row.area_m2, percent_of_boundary: row.area_m2 / area * 100,
      source_feature_ids: [...row.source_feature_ids].sort(compare) });
  }
  if (references !== d.source_reference_count) stop("invalid_partition_result");
  buckets.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  const byCategory = new Map(buckets.map(bucket => [bucket.category, bucket.area_m2]));
  const tolerance = Math.max(1e-6, area * 1e-9), close = (a, b) => Math.abs(a - b) <= tolerance;
  const sum = buckets.reduce((total, bucket) => total + bucket.area_m2, 0);
  const classified = LAND_USE_KNOWN_CATEGORIES.reduce((total, category) => total + byCategory.get(category), 0);
  if (!close(sum, area) || !close(d.partition_sum_m2, sum) || !close(d.partition_union_m2, area) ||
      d.overlap_area_m2 > tolerance || d.symmetric_difference_area_m2 > tolerance ||
      !close(d.classified_area_m2, classified) || !close(d.conflict_area_m2, byCategory.get("unknown_conflict")) ||
      !close(d.unclassified_area_m2, byCategory.get("unknown_classification")) || !close(d.uncovered_area_m2, byCategory.get("unknown_uncovered")) ||
      !close(d.observed_area_m2, area - byCategory.get("unknown_uncovered")) ||
      d.raw_observed_feature_area_sum_m2 + tolerance < d.observed_area_m2 ||
      d.raw_known_feature_area_sum_m2 > d.raw_observed_feature_area_sum_m2 + tolerance ||
      d.dissolved_known_class_area_sum_m2 > d.raw_known_feature_area_sum_m2 + tolerance ||
      classified + d.conflict_area_m2 > d.dissolved_known_class_area_sum_m2 + tolerance ||
      buckets.some(bucket => bucket.area_m2 > area + tolerance)) stop("area_conservation_failed");
  d.observed_feature_ids.sort(compare);
  // Preserve the raw difference; an insignificant negative rounding residual is
  // visible rather than changed into an invented positive/zero measured area.
  d.same_class_overlap_excess_m2 = d.raw_known_feature_area_sum_m2 - d.dissolved_known_class_area_sum_m2;
  d.input_feature_count = input.features.length;
  d.input_source_record_count = input.source_snapshots.reduce((sum, source) => sum + source.records.length, 0);
  d.observed_feature_count = d.observed_feature_ids.length;
  d.ignored_zoning_feature_count = input.features.filter(feature => feature.semantics === "zoning").length;
  const supports = [support(input.boundary, input.effective_date, input.knowledge_cutoff),
    ...d.observed_feature_ids.map(id => support(features.get(id), input.effective_date, input.knowledge_cutoff))];
  return { boundary_area_m2: area, buckets, diagnostics: d, tolerance,
    effective_date_support: supports.includes("unsupported") ? "unsupported" : supports.includes("unknown") ? "unknown" : "supported",
    coverage: { observed_percent: d.observed_area_m2 / area * 100, classified_percent: classified / area * 100,
      conflict_percent: d.conflict_area_m2 / area * 100, unknown_classification_percent: d.unclassified_area_m2 / area * 100,
      unknown_uncovered_percent: d.uncovered_area_m2 / area * 100,
      unknown_total_percent: (d.conflict_area_m2 + d.unclassified_area_m2 + d.uncovered_area_m2) / area * 100 } };
}

async function bounded(promise, milliseconds, code) {
  let timer;
  try { return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function release(client, error, milliseconds) {
  if (!client) return;
  await bounded(Promise.resolve().then(() => client.release(error)), milliseconds, "cleanup_failed");
}
async function connect(pool, milliseconds, cleanupMilliseconds) {
  let expired = false;
  const pending = Promise.resolve().then(() => pool.connect()).then(async client => {
    if (!client || typeof client.release !== "function") stop("source_query_unavailable");
    if (typeof client.query !== "function") {
      try { await release(client, new Error("neighborhood_land_use_invalid_client"), cleanupMilliseconds); } catch { /* contained invalid client cleanup */ }
      stop("source_query_unavailable");
    }
    if (expired) { try { await release(client, new Error("neighborhood_land_use_connection_expired"), cleanupMilliseconds); } catch { /* contained late cleanup */ } stop("connection_timeout"); }
    return client;
  });
  try { return await bounded(pending, milliseconds, "connection_timeout"); }
  catch (error) { expired = true; throw error; }
}
function provenanceOf(input) {
  const { geometry, ...boundary } = input.boundary;
  return { boundary: { ...boundary, geometry_sha256: geometry.content_sha256, srid: geometry.srid },
    source_snapshots: input.source_snapshots,
    features: input.features.map(({ geometry: featureGeometry, ...feature }) => ({ ...feature, geometry_sha256: featureGeometry.content_sha256,
      context_sha256: landUseEvidenceDigest({ semantics: feature.semantics, classification: feature.classification,
        fact_validity: feature.fact_validity, historical_availability: feature.historical_availability }) })) };
}
function initial(limits, input = null) {
  return { result_type: "neighborhood_land_use_partition", partition_version: LAND_USE_PARTITION_VERSION,
    computation_status: "incomplete", effective_date_support: "unknown", report_eligibility: "not_assessed",
    scope: input?.scope ?? null, effective_date: input?.effective_date ?? null, knowledge_cutoff: input?.knowledge_cutoff ?? null,
    input_sha256: input ? landUseEvidenceDigest(input) : null, partition_revision: null, boundary_area_m2: null,
    buckets: [], coverage: null, diagnostics: {}, engine_versions: null, performed_policy: null,
    provenance: input ? provenanceOf(input) : null, incomplete_reasons: [], limits };
}
function finish(output, limits, errorCode = null) {
  if (errorCode) {
    output.computation_status = "incomplete"; output.partition_revision = null; output.boundary_area_m2 = null;
    output.buckets = []; output.coverage = null; output.diagnostics = {}; output.incomplete_reasons = [errorCode];
  }
  if (Buffer.byteLength(JSON.stringify(output)) > limits.output_bytes) {
    output.computation_status = "incomplete"; output.partition_revision = null; output.boundary_area_m2 = null;
    output.buckets = []; output.coverage = null; output.diagnostics = {}; output.provenance = null;
    output.engine_versions = null; output.performed_policy = null; output.incomplete_reasons = ["output_limit_exceeded"];
  }
  // Minimum output limit guarantees this bounded fallback envelope can fit.
  if (Buffer.byteLength(JSON.stringify(output)) > limits.output_bytes) {
    output.scope = null; output.input_sha256 = null;
  }
  return frozen(output);
}

/** Geometry-only injected PostGIS kernel. Configure the pool's own connection
 * timeout and an isolated bounded worker as well. Content hashes are identity,
 * not source authenticity, historical proof, report permission or signing. */
export function createNeighborhoodPostgisLandUsePartition(pool, { limits: options } = {}) {
  if (typeof pool?.connect !== "function") invalid("pool");
  const limits = limitsOf(options);
  return { async build(rawInput) {
    const started = performance.now(); let input, output;
    try { input = normalize(rawInput, limits); output = initial(limits, input); }
    catch (error) { if (!internalErrors.has(error)) throw error; return finish(initial(limits), limits, reason(error)); }
    if (input.source_snapshots.some(source => source.state !== "complete")) return finish(output, limits, "source_evidence_incomplete");
    if (input.source_snapshots.some(source => source.captured_at > input.knowledge_cutoff)) return finish(output, limits, "knowledge_cutoff_exceeded");
    const remaining = () => { const value = limits.duration_ms - (performance.now() - started); if (value <= 0) stop("duration_limit"); return Math.max(1, Math.floor(value)); };
    let client, begun = false, poisoned = false, errorCode = null;
    const query = async (tag, text, values = []) => {
      const timeout = Math.min(limits.statement_ms + 1000, remaining());
      try {
        const response = await bounded(Promise.resolve().then(() => client.query({ text: `/* neighborhood-land-use:${tag} */ ${text}`, values, query_timeout: timeout })), timeout, "query_timeout");
        remaining(); if (!response || !Array.isArray(response.rows)) stop("invalid_partition_result"); return response.rows;
      } catch (error) { poisoned = true; throw error; }
    };
    try {
      client = await connect(pool, Math.min(limits.connect_ms, remaining()), limits.cleanup_ms);
      begun = true;
      await query("begin", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      // node-postgres returns QueryResult[] for multi-statement text. Keep this
      // one statement so the same strict rows protocol covers native clients.
      await query("settings", `SELECT pg_catalog.set_config('statement_timeout',$1::text,true) AS statement_timeout,
        pg_catalog.set_config('lock_timeout',$2::text,true) AS lock_timeout,
        pg_catalog.set_config('idle_in_transaction_session_timeout',$3::text,true) AS idle_in_transaction_session_timeout`,
      [`${limits.statement_ms}ms`, "1000ms", "10000ms"]);
      const versions = await query("versions", VERSION_SQL);
      if (versions.length !== 1) stop("engine_version_unavailable"); output.engine_versions = versionsOf(versions[0]);
      const features = input.features.map(feature => ({ id: feature.id, semantics: feature.semantics, ewkb: feature.geometry.ewkb,
        category: feature.semantics === "observed_use" && feature.classification.status === "supported" &&
          support(feature, input.effective_date, input.knowledge_cutoff) === "supported" ? feature.classification.category : null }));
      const values = [input.boundary.geometry.ewkb, JSON.stringify(features)];
      const validation = await query("validate", VALIDATE_SQL, values);
      if (validation.length !== 1 || validation[0].boundary_valid !== true || validation[0].features_valid !== true) stop("invalid_polygon_geometry");
      const rows = await query("partition", partitionSql(limits), values);
      if (rows.length !== 1) stop("invalid_partition_result");
      const partition = partitionOf(rows[0], input, limits);
      output.performed_policy = { ...input.policy, kernel_version: LAND_USE_PARTITION_VERSION, supported_projection_window: WINDOW,
        denominator: "full_geographic_boundary_surface", geometry_repair: "none", snap_tolerance_meters: 0,
        numerical_tolerance_m2: partition.tolerance, tolerance_usage: "validation_only",
        classification_semantics: "observed_use_with_effective_date_support", unknown_precedence: "known_union_subtracted_from_unknown",
        category_pairs: "fixed_known_categories", report_mapping: "not_performed" };
      const { tolerance, ...computed } = partition; Object.assign(output, computed);
      await query("commit", "COMMIT"); begun = false;
    } catch (error) { errorCode = reason(error); }
    if (client) {
      if (begun && !poisoned) {
        try { await bounded(Promise.resolve().then(() => client.query({ text: "/* neighborhood-land-use:rollback */ ROLLBACK", query_timeout: limits.cleanup_ms })), limits.cleanup_ms, "cleanup_failed"); }
        catch { poisoned = true; errorCode = errorCode ?? "cleanup_failed"; }
      }
      try { await release(client, errorCode || poisoned ? new Error("neighborhood_land_use_client_discarded") : undefined, limits.cleanup_ms); }
      catch { errorCode = errorCode ?? "cleanup_failed"; }
    }
    if (errorCode) return finish(output, limits, errorCode);
    try {
      remaining(); output.computation_status = "ready";
      output.partition_revision = `land-use:${landUseEvidenceDigest({ ...output, partition_revision: null })}`;
      remaining(); return finish(output, limits);
    } catch (error) { return finish(output, limits, reason(error)); }
  } };
}
