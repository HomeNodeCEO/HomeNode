import assert from "node:assert/strict";
import test from "node:test";
import { buildCachedSourceCaptures, CACHED_SOURCE_CAPTURE_LIMITS } from "../src/services/neighborhoodAssessment/cachedSourceCaptures.js";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { buildCachedNeighborhoodInputs } from "../src/services/neighborhoodAssessment/cachedRecords.js";
import { ASSESSMENT_SCOPE, neighborhoodAssessmentFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

function capture(records = [{ record_id: "P1", data: { account_id: "P1", gla_sqft: 2000, assessed_value: null } }]) {
  return {
    upstream: { key: "parcels", id: "cached-parcels", state: records.length ? "populated" : "present_empty",
      complete: true, revision: "raw-4", content_sha256: "a".repeat(64),
      captured_at: "2026-09-01T00:00:00.000Z", visibility: "public", scope: null, row_count: records.length },
    metadata: { id: "normalized-parcels", provider: "synthetic-cached-cad", revision: "capture-1",
      valid_from: "2023-01-01", valid_to: "2024-06-30", observed_at: "2026-09-01T00:00:00.000Z",
      historical_availability: "reconstructed" },
    projection: { id: "eligible-stock", revision: "projection-1",
      definition: { selected_accounts: ["P1"], housing_type: "one_unit", effective_date: "2024-06-30" },
      input_row_count: records.length, output_record_count: records.length, complete: true },
    records,
  };
}
const build = (...captures) => buildCachedSourceCaptures({ scope: { ...ASSESSMENT_SCOPE }, captures });
const limitError = error => error.code === "NEIGHBORHOOD_CAPTURE_LIMIT" && error.state === "incomplete";

test("normalized capture uses its actual canonical payload hash, preserving upstream raw identity separately", () => {
  const result = build(capture());
  assert.equal(result.status, "ready");
  const [snapshot] = result.source_snapshots;
  const [{ payload }] = result.sources;
  assert.equal(snapshot.content_sha256, assessmentEvidenceDigest(payload));
  assert.notEqual(snapshot.content_sha256, "a".repeat(64));
  assert.equal(payload.upstream.upstream_content_sha256, "a".repeat(64));
  assert.equal(payload.upstream.revision, "raw-4");
  assert.equal(payload.upstream.visibility, "public");
  assert.equal(snapshot.visibility, "assignment", "even public-origin selected evidence is assignment-private");
  assert.deepEqual(snapshot.scope, ASSESSMENT_SCOPE);
  assert.deepEqual(payload.scope, ASSESSMENT_SCOPE);
  assert.equal(snapshot.id, `normalized-parcels:${snapshot.content_sha256}`);
  assert.deepEqual(result.references[0].record_sources, [{ record_id: "P1", source_ref: snapshot.id }]);
  assert.equal(payload.records[0].data.assessed_value, null);
});

test("all source metadata is explicit; no provider, version, validity, timestamp or history is invented", () => {
  for (const field of ["id", "provider", "revision", "valid_from", "valid_to", "observed_at", "historical_availability"]) {
    const input = capture(); delete input.metadata[field];
    assert.throws(() => build(input), undefined, field);
  }
  for (const field of ["revision", "content_sha256", "captured_at", "visibility", "scope", "complete", "row_count"]) {
    const input = capture(); delete input.upstream[field];
    assert.throws(() => build(input), undefined, field);
  }
});

test("invalid Gregorian dates, unknown historical enum and reversed validity are rejected", () => {
  for (const change of [
    input => { input.metadata.valid_from = "2024-02-31"; },
    input => { input.metadata.valid_from = "2025-01-01"; },
    input => { input.metadata.observed_at = "2026-02-31T00:00:00.000Z"; },
    input => { input.upstream.captured_at = "2026-02-31T00:00:00.000Z"; },
    input => { input.metadata.historical_availability = "current_only"; },
  ]) {
    const input = capture(); change(input); assert.throws(() => build(input));
  }
  const unknown = capture();
  Object.assign(unknown.metadata, { valid_from: null, valid_to: null, historical_availability: "unknown" });
  const result = build(unknown);
  assert.equal(result.source_snapshots[0].historical_availability, "unknown");
  assert.equal(result.source_snapshots[0].valid_from, null);
  assert.equal(result.capability_diagnostics[0].historical_availability, "unknown");
});

test("assignment-private origin requires exact organization, case, snapshot and subject identity", () => {
  const input = capture();
  Object.assign(input.upstream, { visibility: "assignment_private", scope: { ...ASSESSMENT_SCOPE } });
  assert.equal(build(input).source_snapshots[0].visibility, "assignment");
  for (const field of Object.keys(ASSESSMENT_SCOPE)) {
    const mismatched = structuredClone(input);
    mismatched.upstream.scope[field] = field === "account_id" ? "OTHER" : "90000000-0000-4000-8000-000000000009";
    assert.throws(() => build(mismatched), /scope_mismatch/);
  }
  const publicScoped = capture(); publicScoped.upstream.scope = { ...ASSESSMENT_SCOPE };
  assert.throws(() => build(publicScoped), /public_scope/);
  const privateUnscoped = structuredClone(input); privateUnscoped.upstream.scope = null;
  assert.throws(() => build(privateUnscoped));
});

test("normalized capture observation cannot be backdated before upstream acquisition to manufacture historical support", () => {
  for (const historical_availability of ["contemporaneous", "reconstructed", "unknown"]) {
    const input = capture();
    Object.assign(input.metadata, { historical_availability, observed_at: "2024-06-30T00:00:00.000Z" });
    assert.throws(() => build(input), /observed_before_upstream_capture/);
  }
  const reconstructed = capture();
  reconstructed.metadata.observed_at = "2026-09-02T00:00:00.000Z";
  const result = build(reconstructed);
  assert.equal(result.source_snapshots[0].valid_from, "2023-01-01", "fact validity remains distinct from capture observation");
  assert.equal(result.source_snapshots[0].observed_at, "2026-09-02T00:00:00.000Z");
  assert.equal(result.sources[0].payload.upstream.captured_at, "2026-09-01T00:00:00.000Z");
});

test("scope, normalized facts, projection, upstream and caller metadata all bind capture identity", () => {
  const baseline = build(capture()).source_snapshots[0].content_sha256;
  for (const change of [
    input => { input.records[0].data.gla_sqft = 2100; },
    input => { input.upstream.revision = "raw-5"; },
    input => { input.upstream.content_sha256 = "b".repeat(64); },
    input => { input.projection.definition.housing_type = "condo"; },
    input => { input.projection.revision = "projection-2"; },
    input => { input.metadata.revision = "capture-2"; },
    input => { input.metadata.provider = "different-captured-provider"; },
    input => { input.metadata.valid_from = "2022-01-01"; },
    input => { input.metadata.observed_at = "2026-09-02T00:00:00.000Z"; },
  ]) {
    const input = capture(); change(input);
    assert.notEqual(build(input).source_snapshots[0].content_sha256, baseline);
  }
  const result = buildCachedSourceCaptures({ scope: { ...ASSESSMENT_SCOPE, account_id: "OTHER" }, captures: [capture()] });
  assert.notEqual(result.source_snapshots[0].content_sha256, baseline);
});

test("record and capture order use deterministic code-unit sorting, not locale or arrival order", () => {
  const input = capture(["a", "Z", "á", "1"].map(record_id => ({ record_id, data: { b: 2, a: 1 } })));
  const extra = capture(); extra.metadata.id = "A-capture";
  const expected = build(input, extra);
  const reordered = structuredClone(input);
  reordered.records.reverse().forEach(row => { row.data = { a: 1, b: 2 }; });
  assert.deepEqual(build(extra, reordered), expected);
  assert.deepEqual(expected.sources[1].payload.records.map(row => row.record_id), ["1", "Z", "a", "á"]);
});

test("caller canonical transaction and additional-parcel evidence remain exact, including repeated raw records", () => {
  const transaction = { canonical_transaction_id: "T1", sale_date: "2024-03-01", sale_price: 500000,
    parcels: [{ account_id: "P1", allocation_verified: true, allocated_sale_price: 400000 },
      { account_id: "LOT", allocation_verified: true, allocated_sale_price: 100000 }] };
  const input = capture([{ record_id: "raw-1", data: transaction }, { record_id: "raw-2", data: transaction }]);
  const rows = build(input).sources[0].payload.records;
  assert.equal(rows.length, 2, "capture layer does not deduplicate transactions or invent canonical identities");
  assert.deepEqual(rows[0].data, transaction);
  assert.deepEqual(rows[1].data.parcels, transaction.parcels);
});

test("missing or duplicate caller record identities fail without discarding conflicting data", () => {
  const input = capture([{ record_id: "row-1", data: { sale_price: 1 } }, { record_id: "row-1", data: { sale_price: 2 } }]);
  assert.throws(() => build(input), /duplicate_record_id/);
  delete input.records[1].record_id;
  assert.throws(() => build(input), /record.record_id/);
  assert.throws(() => build(capture(), capture()), /duplicate_capture_id/);
});

test("absent sources produce explicit unavailable diagnostics and never invented usable snapshots", () => {
  const input = capture([]);
  Object.assign(input.upstream, { state: "absent", complete: false, revision: null, content_sha256: null });
  input.projection.complete = false;
  const result = build(input);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.source_snapshots, []);
  assert.deepEqual(result.references[0].source_refs, []);
  assert.ok(result.capability_diagnostics[0].reasons.includes("source_absent"));
  input.upstream.revision = "invented";
  assert.throws(() => build(input), /absent_version/);
});

test("truncated sources never become usable captures despite complete projection of the supplied partial rows", () => {
  const input = capture();
  Object.assign(input.upstream, { state: "truncated", complete: false });
  const result = build(input);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.source_snapshots, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.capability_diagnostics[0].normalized_record_count, 1);
  assert.ok(result.capability_diagnostics[0].reasons.includes("source_truncated"));
  input.upstream.complete = true;
  assert.throws(() => build(input), /state_count/);
});

test("known complete empty sources retain empty evidence, distinct from unavailable sources", () => {
  const result = build(capture([]));
  assert.equal(result.status, "ready");
  assert.equal(result.sources.length, 1);
  assert.deepEqual(result.sources[0].payload.records, []);
  assert.equal(result.sources[0].payload.upstream.state, "present_empty");
  assert.deepEqual(result.sources[0].payload.partition, { index: 0, count: 1, record_count: 0 });
});

test("populated-to-empty normalization requires explicit selection/count declarations and cannot be inferred", () => {
  const input = capture(); input.records = [];
  assert.throws(() => build(input), /projection.count_mismatch/);
  input.projection.output_record_count = 0;
  input.projection.definition = { selected_accounts: [], filter: "no selected accounts in this explicit projection" };
  const result = build(input);
  assert.equal(result.status, "ready");
  assert.equal(result.sources[0].payload.upstream.row_count, 1);
  assert.equal(result.sources[0].payload.projection.output_record_count, 0);
  assert.equal(result.sources[0].payload.upstream.state, "populated");
  delete input.projection; assert.throws(() => build(input), /projection/);
});

test("unknown or incomplete source/projection coverage is never inferred complete from row counts", () => {
  for (const field of ["upstream", "projection"]) {
    for (const complete of [null, false]) {
      const input = capture(); input[field].complete = complete;
      const result = build(input);
      assert.equal(result.status, "incomplete");
      assert.deepEqual(result.sources, []);
      assert.ok(result.capability_diagnostics[0].reasons.some(reason => reason.endsWith(complete === null ? "unknown" : "incomplete")));
    }
  }
  for (const change of [
    input => { input.projection.input_row_count = 2; },
    input => { input.projection.output_record_count = 0; },
    input => { input.projection.definition = {}; },
    input => { delete input.projection.complete; },
  ]) {
    const input = capture(); change(input); assert.throws(() => build(input));
  }
});

test("byte-bounded UTF-8 chunks preserve every row with stable content-addressed references", () => {
  const input = capture(["R3", "R1", "R2"].map(record_id => ({ record_id, data: { text: "é".repeat(400_000) } })));
  const result = build(input);
  assert.equal(result.sources.length, 3);
  const found = [];
  for (const [index, source] of result.sources.entries()) {
    const json = canonicalAssessmentJson(source.payload);
    assert.ok(Buffer.byteLength(json, "utf8") <= CACHED_SOURCE_CAPTURE_LIMITS.payload_bytes);
    assert.equal(result.source_snapshots[index].content_sha256, assessmentEvidenceDigest(source.payload));
    assert.deepEqual(source.payload.partition, { index, count: 3, record_count: 1 });
    found.push(...source.payload.records.map(row => row.record_id));
  }
  assert.deepEqual(found, ["R1", "R2", "R3"]);
  input.records.reverse();
  assert.deepEqual(build(input).source_snapshots, result.source_snapshots);
  assert.equal(result.references[0].record_sources.length, 3);
});

test("canonical JSON node bounds also partition small-byte but deeply repeated evidence", () => {
  const input = capture(Array.from({ length: 100 }, (_, index) => ({ record_id: `R${String(index).padStart(3, "0")}`,
    data: { values: Array(1200).fill(null) } })));
  const result = build(input);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources.flatMap(source => source.payload.records).length, 100);
  result.sources.forEach(source => assert.doesNotThrow(() => canonicalAssessmentJson(source.payload)));
});

test("more than one thousand records are retained, not restricted to a sales count target", () => {
  const input = capture(Array.from({ length: 1041 }, (_, index) => ({ record_id: `T${index}`, data: { sale_price: index + 1 } })));
  const result = build(input);
  assert.equal(result.sources.length, 2);
  assert.equal(result.references[0].record_sources.length, 1041);
  assert.equal(result.sources.reduce((sum, source) => sum + source.payload.records.length, 0), 1041);
});

test("oversized strings, arrays and capture counts fail with bounded controlled incomplete errors", () => {
  const enormous = capture([{ record_id: "R1", data: { text: "x".repeat(CACHED_SOURCE_CAPTURE_LIMITS.payload_bytes) } }]);
  assert.throws(() => build(enormous), limitError);
  const escaped = capture([{ record_id: "R1", data: { text: "\u0000".repeat(300_000) } }]);
  assert.throws(() => build(escaped), limitError);
  const excessive = capture(); excessive.records = Array(CACHED_SOURCE_CAPTURE_LIMITS.input_records + 1);
  assert.throws(() => build(excessive), limitError);
  assert.throws(() => buildCachedSourceCaptures({ scope: ASSESSMENT_SCOPE,
    captures: Array(CACHED_SOURCE_CAPTURE_LIMITS.input_captures + 1) }), limitError);
  const manyNodes = capture([{ record_id: "R1", data: { values: Array(100_000).fill(null) } }]);
  assert.throws(() => build(manyNodes), limitError);
});

test("lossy non-JSON values and unsafe numbers are rejected instead of hashed after silent coercion", () => {
  for (const bad of [undefined, NaN, Infinity, new Date("2024-01-01"), () => 1]) {
    assert.throws(() => build(capture([{ record_id: "R1", data: { field: bad } }])));
  }
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => build(capture([{ record_id: "R1", data: cycle }])), limitError);
});

test("owned output is deeply frozen and unaffected by later input mutation", () => {
  const input = capture(); const result = build(input);
  input.records[0].data.gla_sqft = 9999;
  input.projection.definition.housing_type = "changed";
  input.upstream.revision = "changed";
  assert.equal(result.sources[0].payload.records[0].data.gla_sqft, 2000);
  assert.equal(result.sources[0].payload.projection.definition.housing_type, "one_unit");
  assert.equal(result.sources[0].payload.upstream.revision, "raw-4");
  assert.ok(Object.isFrozen(result.sources[0].payload.records[0].data));
  assert.ok(Object.isFrozen(result.source_snapshots[0].scope));
  assert.ok(Object.isFrozen(result.references[0].record_sources));
});

test("emitted snapshots are accepted by the shared contract without changing its schema", () => {
  const result = build(capture());
  const id = result.source_snapshots[0].id;
  const fixture = JSON.parse(JSON.stringify(neighborhoodAssessmentFixture()).replaceAll("fixture-source", id));
  fixture.source_snapshots = result.source_snapshots;
  const assessment = buildNeighborhoodAssessment(fixture);
  assert.equal(assessment.source_snapshots[0].id, id);
  assert.equal(assessment.source_snapshots[0].visibility, "assignment");
});

test("bridge consumes cached adapter snapshots and explicit normalized row projections without raw-hash substitution", () => {
  const source = (id, rows) => ({ id, state: rows.length ? "populated" : "present_empty", complete: true,
    revision: "raw-1", content_sha256: "b".repeat(64), captured_at: "2026-09-01T00:00:00.000Z",
    visibility: "public", scope: null, rows });
  const cached = buildCachedNeighborhoodInputs({ scope: ASSESSMENT_SCOPE, population_id: "stock", effective_date: "2024-06-30",
    observation_period: { start_date: "2023-07-01", end_date: "2024-06-30" },
    selection: { account_ids: ["P1"], eligible_housing_types: ["one_unit"], subject_subdivision_key: "subdivision-1" },
    sources: {
      parcels: source("raw-parcels", [{ account_id: "P1", year_built: 2004, gla_sqft: 2000,
        housing_type: "one_unit", historical_support: "reconstructed", valid_from: "2023-01-01", valid_to: null }]),
      accounts: source("raw-accounts", []), transactions: source("raw-sales", []), sale_links: source("raw-links", []),
    } });
  const input = capture(cached.statistics_input.stock.map(row => ({ record_id: row.account_id, data: row })));
  input.upstream = cached.source_snapshots.find(row => row.key === "parcels");
  input.projection.input_row_count = input.upstream.row_count;
  const result = build(input);
  assert.equal(result.sources[0].payload.upstream.upstream_content_sha256, "b".repeat(64));
  assert.equal(result.sources[0].payload.records[0].data.gla_sqft, 2000);
  assert.notEqual(result.source_snapshots[0].content_sha256, cached.source_snapshots[0].content_sha256);
});
