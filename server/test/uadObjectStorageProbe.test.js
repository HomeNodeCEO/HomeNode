import assert from "node:assert/strict";
import test from "node:test";

import { verifyUadObjectStorage } from "../src/modules/uad/uadObjectStorageProbe.js";

function storageFixture(overrides = {}) {
  let body = null;
  return {
    configured: true,
    isolated: true,
    provider: "r2",
    async putObject(input) {
      body = Buffer.from(input.body);
      return { byte_size: body.length };
    },
    async inspectObject() {
      return { byte_size: body.length, content_type: "application/json" };
    },
    async getObject() {
      return { body, byte_size: body.length };
    },
    async deleteObject() {
      body = null;
      return { deleted: true };
    },
    ...overrides,
  };
}

test("verifies an isolated UAD object round trip and removes the probe", async () => {
  const result = await verifyUadObjectStorage(storageFixture(), {
    requireIsolated: true,
    nonce: "00000000-0000-4000-8000-000000000001",
    checkedAt: "2026-08-25T12:00:00.000Z",
  });
  assert.deepEqual(result, {
    ok: true,
    checked_at: "2026-08-25T12:00:00.000Z",
    provider: "r2",
    isolated: true,
    write_verified: true,
    metadata_verified: true,
    checksum_verified: true,
    cleanup_verified: true,
  });
});

test("refuses a shared bucket when isolation is required", async () => {
  await assert.rejects(
    verifyUadObjectStorage(storageFixture({ isolated: false }), { requireIsolated: true }),
    /uad_object_probe_storage_not_isolated/,
  );
});

test("fails checksum verification and still attempts cleanup", async () => {
  let deleted = false;
  const storage = storageFixture({
    async getObject() {
      return { body: Buffer.from("corrupted"), byte_size: 9 };
    },
    async deleteObject() {
      deleted = true;
      return { deleted: true };
    },
  });
  await assert.rejects(
    verifyUadObjectStorage(storage, { nonce: "00000000-0000-4000-8000-000000000002" }),
    /uad_object_probe_checksum_mismatch/,
  );
  assert.equal(deleted, true);
});

test("reports cleanup failure after a verified object round trip", async () => {
  await assert.rejects(
    verifyUadObjectStorage(storageFixture({
      async deleteObject() {
        throw new Error("provider_unavailable");
      },
    })),
    /uad_object_probe_cleanup_failed/,
  );
});
