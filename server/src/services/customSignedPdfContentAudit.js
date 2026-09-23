const CONTENT_AUDIT_SQL = `
  SELECT COUNT(*) AS artifact_count,
         COUNT(*) FILTER (
           WHERE encode(sha256(content), 'hex') IS DISTINCT FROM content_sha256
         ) AS content_digest_mismatch_count,
         COUNT(*) FILTER (
           WHERE substring(content from 1 for 5)
             IS DISTINCT FROM decode('255044462d', 'hex')
         ) AS pdf_header_mismatch_count,
         COUNT(*) FILTER (
           WHERE octet_length(content) IS DISTINCT FROM byte_size
         ) AS byte_length_mismatch_count
    FROM app.custom_appraisal_report_artifacts`;

function safeCount(value) {
  const valueText = String(value ?? "");
  if (!/^\d+$/.test(valueText)) throw new Error("custom_signed_pdf_content_audit_invalid_count");
  const count = Number(valueText);
  if (!Number.isSafeInteger(count)) throw new Error("custom_signed_pdf_content_audit_invalid_count");
  return count;
}

/** Opt-in, aggregate-only database-side digest verification; never returns PDF bytes or file IDs. */
export async function auditCustomSignedPdfContent(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("custom_signed_pdf_content_audit_pool_required");
  }
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new Error("custom_signed_pdf_content_audit_failed");
  }
  let transactionStarted = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const schema = await client.query(
      "SELECT to_regclass('app.custom_appraisal_report_artifacts') IS NOT NULL AS artifacts_present",
    );
    if (schema.rows[0]?.artifacts_present !== true) {
      return { ok: false, code: "custom_signed_pdf_content_schema_missing" };
    }
    const row = (await client.query(CONTENT_AUDIT_SQL)).rows[0] || {};
    const counts = {
      artifact_count: safeCount(row.artifact_count),
      content_digest_mismatch_count: safeCount(row.content_digest_mismatch_count),
      pdf_header_mismatch_count: safeCount(row.pdf_header_mismatch_count),
      byte_length_mismatch_count: safeCount(row.byte_length_mismatch_count),
    };
    return {
      ok: counts.content_digest_mismatch_count === 0
        && counts.pdf_header_mismatch_count === 0
        && counts.byte_length_mismatch_count === 0,
      ...counts,
    };
  } catch {
    throw new Error("custom_signed_pdf_content_audit_failed");
  } finally {
    let rollbackFailed = false;
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    client.release(rollbackFailed ? new Error("custom_signed_pdf_content_audit_failed") : undefined);
    if (rollbackFailed) throw new Error("custom_signed_pdf_content_audit_failed");
  }
}

export const customSignedPdfContentAuditInternals = Object.freeze({ CONTENT_AUDIT_SQL });
