import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verifyUadAssetUpload } from "../src/modules/uad/assets.js";
import { buildUadObjectKey, buildUadVerifiedAssetObjectKey } from "../src/modules/uad/r2Storage.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const CHECKSUM_SHA256 = createHash("sha256").update(PNG).digest("hex");
const WORKFILE_UPDATED_AT = "2026-09-05T00:00:00.000Z";
const SOURCE_OBJECT_KEY = `organizations/${ORGANIZATION_ID}/uad/${WORKFILE_ID}/assets/${ASSET_ID}/probe.png`;
const VERIFIED_OBJECT_KEY = buildUadVerifiedAssetObjectKey({
  organizationId: ORGANIZATION_ID,
  workfileId: WORKFILE_ID,
  assetId: ASSET_ID,
  checksumSha256: CHECKSUM_SHA256,
  fileName: "probe.png",
});
const VERIFICATION_SOURCE_FIELDS = Object.freeze([
  "object_key",
  "original_file_name",
  "content_type",
  "section_number",
  "entity_id",
  "asset_kind",
  "caption_type",
  "caption",
  "storage_provider",
  "storage_bucket",
]);

const clone = (value) => value == null ? value : structuredClone(value);

function normalizeSql(sql) {
  return String(sql).trim().replace(/\s+/g, " ");
}

function initialAsset(overrides = {}) {
  return {
    id: ASSET_ID,
    workfile_id: WORKFILE_ID,
    entity_id: null,
    asset_kind: "photo",
    section_number: 8,
    caption_type: "DwellingFront",
    caption: null,
    storage_provider: "synthetic",
    storage_bucket: "synthetic-private-bucket",
    object_key: SOURCE_OBJECT_KEY,
    original_file_name: "probe.png",
    content_type: "image/png",
    byte_size: null,
    checksum_sha256: null,
    status: "pending_upload",
    capture_metadata: { expected_byte_size: PNG.length },
    uploaded_at: null,
    verified_at: null,
    created_at: "2026-09-05T00:00:00.000Z",
    organization_id: ORGANIZATION_ID,
    ...overrides,
  };
}

function verificationHarness({
  workfile = {
    id: WORKFILE_ID,
    organization_id: ORGANIZATION_ID,
    status: "draft",
    signed_at: null,
    updated_at: WORKFILE_UPDATED_AT,
  },
  signatureResult = { rows: [{ has_signatures: false }] },
  signatureError = null,
  asset: suppliedAsset = initialAsset(),
  inspectMismatch = false,
  invalidDownloadedBytes = false,
  winnerBeforeReject = false,
  winnerAtPut = false,
  mutateAssetAtGet = null,
  mutateWorkfileAtGet = null,
  preexistingWinner = false,
  copiedByteSize = PNG.length,
  finalization = "success",
  finalizationError = new Error("uad_asset_finalization_failed"),
  commitAcknowledgementLost = false,
  commitError = new Error("uad_asset_finalization_acknowledgement_lost"),
} = {}) {
  const state = { workfile: clone(workfile), asset: clone(suppliedAsset) };
  const sourceOrganizationId = state.workfile?.organization_id;
  const expectedVerifiedObjectKey = buildUadVerifiedAssetObjectKey({
    organizationId: sourceOrganizationId,
    workfileId: WORKFILE_ID,
    assetId: ASSET_ID,
    checksumSha256: CHECKSUM_SHA256,
    fileName: state.asset.original_file_name,
  });
  const queries = [];
  const storageCalls = [];
  const events = [];
  const mutationQueries = [];
  const objects = new Map([[state.asset.object_key, Buffer.from(PNG)]]);
  if (preexistingWinner) objects.set(expectedVerifiedObjectKey, Buffer.from(PNG));
  let transactionOpen = false;
  let transactionSnapshot = null;
  let transactionMutated = false;
  let committedWithoutAcknowledgement = false;
  let connectCount = 0;
  let releaseCount = 0;
  let commitCount = 0;

  const promoteWinner = () => {
    objects.set(expectedVerifiedObjectKey, Buffer.from(PNG));
    Object.assign(state.asset, {
      status: "verified",
      object_key: expectedVerifiedObjectKey,
      byte_size: PNG.length,
      checksum_sha256: CHECKSUM_SHA256,
      capture_metadata: {
        ...state.asset.capture_metadata,
        storage_etag: "winner-etag",
        verified_dimensions: { width: 1, height: 1, pixels: 1 },
        verified_object_immutable: true,
      },
      uploaded_at: "2026-09-05T00:01:00.000Z",
      verified_at: "2026-09-05T00:01:00.000Z",
    });
  };

  const query = async (owner, sql, parameters = []) => {
    const statement = normalizeSql(sql);
    queries.push({ owner, statement, parameters });
    events.push({ kind: "sql", owner, statement });
    if (owner === "pool" && connectCount > 0) throw new Error(`pool_query_after_connect:${statement}`);

    if (statement === "BEGIN" || statement === "BEGIN ISOLATION LEVEL READ COMMITTED") {
      assert.equal(owner, "client");
      assert.equal(transactionOpen, false, "transactions must not nest");
      transactionOpen = true;
      transactionSnapshot = { workfile: clone(state.workfile), asset: clone(state.asset) };
      transactionMutated = false;
      return { rows: [] };
    }
    if (statement === "COMMIT") {
      assert.equal(owner, "client");
      assert.equal(transactionOpen, true, "COMMIT requires an owned transaction");
      commitCount += 1;
      transactionOpen = false;
      transactionSnapshot = null;
      if (commitAcknowledgementLost && transactionMutated) {
        committedWithoutAcknowledgement = true;
        throw commitError;
      }
      transactionMutated = false;
      return { rows: [] };
    }
    if (statement === "ROLLBACK") {
      assert.equal(owner, "client");
      if (committedWithoutAcknowledgement) {
        committedWithoutAcknowledgement = false;
        throw new Error("uad_asset_rollback_after_commit_uncertain");
      }
      assert.equal(transactionOpen, true, "ROLLBACK requires an owned transaction");
      state.workfile = transactionSnapshot.workfile;
      state.asset = transactionSnapshot.asset;
      transactionOpen = false;
      transactionSnapshot = null;
      transactionMutated = false;
      return { rows: [] };
    }
    if (statement.includes("AS has_signatures")) {
      assert.deepEqual(parameters, [WORKFILE_ID]);
      if (signatureError) throw signatureError;
      return signatureResult;
    }
    if (
      statement.includes("FROM appraisal.uad_workfiles")
      && statement.includes("FOR UPDATE")
      && !statement.includes("JOIN appraisal.uad_workfiles")
    ) {
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: state.workfile == null ? [] : [clone(state.workfile)] };
    }
    if (statement.includes("JOIN appraisal.uad_workfiles AS workfile")) {
      assert.deepEqual(parameters, [ASSET_ID, WORKFILE_ID]);
      if (!["pending_upload", "uploaded"].includes(state.asset.status)) return { rows: [] };
      return { rows: [clone({
        ...state.asset,
        organization_id: state.workfile?.organization_id,
        workfile_status: state.workfile?.status,
      })] };
    }
    if (statement.includes("FROM appraisal.uad_assets") && statement.includes("FOR UPDATE")) {
      assert.deepEqual(parameters.slice(0, 2), [ASSET_ID, WORKFILE_ID]);
      return { rows: state.asset == null ? [] : [clone(state.asset)] };
    }
    if (statement.includes("SET status = 'rejected'")) {
      mutationQueries.push({ kind: "reject", owner, statement, parameters });
      const limitsToUnverified = /status IN \('pending_upload', ?'uploaded'\)/.test(statement);
      if (limitsToUnverified && !["pending_upload", "uploaded"].includes(state.asset.status)) return { rows: [] };
      state.workfile.status = "draft";
      state.workfile.updated_at = "2026-09-05T00:02:00.000Z";
      state.asset.status = "rejected";
      state.asset.capture_metadata = {
        ...state.asset.capture_metadata,
        ...JSON.parse(parameters[2]),
      };
      transactionMutated = true;
      return { rows: [{ id: ASSET_ID }] };
    }
    if (statement.includes("SET status = 'verified'")) {
      mutationQueries.push({ kind: "verify", owner, statement, parameters });
      const objectKey = parameters.find((value) => typeof value === "string" && value.includes("/verified-assets/"))
        || expectedVerifiedObjectKey;
      state.workfile.status = "draft";
      state.workfile.updated_at = "2026-09-05T00:02:00.000Z";
      transactionMutated = true;
      Object.assign(state.asset, {
        status: "verified",
        object_key: objectKey,
        byte_size: PNG.length,
        checksum_sha256: CHECKSUM_SHA256,
        capture_metadata: {
          ...state.asset.capture_metadata,
          storage_etag: parameters[3],
          verified_dimensions: JSON.parse(parameters[6]),
          verified_object_immutable: true,
        },
        uploaded_at: "2026-09-05T00:01:00.000Z",
        verified_at: "2026-09-05T00:01:00.000Z",
      });
      if (finalization === "error") throw finalizationError;
      if (finalization === "empty") return { rows: [] };
      return { rows: [clone(state.asset)] };
    }
    if (statement === "SELECT status FROM appraisal.uad_workfiles WHERE id = $1") {
      return { rows: state.workfile == null ? [] : [{ status: state.workfile.status }] };
    }
    throw new Error(`unexpected_sql:${statement}`);
  };

  const client = {
    query(sql, parameters) {
      return query("client", sql, parameters);
    },
    release() {
      assert.equal(transactionOpen, false, "client released with an open transaction");
      releaseCount += 1;
      queries.push({ owner: "client", statement: "RELEASE", parameters: [] });
      events.push({ kind: "sql", owner: "client", statement: "RELEASE" });
    },
  };
  const pool = {
    query(sql, parameters) {
      return query("pool", sql, parameters);
    },
    async connect() {
      connectCount += 1;
      return client;
    },
  };
  const outsideTransaction = (operation, objectKey) => {
    assert.equal(transactionOpen, false, `${operation} storage access occurred inside a live transaction`);
    storageCalls.push({ operation, objectKey });
    events.push({ kind: "storage", operation, objectKey });
  };
  const storage = {
    async inspectObject({ objectKey }) {
      outsideTransaction("inspect", objectKey);
      if (winnerBeforeReject && inspectMismatch) promoteWinner();
      return {
        byte_size: inspectMismatch ? PNG.length + 1 : PNG.length,
        content_type: "image/png",
        etag: "source-etag",
      };
    },
    async getObject({ objectKey }) {
      outsideTransaction("get", objectKey);
      if (winnerBeforeReject && invalidDownloadedBytes) promoteWinner();
      const body = invalidDownloadedBytes ? Buffer.alloc(PNG.length, 0x41) : Buffer.from(PNG);
      if (typeof mutateAssetAtGet === "function") mutateAssetAtGet(state.asset);
      if (typeof mutateWorkfileAtGet === "function") mutateWorkfileAtGet(state.workfile);
      return { body, byte_size: body.length, content_type: "image/png" };
    },
    async putObject({ objectKey, contentType, body }) {
      outsideTransaction("put", objectKey);
      assert.equal(contentType, "image/png");
      assert.deepEqual(body, PNG);
      if (winnerAtPut) promoteWinner();
      objects.set(objectKey, Buffer.from(body));
      return { byte_size: copiedByteSize, etag: "verified-etag" };
    },
    async deleteObject({ objectKey }) {
      outsideTransaction("delete", objectKey);
      objects.delete(objectKey);
      return { deleted: true };
    },
  };

  return {
    pool,
    storage,
    state,
    objects,
    queries,
    storageCalls,
    events,
    mutationQueries,
    expectedVerifiedObjectKey,
    get connectCount() { return connectCount; },
    get releaseCount() { return releaseCount; },
    get commitCount() { return commitCount; },
    get transactionOpen() { return transactionOpen; },
  };
}

async function captureVerification(harness) {
  try {
    return { result: await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID), error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function assertNoStorageOrMutation(harness) {
  assert.deepEqual(harness.storageCalls, [], "lifecycle refusal must precede object-storage access");
  assert.deepEqual(harness.mutationQueries, [], "lifecycle refusal must precede asset mutation");
}

function assertStrictVerificationTransactions(harness, expectedTransactions) {
  const sql = harness.queries.filter(({ statement }) => statement !== "RELEASE");
  const poolQueries = sql.filter(({ owner }) => owner === "pool");
  assert.equal(poolQueries.length, 1, "only the initial applicability preflight may use pool.query");
  assert.match(poolQueries[0].statement, /JOIN appraisal\.uad_workfiles AS workfile/);
  assert.match(poolQueries[0].statement, /asset\.storage_provider, asset\.storage_bucket/);
  assert.equal(sql.filter(({ statement }) => statement === "BEGIN ISOLATION LEVEL READ COMMITTED").length, expectedTransactions);
  assert.equal(sql.filter(({ statement }) => /^SELECT id, organization_id, status, signed_at .* FOR UPDATE$/.test(statement)).length, expectedTransactions);
  assert.equal(sql.filter(({ statement }) => statement.includes("AS has_signatures")).length, expectedTransactions);
  const assetLocks = sql.filter(({ statement }) => statement.includes("FROM appraisal.uad_assets") && statement.includes("FOR UPDATE"));
  assert.equal(assetLocks.length, expectedTransactions);
  for (const { statement } of assetLocks) {
    assert.match(statement, /^SELECT id, workfile_id, object_key, original_file_name, content_type,/);
    assert.match(statement, /storage_provider, storage_bucket, capture_metadata, status FROM/);
  }
  const clientStatements = harness.queries
    .filter(({ owner }) => owner === "client")
    .map(({ statement }) => statement);
  let cursor = 0;
  for (let phase = 0; phase < expectedTransactions; phase += 1) {
    assert.equal(clientStatements[cursor], "BEGIN ISOLATION LEVEL READ COMMITTED", `phase ${phase + 1} must begin first`);
    assert.match(clientStatements[cursor + 1], /^SELECT id, organization_id, status, signed_at .* FOR UPDATE$/, `phase ${phase + 1} workfile lock order`);
    assert.match(clientStatements[cursor + 2], /AS has_signatures/, `phase ${phase + 1} signature snapshot order`);
    assert.match(clientStatements[cursor + 3], /FROM appraisal\.uad_assets .* FOR UPDATE$/, `phase ${phase + 1} asset lock order`);
    const terminal = clientStatements.findIndex(
      (statement, index) => index >= cursor + 4 && ["COMMIT", "ROLLBACK"].includes(statement),
    );
    assert.ok(terminal >= cursor + 4, `phase ${phase + 1} requires a terminal statement`);
    for (const statement of clientStatements.slice(cursor + 4, terminal)) {
      assert.match(statement, /SET status = '(?:verified|rejected)'/, `phase ${phase + 1} contains an unexpected query`);
    }
    assert.equal(clientStatements[terminal + 1], "RELEASE", `phase ${phase + 1} must release immediately after its terminal`);
    cursor = terminal + 2;
  }
  assert.equal(cursor, clientStatements.length, "no client statements may occur outside the verified phases");
  assert.equal(harness.connectCount, expectedTransactions);
  assert.equal(harness.releaseCount, expectedTransactions);
  assert.equal(harness.transactionOpen, false);
}

function eventIndex(harness, predicate) {
  return harness.events.findIndex(predicate);
}

function assertPublishedWinner(harness, storageEtag = "winner-etag") {
  assert.equal(harness.state.asset.status, "verified");
  assert.equal(harness.state.asset.object_key, harness.expectedVerifiedObjectKey);
  assert.equal(harness.state.asset.checksum_sha256, CHECKSUM_SHA256);
  assert.equal(harness.state.asset.caption_type, "DwellingFront");
  assert.equal(harness.state.asset.storage_provider, "synthetic");
  assert.equal(harness.state.asset.storage_bucket, "synthetic-private-bucket");
  assert.deepEqual(harness.state.asset.capture_metadata, {
    expected_byte_size: PNG.length,
    storage_etag: storageEtag,
    verified_dimensions: { width: 1, height: 1, pixels: 1 },
    verified_object_immutable: true,
  });
  assert.deepEqual(harness.objects.get(harness.expectedVerifiedObjectKey), PNG);
}

test("unsigned mutable asset verification promotes inspected PNG bytes", async () => {
  const harness = verificationHarness();
  const result = await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID);

  assert.equal(result.status, "verified");
  assert.equal(harness.state.asset.object_key, VERIFIED_OBJECT_KEY);
  assert.equal(harness.objects.has(VERIFIED_OBJECT_KEY), true);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), false);
  assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect", "get", "put", "delete"]);
  assertStrictVerificationTransactions(harness, 2);
  assert.equal(harness.commitCount, 2);
  const firstCommit = eventIndex(harness, (event) => event.statement === "COMMIT");
  const inspect = eventIndex(harness, (event) => event.operation === "inspect");
  const put = eventIndex(harness, (event) => event.operation === "put");
  const secondBegin = harness.events.findIndex((event, index) => index > firstCommit && event.statement === "BEGIN ISOLATION LEVEL READ COMMITTED");
  const finalCommit = harness.events.findLastIndex((event) => event.statement === "COMMIT");
  const stagingDelete = eventIndex(harness, (event) => event.operation === "delete");
  assert.ok(firstCommit < inspect, "preflight lock must be released before storage inspection");
  assert.ok(put < secondBegin, "finalization lock must begin only after storage copy");
  assert.ok(finalCommit < stagingDelete, "owned staging cleanup requires acknowledged persistence");
});

test("unsigned mutable asset verification rejects mismatched inspection metadata", async () => {
  const harness = verificationHarness({ inspectMismatch: true });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "invalid_uad_uploaded_asset");
  assert.equal(harness.state.asset.status, "rejected");
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), false);
  assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect", "delete"]);
  assertStrictVerificationTransactions(harness, 2);
  assert.equal(harness.commitCount, 2);
  const reject = eventIndex(harness, (event) => event.kind === "sql" && event.statement.includes("SET status = 'rejected'"));
  const rejectCommit = harness.events.findIndex((event, index) => index > reject && event.statement === "COMMIT");
  const cleanup = eventIndex(harness, (event) => event.operation === "delete");
  assert.ok(reject >= 0 && rejectCommit > reject && cleanup > rejectCommit);
});

test("unsigned mutable asset verification rejects malformed downloaded payload bytes", async () => {
  const harness = verificationHarness({ invalidDownloadedBytes: true });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "invalid_uad_uploaded_asset");
  assert.equal(harness.state.asset.status, "rejected");
  assert.match(harness.state.asset.capture_metadata.verification_error, /^invalid_uad_asset_/);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), false);
  assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect", "get", "delete"]);
  assertStrictVerificationTransactions(harness, 2);
  assert.equal(harness.commitCount, 2);
});

test("uploaded is an explicitly supported unsigned verification source state", async () => {
  const harness = verificationHarness({ asset: initialAsset({ status: "uploaded" }) });
  const result = await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID);

  assert.equal(result.status, "verified");
  assert.equal(harness.state.asset.object_key, VERIFIED_OBJECT_KEY);
  assert.deepEqual(harness.objects.get(VERIFIED_OBJECT_KEY), PNG);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), false);
  assertStrictVerificationTransactions(harness, 2);
});

test("null organization uses the builders' unassigned source and checksum destinations", async () => {
  const sourceObjectKey = buildUadObjectKey({
    organizationId: null,
    workfileId: WORKFILE_ID,
    assetId: ASSET_ID,
    fileName: "probe.png",
  });
  const harness = verificationHarness({
    workfile: {
      id: WORKFILE_ID,
      organization_id: null,
      status: "draft",
      signed_at: null,
      updated_at: WORKFILE_UPDATED_AT,
    },
    asset: initialAsset({ object_key: sourceObjectKey }),
  });
  const expectedDestination = buildUadVerifiedAssetObjectKey({
    organizationId: null,
    workfileId: WORKFILE_ID,
    assetId: ASSET_ID,
    checksumSha256: CHECKSUM_SHA256,
    fileName: "probe.png",
  });
  const result = await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID);

  assert.equal(harness.expectedVerifiedObjectKey, expectedDestination);
  assert.equal(result.status, "verified");
  assert.equal(harness.state.asset.object_key, expectedDestination);
  assert.deepEqual(harness.objects.get(expectedDestination), PNG);
  assert.equal(harness.objects.has(sourceObjectKey), false);
  assertStrictVerificationTransactions(harness, 2);
});

test("partial signature state refuses verification before storage or promotion", async () => {
  const harness = verificationHarness({
    workfile: { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "ready", signed_at: null },
    signatureResult: { rows: [{ has_signatures: true }] },
  });
  const outcome = await captureVerification(harness);

  assertNoStorageOrMutation(harness);
  assert.equal(outcome.error?.message, "uad_workfile_status_locked");
});

test("historical signature state refuses the inspection-rejection path before storage", async () => {
  const harness = verificationHarness({
    workfile: { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "revised", signed_at: null },
    signatureResult: { rows: [{ has_signatures: true }] },
    inspectMismatch: true,
  });
  const outcome = await captureVerification(harness);

  assertNoStorageOrMutation(harness);
  assert.equal(outcome.error?.message, "uad_workfile_status_locked");
});

test("signed_at refuses the payload-rejection path before storage", async () => {
  const harness = verificationHarness({
    workfile: { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "validating", signed_at: "2026-09-05T01:00:00.000Z" },
    invalidDownloadedBytes: true,
  });
  const outcome = await captureVerification(harness);

  assertNoStorageOrMutation(harness);
  assert.equal(outcome.error?.message, "uad_workfile_status_locked");
});

test("stale rejection cannot replace an already verified winner", async () => {
  const harness = verificationHarness({ inspectMismatch: true, winnerBeforeReject: true });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "uad_asset_not_found");
  assertPublishedWinner(harness);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), true, "a stale verifier does not own winner cleanup");
});

test("copy-size mismatch never deletes pre-existing checksum bytes", async () => {
  const harness = verificationHarness({ preexistingWinner: true, copiedByteSize: PNG.length + 1 });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "invalid_uad_uploaded_asset");
  assert.equal(harness.objects.has(VERIFIED_OBJECT_KEY), true);
  assert.equal(harness.state.asset.status, "pending_upload");
});

test("failed finalization query preserves its original error, transaction state, and checksum bytes", async () => {
  const finalizationError = new Error("uad_asset_finalization_failed");
  const harness = verificationHarness({
    workfile: {
      id: WORKFILE_ID,
      organization_id: ORGANIZATION_ID,
      status: "ready",
      signed_at: null,
      updated_at: WORKFILE_UPDATED_AT,
    },
    preexistingWinner: true,
    finalization: "error",
    finalizationError,
  });
  const workfileBefore = clone(harness.state.workfile);
  const assetBefore = clone(harness.state.asset);
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error, finalizationError);
  assert.equal(harness.objects.has(VERIFIED_OBJECT_KEY), true);
  assert.deepEqual(harness.state.workfile, workfileBefore);
  assert.deepEqual(harness.state.asset, assetBefore);
});

test("zero-row finalization rolls back CTE workfile changes and preserves checksum bytes", async () => {
  const harness = verificationHarness({
    workfile: {
      id: WORKFILE_ID,
      organization_id: ORGANIZATION_ID,
      status: "ready",
      signed_at: null,
      updated_at: WORKFILE_UPDATED_AT,
    },
    preexistingWinner: true,
    finalization: "empty",
  });
  const workfileBefore = clone(harness.state.workfile);
  const assetBefore = clone(harness.state.asset);
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "uad_asset_not_found");
  assert.equal(harness.objects.has(VERIFIED_OBJECT_KEY), true);
  assert.deepEqual(harness.state.workfile, workfileBefore);
  assert.deepEqual(harness.state.asset, assetBefore);
});

test("lost COMMIT acknowledgement preserves the committed winner and original error", async () => {
  const finalizationError = new Error("uad_asset_finalization_acknowledgement_lost");
  const harness = verificationHarness({
    preexistingWinner: true,
    commitAcknowledgementLost: true,
    commitError: finalizationError,
  });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error, finalizationError);
  assertPublishedWinner(harness, "verified-etag");
  assert.equal(harness.state.workfile.status, "draft");
  assert.equal(harness.state.workfile.updated_at, "2026-09-05T00:02:00.000Z");
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), true, "uncertain COMMIT cannot authorize staging cleanup");
});

test("lost rejection COMMIT acknowledgement preserves committed rejection and staging bytes", async () => {
  const commitError = new Error("uad_asset_rejection_acknowledgement_lost");
  const harness = verificationHarness({
    workfile: {
      id: WORKFILE_ID,
      organization_id: ORGANIZATION_ID,
      status: "ready",
      signed_at: null,
      updated_at: WORKFILE_UPDATED_AT,
    },
    inspectMismatch: true,
    commitAcknowledgementLost: true,
    commitError,
  });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error, commitError);
  assert.equal(harness.state.workfile.status, "draft");
  assert.equal(harness.state.workfile.updated_at, "2026-09-05T00:02:00.000Z");
  assert.equal(harness.state.asset.status, "rejected");
  assert.equal(harness.state.asset.capture_metadata.verification_error, "uploaded_object_does_not_match_request");
  assert.deepEqual(harness.objects.get(SOURCE_OBJECT_KEY), PNG);
  assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect"]);
});

test("a winner published while bytes are copied survives the loser's final lock", async () => {
  const harness = verificationHarness({ winnerAtPut: true });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "uad_asset_not_found");
  assertPublishedWinner(harness);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), true);
});

test("every declared scalar verification identity field is rebound at the I/O barrier", async (t) => {
  const changedValues = {
    object_key: `organizations/${ORGANIZATION_ID}/uad/${WORKFILE_ID}/assets/${ASSET_ID}/changed.png`,
    original_file_name: "changed.png",
    content_type: "image/jpeg",
    section_number: 9,
    entity_id: "55555555-5555-4555-8555-555555555555",
    asset_kind: "image",
    caption_type: "DwellingRear",
    caption: "changed caption",
    storage_provider: "changed-provider",
    storage_bucket: "changed-bucket",
  };
  assert.deepEqual(Object.keys(changedValues), VERIFICATION_SOURCE_FIELDS);
  for (const [field, changedValue] of Object.entries(changedValues)) {
    await t.test(field, async () => {
      const harness = verificationHarness({
        mutateAssetAtGet(asset) {
          asset[field] = changedValue;
        },
      });
      const outcome = await captureVerification(harness);

      assert.equal(outcome.error?.message, "uad_asset_not_found");
      assert.equal(harness.state.asset[field], changedValue);
      assert.equal(harness.state.asset.status, "pending_upload");
      assert.deepEqual(harness.mutationQueries, []);
      assert.deepEqual(harness.objects.get(SOURCE_OBJECT_KEY), PNG);
      assert.deepEqual(harness.objects.get(harness.expectedVerifiedObjectKey), PNG);
      assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect", "get", "put"]);
    });
  }
});

test("capture metadata drift at the I/O barrier fails stale without overwriting either object", async () => {
  const harness = verificationHarness({
    asset: initialAsset({
      capture_metadata: {
        expected_byte_size: PNG.length,
        camera: { id: "camera-1", calibration: { revision: 1, source: "native" } },
      },
    }),
    mutateAssetAtGet(asset) {
      asset.capture_metadata.camera.calibration.revision = 2;
    },
  });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "uad_asset_not_found");
  assert.equal(harness.state.asset.status, "pending_upload");
  assert.equal(harness.state.asset.capture_metadata.camera.calibration.revision, 2);
  assert.deepEqual(harness.objects.get(SOURCE_OBJECT_KEY), PNG);
  assert.deepEqual(harness.objects.get(VERIFIED_OBJECT_KEY), PNG);
});

test("capture metadata key-order changes remain structurally equal", async () => {
  const harness = verificationHarness({
    asset: initialAsset({
      capture_metadata: {
        expected_byte_size: PNG.length,
        camera: { id: "camera-1", calibration: { revision: 1, source: "native" } },
      },
    }),
    mutateAssetAtGet(asset) {
      asset.capture_metadata = {
        camera: { calibration: { source: "native", revision: 1 }, id: "camera-1" },
        expected_byte_size: PNG.length,
      };
    },
  });
  const result = await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID);

  assert.equal(result.status, "verified");
  assert.equal(harness.state.asset.object_key, VERIFIED_OBJECT_KEY);
  assert.equal(harness.objects.has(VERIFIED_OBJECT_KEY), true);
  assert.equal(harness.objects.has(SOURCE_OBJECT_KEY), false);
  assertStrictVerificationTransactions(harness, 2);
});

test("workfile organization drift at the I/O barrier fails stale and preserves both objects", async () => {
  const changedOrganization = "44444444-4444-4444-8444-444444444444";
  const harness = verificationHarness({
    mutateWorkfileAtGet(workfile) {
      workfile.organization_id = changedOrganization;
    },
  });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error?.message, "uad_asset_not_found");
  assert.equal(harness.state.workfile.organization_id, changedOrganization);
  assert.equal(harness.state.asset.status, "pending_upload");
  assert.deepEqual(harness.objects.get(SOURCE_OBJECT_KEY), PNG);
  assert.deepEqual(harness.objects.get(VERIFIED_OBJECT_KEY), PNG);
});

test("acknowledged promotion retains an unrecognized legacy staging key", async () => {
  const legacyObjectKey = `legacy-uad/${WORKFILE_ID}/${ASSET_ID}/probe.png`;
  const harness = verificationHarness({ asset: initialAsset({ object_key: legacyObjectKey }) });
  const result = await verifyUadAssetUpload(harness.pool, harness.storage, WORKFILE_ID, ASSET_ID);

  assert.equal(result.status, "verified");
  assert.deepEqual(harness.objects.get(legacyObjectKey), PNG);
  assert.deepEqual(harness.objects.get(VERIFIED_OBJECT_KEY), PNG);
  assert.deepEqual(harness.storageCalls.map(({ operation }) => operation), ["inspect", "get", "put"]);
  assertStrictVerificationTransactions(harness, 2);
  assert.equal(harness.commitCount, 2);
});

test("malformed signature evidence fails closed before object storage", async () => {
  const harness = verificationHarness({ signatureResult: { rows: [] } });
  const outcome = await captureVerification(harness);

  assertNoStorageOrMutation(harness);
  assert.equal(outcome.error?.message, "uad_workfile_status_locked");
  assert.equal(harness.connectCount, 1);
  assert.equal(harness.releaseCount, 1);
  assert.equal(harness.queries.some(({ statement }) => statement === "ROLLBACK"), true);
});

test("signature query failure preserves its original error and refuses storage", async () => {
  const signatureError = new Error("uad_asset_signature_query_failed");
  const harness = verificationHarness({ signatureError });
  const outcome = await captureVerification(harness);

  assert.equal(outcome.error, signatureError);
  assertNoStorageOrMutation(harness);
  assert.equal(harness.connectCount, 1);
  assert.equal(harness.releaseCount, 1);
  assert.equal(harness.queries.some(({ statement }) => statement === "ROLLBACK"), true);
  assert.equal(harness.transactionOpen, false);
});
