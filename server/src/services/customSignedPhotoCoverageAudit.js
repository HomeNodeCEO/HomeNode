const MAX_PDF_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_METADATA_REVIEW_BYTES = 64 * 1024 * 1024;

const PHOTO_COVERAGE_AUDIT_SQL = `
  WITH signed_snapshot_photo_states AS (
    SELECT snapshot.assignment_file_id,
           BOOL_OR(jsonb_typeof(snapshot.snapshot #> '{evidence,inspection_photos}')
             IS DISTINCT FROM 'array') AS invalid_photo_manifest,
           COUNT(signed_photo.record) FILTER (
             WHERE signed_photo.record->>'status' = 'verified'
           ) AS verified_photo_count_at_signing,
           COUNT(signed_photo.record) FILTER (
             WHERE COALESCE(signed_photo.record->>'status', '')
               NOT IN ('verified', 'excluded', 'deleted')
           ) AS nonfinalized_photo_count_at_signing
      FROM app.custom_appraisal_signed_snapshots snapshot
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(snapshot.snapshot #> '{evidence,inspection_photos}') = 'array'
          THEN snapshot.snapshot #> '{evidence,inspection_photos}'
          ELSE '[]'::jsonb END
      ) AS signed_photo(record) ON true
     GROUP BY snapshot.assignment_file_id
  ), signed_file_photos AS (
    SELECT snapshot.assignment_file_id,
           COUNT(DISTINCT report.id) AS report_file_count,
           COUNT(photo.id) AS verified_photo_count,
           COUNT(photo.id) FILTER (
             WHERE renderable.id IS NULL
           ) AS missing_pdf_compatible_object_count,
           COUNT(photo.id) FILTER (
             WHERE renderable.id IS NOT NULL
               AND (renderable.byte_size IS NULL
                 OR renderable.byte_size < 1
                 OR renderable.byte_size > ${MAX_PDF_PHOTO_BYTES})
           ) AS pdf_object_size_out_of_range_count,
           COALESCE(SUM(renderable.byte_size) FILTER (
             WHERE renderable.byte_size BETWEEN 1 AND ${MAX_PDF_PHOTO_BYTES}
           ), 0) AS pdf_eligible_photo_metadata_bytes,
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
        SELECT object.id, object.byte_size
          FROM app.inspection_photo_objects object
         WHERE object.photo_id = photo.id
           AND object.status = 'verified'
           AND object.content_type IN ('image/jpeg', 'image/png')
         ORDER BY CASE object.variant WHEN 'display' THEN 0 ELSE 1 END,
                  object.id
         LIMIT 1
      ) renderable ON true
     GROUP BY snapshot.assignment_file_id
  )
  SELECT COUNT(*) AS signed_file_count,
         COUNT(*) FILTER (
           WHERE coverage.report_file_count = 0
         ) AS missing_report_file_count,
         COUNT(*) FILTER (
           WHERE signing.invalid_photo_manifest
         ) AS invalid_photo_manifest_file_count,
         COUNT(*) FILTER (
           WHERE signing.nonfinalized_photo_count_at_signing > 0
         ) AS signed_files_with_nonfinalized_photos_count,
         COALESCE(SUM(signing.verified_photo_count_at_signing), 0)
           AS verified_photo_count_at_signing,
         COALESCE(SUM(signing.nonfinalized_photo_count_at_signing), 0)
           AS nonfinalized_photo_count_at_signing,
         COALESCE(SUM(coverage.verified_photo_count), 0) AS verified_photo_count,
         COUNT(*) FILTER (
           WHERE coverage.verified_photo_count > 100
         ) AS photo_overflow_file_count,
         COALESCE(SUM(GREATEST(coverage.verified_photo_count - 100, 0)), 0)
           AS verified_photos_beyond_cap_count,
         COALESCE(SUM(coverage.missing_pdf_compatible_object_count), 0)
           AS missing_pdf_compatible_object_count,
         COALESCE(SUM(coverage.pdf_object_size_out_of_range_count), 0)
           AS pdf_object_size_out_of_range_count,
         COALESCE(MAX(coverage.pdf_eligible_photo_metadata_bytes), 0)
           AS max_pdf_eligible_photo_metadata_bytes_per_file,
         COUNT(*) FILTER (
           WHERE coverage.pdf_eligible_photo_metadata_bytes > ${PHOTO_METADATA_REVIEW_BYTES}
         ) AS signed_files_over_64mib_pdf_eligible_photo_metadata_count,
         COALESCE(SUM(coverage.cross_organization_photo_count), 0)
           AS cross_organization_photo_count,
         COALESCE(SUM(coverage.wrong_workflow_photo_count), 0)
           AS wrong_workflow_photo_count
    FROM signed_file_photos coverage
    JOIN signed_snapshot_photo_states signing
      ON signing.assignment_file_id = coverage.assignment_file_id`;

function safeCount(value) {
  const countText = String(value ?? "");
  if (!/^\d+$/.test(countText)) throw new Error("custom_signed_photo_coverage_audit_invalid_count");
  const count = Number(countText);
  if (!Number.isSafeInteger(count)) throw new Error("custom_signed_photo_coverage_audit_invalid_count");
  return count;
}

/**
 * Aggregate-only current coverage and signing-time photo-state preflight; never returns identifiers.
 * Photo byte totals use object metadata for all verified photos, including any beyond the PDF's
 * 100-photo selection cap. They are a conservative sizing diagnostic, not R2 or PDF-byte proof.
 */
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
      invalid_photo_manifest_file_count: safeCount(row.invalid_photo_manifest_file_count),
      signed_files_with_nonfinalized_photos_count: safeCount(row.signed_files_with_nonfinalized_photos_count),
      verified_photo_count_at_signing: safeCount(row.verified_photo_count_at_signing),
      nonfinalized_photo_count_at_signing: safeCount(row.nonfinalized_photo_count_at_signing),
      verified_photo_count: safeCount(row.verified_photo_count),
      photo_overflow_file_count: safeCount(row.photo_overflow_file_count),
      verified_photos_beyond_cap_count: safeCount(row.verified_photos_beyond_cap_count),
      missing_pdf_compatible_object_count: safeCount(row.missing_pdf_compatible_object_count),
      pdf_object_size_out_of_range_count: safeCount(row.pdf_object_size_out_of_range_count),
      max_pdf_eligible_photo_metadata_bytes_per_file:
        safeCount(row.max_pdf_eligible_photo_metadata_bytes_per_file),
      signed_files_over_64mib_pdf_eligible_photo_metadata_count:
        safeCount(row.signed_files_over_64mib_pdf_eligible_photo_metadata_count),
      cross_organization_photo_count: safeCount(row.cross_organization_photo_count),
      wrong_workflow_photo_count: safeCount(row.wrong_workflow_photo_count),
    };
    return {
      ok: counts.missing_report_file_count === 0
        && counts.invalid_photo_manifest_file_count === 0
        && counts.signed_files_with_nonfinalized_photos_count === 0
        && counts.photo_overflow_file_count === 0
        && counts.missing_pdf_compatible_object_count === 0
        && counts.pdf_object_size_out_of_range_count === 0
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

export const customSignedPhotoCoverageAuditInternals = Object.freeze({
  MAX_PDF_PHOTO_BYTES,
  PHOTO_METADATA_REVIEW_BYTES,
  PHOTO_COVERAGE_AUDIT_SQL,
});
