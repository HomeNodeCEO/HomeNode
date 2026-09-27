import assert from "node:assert/strict";
import test from "node:test";

import {
  processAssignmentDocument,
  processPendingAssignmentDocuments,
} from "../src/services/assignmentDocuments.js";

function fixtureDocument(overrides = {}) {
  return {
    id: 7,
    account_id: "fixture",
    assignment_file_id: null,
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/SELECT account_id, assignment_file_id/.test(sql)) {
        return { rows: [{ account_id: "fixture", assignment_file_id: null }] };
      }
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [fixtureDocument()] };
      }
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
    async connect() { return { query: this.query.bind(this), release() {} }; },
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/SELECT account_id, assignment_file_id/.test(sql)) {
        return { rows: [{ account_id: "fixture", assignment_file_id: null }] };
      }
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [fixtureDocument()] };
      }
      if (/SET processing_status = 'processing'/.test(sql)) {
        return { rows: [fixtureDocument({ content: Buffer.from("bad-pdf") })] };
      }
      if (/SET processing_status = 'extraction_failed'/.test(sql)) {
        persisted.push(values[1]);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() { return { query: this.query.bind(this), release() {} }; },
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/SET processing_status = 'extraction_failed'/.test(sql)) return { rowCount: 0 };
      if (/SELECT document\.id/.test(sql)) return { rows: [] };
      if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) {
        return { rows: [{ id: 7 }] };
      }
      if (/SELECT account_id, assignment_file_id/.test(sql)) {
        return { rows: [{ account_id: "fixture", assignment_file_id: null }] };
      }
      if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [fixtureDocument()] };
      }
      if (/SET processing_status = 'processing'/.test(sql)) {
        throw new Error("private-url=https://private.example/secret-token");
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async connect() { return { query: this.query.bind(this), release() {} }; },
  };
  const result = await processPendingAssignmentDocuments(pool, { logger: { warn() {} } });
  assert.deepEqual(result, {
    attempted: 1,
    results: [{ id: 7, ok: false, error: "assignment_document_extraction_failed" }],
  });
});

for (const [status, expectedWrites] of [["signed", 0], ["draft", 1]]) {
  test(`stale Custom cleanup ${status === "signed" ? "skips" : "locks"} the workfile before mutation`, async () => {
    const trace = [];
    const pool = {
      async query(sql) {
        if (/CREATE SCHEMA IF NOT EXISTS app/.test(sql)) return { rows: [] };
        if (/SET processing_status = 'extraction_failed'/.test(sql)) {
          assert.match(sql, /assignment_file_id IS NULL/);
          return { rowCount: 0 };
        }
        if (/SELECT document\.id/.test(sql)) return { rows: [{ id: 7 }] };
        if (/SELECT id\s+FROM app\.assignment_documents/.test(sql)) {
          assert.match(sql, /workfile\.status = 'signed'/);
          return { rows: [] };
        }
        throw new Error(`unexpected pool query: ${sql}`);
      },
      async connect() {
        return {
          async query(sql) {
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (/SELECT account_id, assignment_file_id/.test(sql)) {
              trace.push("scope");
              return { rows: [{ account_id: "fixture", assignment_file_id: 9 }] };
            }
            if (/SELECT id, file_number FROM app\.assignment_files/.test(sql)) {
              return { rows: [{ id: 9, file_number: "fixture" }] };
            }
            if (/INSERT INTO app\.custom_appraisal_workfiles/.test(sql)) return { rows: [] };
            if (/SELECT workfile\.status/.test(sql)) {
              trace.push("workfile_lock");
              return { rows: [{ status, has_signed_snapshot: false }] };
            }
            if (/SELECT \* FROM app\.assignment_documents WHERE id = \$1 FOR UPDATE/.test(sql)) {
              trace.push("document_lock");
              return { rows: [fixtureDocument({ assignment_file_id: 9, processing_attempts: 5 })] };
            }
            if (/SET processing_status = 'extraction_failed'/.test(sql)) {
              trace.push("failure_update");
              return { rowCount: 1 };
            }
            throw new Error(`unexpected client query: ${sql}`);
          },
          release() {},
        };
      },
    };
    const result = await processPendingAssignmentDocuments(pool, {
      maximumAttempts: 5,
      logger: { warn() {} },
    });
    assert.equal(result.attempted, 0);
    assert.equal(trace.filter((item) => item === "failure_update").length, expectedWrites);
    assert.deepEqual(trace.slice(0, status === "signed" ? 2 : 3),
      status === "signed"
        ? ["scope", "workfile_lock"]
        : ["scope", "workfile_lock", "document_lock"]);
  });
}
