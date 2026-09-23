const SIGNED_ARTIFACT_AUDIT_SQL = `
  SELECT COUNT(*) AS signed_snapshot_count,
         COUNT(artifact.assignment_file_id) AS artifact_count,
         COUNT(*) FILTER (
           WHERE artifact.assignment_file_id IS NULL
         ) AS missing_artifact_count,
         COUNT(*) FILTER (
           WHERE artifact.assignment_file_id IS NOT NULL
             AND artifact.signed_snapshot_id IS DISTINCT FROM snapshot.id
         ) AS snapshot_link_mismatch_count,
         COUNT(*) FILTER (
           WHERE artifact.assignment_file_id IS NOT NULL
             AND artifact.workfile_checksum_sha256 IS DISTINCT FROM snapshot.checksum_sha256
         ) AS checksum_mismatch_count
    FROM app.custom_appraisal_signed_snapshots snapshot
    LEFT JOIN app.custom_appraisal_report_artifacts artifact
      ON artifact.assignment_file_id = snapshot.assignment_file_id`;

function safeCount(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error("custom_signed_artifact_audit_invalid_count");
  const count = Number(text);
  if (!Number.isSafeInteger(count)) throw new Error("custom_signed_artifact_audit_invalid_count");
  return count;
}

/** Aggregate-only, read-only preflight for a future signed-PDF storage migration. */
export async function auditCustomSignedArtifacts(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("custom_signed_artifact_audit_pool_required");
  }
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new Error("custom_signed_artifact_audit_failed");
  }
  let transactionStarted = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const schema = await client.query(`
      SELECT to_regclass('app.custom_appraisal_signed_snapshots') IS NOT NULL AS snapshots_present,
             to_regclass('app.custom_appraisal_report_artifacts') IS NOT NULL AS artifacts_present`);
    if (schema.rows[0]?.snapshots_present !== true || schema.rows[0]?.artifacts_present !== true) {
      return { ok: false, code: "custom_signed_artifact_schema_missing" };
    }
    const result = await client.query(SIGNED_ARTIFACT_AUDIT_SQL);
    const row = result.rows[0] || {};
    const counts = {
      signed_snapshot_count: safeCount(row.signed_snapshot_count),
      artifact_count: safeCount(row.artifact_count),
      missing_artifact_count: safeCount(row.missing_artifact_count),
      snapshot_link_mismatch_count: safeCount(row.snapshot_link_mismatch_count),
      checksum_mismatch_count: safeCount(row.checksum_mismatch_count),
    };
    return {
      ok: counts.missing_artifact_count === 0
        && counts.snapshot_link_mismatch_count === 0
        && counts.checksum_mismatch_count === 0,
      ...counts,
    };
  } catch {
    throw new Error("custom_signed_artifact_audit_failed");
  } finally {
    let rollbackFailed = false;
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    client.release(rollbackFailed ? new Error("custom_signed_artifact_audit_failed") : undefined);
    if (rollbackFailed) throw new Error("custom_signed_artifact_audit_failed");
  }
}

export const customSignedArtifactAuditInternals = Object.freeze({
  SIGNED_ARTIFACT_AUDIT_SQL,
});
