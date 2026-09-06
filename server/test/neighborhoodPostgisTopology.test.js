import assert from "node:assert/strict";
import test from "node:test";
import { GRAPH_PREPARATION_VERSION, prepareNeighborhoodLinework } from "../src/services/neighborhoodAssessment/graphPreparation.js";
import { createNeighborhoodPostgisTopology, neighborhoodTopologyRevision, POSTGIS_TOPOLOGY_LIMITS,
  POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES } from "../src/services/neighborhoodAssessment/postgisTopology.js";

// Mocked boundary/lifecycle tests only. These records do not prove any geometry
// operation; the separate isolated PostgreSQL suite constructs real source lines.
const run = "00000000-0000-4000-8000-000000000001", at = "2026-09-05T00:00:00.000Z";
function fixture() {
  const points = [[-96.9, 32.6], [-96.89, 32.6], [-96.89, 32.61]];
  return { version: GRAPH_PREPARATION_VERSION, capture: { id: "roads", revision: "capture-1", acquired_at: at,
    coverage: "complete", expected_feature_count: 3,
    query: { crs: "EPSG:4326", envelope: [-97, 32, -96, 33], layers: ["TIGER/8"] },
    source_inventory: [{ source_layer: 'TIGER/8', source_key: 'roads' }],
    source_states: [{ source_key: "roads", status: "current", last_run_id: run }],
    origin_runs: [{ id: run, source_key: "roads", mode: "full", status: "complete" }] },
  aliases: { revision: "aliases-1", coverage: "complete", records: [] },
  policy: { version: "source-planar-1", metric_srid: 26914, snap_tolerance_meters: 0 },
  features: points.map((point, index) => ({ source_key: "roads", source_layer: "TIGER/8", source_object_id: String(index + 1),
    source_record_hash: "a".repeat(64), sync_run_id: run, source_vintage: "2025", name: `Road ${index + 1}`, base_name: "Road",
    road_class: "primary", repair_revision: null, original_geometry_sha256: null,
    geometry: { type: "LineString", coordinates: [point, points[(index + 1) % 3]] } })) };
}
const versions = () => ({ postgis_version: "3.5.2", geos_version: "3.13.1-CAPI-1.19.2", proj_version: "9.5.1",
  auth_name: "EPSG", auth_srid: 26914, dump_segments_available: true,
  proj4text: "+proj=utm +zone=14 +datum=NAD83 +units=m +no_defs",
  srtext: 'PROJCS["NAD83 / UTM zone 14N",UNIT["metre",1,AUTHORITY["EPSG","9001"]]]' });
const id = (kind, n) => `${kind}:${String(n).padStart(64, "0")}`;
function payloads(input = fixture()) {
  const prepared = prepareNeighborhoodLinework(input), cellId = id("cell", 1), nodes = [1, 2, 3].map(n => id("node", n));
  const edges = nodes.map((from, i) => ({ id: id("edge", i + 1), from_node_id: from, to_node_id: nodes[(i + 1) % 3],
    length_meters: 100, geometry_validated: true, geometry: input.features[i].geometry, geometry_ewkb: "00", metric_srid: 26914,
    cell_ids: [cellId], source_parts: [{ feature_id: prepared.features[i].feature_id, source_part_index: 1,
      source_segment_index: 1, source_fraction_basis: "source_segment", start_fraction: 0, end_fraction: 1 }] }));
  const cell = { id: cellId, area_m2: 10000, geometry_validated: true, metric_srid: 26914, geometry_ewkb: "00",
    geometry: { type: "Polygon", coordinates: [[...input.features.map(row => row.geometry.coordinates[0]), input.features[0].geometry.coordinates[0]]] },
    boundary_edge_ids: edges.map(row => row.id), interior_ring_count: 0 };
  const diagnostics = { invalid_source_count: 0, nonsimple_source_count: 0, noded_coordinate_count: 6, edge_count: 3,
    cell_count: 1, node_count: 3, source_reference_count: 3, invalid_cell_count: 0, sliver_cell_count: 0, unattributed_edge_count: 0, uncovered_source_segment_count: 0, ambiguous_source_edge_count: 0,
    source_point_incidence_count: 12, source_chain_count: 3, invalid_source_witness_count: 0, ambiguous_source_order_count: 0,
    invalid_incidence_count: 0, unsupported_boundary_count: 0, overlapping_cell_count: 0, multisource_edge_count: 0,
    unused_edge_count: 0, dangle_node_count: 0 };
  return [{ kind: "diagnostics", id: "diagnostics", payload: diagnostics }, { kind: "cell", id: cellId, payload: cell },
    ...edges.map(payload => ({ kind: "edge", id: payload.id, payload })),
    ...nodes.map((nodeId, i) => ({ kind: "node", id: nodeId, payload: { id: nodeId, degree: 2, metric_srid: 26914,
      geometry_ewkb: "00", geometry: { type: "Point", coordinates: input.features[i].geometry.coordinates[0] } } }))];
}
function envelope(rows) {
  const sized = structuredClone(rows).map(row => ({ ...row, row_bytes: Buffer.byteLength(JSON.stringify(row.payload)) }));
  const total = String(sized.reduce((sum, row) => sum + row.row_bytes, 0));
  return sized.map(row => ({ ...row, total_bytes: total }));
}
function mock({ input = fixture(), rows = payloads(input), version = versions(), admission, fail, rollbackFails = false, mutateRecords } = {}) {
  const calls = [], released = [];
  const client = { release: error => released.push(error), async query(config) {
    const text = config.text; calls.push(config);
    const tag = /neighborhood-topology:(\w+)/.exec(text)?.[1] || text;
    if (tag === fail || (text === "ROLLBACK" && rollbackFails)) throw new Error("sensitive database detail must not leak");
    if (tag === "versions") return { rows: [version] };
    if (tag === "admission") {
      const primitives = JSON.parse(config.values[0]).reduce((sum, part) => sum + part.geometry.coordinates.length - 1, 0);
      return { rows: [admission ?? { primitive_segments: primitives, invalid_primitive_count: 0,
        candidate_pairs: Math.min(3, primitives * (primitives - 1) / 2) }] };
    }
    if (tag === "build") {
      const result = envelope(rows); mutateRecords?.(result); return { rows: result };
    }
    return { rows: [] };
  } };
  let connections = 0;
  return { input, calls, released, client, pool: { connect: async () => { connections++; return client; } }, get connections() { return connections; } };
}
const runMock = async (options, limits) => {
  const context = mock(options); const output = await createNeighborhoodPostgisTopology(context.pool, { limits }).build(context.input);
  return { ...context, output };
};
const emptyGraph = output => {
  assert.equal(output.status, "incomplete"); assert.equal(output.topology_validated, false); assert.equal(output.topology_revision, null);
  assert.deepEqual(output.cells, []); assert.deepEqual(output.edges, []); assert.deepEqual(output.nodes, []);
};

test("mocked boundary: ready requires own preparation and PostGIS query, and preserves source/projection caveats", async () => {
  const { output, calls, released } = await runMock();
  assert.equal(output.status, "ready"); assert.equal(output.topology_validated, true);
  assert.equal(output.topology_version, 'postgis-planar-v3');
  assert.equal(output.metric_srid, 26914); assert.equal(output.display_srid, 4326);
  assert.equal(output.performed_policy.snap_tolerance_meters, 0);
  assert.equal(output.performed_policy.source_fraction_basis, "source_segment");
  assert.equal(output.performed_policy.noding_admission_policy, 'projected-primitive-bbox-v1');
  assert.deepEqual(output.noding_admission, { policy: 'projected-primitive-bbox-v1', primitive_segments: 3, original_coordinates: 6,
    candidate_pairs: 3, candidate_pairs_complete: true, split_pieces_upper_bound: 15, noded_coordinates_upper_bound: 30, admitted: true });
  assert.deepEqual(output.performed_policy.supported_projection_window, [-98.5, 31, -95.5, 34.5]);
  assert.equal(output.travel_connectivity, "not_evaluated");
  assert.deepEqual(output.source_coverage, { query_coverage: "complete", provider_coverage: "unknown", historical_coverage: "unknown" });
  assert.ok(output.source_limitations.some(row => row.code === "original_geometry_unavailable"));
  assert.equal(output.source_features.length, 3); assert.equal(output.source_features[0].source_part_count, 1);
  assert.match(output.topology_revision, /^topology:[a-f0-9]{64}$/);
  assert.equal(neighborhoodTopologyRevision(output), output.topology_revision);
  assert.equal(Object.isFrozen(output.edges[0].source_parts[0]), true);
  assert.match(calls[0].text, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(calls[1].text, /SET LOCAL statement_timeout='5000ms'/);
  const query = calls.find(row => /:build/.test(row.text));
  const admissionQuery = calls.find(row => /:admission/.test(row.text));
  assert.match(admissionQuery.text, /ST_Transform/); assert.match(admissionQuery.text, /ST_DumpSegments/);
  assert.match(admissionQuery.text, /invalid_primitive_count/);
  assert.match(admissionQuery.text, /a.geom && b.geom\s+WHERE \(SELECT invalid_primitive_count FROM primitive_checks\)=0 LIMIT 4097/);
  assert.doesNotMatch(admissionQuery.text, /ST_(Node|Polygonize|Snap|Buffer|MakeLine)\s*\(/i);
  assert.ok(calls.indexOf(admissionQuery) < calls.indexOf(query));
  assert.match(query.text, /ST_Node\(/); assert.match(query.text, /ST_Polygonize\(/); assert.match(query.text, /ST_DumpSegments/);
  assert.match(query.text, /ST_Intersection\(/);
  assert.match(query.text, /source_segment_index/);
  assert.doesNotMatch(query.text, /ST_CoveredBy\(e.geom,p.geom\)|ST_DWithin|ST_Distance|ST_LineLocatePoint|ST_LineSubstring/);
  assert.doesNotMatch(query.text, /WHERE\s+ST_Length\(d\.geom\)\s*>\s*0/i,
    'original primitive occurrences must never be silently removed');
  assert.equal(output.performed_policy.source_attribution, 'exact_original_endpoint_and_pair_intersection_witness_chains_v1');
  assert.equal(output.performed_policy.source_occurrence_coverage, 'complete_consecutive_witness_chain_coverage_v1');
  assert.equal(output.performed_policy.source_fraction_interpretation, 'dominant_axis_signed_order_coordinate_v1');
  assert.equal(output.performed_policy.source_witness_budgets, 'point_incidences_2S_plus_4P_chains_S_plus_4P_v1');
  assert.match(query.text, /lead\(/i);
  assert.match(query.text, /NOT ST_Relate\(a.geom,b.geom,'1\*\*\*\*\*\*\*\*'\)/);
  assert.equal(output.performed_policy.ambiguous_source_policy, 'require_original_primitive_positive_length_overlap_v1');
  assert.doesNotMatch(query.text, /ST_(Snap|Buffer|MakeLine|Envelope|MakeEnvelope|ConvexHull|MakeValid)\s*\(/i);
  assert.doesNotMatch(query.text, /\b(CREATE|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/);
  assert.equal(JSON.parse(query.values[0]).length, 3); assert.equal(released.length, 1); assert.equal(released[0], undefined);
});

test('mocked SQL boundary: feature names remain result metadata while only hashed line parts reach PostGIS', async () => {
  const benign = await runMock();
  assert.equal(benign.output.status, 'ready');
  const input = fixture(), marker = "Road'); DROP TABLE spatial_ref_sys; --";
  input.features[0].name = marker;
  const prepared = prepareNeighborhoodLinework(input);
  assert.equal(prepared.status, 'ready_for_preprocessing');
  const expectedParts = prepared.line_parts.map(({ feature_id, source_part_index, geometry }) => ({
    feature_id, source_part_index, geometry,
  }));
  const { output, calls, connections, released } = await runMock({ input });
  assert.equal(output.status, 'ready');
  assert.equal(output.source_features.find(row => row.source_object_id === input.features[0].source_object_id)?.name, marker);
  assert.equal(connections, 1); assert.deepEqual(released, [undefined]);
  assert.deepEqual(calls.map(call => call.text), benign.calls.map(call => call.text));
  assert.deepEqual(calls.map(call => call.values), benign.calls.map(call => call.values),
    'a name change does not change the hashed source identity or the line-part parameters');
  for (const call of calls) {
    assert.equal(call.text.includes(marker), false);
    assert.equal(JSON.stringify(call.values).includes(marker), false);
  }
  const partQueries = calls.filter(call => /neighborhood-topology:(admission|build)/.test(call.text));
  assert.equal(partQueries.length, 2);
  for (const query of partQueries) {
    assert.match(query.text, /FROM jsonb_to_recordset\(\$1::jsonb\) AS p\(feature_id text,source_part_index integer,geometry jsonb\)/);
    assert.equal(query.values.length, 1); assert.equal(typeof query.values[0], 'string');
    const parts = JSON.parse(query.values[0]);
    assert.deepEqual(parts, expectedParts);
    for (const part of parts) {
      assert.deepEqual(Object.keys(part).sort(), ['feature_id', 'geometry', 'source_part_index']);
      assert.match(part.feature_id, /^[a-f0-9]{64}$/);
      assert.equal(part.source_part_index, 1);
    }
  }
});

test("no DB for incomplete source, unsupported units/snap, or reduced input budgets; caller flags cannot bypass", async () => {
  for (const [change, expected, limits] of [
    [input => { input.capture.coverage = "unknown"; }, "source_preparation_incomplete"],
    [input => { input.policy.snap_tolerance_meters = 0.05; }, "unsupported_projection_policy"],
    [input => { input.policy.metric_srid = 3857; }, "unsupported_projection_policy"],
    [input => { input.capture.query.envelope = [-100, 32, -96, 33]; }, "unsupported_projection_extent"],
    [input => { input.features[0].geometry.coordinates[0] = [-96.9, 35]; }, "unsupported_projection_extent"],
    [() => {}, "input_limit_exceeded", { input_parts: 2 }], [() => {}, "input_limit_exceeded", { input_coordinates: 5 }],
  ]) {
    const context = mock(); change(context.input); context.input.topology_validated = true;
    context.input.status = "ready";
    const output = await createNeighborhoodPostgisTopology(context.pool, { limits }).build(context.input);
    emptyGraph(output); assert.deepEqual(output.incomplete_reasons, [expected]); assert.equal(context.connections, 0);
  }
});

test("invalid projected primitive admission rejects the whole graph before any build or pair-count claim", async () => {
  const context = mock({ rows: [], admission: { primitive_segments: 3, invalid_primitive_count: 1, candidate_pairs: 0 } });
  const output = await createNeighborhoodPostgisTopology(context.pool).build(context.input);
  emptyGraph(output);
  assert.deepEqual(output.incomplete_reasons, ['invalid_source_primitive']);
  assert.equal(output.noding_admission.primitive_segments, 3);
  assert.equal(output.noding_admission.invalid_primitive_count, 1);
  assert.equal(output.noding_admission.admitted, false);
  assert.equal(output.noding_admission.candidate_pairs, null, 'an unperformed pair scan is unknown, not zero');
  assert.equal(output.noding_admission.candidate_pairs_complete, false);
  assert.equal(output.noding_admission.split_pieces_upper_bound, null);
  assert.equal(output.noding_admission.noded_coordinates_upper_bound, null);
  assert.ok(context.calls.some(call => /:admission/.test(call.text)));
  assert.ok(!context.calls.some(call => /:build/.test(call.text)));
  assert.equal(context.calls.at(-1).text, 'ROLLBACK');
});

test("projection evidence checks actual EPSG26914 metre metadata and required engine support", async () => {
  for (const change of [row => { row.auth_srid = 3857; }, row => { row.auth_name = "OTHER"; },
    row => { row.proj4text = row.proj4text.replace("+units=m", "+units=us-ft"); },
    row => { row.proj4text = row.proj4text.replace("+zone=14", "+zone=15"); },
    row => { row.srtext = 'UNIT["metre",100]'; }, row => { row.dump_segments_available = false; }]) {
    const version = versions(); change(version);
    const { output, calls } = await runMock({ version });
    emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ["unsupported_projection_policy"]);
    assert.equal(calls.some(row => /:build/.test(row.text)), false); assert.equal(calls.at(-1).text, "ROLLBACK");
  }
  const { output } = await runMock({ version: { ...versions(), geos_version: "" } });
  assert.deepEqual(output.incomplete_reasons, ["engine_version_unavailable"]);
});

test("every incomplete geometry/limit diagnostic is atomic rather than exposing a usable prefix", async () => {
  for (const [key, value, expected] of [["cell_count", 0, "no_closed_cells"], ["invalid_source_count", 1, "invalid_source_geometry"],
    ["invalid_cell_count", 1, "invalid_cell_geometry"], ["sliver_cell_count", 1, "sliver_cells"],
    ["unattributed_edge_count", 1, "unattributed_source_edges"], ["invalid_incidence_count", 1, "invalid_edge_incidence"],
    ["uncovered_source_segment_count", 1, "uncovered_source_segments"],
    ["ambiguous_source_edge_count", 1, "ambiguous_source_attribution"],
    ["invalid_source_witness_count", 1, "unsupported_source_witness"],
    ["ambiguous_source_order_count", 1, "ambiguous_source_order"],
    ["source_point_incidence_count", 19, "topology_limit_exceeded"],
    ["source_chain_count", 16, "topology_limit_exceeded"],
    ["unsupported_boundary_count", 1, "unsupported_cell_boundary"], ["overlapping_cell_count", 1, "overlapping_cells"],
    ["edge_count", 8193, "topology_limit_exceeded"], ["cell_count", 1025, "topology_limit_exceeded"],
    ["noded_coordinate_count", 32769, "topology_limit_exceeded"], ["source_reference_count", 16385, "topology_limit_exceeded"]]) {
    const rows = payloads(); rows[0].payload[key] = value;
    const { output } = await runMock({ rows }); emptyGraph(output); assert.ok(output.incomplete_reasons.includes(expected), key);
  }
});

test("dangling real linework remains diagnostic, not a fabricated boundary or travel connection", async () => {
  const rows = payloads(), node = structuredClone(rows.find(row => row.kind === "node"));
  node.id = id("node", 4); node.payload.id = node.id; node.payload.degree = 1; rows.push(node);
  const edge = structuredClone(rows.find(row => row.kind === "edge"));
  edge.id = id("edge", 4); Object.assign(edge.payload, { id: edge.id, to_node_id: node.id, cell_ids: [] }); rows.push(edge);
  rows.find(row => row.kind === "node" && row.id === edge.payload.from_node_id).payload.degree++;
  Object.assign(rows[0].payload, { edge_count: 4, node_count: 4, source_reference_count: 4, source_chain_count: 4, unused_edge_count: 1, dangle_node_count: 1 });
  const { output } = await runMock({ rows }); assert.equal(output.status, "ready");
  assert.equal(output.edges.filter(row => !row.cell_ids.length).length, 1);
  assert.equal(output.travel_connectivity, "not_evaluated");
});

test("malformed diagnostic fields, duplicate IDs, missing incidence, and invented provenance fail closed", async () => {
  for (const mutate of [rows => { delete rows[0].payload.overlapping_cell_count; },
    rows => { rows[0].payload.source_chain_count++; },
    rows => { rows[0].payload.sliver_cell_count = "0"; }, rows => { rows.push(rows[0]); },
    rows => { rows.find(row => row.kind === "edge").payload.from_node_id = id("node", 7); },
    rows => { rows.find(row => row.kind === "edge").payload.source_parts[0].feature_id = "f".repeat(64); },
    rows => { rows.find(row => row.kind === "edge").payload.source_parts[0].source_segment_index = 2; },
    rows => { delete rows.find(row => row.kind === "edge").payload.source_parts[0].source_fraction_basis; },
    rows => { rows.find(row => row.kind === "edge").payload.source_parts[0].start_fraction = -0.1; },
    rows => { rows.find(row => row.kind === "edge").payload.source_parts[0].start_fraction = 1; },
    rows => { const edge = rows.find(row => row.kind === "edge"); edge.payload.source_parts.push({ ...edge.payload.source_parts[0] }); rows[0].payload.source_reference_count++; },
    rows => { rows.find(row => row.kind === "edge").payload.cell_ids = []; },
    rows => { rows.find(row => row.kind === "node").payload.degree = 3; },
    rows => { rows.find(row => row.kind === "cell").payload.boundary_edge_ids.push(id("edge", 1)); },
    rows => { rows.find(row => row.kind === "cell").payload.geometry_validated = "true"; },
  ]) {
    const rows = payloads(); mutate(rows); const { output } = await runMock({ rows }); emptyGraph(output);
  }
});

test("row/aggregate transfer budgets refuse nulled or oversized records", async () => {
  for (const mutateRecords of [rows => { rows[0].row_bytes = 128001; }, rows => { rows[0].total_bytes = "32000001"; },
    rows => { rows[0].payload = null; }, rows => { rows[0].row_bytes = 0; }]) {
    const { output } = await runMock({ mutateRecords }); emptyGraph(output);
    assert.deepEqual(output.incomplete_reasons, ["topology_limit_exceeded"]);
  }
  for (const limits of [{ row_bytes: 20 }, { output_bytes: 20 }]) {
    const { output } = await runMock({}, limits); emptyGraph(output);
  }
  const justGraphBytes = Number(envelope(payloads())[0].total_bytes);
  const { output } = await runMock({}, { output_bytes: justGraphBytes + 200 });
  emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ["topology_limit_exceeded"], "retained source metadata shares the aggregate budget");
  const mismatched = await runMock({ mutateRecords: rows => { rows[0].total_bytes = String(Number(rows[0].total_bytes) + 1); } });
  emptyGraph(mismatched.output); assert.deepEqual(mismatched.output.incomplete_reasons, ["invalid_topology_result"]);
});

test('successful output budget includes the entire serialized envelope at its exact acceptance boundary', async () => {
  let low = 1, high = 100000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const { output } = await runMock({}, { output_bytes: middle });
    if (output.status === 'ready') {
      assert.ok(Buffer.byteLength(JSON.stringify(output)) <= middle);
      high = middle;
    } else low = middle + 1;
  }
  const { output: accepted } = await runMock({}, { output_bytes: low });
  assert.equal(accepted.status, 'ready');
  assert.ok(Buffer.byteLength(JSON.stringify(accepted)) <= low);
  const { output: rejected } = await runMock({}, { output_bytes: low - 1 });
  emptyGraph(rejected);
  assert.deepEqual(rejected.incomplete_reasons, ['topology_limit_exceeded']);
  assert.deepEqual(rejected.source_features, []);
  assert.ok(Buffer.byteLength(JSON.stringify(rejected)) <= POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES);
});

test("query failures and uncertain BEGIN roll back and release, without leaking SQL details", async () => {
  for (const fail of ["begin", "settings", "versions", "admission", "build", "commit"]) {
    const { output, calls, released } = await runMock({ fail });
    emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ["source_query_unavailable"]);
    assert.equal(calls.at(-1).text, "ROLLBACK"); assert.equal(released.length, 1);
    assert.doesNotMatch(JSON.stringify(output), /sensitive database/);
  }
  const { output, released } = await runMock({ fail: "build", rollbackFails: true });
  emptyGraph(output); assert.match(released[0].message, /rollback_failed/);
});

test("late arriving connections are released after a bounded timeout and never queried", async () => {
  let resolve; const context = mock();
  const pool = { connect: () => new Promise(done => { resolve = done; }) };
  const result = await createNeighborhoodPostgisTopology(pool, { limits: { connect_ms: 5 } }).build(fixture());
  emptyGraph(result); assert.deepEqual(result.incomplete_reasons, ["connection_timeout"]);
  resolve(context.client); await new Promise(done => setTimeout(done, 5));
  assert.equal(context.released.length, 1); assert.equal(context.calls.length, 0);
});

test("content manifest is order stable, provenance complete, and a digest is not proof of geometry", async () => {
  const rows = payloads(), first = (await runMock({ rows })).output;
  const reverse = (await runMock({ rows: [...rows].reverse() })).output;
  assert.equal(first.topology_revision, reverse.topology_revision);
  for (const mutate of [result => { result.source_features[0].name = "Changed name"; },
    result => { result.source_features[0].source_record_hash = "b".repeat(64); },
    result => { result.source_capture_sha256 = "c".repeat(64); },
    result => { result.engine_versions.geos = "different"; },
    result => { result.cells[0].area_m2++; }, result => { result.performed_policy.snap_tolerance_meters = 1; },
    result => { result.edges[0].source_parts[0].source_segment_index = 2; },
    result => { result.diagnostics.dangle_node_count++; },
    result => { result.noding_admission.candidate_pairs++; },
    result => { result.source_aliases.push({ normalized_alias: "RENAMED ROAD", canonical_name: "Road" }); },
  ]) {
    const next = structuredClone(first); mutate(next); assert.notEqual(neighborhoodTopologyRevision(next), first.topology_revision);
  }
  const next = structuredClone(first); next.topology_validated = false;
  assert.equal(neighborhoodTopologyRevision(next), first.topology_revision, "bookkeeping boolean is not geometry evidence");
  assert.throws(() => neighborhoodTopologyRevision({ ...first, source_capture_sha256: null }), /manifest/);
  assert.throws(() => neighborhoodTopologyRevision({ ...first, cells: Array(1025).fill(first.cells[0]) }), /manifest_rows/);
});

test("configuration cannot disable or exceed accepted work bounds", () => {
  for (const limits of [{ cells: 0 }, { edges: -1 }, { statement_ms: 5001 }, { unlimited: true }, { output_bytes: Infinity },
    { primitive_segments: 513 }, { candidate_pairs: 4097 }]) {
    assert.throws(() => createNeighborhoodPostgisTopology(mock().pool, { limits }), /invalid_neighborhood_topology:limits/);
  }
  assert.equal(Object.isFrozen(POSTGIS_TOPOLOGY_LIMITS), true);
  assert.throws(() => createNeighborhoodPostgisTopology({}), /invalid_neighborhood_topology:pool/);
});

test('SQL-shaped topology limits are rejected before any connection or query', () => {
  for (const limits of [{ candidate_pairs: '3);DROP TABLE spatial_ref_sys;--' },
    { statement_ms: "5000'; DROP TABLE spatial_ref_sys;--" }]) {
    const context = mock();
    assert.throws(() => createNeighborhoodPostgisTopology(context.pool, { limits }), {
      name: 'TypeError', message: 'invalid_neighborhood_topology:limits',
    });
    assert.equal(context.connections, 0);
    assert.deepEqual(context.calls, []); assert.deepEqual(context.released, []);
  }
});

test("external pool and query failures cannot spoof trusted reasons or execute error getters", async () => {
  let getterReads = 0;
  const guarded = new Error('PRIVATE DRIVER DETAIL');
  for (const key of ['message', 'code', 'topology_reason']) Object.defineProperty(guarded, key, {
    get() { getterReads++; throw new Error('PRIVATE GETTER DETAIL'); },
  });
  const opaque = new Proxy({}, { get() { getterReads++; throw new Error('PRIVATE PROXY DETAIL'); },
    getPrototypeOf() { getterReads++; throw new Error('PRIVATE PROTOTYPE DETAIL'); } });
  for (const fault of [Object.assign(new Error('PRIVATE SQL DETAIL'), { topology_reason: 'connection_timeout' }),
    { topology_reason: 'private_database_password' }, guarded, opaque, 'PRIVATE STRING DETAIL', null, undefined]) {
    for (const stage of ['connect', 'build']) {
      const context = mock();
      let pool = context.pool;
      if (stage === 'connect') pool = { async connect() { throw fault; } };
      else {
        const query = context.client.query;
        context.client.query = async config => {
          if (config.text.includes('neighborhood-topology:build')) throw fault;
          return query(config);
        };
      }
      const output = await createNeighborhoodPostgisTopology(pool).build(context.input);
      emptyGraph(output);
      assert.deepEqual(output.incomplete_reasons, ['source_query_unavailable']);
      assert.doesNotMatch(JSON.stringify(output), /PRIVATE|private_database_password/);
      assert.equal(context.released.length, stage === 'connect' ? 0 : 1);
      if (stage === 'build') assert.equal(context.calls.at(-1).text, 'ROLLBACK');
    }
  }
  assert.equal(getterReads, 0, 'classification must not inspect any externally supplied error property');
});

test("successful geometry is withheld when synchronous connection release throws or is unavailable", async () => {
  for (const releaseKind of ['throw', 'getter', 'missing', 'promise']) {
    const context = mock();
    const release = context.client.release;
    let cleanupAttempts = 0;
    const cleanup = error => {
      cleanupAttempts++; release(error);
      if (releaseKind === 'promise') return Promise.reject(new Error('PRIVATE ASYNC RELEASE DETAIL'));
      throw Object.assign(new Error('PRIVATE RELEASE DETAIL'), { topology_reason: 'private_release_password' });
    };
    if (releaseKind === 'getter') Object.defineProperty(context.client, 'release', {
      get() { cleanupAttempts++; throw new Error('PRIVATE RELEASE GETTER'); },
    });
    else context.client.release = releaseKind === 'missing' ? undefined : cleanup;
    const output = await createNeighborhoodPostgisTopology(context.pool).build(context.input);
    await new Promise(resolve => setImmediate(resolve));
    emptyGraph(output);
    assert.deepEqual(output.incomplete_reasons, ['connection_release_failed']);
    assert.equal(output.metadata_not_returned, true);
    assert.deepEqual(output.source_features, []); assert.deepEqual(output.source_aliases, []);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE|private_release_password/);
    assert.equal(context.calls.at(-1).text, '/* neighborhood-topology:commit */ COMMIT');
    assert.equal(cleanupAttempts, releaseKind === 'missing' ? 0 : 1);
    assert.equal(context.released.length, ['throw', 'promise'].includes(releaseKind) ? 1 : 0);
  }
});

test("cleanup failure preserves the primary query, geometry or private admission failure and releases only once", async () => {
  for (const scenario of ['query', 'rollback', 'admission', 'diagnostic']) {
    const rows = payloads();
    if (scenario === 'diagnostic') rows[0].payload.invalid_cell_count = 1;
    const context = mock({ rows, fail: ['query', 'rollback'].includes(scenario) ? 'build' : undefined,
      rollbackFails: scenario === 'rollback' });
    const release = context.client.release;
    context.client.release = error => {
      release(error);
      throw new Error('PRIVATE SECONDARY CLEANUP DETAIL');
    };
    const output = await createNeighborhoodPostgisTopology(context.pool,
      scenario === 'admission' ? { limits: { edges: 10 } } : {}).build(context.input);
    emptyGraph(output);
    assert.deepEqual(output.incomplete_reasons, [scenario === 'admission' ? 'pre_noding_limit_exceeded'
      : scenario === 'diagnostic' ? 'invalid_cell_geometry' : 'source_query_unavailable']);
    assert.equal(context.released.length, 1);
    if (scenario === 'rollback') assert.equal(context.released[0].message, 'neighborhood_topology_rollback_failed');
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE/);
  }
});

test("late client cleanup failures are consumed without queries, raw rejection or a second release", async () => {
  for (const asynchronous of [false, true]) {
    const context = mock();
    let resolveConnect;
    const pool = { connect: () => new Promise(resolve => { resolveConnect = resolve; }) };
    const release = context.client.release;
    context.client.release = error => {
      release(error);
      if (asynchronous) return Promise.reject(new Error('PRIVATE LATE ASYNC CLEANUP DETAIL'));
      throw new Error('PRIVATE LATE CLEANUP DETAIL');
    };
    const output = await createNeighborhoodPostgisTopology(pool, { limits: { connect_ms: 5 } }).build(context.input);
    emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ['connection_timeout']);
    resolveConnect(context.client);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.released.length, 1); assert.equal(context.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE/);
  }
});

test("a pool rejection after connection timeout is consumed without exposing its supplied reason", async () => {
  let rejectConnect;
  const pool = { connect: () => new Promise((_resolve, reject) => { rejectConnect = reject; }) };
  const output = await createNeighborhoodPostgisTopology(pool, { limits: { connect_ms: 5 } }).build(fixture());
  rejectConnect(Object.assign(new Error('PRIVATE LATE POOL DETAIL'), { topology_reason: 'private_pool_password' }));
  await new Promise(resolve => setImmediate(resolve));
  emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ['connection_timeout']);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE|private_pool_password/);
});

test('primitive admission counts internal same-part segments before connecting, never truncating sources', async () => {
  const input = fixture(); input.features = [input.features[0]]; input.capture.expected_feature_count = 1;
  input.features[0].geometry.coordinates = Array.from({ length: 514 }, (_, index) => [-96.9 + index / 100000, 32.6]);
  const context = mock({ input, rows: [] });
  const output = await createNeighborhoodPostgisTopology(context.pool).build(input);
  emptyGraph(output); assert.equal(context.connections, 0);
  assert.deepEqual(output.incomplete_reasons, ['pre_noding_limit_exceeded']);
  assert.equal(output.noding_admission.primitive_segments, 513); assert.equal(output.noding_admission.candidate_pairs, null);
  assert.equal(input.features[0].geometry.coordinates.length, 514, 'original source untouched');
  const small = mock(); const lowered = await createNeighborhoodPostgisTopology(small.pool, { limits: { primitive_segments: 2 } }).build(small.input);
  emptyGraph(lowered); assert.equal(small.connections, 0);
});

test('projected pair admission rejects dense bounded inputs before any noding and rolls back the read transaction', async () => {
  const input = fixture(), seed = input.features[0];
  input.features = Array.from({ length: 128 }, (_, index) => ({ ...structuredClone(seed), source_object_id: String(index + 1) }));
  input.capture.expected_feature_count = input.features.length;
  const context = mock({ input, rows: [], admission: { primitive_segments: 128, invalid_primitive_count: 0, candidate_pairs: 4096 } });
  const output = await createNeighborhoodPostgisTopology(context.pool).build(input);
  emptyGraph(output); assert.deepEqual(output.incomplete_reasons, ['pre_noding_limit_exceeded']);
  assert.equal(output.noding_admission.split_pieces_upper_bound, 16512);
  assert.equal(output.noding_admission.noded_coordinates_upper_bound, 33024);
  assert.equal(output.noding_admission.admitted, false); assert.equal(context.connections, 1);
  assert.equal(context.calls.some(row => /:build/.test(row.text)), false);
  assert.equal(context.calls.at(-1).text, 'ROLLBACK'); assert.equal(context.released.length, 1);
  // A stopped pair count is not a complete count or a valid upper bound.
  const truncated = await runMock({ input, rows: [], admission: { primitive_segments: 128, invalid_primitive_count: 0, candidate_pairs: 4097 } });
  emptyGraph(truncated.output); assert.equal(truncated.output.noding_admission.candidate_pairs_complete, false);
  assert.equal(truncated.output.noding_admission.split_pieces_upper_bound, null);
});

test('pair/edge/source-ref lower limits and malformed admission metadata cannot bypass the pre-noding gate', async () => {
  for (const limits of [{ candidate_pairs: 2 }, { edges: 14 }, { source_references: 14 }]) {
    const { output, calls } = await runMock({}, limits); emptyGraph(output);
    assert.deepEqual(output.incomplete_reasons, ['pre_noding_limit_exceeded']); assert.equal(calls.some(row => /:build/.test(row.text)), false);
  }
  for (const admission of [{ primitive_segments: 4, invalid_primitive_count: 0, candidate_pairs: 3 },
    { primitive_segments: 3, invalid_primitive_count: 0, candidate_pairs: -1 },
    { primitive_segments: 3, invalid_primitive_count: 0, candidate_pairs: '3' },
    { primitive_segments: 3, invalid_primitive_count: 0, candidate_pairs: '3);DROP TABLE spatial_ref_sys;--' },
    { primitive_segments: '3 UNION SELECT 1', invalid_primitive_count: 0, candidate_pairs: 3 },
    { primitive_segments: 3, invalid_primitive_count: 0, candidate_pairs: 4 },
    { primitive_segments: 3, invalid_primitive_count: 0 },
    { primitive_segments: 3, candidate_pairs: 3 },
    { primitive_segments: 3, invalid_primitive_count: 1, candidate_pairs: 1 },
    ...[-1, 4, 0.5, NaN, Infinity, '0', null].map(invalid_primitive_count => ({ primitive_segments: 3, invalid_primitive_count, candidate_pairs: 3 }))]) {
    const { output, calls, connections, released } = await runMock({ admission }); emptyGraph(output);
    assert.deepEqual(output.incomplete_reasons, ['invalid_topology_result']); assert.equal(calls.some(row => /:build/.test(row.text)), false);
    assert.deepEqual(calls.map(call => /neighborhood-topology:(\w+)/.exec(call.text)?.[1] || call.text),
      ['begin', 'settings', 'versions', 'admission', 'ROLLBACK']);
    assert.equal(connections, 1); assert.deepEqual(released, [undefined]);
  }
});

test('sparse large primitive sets are not rejected using all geographic pairs', async () => {
  const input = fixture(); input.features = [input.features[0]]; input.capture.expected_feature_count = 1;
  input.features[0].geometry.coordinates = Array.from({ length: 513 }, (_, index) => [-96.9 + index / 100000, 32.6]);
  const context = mock({ input, rows: [], admission: { primitive_segments: 512, invalid_primitive_count: 0, candidate_pairs: 511 }, fail: 'build' });
  const output = await createNeighborhoodPostgisTopology(context.pool).build(input);
  assert.equal(output.noding_admission.admitted, true); assert.equal(output.noding_admission.split_pieces_upper_bound, 2556);
  assert.equal(context.calls.some(row => /:build/.test(row.text)), true);
  assert.deepEqual(output.incomplete_reasons, ['source_query_unavailable'], 'the deliberate later mock failure, not an admission rejection');
});

test('incomplete output strips large descriptors on pre-query and post-query failures within a separate error-control budget', async () => {
  for (const stage of ['policy', 'admission', 'build']) {
    const input = fixture();
    input.aliases.records = Array.from({ length: 1000 }, (_, index) => ({ normalized_alias: `ROAD ${index}`, corridor_key: `road-${index}`,
      canonical_name: `Road ${index}`, source: 'reviewed', updated_at: at }));
    if (stage === 'policy') input.policy.snap_tolerance_meters = 0.05;
    const context = mock({ input, fail: stage === 'policy' ? undefined : stage });
    const output = await createNeighborhoodPostgisTopology(context.pool, { limits: { output_bytes: 1 } }).build(input);
    emptyGraph(output); assert.equal(output.metadata_not_returned, true);
    assert.equal(output.source_metadata_counts.aliases, 1000);
    assert.deepEqual(output.source_features, []); assert.deepEqual(output.source_aliases, []); assert.deepEqual(output.source_limitations, []);
    assert.equal(output.failure_control_budget_bytes, POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) <= POSTGIS_TOPOLOGY_ERROR_LIMIT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(output)) > 1, 'a reason uses the documented fixed control envelope, not a one-byte payload fiction');
  }
});
