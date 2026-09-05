// Selection only: upstream GIS preprocessing must node/validate cells and source
// edges. This module neither draws connectors nor proves a dissolved polygon valid.
export const CELL_GRAPH_VERSION = 1;
export const CELL_GRAPH_LIMITS = Object.freeze({
  max_input_cells: 5000,
  max_input_edges: 20000,
  max_selected_cells: 256,
  max_area_m2: 100000000,
  max_growth_steps: 5000,
});

const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 200;
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const scoreKnown = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

// Fixed cell scores are supplied by the versioned domain policy, not recomputed
// from sales dispersion here. Ties use IDs rather than input/database row order.
class Frontier {
  values = [];
  before(a, b) { return a.selection_score > b.selection_score ||
    (a.selection_score === b.selection_score && compareIds(a.id, b.id) < 0); }
  push(cell) {
    let index = this.values.push(cell) - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(cell, this.values[parent])) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = cell;
  }
  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (!this.values.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.values.length) {
      let next = index * 2 + 1;
      if (next + 1 < this.values.length && this.before(this.values[next + 1], this.values[next])) next += 1;
      if (!this.before(this.values[next], last)) break;
      this.values[index] = this.values[next];
      index = next;
    }
    this.values[index] = last;
    return first;
  }
}

function limitsFor(requested = {}) {
  const limits = { ...CELL_GRAPH_LIMITS };
  for (const [key, ceiling] of Object.entries(limits)) {
    if (requested[key] === undefined) continue;
    if (!positive(requested[key]) || requested[key] > ceiling ||
        (key !== "max_area_m2" && !Number.isSafeInteger(requested[key]))) {
      throw new Error(`invalid_cell_graph_limit:${key}`);
    }
    limits[key] = requested[key];
  }
  return limits;
}

function sourceChains(perimeter, issue) {
  const remaining = new Map(perimeter.map((edge) => [edge.id, edge]));
  const endpoints = new Map();
  for (const edge of perimeter) {
    for (const node of [edge.from_node_id, edge.to_node_id]) {
      if (!endpoints.has(node)) endpoints.set(node, []);
      endpoints.get(node).push(edge.id);
    }
  }
  for (const [node, ids] of endpoints) {
    ids.sort(compareIds);
    if (ids.length !== 2) issue(ids.length < 2 ? "perimeter_gap" : "perimeter_branch", node);
  }
  const chains = [];
  for (const first of perimeter) {
    if (!remaining.has(first.id)) continue;
    const start = [first.from_node_id, first.to_node_id].sort(compareIds)[0];
    let node = start;
    let edge = first;
    const segments = [];
    while (edge) {
      remaining.delete(edge.id);
      const next = edge.from_node_id === node ? edge.to_node_id : edge.from_node_id;
      segments.push({
        edge_id: edge.id, from_node_id: node, to_node_id: next,
        reversed: edge.from_node_id !== node,
        source_id: edge.source_id, source_segment_id: edge.source_segment_id,
        source_names: [...new Set(edge.source_names || [])].sort(compareIds),
        aadt: typeof edge.aadt === "number" && Number.isFinite(edge.aadt) && edge.aadt >= 0 ? edge.aadt : null,
      });
      node = next;
      if (node === start || endpoints.get(node)?.length !== 2) break;
      const nextId = endpoints.get(node).find((id) => remaining.has(id));
      edge = nextId ? remaining.get(nextId) : null;
    }
    const closed = node === start;
    if (!closed) issue("perimeter_open_chain", first.id);
    chains.push({ closed, segments });
  }
  return chains;
}

/**
 * Pure bounded selection of source cells. Required inputs: graph_version: 1,
 * topology_revision, topology_validated, source_completeness (complete, truncated,
 * or unknown), subject_cell_id, cells and edges.
 * Cells: id, area_m2, geometry_validated, boundary_edge_ids, eligible,
 * selection_score (0..1 or null), competitive_eligible. Edges: id, cell_ids,
 * contact: "edge"|"corner", length_meters, geometry_validated, from_node_id,
 * to_node_id, source_id, source_segment_id, optional source_names/aadt, and an
 * explicit geographic crossing_allowed decision (NOT travel connectivity).
 * Missing AADT never supplies that decision. Bridge/ramp routing belongs to a
 * separate travel graph; merely sharing a planar side does not prove access.
 * The caller must validate a dissolved geometry and subject containment later;
 * ready here means graph selection complete, NOT valid report-ready geometry.
 */
export function selectNeighborhoodCells(input) {
  if (input?.graph_version !== CELL_GRAPH_VERSION || !validId(input?.topology_revision) ||
      !validId(input?.subject_cell_id) || !Array.isArray(input?.cells) || !Array.isArray(input?.edges)) {
    throw new Error("invalid_cell_graph_input");
  }
  const limits = limitsFor(input.limits);
  const minimum = input.minimum_selection_score ?? 0;
  if (!scoreKnown(minimum)) throw new Error("invalid_cell_graph_minimum_score");
  const issues = new Map();
  const issue = (code, id = "graph") => {
    if (!issues.has(code)) issues.set(code, new Set());
    issues.get(code).add(id);
  };
  const selected = new Set([input.subject_cell_id]);
  const result = {
    graph_version: CELL_GRAPH_VERSION, topology_revision: input.topology_revision,
    status: "incomplete", geometry_validity: "not_evaluated", geometry: null,
    subject_cell_id: input.subject_cell_id, selected_cell_ids: [input.subject_cell_id],
    selected_area_m2: null, selection_order: [input.subject_cell_id],
    competitive_components: [], perimeter_chains: [], deferred_cell_ids: [],
    incomplete_reasons: [], limits, growth_steps: 0,
  };
  const finish = () => {
    result.selected_cell_ids = [...selected].sort(compareIds);
    result.incomplete_reasons = [...issues].sort(([a], [b]) => compareIds(a, b))
      .map(([code, ids]) => ({ code, ids: [...ids].sort(compareIds) }));
    result.status = issues.size ? "incomplete" : "ready";
    return result;
  };
  // Reject overlarge source snapshots without selecting an input-order prefix.
  if (input.cells.length > limits.max_input_cells || input.edges.length > limits.max_input_edges) {
    issue("input_limit_exceeded");
    return finish();
  }
  const cells = new Map();
  const edges = new Map();
  for (const [rows, index, kind] of [[input.cells, cells, "cell"], [input.edges, edges, "edge"]]) {
    for (const row of rows) {
      if (!validId(row?.id)) throw new Error(`invalid_cell_graph_${kind}_id`);
      if (index.has(row.id)) throw new Error(`duplicate_cell_graph_${kind}_id`);
      index.set(row.id, row);
    }
  }
  const subject = cells.get(input.subject_cell_id);
  if (!subject) { issue("subject_cell_missing", input.subject_cell_id); return finish(); }
  if (input.topology_validated !== true) {
    issue("topology_not_validated");
    return finish();
  }
  if (input.source_completeness === "truncated") issue("source_snapshot_truncated");
  else if (input.source_completeness !== "complete") issue("source_completeness_unknown");
  const referenceCount = input.cells.reduce((total, cell) =>
    total + (Array.isArray(cell.boundary_edge_ids) ? cell.boundary_edge_ids.length : 0), 0);
  if (referenceCount > limits.max_input_edges * 2) {
    issue("boundary_reference_limit_exceeded");
    return finish();
  }
  const validCells = new Set();
  const boundaryIds = new Map();
  for (const cell of cells.values()) {
    // Unknown policy decisions are incomplete evidence, not deliberate exclusion.
    // Still retain the subject seed and permit review of the known source cells.
    if (typeof cell.eligible !== "boolean") issue("cell_eligibility_unknown", cell.id);
    if (typeof cell.competitive_eligible !== "boolean") issue("competitive_eligibility_unknown", cell.id);
    const ids = cell.boundary_edge_ids;
    if (cell.geometry_validated !== true || !positive(cell.area_m2) ||
        !Array.isArray(ids) || !ids.length || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
      issue("cell_geometry_or_edges_missing", cell.id);
      continue;
    }
    validCells.add(cell.id);
    boundaryIds.set(cell.id, new Set(ids));
    for (const id of ids) if (!edges.has(id)) issue("source_edge_missing", id);
  }
  const validEdges = new Map();
  const adjacency = new Map([...cells.keys()].map((id) => [id, []]));
  for (const edge of [...edges.values()].sort((a, b) => compareIds(a.id, b.id))) {
    if (edge.contact === "corner") continue; // Touching at one point is never a shared side.
    const incidents = edge.cell_ids;
    if (edge.contact !== "edge" || edge.geometry_validated !== true || !positive(edge.length_meters) ||
        !validId(edge.from_node_id) || !validId(edge.to_node_id) || edge.from_node_id === edge.to_node_id ||
        !Array.isArray(incidents) || incidents.length < 1 || incidents.length > 2 || new Set(incidents).size !== incidents.length ||
        incidents.some((id) => !validCells.has(id) || !boundaryIds.get(id)?.has(edge.id))) {
      issue("source_edge_invalid_or_inconsistent", edge.id);
      continue;
    }
    if (!validId(edge.source_id) || !validId(edge.source_segment_id) ||
        (edge.source_names !== undefined && (!Array.isArray(edge.source_names) || edge.source_names.length > 32 ||
          edge.source_names.some((name) => !validId(name))))) {
      issue("edge_provenance_missing", edge.id);
      continue;
    }
    validEdges.set(edge.id, edge);
    if (incidents.length === 2) {
      if (edge.crossing_allowed !== true && edge.crossing_allowed !== false) issue("crossing_evidence_missing", edge.id);
      if (edge.crossing_allowed === true) {
        adjacency.get(incidents[0]).push(incidents[1]);
        adjacency.get(incidents[1]).push(incidents[0]);
      }
    }
  }
  for (const cell of cells.values()) {
    for (const id of boundaryIds.get(cell.id) || []) {
      if (validEdges.has(id) && !validEdges.get(id).cell_ids.includes(cell.id)) issue("cell_edge_incidence_mismatch", cell.id);
    }
  }
  if (!validCells.has(subject.id)) return finish();
  result.selected_area_m2 = subject.area_m2;
  const canSelect = (cell) => validCells.has(cell.id) && cell.eligible === true &&
    scoreKnown(cell.selection_score) && cell.selection_score >= minimum;
  for (const cell of cells.values()) {
    if (cell.eligible === true && !scoreKnown(cell.selection_score)) issue("selection_score_unknown", cell.id);
  }
  const frontier = new Frontier();
  const enqueued = new Set([subject.id]);
  const enqueueNeighbors = (id) => {
    for (const neighbor of adjacency.get(id)) {
      if (!enqueued.has(neighbor) && canSelect(cells.get(neighbor))) {
        enqueued.add(neighbor);
        frontier.push(cells.get(neighbor));
      }
    }
  };
  if (subject.area_m2 > limits.max_area_m2) issue("subject_exceeds_area_limit", subject.id);
  else enqueueNeighbors(subject.id);
  while (frontier.values.length) {
    if (result.growth_steps >= limits.max_growth_steps) { issue("growth_work_limit_reached"); break; }
    if (selected.size >= limits.max_selected_cells) { issue("selected_cell_limit_reached"); break; }
    const cell = frontier.pop();
    result.growth_steps += 1;
    if (result.selected_area_m2 + cell.area_m2 > limits.max_area_m2) {
      issue("area_limit_reached", cell.id);
      continue;
    }
    selected.add(cell.id);
    result.selection_order.push(cell.id);
    result.selected_area_m2 += cell.area_m2;
    enqueueNeighbors(cell.id);
  }
  result.deferred_cell_ids = [...cells.values()].filter((cell) => canSelect(cell) && !selected.has(cell.id))
    .map((cell) => cell.id).sort(compareIds);
  // Competitive components can be outside the descriptive neighborhood. Do not
  // create land/road connectors to force them into the selected subject region.
  const competitive = new Set([...cells.values()].filter((cell) =>
    validCells.has(cell.id) && cell.competitive_eligible === true).map((cell) => cell.id));
  for (const first of [...competitive].sort(compareIds)) {
    if (!competitive.delete(first)) continue;
    const members = [first];
    for (let index = 0; index < members.length; index += 1) {
      for (const neighbor of adjacency.get(members[index])) {
        if (competitive.delete(neighbor)) members.push(neighbor);
      }
    }
    const inside = members.filter((id) => selected.has(id)).length;
    result.competitive_components.push({
      component_id: first, cell_ids: members.sort(compareIds),
      neighborhood_relation: inside === members.length ? "inside" : inside === 0 ? "outside" : "mixed",
    });
  }
  const perimeter = [...validEdges.values()].filter((edge) => edge.cell_ids.filter((id) => selected.has(id)).length === 1);
  for (const id of selected) {
    for (const edgeId of boundaryIds.get(id)) {
      if (!validEdges.has(edgeId)) issue("selected_perimeter_edge_unavailable", edgeId);
    }
  }
  if (!perimeter.length) issue("perimeter_missing");
  result.perimeter_chains = sourceChains(perimeter, issue);
  return finish();
}
