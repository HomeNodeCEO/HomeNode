import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createNeighborhoodPostgisLandUsePartition,
  LAND_USE_PARTITION_VERSION,
  LAND_USE_KNOWN_CATEGORIES,
  LAND_USE_PARTITION_LIMITS,
  LAND_USE_PARTITION_HARD_LIMITS,
  landUseEvidenceDigest,
  landUseGeometryDigest,
} from "../src/services/neighborhoodAssessment/postgisLandUsePartition.js";
import {
  buildNeighborhoodPostgisLandUseFixture,
  landUseFixtureFeatureContext,
  rebindLandUseFixtureFeature,
  rehashLandUseFixtureSnapshot,
} from "./fixtures/neighborhoodPostgisLandUseFixture.js";

const ALL_CATEGORIES = [...LAND_USE_KNOWN_CATEGORIES,
  "unknown_uncovered", "unknown_classification", "unknown_conflict"];

// These injected-pool tests exercise input/output contracts, not geometry math.
// The native integration suite runs the shared metric fixture through PostGIS.
// This deliberately simple projection double supplies valid 4326 EWKB only;
// neither its coordinates nor the mocked partition prove a GIS area result.
function polygonHex({ srid = 4326, includeSrid = true, points } = {}) {
  points ??= [[-97, 32], [-96.99, 32], [-96.99, 32.01], [-97, 32.01], [-97, 32]];
  const bytes = Buffer.alloc(1 + 4 + (includeSrid ? 4 : 0) + 4 + 4 + points.length * 16);
  let offset = 0;
  bytes.writeUInt8(1, offset++);
  bytes.writeUInt32LE((0x00000003 | (includeSrid ? 0x20000000 : 0)) >>> 0, offset); offset += 4;
  if (includeSrid) { bytes.writeUInt32LE(srid, offset); offset += 4; }
  bytes.writeUInt32LE(1, offset); offset += 4;
  bytes.writeUInt32LE(points.length, offset); offset += 4;
  for (const [x, y] of points) {
    bytes.writeDoubleLE(x, offset); offset += 8;
    bytes.writeDoubleLE(y, offset); offset += 8;
  }
  return bytes.toString("hex");
}
function multiHex(child = polygonHex({ includeSrid: false })) {
  const head = Buffer.alloc(13);
  head.writeUInt8(1, 0); head.writeUInt32LE(0x20000006, 1);
  head.writeUInt32LE(4326, 5); head.writeUInt32LE(1, 9);
  return head.toString("hex") + child;
}
const rawDigest = hex => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
const projectionDouble = async () => ({ rows: [{ ewkb: polygonHex() }] });
const fixture = variant => buildNeighborhoodPostgisLandUseFixture(projectionDouble, variant);

function payloadFor(input, expected) {
  const observed = input.features.filter(row => row.semantics === "observed_use"
    && !expected.zero_area_feature_ids.includes(row.id));
  const buckets = ALL_CATEGORIES.map(category => ({
    category, area_m2: expected.areas_m2[category] ?? 0,
    source_feature_ids: category.startsWith("unknown_") ? []
      : observed.filter(row => row.classification.category === category).map(row => row.id).sort(),
  }));
  for (const bucket of buckets) if (bucket.area_m2 === 0) bucket.source_feature_ids = [];
  const area = category => expected.areas_m2[category] ?? 0;
  const known = LAND_USE_KNOWN_CATEGORIES.reduce((sum, category) => sum + area(category), 0);
  return {
    boundary_area_m2: expected.boundary_area_m2,
    buckets,
    diagnostics: {
      observed_area_m2: expected.boundary_area_m2 - area("unknown_uncovered"),
      raw_observed_feature_area_sum_m2: expected.boundary_area_m2 - area("unknown_uncovered"),
      raw_known_feature_area_sum_m2: known, dissolved_known_class_area_sum_m2: known,
      classified_area_m2: known, conflict_area_m2: area("unknown_conflict"),
      unclassified_area_m2: area("unknown_classification"), uncovered_area_m2: area("unknown_uncovered"),
      partition_sum_m2: expected.boundary_area_m2, partition_union_m2: expected.boundary_area_m2,
      overlap_area_m2: 0, symmetric_difference_area_m2: 0,
      intermediate_coordinate_count: 60, intermediate_component_count: 5,
      class_pair_count: 0, reference_candidate_count: 9,
      source_reference_count: buckets.reduce((sum, row) => sum + row.source_feature_ids.length, 0),
      observed_feature_ids: observed.map(row => row.id).sort(),
    },
  };
}

function fakePool(payload, { queryHook, connectError, releaseError } = {}) {
  const calls = [];
  let connections = 0;
  let releases = 0;
  const client = {
    async query(query) {
      assert.equal(typeof query, "object", "SQL is sent as a bounded query object");
      assert.equal(typeof query.text, "string");
      assert.ok(Number.isFinite(query.query_timeout) && query.query_timeout > 0);
      const tag = /neighborhood-land-use:([a-z_-]+)/.exec(query.text)?.[1];
      assert.ok(tag, "query has an auditable kernel tag");
      calls.push({ tag, query });
      const intercepted = await queryHook?.(tag, query);
      if (intercepted !== undefined) return intercepted;
      if (tag === "versions") return { rows: [{
        postgis_version: "3.5 SYNTHETIC", geos_version: "3.13.0-SYNTHETIC", proj_version: "9.5.0",
        auth_name: "EPSG", auth_srid: 26914,
        proj4text: "+proj=utm +zone=14 +datum=NAD83 +units=m +no_defs",
        srtext: 'PROJCS["NAD83 / UTM zone 14N",UNIT["metre",1]]',
      }] };
      if (tag === "validate") return { rows: [{ boundary_valid: true, features_valid: true }] };
      if (tag === "partition") return { rows: [{ payload: structuredClone(payload),
        payload_bytes: Buffer.byteLength(JSON.stringify(payload)) }] };
      return { rows: [] };
    },
    release() { releases += 1; if (releaseError) throw releaseError; },
  };
  return {
    pool: { async connect() { connections += 1; if (connectError) throw connectError; return client; } },
    calls,
    get connections() { return connections; },
    get releases() { return releases; },
  };
}
function kernel(mock, limits) {
  return createNeighborhoodPostgisLandUsePartition(mock.pool, limits ? { limits } : undefined);
}
function assertIncomplete(result) {
  assert.equal(result.computation_status, "incomplete");
  assert.notEqual(result.report_eligibility, "ready");
  assert.ok(result.partition_revision == null);
  assert.ok(result.boundary_area_m2 == null);
  assert.ok(result.buckets == null || result.buckets.length === 0);
  assert.ok(result.incomplete_reasons.length > 0);
}
async function expectPreconnectRejection(mutate, pattern = /^invalid_neighborhood_land_use:/) {
  const { input, expected } = await fixture();
  mutate(input);
  const mock = fakePool(payloadFor(input, expected));
  await assert.rejects(async () => kernel(mock).build(input), error => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, pattern);
    return true;
  });
  assert.equal(mock.connections, 0);
  assert.equal(mock.releases, 0);
}

test("ready partition keeps the full geographic denominator and declared evidence", async () => {
  const { input, expected } = await fixture();
  const before = structuredClone(input);
  const mock = fakePool(payloadFor(input, expected));
  const result = await kernel(mock).build(input);
  assert.equal(result.result_type, "neighborhood_land_use_partition");
  assert.equal(result.partition_version, LAND_USE_PARTITION_VERSION);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.effective_date_support, "supported");
  assert.equal(result.report_eligibility, "not_assessed");
  assert.deepEqual(result.scope, input.scope);
  assert.equal(result.boundary_area_m2, 10000);
  assert.deepEqual(result.buckets.map(row => row.category), ALL_CATEGORIES);
  assert.equal(result.buckets.find(row => row.category === "one_unit").percent_of_boundary, 60);
  assert.equal(result.buckets.find(row => row.category === "unknown_uncovered").percent_of_boundary, 10);
  assert.equal(result.buckets.reduce((sum, row) => sum + row.percent_of_boundary, 0), 100);
  assert.match(result.input_sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.partition_revision);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.buckets) && Object.isFrozen(result.scope));
  assert.ok(result.provenance);
  assert.ok(!JSON.stringify(result.provenance).includes(input.boundary.geometry.ewkb), "provenance must not duplicate EWKB");
  assert.deepEqual(input, before, "caller-owned evidence is not mutated");
  assert.equal(mock.connections, 1); assert.equal(mock.releases, 1);
  assert.deepEqual(mock.calls.map(row => row.tag), ["begin", "settings", "versions", "validate", "partition", "commit"]);
});

test("duplicate and stacked source footprints remain auditable without inflating the surface partition", async () => {
  const { input, expected } = await fixture("duplicate_and_stacked");
  const payload = payloadFor(input, expected);
  payload.diagnostics.raw_observed_feature_area_sum_m2 = 11400;
  payload.diagnostics.raw_known_feature_area_sum_m2 = 11400;
  payload.diagnostics.dissolved_known_class_area_sum_m2 = 9000;
  payload.diagnostics.reference_candidate_count = 12;
  const result = await kernel(fakePool(payload)).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.boundary_area_m2, 10000);
  assert.equal(result.buckets.find(row => row.category === "one_unit").area_m2, 6000);
  assert.equal(result.buckets.find(row => row.category === "one_unit").percent_of_boundary, 60);
  assert.equal(result.diagnostics.raw_observed_feature_area_sum_m2, 11400);
  assert.equal(result.diagnostics.raw_known_feature_area_sum_m2, 11400);
  assert.equal(result.diagnostics.dissolved_known_class_area_sum_m2, 9000);
  assert.equal(result.diagnostics.same_class_overlap_excess_m2, 2400);
  assert.equal(result.diagnostics.conflict_area_m2, 0);
  assert.equal(result.diagnostics.input_feature_count, 12);
  assert.equal(result.diagnostics.input_source_record_count, 13);
  assert.equal(result.diagnostics.observed_feature_count, 12);
  assert.equal(result.diagnostics.ignored_zoning_feature_count, 0);
  const residential = result.buckets.find(row => row.category === "one_unit");
  for (const id of ["DUPLICATE-TAX-400", "STACKED-CONDO-1", "STACKED-CONDO-2"]) assert.ok(residential.source_feature_ids.includes(id));
});

test("fixture and production helpers agree on actual bytes and canonical manifest hashes", async () => {
  const { input } = await fixture();
  const source = input.source_snapshots[0];
  const { content_sha256, ...manifest } = source;
  assert.equal(landUseEvidenceDigest(manifest), content_sha256);
  assert.equal(landUseGeometryDigest(input.boundary.geometry.ewkb), rawDigest(input.boundary.geometry.ewkb));
  assert.equal(landUseEvidenceDigest(landUseFixtureFeatureContext(input.features[0])), source.records.find(row => row.source_record_id === "source:A1").context_sha256);
  assert.equal(landUseEvidenceDigest({ b: 2, a: 1 }), landUseEvidenceDigest({ a: 1, b: 2 }));
  assert.notEqual(landUseEvidenceDigest([1, 2]), landUseEvidenceDigest([2, 1]));
});

test("manifest permutation is deterministic while changes to selection or cutoff have a new identity", async () => {
  const { input, expected } = await fixture();
  const original = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(original.computation_status, "ready");
  const shuffled = structuredClone(input);
  shuffled.features.reverse(); shuffled.source_snapshots[0].records.reverse();
  const replay = await kernel(fakePool(payloadFor(shuffled, expected))).build(shuffled);
  assert.equal(replay.computation_status, "ready");
  assert.equal(replay.input_sha256, original.input_sha256);
  assert.equal(replay.partition_revision, original.partition_revision);
  const changedSelection = structuredClone(input);
  changedSelection.boundary.selection_evidence_sha256 = "a".repeat(64);
  const selectionResult = await kernel(fakePool(payloadFor(changedSelection, expected))).build(changedSelection);
  assert.equal(selectionResult.computation_status, "ready");
  assert.notEqual(selectionResult.input_sha256, original.input_sha256);
  const changedCutoff = structuredClone(input);
  changedCutoff.knowledge_cutoff = "2024-07-03T00:00:00.000Z";
  const cutoffResult = await kernel(fakePool(payloadFor(changedCutoff, expected))).build(changedCutoff);
  assert.equal(cutoffResult.computation_status, "ready");
  assert.notEqual(cutoffResult.input_sha256, original.input_sha256);
});

test("input is detached before asynchronous database work", async () => {
  const { input, expected } = await fixture();
  const baseline = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(baseline.computation_status, "ready");
  const mock = fakePool(payloadFor(input, expected), { queryHook(tag) {
    if (tag === "begin") {
      input.scope.account_id = "changed-after-start";
      input.features[0].classification.category = "commercial";
      input.source_snapshots[0].records.length = 0;
    }
  } });
  const result = await kernel(mock).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.input_sha256, baseline.input_sha256);
  assert.notEqual(result.scope.account_id, input.scope.account_id);
});

const invalidEvidenceCases = [
  ["cross-assignment source cannot be rescued by rehashing", input => {
    input.source_snapshots[0].scope.appraisal_case_id = "22222222-2222-4222-8222-222222222222";
    rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  }],
  ["foreign account in otherwise equal source scope", input => {
    input.source_snapshots[0].scope.account_id = "foreign-account";
    rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  }],
  ["altered geometry with a new byte digest still needs record closure", input => {
    input.features[0].geometry.ewkb = polygonHex({ points: [[-97, 32], [-96.98, 32], [-96.98, 32.01], [-97, 32.01], [-97, 32]] });
    input.features[0].geometry.content_sha256 = rawDigest(input.features[0].geometry.ewkb);
    rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  }],
  ["altered classification is not authenticated by the source manifest hash", input => {
    input.features[0].classification.category = "commercial";
    rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  }],
  ["two feature IDs cannot give one source record conflicting meaning", input => {
    const other = structuredClone(input.features[0]);
    other.id = "A1-conflicting-reuse"; other.classification.category = "water";
    input.features.push(other);
  }],
  ["classification cannot cite a record outside the manifest", input => {
    input.features[0].classification.evidence_refs[0].source_record_id = "not-in-manifest";
    rebindLandUseFixtureFeature(input, "A1");
  }],
  ["boundary cannot cite a missing source record", input => {
    input.boundary.source_refs[0].source_record_id = "not-in-manifest";
  }],
  ["a duplicate feature ID does not imply a duplicate footprint allowance", input => { input.features.push(structuredClone(input.features[0])); }],
  ["duplicate source record IDs are ambiguous", input => {
    input.source_snapshots[0].records.push(structuredClone(input.source_snapshots[0].records[0]));
    rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  }],
  ["unknown classification cannot retain a known category", input => {
    input.features[0].classification.status = "unknown";
    rebindLandUseFixtureFeature(input, "A1");
  }],
  ["reversed fact interval cannot assert historical support", input => {
    input.features[0].fact_validity = { valid_from: "2024-06-30", valid_to: "2024-06-29" };
    rebindLandUseFixtureFeature(input, "A1");
  }],
  ["invalid calendar dates are rejected", input => { input.effective_date = "2024-02-30"; }],
  ["competitive pockets cannot replace the geographic boundary role", input => { input.boundary.role = "competitive_population"; }],
  ["unrecognized input fields are rejected", input => { input.trust_me = true; }],
];
for (const [title, mutate] of invalidEvidenceCases) test(title, () => expectPreconnectRejection(mutate));

const invalidGeometries = [
  ["wrong SRID", () => polygonHex({ srid: 26914 })],
  ["missing root SRID", () => polygonHex({ includeSrid: false })],
  ["trailing bytes", () => polygonHex() + "00"],
  ["truncated coordinates", () => polygonHex().slice(0, -2)],
  ["unclosed ring", () => polygonHex({ points: [[-97, 32], [-96.99, 32], [-96.99, 32.01], [-97, 32.01], [-97, 32.001]] })],
  ["nonfinite coordinate", () => polygonHex({ points: [[NaN, 32], [-96.99, 32], [-96.99, 32.01], [-97, 32.01], [NaN, 32]] })],
  ["impossible point count", () => { const b = Buffer.from(polygonHex(), "hex"); b.writeUInt32LE(0xffffffff, 13); return b.toString("hex"); }],
  ["multi child foreign SRID", () => multiHex(polygonHex({ srid: 3857 }))],
  ["multi child non-polygon type", () => { const b = Buffer.from(polygonHex({ includeSrid: false }), "hex"); b.writeUInt32LE(2, 1); return multiHex(b.toString("hex")); }],
  ["EWKB Z flag", () => { const b = Buffer.from(polygonHex(), "hex"); b.writeUInt32LE(0xa0000003, 1); return b.toString("hex"); }],
];
for (const [name, geometry] of invalidGeometries) test(`invalid EWKB ${name} rejects before connecting`, () => expectPreconnectRejection(input => {
  input.boundary.geometry.ewkb = geometry();
  input.boundary.geometry.content_sha256 = rawDigest(input.boundary.geometry.ewkb);
}));

test("structurally valid MultiPolygon children without repeated SRID remain supported", async () => {
  const { input, expected } = await fixture();
  input.boundary.geometry.ewkb = multiHex();
  input.boundary.geometry.content_sha256 = rawDigest(input.boundary.geometry.ewkb);
  const result = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(result.computation_status, "ready");
});

test("PostGIS invalidity is not repaired or published as ready", async () => {
  const { input, expected } = await fixture();
  const mock = fakePool(payloadFor(input, expected), { queryHook(tag) {
    if (tag === "validate") return { rows: [{ boundary_valid: false, features_valid: true }] };
  } });
  assertIncomplete(await kernel(mock).build(input));
  assert.ok(!mock.calls.some(row => row.tag === "partition"));
  assert.ok(!mock.calls.some(row => row.tag === "commit"));
  assert.equal(mock.calls.filter(row => row.tag === "rollback").length, 1);
  assert.equal(mock.releases, 1);
});

const invalidPayloadCases = [
  ["area exceeds the full boundary denominator", payload => { payload.buckets[0].area_m2 += 1; }],
  ["negative bucket area", payload => { payload.buckets[0].area_m2 = -1; }],
  ["nonfinite bucket area", payload => { payload.buckets[0].area_m2 = NaN; }],
  ["nonpositive boundary area", payload => { payload.boundary_area_m2 = 0; }],
  ["missing bucket", payload => { payload.buckets.pop(); }],
  ["duplicated category", payload => { payload.buckets[1].category = payload.buckets[0].category; }],
  ["unknown bucket vocabulary", payload => { payload.buckets[1].category = "recreational_maybe"; }],
  ["unresolved output overlap", payload => { payload.diagnostics.overlap_area_m2 = 0.1; }],
  ["geographic partition loses area", payload => { payload.diagnostics.symmetric_difference_area_m2 = 0.1; }],
  ["foreign source feature reference", payload => { payload.buckets[0].source_feature_ids.push("foreign-feature"); }],
  ["foreign observed footprint identity", payload => { payload.diagnostics.observed_feature_ids.push("foreign-feature"); }],
];
for (const [title, mutate] of invalidPayloadCases) test(`untrusted SQL payload: ${title} fails closed`, async () => {
  const { input, expected } = await fixture();
  const payload = payloadFor(input, expected); mutate(payload);
  const mock = fakePool(payload);
  assertIncomplete(await kernel(mock).build(input));
  assert.ok(!mock.calls.some(row => row.tag === "commit"));
  assert.equal(mock.calls.filter(row => row.tag === "rollback").length, 1);
  assert.equal(mock.releases, 1);
});

test("empty current-use input is 100% uncovered with an evidenced geographic boundary", async () => {
  const { input, expected } = await fixture("empty");
  const result = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.buckets.find(row => row.category === "unknown_uncovered").percent_of_boundary, 100);
  assert.equal(result.report_eligibility, "not_assessed");
});

test("incomplete capture is not equivalent to an evidenced empty feature set", async () => {
  const { input, expected } = await fixture("empty");
  input.source_snapshots[0].state = "incomplete";
  rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  const mock = fakePool(payloadFor(input, expected));
  assertIncomplete(await kernel(mock).build(input));
  assert.equal(mock.connections, 0);
});

test("unrelated zoning historical uncertainty cannot downgrade observed current-use support", async () => {
  const { input, expected } = await fixture("zoning_overlay");
  const zoning = input.features.find(row => row.semantics === "zoning");
  zoning.fact_validity = { valid_from: null, valid_to: null };
  zoning.historical_availability = { status: "unknown", available_at: null };
  rebindLandUseFixtureFeature(input, zoning.id);
  const result = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.effective_date_support, "supported");
  assert.equal(result.buckets.find(row => row.category === "one_unit").percent_of_boundary, 60);
  assert.equal(result.diagnostics.ignored_zoning_feature_count, 1);
  assert.equal(result.diagnostics.observed_feature_count, 9);
});

test("zero-area contacts with unknown historical support cannot downgrade the clipped result", async () => {
  const { input, expected } = await fixture("zero_area_contacts");
  for (const id of expected.zero_area_feature_ids) {
    const row = input.features.find(feature => feature.id === id);
    row.fact_validity = { valid_from: null, valid_to: null };
    row.historical_availability = { status: "unknown", available_at: null };
    rebindLandUseFixtureFeature(input, id);
  }
  const result = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.effective_date_support, "supported");
  for (const row of result.buckets) for (const id of expected.zero_area_feature_ids) assert.ok(!row.source_feature_ids.includes(id));
});

test("observed housing without fact-validity support cannot imply a historical class", async () => {
  const { input, expected } = await fixture();
  const row = input.features.find(feature => feature.id === "A1");
  row.fact_validity = { valid_from: null, valid_to: null };
  rebindLandUseFixtureFeature(input, row.id);
  expected.areas_m2.one_unit = 5000; expected.areas_m2.unknown_classification = 1000;
  const payload = payloadFor(input, expected);
  payload.buckets.find(bucket => bucket.category === "one_unit").source_feature_ids = ["A2", "A3", "A4", "A5", "A6"];
  payload.buckets.find(bucket => bucket.category === "unknown_classification").source_feature_ids = ["A1"];
  payload.diagnostics.source_reference_count = 9;
  const mock = fakePool(payload);
  const result = await kernel(mock).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.effective_date_support, "unknown");
  assert.equal(result.buckets.find(bucket => bucket.category === "unknown_classification").area_m2, 1000);
  const sqlFeatures = JSON.parse(mock.calls.find(call => call.tag === "partition").query.values[1]);
  assert.equal(sqlFeatures.find(feature => feature.id === "A1").category, null,
    "the database receives an unclassified footprint, not a historically unsupported housing class");
});

test("external errors cannot impersonate branded safe failures or expose SQL details", async () => {
  const { input, expected } = await fixture();
  const secret = "private-provider-url-and-sql";
  const driverError = Object.assign(new Error(secret), { code: "XX000", reason: secret, safe: true });
  const mock = fakePool(payloadFor(input, expected), { queryHook(tag) { if (tag === "partition") throw driverError; } });
  const result = await kernel(mock).build(input);
  assertIncomplete(result);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!mock.calls.some(row => row.tag === "commit"));
  assert.equal(mock.releases, 1);
});

test("escaped internal digest errors retain their private classification after public message mutation", async () => {
  let escaped;
  try { landUseEvidenceDigest("x".repeat(LAND_USE_PARTITION_HARD_LIMITS.input_bytes + 1)); }
  catch (error) { escaped = error; }
  assert.ok(escaped instanceof Error);
  escaped.message = "synthetic-private-marker-from-mutated-error";
  escaped.reason = escaped.message;
  const { input, expected } = await fixture();
  for (const stage of ["connect", "partition"]) {
    const mock = fakePool(payloadFor(input, expected), stage === "connect" ? { connectError: escaped }
      : { queryHook(tag) { if (tag === "partition") throw escaped; } });
    const result = await kernel(mock).build(input);
    assertIncomplete(result);
    assert.deepEqual(result.incomplete_reasons, ["input_limit_exceeded"]);
    assert.ok(!JSON.stringify(result).includes(escaped.message));
    assert.equal(mock.releases, stage === "connect" ? 0 : 1);
  }
});

test("release failure after success prevents publication and remains sanitized", async () => {
  const { input, expected } = await fixture();
  const mock = fakePool(payloadFor(input, expected), { releaseError: new Error("private-release-detail") });
  const result = await kernel(mock).build(input);
  assertIncomplete(result);
  assert.ok(!JSON.stringify(result).includes("private-release-detail"));
  assert.equal(mock.releases, 1);
});

test("query failure remains primary when release also throws", async () => {
  const { input, expected } = await fixture();
  const queryHook = tag => { if (tag === "partition") throw Object.assign(new Error("private-query-detail"), { code: "57014" }); };
  const primary = await kernel(fakePool(payloadFor(input, expected), { queryHook })).build(input);
  const mock = fakePool(payloadFor(input, expected), { queryHook, releaseError: new Error("private-release-detail") });
  const result = await kernel(mock).build(input);
  assertIncomplete(result);
  assert.deepEqual(result.incomplete_reasons, primary.incomplete_reasons);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.equal(mock.releases, 1);
});

test("connect rejection is sanitized and never releases an unacquired client", async () => {
  const { input, expected } = await fixture();
  const mock = fakePool(payloadFor(input, expected), { connectError: new Error("private-connection-string") });
  const result = await kernel(mock).build(input);
  assertIncomplete(result);
  assert.ok(!JSON.stringify(result).includes("private-connection-string"));
  assert.equal(mock.connections, 1); assert.equal(mock.releases, 0); assert.equal(mock.calls.length, 0);
});

test("exported limits are frozen and default caps cannot exceed hard caps", () => {
  assert.ok(Object.isFrozen(LAND_USE_PARTITION_LIMITS));
  assert.ok(Object.isFrozen(LAND_USE_PARTITION_HARD_LIMITS));
  for (const [name, value] of Object.entries(LAND_USE_PARTITION_LIMITS)) {
    assert.ok(Number.isFinite(value) && value > 0, name);
    assert.ok(value <= LAND_USE_PARTITION_HARD_LIMITS[name], name);
  }
});

test("after-cutoff capture returns incomplete before connecting, even when its manifest hashes match", async () => {
  const { input, expected } = await fixture();
  input.source_snapshots[0].captured_at = "2024-07-03T00:00:00.000Z";
  rehashLandUseFixtureSnapshot(input.source_snapshots[0]);
  const mock = fakePool(payloadFor(input, expected));
  const result = await kernel(mock).build(input);
  assertIncomplete(result);
  assert.deepEqual(result.incomplete_reasons, ["knowledge_cutoff_exceeded"]);
  assert.equal(mock.connections, 0);
});

test("an absent declared source is not a completed empty source", async () => {
  const { input, expected } = await fixture("empty");
  input.source_snapshots.push(rehashLandUseFixtureSnapshot({
    id: "synthetic-missing-current-use-source", revision: null, scope: { ...input.scope },
    captured_at: "2024-07-01T00:00:00.000Z", state: "absent", records: [],
  }));
  const absent = fakePool(payloadFor(input, expected));
  assertIncomplete(await kernel(absent).build(input));
  assert.equal(absent.connections, 0);
  const source = input.source_snapshots.at(-1);
  source.state = "complete"; source.revision = "known-empty:1";
  rehashLandUseFixtureSnapshot(source);
  const result = await kernel(fakePool(payloadFor(input, expected))).build(input);
  assert.equal(result.computation_status, "ready");
  assert.equal(result.buckets.find(row => row.category === "unknown_uncovered").percent_of_boundary, 100);
});

for (const [title, createHex] of [
  ["unsupported projection extent", () => polygonHex({ points: [[-120, 32], [-119.99, 32], [-119.99, 32.01], [-120, 32.01], [-120, 32]] })],
  ["impossible declared ring count", () => { const b = Buffer.from(polygonHex(), "hex"); b.writeUInt32LE(0xffffffff, 9); return b.toString("hex"); }],
]) test(`${title} is bounded before database work`, async () => {
  const { input, expected } = await fixture();
  input.boundary.geometry.ewkb = createHex();
  input.boundary.geometry.content_sha256 = rawDigest(input.boundary.geometry.ewkb);
  const mock = fakePool(payloadFor(input, expected));
  assertIncomplete(await kernel(mock).build(input));
  assert.equal(mock.connections, 0);
});

for (const [limit, threshold] of [
  ["input_features", 9], ["source_records", 10], ["input_coordinates", 50], ["geometry_coordinates", 5],
]) test(`${limit} accepts its exact capacity and refuses one item beyond it`, async () => {
  const { input, expected } = await fixture();
  for (const capacity of [threshold - 1, threshold, threshold + 1]) {
    const mock = fakePool(payloadFor(input, expected));
    const result = await kernel(mock, { [limit]: capacity }).build(input);
    if (capacity < threshold) {
      assertIncomplete(result); assert.equal(mock.connections, 0);
    } else assert.equal(result.computation_status, "ready", `capacity ${capacity}`);
  }
});

test("canonical input byte cap is enforced before connect without truncating the evidence", async () => {
  const { input, expected } = await fixture();
  const serializedBytes = Buffer.byteLength(JSON.stringify(input));
  for (const capacity of [serializedBytes - 1, serializedBytes, serializedBytes + 1]) {
    const mock = fakePool(payloadFor(input, expected));
    const result = await kernel(mock, { input_bytes: capacity }).build(input);
    if (capacity < serializedBytes) {
      assertIncomplete(result); assert.equal(mock.connections, 0);
      assert.equal(result.provenance, null);
    } else assert.equal(result.computation_status, "ready", `capacity ${capacity}`);
  }
});

for (const [limit, threshold] of [
  ["intermediate_coordinates", 60], ["intermediate_components", 5],
  ["reference_candidates", 9], ["source_references", 9],
]) test(`${limit} enforces result capacity without publishing partial buckets`, async () => {
  const { input, expected } = await fixture();
  for (const capacity of [threshold - 1, threshold, threshold + 1]) {
    const mock = fakePool(payloadFor(input, expected));
    const result = await kernel(mock, { [limit]: capacity }).build(input);
    if (capacity < threshold) {
      assertIncomplete(result);
      assert.ok(!mock.calls.some(call => call.tag === "commit"));
    } else assert.equal(result.computation_status, "ready", `capacity ${capacity}`);
    assert.equal(mock.releases, 1);
  }
});

test("SQL response byte cap and complete serialized result cap are both enforced", async () => {
  const { input, expected } = await fixture();
  const payload = payloadFor(input, expected);
  for (const response of [
    { payload: null, payload_bytes: 5000 },
    { payload, payload_bytes: 5000 },
    { payload, payload_bytes: Buffer.byteLength(JSON.stringify(payload)) },
  ]) {
    const mock = fakePool(payload, { queryHook(tag) { if (tag === "partition") return { rows: [response] }; } });
    const result = await kernel(mock, { output_bytes: 4096 }).build(input);
    assertIncomplete(result);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
    assert.deepEqual(result.incomplete_reasons, ["output_limit_exceeded"]);
    assert.equal(mock.releases, 1);
  }
});

test("caller cannot raise a hard cap or lower the failure envelope below its minimum", () => {
  const mock = fakePool(null);
  for (const options of [
    { output_bytes: 4095 }, { input_features: LAND_USE_PARTITION_HARD_LIMITS.input_features + 1 },
    { input_bytes: 1.5 }, { duration_ms: -1 }, { invented_cap: 1 },
  ]) assert.throws(() => kernel(mock, options), /^TypeError: invalid_neighborhood_land_use:limits$/);
  assert.equal(mock.connections, 0);
});

test("a timed-out connection is released exactly once if the pool later resolves it", async () => {
  const { input } = await fixture("empty");
  let completeConnection;
  let releases = 0;
  let releaseError;
  const client = {
    query() { assert.fail("a late connection must never run geometry SQL"); },
    release(error) { releases += 1; releaseError = error; },
  };
  const pool = { connect: () => new Promise(resolve => { completeConnection = resolve; }) };
  const result = await createNeighborhoodPostgisLandUsePartition(pool, { limits: { connect_ms: 10 } }).build(input);
  assertIncomplete(result);
  assert.deepEqual(result.incomplete_reasons, ["connection_timeout"]);
  assert.equal(releases, 0);
  completeConnection(client);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1);
  assert.ok(releaseError instanceof Error, "late client is discarded from the pool");
});

test("accessors are not executed when the evidence graph is detached", async () => {
  const { input, expected } = await fixture();
  let invoked = 0;
  Object.defineProperty(input, "extra", { enumerable: true, get() { invoked += 1; return "private getter"; } });
  const mock = fakePool(payloadFor(input, expected));
  await assert.rejects(() => kernel(mock).build(input), /^TypeError: invalid_neighborhood_land_use:json_accessor$/);
  assert.equal(invoked, 0); assert.equal(mock.connections, 0);
});
