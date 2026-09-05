import assert from "node:assert/strict";
import test from "node:test";
import { assessmentEvidenceDigest } from "../src/services/neighborhoodAssessment/contract.js";
import { GRAPH_PREPARATION_LIMITS, prepareNeighborhoodLinework } from "../src/services/neighborhoodAssessment/graphPreparation.js";

const runA = "00000000-0000-4000-8000-000000000001";
const runB = "00000000-0000-4000-8000-000000000002";
const at = "2026-09-05T00:00:00.000Z";
function feature(id = "1", coordinates = [[-96.9, 32.6], [-96.89, 32.61]]) {
  return { source_key: "tiger_primary", source_layer: "TIGER/8", source_object_id: id,
    source_record_hash: "a".repeat(64), sync_run_id: runA, source_vintage: "configured-2025",
    name: "North Road", base_name: "Road", road_class: "primary",
    repair_revision: null, original_geometry_sha256: null, geometry: { type: "LineString", coordinates } };
}
function fixture() {
  return { version: 1, capture: { id: "roads", revision: "capture-1", acquired_at: at,
    coverage: "complete", expected_feature_count: 1, query: { crs: "EPSG:4326", envelope: [-97, 32, -96, 33], layers: ["TIGER/8"] },
    source_states: [{ source_key: "tiger_primary", status: "current", last_run_id: runA }],
    origin_runs: [{ id: runA, source_key: "tiger_primary", mode: "full", status: "complete" }] },
  aliases: { revision: "aliases-1", coverage: "complete", records: [{ normalized_alias: "NORTH ROAD", corridor_key: "reviewed-road",
    canonical_name: "North Road", source: "reviewed", updated_at: at }] },
  policy: { version: "planar-preparation-1", metric_srid: 26914, snap_tolerance_meters: 0.5 }, features: [feature()] };
}
const codes = output => output.incomplete_reasons.map(row => row.code);

test("exact cached linework is prepared without claiming topology, travel access, or original geometry", () => {
  const input = fixture(), before = structuredClone(input), output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "ready_for_preprocessing");
  assert.equal(output.topology_validated, false);
  assert.equal(output.geometry_validity, "not_evaluated");
  assert.equal(output.travel_connectivity, "not_evaluated");
  assert.equal(Object.hasOwn(output, "cells"), false);
  assert.equal(Object.hasOwn(output, "edges"), false);
  assert.deepEqual(output.line_parts[0].geometry, input.features[0].geometry);
  assert.equal(output.features[0].original_geometry_sha256, null);
  assert.equal(output.features[0].source_record_hash, "a".repeat(64));
  assert.equal(output.features[0].stored_geometry_sha256, assessmentEvidenceDigest(input.features[0].geometry));
  assert.deepEqual(output.limitations.map(row => row.code), ["original_geometry_unavailable", "stored_geometry_repair_metadata_unknown"]);
  assert.deepEqual(input, before);
  input.features[0].geometry.coordinates[0][0] = -97;
  assert.equal(output.line_parts[0].geometry.coordinates[0][0], -96.9);
  assert.ok(Object.isFrozen(output.line_parts[0].geometry.coordinates[0]));
});

test("complete current state cannot conceal a running or failed origin run", () => {
  for (const status of ["running", "failed"]) {
    const input = fixture(); input.capture.origin_runs[0].status = status;
    const output = prepareNeighborhoodLinework(input);
    assert.equal(output.status, "incomplete");
    assert.ok(codes(output).includes("origin_run_not_complete"));
    assert.deepEqual(output.line_parts, []); assert.equal(output.capture_sha256, null);
  }
  for (const status of ["pending", "running", "failed"]) {
    const input = fixture(); input.capture.source_states[0].status = status;
    assert.ok(codes(prepareNeighborhoodLinework(input)).includes("source_state_not_complete"));
  }
});

test("unchanged rows from an earlier completed run survive a later completed incremental source state", () => {
  const input = fixture();
  input.capture.origin_runs.push({ id: runB, source_key: "tiger_primary", mode: "incremental", status: "complete" });
  input.capture.source_states[0].last_run_id = runB;
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "ready_for_preprocessing");
  assert.equal(output.features[0].sync_run_id, runA);
  assert.deepEqual(output.origin_runs.map(row => row.mode), ["full", "incremental"]);
});

test("missing origin/state and mismatched source identities stay incomplete, not healthy from counts", () => {
  for (const change of [input => { input.capture.origin_runs = []; }, input => { input.capture.source_states = []; },
    input => { input.capture.origin_runs[0].source_key = "different"; }, input => { input.features[0].sync_run_id = null; }]) {
    const input = fixture(); change(input);
    const output = prepareNeighborhoodLinework(input);
    assert.equal(output.status, "incomplete"); assert.deepEqual(output.line_parts, []);
  }
});

test("coverage, exact membership count and alias completeness are independent required evidence", () => {
  for (const change of [input => { input.capture.coverage = "truncated"; }, input => { input.capture.coverage = "unknown"; },
    input => { input.capture.expected_feature_count = null; }, input => { input.capture.expected_feature_count = 2; },
    input => { input.aliases.coverage = "unknown"; }, input => { input.aliases.revision = null; }]) {
    const input = fixture(); change(input);
    const output = prepareNeighborhoodLinework(input);
    assert.equal(output.status, "incomplete"); assert.equal(output.linework_content_sha256, null);
    assert.deepEqual(output.line_parts, []);
  }
  const empty = fixture(); empty.features = []; empty.capture.expected_feature_count = 0;
  assert.ok(codes(prepareNeighborhoodLinework(empty)).includes("linework_empty"));
});

test("source arrival order is deterministic; reversing/resorting line parts changes retained bytes, not semantic content", () => {
  const input = fixture();
  input.features[0].geometry = { type: "MultiLineString", coordinates: [input.features[0].geometry.coordinates, [[-96.5, 32.8], [-96.4, 32.9]]] };
  input.features.push(feature("2")); input.capture.expected_feature_count = 2;
  const first = prepareNeighborhoodLinework(input);
  input.features.reverse();
  assert.deepEqual(prepareNeighborhoodLinework(input), first);
  input.features[1].geometry.coordinates = input.features[1].geometry.coordinates.reverse().map(part => part.reverse());
  const reversed = prepareNeighborhoodLinework(input);
  assert.equal(first.linework_content_sha256, reversed.linework_content_sha256);
  assert.notEqual(first.capture_sha256, reversed.capture_sha256);
  assert.deepEqual(reversed.line_parts.filter(row => row.feature_id === reversed.features.find(row => row.source_object_id === "1").feature_id)
    .map(row => row.source_part_index), [1, 2]);
});

test("ingestion hash/run/vintage and capture context are retained separately from source semantic content", () => {
  const input = fixture(), first = prepareNeighborhoodLinework(input);
  input.capture.origin_runs[0].id = runB; input.capture.source_states[0].last_run_id = runB;
  Object.assign(input.features[0], { sync_run_id: runB, source_record_hash: "b".repeat(64), source_vintage: "configured-2026" });
  input.capture.acquired_at = "2026-09-06T00:00:00.000Z";
  input.capture.query.envelope[0] = -98;
  const next = prepareNeighborhoodLinework(input);
  assert.equal(next.linework_content_sha256, first.linework_content_sha256);
  assert.notEqual(next.capture_sha256, first.capture_sha256);
  assert.notEqual(next.query_sha256, first.query_sha256);
});

test("same-name disconnected pieces, a 30 metre gap and grade crossings never receive fabricated connectors", () => {
  const input = fixture();
  input.features = [feature("1", [[-96.9, 32.6], [-96.89, 32.6]]),
    feature("2", [[-96.88968, 32.6], [-96.88, 32.6]]),
    feature("3", [[-96.885, 32.59], [-96.885, 32.61]])];
  input.features[2].name = "Bridge Road";
  input.capture.expected_feature_count = 3;
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.line_parts.length, 3);
  assert.equal(output.features.length, 3);
  assert.equal(output.counts.coordinates, 6);
  assert.deepEqual(output.line_parts.map(row => row.geometry).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    input.features.map(row => row.geometry).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(output.topology_validated, false);
  assert.ok(output.required_next_steps.includes("gap_overlap_sliver_checks"));
});

test("aliases are evidence, not name-based geometric merging, and corrections change both manifests", () => {
  const input = fixture(); input.features.push(feature("2")); input.capture.expected_feature_count = 2;
  const first = prepareNeighborhoodLinework(input);
  assert.equal(first.features.length, 2);
  input.aliases.records[0].corridor_key = "different-corridor";
  const next = prepareNeighborhoodLinework(input);
  assert.notEqual(first.linework_content_sha256, next.linework_content_sha256);
  assert.notEqual(first.capture_sha256, next.capture_sha256);
});

test("missing/invalid geometry returns atomic incomplete without prefix linework", () => {
  for (const geometry of [null, { type: "Point", coordinates: [0, 0] }, { type: "LineString", coordinates: [[0, 0]] },
    { type: "LineString", coordinates: [[0, 0], [0, 0]] }, { type: "LineString", coordinates: [[0, 0], [181, 0]] },
    { type: "LineString", coordinates: [[0, 0], [NaN, 1]] }, { type: "LineString", coordinates: [[0, 0, 0], [1, 1, 1]] },
    { type: "LineString", coordinates: [[0, 0], , [1, 1]] }]) {
    const input = fixture(); input.features.push({ ...feature("2"), geometry }); input.capture.expected_feature_count = 2;
    const output = prepareNeighborhoodLinework(input);
    assert.equal(output.status, "incomplete"); assert.deepEqual(output.features, []); assert.deepEqual(output.line_parts, []);
  }
});

test("large allowed alias captures are hashed incrementally without enlarging the core single-object budget", () => {
  const input = fixture(), padding = "x".repeat(240);
  input.aliases.records = Array.from({ length: 1600 }, (_, index) => ({ normalized_alias: `${index}-${padding}`,
    corridor_key: padding, canonical_name: padding, source: padding, updated_at: at }));
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "ready_for_preprocessing");
  assert.equal(output.aliases.length, 1600);
  assert.ok(output.counts.retained_bytes > 1_500_000);
  assert.match(output.capture_sha256, /^[a-f0-9]{64}$/);
});

test("aggregate feature/part/coordinate/query budgets do not select an input-order prefix", () => {
  for (const change of [input => { input.features = Array(GRAPH_PREPARATION_LIMITS.features + 1).fill(null); },
    input => { input.features[0].geometry = { type: "MultiLineString", coordinates: Array(GRAPH_PREPARATION_LIMITS.parts + 1).fill(null) }; },
    input => { input.features[0].geometry.coordinates = Array(GRAPH_PREPARATION_LIMITS.coordinates + 1).fill([0, 0]); },
    input => { input.features[0].geometry.coordinates = Array(GRAPH_PREPARATION_LIMITS.coordinates_per_feature + 1).fill([0, 0]); },
    input => { input.capture.query.padding = "x".repeat(GRAPH_PREPARATION_LIMITS.query_bytes); },
    input => { input.aliases.records = Array(GRAPH_PREPARATION_LIMITS.aliases + 1).fill(null); }]) {
    const input = fixture(); change(input);
    const output = prepareNeighborhoodLinework(input);
    assert.equal(output.status, "incomplete"); assert.ok(codes(output).includes("input_limit_exceeded"));
    assert.deepEqual(output.line_parts, []); assert.equal(output.capture_sha256, null);
  }
});

test("aggregate retained byte overflow returns incomplete, never a smaller ready alias/feature prefix", () => {
  const input = fixture(), padding = "\u{1f600}".repeat(120);
  input.aliases.records = Array.from({ length: 4500 }, (_, index) => ({ normalized_alias: `${index}-${padding}`,
    corridor_key: padding, canonical_name: padding, source: padding, updated_at: at }));
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "incomplete");
  assert.ok(codes(output).includes("input_limit_exceeded"));
  assert.deepEqual(output.line_parts, []); assert.deepEqual(output.aliases, []);
  assert.equal(output.capture_sha256, null);
});

test("alias overflow stops reading later rows before allocating or inspecting the remaining projection", () => {
  const input = fixture(), padding = "\u{1f600}".repeat(120);
  input.aliases.records = Array.from({ length: 4500 }, (_, index) => ({ normalized_alias: `${index}-${padding}`,
    corridor_key: padding, canonical_name: padding, source: padding, updated_at: at }));
  let laterAliasRead = false, laterFeatureRead = false;
  Object.defineProperty(input.aliases.records.at(-1), "normalized_alias", { get() {
    laterAliasRead = true; throw new Error("Must not inspect aliases after the byte limit");
  } });
  Object.defineProperty(input.features[0], "source_record_hash", { get() {
    laterFeatureRead = true; throw new Error("Must not build feature metadata after the byte limit");
  } });
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "incomplete");
  assert.ok(codes(output).includes("input_limit_exceeded"));
  assert.equal(laterAliasRead, false); assert.equal(laterFeatureRead, false);
  assert.ok(output.counts.retained_bytes > GRAPH_PREPARATION_LIMITS.bytes);
  assert.ok(output.counts.retained_bytes < GRAPH_PREPARATION_LIMITS.bytes + 4096,
    "At most the single bounded overflow row is encoded");
  assert.deepEqual(output.aliases, []); assert.deepEqual(output.line_parts, []);
});

test("exact IDs and duplicate source identities are checked without numeric coercion or inferred defaults", () => {
  const large = fixture(); large.features[0].source_object_id = "9007199254740993";
  assert.equal(prepareNeighborhoodLinework(large).features[0].source_object_id, "9007199254740993");
  for (const change of [input => { input.features[0].source_object_id = 42; }, input => { input.capture.expected_feature_count = "1"; },
    input => { input.capture.coverage = true; }, input => { delete input.features[0].original_geometry_sha256; },
    input => { input.features.push(structuredClone(input.features[0])); input.capture.expected_feature_count = 2; },
    input => { input.aliases.records.push(structuredClone(input.aliases.records[0])); },
    input => { input.capture.origin_runs.push(structuredClone(input.capture.origin_runs[0])); }]) {
    const input = fixture(); change(input); assert.throws(() => prepareNeighborhoodLinework(input), /invalid_graph_preparation/);
  }
});

test("null ingestion evidence is labeled unknown and never substituted with a semantic hash", () => {
  const input = fixture(); input.features[0].source_record_hash = null;
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "ready_for_preprocessing");
  assert.equal(output.features[0].source_record_hash, null);
  assert.match(output.features[0].content_sha256, /^[a-f0-9]{64}$/);
  assert.ok(output.limitations.some(row => row.code === "ingestion_fingerprint_unavailable"));
});

test("complete capture requires an explicit bounded query envelope/CRS and declared source layers", () => {
  for (const change of [input => { input.capture.query = {}; }, input => { input.capture.query.crs = "EPSG:26914"; },
    input => { input.capture.query.envelope = [-96, 32, -97, 33]; }, input => { input.capture.query.envelope = [-181, 32, -97, 33]; },
    input => { input.capture.query.layers = []; }]) {
    const input = fixture(); change(input); assert.throws(() => prepareNeighborhoodLinework(input), /capture.query_envelope/);
  }
  const input = fixture(); input.features[0].source_layer = "unselected-layer";
  const output = prepareNeighborhoodLinework(input);
  assert.equal(output.status, "incomplete");
  assert.ok(codes(output).includes("feature_outside_declared_source_layers"));
  assert.deepEqual(output.line_parts, []);
});
