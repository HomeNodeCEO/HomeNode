import assert from "node:assert/strict";
import test from "node:test";

import {
  auditCustomSignedArtifacts,
  customSignedArtifactAuditInternals,
} from "../src/services/customSignedArtifactAudit.js";

function fakePool({ schema = { snapshots_present: true, artifacts_present: true }, counts = {}, fail = false, failRollback = false } = {}) {
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
          if (failRollback && sql === "ROLLBACK") throw new Error("private rollback diagnostic");
          if (fail && sql.includes("FROM app.custom_appraisal_signed_snapshots snapshot")) {
            throw new Error("private database diagnostic");
          }
          if (sql.includes("to_regclass")) return { rows: [schema] };
          if (sql.includes("FROM app.custom_appraisal_signed_snapshots snapshot")) {
            return { rows: [{
              signed_snapshot_count: "3",
              artifact_count: "3",
              missing_artifact_count: "0",
              snapshot_link_mismatch_count: "0",
              checksum_mismatch_count: "0",
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

test("audits signed-PDF parity through an aggregate-only read transaction", async () => {
  const pool = fakePool();
  const result = await auditCustomSignedArtifacts(pool);
  assert.deepEqual(result, {
    ok: true,
    signed_snapshot_count: 3,
    artifact_count: 3,
    missing_artifact_count: 0,
    snapshot_link_mismatch_count: 0,
    checksum_mismatch_count: 0,
  });
  assert.equal(pool.calls[0], "BEGIN READ ONLY");
  assert.equal(pool.calls.at(-1), "ROLLBACK");
  assert.equal(pool.released, true);
  assert.doesNotMatch(pool.calls.join("\n"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
  assert.doesNotMatch(customSignedArtifactAuditInternals.SIGNED_ARTIFACT_AUDIT_SQL, /SELECT\s+snapshot\.id|assignment_file\.file_number/i);
});

test("reports only counts for missing or mismatched signed artifacts", async () => {
  const pool = fakePool({ counts: {
    artifact_count: "1",
    missing_artifact_count: "2",
    checksum_mismatch_count: "1",
  } });
  const result = await auditCustomSignedArtifacts(pool);
  assert.equal(result.ok, false);
  assert.equal(result.missing_artifact_count, 2);
  assert.equal(result.checksum_mismatch_count, 1);
  assert.equal(JSON.stringify(result).includes("assignment_file_id"), false);
});

test("fails closed on missing schema or database errors without exposing diagnostics", async () => {
  const missing = fakePool({ schema: { snapshots_present: true, artifacts_present: false } });
  assert.deepEqual(await auditCustomSignedArtifacts(missing), {
    ok: false, code: "custom_signed_artifact_schema_missing",
  });
  assert.equal(missing.calls.at(-1), "ROLLBACK");
  const failed = fakePool({ fail: true });
  await assert.rejects(auditCustomSignedArtifacts(failed), /custom_signed_artifact_audit_failed/);
  assert.equal(failed.calls.at(-1), "ROLLBACK");
  assert.equal(failed.released, true);
  const invalid = fakePool({ counts: { signed_snapshot_count: "not-a-count" } });
  await assert.rejects(auditCustomSignedArtifacts(invalid), /custom_signed_artifact_audit_failed/);
  assert.equal(invalid.calls.at(-1), "ROLLBACK");
  await assert.rejects(
    auditCustomSignedArtifacts({ async connect() { throw new Error("private connection detail"); } }),
    /custom_signed_artifact_audit_failed/,
  );
  await assert.rejects(
    auditCustomSignedArtifacts({ connect() { throw new Error("private synchronous connection detail"); } }),
    /custom_signed_artifact_audit_failed/,
  );
  const rollbackFailed = fakePool({ failRollback: true });
  await assert.rejects(auditCustomSignedArtifacts(rollbackFailed), /custom_signed_artifact_audit_failed/);
  assert.equal(rollbackFailed.released, true);
  assert.match(rollbackFailed.releaseError?.message || "", /custom_signed_artifact_audit_failed/);
});
