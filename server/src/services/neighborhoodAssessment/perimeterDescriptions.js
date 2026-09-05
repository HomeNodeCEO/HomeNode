import { createHash } from "node:crypto";
import { canonicalAssessmentJson } from "./contract.js";

// Presentation over supplied identities only. Foundation's producer still owns
// source authority, selected-union validity, containment and exterior/hole roles.
// No topology service, provider, database, projection or spatial operation runs.
export const PERIMETER_DESCRIPTION_VERSION = "perimeter-description-v1";
export const PERIMETER_DESCRIPTION_LIMITS = Object.freeze({
  topology_bytes: 32000000, request_bytes: 36000000, selected_cells: 256,
  perimeter_edges: 5000, rings: 256, source_occurrences: 16384, feature_records: 2000,
  label_records: 2000, alias_decisions: 5000, source_snapshots: 1000, coordinates: 10000,
  output_bytes: 1000000, text_length: 256, summary_length: 2000, references: 64000,
});
const FAILURE_BYTES = 16384;
const SIDES = ["north", "east", "south", "west"];
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const internalReasons = new WeakMap();
const SCOPE_KEYS = ["organization_id", "appraisal_case_id", "subject_snapshot_id", "account_id"];
const SOURCE_KEYS = ["id", "revision", "provider", "content_sha256", "visibility", "scope", "valid_from", "valid_to", "observed_at", "historical_availability"];
const TEMPORAL_KEYS = ["observed_at", "valid_from", "valid_to", "historical_availability"];
const TOPOLOGY_LIMITS = { input_parts: 512, input_coordinates: 8192, cells: 1024, edges: 8192,
  primitive_segments: 512, candidate_pairs: 4096, source_references: 16384, output_bytes: 32000000,
  row_bytes: 128000, statement_ms: 5000, duration_ms: 20000, connect_ms: 3000 };
function invalid(field) { throw new TypeError(`invalid_perimeter_description:${field}`); }
function stop(code) { const error = new Error(code); internalReasons.set(error, code); throw error; }
function object(value, field) { if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid(field); return value; }
function keys(value, allowed, field, required = allowed) {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}
function text(value, field, maximum = 256) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}
function hash(value, field) { if (typeof value !== "string" || !SHA.test(value)) invalid(field); return value; }
function list(value, maximum, field) {
  if (!Array.isArray(value)) invalid(field);
  if (value.length > maximum) stop("input_limit_exceeded");
  return value;
}
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function date(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid(field);
  return value;
}
function timestamp(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(field);
  return value;
}
function scoped(value) {
  keys(value, SCOPE_KEYS, "scope");
  return Object.fromEntries(SCOPE_KEYS.map(key => {
    const entry = text(value[key], "scope", key === "account_id" ? 100 : 36);
    if (key !== "account_id" && !UUID.test(entry)) invalid("scope");
    return [key, key === "account_id" ? entry : entry.toLowerCase()];
  }));
}
function limitsOf(input = {}) {
  object(input, "limits"); const result = { ...PERIMETER_DESCRIPTION_LIMITS };
  if (Object.getOwnPropertySymbols(input).length) invalid("limits");
  for (const key of Object.getOwnPropertyNames(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid("limits");
    const value = descriptor.value;
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) invalid("limits");
    result[key] = value;
  }
  return result;
}

// Detach without invoking user accessors. Count exact JSON UTF-8 framing while
// visiting, and stop at a limit before inspecting later records. Topology rows
// subsequently use the existing bounded canonical encoder, never one 32MB row.
function detach(value, maximum, topologyMaximum = maximum) {
  let bytes = 0, nodes = 0, topologyStart = null;
  const ancestors = new WeakSet();
  const charge = number => {
    bytes += number;
    if (bytes > maximum || (topologyStart !== null && bytes - topologyStart > topologyMaximum)) stop("input_limit_exceeded");
  };
  const visit = (item, depth, isTopology = false) => {
    if (++nodes > 2000000 || depth > 40) stop("input_limit_exceeded");
    const previous = topologyStart;
    if (isTopology) topologyStart = bytes;
    let result;
    if (item === null || typeof item === "boolean") { charge(item === null ? 4 : item ? 4 : 5); result = item; }
    else if (typeof item === "string") {
      if (item.length > maximum) stop("input_limit_exceeded");
      charge(Buffer.byteLength(JSON.stringify(item))); result = item;
    } else if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid("nonfinite_number"); charge(Buffer.byteLength(JSON.stringify(item))); result = item;
    } else {
      if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) invalid("json_value");
      if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) invalid("json_object");
      ancestors.add(item); charge(2);
      if (Array.isArray(item)) {
        if (item.length > 2000000) stop("input_limit_exceeded");
        if (Object.keys(item).length !== item.length) invalid("sparse_array");
        result = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid("json_accessor");
          if (index) charge(1); result.push(visit(descriptor.value, depth + 1));
        }
      } else {
        result = {};
        const names = Object.getOwnPropertyNames(item);
        if (names.length > 2000000) stop("input_limit_exceeded");
        for (const [index, key] of names.entries()) {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) invalid("json_accessor");
          charge((index ? 1 : 0) + Buffer.byteLength(JSON.stringify(key)) + 1);
          Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1, depth === 0 && key === "topology"), enumerable: true, writable: true, configurable: true });
        }
      }
      ancestors.delete(item);
    }
    if (isTopology) topologyStart = previous;
    return result;
  };
  return visit(value, 0);
}
function encoded(value) {
  try { return canonicalAssessmentJson(value); }
  catch (error) {
    if (/^invalid_neighborhood_assessment:json_(limit|bytes)$/.test(error.message)) stop("input_limit_exceeded");
    invalid("canonical_record");
  }
}
function digest(value) { return createHash("sha256").update(encoded(value)).digest("hex"); }
export function perimeterDescriptionDigest(value) { return digest(detach(value, 1500000)); }
function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }
function strings(value, maximum, field, maximumText = 256) {
  const values = list(value, maximum, field).map(item => text(item, field, maximumText));
  if (new Set(values).size !== values.length) invalid(`${field}_duplicate`);
  return values.sort(compare);
}
function temporal(value) {
  const from = value.valid_from === null ? null : date(value.valid_from, "valid_from");
  const to = value.valid_to === null ? null : date(value.valid_to, "valid_to");
  if (from && to && from > to) invalid("valid_interval");
  if (!["contemporaneous", "reconstructed", "unknown"].includes(value.historical_availability)) invalid("historical_availability");
  return { observed_at: timestamp(value.observed_at, "observed_at"), valid_from: from, valid_to: to, historical_availability: value.historical_availability };
}
function temporalSupport(value, effectiveDate, cutoff) {
  if (value.observed_at > cutoff || (value.valid_from && value.valid_from > effectiveDate) || (value.valid_to && value.valid_to < effectiveDate)) return "unsupported";
  if (!value.valid_from || value.historical_availability === "unknown") return "unknown";
  if (value.historical_availability === "contemporaneous" && value.observed_at.slice(0, 10) > effectiveDate) return "unsupported";
  return "supported";
}
function combineSupport(values) { return values.includes("unsupported") ? "unsupported" : values.includes("unknown") ? "unknown" : "supported"; }
function normalizedAlias(value) { return value.normalize("NFC").trim().replace(/\s+/gu, " ").toUpperCase(); }

function topologyOf(topology, limits, chargeRefs) {
  object(topology, "topology");
  if (topology.status !== "ready" || topology.topology_validated !== true || topology.topology_revision === null) stop("topology_incomplete");
  if (topology.topology_version !== "postgis-planar-v2" || topology.metric_srid !== 26914 || topology.display_srid !== 4326) stop("unsupported_topology_policy");
  hash(topology.source_capture_sha256, "source_capture_sha256"); hash(topology.linework_content_sha256, "linework_content_sha256");
  const sourceLimits = keys(topology.limits, Object.keys(TOPOLOGY_LIMITS), "topology_limits");
  for (const [key, value] of Object.entries(sourceLimits)) if (!Number.isSafeInteger(value) || value < 1 || value > TOPOLOGY_LIMITS[key]) invalid("topology_limits");
  const collections = [["source_features", Math.min(limits.feature_records, 2000), "feature_id"], ["source_aliases", 5000, "normalized_alias"],
    ["cells", sourceLimits.cells, "id"], ["edges", sourceLimits.edges, "id"], ["nodes", sourceLimits.edges * 2, "id"]];
  const hasher = createHash("sha256"); let bytes = 0;
  const append = value => {
    const json = encoded(value); bytes += Buffer.byteLength(json) + 1;
    if (bytes > sourceLimits.output_bytes || bytes > limits.topology_bytes) stop("input_limit_exceeded");
    hasher.update(json).update("\n");
  };
  append({ version: topology.topology_version, metric_srid: topology.metric_srid, display_srid: topology.display_srid,
    capture: topology.source_capture_sha256, content: topology.linework_content_sha256, engine_versions: topology.engine_versions,
    policy: topology.performed_policy, source_coverage: topology.source_coverage, source_limitations: topology.source_limitations,
    diagnostics: topology.diagnostics, noding_admission: topology.noding_admission, travel_connectivity: topology.travel_connectivity, limits: sourceLimits });
  const maps = {};
  for (const [key, maximum, idKey] of collections) {
    const rows = list(topology[key], maximum, key);
    for (const row of rows) { object(row, key); text(row[idKey], key, key === "source_aliases" ? limits.text_length : 256); }
    const ordered = [...rows].sort((a, b) => compare(a[idKey], b[idKey]) || (key === "source_aliases" ? compare(a.corridor_key, b.corridor_key) : 0));
    append({ collection: key, count: rows.length });
    for (const row of ordered) {
      // Only SQL geometry rows use the producer's row_bytes cap. Source feature
      // descriptors retain the existing core canonical-record bound instead.
      if (["cells", "edges", "nodes"].includes(key) && Buffer.byteLength(encoded(row)) > sourceLimits.row_bytes) stop("input_limit_exceeded");
      append(row);
    }
    if (new Set(ordered.map(row => row[idKey])).size !== rows.length) invalid(`${key}_duplicate`);
    maps[key] = new Map(ordered.map(row => [row[idKey], row]));
  }
  if (`topology:${hasher.digest("hex")}` !== topology.topology_revision) invalid("topology_revision");
  const policy = object(topology.performed_policy, "topology_policy");
  if (policy.version !== "postgis-planar-v2" || policy.metric_srid !== 26914 || policy.snap_tolerance_meters !== 0 || policy.geometry_repair !== "none" ||
      policy.source_fraction_basis !== "source_segment" || policy.source_attribution !== "exact_normalized_EWKB_source_segment_reconstruction_v1") stop("unsupported_topology_policy");
  if (topology.source_coverage?.query_coverage !== "complete" || topology.noding_admission?.admitted !== true ||
      topology.noding_admission?.candidate_pairs_complete !== true || !Array.isArray(topology.incomplete_reasons) || topology.incomplete_reasons.length) stop("topology_incomplete");
  const admission = topology.noding_admission, diagnostics = object(topology.diagnostics, "topology_diagnostics");
  if (admission.policy !== "projected-primitive-bbox-v1" || !Number.isSafeInteger(admission.primitive_segments) ||
      admission.primitive_segments < 1 || admission.primitive_segments > sourceLimits.primitive_segments ||
      !Number.isSafeInteger(admission.candidate_pairs) || admission.candidate_pairs < 0 || admission.candidate_pairs > sourceLimits.candidate_pairs) stop("topology_incomplete");
  // A ready flag cannot override explicit producer failure evidence. This is
  // consistency admission; it neither reconstructs nor independently proves GIS.
  // Nonsimple source lines, unused edges and dangles are allowed by v2 and are
  // deliberately not fatal here; noding can produce valid sourced cells from them.
  for (const key of ["invalid_source_count", "invalid_cell_count", "sliver_cell_count",
    "unattributed_edge_count", "uncovered_source_segment_count", "ambiguous_source_edge_count", "invalid_incidence_count",
    "unsupported_boundary_count", "overlapping_cell_count"]) if (diagnostics[key] !== 0) stop("topology_incomplete");
  for (const feature of maps.source_features.values()) {
    hash(feature.feature_id, "feature_id");
    for (const key of ["name", "base_name"]) if (feature[key] !== null) text(feature[key], "feature_name", limits.text_length);
    if (!["primary", "secondary", "local", "railroad"].includes(feature.road_class) || !Number.isSafeInteger(feature.source_part_count) || feature.source_part_count < 1) invalid("feature_descriptor");
  }
  let occurrences = 0;
  for (const edge of maps.edges.values()) {
    if (edge.metric_srid !== 26914 || edge.geometry_validated !== true || !/^edge:[a-f0-9]{64}$/.test(edge.id) ||
        !Number.isFinite(edge.length_meters) || edge.length_meters <= 0) stop("edge_geometry_incomplete");
    const cells = strings(edge.cell_ids, 2, "edge_cell_ids"); chargeRefs(cells.length);
    if (cells.some(id => !maps.cells.has(id)) || !maps.nodes.has(edge.from_node_id) || !maps.nodes.has(edge.to_node_id) || edge.from_node_id === edge.to_node_id) stop("topology_incidence_invalid");
    list(edge.source_parts, limits.source_occurrences, "source_parts");
    occurrences += edge.source_parts.length; if (occurrences > limits.source_occurrences || occurrences > sourceLimits.source_references) stop("input_limit_exceeded");
    const identities = new Set();
    for (const occurrence of edge.source_parts) {
      keys(occurrence, ["feature_id", "source_part_index", "source_segment_index", "source_fraction_basis", "start_fraction", "end_fraction"], "source_occurrence");
      const feature = maps.source_features.get(occurrence.feature_id);
      if (!feature || !Number.isSafeInteger(occurrence.source_part_index) || occurrence.source_part_index < 1 || occurrence.source_part_index > feature.source_part_count ||
          !Number.isSafeInteger(occurrence.source_segment_index) || occurrence.source_segment_index < 1 || occurrence.source_segment_index > 8192 ||
          occurrence.source_fraction_basis !== "source_segment" || !Number.isFinite(occurrence.start_fraction) || !Number.isFinite(occurrence.end_fraction) ||
          occurrence.start_fraction < 0 || occurrence.start_fraction > 1 || occurrence.end_fraction < 0 || occurrence.end_fraction > 1 || occurrence.start_fraction === occurrence.end_fraction) invalid("source_occurrence");
      const identity = encoded([occurrence.feature_id, occurrence.source_part_index, occurrence.source_segment_index]);
      if (identities.has(identity)) invalid("source_occurrence_duplicate"); identities.add(identity);
    }
    if (!edge.source_parts.length) stop("source_occurrence_incomplete");
  }
  for (const cell of maps.cells.values()) {
    if (!/^cell:[a-f0-9]{64}$/.test(cell.id) || cell.metric_srid !== 26914 || cell.geometry_validated !== true) stop("topology_incidence_invalid");
    const edgeIds = strings(cell.boundary_edge_ids, sourceLimits.edges, "cell_edges"); chargeRefs(edgeIds.length);
    if (edgeIds.some(id => !maps.edges.get(id)?.cell_ids.includes(cell.id))) stop("topology_incidence_invalid");
  }
  for (const edge of maps.edges.values()) if (edge.cell_ids.some(id => !maps.cells.get(id).boundary_edge_ids.includes(edge.id))) stop("topology_incidence_invalid");
  if (topology.diagnostics?.source_reference_count !== occurrences || topology.diagnostics?.edge_count !== maps.edges.size ||
      topology.diagnostics?.node_count !== maps.nodes.size || topology.diagnostics?.cell_count !== maps.cells.size) stop("topology_incidence_invalid");
  const aliases = new Map();
  for (const row of maps.source_aliases.values()) {
    keys(row, ["normalized_alias", "corridor_key", "canonical_name", "source", "updated_at"], "topology_alias");
    for (const key of ["normalized_alias", "corridor_key", "canonical_name", "source"]) text(row[key], "topology_alias", limits.text_length);
    timestamp(row.updated_at, "alias_updated_at"); aliases.set(digest(row), row);
  }
  return { ...maps, aliases };
}

function metricGeometry(hex, kind, expectedId, budget) {
  if (typeof hex !== "string" || hex.length > 200 || !/^(?:[a-f0-9]{2})+$/.test(hex)) stop("metric_geometry_invalid");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length < 9 || (bytes[0] !== 0 && bytes[0] !== 1)) stop("metric_geometry_invalid");
  const little = bytes[0] === 1, uint = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (uint(1) !== ((0x20000000 | kind) >>> 0) || uint(5) !== 26914) stop("metric_geometry_invalid");
  const count = kind === 1 ? 1 : bytes.length >= 13 ? uint(9) : 0, start = kind === 1 ? 9 : 13;
  if (count !== (kind === 1 ? 1 : 2) || bytes.length !== start + count * 16) stop("metric_geometry_invalid");
  budget.count += count; if (budget.count > budget.maximum) stop("input_limit_exceeded");
  if (`${kind === 1 ? "node" : "edge"}:${createHash("sha256").update(bytes).digest("hex")}` !== expectedId) stop("metric_geometry_identity_invalid");
  const result = [];
  for (let index = 0; index < count; index++) {
    const offset = start + index * 16;
    const point = [little ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset), little ? bytes.readDoubleLE(offset + 8) : bytes.readDoubleBE(offset + 8)];
    if (point.some(value => !Number.isFinite(value) || Math.abs(value) > 20000000)) stop("metric_geometry_invalid"); result.push(point);
  }
  return result;
}
function boundaryOf(boundary, maps, limits, input) {
  keys(boundary, ["revision", "scope", "effective_date", "knowledge_cutoff", "topology_revision", "source_capture_sha256", "geometry_sha256", "selected_cell_ids", "validation", "exterior", "interiors", "label_anchor", "content_sha256"], "selected_boundary",
    ["revision", "scope", "effective_date", "knowledge_cutoff", "topology_revision", "source_capture_sha256", "geometry_sha256", "selected_cell_ids", "content_sha256"]);
  text(boundary.revision, "selected_boundary_revision"); hash(boundary.geometry_sha256, "selected_geometry_sha256");
  const { content_sha256, ...manifest } = boundary;
  if (digest(manifest) !== hash(content_sha256, "selected_boundary_digest")) invalid("selected_boundary_digest");
  const boundaryScope = scoped(boundary.scope);
  if (SCOPE_KEYS.some(key => boundaryScope[key] !== input.scope[key]) ||
      date(boundary.effective_date, "boundary_effective_date") !== input.effective_date ||
      timestamp(boundary.knowledge_cutoff, "boundary_knowledge_cutoff") !== input.knowledge_cutoff ||
      boundary.topology_revision !== input.topology.topology_revision ||
      hash(boundary.source_capture_sha256, "boundary_source_capture") !== input.topology.source_capture_sha256) invalid("selected_boundary_context");
  const selected = new Set(strings(boundary.selected_cell_ids, limits.selected_cells, "selected_cells"));
  if (!selected.size || [...selected].some(id => !maps.cells.has(id))) stop("selected_boundary_incidence_invalid");
  if (!boundary.validation || !boundary.exterior || !Array.isArray(boundary.interiors) || !boundary.label_anchor) stop("upstream_boundary_validation_incomplete");
  keys(boundary.validation, ["valid", "connected", "contains_subject", "engine", "revision"], "boundary_validation");
  text(boundary.validation.engine, "validation_engine"); text(boundary.validation.revision, "validation_revision");
  if (boundary.validation.valid !== true || boundary.validation.connected !== true || boundary.validation.contains_subject !== true) stop("upstream_boundary_validation_incomplete");
  const anchor = keys(boundary.label_anchor, ["metric_srid", "coordinates", "basis", "validation_revision"], "label_anchor");
  if (anchor.metric_srid !== 26914 || anchor.basis !== "validated_subject_interior_point" || anchor.validation_revision !== boundary.validation.revision ||
      !Array.isArray(anchor.coordinates) || anchor.coordinates.length !== 2 || anchor.coordinates.some(value => !Number.isFinite(value) || Math.abs(value) > 20000000)) stop("label_anchor_incomplete");
  const expectedEdges = new Set([...maps.edges.values()].filter(edge => edge.cell_ids.filter(id => selected.has(id)).length === 1).map(edge => edge.id));
  const rings = [boundary.exterior, ...list(boundary.interiors, limits.rings - 1, "interiors")];
  if (rings.length > limits.rings) stop("input_limit_exceeded");
  const ringIds = new Set(), usedEdges = new Set(), points = new Map(), budget = { count: 0, maximum: limits.coordinates };
  const nodePoint = id => {
    if (!points.has(id)) {
      const node = maps.nodes.get(id);
      if (!node || node.metric_srid !== 26914) stop("selected_boundary_cycle_invalid");
      points.set(id, metricGeometry(node.geometry_ewkb, 1, id, budget)[0]);
    }
    return points.get(id);
  };
  const normalizedRings = [];
  for (let index = 0; index < rings.length; index++) {
    const ring = keys(rings[index], ["ring_id", "orientation", "segments"], "ring");
    text(ring.ring_id, "ring_id", limits.text_length);
    if (ringIds.has(ring.ring_id)) stop("selected_boundary_cycle_invalid"); ringIds.add(ring.ring_id);
    if (ring.orientation !== (index === 0 ? "counterclockwise" : "clockwise")) stop("ring_orientation_invalid");
    const segments = list(ring.segments, limits.perimeter_edges, "ring_segments");
    if (segments.length < 3) stop("selected_boundary_cycle_invalid");
    const rows = [];
    for (const segment of segments) {
      keys(segment, ["edge_id", "from_node_id", "to_node_id", "reversed"], "ring_segment");
      if (usedEdges.size >= limits.perimeter_edges) stop("input_limit_exceeded");
      const edge = maps.edges.get(segment.edge_id);
      if (!edge || !expectedEdges.has(edge.id) || usedEdges.has(edge.id) || typeof segment.reversed !== "boolean") stop("selected_boundary_incidence_invalid");
      usedEdges.add(edge.id);
      if (segment.from_node_id !== (segment.reversed ? edge.to_node_id : edge.from_node_id) ||
          segment.to_node_id !== (segment.reversed ? edge.from_node_id : edge.to_node_id)) stop("selected_boundary_cycle_invalid");
      const geometry = metricGeometry(edge.geometry_ewkb, 2, edge.id, budget);
      if (!same(geometry[0], nodePoint(edge.from_node_id)) || !same(geometry[1], nodePoint(edge.to_node_id))) stop("selected_boundary_cycle_invalid");
      const from = segment.reversed ? geometry[1] : geometry[0], to = segment.reversed ? geometry[0] : geometry[1];
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      if (!Number.isFinite(length) || length <= 0 || Math.abs(length - edge.length_meters) > Math.max(1, length) * 1e-9) stop("metric_length_invalid");
      rows.push({ ...segment, edge, from, to, length });
    }
    if (rows.some((row, i) => row.to_node_id !== rows[(i + 1) % rows.length].from_node_id)) stop("selected_boundary_cycle_invalid");
    const origin = rows[0].from;
    const signed = rows.reduce((sum, row) => sum + (row.from[0] - origin[0]) * (row.to[1] - origin[1]) - (row.to[0] - origin[0]) * (row.from[1] - origin[1]), 0);
    if (!Number.isFinite(signed) || (index === 0 ? signed <= 0 : signed >= 0)) stop("ring_orientation_invalid");
    const start = rows.reduce((best, row, i) => compare(row.edge_id, rows[best].edge_id) < 0 ? i : best, 0);
    const ordered = [...rows.slice(start), ...rows.slice(0, start)];
    const concave = index === 0 && ordered.some((row, i) => {
      const next = ordered[(i + 1) % ordered.length];
      return (row.to[0] - row.from[0]) * (next.to[1] - next.from[1]) - (row.to[1] - row.from[1]) * (next.to[0] - next.from[0]) < 0;
    });
    normalizedRings.push({ ring_id: ring.ring_id, interior: index !== 0, rows: ordered, concave });
  }
  if (usedEdges.size !== expectedEdges.size || [...expectedEdges].some(id => !usedEdges.has(id))) stop("selected_boundary_incidence_invalid");
  return { rings: [normalizedRings[0], ...normalizedRings.slice(1).sort((a, b) => compare(a.ring_id, b.ring_id))], anchor: [...anchor.coordinates] };
}

function evidenceOf(input, maps, limits, chargeRefs) {
  const sources = new Map(), bindings = new Map(), labels = new Map(), decisions = new Map();
  for (const source of list(input.source_snapshots, limits.source_snapshots, "source_snapshots")) {
    keys(source, SOURCE_KEYS, "source_snapshot");
    for (const key of ["id", "revision", "provider"]) text(source[key], `source_${key}`, limits.text_length);
    hash(source.content_sha256, "source_digest"); temporal(source);
    if (!["public", "organization", "assignment"].includes(source.visibility)) invalid("source_visibility");
    const owner = source.scope === null ? null : scoped(source.scope);
    if (source.visibility === "public" ? owner !== null : !owner || owner.organization_id !== input.scope.organization_id ||
        (source.visibility === "assignment" && SCOPE_KEYS.some(key => owner[key] !== input.scope[key]))) invalid("source_scope");
    if (sources.has(source.id)) invalid("source_duplicate"); sources.set(source.id, { ...source, scope: owner });
  }
  const refs = value => {
    const ids = strings(value, limits.source_snapshots, "source_refs", limits.text_length); chargeRefs(ids.length);
    if (!ids.length || ids.some(id => !sources.has(id))) invalid("source_reference_closure"); return ids;
  };
  const recordRef = value => {
    keys(value, ["source_id", "record_id", "record_sha256"], "record_ref");
    text(value.source_id, "record_source_id", limits.text_length); text(value.record_id, "record_id", limits.text_length); hash(value.record_sha256, "record_digest");
    if (!sources.has(value.source_id)) invalid("record_source_reference");
  };
  for (const binding of list(input.feature_bindings, limits.feature_records, "feature_bindings")) {
    keys(binding, ["feature_id", "source_refs"], "feature_binding");
    if (!maps.source_features.has(binding.feature_id) || bindings.has(binding.feature_id)) invalid("feature_binding");
    bindings.set(binding.feature_id, refs(binding.source_refs));
  }
  if (bindings.size !== maps.source_features.size) invalid("feature_binding_closure");
  for (const row of list(input.label_records, limits.label_records, "label_records")) {
    keys(row, ["id", "feature_id", "kind", "literal_name", "basis", "source_refs", "record_ref", ...TEMPORAL_KEYS, "content_sha256"], "label_record");
    const { content_sha256, ...manifest } = row;
    if (digest(manifest) !== hash(content_sha256, "label_digest")) invalid("label_digest");
    text(row.id, "label_id", limits.text_length); const feature = maps.source_features.get(row.feature_id);
    if (!feature || labels.has(row.id)) invalid("label_feature");
    if (!["road", "railroad", "watercourse", "plat_boundary", "parcel_boundary", "unknown"].includes(row.kind) ||
        !["feature_name", "feature_base_name", "source_label"].includes(row.basis)) invalid("label_kind_or_basis");
    if (row.literal_name !== null) text(row.literal_name, "literal_name", limits.text_length);
    if (row.basis !== "source_label") {
      if (row.literal_name !== feature[row.basis === "feature_name" ? "name" : "base_name"]) invalid("literal_feature_binding");
      if (row.kind !== "unknown" && row.kind !== (feature.road_class === "railroad" ? "railroad" : "road")) invalid("literal_feature_kind");
    }
    const sourceRefs = refs(row.source_refs); recordRef(row.record_ref); temporal(row);
    if (!sourceRefs.includes(row.record_ref.source_id) || !sourceRefs.some(id => bindings.get(row.feature_id).includes(id))) invalid("label_source_binding");
    labels.set(row.id, { ...row, source_refs: sourceRefs });
  }
  for (const row of list(input.alias_decisions, limits.alias_decisions, "alias_decisions")) {
    keys(row, ["id", "feature_id", "label_record_id", "alias_row_sha256", "matched_field", "matched_literal", "decision", "review_record_ref", "source_refs", ...TEMPORAL_KEYS, "content_sha256"], "alias_decision");
    const { content_sha256, ...manifest } = row;
    if (digest(manifest) !== hash(content_sha256, "alias_decision_digest")) invalid("alias_decision_digest");
    text(row.id, "alias_decision_id", limits.text_length);
    const label = labels.get(row.label_record_id), feature = maps.source_features.get(row.feature_id), alias = maps.aliases.get(row.alias_row_sha256);
    if (!label || label.feature_id !== row.feature_id || !feature || !alias || decisions.has(row.id)) invalid("alias_target");
    if (!["name", "base_name"].includes(row.matched_field) || !["accepted", "rejected"].includes(row.decision)) invalid("alias_decision");
    text(row.matched_literal, "alias_literal", limits.text_length);
    if (feature[row.matched_field] !== row.matched_literal || normalizedAlias(row.matched_literal) !== alias.normalized_alias ||
        normalizedAlias(alias.normalized_alias) !== alias.normalized_alias) invalid("alias_feature_binding");
    const sourceRefs = refs(row.source_refs); recordRef(row.review_record_ref); temporal(row);
    if (!sourceRefs.includes(row.review_record_ref.source_id)) invalid("alias_review_binding");
    decisions.set(row.id, { ...row, source_refs: sourceRefs });
  }
  return { sources, bindings, labels, decisions };
}

function direction(row, anchor, band) {
  const dx = row.to[0] - row.from[0], dy = row.to[1] - row.from[1];
  const angle = (Math.atan2(-dx, dy) * 180 / Math.PI + 360) % 360;
  const around = ["east", "north", "west", "south"], candidates = [];
  for (let index = 0; index < 4; index++) {
    const diagonal = 45 + 90 * index, distance = Math.abs(((angle - diagonal + 540) % 360) - 180);
    if (distance <= band) candidates.push(around[index], around[(index + 1) % 4]);
  }
  if (!candidates.length) candidates.push(around[Math.round(angle / 90) % 4]);
  const sides = SIDES.filter(side => candidates.includes(side));
  const midpoint = [(row.from[0] + row.to[0]) / 2, (row.from[1] + row.to[1]) / 2];
  const conflict = sides.some(side => side === "north" ? midpoint[1] <= anchor[1] : side === "south" ? midpoint[1] >= anchor[1] :
    side === "east" ? midpoint[0] <= anchor[0] : midpoint[0] >= anchor[0]);
  const reasons = [...(sides.length > 1 ? ["diagonal_ambiguity"] : []), ...(conflict ? ["anchor_side_ambiguity"] : [])];
  return { side_assignment: reasons.length ? "ambiguous" : sides[0], candidate_sides: sides, reasons };
}
function emptyOutput(limits) {
  return { result_type: "neighborhood_perimeter_description", description_version: PERIMETER_DESCRIPTION_VERSION,
    computation_status: "incomplete", description_status: "review_required", effective_date_support: "unknown",
    report_eligibility: "not_assessed", source_authority: "not_established", geometry_authority: "upstream_validation_required",
    scope: null, effective_date: null, knowledge_cutoff: null, topology_revision: null, selected_boundary_revision: null, geometry_sha256: null,
    input_sha256: null, description_revision: null, cardinal_summaries: Object.fromEntries(SIDES.map(side => [side, null])),
    sides: Object.fromEntries(SIDES.map(side => [side, { status: "unavailable", piece_ids: [], candidate_text: null, reasons: [] }])),
    exterior_pieces: [], interior_pieces: [], coverage: { perimeter_length_m: 0, named_length_m: 0, unnamed_length_m: 0, ambiguous_length_m: 0 },
    provenance: { source_refs: [], feature_ids: [], label_record_ids: [], alias_decision_ids: [] }, diagnostics: [], incomplete_reasons: [], performed_policy: null, limits };
}
function incomplete(limits, code, base) {
  const result = emptyOutput(limits);
  if (base) for (const key of ["scope", "effective_date", "knowledge_cutoff", "topology_revision", "selected_boundary_revision", "geometry_sha256", "input_sha256"]) result[key] = base[key];
  result.incomplete_reasons = [code];
  if (Buffer.byteLength(JSON.stringify(result)) > FAILURE_BYTES) invalid("failure_envelope");
  return freeze(result);
}

export function describeNeighborhoodPerimeter(rawInput, options = {}) {
  keys(options, ["limits"], "options", []);
  if (Object.getOwnPropertySymbols(options).length || Object.getOwnPropertyNames(options).some(key => key !== "limits")) invalid("options");
  const limitDescriptor = Object.getOwnPropertyDescriptor(options, "limits");
  if (limitDescriptor && (!limitDescriptor.enumerable || !Object.hasOwn(limitDescriptor, "value"))) invalid("options");
  const limits = limitsOf(limitDescriptor?.value); let output;
  try {
    const input = detach(rawInput, limits.request_bytes, limits.topology_bytes);
    keys(input, ["description_version", "scope", "effective_date", "knowledge_cutoff", "topology", "selected_boundary", "source_snapshots", "feature_bindings", "label_records", "alias_decisions", "policy"], "input");
    if (input.description_version !== PERIMETER_DESCRIPTION_VERSION) invalid("description_version");
    input.scope = scoped(input.scope); date(input.effective_date, "effective_date"); timestamp(input.knowledge_cutoff, "knowledge_cutoff");
    keys(input.policy, ["version", "metric_srid", "side_assignment", "diagonal_band_degrees", "concavity", "alias_matching", "language"], "policy");
    if (input.policy.version !== "metric-perimeter-presentation-v1" || input.policy.metric_srid !== 26914 || input.policy.side_assignment !== "oriented-normal-and-anchor-v1" ||
        input.policy.diagonal_band_degrees !== 5 || input.policy.concavity !== "review_required" || input.policy.alias_matching !== "nfc-trim-collapse-uppercase-v1" || input.policy.language !== "en") invalid("policy");
    output = emptyOutput(limits); Object.assign(output, { scope: input.scope, effective_date: input.effective_date, knowledge_cutoff: input.knowledge_cutoff });
    let referenceCount = 0;
    const chargeRefs = count => { referenceCount += count; if (referenceCount > limits.references) stop("input_limit_exceeded"); };
    const maps = topologyOf(input.topology, limits, chargeRefs), boundary = boundaryOf(input.selected_boundary, maps, limits, input);
    const evidence = evidenceOf(input, maps, limits, chargeRefs);
    const featureIds = new Set(boundary.rings.flatMap(ring => ring.rows.flatMap(row => row.edge.source_parts.map(source => source.feature_id))));
    const relevantLabels = [...evidence.labels.values()].filter(label => featureIds.has(label.feature_id)).sort((a, b) => compare(a.id, b.id));
    const labelIds = new Set(relevantLabels.map(label => label.id));
    const relevantDecisions = [...evidence.decisions.values()].filter(decision => labelIds.has(decision.label_record_id)).sort((a, b) => compare(a.id, b.id));
    const sourceIds = new Set([...featureIds].flatMap(id => evidence.bindings.get(id)));
    for (const row of [...relevantLabels, ...relevantDecisions]) row.source_refs.forEach(id => sourceIds.add(id));
    Object.assign(output, { topology_revision: input.topology.topology_revision, selected_boundary_revision: input.selected_boundary.revision,
      geometry_sha256: input.selected_boundary.geometry_sha256, performed_policy: { ...input.policy, orientation_check: "signed_metric_ring_area",
        metric_length_check: "decoded_EWKB_hypot", metric_length_comparison_relative_tolerance: 1e-9, geometry_operations: "none" },
      provenance: { source_refs: [...sourceIds].sort(compare), feature_ids: [...featureIds].sort(compare),
        label_record_ids: relevantLabels.map(row => row.id), alias_decision_ids: relevantDecisions.map(row => row.id) } });
    output.input_sha256 = digest({ version: PERIMETER_DESCRIPTION_VERSION, scope: input.scope, effective_date: input.effective_date, knowledge_cutoff: input.knowledge_cutoff,
      topology_revision: output.topology_revision, selected_boundary_sha256: input.selected_boundary.content_sha256,
      sources: [...sourceIds].sort(compare).map(id => evidence.sources.get(id)),
      bindings: [...featureIds].sort(compare).map(feature_id => ({ feature_id, source_refs: evidence.bindings.get(feature_id) })),
      labels: relevantLabels.map(row => ({ id: row.id, content_sha256: row.content_sha256 })),
      alias_decisions: relevantDecisions.map(row => ({ id: row.id, content_sha256: row.content_sha256 })), policy: input.policy, limits });
    const diagnostics = new Set(), sourceSupport = ids => combineSupport(ids.map(id => temporalSupport(evidence.sources.get(id), input.effective_date, input.knowledge_cutoff)));
    const labelsByFeature = new Map([...featureIds].map(id => [id, relevantLabels.filter(label => label.feature_id === id)]));
    const decisionsByLabel = new Map(relevantLabels.map(label => [label.id, relevantDecisions.filter(decision => decision.label_record_id === label.id)]));
    const labelFor = record => {
      const support = combineSupport([temporalSupport(record, input.effective_date, input.knowledge_cutoff), sourceSupport(record.source_refs)]);
      const valid = [], rejectedAliases = new Set();
      for (const decision of decisionsByLabel.get(record.id)) {
        const alias = maps.aliases.get(decision.alias_row_sha256);
        if (decision.observed_at > input.knowledge_cutoff || alias.updated_at > input.knowledge_cutoff) { diagnostics.add("alias_after_cutoff"); continue; }
        if (alias.updated_at > decision.observed_at) { diagnostics.add("alias_review_predates_row"); continue; }
        if (combineSupport([temporalSupport(decision, input.effective_date, input.knowledge_cutoff), sourceSupport(decision.source_refs)]) !== "supported") { diagnostics.add("alias_temporal_support_incomplete"); continue; }
        if (decision.decision === "rejected") {
          diagnostics.add("alias_rejected"); rejectedAliases.add(decision.alias_row_sha256); continue;
        }
        valid.push(decision);
      }
      const aliasKeys = new Set(valid.map(decision => decision.alias_row_sha256));
      // Both dispositions describe immutable evidence. Without an explicit
      // supersession relationship, an applicable rejection contradicts an
      // acceptance of the same row regardless of timestamps or arrival order.
      const conflict = aliasKeys.size > 1 || [...aliasKeys].some(key => rejectedAliases.has(key));
      if (conflict) diagnostics.add("alias_decisions_conflict");
      const accepted = !conflict && valid.length ? valid[0] : null;
      return { label_record_id: record.id, kind: record.kind, literal_name: record.literal_name,
        display_name: conflict ? record.literal_name ?? "Unnamed boundary segment" : accepted ? maps.aliases.get(accepted.alias_row_sha256).canonical_name : record.literal_name ?? "Unnamed boundary segment",
        alias_decision_id: accepted?.id ?? null, source_refs: [...record.source_refs], effective_date_support: support,
        disposition: conflict ? "conflicting" : record.literal_name === null ? "unnamed" : accepted ? "accepted_alias" : "literal" };
    };
    const preparedLabels = new Map(relevantLabels.map(record => [record.id, labelFor(record)]));
    const metadata = new Map();
    for (const ring of boundary.rings) for (const row of ring.rows) {
      const occurrences = [...row.edge.source_parts].sort((a, b) => compare(encoded(a), encoded(b))).map(source => ({ ...source,
        traversal_start_fraction: row.reversed ? source.end_fraction : source.start_fraction,
        traversal_end_fraction: row.reversed ? source.start_fraction : source.end_fraction }));
      const edgeFeatures = [...new Set(occurrences.map(source => source.feature_id))].sort(compare), labels = [];
      for (const featureId of edgeFeatures) {
        const records = labelsByFeature.get(featureId);
        if (records.length) for (const record of records) labels.push({ ...preparedLabels.get(record.id), source_refs: [...preparedLabels.get(record.id).source_refs] });
        else labels.push({ label_record_id: null, kind: "unknown", literal_name: null, display_name: "Unnamed boundary segment", alias_decision_id: null,
          source_refs: [...evidence.bindings.get(featureId)], effective_date_support: sourceSupport(evidence.bindings.get(featureId)), disposition: "unnamed" });
      }
      chargeRefs(labels.reduce((sum, label) => sum + label.source_refs.length, 0));
      const dirs = ring.interior ? { side_assignment: "interior", candidate_sides: [], reasons: [] } : direction(row, boundary.anchor, input.policy.diagonal_band_degrees);
      const reasons = [...dirs.reasons];
      if (ring.concave) reasons.push("concave_review_required");
      if (labels.some(label => label.literal_name === null)) reasons.push("unnamed_boundary");
      const dateSupport = combineSupport([...edgeFeatures.map(id => sourceSupport(evidence.bindings.get(id))), ...labels.map(label => label.effective_date_support)]);
      if (dateSupport !== "supported") reasons.push("effective_date_support_incomplete");
      const aliasCorridors = labels.map(label => label.alias_decision_id ? maps.aliases.get(evidence.decisions.get(label.alias_decision_id).alias_row_sha256).corridor_key : null);
      const resolvedTogether = labels.length > 1 && labels.every(label => label.disposition === "accepted_alias") &&
        new Set(aliasCorridors).size === 1 && new Set(labels.map(label => `${label.kind}:${label.display_name}`)).size === 1;
      if (labels.some(label => label.disposition === "conflicting") || (labels.length > 1 && !resolvedTogether)) {
        reasons.push("competing_source_labels"); labels.forEach(label => { if (label.literal_name !== null) label.disposition = "conflicting"; });
      }
      const piece = { id: `perimeter-piece:${digest({ ring_id: ring.ring_id, edge_id: row.edge_id, from_node_id: row.from_node_id, to_node_id: row.to_node_id })}`,
        ring_id: ring.ring_id, edge_id: row.edge_id, from_node_id: row.from_node_id, to_node_id: row.to_node_id, reversed: row.reversed, length_m: row.length,
        side_assignment: dirs.side_assignment, candidate_sides: dirs.candidate_sides, source_occurrences: occurrences, labels, reasons: [...new Set(reasons)].sort(compare) };
      (ring.interior ? output.interior_pieces : output.exterior_pieces).push(piece);
      metadata.set(piece.id, { dateSupport, text: [...new Set(labels.map(label => label.display_name))].join(" / ") });
      if (!ring.interior) {
        output.coverage.perimeter_length_m += row.length;
        output.coverage[labels.some(label => label.literal_name !== null) ? "named_length_m" : "unnamed_length_m"] += row.length;
        if (dirs.side_assignment === "ambiguous") output.coverage.ambiguous_length_m += row.length;
      }
    }
    const compatible = (a, b) => {
      if (a.to_node_id !== b.from_node_id || a.side_assignment !== b.side_assignment || metadata.get(a.id).text !== metadata.get(b.id).text ||
          a.labels.length !== b.labels.length || a.labels.some((label, index) => label.kind !== b.labels[index].kind || label.alias_decision_id !== b.labels[index].alias_decision_id) ||
          a.source_occurrences.length !== b.source_occurrences.length) return false;
      return a.source_occurrences.every((source, index) => {
        const next = b.source_occurrences[index];
        if (source.feature_id !== next.feature_id || source.source_part_index !== next.source_part_index) return false;
        return source.source_segment_index === next.source_segment_index ? source.traversal_end_fraction === next.traversal_start_fraction :
          next.source_segment_index === source.source_segment_index + 1 ? source.traversal_end_fraction === 1 && next.traversal_start_fraction === 0 :
          next.source_segment_index === source.source_segment_index - 1 && source.traversal_end_fraction === 0 && next.traversal_start_fraction === 1;
      });
    };
    for (const side of SIDES) {
      const pieces = output.exterior_pieces.filter(piece => piece.candidate_sides.includes(side));
      const reasons = [...new Set(pieces.flatMap(piece => piece.reasons))].sort(compare), runs = [];
      let previous;
      for (const piece of pieces) { if (!previous || !compatible(previous, piece)) runs.push(metadata.get(piece.id).text); previous = piece; }
      const candidate = runs.length ? runs.join("; ") : null;
      if (candidate !== null && candidate.length > limits.summary_length) stop("summary_limit_exceeded");
      const status = !pieces.length ? "unavailable" : reasons.length ? "review_required" : "supported";
      output.sides[side] = { status, piece_ids: pieces.map(piece => piece.id), candidate_text: candidate, reasons };
      output.cardinal_summaries[side] = status === "supported" ? candidate : null;
    }
    output.diagnostics = [...diagnostics].sort(compare);
    output.effective_date_support = combineSupport([...metadata.values()].map(value => value.dateSupport));
    output.description_status = SIDES.every(side => output.sides[side].status === "supported") ? "supported" : "review_required";
    output.computation_status = "complete";
    if (Buffer.byteLength(JSON.stringify({ ...output, description_revision: `perimeter-description:${"0".repeat(64)}` })) > limits.output_bytes) stop("output_limit_exceeded");
    output.description_revision = `perimeter-description:${digest({ ...output, description_revision: null })}`;
    if (Buffer.byteLength(JSON.stringify(output)) > limits.output_bytes) stop("output_limit_exceeded");
    return freeze(output);
  } catch (error) {
    if (internalReasons.has(error)) return incomplete(limits, internalReasons.get(error), output);
    throw error;
  }
}
