import { canonicalAssessmentJson } from "./contract.js";
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from "./customAcceptanceSnapshot.js";

/** Internal draft-export companion. The route owns workflow/assignment access.
 * Resolve the report identity independently of values inside the saved catalog,
 * and require the exact section/receipt/history in the same statement snapshot.
 * This query cannot authorize a write or substitute for signed-snapshot reads.
 */
export async function captureCustomNeighborhoodDraftReportBinding(pool, { accountId, assignmentFileId, section }) {
  const unavailable = () => { throw new Error("custom_neighborhood_saved_group_unavailable"); };
  if (typeof accountId !== "string" || !/^[0-9A-Za-z_-]{1,50}$/.test(accountId)
    || !Number.isSafeInteger(assignmentFileId) || assignmentFileId < 1) unavailable();
  if (section === undefined) {
    // Absence in an earlier workfile response is not proof this file has never
    // accepted an analysis. Refuse deletion/races rather than resurrect aliases.
    const result = await pool.query(`/* custom-neighborhood-draft:verify-absent */
      SELECT f.id AS assignment_file_id,f.account_id,
        EXISTS(SELECT 1 FROM app.custom_appraisal_workfile_sections s
          WHERE s.assignment_file_id=f.id AND s.section_key=$3) AS has_section,
        EXISTS(SELECT 1 FROM app.custom_neighborhood_acceptances accepted
          WHERE accepted.assignment_file_id=f.id) AS has_acceptance
      FROM app.assignment_files f JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=f.id
      WHERE f.id=$1 AND f.account_id=$2 AND w.status='draft' AND w.signed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM app.custom_appraisal_signed_snapshots signed WHERE signed.assignment_file_id=f.id)`,
    [assignmentFileId, accountId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
    const row = result.rows[0];
    if (result.rowCount !== 1 || result.rows.length !== 1
      || String(row.assignment_file_id) !== String(assignmentFileId) || row.account_id !== accountId
      || row.has_section !== false || row.has_acceptance !== false) unavailable();
    return null;
  }
  if (!section || !Number.isSafeInteger(section.revision) || section.revision < 1
    || !section.value || section.value.accepted_editor_revision !== section.revision) unavailable();
  const value = canonicalAssessmentJson(section.value);
  const result = await pool.query(`/* custom-neighborhood-draft:exact-report-binding */
    SELECT r.id,r.organization_id,r.account_id,r.workflow_type,r.custom_assignment_file_id,
      r.uad_workfile_id,r.tax_protest_file_id
    FROM app.assignment_files f
    JOIN app.report_files r ON r.custom_assignment_file_id=f.id AND r.organization_id=f.organization_id
      AND r.account_id=f.account_id AND r.workflow_type='custom_appraisal'
      AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
    JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=f.id AND w.status='draft' AND w.signed_at IS NULL
    JOIN app.custom_appraisal_workfile_sections s ON s.assignment_file_id=f.id AND s.section_key=$3
    JOIN app.custom_neighborhood_acceptances accepted ON accepted.assignment_file_id=f.id
      AND accepted.organization_id=f.organization_id AND accepted.report_file_id=r.id AND accepted.account_id=f.account_id
      AND accepted.operation_id::text=s.section_value->>'operation_id'
      AND accepted.accepted_editor_revision=s.revision AND accepted.section_key=s.section_key
      AND accepted.section_json_utf8::jsonb=s.section_value
    JOIN app.neighborhood_assessment_attachments attachment ON attachment.attachment_id=accepted.attachment_id
      AND attachment.attachment_revision=accepted.attachment_revision AND attachment.report_file_id=r.id
      AND attachment.organization_id=r.organization_id AND attachment.custom_assignment_file_id=f.id
      AND attachment.workflow_type='custom_appraisal' AND attachment.uad_workfile_id IS NULL
    JOIN app.neighborhood_assessment_revisions revision ON revision.assessment_id=attachment.assessment_id
      AND revision.revision=attachment.assessment_revision AND revision.publication_status='published'
    JOIN app.neighborhood_assessments assessment ON assessment.id=revision.assessment_id
      AND assessment.organization_id=r.organization_id AND assessment.account_id=r.account_id
      AND assessment.appraisal_case_id=r.appraisal_case_id AND assessment.subject_snapshot_id=r.subject_snapshot_id
    JOIN app.appraisal_cases appraisal_case ON appraisal_case.id=r.appraisal_case_id
      AND appraisal_case.organization_id=r.organization_id AND appraisal_case.account_id=r.account_id
    JOIN app.appraisal_subject_snapshots subject_snapshot ON subject_snapshot.id=r.subject_snapshot_id
      AND subject_snapshot.appraisal_case_id=appraisal_case.id
    JOIN app.custom_appraisal_workfile_section_history h ON h.id=accepted.section_history_id
      AND h.assignment_file_id=s.assignment_file_id AND h.section_key=s.section_key
      AND h.revision=s.revision AND h.section_value=s.section_value
    WHERE f.id=$1 AND f.account_id=$2 AND s.revision=$4 AND s.section_value=$5::jsonb
      AND COALESCE(subject_snapshot.effective_date,appraisal_case.effective_date)::text=revision.assessment->>'effective_date'
      AND (subject_snapshot.effective_date IS NULL OR appraisal_case.effective_date IS NULL
        OR subject_snapshot.effective_date=appraisal_case.effective_date)
      AND NOT EXISTS(SELECT 1 FROM app.custom_appraisal_signed_snapshots signed WHERE signed.assignment_file_id=f.id)`,
  [assignmentFileId, accountId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION, section.revision, value]);
  if (result.rowCount !== 1 || result.rows.length !== 1) unavailable();
  const row = result.rows[0];
  if (String(row.custom_assignment_file_id) !== String(assignmentFileId) || row.account_id !== accountId
    || row.workflow_type !== "custom_appraisal" || row.uad_workfile_id !== null || row.tax_protest_file_id !== null
    || !/^[0-9a-f-]{36}$/.test(row.organization_id) || !/^[0-9a-f-]{36}$/.test(row.id)) unavailable();
  return { report_files: [row] };
}
