import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createUadAssetUpload, deleteUadAsset, verifyUadAssetUpload } from "../src/modules/uad/assets.js";
import { createUadEntityWithClient, deleteUadEntityWithClient } from "../src/modules/uad/entities.js";
import { assertUadWorkfileMutable, isUadWorkfileMutable } from "../src/modules/uad/workfileLifecycle.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";

test("the shared UAD lifecycle guard fails closed outside explicitly mutable states", () => {
  for (const status of ["signed", "exported", "submitted", "cancelled", "", null, "unknown"]) {
    assert.equal(isUadWorkfileMutable(status), false);
    assert.throws(() => assertUadWorkfileMutable(status), /uad_workfile_status_locked/);
  }
  for (const status of ["draft", "validating", "ready", "revised"]) {
    assert.equal(isUadWorkfileMutable(status), true);
    assert.doesNotThrow(() => assertUadWorkfileMutable(status));
  }
});

test("entity creation and deletion stop at the locked finalized workfile row", async () => {
  for (const operation of [
    (client) => createUadEntityWithClient(client, WORKFILE_ID, { entity_type: "sales_comparable" }),
    (client) => deleteUadEntityWithClient(client, WORKFILE_ID, ENTITY_ID),
  ]) {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(String(sql));
        return { rows: [{ id: WORKFILE_ID, status: "signed" }] };
      },
    };
    await assert.rejects(() => operation(client), /uad_workfile_status_locked/);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /FOR UPDATE/);
    assert.doesNotMatch(queries[0], /INSERT|DELETE FROM appraisal\.uad_entities/);
  }
});

test("asset URL creation and verification reject finalized workfiles before storage access", async () => {
  let storageTouched = false;
  const storage = {
    createUploadUrl() { storageTouched = true; },
    inspectObject() { storageTouched = true; },
  };
  const creationQueries = [];
  let creationReleased = false;
  const creationClient = {
    async query(statement, parameters = []) {
      const sql = statement.replace(/\s+/g, " ").trim();
      creationQueries.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "ROLLBACK") {
        assert.deepEqual(parameters, []);
        return { rows: [] };
      }
      assert.equal(sql, "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE");
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [{ id: WORKFILE_ID, organization_id: "org", status: "signed", signed_at: null }] };
    },
    release() { assert.equal(creationReleased, false); creationReleased = true; },
  };
  await assert.rejects(
    () => createUadAssetUpload(
      { connect: async () => creationClient, query: async () => assert.fail("creation escaped its transaction client") },
      storage,
      WORKFILE_ID,
      { asset_kind: "photo", content_type: "image/jpeg", file_name: "subject.jpg", byte_size: 10 },
    ),
    /uad_workfile_status_locked/,
  );
  assert.deepEqual(creationQueries, [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE",
    "ROLLBACK",
  ]);
  assert.equal(creationReleased, true);
  await assert.rejects(
    () => verifyUadAssetUpload(
      { query: async () => ({ rows: [{ id: ASSET_ID, workfile_status: "signed" }] }) },
      storage,
      WORKFILE_ID,
      ASSET_ID,
    ),
    /uad_workfile_status_locked/,
  );
  assert.equal(storageTouched, false);
});

test("asset deletion locks and rejects the workfile before deleting storage", async () => {
  const queries = [];
  let deleted = false;
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (statement.startsWith("SELECT id, status")) {
        return { rows: [{ id: WORKFILE_ID, status: "exported", signed_at: null }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    () => deleteUadAsset(
      { connect: async () => client },
      { deleteObject: async () => { deleted = true; } },
      WORKFILE_ID,
      ASSET_ID,
    ),
    /uad_workfile_status_locked/,
  );
  assert.equal(deleted, false);
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.some((sql) => sql.startsWith("SELECT id, object_key")), false);
});

test("asset insertion and verification retain mutable-workfile dependencies with locked verification admission", () => {
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const validation = fs.readFileSync(path.resolve(directory, "../src/modules/uad/validation.js"), "utf8");
  assert.match(assets, /WITH mutable_workfile AS[\s\S]+status IN \('draft', 'validating', 'ready', 'revised'\)[\s\S]+FROM mutable_workfile/);
  assert.match(assets, /updated_asset AS[\s\S]+EXISTS \(SELECT 1 FROM mutable_workfile\)/);
  assert.match(assets, /async function withUadAssetVerificationLock[\s\S]+BEGIN ISOLATION LEVEL READ COMMITTED[\s\S]+FOR UPDATE[\s\S]+await assertLockedUadWorkfileMutable\(client, locked\.rows\[0\]\)/);
  assert.match(assets, /async function rejectUadAssetIfWorkfileMutable[\s\S]+await withUadAssetVerificationLock\(pool, workfileId, assetId, source/);
  assert.match(assets, /const updatedAsset = await withUadAssetVerificationLock\(pool, workfileId, assetId, asset/);
  assert.match(validation, /assertUadWorkfileMutable\(locked\.rows\[0\]\.status, "uad_validation_status_locked"\)/);
});
