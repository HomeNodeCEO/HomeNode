import assert from "node:assert/strict";
import test from "node:test";

import { deleteUadAsset } from "../src/modules/uad/assets.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_KEY = `organizations/redteam/uad/${WORKFILE_ID}/assets/${ASSET_ID}/probe.png`;

function deletionPool({
  workfile = { id: WORKFILE_ID, status: "draft", signed_at: null },
  signatureResult = { rows: [{ has_signatures: false }] },
  signatureError = null,
} = {}) {
  const queries = [];
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (/^BEGIN(?: ISOLATION LEVEL READ COMMITTED)?$/.test(statement)) return { rows: [] };
      if (statement.startsWith("SELECT id, status")) {
        return { rows: [workfile] };
      }
      if (statement.includes("AS has_signatures")) {
        if (signatureError) throw signatureError;
        return signatureResult;
      }
      if (statement.startsWith("SELECT id, object_key")) {
        return { rows: [{ id: ASSET_ID, object_key: OBJECT_KEY }] };
      }
      if (statement.startsWith("WITH deleted_asset")) return { rows: [{ id: ASSET_ID }] };
      if (statement === "COMMIT" || statement === "ROLLBACK") return { rows: [] };
      throw new Error(`unexpected_sql:${statement}`);
    },
    release() {
      queries.push("RELEASE");
    },
  };
  return { queries, pool: { async connect() { return client; } } };
}

function deletionStorage(deletedKeys) {
  return {
    async deleteObject({ objectKey }) {
      deletedKeys.push(objectKey);
      return { deleted: true };
    },
  };
}

async function assertDeletionRefused(options, expectedError = /uad_workfile_status_locked/) {
  const { pool, queries } = deletionPool(options);
  const deletedKeys = [];
  await assert.rejects(
    () => deleteUadAsset(pool, deletionStorage(deletedKeys), WORKFILE_ID, ASSET_ID),
    expectedError,
  );
  assert.deepEqual(deletedKeys, []);
  assert.equal(queries.some((sql) => sql.startsWith("SELECT id, object_key")), false);
  assert.equal(queries.some((sql) => sql.startsWith("WITH deleted_asset")), false);
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.at(-1), "RELEASE");
  return queries;
}

test("asset deletion removes the private object before hiding its metadata", async () => {
  const { pool, queries } = deletionPool();
  const deletedKeys = [];
  await deleteUadAsset(pool, deletionStorage(deletedKeys), WORKFILE_ID, ASSET_ID);

  assert.deepEqual(deletedKeys, [OBJECT_KEY]);
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
  const workfileLock = queries.findIndex((sql) => sql.startsWith("SELECT id, status"));
  const signatureCheck = queries.findIndex((sql) => sql.includes("AS has_signatures"));
  const assetLock = queries.findIndex((sql) => sql.startsWith("SELECT id, object_key"));
  const metadataDeletion = queries.findIndex((sql) => sql.startsWith("WITH deleted_asset"));
  assert.match(queries[workfileLock], /^SELECT id, status, signed_at[\s\S]+FOR UPDATE$/);
  assert.ok(signatureCheck > workfileLock);
  assert.ok(assetLock > signatureCheck);
  assert.ok(metadataDeletion > assetLock);
  assert.ok(queries.includes("COMMIT"));
  assert.equal(queries.includes("ROLLBACK"), false);
  assert.equal(queries.at(-1), "RELEASE");
});

test("asset deletion rolls back metadata when object storage fails", async () => {
  const { pool, queries } = deletionPool();
  await assert.rejects(
    () => deleteUadAsset(pool, {
      async deleteObject() {
        throw new Error("uad_object_delete_failed:503");
      },
    }, WORKFILE_ID, ASSET_ID),
    /uad_object_delete_failed/,
  );
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.some((sql) => sql.startsWith("WITH deleted_asset")), false);
});

test("asset deletion refuses ready workfiles with signed_at before asset or storage access", async () => {
  const queries = await assertDeletionRefused({
    workfile: {
      id: WORKFILE_ID,
      status: "ready",
      signed_at: "2026-09-05T12:00:00.000Z",
    },
  });
  assert.equal(queries.some((sql) => sql.includes("AS has_signatures")), false);
});

test("asset deletion refuses partial and historical signatures before asset or storage access", async () => {
  for (const status of ["ready", "revised"]) {
    const queries = await assertDeletionRefused({
      workfile: { id: WORKFILE_ID, status, signed_at: null },
      signatureResult: { rows: [{ has_signatures: true }] },
    });
    const workfileLock = queries.findIndex((sql) => sql.startsWith("SELECT id, status"));
    const signatureCheck = queries.findIndex((sql) => sql.includes("AS has_signatures"));
    assert.ok(workfileLock >= 0);
    assert.ok(signatureCheck > workfileLock);
  }
});

test("asset deletion fails closed on malformed signature query results", async () => {
  const malformedResults = [
    null,
    {},
    { rows: [] },
    { rows: [{}] },
    { rows: [{ has_signatures: false }, { has_signatures: false }] },
    { rows: { 0: { has_signatures: false }, length: 1 } },
    { rows: [{ has_signatures: "false" }] },
    { rows: [{ has_signatures: null }] },
  ];
  for (const signatureResult of malformedResults) {
    const queries = await assertDeletionRefused({ signatureResult });
    assert.ok(queries.some((sql) => sql.includes("AS has_signatures")));
  }
});

test("asset deletion rolls back a signature query failure without storage access", async () => {
  const signatureError = new Error("uad_signature_query_failed");
  const queries = await assertDeletionRefused({ signatureError }, signatureError);
  assert.ok(queries.some((sql) => sql.includes("AS has_signatures")));
});

test("asset deletion preserves every explicitly unsigned mutable workflow", async () => {
  for (const status of ["draft", "validating", "ready", "revised"]) {
    const { pool, queries } = deletionPool({
      workfile: { id: WORKFILE_ID, status, signed_at: null },
    });
    const deletedKeys = [];
    await deleteUadAsset(pool, deletionStorage(deletedKeys), WORKFILE_ID, ASSET_ID);
    assert.deepEqual(deletedKeys, [OBJECT_KEY]);
    assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
    assert.ok(queries.some((sql) => sql.includes("AS has_signatures")));
    assert.ok(queries.includes("COMMIT"));
    assert.equal(queries.includes("ROLLBACK"), false);
  }
});

test("asset deletion requires explicit mutable status and explicit unsigned timestamp evidence", async () => {
  const invalidWorkfiles = [
    { id: WORKFILE_ID, status: "draft" },
    { id: WORKFILE_ID, status: "ready", signed_at: undefined },
    { id: WORKFILE_ID, status: "unknown", signed_at: null },
    { id: WORKFILE_ID, status: null, signed_at: null },
    { id: WORKFILE_ID, status: 0, signed_at: null },
    { id: WORKFILE_ID, status: "draft", signed_at: false },
    { id: WORKFILE_ID, status: "draft", signed_at: 0 },
    { id: WORKFILE_ID, status: "draft", signed_at: "" },
  ];
  for (const workfile of invalidWorkfiles) {
    const queries = await assertDeletionRefused({ workfile });
    assert.equal(queries.some((sql) => sql.includes("AS has_signatures")), false);
  }
});
