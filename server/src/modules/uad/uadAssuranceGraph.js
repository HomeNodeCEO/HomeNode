const ASSURANCE_CHECKS = Object.freeze([
  Object.freeze({
    code: "revision_chain_incomplete",
    query: `
      WITH revision_stats AS (
        SELECT workfile_id, count(*)::integer AS revision_count,
               min(revision_number)::integer AS minimum_revision,
               max(revision_number)::integer AS maximum_revision
          FROM appraisal.uad_revisions
         GROUP BY workfile_id
      )
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_workfiles workfile
        LEFT JOIN revision_stats revision ON revision.workfile_id = workfile.id
       WHERE COALESCE(revision.minimum_revision, 0) <> 1
          OR COALESCE(revision.maximum_revision, 0) <> workfile.current_revision
          OR COALESCE(revision.revision_count, 0) <> workfile.current_revision`,
  }),
  Object.freeze({
    code: "field_entity_cross_workfile",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_field_values value
        JOIN appraisal.uad_entities entity ON entity.id = value.entity_id
       WHERE value.workfile_id <> entity.workfile_id`,
  }),
  Object.freeze({
    code: "entity_parent_cross_workfile",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_entities child
        JOIN appraisal.uad_entities parent ON parent.id = child.parent_entity_id
       WHERE child.workfile_id <> parent.workfile_id`,
  }),
  Object.freeze({
    code: "validation_revision_missing",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_validation_runs validation
        LEFT JOIN appraisal.uad_revisions revision
          ON revision.workfile_id = validation.workfile_id
         AND revision.revision_number = validation.revision_number
       WHERE revision.id IS NULL`,
  }),
  Object.freeze({
    code: "signature_revision_missing",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_signatures signature
        LEFT JOIN appraisal.uad_revisions revision
          ON revision.workfile_id = signature.workfile_id
         AND revision.revision_number = signature.revision_number
       WHERE revision.id IS NULL`,
  }),
  Object.freeze({
    code: "artifact_revision_missing",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_generated_artifacts artifact
        LEFT JOIN appraisal.uad_revisions revision
          ON revision.workfile_id = artifact.workfile_id
         AND revision.revision_number = artifact.revision_number
       WHERE revision.id IS NULL`,
  }),
  Object.freeze({
    code: "ready_artifact_integrity_incomplete",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_generated_artifacts
       WHERE generation_status = 'ready'
         AND (object_key IS NULL OR object_key = '' OR byte_size IS NULL OR byte_size <= 0
           OR checksum_sha256 IS NULL OR checksum_sha256 !~ '^[0-9a-f]{64}$')`,
  }),
  Object.freeze({
    code: "verified_asset_integrity_incomplete",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_assets
       WHERE status = 'verified'
         AND (object_key IS NULL OR object_key = '' OR byte_size IS NULL OR byte_size <= 0
           OR checksum_sha256 IS NULL OR checksum_sha256 !~ '^[0-9a-f]{64}$')`,
  }),
  Object.freeze({
    code: "signed_status_without_current_signature",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.uad_workfiles workfile
       WHERE workfile.status IN ('signed', 'submitted')
         AND NOT EXISTS (
           SELECT 1 FROM appraisal.uad_signatures signature
            WHERE signature.workfile_id = workfile.id
              AND signature.revision_number = workfile.current_revision
         )`,
  }),
  Object.freeze({
    code: "delivery_artifact_identity_mismatch",
    query: `
      SELECT count(*)::integer AS finding_count
        FROM appraisal.delivery_attempts attempt
        JOIN appraisal.uad_generated_artifacts artifact ON artifact.id = attempt.artifact_id
       WHERE artifact.workfile_id <> attempt.workfile_id
          OR artifact.revision_number <> attempt.revision_number
          OR artifact.checksum_sha256 IS DISTINCT FROM attempt.package_checksum_sha256
          OR artifact.artifact_type <> 'submission_package'`,
  }),
]);

const NODE_COUNT_QUERY = `
  SELECT
    (SELECT count(*)::integer FROM appraisal.uad_workfiles) AS workfiles,
    (SELECT count(*)::integer FROM appraisal.uad_revisions) AS revisions,
    (SELECT count(*)::integer FROM appraisal.uad_entities) AS entities,
    (SELECT count(*)::integer FROM appraisal.uad_field_values) AS field_values,
    (SELECT count(*)::integer FROM appraisal.uad_assets) AS assets,
    (SELECT count(*)::integer FROM appraisal.uad_validation_runs) AS validations,
    (SELECT count(*)::integer FROM appraisal.uad_signatures) AS signatures,
    (SELECT count(*)::integer FROM appraisal.uad_generated_artifacts) AS artifacts,
    (SELECT count(*)::integer FROM appraisal.delivery_attempts) AS delivery_attempts`;

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function summarizeUadAssuranceGraph(nodeRow = {}, checkRows = []) {
  const nodes = Object.freeze(Object.fromEntries(
    Object.entries(nodeRow).map(([key, value]) => [key, safeCount(value)]),
  ));
  const checks = Object.freeze(checkRows.map((item) => Object.freeze({
    code: item.code,
    finding_count: safeCount(item.finding_count),
    passed: safeCount(item.finding_count) === 0,
  })));
  const findingCount = checks.reduce((total, check) => total + check.finding_count, 0);
  return Object.freeze({
    ok: findingCount === 0,
    profile: "uad_assurance_graph_v1",
    checked_at: new Date().toISOString(),
    nodes,
    checks,
    finding_count: findingCount,
  });
}

export async function auditUadAssuranceGraph(pool) {
  const nodeResult = await pool.query(NODE_COUNT_QUERY);
  const checkRows = [];
  for (const check of ASSURANCE_CHECKS) {
    const result = await pool.query(check.query);
    checkRows.push({ code: check.code, finding_count: result.rows[0]?.finding_count });
  }
  return summarizeUadAssuranceGraph(nodeResult.rows[0], checkRows);
}
