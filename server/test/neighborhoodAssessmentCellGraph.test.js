import assert from "node:assert/strict";
import test from "node:test";
import { selectNeighborhoodCells } from "../src/services/neighborhoodAssessment/cellGraph.js";

// Source topology is deliberately synthetic; tests assert graph invariants, not
// PostGIS validity. Grid edge endpoints stand for already-noded source vertices.
function graph(positions = [["subject", 0, 0], ["east", 1, 0]]) {
  const edges = new Map();
  const cells = positions.map(([id, x, y]) => {
    const nodes = [`${x},${y}`, `${x + 1},${y}`, `${x + 1},${y + 1}`, `${x},${y + 1}`];
    const boundary_edge_ids = nodes.map((from, i) => {
      const ends = [from, nodes[(i + 1) % nodes.length]].sort();
      const key = ends.join("/");
      if (!edges.has(key)) edges.set(key, {
        id: key, cell_ids: [], contact: "edge", geometry_validated: true,
        length_meters: 100, from_node_id: ends[0], to_node_id: ends[1],
        source_id: "synthetic-road-v1", source_segment_id: key,
        source_names: ["Example Road", "Former Road Name"], aadt: null, crossing_allowed: true,
      });
      edges.get(key).cell_ids.push(id);
      return key;
    });
    return { id, area_m2: 10000, geometry_validated: true, boundary_edge_ids,
      eligible: true, competitive_eligible: true, selection_score: 0.8 };
  });
  return { graph_version: 1, topology_revision: "fixture-v1", topology_validated: true,
    source_completeness: "complete", subject_cell_id: "subject", cells, edges: [...edges.values()] };
}

const reasons = (result) => result.incomplete_reasons.map((item) => item.code);

test("selects shared-edge cells and emits only closed source-edge perimeter chains", () => {
  const input = graph();
  const before = structuredClone(input);
  const result = selectNeighborhoodCells(input);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.selected_cell_ids, ["east", "subject"]);
  assert.equal(result.selected_area_m2, 20000);
  assert.equal(result.perimeter_chains.length, 1);
  assert.equal(result.perimeter_chains[0].closed, true);
  assert.equal(result.perimeter_chains[0].segments.length, 6);
  assert.equal(result.geometry, null);
  assert.equal(result.geometry_validity, "not_evaluated");
  const sourceIds = new Set(input.edges.map((edge) => edge.id));
  for (const segment of result.perimeter_chains[0].segments) assert.ok(sourceIds.has(segment.edge_id));
  assert.deepEqual(input, before);
});

test("keeps disconnected competitive components outside without fabricated connectors", () => {
  const result = selectNeighborhoodCells(graph([["subject", 0, 0], ["east", 1, 0], ["remote", 5, 5]]));
  assert.deepEqual(result.selected_cell_ids, ["east", "subject"]);
  assert.deepEqual(result.competitive_components, [
    { component_id: "east", cell_ids: ["east", "subject"], neighborhood_relation: "inside" },
    { component_id: "remote", cell_ids: ["remote"], neighborhood_relation: "outside" },
  ]);
  assert.deepEqual(result.deferred_cell_ids, ["remote"]);
});

test("corner contacts and plausible nearby cells never become shared-edge adjacency", () => {
  const input = graph([["subject", 0, 0], ["corner", 1, 1]]);
  input.edges.push({ id: "touch", cell_ids: ["subject", "corner"], contact: "corner", length_meters: 0 });
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.equal(result.competitive_components.length, 2);
  assert.ok(!result.perimeter_chains.flatMap((chain) => chain.segments).some((edge) => edge.edge_id === "touch"));
});

test("priority, ties, perimeter ordering and bounded selection are input-order independent", () => {
  const input = graph([["subject", 0, 0], ["west", -1, 0], ["east", 1, 0], ["north", 0, 1]]);
  input.cells.find((cell) => cell.id === "north").selection_score = 0.9;
  input.limits = { max_selected_cells: 3 };
  const first = selectNeighborhoodCells(input);
  const permuted = structuredClone(input);
  permuted.cells.reverse();
  permuted.edges.reverse();
  for (const cell of permuted.cells) cell.boundary_edge_ids.reverse();
  for (const edge of permuted.edges) { edge.cell_ids.reverse(); edge.source_names.reverse(); }
  assert.deepEqual(selectNeighborhoodCells(permuted), first);
  assert.deepEqual(first.selection_order, ["subject", "north", "east"]);
  assert.ok(reasons(first).includes("selected_cell_limit_reached"));
});

test("missing geometry/edges and open perimeters remain explicitly incomplete", () => {
  const input = graph();
  input.edges = input.edges.filter((edge) => edge.cell_ids.length !== 2);
  const result = selectNeighborhoodCells(input);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.ok(reasons(result).includes("source_edge_missing"));
  assert.ok(reasons(result).includes("selected_perimeter_edge_unavailable"));
  assert.ok(reasons(result).includes("perimeter_gap"));
  assert.ok(reasons(result).includes("perimeter_open_chain"));
  input.cells[0].geometry_validated = false;
  assert.ok(reasons(selectNeighborhoodCells(input)).includes("cell_geometry_or_edges_missing"));
});

test("unvalidated topology cannot authorize expansion or a polygon-validity claim", () => {
  const input = graph();
  input.topology_validated = false;
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.equal(result.geometry_validity, "not_evaluated");
  assert.deepEqual(reasons(result), ["topology_not_validated"]);
});

test("growth and input limits are reported instead of silently claiming full coverage", () => {
  const input = graph([["subject", 0, 0], ["east", 1, 0], ["far-east", 2, 0]]);
  input.limits = { max_growth_steps: 1 };
  const bounded = selectNeighborhoodCells(input);
  assert.equal(bounded.growth_steps, 1);
  assert.deepEqual(bounded.selected_cell_ids, ["east", "subject"]);
  assert.ok(reasons(bounded).includes("growth_work_limit_reached"));
  input.limits = { max_input_cells: 2 };
  assert.deepEqual(reasons(selectNeighborhoodCells(input)), ["input_limit_exceeded"]);
  assert.throws(() => selectNeighborhoodCells({ ...input, limits: { max_growth_steps: Infinity } }), /invalid_cell_graph_limit/);
});

test("area limits preserve the subject and do not add oversized cells", () => {
  const input = graph();
  input.limits = { max_area_m2: 15000 };
  assert.deepEqual(selectNeighborhoodCells(input).selected_cell_ids, ["subject"]);
  assert.ok(reasons(selectNeighborhoodCells(input)).includes("area_limit_reached"));
  input.limits.max_area_m2 = 5000;
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.ok(reasons(result).includes("subject_exceeds_area_limit"));
});

test("subject retention does not bypass competitive housing eligibility", () => {
  const input = graph();
  Object.assign(input.cells[0], { eligible: false, competitive_eligible: false, selection_score: null });
  const result = selectNeighborhoodCells(input);
  assert.ok(result.selected_cell_ids.includes("subject"));
  assert.deepEqual(result.competitive_components[0].cell_ids, ["east"]);
});

test("unknown traffic is distinct from measured zero and never infers crossing permission", () => {
  const input = graph();
  input.edges[0].aadt = 0;
  const segments = selectNeighborhoodCells(input).perimeter_chains.flatMap((chain) => chain.segments);
  assert.ok(segments.some((edge) => edge.aadt === 0));
  assert.ok(segments.some((edge) => edge.aadt === null));
  const shared = input.edges.find((edge) => edge.cell_ids.length === 2);
  delete shared.crossing_allowed;
  shared.aadt = null;
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.ok(reasons(result).includes("crossing_evidence_missing"));
});

test("unknown selection scores are not zero or average matches", () => {
  const input = graph();
  input.cells.find((cell) => cell.id === "east").selection_score = null;
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.ok(reasons(result).includes("selection_score_unknown"));
});

test("version and duplicate identities cannot silently produce ambiguous results", () => {
  assert.throws(() => selectNeighborhoodCells({ ...graph(), graph_version: 2 }), /invalid_cell_graph_input/);
  const input = graph();
  input.cells.push({ ...input.cells[0] });
  assert.throws(() => selectNeighborhoodCells(input), /duplicate_cell_graph_cell_id/);
});

test("a declared 30m source gap remains open until an actual creek segment closes it", () => {
  const input = graph([["subject", 0, 0]]);
  const originalEndpoint = input.edges[0].to_node_id;
  // No coordinates are snapped/extended here. Upstream nodes identify a gap
  // larger than its declared tolerance; the kernel cannot invent its missing span.
  input.edges[0].to_node_id = "source-node-30m-short";
  const incomplete = selectNeighborhoodCells(input);
  assert.equal(incomplete.status, "incomplete");
  assert.ok(reasons(incomplete).includes("perimeter_gap"));
  assert.ok(incomplete.perimeter_chains.some((chain) => !chain.closed));
  assert.equal(incomplete.perimeter_chains.flatMap((chain) => chain.segments).length, 4);
  input.topology_revision = "fixture-v2-explicit-creek";
  input.edges.push({
    id: "creek-gap", cell_ids: ["subject"], contact: "edge", length_meters: 30,
    geometry_validated: true, from_node_id: "source-node-30m-short", to_node_id: originalEndpoint,
    source_id: "official-creek-v2", source_segment_id: "creek-part-1", source_names: ["Example Creek"],
  });
  input.cells[0].boundary_edge_ids.push("creek-gap");
  const complete = selectNeighborhoodCells(input);
  assert.equal(complete.status, "ready");
  assert.equal(complete.perimeter_chains.length, 1);
  assert.equal(complete.perimeter_chains[0].closed, true);
  const creek = complete.perimeter_chains[0].segments.find((segment) => segment.edge_id === "creek-gap");
  assert.equal(creek.source_id, "official-creek-v2");
  assert.equal(complete.geometry_validity, "not_evaluated");
});

test("reversing source directions preserves semantic perimeter order and provenance", () => {
  const input = graph();
  const first = selectNeighborhoodCells(input);
  for (const edge of input.edges) [edge.from_node_id, edge.to_node_id] = [edge.to_node_id, edge.from_node_id];
  input.edges.reverse();
  const reversed = selectNeighborhoodCells(input);
  const semantic = (result) => result.perimeter_chains.map((chain) => ({
    closed: chain.closed,
    segments: chain.segments.map(({ reversed: directionFlag, ...segment }) => segment),
  }));
  assert.deepEqual(semantic(first), semantic(reversed));
  assert.deepEqual(first.selected_cell_ids, reversed.selected_cell_ids);
  for (let i = 0; i < first.perimeter_chains[0].segments.length; i += 1) {
    assert.notEqual(first.perimeter_chains[0].segments[i].reversed, reversed.perimeter_chains[0].segments[i].reversed);
  }
});

test("planar geographic policy does not manufacture a travel connection at an overpass", () => {
  const input = graph();
  const shared = input.edges.find((edge) => edge.cell_ids.length === 2);
  shared.travel_connected = false;
  shared.grade_separated = true;
  assert.deepEqual(selectNeighborhoodCells(input).selected_cell_ids, ["east", "subject"]);
  shared.crossing_allowed = false;
  const separated = selectNeighborhoodCells(input);
  assert.deepEqual(separated.selected_cell_ids, ["subject"]);
  assert.equal(separated.competitive_components.length, 2);
  assert.equal(shared.travel_connected, false);
});

test("supporting park land does not need competitive sales eligibility for geography", () => {
  const input = graph([["subject", 0, 0], ["park", 1, 0], ["industrial", 2, 0], ["remote", 3, 0]]);
  Object.assign(input.cells.find((cell) => cell.id === "park"), { competitive_eligible: false });
  Object.assign(input.cells.find((cell) => cell.id === "industrial"), { eligible: false, competitive_eligible: false });
  const result = selectNeighborhoodCells(input);
  assert.deepEqual(result.selected_cell_ids, ["park", "subject"]);
  assert.deepEqual(result.competitive_components, [
    { component_id: "remote", cell_ids: ["remote"], neighborhood_relation: "outside" },
    { component_id: "subject", cell_ids: ["subject"], neighborhood_relation: "inside" },
  ]);
});

test("oversized nested edge references are bounded without publishing ready results", () => {
  const input = graph([["subject", 0, 0]]);
  input.limits = { max_input_edges: 4 };
  input.cells[0].boundary_edge_ids = Array(9).fill("bad-edge");
  assert.deepEqual(reasons(selectNeighborhoodCells(input)), ["boundary_reference_limit_exceeded"]);
});

test("upstream truncation or unknown completeness cannot become a ready selection", () => {
  const input = graph();
  input.source_completeness = "truncated";
  const truncated = selectNeighborhoodCells(input);
  assert.equal(truncated.status, "incomplete");
  assert.ok(reasons(truncated).includes("source_snapshot_truncated"));
  assert.deepEqual(truncated.selected_cell_ids, ["east", "subject"]);
  delete input.source_completeness;
  assert.ok(reasons(selectNeighborhoodCells(input)).includes("source_completeness_unknown"));
});

test("absent, null and string neighborhood eligibility remain explicitly incomplete", () => {
  for (const unknown of [undefined, null, "true", "false"]) {
    const input = graph();
    const east = input.cells.find((cell) => cell.id === "east");
    if (unknown === undefined) delete east.eligible;
    else east.eligible = unknown;
    const result = selectNeighborhoodCells(input);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.selected_cell_ids, ["subject"]);
    assert.deepEqual(result.incomplete_reasons.find((reason) => reason.code === "cell_eligibility_unknown")?.ids, ["east"]);
  }
  const explicit = graph();
  explicit.cells.find((cell) => cell.id === "east").eligible = false;
  const result = selectNeighborhoodCells(explicit);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.selected_cell_ids, ["subject"]);
  assert.ok(!reasons(result).includes("cell_eligibility_unknown"));
});

test("unknown competitive eligibility does not silently become a known empty population", () => {
  for (const unknown of [undefined, null, "true", "false"]) {
    const input = graph();
    for (const cell of input.cells) {
      if (unknown === undefined) delete cell.competitive_eligible;
      else cell.competitive_eligible = unknown;
    }
    const result = selectNeighborhoodCells(input);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.competitive_components, []);
    assert.deepEqual(result.incomplete_reasons.find((reason) => reason.code === "competitive_eligibility_unknown")?.ids, ["east", "subject"]);
    assert.ok(result.selected_cell_ids.includes("subject"));
  }
  const explicit = graph();
  for (const cell of explicit.cells) cell.competitive_eligible = false;
  const result = selectNeighborhoodCells(explicit);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.competitive_components, []);
  assert.ok(!reasons(result).includes("competitive_eligibility_unknown"));
});
