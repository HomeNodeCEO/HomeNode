import assert from "node:assert/strict";
import test from "node:test";

import { deleteUadAsset } from "../src/modules/uad/assets.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_KEY = `organizations/redteam/uad/${WORKFILE_ID}/assets/${ASSET_ID}/probe.png`;

function deletionPool() {
  const queries = [];
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (statement.startsWith("SELECT id, status")) {
        return { rows: [{ id: WORKFILE_ID, status: "draft" }] };
      }
      if (statement.startsWith("SELECT id, object_key")) {
        return { rows: [{ id: ASSET_ID, object_key: OBJECT_KEY }] };
      }
      if (statement.startsWith("WITH deleted_asset")) return { rows: [{ id: ASSET_ID }] };
      return { rows: [] };
    },
    release() {
      queries.push("RELEASE");
    },
  };
  return { queries, pool: { async connect() { return client; } } };
}

test("asset deletion removes the private object before hiding its metadata", async () => {
  const { pool, queries } = deletionPool();
  const deletedKeys = [];
  await deleteUadAsset(pool, {
    async deleteObject({ objectKey }) {
      deletedKeys.push(objectKey);
      return { deleted: true };
    },
  }, WORKFILE_ID, ASSET_ID);

  assert.deepEqual(deletedKeys, [OBJECT_KEY]);
  assert.ok(queries.includes("BEGIN"));
  assert.ok(queries.some((sql) => sql.startsWith("WITH deleted_asset")));
  assert.ok(queries.includes("COMMIT"));
  assert.equal(queries.includes("ROLLBACK"), false);
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
