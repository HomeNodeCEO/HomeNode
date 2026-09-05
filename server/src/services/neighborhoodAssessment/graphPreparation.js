import { assessmentEvidenceDigest, canonicalAssessmentJson } from "./contract.js";

// A source-linework manifest, NOT a geometry/noding engine. No topology flag
// supplied by a caller can promote these cached road parts into verified cells.
export const GRAPH_PREPARATION_VERSION = 1;
export const GRAPH_PREPARATION_LIMITS = Object.freeze({
  features: 2000, parts: 5000, coordinates: 50000, coordinates_per_feature: 20000, aliases: 5000,
  runs: 4000, states: 64, bytes: 8_000_000, query_bytes: 16_384,
});
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = field => { throw new TypeError(`invalid_graph_preparation:${field}`); };
function object(value, field) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(field);
  return value;
}
function text(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) fail(field);
  return value;
}
function hash(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (!HASH.test(value) || typeof value !== "string") fail(field);
  return value;
}
function uuid(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) fail(field);
  return value.toLowerCase();
}
function choice(value, options, field) { if (!options.includes(value)) fail(field); return value; }
function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(field);
  return value;
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function uniqueMap(rows, field, identify) {
  const result = new Map();
  for (const row of rows) {
    const id = identify(row);
    if (result.has(id)) fail(`${field}.duplicate`);
    result.set(id, row);
  }
  return result;
}
function reverseFirst(coordinates) {
  for (let i = 0; i < coordinates.length; i += 1) {
    const a = coordinates[i], b = coordinates[coordinates.length - i - 1];
    if (a[0] !== b[0]) return a[0] > b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
  }
  return false;
}
function validCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  let distinct = false;
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number" ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return false;
    if (point[0] !== coordinates[0][0] || point[1] !== coordinates[0][1]) distinct = true;
  }
  return distinct;
}

/**
 * Prepare an exact bounded EPSG:4326 cached-line capture for later PostGIS work.
 * capture: id/revision/acquired_at, exact query object (crs, bbox envelope, layers), coverage, expected_feature_count,
 * source_states [{source_key,status,last_run_id}], origin_runs [{id,source_key,mode,status}].
 * features: source_key/source_layer/source_object_id (exact decimal string),
 * source_record_hash (ingestion fingerprint or null), sync_run_id, source_vintage,
 * name/base_name/road_class, stored geometry, repair_revision/original_geometry_sha256.
 * aliases: revision, coverage, records [{normalized_alias,corridor_key,canonical_name,source,updated_at}].
 * policy: version, metric_srid, snap_tolerance_meters. These are requested future
 * preprocessing parameters, not evidence that projection/snapping was performed.
 *
 * ready_for_preprocessing certifies only this explicitly complete queried capture
 * and well-formed line coordinates. It proves neither provider-wide completeness,
 * past-effective-date coverage, geometry validity, planar topology nor travel access.
 * Names/aliases never merge lines. Every original part/order/coordinate is retained;
 * the separate semantic digest ignores direction/part order and ingestion metadata.
 */
export function prepareNeighborhoodLinework(input) {
  object(input, "input");
  if (input.version !== GRAPH_PREPARATION_VERSION) fail("version");
  const capture = object(input.capture, "capture"), aliasInput = object(input.aliases, "aliases");
  const policyInput = object(input.policy, "policy");
  for (const [value, field] of [[input.features, "features"], [capture.source_states, "source_states"],
    [capture.origin_runs, "origin_runs"], [aliasInput.records, "aliases.records"]]) if (!Array.isArray(value)) fail(field);
  const policy = { version: text(policyInput.version, "policy.version"), metric_srid: policyInput.metric_srid,
    snap_tolerance_meters: policyInput.snap_tolerance_meters };
  if (!Number.isSafeInteger(policy.metric_srid) || policy.metric_srid <= 0 || policy.metric_srid === 4326 ||
      typeof policy.snap_tolerance_meters !== "number" || !Number.isFinite(policy.snap_tolerance_meters) ||
      policy.snap_tolerance_meters < 0 || policy.snap_tolerance_meters > 30) fail("policy.metric_parameters");
  const context = { id: text(capture.id, "capture.id"), revision: text(capture.revision, "capture.revision"),
    acquired_at: timestamp(capture.acquired_at, "capture.acquired_at"),
    coverage: choice(capture.coverage, ["complete", "truncated", "unknown"], "capture.coverage"),
    expected_feature_count: capture.expected_feature_count };
  if (context.expected_feature_count !== null && (!Number.isSafeInteger(context.expected_feature_count) || context.expected_feature_count < 0)) fail("capture.expected_feature_count");
  const issues = new Map(), limitations = new Map();
  const note = (index, code, id = "capture") => {
    if (!index.has(code)) index.set(code, new Set());
    index.get(code).add(id);
  };
  const issue = (code, id) => note(issues, code, id);
  const limitation = (code, id) => note(limitations, code, id);
  const diagnostics = index => [...index].sort(([a], [b]) => compare(a, b))
    .map(([code, ids]) => ({ code, ids: [...ids].sort(compare) }));
  const result = { version: GRAPH_PREPARATION_VERSION, status: "incomplete", capture: context, policy,
    coordinate_crs: "EPSG:4326", geometry_validity: "not_evaluated", topology_validated: false,
    travel_connectivity: "not_evaluated", features: [], line_parts: [], aliases: [], source_states: [], origin_runs: [],
    query: null, query_sha256: null, alias_revision: null, linework_content_sha256: null, capture_sha256: null,
    incomplete_reasons: [], limitations: [], counts: { features: input.features.length, parts: 0, coordinates: 0, retained_bytes: 0 },
    required_next_steps: ["verify_metric_projection", "source_preserving_noding", "gap_overlap_sliver_checks", "polygonize_and_validate_cells", "publish_immutable_topology_revision"],
  };
  const finish = () => {
    result.incomplete_reasons = diagnostics(issues); result.limitations = diagnostics(limitations);
    // Atomic handoff: callers cannot mistake an input-order prefix for the full
    // source. Diagnostics remain, but no partial geometry/manifests are emitted.
    if (issues.size) { result.features = []; result.line_parts = []; result.aliases = []; }
    else result.status = "ready_for_preprocessing";
    return freeze(result);
  };
  for (const [count, ceiling, field] of [[input.features.length, GRAPH_PREPARATION_LIMITS.features, "features"],
    [aliasInput.records.length, GRAPH_PREPARATION_LIMITS.aliases, "aliases"],
    [capture.origin_runs.length, GRAPH_PREPARATION_LIMITS.runs, "origin_runs"],
    [capture.source_states.length, GRAPH_PREPARATION_LIMITS.states, "source_states"]]) {
    if (count > ceiling) issue("input_limit_exceeded", field);
  }
  if (issues.size) return finish();
  // First bound all nested geometry work, before canonical encoding or copying.
  for (const feature of input.features) {
    object(feature, "feature");
    const geom = feature.geometry;
    const parts = geom?.type === "LineString" ? [geom.coordinates] : geom?.type === "MultiLineString" ? geom.coordinates : null;
    if (!Array.isArray(parts) || !parts.length) { issue("source_geometry_unavailable"); continue; }
    result.counts.parts += parts.length;
    if (result.counts.parts > GRAPH_PREPARATION_LIMITS.parts) { issue("input_limit_exceeded", "geometry"); return finish(); }
    let featureCoordinates = 0;
    for (const part of parts) if (Array.isArray(part)) featureCoordinates += part.length;
    result.counts.coordinates += featureCoordinates;
    if (featureCoordinates > GRAPH_PREPARATION_LIMITS.coordinates_per_feature) {
      issue("input_limit_exceeded", "feature_geometry"); return finish();
    }
    if (result.counts.parts > GRAPH_PREPARATION_LIMITS.parts || result.counts.coordinates > GRAPH_PREPARATION_LIMITS.coordinates) {
      issue("input_limit_exceeded", "geometry"); return finish();
    }
  }
  let retainedBytes = 0;
  const encode = value => {
    let json;
    try { json = canonicalAssessmentJson(value); } catch (error) {
      if (!/^invalid_neighborhood_assessment:json_(limit|bytes)$/.test(error.message)) throw error;
      issue("input_limit_exceeded", "canonical_payload"); return null;
    }
    retainedBytes += Buffer.byteLength(json);
    if (retainedBytes > GRAPH_PREPARATION_LIMITS.bytes) issue("input_limit_exceeded", "bytes");
    result.counts.retained_bytes = retainedBytes;
    return json;
  };
  const prepareRows = (inputRows, normalize, order) => {
    const rows = [];
    for (const inputRow of inputRows) {
      const row = normalize(inputRow);
      // Charge one bounded normalized row before retaining it. Stop before
      // inspecting later rows, rather than allocating an oversized projection.
      encode(row);
      if (issues.has("input_limit_exceeded")) return null;
      rows.push(row);
    }
    return rows.sort(order);
  };
  object(capture.query, "capture.query");
  const envelope = capture.query.envelope, layers = capture.query.layers;
  if (capture.query.crs !== "EPSG:4326" || !Array.isArray(envelope) || envelope.length !== 4 ||
      envelope.some(value => typeof value !== "number" || !Number.isFinite(value)) ||
      !(envelope[0] < envelope[2] && envelope[1] < envelope[3]) || envelope[0] < -180 || envelope[2] > 180 ||
      envelope[1] < -90 || envelope[3] > 90 || !Array.isArray(layers) || !layers.length || layers.length > 64) fail("capture.query_envelope");
  for (const layer of layers) text(layer, "capture.query_layer");
  if (new Set(layers).size !== layers.length) fail("capture.query_layers_duplicate");
  const query = encode(capture.query);
  if (query === null) return finish();
  if (Buffer.byteLength(query) > GRAPH_PREPARATION_LIMITS.query_bytes) { issue("input_limit_exceeded", "query_bytes"); return finish(); }
  result.query = JSON.parse(query); result.query_sha256 = assessmentEvidenceDigest(result.query);
  encode({ context, policy });
  if (issues.has("input_limit_exceeded")) return finish();
  if (context.coverage !== "complete") issue(`source_capture_${context.coverage}`);
  if (context.expected_feature_count === null) issue("source_feature_count_unknown");
  else if (context.expected_feature_count !== input.features.length) issue("source_feature_count_mismatch");
  if (!input.features.length) issue("linework_empty");
  const runs = prepareRows(capture.origin_runs, row => {
    object(row, "origin_run");
    return { id: uuid(row.id, "origin_run.id"), source_key: text(row.source_key, "origin_run.source_key"),
      mode: choice(row.mode, ["full", "incremental"], "origin_run.mode"),
      status: choice(row.status, ["running", "complete", "failed"], "origin_run.status") };
  }, (a, b) => compare(a.id, b.id));
  if (runs === null) return finish();
  const runById = uniqueMap(runs, "origin_runs", row => row.id);
  for (const run of runs) if (run.status !== "complete") issue("origin_run_not_complete", run.id);
  const states = prepareRows(capture.source_states, row => {
    object(row, "source_state");
    return { source_key: text(row.source_key, "source_state.source_key"),
      status: choice(row.status, ["pending", "running", "current", "failed"], "source_state.status"),
      last_run_id: uuid(row.last_run_id, "source_state.last_run_id", true) };
  }, (a, b) => compare(a.source_key, b.source_key));
  if (states === null) return finish();
  const stateByKey = uniqueMap(states, "source_states", row => row.source_key);
  for (const state of states) {
    const run = runById.get(state.last_run_id);
    if (state.status !== "current" || !run || run.status !== "complete" || run.source_key !== state.source_key) issue("source_state_not_complete", state.source_key);
  }
  result.source_states = states; result.origin_runs = runs;
  result.alias_revision = text(aliasInput.revision, "aliases.revision", true);
  const aliasCoverage = choice(aliasInput.coverage, ["complete", "truncated", "unknown"], "aliases.coverage");
  if (aliasCoverage !== "complete" || result.alias_revision === null) issue("alias_capture_incomplete");
  const aliases = prepareRows(aliasInput.records, row => {
    object(row, "alias");
    return { normalized_alias: text(row.normalized_alias, "alias.name"), corridor_key: text(row.corridor_key, "alias.corridor"),
      canonical_name: text(row.canonical_name, "alias.canonical_name"), source: text(row.source, "alias.source"),
      updated_at: timestamp(row.updated_at, "alias.updated_at") };
  }, (a, b) => compare(a.normalized_alias, b.normalized_alias));
  if (aliases === null) return finish();
  uniqueMap(aliases, "aliases", row => row.normalized_alias);
  result.aliases = aliases;
  const featureIds = new Set();
  for (const row of input.features) {
    if (typeof row.source_object_id !== "string" || !/^[1-9][0-9]{0,19}$/.test(row.source_object_id)) fail("feature.source_object_id");
    const identity = { source_key: text(row.source_key, "feature.source_key"), source_layer: text(row.source_layer, "feature.source_layer"), source_object_id: row.source_object_id };
    const featureId = assessmentEvidenceDigest(identity);
    if (!layers.includes(identity.source_layer)) issue("feature_outside_declared_source_layers", featureId);
    if (featureIds.has(featureId)) fail("features.duplicate");
    featureIds.add(featureId);
    const feature = { feature_id: featureId, ...identity,
      source_record_hash: hash(row.source_record_hash, "feature.source_record_hash", true),
      sync_run_id: uuid(row.sync_run_id, "feature.sync_run_id", true), source_vintage: text(row.source_vintage, "feature.source_vintage", true),
      name: text(row.name, "feature.name", true), base_name: text(row.base_name, "feature.base_name", true),
      road_class: choice(row.road_class, ["primary", "secondary", "local", "railroad"], "feature.road_class"),
      repair_revision: text(row.repair_revision, "feature.repair_revision", true),
      original_geometry_sha256: hash(row.original_geometry_sha256, "feature.original_geometry_sha256", true) };
    const run = runById.get(feature.sync_run_id);
    if (!run || run.source_key !== feature.source_key || run.status !== "complete") issue("feature_origin_run_unavailable", featureId);
    if (!stateByKey.has(feature.source_key)) issue("feature_source_state_unavailable", featureId);
    if (feature.source_record_hash === null) limitation("ingestion_fingerprint_unavailable", featureId);
    if (feature.original_geometry_sha256 === null) limitation("original_geometry_unavailable", featureId);
    if (feature.repair_revision === null) limitation("stored_geometry_repair_metadata_unknown", featureId);
    const rawParts = row.geometry?.type === "LineString" ? [row.geometry.coordinates] : row.geometry?.type === "MultiLineString" ? row.geometry.coordinates : null;
    if (!Array.isArray(rawParts) || !rawParts.length) { issue("source_geometry_unavailable", featureId); continue; }
    const validParts = [];
    for (const [index, coordinates] of rawParts.entries()) {
      if (!validCoordinates(coordinates)) {
        issue("source_line_coordinates_invalid", featureId); continue;
      }
      validParts.push({ index, coordinates });
    }
    if (validParts.length !== rawParts.length) continue;
    const storedInput = { type: row.geometry.type, coordinates: row.geometry.type === "LineString" ? rawParts[0] : rawParts };
    // Charge the exact retained projection before allocating coordinate copies.
    encode({ feature, geometry: storedInput });
    if (issues.has("input_limit_exceeded")) return finish();
    const parts = [];
    for (const { index, coordinates } of validParts) {
      const retained = coordinates.map(point => [...point]);
      const geometry = { type: "LineString", coordinates: retained };
      const semanticGeometry = { type: "LineString", coordinates: reverseFirst(retained) ? [...retained].reverse() : retained };
      const part = { feature_id: featureId, source_part_index: index + 1, geometry,
        stored_geometry_sha256: assessmentEvidenceDigest(geometry), semantic_geometry_sha256: assessmentEvidenceDigest(semanticGeometry) };
      parts.push(part);
    }
    feature.geometry_type = row.geometry.type;
    feature.source_part_count = parts.length;
    const stored = { type: row.geometry.type, coordinates: row.geometry.type === "LineString" ? parts[0].geometry.coordinates : parts.map(part => part.geometry.coordinates) };
    feature.stored_geometry_sha256 = assessmentEvidenceDigest(stored);
    feature.content_sha256 = assessmentEvidenceDigest({ ...identity, name: feature.name, base_name: feature.base_name,
      road_class: feature.road_class, part_geometry_sha256: parts.map(part => part.semantic_geometry_sha256).sort(compare) });
    result.features.push(feature); result.line_parts.push(...parts);
  }
  if (issues.size) return finish();
  result.features.sort((a, b) => compare(a.feature_id, b.feature_id));
  result.line_parts.sort((a, b) => compare(a.feature_id, b.feature_id) || a.source_part_index - b.source_part_index);
  result.linework_content_sha256 = assessmentEvidenceDigest({ version: GRAPH_PREPARATION_VERSION, policy,
    features: result.features.map(row => ({ feature_id: row.feature_id, content_sha256: row.content_sha256 })),
    aliases: aliases.map(({ updated_at, ...row }) => assessmentEvidenceDigest(row)) });
  // Ordered per-row hashes keep manifests below the core single-object budget;
  // the retained rows themselves still have one aggregate preparation byte cap.
  result.capture_sha256 = assessmentEvidenceDigest({ context, query_sha256: result.query_sha256, policy,
    alias_revision: result.alias_revision, aliases: aliases.map(assessmentEvidenceDigest),
    states: states.map(assessmentEvidenceDigest), runs: runs.map(assessmentEvidenceDigest),
    features: result.features.map(assessmentEvidenceDigest) });
  return finish();
}
