import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createAssignmentWorkfileFile,
  createAssignmentWorkfileLink,
  getAssignmentWorkfileFile,
} from "../src/services/assignmentWorkfileItems.js";

const organizationId = "11111111-1111-4111-8111-111111111111";

test("general workfile files are checksummed, scope-partitioned, and retained outside evidence extraction", async () => {
  const uploaded = [];
  const content = Buffer.from("parcel spreadsheet bytes");
  const checksum = createHash("sha256").update(content).digest("hex");
  const pool = {
    async query(sql, values) {
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        assert.deepEqual(values, [41]);
        return { rows: [{ assignment_file_id: 41, status: "draft" }] };
      }
      assert.match(sql, /INSERT INTO app\.assignment_workfile_items/);
      assert.equal(values[1], organizationId);
      assert.equal(values[2], 41);
      assert.equal(values[3], null);
      assert.equal(values[6], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.equal(values[8], checksum);
      return { rows: [{
        id: values[0], item_type: "file", title: values[4], original_file_name: values[5],
        content_type: values[6], file_size_bytes: values[7], checksum_sha256: values[8],
        external_url: null, created_by_user_id: values[10], created_at: "2026-09-22T00:00:00Z",
      }] };
    },
  };
  const storage = {
    configured: true,
    async putObject(input) { uploaded.push(input); },
    async deleteObject() {},
  };
  const result = await createAssignmentWorkfileFile(pool, storage, { assignmentFileId: 41 }, {
    organizationId,
    title: "Market support",
    fileName: "market.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content,
    createdByUserId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(result.title, "Market support");
  assert.equal(result.checksum_sha256, checksum);
  assert.equal(uploaded.length, 1);
  assert.match(uploaded[0].objectKey, new RegExp(`/workfiles/custom/41/items/.+/${checksum}/market.xlsx$`));
  assert.deepEqual(uploaded[0].body, content);
});

test("workfile file allowlist rejects executable content", async () => {
  await assert.rejects(
    createAssignmentWorkfileFile({ query: async () => ({ rows: [] }) }, { configured: true, putObject: async () => {} }, { assignmentFileId: 4 }, {
      organizationId,
      fileName: "payload.exe",
      contentType: "application/octet-stream",
      content: Buffer.from("MZ"),
    }),
    /unsupported_workfile_file_type/,
  );
});

test("workfile links accept only credential-free http or https URLs", async () => {
  await assert.rejects(
    createAssignmentWorkfileLink({ query: async () => ({ rows: [] }) }, { uadWorkfileId: "33333333-3333-4333-8333-333333333333" }, {
      organizationId,
      title: "Unsafe",
      externalUrl: "javascript:alert(1)",
    }),
    /invalid_workfile_link/,
  );
});

test("signed Custom workfiles reject new files and clean the staged object", async () => {
  let removed = 0;
  const storage = {
    configured: true,
    async putObject() {},
    async deleteObject() { removed += 1; },
  };
  await assert.rejects(
    createAssignmentWorkfileFile({ query: async sql => {
      assert.match(sql, /FROM app\.custom_appraisal_workfiles/);
      return { rows: [{ assignment_file_id: 4, status: "signed" }] };
    } }, storage, { assignmentFileId: 4 }, {
      organizationId,
      fileName: "signed.pdf",
      contentType: "application/pdf",
      content: Buffer.from("%PDF-signed"),
    }),
    /assignment_workfile_status_locked/,
  );
  assert.equal(removed, 1);
});

test("download verifies both retained byte length and SHA-256", async () => {
  const body = Buffer.from("verified workfile evidence");
  const pool = { query: async () => ({ rows: [{
    id: "44444444-4444-4444-8444-444444444444",
    title: "Evidence",
    original_file_name: "evidence.pdf",
    content_type: "application/pdf",
    file_size_bytes: body.length,
    checksum_sha256: createHash("sha256").update(body).digest("hex"),
    object_key: "private/evidence",
  }] }) };
  const storage = { configured: true, getObject: async () => ({ body }) };
  const result = await getAssignmentWorkfileFile(pool, storage, { assignmentFileId: 4 }, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(result.body, body);
  await assert.rejects(
    getAssignmentWorkfileFile(pool, { configured: true, getObject: async () => ({ body: Buffer.from("tampered") }) }, { assignmentFileId: 4 }, "44444444-4444-4444-8444-444444444444"),
    /workfile_file_integrity_failed/,
  );
});
