import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectMobilePhotoPayload,
  normalizePhotoBatch,
  verifyInspectionPhoto,
} from "../src/modules/mobile/photos.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const PHOTO_ID = "10000000-0000-4000-8000-000000000002";
const USER_ID = "10000000-0000-4000-8000-000000000003";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000004";
const REPORT_FILE_ID = "10000000-0000-4000-8000-000000000005";

const auth = {
  userId: USER_ID,
  organizations: [{ organizationId: ORGANIZATION_ID, roles: ["appraiser"] }],
};

function photoRow(overrides = {}) {
  return {
    id: PHOTO_ID,
    inspection_session_id: SESSION_ID,
    report_file_id: REPORT_FILE_ID,
    client_photo_id: "10000000-0000-4000-8000-000000000006",
    workflow_type: "custom_appraisal",
    category: "Front",
    category_source: "custom_catalog",
    room_ref: null,
    room_label: null,
    caption: "Subject front",
    caption_source: "manual",
    source: "camera",
    position: 1,
    captured_at: "2026-09-04T12:00:00.000Z",
    capture_metadata: {},
    status: "pending_upload",
    revision: 1,
    required_retention_years: 5,
    created_at: "2026-09-04T12:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
    ...overrides,
  };
}

function objectRow(id, variant) {
  return {
    id,
    photo_id: PHOTO_ID,
    client_object_id: id,
    variant,
    object_key: `private/pending/${variant}.png`,
    original_file_name: `${variant}.png`,
    content_type: "image/png",
    expected_byte_size: PNG.length,
    byte_size: null,
    pixel_width: 1,
    pixel_height: 1,
    status: "pending_upload",
  };
}

test("mobile photo registration always requires a safe display derivative", () => {
  assert.throws(() => normalizePhotoBatch({
    photos: [{
      client_photo_id: "20000000-0000-4000-8000-000000000001",
      category: "Front",
      category_source: "custom_catalog",
      source: "camera",
      objects: [{
        client_object_id: "20000000-0000-4000-8000-000000000002",
        variant: "original",
        file_name: "front.png",
        content_type: "image/png",
        byte_size: PNG.length,
      }],
    }],
  }), /mobile_photo_display_derivative_required/);
});

test("mobile photo inspection fully decodes supported image bytes", async () => {
  const inspected = await inspectMobilePhotoPayload(PNG, "image/png");
  assert.equal(inspected.byte_size, PNG.length);
  assert.match(inspected.checksum_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(inspected.dimensions, { width: 1, height: 1, pixels: 1 });
  await assert.rejects(
    () => inspectMobilePhotoPayload(Buffer.alloc(PNG.length, 0x41), "image/png"),
    /invalid_mobile_photo_upload/,
  );
});

test("mobile verification checksum-binds bytes and promotes immutable object keys", async () => {
  const originalPhoto = photoRow();
  const originalObjects = [
    objectRow("30000000-0000-4000-8000-000000000001", "original"),
    objectRow("30000000-0000-4000-8000-000000000002", "display"),
  ];
  const verifiedObjects = new Map(originalObjects.map((object) => [object.id, object]));
  const objectUpdates = [];
  const client = {
    async query(sql, values = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/FROM app\.inspection_sessions session/.test(sql)) {
        return { rows: [{
          id: SESSION_ID,
          status: "active",
          organization_id: ORGANIZATION_ID,
          workflow_type: "custom_appraisal",
          bound_report_file_id: REPORT_FILE_ID,
        }] };
      }
      if (/SELECT \* FROM app\.inspection_photos/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: [originalPhoto] };
      }
      if (/UPDATE app\.inspection_photo_objects/.test(sql)) {
        objectUpdates.push(values);
        const previous = verifiedObjects.get(values[0]);
        verifiedObjects.set(values[0], {
          ...previous,
          status: "verified",
          byte_size: values[1],
          storage_etag: values[2],
          checksum_sha256: values[3],
          object_key: values[4],
          pixel_width: values[5],
          pixel_height: values[6],
        });
        return { rows: [] };
      }
      if (/UPDATE app\.inspection_photos/.test(sql)) {
        return { rows: [photoRow({
          status: "verified",
          revision: 2,
          verified_at: "2026-09-04T12:01:00.000Z",
          retention_starts_at: "2026-09-04T12:01:00.000Z",
          retention_until: "2031-09-04T12:01:00.000Z",
        })] };
      }
      if (/UPDATE app\.inspection_sessions/.test(sql)
          || /INSERT INTO app\.inspection_photo_events/.test(sql)) return { rows: [] };
      if (/FROM app\.inspection_photo_objects/.test(sql)) {
        return { rows: [...verifiedObjects.values()] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/FROM app\.inspection_photos photo/.test(sql)) return { rows: [originalPhoto] };
      if (/FROM app\.inspection_photo_objects/.test(sql)) return { rows: originalObjects };
      if (/UPDATE app\.inspection_photos SET status = 'verifying'/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() { return client; },
  };
  const operations = [];
  const result = await verifyInspectionPhoto(pool, {
    configured: true,
    bucket: "private",
    async inspectObject({ objectKey }) {
      operations.push(["inspect", objectKey]);
      return { byte_size: PNG.length, content_type: "image/png", etag: "pending-etag" };
    },
    async getObject({ objectKey, maxBytes }) {
      operations.push(["get", objectKey, maxBytes]);
      return { body: PNG, byte_size: PNG.length, content_type: "image/png" };
    },
    async putObject({ objectKey, contentType, body }) {
      operations.push(["put", objectKey, contentType, body.length]);
      return { byte_size: body.length, etag: "verified-etag" };
    },
    async deleteObject({ objectKey }) {
      operations.push(["delete", objectKey]);
      return { deleted: true };
    },
  }, auth, SESSION_ID, PHOTO_ID);

  assert.equal(result.status, "verified");
  assert.equal(objectUpdates.length, 2);
  for (const values of objectUpdates) {
    assert.match(values[3], /^[a-f0-9]{64}$/);
    assert.match(values[4], /\.verified-[0-9a-f-]+-[a-f0-9]{64}$/);
    assert.deepEqual(values.slice(5, 7), [1, 1]);
  }
  assert.ok(operations.every(([name, key]) => name !== "delete"
    || originalObjects.some((object) => object.object_key === key)));
  assert.equal(operations.filter(([name]) => name === "delete").length, 2);
  assert.ok(operations.filter(([name]) => name === "get")
    .every((operation) => operation[2] === 50 * 1024 * 1024));
});

test("mobile verification rejects and removes same-size non-image bytes", async () => {
  const originalPhoto = photoRow();
  const originalObject = objectRow("40000000-0000-4000-8000-000000000001", "original");
  const failureQueries = [];
  const failureClient = {
    async query(sql) {
      failureQueries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/SELECT \* FROM app\.inspection_photos/.test(sql)) return { rows: [originalPhoto] };
      if (/UPDATE app\.inspection_photos/.test(sql)
          || /INSERT INTO app\.inspection_photo_events/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async query(sql) {
      if (/FROM app\.inspection_photos photo/.test(sql)) return { rows: [originalPhoto] };
      if (/FROM app\.inspection_photo_objects/.test(sql)) return { rows: [originalObject] };
      if (/UPDATE app\.inspection_photos SET status = 'verifying'/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() { return failureClient; },
  };
  const spoof = Buffer.alloc(PNG.length, 0x41);
  const deleted = [];
  await assert.rejects(() => verifyInspectionPhoto(pool, {
    configured: true,
    bucket: "private",
    inspectObject: async () => ({
      byte_size: spoof.length,
      content_type: "image/png",
      etag: "spoof-etag",
    }),
    getObject: async () => ({ body: spoof, byte_size: spoof.length, content_type: "image/png" }),
    putObject: async () => assert.fail("unverified bytes must never be promoted"),
    deleteObject: async ({ objectKey }) => deleted.push(objectKey),
  }, auth, SESSION_ID, PHOTO_ID), /invalid_mobile_photo_upload/);
  assert.deepEqual(deleted, [originalObject.object_key]);
  assert.ok(failureQueries.some((sql) => /photo\.verification_failed/.test(sql)));
});
