import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { migrateAssignmentDocumentStorageBatch } from "../src/services/assignmentDocuments.js";

const content = Buffer.from("%PDF-fixture");
const checksum = createHash("sha256").update(content).digest("hex");

function legacyDocument(overrides = {}) {
  return {
    id: 17,
    account_id: "migration-fixture-account",
    organization_id: "migration-fixture-org",
    assignment_file_id: null,
    uad_workfile_id: "20000000-0000-4000-8000-000000000017",
    tax_protest_file_id: null,
    report_file_id: null,
    file_name: "evidence.pdf",
    checksum_sha256: checksum,
    content,
    ...overrides,
  };
}

test("legacy Custom documents are excluded before private-object migration", async () => {
  const queries = [];
  let uploaded = false;
  const pool = {
    async query(sql) {
      queries.push(String(sql));
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) {
        // Return a stale candidate anyway to exercise the second guard.
        return { rows: [{ id: 17 }] };
      }
      if (/SELECT document\.\*/.test(sql)) {
        return { rows: [legacyDocument({ assignment_file_id: 41 })] };
      }
      throw new Error(`unexpected migration query: ${sql}`);
    },
  };
  const result = await migrateAssignmentDocumentStorageBatch(pool, {
    configured: true,
    async putObject() { uploaded = true; },
  });
  assert.deepEqual(result.results, []);
  assert.equal(result.attempted, 0);
  assert.equal(uploaded, false);
  assert.match(queries[1], /assignment_file_id IS NULL/);
  assert.match(queries[2], /document\.assignment_file_id IS NULL/);
});

test("eligible UAD legacy document still migrates to verified private storage", async () => {
  const queries = [];
  let uploaded;
  const pool = {
    async query(sql, values) {
      queries.push({ sql: String(sql), values });
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) return { rows: [{ id: 17 }] };
      if (/SELECT document\.\*/.test(sql)) return { rows: [legacyDocument()] };
      if (/SET content = NULL/.test(sql)) {
        assert.match(sql, /assignment_file_id IS NULL/);
        assert.equal(values[0], 17);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected migration query: ${sql}`);
    },
  };
  const result = await migrateAssignmentDocumentStorageBatch(pool, {
    configured: true,
    bucket: "private-fixture-bucket",
    async putObject(value) { uploaded = value; },
    async inspectObject() {
      return { byte_size: content.length, etag: "fixture-etag", content_type: "application/pdf" };
    },
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.migrated, 1);
  assert.equal(result.failed, 0);
  assert.equal(uploaded.contentType, "application/pdf");
  assert.deepEqual(uploaded.body, content);
  assert.ok(queries.some(({ sql }) => /SET content = NULL/.test(sql)));
});

test("migration failures retain only stable diagnostics in logs, metadata, and results", async () => {
  const logs = [];
  const persistedErrors = [];
  const pool = {
    async query(sql, values) {
      if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
      if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) return { rows: [{ id: 17 }] };
      if (/SELECT document\.\*/.test(sql)) return { rows: [legacyDocument()] };
      if (/SET storage_status = 'migration_failed'/.test(sql)) {
        assert.match(sql, /assignment_file_id IS NULL/);
        persistedErrors.push(values[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected migration query: ${sql}`);
    },
  };
  const failure = new Error("private-url=https://private.example/secret-token");
  failure.code = "ECONNRESET";
  const result = await migrateAssignmentDocumentStorageBatch(pool, {
    configured: true,
    async putObject() { throw failure; },
  }, { logger: { warn: (...args) => logs.push(args) } });
  assert.equal(result.failed, 1);
  assert.deepEqual(persistedErrors, ["assignment_document_storage_migration_failed"]);
  assert.deepEqual(logs, [["[documents] storage migration failed for document 17", "ECONNRESET"]]);
  assert.equal(JSON.stringify(result).includes("private.example"), false);
});
