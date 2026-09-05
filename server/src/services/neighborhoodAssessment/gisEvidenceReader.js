import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { OFFICIAL_ZONING_SOURCES } from "../propertyZoningSources.js";
import { canonicalAssessmentJson } from "./contract.js";
import { buildCachedSourceCaptures } from "./cachedSourceCaptures.js";

export const GIS_EVIDENCE_READER_VERSION = "gis-cache-query-v1";
export const GIS_EVIDENCE_LIMITS = Object.freeze({
  page_rows: 250, total_rows: 20_000, total_bytes: 8_000_000,
  record_bytes: 128_000, page_bytes: 512_000, total_wire_bytes: 16_000_000,
  subject_members: 32, statement_ms: 5_000, total_ms: 30_000,
});
const MAXIMUM = Object.freeze({
  page_rows: 1000, total_rows: 50_000, total_bytes: 16_000_000,
  record_bytes: 512_000, page_bytes: 2_000_000, total_wire_bytes: 32_000_000,
  subject_members: 100, statement_ms: 10_000, total_ms: 60_000,
});
const CATALOG = Object.freeze(Object.fromEntries([
  ["dcad_parcels", { table: "gis.dcad_parcels", id: "object_id", kind: "parcel", provider: "dcad",
    url: "https://maps.dcad.org/prdwa/rest/services/Property/ParcelQuery/MapServer/4/query" }],
  ...["tiger_roads_primary", "tiger_roads_secondary", "tiger_roads_local", "tiger_railroads"]
    .map((key, index) => [key, { table: "gis.road_segments", id: "source_object_id", kind: "road",
      partition: "source_layer", partitionValue: key, provider: "census_tiger",
      url: `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer/${index}/query` }]),
  ["txdot_aadt", { table: "gis.traffic_volume_segments", id: "source_object_id", kind: "traffic",
    partition: "source_key", partitionValue: "txdot_aadt", provider: "txdot",
    url: "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_AADT/FeatureServer/0/query" }],
  ...OFFICIAL_ZONING_SOURCES.map(source => [source.sourceKey, {
    table: "gis.zoning_districts", id: "source_record_id", kind: "zoning",
    partition: "provider_key", partitionValue: source.providerKey, provider: source.providerKey,
    url: source.url, layer: source.layer,
  }]),
].map(([key, value]) => [key, Object.freeze(value)])));
export const GIS_EVIDENCE_SOURCE_KEYS = Object.freeze(Object.keys(CATALOG).sort());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_KEYS = ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
const invalid = field => { throw new TypeError(`invalid_neighborhood_gis_reader:${field}`); };
const safeFailures = new WeakSet();
const failure = (reason, sqlstate) => {
  const error = Object.assign(new Error(`neighborhood_gis_reader:${reason}`), {
    code: "NEIGHBORHOOD_GIS_READ_FAILED", state: "incomplete", reason,
    ...(/^[0-9A-Z]{5}$/.test(sqlstate || "") ? { sqlstate } : {}),
  });
  safeFailures.add(error);
  return error;
};
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const digest = value => createHash("sha256").update(canonicalAssessmentJson(value)).digest("hex");
const timestamp = column => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function options(input) {
  if (!input || !input.pool || typeof input.pool.connect !== "function") invalid("pool");
  if (!input.scope || Object.getPrototypeOf(input.scope) !== Object.prototype) invalid("scope");
  const scope = Object.fromEntries(SCOPE_KEYS.map(key => {
    const value = input.scope[key];
    if (typeof value !== "string" || !value || value !== value.trim()
      || /[\u0000-\u001f\u007f]/.test(value)
      || (key === "account_id" ? value.length > 100 : !UUID.test(value))) invalid(`scope.${key}`);
    return [key, key === "account_id" ? value : value.toLowerCase()];
  }));
  const bounds = input.bounds;
  if (!bounds || Object.getPrototypeOf(bounds) !== Object.prototype) invalid("bounds");
  const { west, south, east, north } = bounds;
  if (![west, south, east, north].every(value => typeof value === "number" && Number.isFinite(value))
    || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north
    || east - west > 1 || north - south > 1) invalid("bounds");
  // This is an explicit coordinate envelope, not an approximation of a metric radius.
  const sourceKeys = input.sourceKeys;
  if (!Array.isArray(sourceKeys) || !sourceKeys.length || sourceKeys.length > 24
    || new Set(sourceKeys).size !== sourceKeys.length
    || sourceKeys.some(key => typeof key !== "string" || !Object.hasOwn(CATALOG, key))
    || !sourceKeys.includes("dcad_parcels")) invalid("sourceKeys");
  const supplied = input.limits ?? {};
  if (!supplied || Object.getPrototypeOf(supplied) !== Object.prototype
    || Object.keys(supplied).some(key => !Object.hasOwn(MAXIMUM, key))) invalid("limits");
  const limits = { ...GIS_EVIDENCE_LIMITS, ...supplied };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM[key]) invalid(`limits.${key}`);
  }
  if (limits.page_bytes < limits.record_bytes) invalid("limits.page_bytes");
  return { pool: input.pool, scope, bounds: { west, south, east, north },
    sourceKeys: [...sourceKeys].sort(), limits };
}

// Values are always parameters. Identifiers/expressions below come only from this fixed catalog.
function properties(kind) {
  const fields = {
    parcel: ["account_id", "low_parcel_id", "site_address", "use_code", "use_description", "class_code",
      "class_description", "property_description", "subdivision_name", "structure_type", "land_use_category",
      "classification_confidence", "classification_review_reason", "built_up", "building_area_sqft::text",
      "residential_area_sqft::text", "residential_year_built", "land_value::text", "improvement_value::text",
      "current_market_value::text", "previous_market_value::text", "parcel_area_sqft::text"],
    road: ["source_oid", "name", "base_name", "mtfcc", "route_type", "road_class", "source_vintage"],
    traffic: ["route_name", "route_prefix", "route_number", "roadway_type", "current_aadt"],
    zoning: ["jurisdiction", "zoning_code", "zoning_description", "generalized_use", "overlays::text"],
  }[kind];
  const pairs = fields.map(field => `'${field.split("::")[0]}', t.${field}`);
  if (kind === "parcel" || kind === "zoning") pairs.push(`'source_updated_at', ${timestamp("t.source_updated_at")}`);
  if (kind === "traffic") pairs.push(`'source_date', ${timestamp("t.source_date")}`);
  // Preserve JSONB numeric precision instead of decoding arbitrary source numbers through JS Number.
  pairs.push("'source_attributes_json', t.source_attributes::text");
  return `jsonb_build_object(${pairs.join(", ")})`;
}

function pageSql(spec, hasRuns) {
  const id = spec.kind === "zoning" ? `t.${spec.id} COLLATE "C"` : `t.${spec.id}`;
  const cursor = spec.kind === "zoning" ? '$6::text COLLATE "C"' : "$6::bigint";
  return `/* neighborhood-gis:page:${spec.kind} */
    WITH selected AS MATERIALIZED (
      SELECT t.* FROM ${spec.table} t
      WHERE ${spec.partition ? `t.${spec.partition} = $5::text` : "$5::text IS NULL"}
        AND t.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ST_Intersects(t.geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
        AND ($6::text IS NULL OR ${id} > ${cursor})
      ORDER BY ${id} LIMIT $7
    ), encoded AS (
      SELECT t.${spec.id} AS sort_key,
        CASE WHEN length(t.${spec.id}::text) <= 140 AND octet_length(t.${spec.id}::text) <= 256
        THEN t.${spec.id}::text END AS feature_id,
        CASE WHEN ST_MemSize(t.geom)::bigint * 2 + pg_column_size(t)::bigint > $8 THEN NULL
        ELSE jsonb_build_object(
          'properties', ${properties(spec.kind)},
          'geometry_ewkb', encode(ST_AsEWKB(t.geom, 'NDR'), 'hex'),
          'geometry_valid', ST_IsValid(t.geom) AND NOT ST_IsEmpty(t.geom),
          'ingest', jsonb_build_object('source_record_hash', t.source_record_hash,
            'sync_run_id', t.sync_run_id::text, 'synced_at', ${timestamp("t.synced_at")}),
          'origin_run', ${hasRuns ? `jsonb_build_object('id', r.id::text, 'source_key', r.source_key,
            'mode', r.mode, 'status', r.status, 'started_at', ${timestamp("r.started_at")},
            'completed_at', ${timestamp("r.completed_at")})` : "'{}'::jsonb"})::text END AS payload
      FROM selected t ${hasRuns ? "LEFT JOIN gis.source_sync_runs r ON r.id = t.sync_run_id" : ""}
    ), sized AS (
      SELECT *, sum(COALESCE(octet_length(payload), 0)) OVER
        (ORDER BY ${spec.kind === "zoning" ? 'sort_key COLLATE "C"' : "sort_key"}) > $9 AS page_bytes_exceeded
      FROM encoded
    )
    SELECT feature_id, CASE WHEN octet_length(payload) <= $8 AND NOT page_bytes_exceeded THEN payload ELSE NULL END AS payload_json,
      octet_length(payload) AS payload_bytes, page_bytes_exceeded,
      feature_id IS NULL AS invalid_feature_identity FROM sized
    ORDER BY ${spec.kind === "zoning" ? 'sort_key COLLATE "C"' : "sort_key"}`;
}

const CAPABILITIES_SQL = `/* neighborhood-gis:capabilities */
  SELECT name, to_regclass(name)::text AS relation FROM unnest($1::text[]) AS name`;
const stateSql = hasRuns => `/* neighborhood-gis:state */
  SELECT s.source_key, s.status,
    CASE WHEN octet_length(s.source_vintage) <= 256 THEN s.source_vintage END AS source_vintage,
    s.source_url = expected.url AS source_url_matches_catalog,
    octet_length(COALESCE(s.source_vintage, '')) > 256 AS metadata_oversized, s.row_count::text,
    s.last_run_id::text, ${timestamp("s.last_success_at")} AS last_success_at,
    ${timestamp("s.last_attempt_at")} AS last_attempt_at,
    ${timestamp("s.last_source_update_at")} AS last_source_update_at,
    ${hasRuns ? `r.id::text AS run_id,
    CASE WHEN octet_length(r.source_key) <= 100 THEN r.source_key END AS run_source_key, r.mode AS run_mode, r.status AS run_status,
    ${timestamp("r.started_at")} AS run_started_at, ${timestamp("r.completed_at")} AS run_completed_at`
    : "NULL AS run_id, NULL AS run_source_key, NULL AS run_mode, NULL AS run_status, NULL AS run_started_at, NULL AS run_completed_at"}
  FROM gis.source_sync_state s JOIN unnest($1::text[], $2::text[]) AS expected(key, url) ON expected.key = s.source_key
  ${hasRuns ? "LEFT JOIN gis.source_sync_runs r ON r.id = s.last_run_id" : ""}
  ORDER BY s.source_key COLLATE "C"`;
const REGISTRY_SQL = `/* neighborhood-gis:registry */
  SELECT provider_key, provider_type, status,
    CASE WHEN octet_length(jurisdiction) <= 256 THEN jurisdiction END AS jurisdiction,
    service_url = expected.url AS service_url_matches_catalog,
    service_layer = expected.layer AS service_layer_matches_catalog,
    octet_length(jurisdiction) > 256 AS metadata_oversized,
    ${timestamp("last_success_at")} AS last_success_at
  FROM gis.zoning_source_registry JOIN unnest($1::text[], $2::text[], $3::integer[]) AS expected(key, url, layer)
    ON expected.key = provider_key
  ORDER BY provider_key COLLATE "C"`;
const SUBJECT_SQL = `/* neighborhood-gis:subject */
  SELECT object_id::text AS feature_id,
    ST_CoveredBy(geom, ST_MakeEnvelope($1,$2,$3,$4,4326)) AS covered
  FROM gis.dcad_parcels WHERE account_id = $5::text
  ORDER BY object_id LIMIT $6`;

function healthy(state, key, observedAt) {
  return state?.status === "current" && state.last_run_id && state.last_run_id === state.run_id
    && state.source_url_matches_catalog === true && state.metadata_oversized === false
    && state.run_source_key === key && state.run_status === "complete"
    && ["full", "incremental"].includes(state.run_mode)
    && validTime(state.run_started_at, observedAt) && validTime(state.run_completed_at, observedAt)
    && state.run_started_at <= state.run_completed_at && validTime(state.last_success_at, observedAt)
    && state.last_success_at >= state.run_completed_at
    && /^(0|[1-9][0-9]*)$/.test(state.row_count || "");
}

function validTime(value, observedAt) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && value <= observedAt;
}

function record(row, key, spec, observedAt, limits) {
  if (typeof row.feature_id !== "string" || !row.feature_id || row.feature_id.length > 140
    || /[\u0000-\u001f\u007f]/.test(row.feature_id)
    || (spec.kind !== "zoning" && !/^(0|[1-9][0-9]*)$/.test(row.feature_id))) throw failure("invalid_feature_identity");
  if (typeof row.payload_json !== "string" || Buffer.byteLength(row.payload_json) > limits.record_bytes) {
    throw failure("record_bytes_limit");
  }
  let payload;
  try { payload = JSON.parse(row.payload_json); } catch { throw failure("invalid_feature_payload"); }
  const { properties: attributes, geometry_ewkb: ewkb, geometry_valid: valid, ingest, origin_run: origin } = payload ?? {};
  if (!attributes || Object.getPrototypeOf(attributes) !== Object.prototype || !ingest || !origin
    || typeof ewkb !== "string" || !/^(?:[0-9a-f]{2})+$/.test(ewkb)) throw failure("invalid_feature_payload");
  const feature = { source_key: key, dataset: spec.table, provider: spec.provider,
    configured_service_url: spec.url, configured_service_layer: spec.layer ?? null,
    acquisition_endpoint_history: "unavailable_in_legacy_run_ledger", object_id: row.feature_id };
  const geometry = { srid: 4326, serialization: "postgis-ewkb-ndr-hex", ewkb,
    content_sha256: createHash("sha256").update(Buffer.from(ewkb, "hex")).digest("hex"),
    raw_provider_geometry: "unavailable_in_legacy_mirror" };
  const content = { feature, attributes, geometry };
  const reasons = [];
  if (valid !== true) reasons.push("invalid_or_empty_geometry");
  if (!ingest.sync_run_id || ingest.sync_run_id !== origin.id || origin.source_key !== key
    || origin.status !== "complete" || !["full", "incremental"].includes(origin.mode)
    || !validTime(origin.started_at, observedAt) || !validTime(origin.completed_at, observedAt)
    || origin.started_at > origin.completed_at) reasons.push("origin_run_unverified");
  const result = { record_id: `${key}:${row.feature_id}`, data: {
    ...content, normalized_content_sha256: digest(content), ingest, origin_run: origin,
  } };
  const canonical = canonicalAssessmentJson(result);
  const bytes = Buffer.byteLength(canonical);
  if (bytes > limits.record_bytes) throw failure("record_bytes_limit");
  return { result, canonical, bytes, reasons };
}

async function connect(pool, timeout) {
  let timedOut = false;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => pool.connect()).then(client => {
        if (timedOut) { client?.release?.(true); throw failure("connection_timeout"); }
        return client;
      }),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(failure("connection_timeout")); }, timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Read already-ingested GIS evidence only. The caller must authorize this exact
 * assignment scope before calling; this service does not authenticate a user.
 * Ready certifies a bounded current-query capture, never provider-wide coverage,
 * historical availability, subject dwelling identity or report eligibility.
 * The returned frozen capture bytes must be persisted before enqueueing; never
 * re-query a mutable mirror to recreate them. No schemas/providers/graphs are modified.
 */
export async function readGisEvidence(input) {
  const { pool, scope, bounds, sourceKeys, limits } = options(input);
  const started = performance.now();
  const deadline = started + limits.total_ms;
  let client;
  let began = false;
  let discard = false;
  const query = async (text, values = []) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw failure("total_time_limit");
    return client.query({ text, values, query_timeout: Math.min(limits.statement_ms + 250, remaining) });
  };
  try {
    client = await connect(pool, limits.total_ms);
    if (!client || typeof client.query !== "function" || typeof client.release !== "function") throw failure("invalid_pool_client");
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    began = true;
    await query(`/* neighborhood-gis:settings */ SELECT
      set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true),
      set_config('idle_in_transaction_session_timeout', $3, true),
      set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, YMD', true)`,
    [String(limits.statement_ms), String(Math.min(limits.statement_ms, 1000)), String(limits.total_ms)]);
    const { rows: [clock] } = await query(`/* neighborhood-gis:clock */
      SELECT ${timestamp("statement_timestamp()")} AS captured_at,
        (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis_version`);
    if (!clock || !validTime(clock.captured_at, clock.captured_at)) throw failure("invalid_capture_clock");
    const observedAt = clock.captured_at;
    const tables = [...new Set(["gis.source_sync_state", "gis.source_sync_runs", "gis.zoning_source_registry",
      ...sourceKeys.map(key => CATALOG[key].table)])];
    const { rows: capabilities } = await query(CAPABILITIES_SQL, [tables]);
    const available = new Set(capabilities.filter(row => typeof row.relation === "string").map(row => row.name));
    const hasRuns = available.has("gis.source_sync_runs");
    const hasSync = available.has("gis.source_sync_state") && hasRuns;
    const states = new Map((available.has("gis.source_sync_state")
      ? (await query(stateSql(hasRuns), [sourceKeys, sourceKeys.map(key => CATALOG[key].url)])).rows : []).map(row => [row.source_key, row]));
    const zoningSpecs = sourceKeys.filter(key => CATALOG[key].kind === "zoning").map(key => CATALOG[key]);
    const registry = new Map((zoningSpecs.length && available.has("gis.zoning_source_registry")
      ? (await query(REGISTRY_SQL, [zoningSpecs.map(spec => spec.partitionValue), zoningSpecs.map(spec => spec.url),
        zoningSpecs.map(spec => spec.layer)])).rows : []).map(row => [row.provider_key, row]));
    const envelope = [bounds.west, bounds.south, bounds.east, bounds.north];
    const subjectReasons = [];
    let subjectRows = [];
    if (clock.postgis_version && available.has("gis.dcad_parcels")) {
      subjectRows = (await query(SUBJECT_SQL, [...envelope, scope.account_id, limits.subject_members + 1])).rows;
      if (subjectRows.length > limits.subject_members) subjectReasons.push("subject_members_limit");
      if (subjectRows.some(row => row.covered !== true)) subjectReasons.push("subject_outside_query_envelope");
      if (!subjectRows.length) subjectReasons.push("subject_account_not_resolved");
    } else subjectReasons.push("subject_source_absent");
    const captures = [];
    const diagnostics = [];
    let totalRows = 0;
    let totalBytes = 0;
    let totalWireBytes = 0;
    for (const key of sourceKeys) {
      const spec = CATALOG[key];
      const state = states.get(key) ?? null;
      const zone = registry.get(spec.partitionValue) ?? null;
      const reasons = new Set();
      const present = Boolean(clock.postgis_version) && available.has(spec.table);
      if (!present) reasons.add("source_schema_absent");
      if (!hasSync) reasons.add("source_sync_schema_absent");
      if (!healthy(state, key, observedAt)) reasons.add("source_sync_unverified");
      if (spec.kind === "zoning" && (zone?.provider_type !== "official_municipal" || zone.status !== "current"
        || zone.service_url_matches_catalog !== true || zone.service_layer_matches_catalog !== true || zone.metadata_oversized !== false
        || !validTime(zone.last_success_at, observedAt) || !state?.last_success_at
        || zone.last_success_at < state.last_success_at)) reasons.add("zoning_registry_unverified");
      const definition = { reader_version: GIS_EVIDENCE_READER_VERSION, source_key: key, dataset: spec.table,
        provider: spec.provider, service_url: spec.url, service_layer: spec.layer ?? null,
        partition: spec.partitionValue ?? null, bounds, srid: 4326,
        spatial_predicate: "bbox_intersection_and_st_intersects", ordering: spec.kind === "zoning" ? "source_record_id_C" : `${spec.id}_numeric`,
        scope_of_completeness: "selected_current_mirror_query_only", provider_coverage: "unknown",
        historical_availability: "unknown", postgis_version: clock.postgis_version ?? null,
        raw_source_state: state, zoning_registry: spec.kind === "zoning" ? zone : null, limits,
        content_digest_protocol: "sha256(canonical_header + LF + each_ordered_canonical_record + LF)",
      };
      const captureHash = createHash("sha256").update(canonicalAssessmentJson(definition)).update("\n");
      const normalizedHash = createHash("sha256");
      const records = [];
      let after = null;
      let exhausted = !present;
      let truncated = false;
      while (present && !exhausted) {
        const take = Math.min(limits.page_rows, limits.total_rows - totalRows);
        // Reserve bounded wire metadata per candidate, including the cap+1 sentinel.
        const pageBytes = Math.min(limits.page_bytes, limits.total_wire_bytes - totalWireBytes - (take + 1) * 512);
        if (pageBytes <= 0) throw failure("total_wire_bytes_limit");
        const { rows } = await query(pageSql(spec, hasRuns), [...envelope, spec.partitionValue ?? null, after,
          take + 1, limits.record_bytes, pageBytes]);
        if (!Array.isArray(rows) || rows.length > take + 1) throw failure("invalid_page_size");
        if (rows.some(row => row.invalid_feature_identity === true || row.feature_id === null)) throw failure("invalid_feature_identity");
        let wireBytes = 0;
        for (const row of rows) {
          wireBytes += Buffer.byteLength(typeof row.payload_json === "string" ? row.payload_json : "", "utf8")
            + Buffer.byteLength(String(row.feature_id ?? ""), "utf8") + 128;
        }
        totalWireBytes += wireBytes;
        if (wireBytes > pageBytes + (take + 1) * 512 || totalWireBytes > limits.total_wire_bytes) throw failure("total_wire_bytes_limit");
        const byteStop = rows.findIndex(row => row.page_bytes_exceeded === true);
        if (byteStop === 0) throw failure(pageBytes < limits.page_bytes ? "total_wire_bytes_limit" : "record_bytes_limit");
        const selected = rows.slice(0, Math.min(take, byteStop < 0 ? rows.length : byteStop));
        for (const row of selected) {
          const next = record(row, key, spec, observedAt, limits);
          if (after !== null && (spec.kind === "zoning"
            ? Buffer.compare(Buffer.from(row.feature_id, "utf8"), Buffer.from(after, "utf8")) <= 0
            : BigInt(row.feature_id) <= BigInt(after))) {
            throw failure("nonadvancing_feature_cursor");
          }
          if (totalBytes + next.bytes > limits.total_bytes) throw failure("total_bytes_limit");
          next.reasons.forEach(reason => reasons.add(reason));
          records.push(next.result); captureHash.update(next.canonical).update("\n");
          normalizedHash.update(next.result.record_id).update("\n").update(next.result.data.normalized_content_sha256).update("\n");
          totalRows++; totalBytes += next.bytes; after = row.feature_id;
        }
        exhausted = byteStop < 0 && rows.length <= take;
        if (!exhausted && totalRows === limits.total_rows) { truncated = true; break; }
      }
      if (truncated) reasons.add("total_rows_limit");
      if (state && /^(0|[1-9][0-9]*)$/.test(state.row_count || "") && BigInt(state.row_count) < BigInt(records.length)) {
        reasons.add("source_row_count_contradiction");
      }
      const complete = present && exhausted && reasons.size === 0;
      const contentHash = captureHash.digest("hex");
      captures.push({
        upstream: { id: `gis-cache:${key}`, key, state: !present ? "absent" : truncated ? "truncated" : records.length ? "populated" : "present_empty",
          complete, row_count: records.length, revision: present ? `${GIS_EVIDENCE_READER_VERSION}:${contentHash}` : null,
          content_sha256: present ? contentHash : null, captured_at: observedAt, visibility: "assignment_private", scope },
        metadata: { id: `gis-query:${key}`, provider: spec.provider, revision: GIS_EVIDENCE_READER_VERSION,
          valid_from: null, valid_to: null, observed_at: observedAt, historical_availability: "unknown" },
        projection: { id: `gis-query:${key}`, revision: GIS_EVIDENCE_READER_VERSION, definition,
          input_row_count: records.length, output_record_count: records.length, complete }, records,
      });
      diagnostics.push({ source_key: key, status: complete ? "captured" : "unavailable", reasons: [...reasons].sort(),
        row_count: records.length, query_exhausted: exhausted && present, normalized_content_sha256: normalizedHash.digest("hex"),
        capture_content_sha256: present ? contentHash : null });
    }
    const parcel = captures.find(capture => capture.upstream.key === "dcad_parcels");
    const parcelIds = new Set(parcel.records.map(row => row.record_id));
    if (parcel.upstream.complete !== true) subjectReasons.push("subject_capture_incomplete");
    if (subjectRows.some(row => !parcelIds.has(`dcad_parcels:${row.feature_id}`))) subjectReasons.push("subject_member_not_captured");
    const capture = buildCachedSourceCaptures({ scope, captures });
    const result = freeze({ status: capture.status === "ready" && !subjectReasons.length ? "ready" : "incomplete",
      reader_version: GIS_EVIDENCE_READER_VERSION, captured_at: observedAt, capture,
      subject: { status: subjectReasons.length ? "unavailable" : "resolved", account_id: scope.account_id,
        member_record_ids: subjectRows.slice(0, limits.subject_members).map(row => `dcad_parcels:${row.feature_id}`),
        resolution_policy: "all_exact_account_features_no_alias_or_smallest_area_fallback", reasons: [...new Set(subjectReasons)].sort() },
      diagnostics, totals: { rows: totalRows, record_bytes: totalBytes, wire_bytes_estimate: totalWireBytes },
      applicability: { provider_coverage: "unknown", historical_availability: "unknown", report_eligibility: "not_assessed" },
    });
    await query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    discard = true;
    if (began) {
      try { await client.query({ text: "ROLLBACK", values: [], query_timeout: 1000 }); } catch { /* discard below */ }
    }
    if (safeFailures.has(error)) throw error;
    throw failure(error?.code === "57014" ? "statement_timeout" : "query_or_capture_failed", error?.code);
  } finally {
    if (client && typeof client.release === "function") {
      try { client.release(discard || undefined); }
      catch { if (!discard) throw failure("client_release_failed"); }
    }
  }
}
