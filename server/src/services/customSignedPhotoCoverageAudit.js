const PHOTO_COVERAGE_AUDIT_SQL = `
  WITH signed_file_photos AS (
    SELECT snapshot.assignment_file_id,
           report.id AS report_file_id,
           COUNT(photo.id) AS verified_photo_count,
           COUNT(photo.id) FILTER (
             WHERE renderable.id IS NULL
           ) AS missing_pdf_compatible_object_count,
           COUNT(photo.id) FILTER (
             WHERE photo.organization_id IS DISTINCT FROM report.organization_id
           ) AS cross_organization_photo_count,
           COUNT(photo.id) FILTER (
             WHERE photo.workflow_type IS DISTINCT FROM 'custom_appraisal'
           ) AS wrong_workflow_photo_count
      FROM app.custom_appraisal_signed_snapshots snapshot
      LEFT JOIN app.report_files report
        ON report.custom_assignment_file_id = snapshot.assignment_file_id
       AND report.workflow_type = 'custom_appraisal'
      LEFT JOIN app.inspection_photos photo
        ON photo.report_file_id = report.id
       AND photo.status = 'verified'
      LEFT JOIN LATERAL (
        SELECT object.id
          FROM app.inspection_photo_objects object
         WHERE object.photo_id = photo.id
           AND object.status = 'verified'
           AND object.content_type IN ('image/jpeg', 'image/png')
         LIMIT 1
      ) renderable ON true
     GROUP BY snapshot.assignment_file_id, report.id
  )
  SELECT COUNT(*) AS signed_file_count,
         COUNT(*) FILTER (
           WHERE report_file_id IS NULL
         ) AS missing_report_file_count,
         COALESCE(SUM(verified_photo_count), 0) AS verified_photo_count,
         COUNT(*) FILTER (
           WHERE verified_photo_count > 100
         ) AS photo_overflow_file_count,
         COALESCE(SUM(GREATEST(verified_photo_count - 100, 0)), 0)
           AS verified_photos_beyond_cap_count,
         COALESCE(SUM(missing_pdf_compatible_object_count), 0)
           AS missing_pdf_compatible_object_count,
         COALESCE(SUM(cross_organization_photo_count), 0)
           AS cross_organization_photo_count,
         COALESCE(SUM(wrong_workflow_photo_count), 0)
           AS wrong_workflow_photo_count
    FROM signed_file_photos`;

function safeCount(value) {
  const countText = String(value ?? "");
  if (!/^\d+$/.test(countText)) throw new Error("custom_signed_photo_coverage_audit_invalid_count");
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) throw new Error("custom_signed_photo_coverage_audit_invalid_count");
  return count;
}

/** Current-state, aggregate-only photo coverage preflight; never returns photo/file identifiers. */
export async function auditCustomSignedPhotoCoverage(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("custom_signed_photo_coverage_audit_pool_required");
  }
  let client;
  try {
    client = await pool.connect();
  } catch {
    throw new Error("custom_signed_photo_coverage_audit_failed");
  }
  let transactionStarted = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const schema = await client.query(`
      SELECT to_regclass('app.custom_appraisal_signed_snapshots') IS NOT NULL AS snapshots_present,
             to_regclass('app.report_files') IS NOT NULL AS reports_present,
             to_regclass('app.inspection_photos') IS NOT NULL AS photos_present,
             to_regclass('app.inspection_photo_objects') IS NOT NULL AS objects_present`);
    if (!schema.rows[0] || Object.values(schema.rows[0]).some((value) => value !== true)) {
      return { ok: false, code: "custom_signed_photo_coverage_schema_missing" };
    }
    const row = (await client.query(PHOTO_COVERAGE_AUDIT_SQL)).rows[0] || {};
    const counts = {
      signed_file_count: safeCount(row.signed_file_count),
      missing_report_file_count: safeCount(row.missing_report_file_count),
      verified_photo_count: safeCount(row.verified_photo_count),
      photo_overflow_file_count: safeCount(row.photo_overflow_file_count),
      verified_photos_beyond_cap_count: safeCount(row.verified_photos_beyond_cap_count),
      missing_pdf_compatible_object_count: safeCount(row.missing_pdf_compatible_object_count),
      cross_organization_photo_count: safeCount(row.cross_organization_photo_count),
      wrong_workflow_photo_count: safeCount(row.wrong_workflow_photo_count),
    };
    return {
      ok: counts.missing_report_file_count === 0
        && counts.photo_overflow_file_count === 0
        && counts.missing_pdf_compatible_object_count === 0
        && counts.cross_organization_photo_count === 0
        && counts.wrong_workflow_photo_count === 0,
      ...counts,
    };
  } catch {
    throw new Error("custom_signed_photo_coverage_audit_failed");
  } finally {
    let rollbackFailed = false;
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        rollbackFailed = true;
      }
    }
    client.release(rollbackFailed ? new Error("custom_signed_photo_coverage_audit_failed") : undefined);
    if (rollbackFailed) throw new Error("custom_signed_photo_coverage_audit_failed");
  }
}

export const customSignedPhotoCoverageAuditInternals = Object.freeze({ PHOTO_COVERAGE_AUDIT_SQL });
