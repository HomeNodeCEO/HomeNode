import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";

import {
  processAssignmentDocument,
  processPendingAssignmentDocuments,
  queueAssignmentDocumentExtraction,
} from "../src/services/assignmentDocuments.js";

function fixtureDocument(overrides = {}) {
  return {
    id: 7,
    account_id: 'SYNTHETIC',
    assignment_file_id: null,
    processing_attempts: 1,
    processing_status: "processing",
    processing_claim_started_at: '2026-01-01 12:00:00.123456+00',
    content: null,
    storage_provider: "r2",
    object_key: "private/fixture.pdf",
    file_size_bytes: 12,
    checksum_sha256: "a".repeat(64),
    ...overrides,
  };
}

function withNativeTransactions(pool, { exists = true } = {}) {
  pool.connect = async () => ({ release() {}, async query(sql, values) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (/SELECT account_id, assignment_file_id/.test(sql)) return { rows: exists ? [fixtureDocument()] : [] };
    if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: [fixtureDocument()] };
    if (/AS owns_claim/.test(sql)) {
      assert.deepEqual(values, [7, 1, '2026-01-01 12:00:00.123456+00']);
      return { rows: [{ owns_claim: true }] };
    }
    return pool.query(sql, values);
  } });
  return pool;
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
  withNativeTransactions(pool);
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

test('busy image scanner persists a delayed queue entry without consuming an extraction attempt', async () => {
  const pdf = new PDFDocument();
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  const content = new Promise(resolve => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  pdf.end();
  const document = fixtureDocument({ content: await content, document_type: 'purchase_contract' });
  const updates = [];
  const pool = { async query(sql, values) {
    if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
    if (/SET processing_status = 'processing'/.test(sql)) {
      assert.match(sql, /processing_status = 'uploaded'\s+AND \(next_processing_at IS NULL OR next_processing_at <= now\(\)\)/);
      return { rows: [document] };
    }
    if (/SET processing_status = 'uploaded'/.test(sql)) {
      updates.push(sql);
      assert.deepEqual(values, [7]);
      return { rows: [{ ...document, processing_status: 'uploaded', processing_attempts: 0 }] };
    }
    throw new Error(`Unexpected query ${sql}`);
  } };
  withNativeTransactions(pool);
  const result = await processAssignmentDocument(pool, 7, {
    ocrProvider: { configured: true, async analyzePdf() { throw new Error('document_ocr_busy'); } },
  });
  assert.equal(result.processing_status, 'uploaded');
  assert.equal(result.processing_attempts, 0);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /GREATEST\(processing_attempts - 1, 0\)/);
  assert.match(updates[0], /interval '15 seconds'/);
  assert.doesNotMatch(updates[0], /DELETE|extraction_summary\s*=/);
});

test('explicit reprocess queues durably without erasing previous evidence or taking a live worker', async () => {
  const pool = { async query(sql, values) {
    if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
    assert.deepEqual(values, [7, 15]);
    assert.match(sql, /processing_status <> 'processing'/);
    assert.match(sql, /processing_attempts = 0/);
    assert.doesNotMatch(sql, /DELETE|extraction_summary\s*=/);
    return { rows: [fixtureDocument({ processing_status: 'uploaded', processing_attempts: 0 })] };
  } };
  withNativeTransactions(pool);
  assert.equal((await queueAssignmentDocumentExtraction(pool, 7)).processing_status, 'uploaded');
  for (const exists of [true, false]) {
    const blocked = { async query(sql) {
      if (/CREATE SCHEMA/.test(sql) || /UPDATE app/.test(sql)) return { rows: [] };
      return { rows: exists ? [{ id: 7 }] : [] };
    } };
    withNativeTransactions(blocked, { exists });
    await assert.rejects(queueAssignmentDocumentExtraction(blocked, 7),
      new RegExp(exists ? 'document_processing_in_progress' : 'document_not_found'));
  }
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
  withNativeTransactions(pool);
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
  withNativeTransactions(pool);
  const result = await processPendingAssignmentDocuments(pool, { logger: { warn() {} } });
  assert.deepEqual(result, {
    attempted: 1,
    results: [{ id: 7, ok: false, error: "assignment_document_extraction_failed" }],
  });
});
