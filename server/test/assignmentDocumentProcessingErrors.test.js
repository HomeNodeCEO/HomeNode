import assert from "node:assert/strict";
import test from "node:test";

import {
  processAssignmentDocument,
  processPendingAssignmentDocuments,
} from "../src/services/assignmentDocuments.js";

function fixtureDocument(overrides = {}) {
  return {
    id: 7,
    processing_attempts: 1,
    processing_status: "processing",
    content: null,
    storage_provider: "r2",
    object_key: "private/fixture.pdf",
    file_size_bytes: 12,
    checksum_sha256: "a".repeat(64),
    ...overrides,
  };
}

test("extraction persists and logs bounded diagnostics after private-object failure", async () => {
  const failure = new Error("private-url=https://private.example/secret-token");
  failure.code = "ECONNRESET";
  const persisted = [];
  const logs = [];
  const pool = {
    async query(sql, values) {
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SET processing_status = 'processing'/.test(sql)) {
        return { rows: [fixtureDocument()] };
      }
      if (/SELECT \* FROM app\.assignment_documents WHERE id/.test(sql)) {
        return { rows: [fixtureDocument()] };
      }
      if (/SET processing_status = 'extraction_failed'/.test(sql)) {
        persisted.push(values[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await assert.rejects(
    processAssignmentDocument(pool, 7, {
      storage: { configured: true, async getObject() { throw failure; } },
      logger: { warn: (...args) => logs.push(args) },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(persisted, ["assignment_document_extraction_failed"]);
  assert.deepEqual(logs, [["[documents] extraction failed for document 7", "ECONNRESET"]]);
  assert.equal(JSON.stringify({ persisted, logs }).includes("private.example"), false);
});

test("a known invalid PDF code remains visible without raw parser details", async () => {
  const persisted = [];
  const pool = {
    async query(sql, values) {
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SET processing_status = 'processing'/.test(sql)) {
        return { rows: [fixtureDocument({ content: Buffer.from("bad-pdf") })] };
      }
      if (/SET processing_status = 'extraction_failed'/.test(sql)) {
        persisted.push(values[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  await assert.rejects(
    processAssignmentDocument(pool, 7, { logger: { warn() {} } }),
    /document_not_pdf/,
  );
  assert.deepEqual(persisted, ["document_not_pdf"]);
});

test("maintenance results do not return unexpected worker exception text", async () => {
  const pool = {
    async query(sql) {
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SET processing_status = 'extraction_failed'/.test(sql)) return { rowCount: 0 };
      if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) {
        return { rows: [{ id: 7 }] };
      }
      if (/SET processing_status = 'processing'/.test(sql)) {
        throw new Error("private-url=https://private.example/secret-token");
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await processPendingAssignmentDocuments(pool, { logger: { warn() {} } });
  assert.deepEqual(result, {
    attempted: 1,
    results: [{ id: 7, ok: false, error: "assignment_document_extraction_failed" }],
  });
});
