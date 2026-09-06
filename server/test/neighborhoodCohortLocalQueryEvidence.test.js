import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareCohortLocalQueryEvidenceV1 } from "../src/services/neighborhoodAssessment/cohortEvidenceContract.js";
import { canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import {
  COHORT_LOCAL_QUERY_FIXTURE_ACCOUNTS, cohortFixtureSha256, cohortFixtureQueryHash,
  createCohortLocalQueryEvidenceFixture, makeCohortLocalQueryMetadata,
  makeCohortCanonicalBlob, makeCohortBlobFromText,
} from "./fixtures/neighborhoodCohortLocalQueryEvidenceFixture.js";

// Expectations below were authored from proposal6b3e2983 before inspecting the
// implementation. These are synthetic byte/shape tests, never native/source or
// permission tests. The full original transaction closure is deliberately absent.
const INVALID_REASONS = new Set(["invalid_input_type", "invalid_json", "noncanonical_json", "invalid_shape",
  "invalid_value", "invalid_unicode", "duplicate_blob", "missing_blob", "unused_blob", "blob_conflict",
  "digest_mismatch", "directory_mismatch", "selection_mismatch", "query_hash_mismatch"]);
const LIMIT_REASONS = new Set(["input_bytes", "input_nodes", "input_depth", "blob_limit", "blob_bytes",
  "blob_nodes", "blob_depth", "storage_limit", "account_limit", "work_limit", "authorization_preimage_limit", "output_limit"]);
const copy = value => structuredClone(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const encode = bundle => JSON.stringify(bundle);
const prepare = bundle => prepareCohortLocalQueryEvidenceV1(encode(bundle));
const sortBlobs = bundle => { bundle.blobs.sort((a, b) => compare(a.ref.content_sha256, b.ref.content_sha256)); return bundle; };
const ids = count => Array.from({ length: count }, (_, index) => `A${String(index).padStart(6, "0")}`);

function assertFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child);
}

function assertFailure(result, status = "invalid", reason) {
  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
  assert.equal(result.status, status);
  if (reason !== undefined) assert.equal(result.reason, reason);
  if (status === "invalid") assert.ok(INVALID_REASONS.has(result.reason), `unexpected invalid reason: ${result.reason}`);
  if (status === "limit_exceeded") assert.ok(LIMIT_REASONS.has(result.reason), `unexpected limit reason: ${result.reason}`);
  if (status === "unsupported") assert.ok(["unsupported_version", "unsupported_producer_profile"].includes(result.reason));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8_192);
  assertFrozen(result);
  return result;
}

function assertAccepted(fixture) {
  const result = prepareCohortLocalQueryEvidenceV1(fixture.inputJson);
  assert.deepEqual(result, { status: "syntax_valid", contract_version: 1,
    validation_scope: "retained_bytes_and_query_hashes_only", authority: "not_established", evidence: fixture.bundle });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8_010_000);
  assert.notEqual(result.evidence, fixture.bundle);
  assertFrozen(result);
  return result;
}

function changedMetadata(change, options = {}) {
  const metadata = makeCohortLocalQueryMetadata();
  change(metadata);
  return createCohortLocalQueryEvidenceFixture({ metadata, ...options });
}

function appendBlob(fixture, blob, copies = 1) {
  const bundle = copy(fixture.bundle);
  for (let index = 0; index < copies; index++) bundle.blobs.push(copy(blob));
  return sortBlobs(bundle);
}

// Replace a reachable metadata blob and its containing preimage, retaining the
// original query hash so malformed text cannot be hidden by an unrelated route.
function replaceMetadataText(fixture, text) {
  const bundle = copy(fixture.bundle);
  const replacement = makeCohortBlobFromText(text);
  const preimage = copy(fixture.preimage);
  preimage.compact_metadata = copy(replacement.ref);
  const newPreimage = makeCohortCanonicalBlob(preimage);
  bundle.blobs = bundle.blobs.filter(blob => ![fixture.refs.metadata.content_sha256,
    fixture.refs.preimage.content_sha256].includes(blob.ref.content_sha256));
  bundle.blobs.push(replacement, newPreimage);
  bundle.query_preimage = copy(newPreimage.ref);
  return sortBlobs(bundle);
}

function futureAtBytes(size, character = "x") {
  const object = { version: 2, padding: "" };
  const room = size - Buffer.byteLength(JSON.stringify(object));
  const width = Buffer.byteLength(character);
  object.padding = character.repeat(Math.floor(room / width)) + "x".repeat(room % width);
  const text = JSON.stringify(object);
  assert.equal(Buffer.byteLength(text), size);
  return text;
}

function nestedAtDepth(depth) {
  let value = null;
  for (let index = 1; index < depth; index++) value = { nested: value };
  return { version: 2, value };
}

test("positive synthetic baseline preserves both exact hashes and the unchanged full evidence bundle", () => {
  const fixture = createCohortLocalQueryEvidenceFixture({ pageSize: 2 });
  const result = assertAccepted(fixture);
  assert.deepEqual(fixture.accountIds, ["000123", "R-001", "r-001"]);
  const authorizationText = canonicalAssessmentJson({ scope: fixture.metadata.scope,
    effective_date: "2024-06-30", selection: fixture.metadata.authorization.selection,
    account_ids: ["000123", "R-001", "r-001"] });
  const authorization = createHash("sha256").update(authorizationText, "utf8").digest("hex");
  const queryText = canonicalAssessmentJson(fixture.metadata) + '"000123"\n"R-001"\n"r-001"\n';
  const query = createHash("sha256").update(queryText, "utf8").digest("hex");
  assert.equal(fixture.metadata.authorization.selection_sha256, authorization);
  assert.equal(fixture.bundle.captured_query_selection_sha256, query);
  assert.notEqual(query, authorization);
  assert.notEqual(query, fixture.bundle.query_preimage.content_sha256);
  assert.equal(result.evidence.blobs.length, 5);
  for (const blob of result.evidence.blobs) {
    assert.equal(blob.ref.content_sha256, cohortFixtureSha256(blob.canonical_json));
    assert.equal(blob.ref.canonical_utf8_bytes, String(Buffer.byteLength(blob.canonical_json)));
  }
});

test("fixture instances and admitted evidence are detached, immutable, structure-only and free of clock assumptions", () => {
  const first = createCohortLocalQueryEvidenceFixture();
  const second = createCohortLocalQueryEvidenceFixture();
  const result = assertAccepted(first);
  first.bundle.blobs[0].canonical_json = "changed";
  first.metadata.scope.account_id = "changed";
  assert.notEqual(second.bundle.blobs[0].canonical_json, "changed");
  assert.deepEqual(result.evidence, second.bundle);
  assert.throws(() => { result.evidence.blobs[0].canonical_json = "changed"; }, TypeError);
  assert.equal(result.authority, "not_established", "synthetic license/target claims are not real grants");
  assert.ok(!("source_verified" in result));
  assertAccepted(changedMetadata(metadata => { metadata.capture_observed_at = "2099-12-31T23:59:59.999999Z"; }));
});

test("Custom positive-bigint and UAD UUID targets preserve their discriminated original identities", () => {
  assertAccepted(createCohortLocalQueryEvidenceFixture({ metadata: makeCohortLocalQueryMetadata({ workflowType: "uad_3_6" }) }));
  assertAccepted(changedMetadata(metadata => { metadata.authorization.target.workflow_target_id = "9223372036854775807"; }));
  for (const [workflow, id] of [["custom_appraisal", "50000000-0000-4000-8000-000000000005"], ["uad_3_6", "42"],
    ["custom_appraisal", "0"], ["custom_appraisal", "01"], ["custom_appraisal", "9223372036854775808"], ["custom_appraisal", 42]]) {
    const fixture = changedMetadata(metadata => { Object.assign(metadata.authorization.target, { workflow_type: workflow, workflow_target_id: id }); });
    assertFailure(prepare(fixture.bundle));
  }
});

test("source reference whitespace and UTF-16 limits are not replaced with opaque200-byte normalization", () => {
  const fixture = changedMetadata(metadata => {
    metadata.authorization.selection.id = ` ${"é".repeat(198)} `;
    metadata.authorization.market_decision.decision_id = " original decision ";
    metadata.authorization.market_decision.policy_revision = "😀".repeat(100);
    metadata.authorization.transaction_closure.source_revision = "é".repeat(200);
    metadata.authorization.selection.revision = 2_147_483_647;
  });
  assertAccepted(fixture);
  assert.equal(fixture.metadata.authorization.selection.id.length, 200);
  assert.ok(Buffer.byteLength(fixture.metadata.authorization.selection.id) > 200);
  for (const change of [
    metadata => { metadata.authorization.selection.id = "x".repeat(201); },
    metadata => { metadata.authorization.selection.id = "   "; },
    metadata => { metadata.authorization.selection.id = "bad\ntext"; },
    metadata => { metadata.authorization.market_decision.policy_revision = "😀".repeat(101); },
    metadata => { metadata.authorization.transaction_closure.source_revision = " padded "; },
    metadata => { metadata.authorization.selection.revision = "1"; },
    metadata => { metadata.authorization.selection.revision = 2_147_483_648; },
  ]) assertFailure(prepare(changedMetadata(change).bundle));
});

test("normalized account spelling remains exact, with case, punctuation, leading zeros and Unicode preserved", () => {
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ["0001", "R-01", "r-01", "é"] }));
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ["é".repeat(64)] }));
  for (const accountIds of [[" padded"], ["padded "], [""], ["x".repeat(65)], ["bad\tvalue"], [7], [null]]) {
    const metadata = makeCohortLocalQueryMetadata();
    assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ accountIds, metadata }).bundle));
  }
  for (const [where, value] of [["organization_id", "10000000-0000-4000-8000-00000000000A"],
    ["subject_snapshot_id", "30000000-0000-0000-0000-000000000003"]]) {
    assertFailure(prepare(changedMetadata(metadata => { metadata.scope[where] = value; }).bundle));
  }
});

test("strict date and six-digit capture-time checks retain precision without promoting historical support", () => {
  assertAccepted(changedMetadata(metadata => { metadata.observation_period.start_date = "2024-02-29"; }));
  const baseline = createCohortLocalQueryEvidenceFixture();
  const changed = changedMetadata(metadata => { metadata.capture_observed_at = "2026-09-06T08:00:00.123457Z"; });
  assertAccepted(changed);
  assert.equal(baseline.metadata.authorization.selection_sha256, changed.metadata.authorization.selection_sha256);
  assert.notEqual(baseline.bundle.captured_query_selection_sha256, changed.bundle.captured_query_selection_sha256);
  for (const change of [
    metadata => { metadata.effective_date = "2024-02-31"; },
    metadata => { metadata.observation_period.start_date = "2023-02-29"; },
    metadata => { metadata.observation_period.start_date = "2024-07-01"; },
    metadata => { metadata.observation_period.end_date = "2024-07-01"; },
    metadata => { metadata.effective_date = "2024-06-30T00:00:00Z"; },
    metadata => { metadata.knowledge_cutoff = "2024-06-30T00:00:00.000Z"; },
    ...["2026-09-06T08:00:00.123Z", "2026-09-06T08:00:00.1234567Z", "2026-09-06T08:00:00.123456+00:00",
      "2026-09-06T24:00:00.123456Z", "2026-09-06T08:00:60.123456Z", "2026-02-31T08:00:00.123456Z"]
      .map(value => metadata => { metadata.capture_observed_at = value; }),
  ]) assertFailure(prepare(changedMetadata(change).bundle));
});

test("all seven table capabilities are closed, available and relation-specific", () => {
  for (const key of Object.keys(makeCohortLocalQueryMetadata().capabilities)) {
    for (const change of [
      metadata => { delete metadata.capabilities[key]; },
      metadata => { metadata.capabilities[key].relation = "other.source"; },
      metadata => { metadata.capabilities[key].state = "absent"; },
      metadata => { metadata.capabilities[key].missing_columns = ["missing_column"]; },
      metadata => { metadata.capabilities[key].extra = true; },
    ]) assertFailure(prepare(changedMetadata(change).bundle));
  }
  assertFailure(prepare(changedMetadata(metadata => { metadata.capabilities.extra = { relation: "other.source", state: "available", missing_columns: [] }; }).bundle));
});

test("known metadata has thirteen exact keys and does not accept post-hash fields, grants or authority bags", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  assert.equal(Object.keys(fixture.metadata).length, 13);
  for (const key of Object.keys(fixture.metadata)) {
    const metadata = copy(fixture.metadata); delete metadata[key];
    assertFailure(prepare(replaceMetadataText(fixture, canonicalAssessmentJson(metadata))));
  }
  for (const [key, value] of [["selection_sha256", "f".repeat(64)], ["selected_account_count", 3], ["role", "selection"],
    ["source_gaps", []], ["auth", { userId: "SECRET_SYNTHETIC" }], ["selection_grant", {}], ["acquisition_id", "invented"]]) {
    assertFailure(prepare(changedMetadata(metadata => { metadata[key] = value; }).bundle));
  }
  for (const change of [metadata => { metadata.authorization.market_decision.allowed = true; },
    metadata => { metadata.provider_coverage = "complete"; }, metadata => { metadata.mapping_version = "1"; },
    metadata => { metadata.authorization.transaction_closure.extra = true; }]) {
    assertFailure(prepare(changedMetadata(change).bundle));
  }
});

test("every declared reader limit is positive, bounded and retained without resetting smaller invocation limits", () => {
  const smaller = changedMetadata(metadata => {
    metadata.limits = { records: 7, bytes: 10_000, row_bytes: 5_000, page_size: 1,
      selected_accounts: 3, duration_ms: 1_000, statement_ms: 100, connect_ms: 100 };
  });
  assertAccepted(smaller);
  for (const [key, maximum] of Object.entries(makeCohortLocalQueryMetadata().limits)) {
    for (const value of [0, -1, 1.5, String(maximum), maximum + 1]) {
      assertFailure(prepare(changedMetadata(metadata => { metadata.limits[key] = value; }).bundle));
    }
  }
  assertFailure(prepare(changedMetadata(metadata => { metadata.limits.extra = 1; }).bundle));
});

test("closure scalar implications distinguish no-sales stock, links, sources and selected-account counts", () => {
  assertAccepted(changedMetadata(metadata => {
    Object.assign(metadata.authorization.transaction_closure, { transaction_count: 0, link_count: 0,
      legacy_sale_count: 0, account_count: 0, source_record_count: 0 });
    metadata.limits.records = 3;
  }));
  assertAccepted(changedMetadata(metadata => {
    Object.assign(metadata.authorization.transaction_closure, { transaction_count: 0, link_count: 0,
      legacy_sale_count: 1, account_count: 1, source_record_count: 0 });
    metadata.limits.records = 5;
  }));
  for (const closure of [
    { source_record_count: 0 }, { transaction_count: 0, source_record_count: 0 },
    { account_count: 0 }, { account_count: 4 }, { transaction_count: -1 },
    { transaction_count: 1.5 }, { link_count: "1" }, { account_count: 50_001 },
    { transaction_count: 50_000, source_record_count: 50_000, link_count: 50_001 },
    { transaction_count: 0, source_record_count: 0, link_count: 0, account_count: 1 },
  ]) assertFailure(prepare(changedMetadata(metadata => { Object.assign(metadata.authorization.transaction_closure, closure); }).bundle));
  const rowBound = changedMetadata(metadata => { metadata.limits.records = 6; });
  assertFailure(prepare(rowBound.bundle));
  const selectionBound = changedMetadata(metadata => { metadata.limits.selected_accounts = 2; });
  assertFailure(prepare(selectionBound.bundle), "limit_exceeded", "account_limit");
});

test("source/header claims may be internally consistent without proving omitted union membership", () => {
  const accountIds = ids(101);
  const metadata = makeCohortLocalQueryMetadata({ subjectId: accountIds[0] });
  Object.assign(metadata.authorization.transaction_closure, { transaction_count: 25_000, source_record_count: 25_000,
    link_count: 0, legacy_sale_count: 0, account_count: 50_000 });
  const result = assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds, metadata }));
  assert.equal(result.authority, "not_established", "A+N is not an observed set union");
});

test("original authorization and captured-query digests cannot substitute for each other or the preimage digest", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ authorizationHash: "d".repeat(64) }).bundle), "invalid", "selection_mismatch");
  for (const hash of [fixture.refs.preimage.content_sha256, fixture.metadata.authorization.selection_sha256, "e".repeat(64)]) {
    const bundle = copy(fixture.bundle); bundle.captured_query_selection_sha256 = hash;
    assertFailure(prepare(bundle), "invalid", "query_hash_mismatch");
  }
  const metadataText = canonicalAssessmentJson(fixture.metadata);
  const records = fixture.accountIds.map(id => canonicalAssessmentJson(id));
  for (const text of [metadataText + "\n" + records.join("\n") + "\n",
    metadataText + records.join("\n"), metadataText + records.toReversed().join("\n") + "\n"]) {
    const bundle = copy(fixture.bundle); bundle.captured_query_selection_sha256 = cohortFixtureSha256(text);
    assertFailure(prepare(bundle), "invalid", "query_hash_mismatch");
  }
});

test("page closure checks reject gaps, reorder, counts, kinds and cross-role references after complete rehashing", () => {
  const changes = [
    directory => { directory.pages.reverse(); },
    directory => { directory.pages[0].page_index = "1"; },
    directory => { directory.pages[0].entry_count = "2"; },
    directory => { directory.entry_count = "2"; },
    directory => { directory.kind = "stock_roster"; },
    directory => { directory.pages.pop(); },
    directory => { directory.pages.push(copy(directory.pages[0])); },
  ];
  for (const mutateDirectory of changes) {
    assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ pageSize: 1, mutateDirectory }).bundle));
  }
  for (const mutatePage of [page => { page.page_index = "1"; }, page => { page.kind = "other"; },
    page => { page.entries[0].extra = true; }, page => { page.extra = true; }]) {
    assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ mutatePage }).bundle));
  }
  for (const mutatePreimage of [preimage => { preimage.ordered_account_roster.entry_count = "2"; },
    (preimage, refs) => { preimage.compact_metadata = copy(refs.directoryBlob.ref); },
    (preimage, refs) => { preimage.ordered_account_roster.manifest = copy(refs.metadataBlob.ref); },
    preimage => { preimage.extra = true; }]) {
    assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ mutatePreimage }).bundle));
  }
});

test("no sorting, deduplication, empty-selection inference or count-only subject inclusion repairs a supplied directory", () => {
  for (const accountIds of [["2", "10"], ["same", "same"], ["A", "B", "A"], []]) {
    assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ accountIds, pageSize: 1 }).bundle), "invalid", "directory_mismatch");
  }
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ["10", "2"], pageSize: 1 }));
  const metadata = makeCohortLocalQueryMetadata({ subjectId: "NOT_SELECTED" });
  assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ metadata }).bundle));
});

test("missing, extra, duplicate, conflicting and unsorted stored blobs fail without repairing their closure", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const missing = copy(fixture.bundle);
  missing.blobs = missing.blobs.filter(blob => blob.ref.content_sha256 !== fixture.refs.metadata.content_sha256);
  assertFailure(prepare(missing), "invalid", "missing_blob");
  assertFailure(prepare(appendBlob(fixture, makeCohortCanonicalBlob({ unused: true }))), "invalid", "unused_blob");
  assertFailure(prepare(appendBlob(fixture, fixture.bundle.blobs[0])), "invalid", "duplicate_blob");
  const conflict = copy(fixture.bundle.blobs[0]); conflict.canonical_json = "{}";
  assertFailure(prepare(appendBlob(fixture, conflict)));
  const reversed = copy(fixture.bundle); reversed.blobs.reverse();
  assertFailure(prepare(reversed));
  const altered = copy(fixture.bundle); altered.blobs[0].canonical_json += " ";
  assertFailure(prepare(altered));
});

test("blob references use strict positive byte text and exact lower hashes, not coerced values or future keys", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  for (const mutate of [ref => { ref.canonical_utf8_bytes = 1; }, ref => { ref.canonical_utf8_bytes = "01"; },
    ref => { ref.canonical_utf8_bytes = "0"; }, ref => { ref.canonical_utf8_bytes = "9223372036854775808"; },
    ref => { ref.content_sha256 = ref.content_sha256.toUpperCase(); }, ref => { ref.content_sha256 = "a".repeat(63); },
    ref => { ref.extra = true; }, ref => { delete ref.content_sha256; }]) {
    const bundle = copy(fixture.bundle); mutate(bundle.query_preimage); assertFailure(prepare(bundle));
  }
  const wrongBytes = copy(fixture.bundle); wrongBytes.blobs[0].ref.canonical_utf8_bytes = "1";
  assertFailure(prepare(wrongBytes));
  const changedHash = copy(fixture.bundle); changedHash.blobs[0].ref.content_sha256 = "d".repeat(64);
  sortBlobs(changedHash); assertFailure(prepare(changedHash), "invalid", "digest_mismatch");
});

test("outer transport rejects nonprimitive input without invoking any user hook", () => {
  let calls = 0;
  const hostile = new Proxy({}, { get() { calls++; throw new Error("SECRET_SYNTHETIC"); },
    ownKeys() { calls++; throw new Error("SECRET_SYNTHETIC"); }, getPrototypeOf() { calls++; throw new Error("SECRET_SYNTHETIC"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const getter = {}; Object.defineProperty(getter, "version", { get() { calls++; throw new Error("SECRET_SYNTHETIC"); } });
  for (const input of [undefined, null, true, 1, 1n, Symbol("x"), {}, [], new String("{}"), hostile, revoked.proxy,
    getter, { toJSON() { calls++; throw new Error("SECRET_SYNTHETIC"); } }]) {
    assertFailure(prepareCohortLocalQueryEvidenceV1(input), "invalid", "invalid_input_type");
  }
  assert.equal(calls, 0);
});

test("outer JSON normalization cannot erase duplicate keys, alternate numbers, whitespace or escapes", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  for (const text of ["", "{", "undefined", '{"version":NaN}']) assertFailure(prepareCohortLocalQueryEvidenceV1(text), "invalid", "invalid_json");
  for (const text of [" " + fixture.inputJson, fixture.inputJson + "\n", JSON.stringify(fixture.bundle, null, 2),
    '{"version":1,"version":2}', '{"version":2.0}', '{"version":2,"x":-0}', '{"version":2,"x":"\\u0041"}']) {
    assertFailure(prepareCohortLocalQueryEvidenceV1(text), "invalid", "noncanonical_json");
  }
});

test("unsupported dispatch follows bounded generic admission without claiming unknown nested-profile validation", () => {
  assertFailure(prepareCohortLocalQueryEvidenceV1('{"version":2,"future":true}'), "unsupported", "unsupported_version");
  const bundle = copy(createCohortLocalQueryEvidenceFixture().bundle);
  bundle.producer_profile = "future-capture"; bundle.blobs = "not-a-v1-blob-array";
  assertFailure(prepare(bundle), "unsupported", "unsupported_producer_profile");
  for (const version of [0, -1, 1.5, "2", null]) assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify({ version })));
  for (const key of Object.keys(createCohortLocalQueryEvidenceFixture().bundle)) {
    const incomplete = copy(bundle); delete incomplete[key]; assertFailure(prepare(incomplete));
  }
  for (const producer_profile of ["", "x".repeat(65), "é".repeat(33), null]) {
    assertFailure(prepare({ ...bundle, producer_profile }));
  }
  const additional = { ...bundle, unexpected: true }; assertFailure(prepare(additional));
});

test("raw byte, generic-node and depth boundaries precede future-version dispatch", () => {
  for (const character of ["x", "é"]) {
    assertFailure(prepareCohortLocalQueryEvidenceV1(futureAtBytes(8_000_000, character)), "unsupported", "unsupported_version");
    assertFailure(prepareCohortLocalQueryEvidenceV1(futureAtBytes(8_000_001, character)), "limit_exceeded", "input_bytes");
  }
  assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify({ version: 2, values: Array(9_997).fill(null) })), "unsupported", "unsupported_version");
  assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify({ version: 2, values: Array(9_998).fill(null) })), "limit_exceeded", "input_nodes");
  assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify(nestedAtDepth(16))), "unsupported", "unsupported_version");
  assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify(nestedAtDepth(17))), "limit_exceeded", "input_depth");
});

test("all stored text representations receive blob-count and parsed-work admission before deduplication", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const small = makeCohortCanonicalBlob({ x: 1 });
  assertFailure(prepare(appendBlob(fixture, small, 1_003 - fixture.bundle.blobs.length)), "invalid", "duplicate_blob");
  assertFailure(prepare(appendBlob(fixture, small, 1_004 - fixture.bundle.blobs.length)), "limit_exceeded", "blob_limit");
  const repeated = makeCohortBlobFromText("[" + Array(90_000).fill("null").join(",") + "]");
  assertFailure(prepare(appendBlob(fixture, repeated, 5)), "invalid", "duplicate_blob");
  assertFailure(prepare(appendBlob(fixture, repeated, 6)), "limit_exceeded", "work_limit");
});

test("per-blob byte, node and depth boundaries apply even to supplied unused evidence", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  assertFailure(prepare(appendBlob(fixture, makeCohortBlobFromText('"' + "x".repeat(1_499_998) + '"'))), "invalid", "unused_blob");
  assertFailure(prepare(appendBlob(fixture, makeCohortBlobFromText('"' + "x".repeat(1_499_999) + '"'))), "limit_exceeded", "blob_bytes");
  const flat = count => makeCohortBlobFromText("[" + Array(count).fill("0").join(",") + "]");
  assertFailure(prepare(appendBlob(fixture, flat(99_999))), "invalid", "unused_blob");
  assertFailure(prepare(appendBlob(fixture, flat(100_000))), "limit_exceeded", "blob_nodes");
  const nested = depth => { let value = null; for (let index = 0; index < depth; index++) value = { x: value }; return makeCohortBlobFromText(JSON.stringify(value)); };
  assertFailure(prepare(appendBlob(fixture, nested(35))), "invalid", "unused_blob");
  assertFailure(prepare(appendBlob(fixture, nested(36))), "limit_exceeded", "blob_depth");
});

test("canonical blob parsing refuses erased lexical distinctions and incompatible Unicode", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  for (const text of ['{"z":1,"a":2}', '{"a":1,"a":2}', '{"x":1.0}', '{"x":-0}', '{"x":"\\u0041"}']) {
    assertFailure(prepare(appendBlob(fixture, makeCohortBlobFromText(text))), "invalid", "noncanonical_json");
  }
  for (const text of [JSON.stringify({ x: "\u0000" }), JSON.stringify({ x: "\ud800" }), JSON.stringify({ "\udc00": "x" })]) {
    assertFailure(prepare(appendBlob(fixture, makeCohortBlobFromText(text))), "invalid", "invalid_unicode");
  }
  for (const value of ["\u0000", "\ud800", "\udc00"]) {
    assertFailure(prepareCohortLocalQueryEvidenceV1(JSON.stringify({ version: 2, value })), "invalid", "invalid_unicode");
  }
  const malformed = replaceMetadataText(fixture, "{"); assertFailure(prepare(malformed), "invalid", "invalid_json");
});

test("JSONB exponent expansion has a separate cap and cannot be bypassed by small canonical text", () => {
  const fixture = createCohortLocalQueryEvidenceFixture();
  const below = makeCohortCanonicalBlob(Array(6_000).fill(1e308));
  const above = makeCohortCanonicalBlob(Array(7_000).fill(1e308));
  assert.ok(Number(above.ref.canonical_utf8_bytes) < 100_000);
  assertFailure(prepare(appendBlob(fixture, below)), "invalid", "unused_blob");
  assertFailure(prepare(appendBlob(fixture, above)), "limit_exceeded", "storage_limit");
});

test("closed-role metadata byte admission occurs before unsupported extra-field semantics", () => {
  const makeSized = bytes => {
    const metadata = makeCohortLocalQueryMetadata(); metadata.padding = "";
    const baseline = createCohortLocalQueryEvidenceFixture({ metadata });
    metadata.padding = "x".repeat(bytes - Buffer.byteLength(canonicalAssessmentJson(baseline.metadata)));
    const fixture = createCohortLocalQueryEvidenceFixture({ metadata });
    assert.equal(Number(fixture.refs.metadata.canonical_utf8_bytes), bytes);
    return fixture;
  };
  assertFailure(prepare(makeSized(64_000).bundle), "invalid", "invalid_shape");
  assertFailure(prepare(makeSized(64_001).bundle), "limit_exceeded", "blob_bytes");
});

test("directory entry/page limits include valid at-cap controls and refuse all excess members", () => {
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ids(1_000), pageSize: 1_000 }));
  assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ accountIds: ids(1_001), pageSize: 1_001 }).bundle), "limit_exceeded", "account_limit");
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ids(1_000), pageSize: 1 }));
  assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ accountIds: ids(1_001), pageSize: 1 }).bundle), "limit_exceeded", "blob_limit");
});

test("50,000 short account IDs are structurally admitted while one additional member is not clipped", () => {
  assertAccepted(createCohortLocalQueryEvidenceFixture({ accountIds: ids(50_000) }));
  assertFailure(prepare(createCohortLocalQueryEvidenceFixture({ accountIds: ids(50_001) }).bundle), "limit_exceeded", "account_limit");
});

test("query streaming does not replace the smaller original authorization-preimage canonical cap", () => {
  const accountIds = Array.from({ length: 25_000 }, (_, index) => String(index).padStart(6, "0") + "x".repeat(58));
  const fixture = createCohortLocalQueryEvidenceFixture({ accountIds, authorizationHash: "d".repeat(64) });
  const preimage = { scope: fixture.metadata.scope, effective_date: fixture.metadata.effective_date,
    selection: fixture.metadata.authorization.selection, account_ids: accountIds };
  assert.ok(Buffer.byteLength(JSON.stringify(preimage)) > 1_500_000);
  assert.ok(Buffer.byteLength(fixture.inputJson) < 8_000_000);
  assert.equal(fixture.bundle.captured_query_selection_sha256, cohortFixtureQueryHash(fixture.metadata, accountIds));
  assertFailure(prepareCohortLocalQueryEvidenceV1(fixture.inputJson), "limit_exceeded", "authorization_preimage_limit");
});

test("fixed failures never echo hostile source text, nested payloads or debug stacks", () => {
  const fixture = changedMetadata(metadata => { metadata.debug = "SECRET_SYNTHETIC_SOURCE_PAYLOAD"; });
  const result = assertFailure(prepare(fixture.bundle));
  assert.equal(JSON.stringify(result).includes("SECRET_SYNTHETIC"), false);
  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
  assert.deepEqual(COHORT_LOCAL_QUERY_FIXTURE_ACCOUNTS, ["000123", "R-001", "r-001"]);
});
