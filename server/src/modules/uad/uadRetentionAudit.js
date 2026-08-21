const DEFAULT_REVIEW_DAYS = 5 * 365;

function boundedReviewDays(value) {
  return Math.max(365, Math.min(Number(value) || DEFAULT_REVIEW_DAYS, 10 * 365));
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [
    key,
    value == null ? null : Number(value),
  ]));
}

export async function auditUadRetention(pool, { reviewDays = DEFAULT_REVIEW_DAYS } = {}) {
  const days = boundedReviewDays(reviewDays);
  const [workfiles, assets, artifacts, compliance] = await Promise.all([
    pool.query(
      `SELECT count(*)::bigint AS total,
              count(*) FILTER (WHERE status IN ('signed', 'exported', 'submitted'))::bigint AS finalized,
              count(*) FILTER (
                WHERE status IN ('cancelled', 'revised')
                  AND updated_at < now() - ($1::integer * interval '1 day')
              )::bigint AS review_candidates
         FROM appraisal.uad_workfiles`,
      [days],
    ),
    pool.query(
      `SELECT count(*)::bigint AS total,
              count(*) FILTER (WHERE status = 'verified')::bigint AS verified,
              count(*) FILTER (
                WHERE status IN ('pending_upload', 'rejected', 'deleted')
                  AND updated_at < now() - ($1::integer * interval '1 day')
              )::bigint AS review_candidates
         FROM appraisal.uad_assets`,
      [days],
    ),
    pool.query(
      `SELECT count(*)::bigint AS total,
              count(*) FILTER (WHERE generation_status = 'ready')::bigint AS ready,
              count(*) FILTER (
                WHERE generation_status IN ('failed', 'superseded')
                  AND created_at < now() - ($1::integer * interval '1 day')
              )::bigint AS review_candidates
         FROM appraisal.uad_generated_artifacts`,
      [days],
    ),
    pool.query(
      `SELECT count(*)::bigint AS total,
              count(*) FILTER (WHERE response_payload IS NOT NULL)::bigint AS raw_response_count,
              count(*) FILTER (
                WHERE response_payload IS NOT NULL
                  AND started_at < now() - ($1::integer * interval '1 day')
              )::bigint AS raw_response_review_candidates
         FROM appraisal.uad_compliance_exchanges`,
      [days],
    ),
  ]);

  return Object.freeze({
    ok: true,
    mode: "review_only",
    automatic_deletion: false,
    review_threshold_days: days,
    legal_hold_review_required_before_deletion: true,
    aggregates: Object.freeze({
      workfiles: Object.freeze(numericRow(workfiles.rows[0])),
      assets: Object.freeze(numericRow(assets.rows[0])),
      generated_artifacts: Object.freeze(numericRow(artifacts.rows[0])),
      compliance_exchanges: Object.freeze(numericRow(compliance.rows[0])),
    }),
  });
}
