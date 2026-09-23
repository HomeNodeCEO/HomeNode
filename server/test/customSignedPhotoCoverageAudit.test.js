import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  auditCustomSignedPhotoCoverage,
  customSignedPhotoCoverageAuditInternals,
} from "../src/services/customSignedPhotoCoverageAudit.js";

const SCHEMA = {
  snapshots_present: true,
  reports_present: true,
  photos_present: true,
  objects_present: true,
};

function fakePool({ schema = SCHEMA, counts = {}, fail = false, failRollback = false } = {}) {
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
          if (fail && sql.includes("WITH signed_file_photos")) throw new Error("private database detail");
          if (sql.includes("to_regclass")) return { rows: [schema] };
          if (sql.includes("WITH signed_file_photos")) {
            return { rows: [{
              signed_file_count: "3",
              missing_report_file_count: "0",
              verified_photo_count: "30",
              photo_overflow_file_count: "0",
              verified_photos_beyond_cap_count: "0",
              missing_pdf_compatible_object_count: "0",
              cross_organization_photo_count: "0",
              wrong_workflow_photo_count: "0",
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

test("audits current signed-photo coverage without returning file or photo identifiers", async () => {
  const pool = fakePool();
  assert.deepEqual(await auditCustomSignedPhotoCoverage(pool), {
    ok: true,
    signed_file_count: 3,
    missing_report_file_count: 0,
    verified_photo_count: 30,
    photo_overflow_file_count: 0,
    verified_photos_beyond_cap_count: 0,
    missing_pdf_compatible_object_count: 0,
    cross_organization_photo_count: 0,
    wrong_workflow_photo_count: 0,
  });
  assert.equal(pool.calls[0], "BEGIN READ ONLY");
  assert.equal(pool.calls.at(-1), "ROLLBACK");
  assert.equal(pool.released, true);
  assert.doesNotMatch(pool.calls.join("\n"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  const sql = customSignedPhotoCoverageAuditInternals.PHOTO_COVERAGE_AUDIT_SQL;
  assert.match(sql, /photo\.status = 'verified'/);
  assert.match(sql, /object\.content_type IN \('image\/jpeg', 'image\/png'\)/);
  assert.match(sql, /verified_photo_count > 100/);
  assert.doesNotMatch(sql, /SELECT\s+(?:photo\.id|snapshot\.assignment_file_id)\s+FROM/i);
});

test("audit threshold stays aligned with the signed-PDF photo cap", async () => {
  const reportSource = await readFile(new URL("../src/services/customAppraisalReportPdf.js", import.meta.url), "utf8");
  assert.match(reportSource, /const MAX_REPORT_PHOTOS = 100;/);
  assert.match(customSignedPhotoCoverageAuditInternals.PHOTO_COVERAGE_AUDIT_SQL, /verified_photo_count > 100/);
});

test("reports current overflow, missing object metadata, and ownership mismatch", async () => {
  const pool = fakePool({ counts: {
    missing_report_file_count: "1",
    photo_overflow_file_count: "1",
    verified_photos_beyond_cap_count: "4",
    missing_pdf_compatible_object_count: "2",
    cross_organization_photo_count: "1",
    wrong_workflow_photo_count: "1",
  } });
  const result = await auditCustomSignedPhotoCoverage(pool);
  assert.equal(result.ok, false);
  assert.equal(result.verified_photos_beyond_cap_count, 4);
  assert.equal(result.missing_pdf_compatible_object_count, 2);
  assert.equal(result.wrong_workflow_photo_count, 1);
  assert.equal(JSON.stringify(result).includes("assignment_file_id"), false);
});

test("missing schema and query/rollback failures return stable codes", async () => {
  const missing = fakePool({ schema: { ...SCHEMA, objects_present: false } });
  assert.deepEqual(await auditCustomSignedPhotoCoverage(missing), {
    ok: false, code: "custom_signed_photo_coverage_schema_missing",
  });
  assert.equal(missing.calls.at(-1), "ROLLBACK");
  const failed = fakePool({ fail: true });
  await assert.rejects(auditCustomSignedPhotoCoverage(failed), /custom_signed_photo_coverage_audit_failed/);
  assert.equal(failed.calls.at(-1), "ROLLBACK");
  const invalid = fakePool({ counts: { verified_photo_count: "NaN" } });
  await assert.rejects(auditCustomSignedPhotoCoverage(invalid), /custom_signed_photo_coverage_audit_failed/);
  const rollbackFailed = fakePool({ failRollback: true });
  await assert.rejects(auditCustomSignedPhotoCoverage(rollbackFailed), /custom_signed_photo_coverage_audit_failed/);
  assert.match(rollbackFailed.releaseError?.message || "", /custom_signed_photo_coverage_audit_failed/);
  await assert.rejects(
    auditCustomSignedPhotoCoverage({ async connect() { throw new Error("private URL"); } }),
    /custom_signed_photo_coverage_audit_failed/,
  );
});
