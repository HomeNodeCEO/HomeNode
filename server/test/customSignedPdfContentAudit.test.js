import assert from "node:assert/strict";
import test from "node:test";

import {
  auditCustomSignedPdfContent,
  customSignedPdfContentAuditInternals,
} from "../src/services/customSignedPdfContentAudit.js";

function fakePool({ schema = true, counts = {}, fail = false, failRollback = false } = {}) {
  const calls = [];
  let released = false;
  let releaseError = null;
  return {
    calls,
    get released() { return released; },
    get releaseError() { return releaseError; },
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (failRollback && sql === "ROLLBACK") throw new Error("private rollback detail");
          if (fail && sql.includes("FROM app.custom_appraisal_report_artifacts")) {
            throw new Error("private database detail");
          }
          if (sql.includes("to_regclass")) return { rows: [{ artifacts_present: schema }] };
          if (sql.includes("FROM app.custom_appraisal_report_artifacts")) {
            return { rows: [{
              artifact_count: "3",
              content_digest_mismatch_count: "0",
              pdf_header_mismatch_count: "0",
              byte_length_mismatch_count: "0",
              ...counts,
            }] };
          }
          return { rows: [] };
        },
        release(error) { released = true; releaseError = error; },
      };
    },
  };
}

test("verifies PDF bytes in PostgreSQL without returning content or identifiers", async () => {
  const pool = fakePool();
  assert.deepEqual(await auditCustomSignedPdfContent(pool), {
    ok: true,
    artifact_count: 3,
    content_digest_mismatch_count: 0,
    pdf_header_mismatch_count: 0,
    byte_length_mismatch_count: 0,
  });
  assert.equal(pool.calls[0], "BEGIN READ ONLY");
  assert.equal(pool.calls.at(-1), "ROLLBACK");
  assert.equal(pool.released, true);
  assert.doesNotMatch(pool.calls.join("\n"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.match(customSignedPdfContentAuditInternals.CONTENT_AUDIT_SQL, /sha256\(content\)/);
  assert.doesNotMatch(customSignedPdfContentAuditInternals.CONTENT_AUDIT_SQL, /SELECT\s+(?:content|assignment_file_id)\b/i);
});

test("reports digest, PDF header, and byte-length mismatch counts", async () => {
  const pool = fakePool({ counts: {
    content_digest_mismatch_count: "2",
    pdf_header_mismatch_count: "1",
    byte_length_mismatch_count: "1",
  } });
  const result = await auditCustomSignedPdfContent(pool);
  assert.equal(result.ok, false);
  assert.equal(result.content_digest_mismatch_count, 2);
  assert.equal(result.pdf_header_mismatch_count, 1);
  assert.equal(result.byte_length_mismatch_count, 1);
  assert.equal(JSON.stringify(result).includes("assignment_file_id"), false);
});

test("missing schema and failures are closed and secret-free", async () => {
  const missing = fakePool({ schema: false });
  assert.deepEqual(await auditCustomSignedPdfContent(missing), {
    ok: false, code: "custom_signed_pdf_content_schema_missing",
  });
  assert.equal(missing.calls.at(-1), "ROLLBACK");
  const failed = fakePool({ fail: true });
  await assert.rejects(auditCustomSignedPdfContent(failed), /^Error: custom_signed_pdf_content_audit_failed$/);
  assert.equal(failed.calls.at(-1), "ROLLBACK");
  const invalid = fakePool({ counts: { artifact_count: "bad" } });
  await assert.rejects(auditCustomSignedPdfContent(invalid), /custom_signed_pdf_content_audit_failed/);
  const rollbackFailed = fakePool({ failRollback: true });
  await assert.rejects(auditCustomSignedPdfContent(rollbackFailed), /custom_signed_pdf_content_audit_failed/);
  assert.match(rollbackFailed.releaseError?.message || "", /custom_signed_pdf_content_audit_failed/);
  await assert.rejects(
    auditCustomSignedPdfContent({ async connect() { throw new Error("secret connection detail"); } }),
    /^Error: custom_signed_pdf_content_audit_failed$/,
  );
});
