import { createHash } from "node:crypto";
import { assessmentEvidenceDigest, canonicalAssessmentJson } from "../../src/services/neighborhoodAssessment/contract.js";
import { ASSESSMENT_SCOPE } from "./neighborhoodAssessmentFixture.js";

// Invented exact metric source coordinates, translated from local origin (0,0)
// to [700000,3600000] in EPSG26914. No GIS operation or source authority is
// asserted by this synthetic upstream-validation fixture. Display coordinates
// below are intentionally illustrative, not a claimed projection: presentation
// must read the exact metric EWKB, never that display geometry.
export const PERIMETER_FIXTURE_METRIC = Object.freeze({ srid: 26914, origin: [700000, 3600000] });
// Frozen producer digest compatibility only; this does not imply native or
// security acceptance of the producer checkpoint.
export const FROZEN_TOPOLOGY_COMPATIBILITY_COMMIT = "2f603b426256926096f6d90f38fd2431d9174a12";
const digest = assessmentEvidenceDigest;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const at = "2024-07-01T00:00:00.000Z";
const runId = "00000000-0000-4000-8000-000000000001";
const sourceId = "synthetic-boundary-source";
const metric = point => [point[0] + 700000, point[1] + 3600000];
const display = point => [-97 + point[0] / 100000, 32 + point[1] / 100000];
const bytesDigest = hex => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const pointOrder = (a, b) => a[0] - b[0] || a[1] - b[1];

function ewkb(type, pointsOrRings) {
  const coordinates = type === 1 ? [pointsOrRings] : type === 2 ? pointsOrRings : pointsOrRings.flat();
  const countBytes = type === 1 ? 0 : type === 2 ? 4 : 4 + 4 * pointsOrRings.length;
  const bytes = Buffer.alloc(9 + countBytes + coordinates.length * 16);
  let cursor = 0;
  bytes.writeUInt8(1, cursor++); bytes.writeUInt32LE((0x20000000 | type) >>> 0, cursor); cursor += 4;
  bytes.writeUInt32LE(26914, cursor); cursor += 4;
  const writePoint = point => { bytes.writeDoubleLE(point[0], cursor); cursor += 8; bytes.writeDoubleLE(point[1], cursor); cursor += 8; };
  if (type === 1) writePoint(pointsOrRings);
  else if (type === 2) {
    bytes.writeUInt32LE(pointsOrRings.length, cursor); cursor += 4;
    pointsOrRings.forEach(writePoint);
  } else {
    bytes.writeUInt32LE(pointsOrRings.length, cursor); cursor += 4;
    for (const ring of pointsOrRings) { bytes.writeUInt32LE(ring.length, cursor); cursor += 4; ring.forEach(writePoint); }
  }
  return bytes.toString("hex");
}
export const perimeterFixtureEwkb = (type, coordinates) => ewkb(type, coordinates);
export const perimeterFixtureGeometryDigest = bytesDigest;

// Frozen compatibility encoding from the exact topology v3 manifest function
// at the commit above. Tests also freeze one literal expected digest checked by
// that exact helper in scratch. No unmerged topology module is imported here.
export function perimeterFixtureTopologyRevision(result) {
  const hash = createHash("sha256");
  const append = value => hash.update(canonicalAssessmentJson(value)).update("\n");
  append({ version: result.topology_version, metric_srid: result.metric_srid, display_srid: result.display_srid,
    capture: result.source_capture_sha256, content: result.linework_content_sha256, engine_versions: result.engine_versions,
    policy: result.performed_policy, source_coverage: result.source_coverage, source_limitations: result.source_limitations,
    diagnostics: result.diagnostics, noding_admission: result.noding_admission,
    travel_connectivity: result.travel_connectivity, limits: result.limits });
  for (const [key, id] of [["source_features", "feature_id"], ["source_aliases", "normalized_alias"],
    ["cells", "id"], ["edges", "id"], ["nodes", "id"]]) {
    append({ collection: key, count: result[key].length });
    [...result[key]].sort((a, b) => compare(a[id], b[id]) || (key === "source_aliases" ? compare(a.corridor_key, b.corridor_key) : 0)).forEach(append);
  }
  return `topology:${hash.digest("hex")}`;
}
export function rehashPerimeterFixtureRecord(record) {
  const { content_sha256: _previous, ...value } = record;
  record.content_sha256 = digest(value);
  return record;
}
export function rehashPerimeterFixture(input) {
  input.topology.topology_revision = perimeterFixtureTopologyRevision(input.topology);
  input.selected_boundary.topology_revision = input.topology.topology_revision;
  input.selected_boundary.source_capture_sha256 = input.topology.source_capture_sha256;
  rehashPerimeterFixtureRecord(input.selected_boundary);
  input.label_records.forEach(rehashPerimeterFixtureRecord);
  input.alias_decisions.forEach(rehashPerimeterFixtureRecord);
  return input;
}

const TOPOLOGY_LIMITS = Object.freeze({ input_parts: 512, input_coordinates: 8192, cells: 1024, edges: 8192,
  primitive_segments: 512, candidate_pairs: 4096, source_references: 16384, output_bytes: 32000000, row_bytes: 128000,
  statement_ms: 5000, duration_ms: 20000, connect_ms: 3000 });
const rectangle = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
const baseNames = ["South Road", "East Road", "North Road", "West Road"];
export const PERIMETER_FIXTURE_VARIANTS = Object.freeze([
  "rectangle", "diamond", "concave", "curved_north", "mixed_north", "duplicate_source", "conflicting_source", "alias", "hole", "two_cells", "split_north", "split_north_distinct_sources",
]);

export function neighborhoodPerimeterDescriptionFixture(variant = "rectangle") {
  if (!PERIMETER_FIXTURE_VARIANTS.includes(variant)) throw new TypeError("unknown_synthetic_perimeter_variant");
  let outer = rectangle.map(point => [...point]);
  let names = [...baseNames];
  let holes = [];
  let anchor = [50, 50];
  if (variant === "diamond") {
    outer = [[50, 0], [100, 50], [50, 100], [0, 50], [50, 0]];
    names = ["Southeast Road", "Northeast Road", "Northwest Road", "Southwest Road"];
  }
  if (variant === "concave") {
    outer = [[0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100], [0, 0]];
    names = ["South Road", "East Road", "North Road", "Indent East", "Indent Base", "Indent West", "North Road", "West Road"];
    anchor = [50, 20];
  }
  if (variant === "curved_north") {
    outer = [[0, 0], [100, 0], [100, 100], [75, 105], [50, 100], [25, 105], [0, 100], [0, 0]];
    names = ["South Road", "East Road", "Curving North Road", "Curving North Road", "Curving North Road", "Curving North Road", "West Road"];
  }
  if (variant === "mixed_north") {
    outer = [[0, 0], [100, 0], [100, 100], [75, 100], [50, 100], [25, 100], [0, 100], [0, 0]];
    names = ["South Road", "East Road", "North Road East", "Clear Creek", null, "North Road West", "West Road"];
  }
  if (["split_north", "split_north_distinct_sources"].includes(variant)) {
    outer = [[0, 0], [100, 0], [100, 100], [75, 100], [25, 100], [0, 100], [0, 0]];
    names = ["South Road", "East Road", "North Road", "North Road", "North Road", "West Road"];
  }
  if (variant === "hole") {
    holes = [[[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]];
    anchor = [20, 20];
  }
  if (variant === "alias") names[2] = "Old North Road";
  if (variant === "two_cells") {
    outer = [[0, 0], [50, 0], [100, 0], [100, 100], [50, 100], [0, 100], [0, 0]];
    names = ["South Road", "South Road", "East Road", "North Road", "North Road", "West Road"];
  }
  const cells = [], edges = [], nodes = [], features = [], featureBindings = [], labels = [];
  const nodeByCoordinates = new Map(), edgeByEndpoints = new Map();
  const featureRefs = new Map();
  const originalPrimitives = new Map();
  const ensureNode = point => {
    const key = point.join(",");
    if (nodeByCoordinates.has(key)) return nodeByCoordinates.get(key);
    const geometry_ewkb = ewkb(1, metric(point));
    const node = { id: `node:${bytesDigest(geometry_ewkb)}`, degree: 0, metric_srid: 26914,
      geometry_ewkb, geometry: { type: "Point", coordinates: display(point) } };
    nodes.push(node); nodeByCoordinates.set(key, node); return node;
  };
  const addSource = (edge, rawStart, rawEnd, name, suffix, shared = false, kind = "road", interval = null) => {
    const identity = { source_key: "synthetic-lines", source_layer: "synthetic-layer", source_object_id: suffix };
    const feature_id = digest(identity);
    let source = features.find(row => row.feature_id === feature_id);
    const primitiveStart = interval?.original_start ?? rawStart, primitiveEnd = interval?.original_end ?? rawEnd;
    const displayGeometry = { type: "LineString", coordinates: [display(primitiveStart), display(primitiveEnd)] };
    if (!source) {
      source = { feature_id, ...identity, source_record_hash: digest({ fixture_record: suffix }), sync_run_id: runId,
        source_vintage: "synthetic-2024", name, base_name: name, road_class: "local", repair_revision: null,
        original_geometry_sha256: null, geometry_type: "LineString", source_part_count: 1,
        stored_geometry_sha256: digest(displayGeometry), content_sha256: digest({ ...identity, name, displayGeometry }) };
      features.push(source); featureBindings.push({ feature_id, source_refs: [sourceId] });
      labels.push(rehashPerimeterFixtureRecord({ id: `label:${suffix}`, feature_id, kind, literal_name: name,
        basis: kind === "watercourse" ? "source_label" : "feature_name", source_refs: [sourceId],
        record_ref: { source_id: sourceId, record_id: `synthetic-label:${suffix}`, record_sha256: digest({ name, kind }) },
        observed_at: at, valid_from: "2024-01-01", valid_to: null, historical_availability: "reconstructed" }));
    }
    const source_segment_index = interval ? 1 : shared ? (featureRefs.get(feature_id)?.length ?? 0) + 1 : 1;
    originalPrimitives.set(`${feature_id}:1:${source_segment_index}`, { feature_id, start: primitiveStart, end: primitiveEnd });
    const reversed = !same(rawStart, edge._start);
    const fromFraction = interval?.start ?? 0, toFraction = interval?.end ?? 1;
    edge.source_parts.push({ feature_id, source_part_index: 1, source_segment_index, source_fraction_basis: "source_segment",
      start_fraction: reversed ? toFraction : fromFraction, end_fraction: reversed ? fromFraction : toFraction });
    if (!featureRefs.has(feature_id)) featureRefs.set(feature_id, []);
    featureRefs.get(feature_id).push(edge.id);
    return source;
  };
  const addEdge = (a, b, name, suffix, options = {}) => {
    const sorted = pointOrder(a, b) <= 0 ? [a, b] : [b, a];
    const key = sorted.map(point => point.join(",")).join("/");
    let edge = edgeByEndpoints.get(key);
    if (!edge) {
      const from = ensureNode(sorted[0]), to = ensureNode(sorted[1]);
      const geometry_ewkb = ewkb(2, sorted.map(metric));
      edge = { id: `edge:${bytesDigest(geometry_ewkb)}`, from_node_id: from.id, to_node_id: to.id,
        length_meters: Math.hypot(b[0] - a[0], b[1] - a[1]), geometry_validated: true, metric_srid: 26914,
        geometry_ewkb, geometry: { type: "LineString", coordinates: sorted.map(display) }, cell_ids: [], source_parts: [], _start: sorted[0] };
      edges.push(edge); edgeByEndpoints.set(key, edge); from.degree++; to.degree++;
      addSource(edge, a, b, name, suffix, options.shared, options.kind, options.interval);
    }
    return { edge_id: edge.id, from_node_id: ensureNode(a).id, to_node_id: ensureNode(b).id, reversed: !same(a, edge._start) };
  };
  const outerSegments = outer.slice(0, -1).map((a, i) => addEdge(a, outer[i + 1], names[i],
    (variant === "curved_north" && i >= 2 && i <= 5) || (variant === "split_north" && i >= 2 && i <= 4) ? "500" : String(i + 1),
    { shared: variant === "curved_north" && i >= 2 && i <= 5, kind: variant === "mixed_north" && i === 3 ? "watercourse" : names[i] === null ? "unknown" : "road",
      interval: variant === "split_north" && i >= 2 && i <= 4
        ? { start: [0.25, 0.375, 0.625][i - 2], end: [0.375, 0.625, 0.75][i - 2], original_start: [150, 100], original_end: [-50, 100] } : null }));
  if (variant === "split_north") {
    // The original north primitive extends outside the selected cell. Explicit
    // external source endpoints witness the two interior ordering positions;
    // all chains of that original primitive remain in the full topology.
    addEdge([150, 100], [100, 100], "North Road", "500", { interval: { start: 0, end: 0.25, original_start: [150, 100], original_end: [-50, 100] } });
    addEdge([0, 100], [-50, 100], "North Road", "500", { interval: { start: 0.75, end: 1, original_start: [150, 100], original_end: [-50, 100] } });
    addEdge([75, 100], [75, 120], "External Witness East", "888");
    addEdge([25, 100], [25, 120], "External Witness West", "889");
  }
  if (variant === "curved_north") {
    // One source part contains all four original primitives, not only the
    // first edge encountered while creating its shared descriptor.
    const source = features.find(row => row.source_object_id === "500");
    const displayGeometry = { type: "LineString", coordinates: outer.slice(2, 7).map(display) };
    source.stored_geometry_sha256 = digest(displayGeometry);
    source.source_record_hash = digest({ fixture_record: "500", displayGeometry });
    source.content_sha256 = digest({ source_key: source.source_key, source_layer: source.source_layer,
      source_object_id: source.source_object_id, name: source.name, displayGeometry });
  }
  const holeSegments = holes.map((ring, holeIndex) => ring.slice(0, -1).map((a, i) => addEdge(a, ring[i + 1], "Interior Boundary", String(100 + holeIndex * 10 + i))));
  const addCell = (rings, boundaries, interiorCount) => {
    const metricRings = rings.map(ring => ring.map(metric));
    const geometry_ewkb = ewkb(3, metricRings);
    const ringArea = ring => Math.abs(ring.slice(0, -1).reduce((sum, point, i) => sum + point[0] * ring[i + 1][1] - ring[i + 1][0] * point[1], 0) / 2);
    const cell = { id: `cell:${bytesDigest(geometry_ewkb)}`, area_m2: ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0),
      geometry_validated: true, metric_srid: 26914, geometry_ewkb, geometry: { type: "Polygon", coordinates: rings.map(ring => ring.map(display)) },
      boundary_edge_ids: [...new Set(boundaries.map(row => row.edge_id))], interior_ring_count: interiorCount };
    cells.push(cell);
    for (const id of cell.boundary_edge_ids) edges.find(edge => edge.id === id).cell_ids.push(cell.id);
    return cell;
  };
  let selected;
  if (variant === "two_cells") {
    const middle = addEdge([50, 0], [50, 100], "Internal Road", "999");
    const left = addCell([[[0, 0], [50, 0], [50, 100], [0, 100], [0, 0]]], [outerSegments[0], middle, outerSegments[4], outerSegments[5]], 0);
    const right = addCell([[[50, 0], [100, 0], [100, 100], [50, 100], [50, 0]]], [outerSegments[1], outerSegments[2], outerSegments[3], middle], 0);
    selected = [left.id, right.id];
  } else {
    const main = addCell([outer, ...holes], [...outerSegments, ...holeSegments.flat()], holes.length);
    selected = [main.id];
    holes.forEach((ring, i) => addCell([[...ring].reverse()], holeSegments[i], 0));
  }
  if (["duplicate_source", "conflicting_source"].includes(variant)) {
    const north = edges.find(edge => edge.id === outerSegments[2].edge_id);
    addSource(north, outer[2], outer[3], variant === "conflicting_source" ? "Alternative North Road" : "North Road", "888");
  }
  for (const edge of edges) delete edge._start;
  const primitives = [...originalPrimitives.values()];
  const primitiveCount = primitives.length;
  let candidatePairs = 0;
  for (let a = 0; a < primitives.length; a++) for (let b = a + 1; b < primitives.length; b++) {
    const one = primitives[a], two = primitives[b];
    if ([0, 1].every(axis => Math.min(one.start[axis], one.end[axis]) <= Math.max(two.start[axis], two.end[axis])
      && Math.min(two.start[axis], two.end[axis]) <= Math.max(one.start[axis], one.end[axis]))) candidatePairs++;
  }
  const primitiveNodes = new Map([...originalPrimitives.keys()].map(key => [key, new Set()]));
  for (const edge of edges) for (const source of edge.source_parts) {
    const key = `${source.feature_id}:${source.source_part_index}:${source.source_segment_index}`;
    primitiveNodes.get(key).add(edge.from_node_id); primitiveNodes.get(key).add(edge.to_node_id);
  }
  // The producer diagnostic counts raw UNION ALL rows, before DISTINCT:
  // two original endpoints per primitive, plus each pair-intersection witness
  // once for each of the pair's two source occurrences. In these explicitly
  // noded synthetic fixtures, shared node sets identify those pair witnesses.
  // An overlapping pair contributes its two overlap endpoints even if other
  // sources split that overlap into additional retained chains.
  let rawPointIncidenceCount = 2 * primitiveCount;
  const nodeSets = [...primitiveNodes.values()];
  for (let a = 0; a < nodeSets.length; a++) for (let b = a + 1; b < nodeSets.length; b++) {
    const shared = [...nodeSets[a]].filter(id => nodeSets[b].has(id)).length;
    rawPointIncidenceCount += 2 * Math.min(shared, 2);
  }
  const sourceReferenceCount = edges.reduce((sum, edge) => sum + edge.source_parts.length, 0);
  const originalCoordinateCount = primitiveCount + features.reduce((sum, feature) => sum + feature.source_part_count, 0);
  const topology = {
    status: "ready", topology_validated: true, topology_revision: null, topology_version: "postgis-planar-v3",
    metric_srid: 26914, display_srid: 4326, source_capture_sha256: digest({ synthetic_capture: variant }),
    linework_content_sha256: digest({ synthetic_linework: variant }),
    source_coverage: { query_coverage: "complete", provider_coverage: "unknown", historical_coverage: "unknown" },
    engine_versions: { postgis: "SYNTHETIC-NO-ENGINE", geos: "SYNTHETIC", proj: "SYNTHETIC", spatial_reference_sha256: digest(PERIMETER_FIXTURE_METRIC) },
    performed_policy: { version: "postgis-planar-v3", requested_policy_version: "synthetic-source-planar-1", metric_srid: 26914,
      snap_tolerance_meters: 0, source_attribution: "exact_original_endpoint_and_pair_intersection_witness_chains_v1", source_fraction_basis: "source_segment",
      source_fraction_interpretation: "dominant_axis_signed_order_coordinate_v1",
      source_occurrence_coverage: "complete_consecutive_witness_chain_coverage_v1",
      source_witness_budgets: "point_incidences_2S_plus_4P_chains_S_plus_4P_v1", ambiguous_source_policy: "require_original_primitive_positive_length_overlap_v1",
      supported_projection_window: [-98.5, 31, -95.5, 34.5], noding_admission_policy: "projected-primitive-bbox-v1",
      minimum_cell_area_m2: 1, geometry_repair: "none", travel_graph: "not_generated" },
    cells, edges, nodes, source_features: features, source_aliases: [],
    diagnostics: { invalid_source_count: 0, nonsimple_source_count: 0, noded_coordinate_count: edges.length * 2,
      edge_count: edges.length, cell_count: cells.length, node_count: nodes.length,
      source_reference_count: sourceReferenceCount, source_point_incidence_count: rawPointIncidenceCount,
      source_chain_count: sourceReferenceCount, invalid_source_witness_count: 0, ambiguous_source_order_count: 0, invalid_cell_count: 0,
      sliver_cell_count: 0, unattributed_edge_count: 0, uncovered_source_segment_count: 0, ambiguous_source_edge_count: 0,
      invalid_incidence_count: 0, unsupported_boundary_count: 0, overlapping_cell_count: 0,
      multisource_edge_count: edges.filter(edge => edge.source_parts.length > 1).length,
      unused_edge_count: edges.filter(edge => edge.cell_ids.length === 0).length, dangle_node_count: nodes.filter(node => node.degree === 1).length },
    noding_admission: { policy: "projected-primitive-bbox-v1", primitive_segments: primitiveCount, original_coordinates: originalCoordinateCount,
      candidate_pairs: candidatePairs, candidate_pairs_complete: true, split_pieces_upper_bound: primitiveCount + 4 * candidatePairs,
      noded_coordinates_upper_bound: originalCoordinateCount + 8 * candidatePairs, admitted: true },
    incomplete_reasons: [], source_limitations: [{ code: "synthetic_upstream_validation_not_geometry_authority", ids: ["fixture"] }],
    travel_connectivity: "not_evaluated", limits: { ...TOPOLOGY_LIMITS },
  };
  const input = {
    description_version: "perimeter-description-v1", scope: { ...ASSESSMENT_SCOPE },
    effective_date: "2024-06-30", knowledge_cutoff: "2024-07-02T00:00:00.000Z", topology,
    selected_boundary: { revision: `synthetic-selected-union:${variant}:1`,
      scope: { ...ASSESSMENT_SCOPE }, effective_date: "2024-06-30", knowledge_cutoff: "2024-07-02T00:00:00.000Z",
      topology_revision: null, source_capture_sha256: topology.source_capture_sha256,
      geometry_sha256: digest({ type: "Polygon", coordinates: [outer, ...holes].map(ring => ring.map(display)) }),
      selected_cell_ids: selected.sort(compare), validation: { valid: true, connected: true, contains_subject: true, engine: "synthetic-upstream-oracle", revision: "synthetic-validation:1" },
      exterior: { ring_id: "exterior:1", orientation: "counterclockwise", segments: outerSegments },
      interiors: holeSegments.map((segments, index) => ({ ring_id: `hole:${index + 1}`, orientation: "clockwise", segments })),
      label_anchor: { metric_srid: 26914, coordinates: metric(anchor), basis: "validated_subject_interior_point", validation_revision: "synthetic-validation:1" },
    },
    source_snapshots: [{ id: sourceId, revision: "synthetic-source:1", provider: "synthetic-replay", content_sha256: digest({ synthetic_source: "perimeter-v1" }),
      visibility: "public", scope: null, valid_from: "2024-01-01", valid_to: null, observed_at: at, historical_availability: "reconstructed" }],
    feature_bindings: featureBindings, label_records: labels, alias_decisions: [],
    policy: { version: "metric-perimeter-presentation-v1", metric_srid: 26914, side_assignment: "oriented-normal-and-anchor-v1",
      diagonal_band_degrees: 5, concavity: "review_required", alias_matching: "nfc-trim-collapse-uppercase-v1", language: "en" },
  };
  if (variant === "alias") {
    const label = labels.find(row => row.literal_name === "Old North Road");
    const alias = { normalized_alias: "OLD NORTH ROAD", corridor_key: "synthetic-north-corridor", canonical_name: "North Road", source: "reviewed", updated_at: at };
    topology.source_aliases.push(alias);
    input.alias_decisions.push(rehashPerimeterFixtureRecord({ id: "alias-decision:1", feature_id: label.feature_id,
      label_record_id: label.id, alias_row_sha256: digest(alias), matched_field: "name", matched_literal: "Old North Road", decision: "accepted",
      review_record_ref: { source_id: sourceId, record_id: "synthetic-alias-review:1", record_sha256: digest({ decision: "accepted" }) },
      source_refs: [sourceId], observed_at: at, valid_from: "2024-01-01", valid_to: null, historical_availability: "reconstructed" }));
  }
  rehashPerimeterFixture(input);
  return { input, expected: {
    exterior_length_m: outer.slice(0, -1).reduce((sum, point, i) => sum + Math.hypot(point[0] - outer[i + 1][0], point[1] - outer[i + 1][1]), 0),
    exterior_piece_count: outerSegments.length, interior_piece_count: holeSegments.flat().length,
    cardinal_summaries: { north: "North Road", east: "East Road", south: "South Road", west: "West Road" },
    metric_outer_coordinates: outer.map(metric),
  } };
}
