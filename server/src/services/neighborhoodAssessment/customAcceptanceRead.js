import { decideAssignmentAccess } from "../../security/assignmentAccess.js";
import { canonicalAssessmentJson } from "./contract.js";
import { getCustomNeighborhoodAcceptance } from "./customAcceptanceRepository.js";
import { CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION } from "./customAcceptanceSnapshot.js";
import { projectCustomNeighborhoodReportSection } from "./customReportMapping.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function unavailable() { throw new Error("custom_neighborhood_saved_group_unavailable"); }

/** Editor-only read. Authorization, the current section and its exact acceptance
 * are resolved in one read-only snapshot, never through account/latest fallbacks.
 * The route still owns workflow authentication. This rechecks the existing
 * assignment policy using the server identity and the same snapshot as the data.
 * Does not create a workfile, issue an Apply receipt, update history or replace
 * signed artifacts. Call only after migrations/readiness have completed.
 */
export async function loadCustomNeighborhoodAcceptance(pool, input) {
  if (typeof pool?.connect !== "function") throw new TypeError("custom_neighborhood_read_pool_required");
  const captured = JSON.parse(canonicalAssessmentJson(input));
  if (!captured || typeof captured !== "object" || Array.isArray(captured)
    || JSON.stringify(Object.keys(captured).sort()) !== JSON.stringify(["accountId", "assignmentFileId", "auth"])) {
    throw new TypeError("invalid_custom_neighborhood_read_input");
  }
  const { accountId, assignmentFileId, auth } = captured;
  if (typeof accountId !== "string" || !/^[0-9A-Za-z_-]{1,50}$/.test(accountId)) {
    throw new TypeError("invalid_account_id");
  }
  if (!Number.isSafeInteger(assignmentFileId) || assignmentFileId < 1) {
    throw new TypeError("invalid_assignment_file_id");
  }
  if (typeof auth?.userId !== "string" || !auth.userId.trim()) throw new Error("authentication_required");
  const client = await pool.connect();
  let transactionOpen = false, discard;
  try {
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); }
    catch (error) { discard = error; throw error; }
    transactionOpen = true;
    const result = await client.query(`/* custom-neighborhood-read:current-target */
      SELECT a.id AS assignment_file_id,a.account_id,a.organization_id,
        a.assigned_appraiser_user_id,a.supervisory_appraiser_user_id,
        r.id AS report_file_id,w.status AS workfile_status,w.signed_at,
        EXISTS(SELECT 1 FROM app.custom_appraisal_signed_snapshots signed
          WHERE signed.assignment_file_id=a.id) AS has_signed_snapshot,
        EXISTS(SELECT 1 FROM app.custom_neighborhood_acceptances accepted
          WHERE accepted.assignment_file_id=a.id AND accepted.organization_id=a.organization_id
            AND accepted.account_id=a.account_id) AS has_neighborhood_acceptance,
        s.section_key,s.section_value,s.revision AS section_revision
      FROM app.assignment_files a
      LEFT JOIN app.report_files r ON r.custom_assignment_file_id=a.id
        AND r.organization_id=a.organization_id AND r.account_id=a.account_id
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
      LEFT JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      LEFT JOIN app.custom_appraisal_workfile_sections s ON s.assignment_file_id=a.id AND s.section_key=$3
      WHERE a.id=$1 AND a.account_id=$2`, [assignmentFileId, accountId, CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION]);
    if (result.rowCount === 0) throw new Error("assignment_file_not_found");
    if (result.rowCount !== 1 || result.rows.length !== 1) unavailable();
    const row = result.rows[0];
    if (String(row.assignment_file_id) !== String(assignmentFileId) || row.account_id !== accountId) unavailable();
    if (!decideAssignmentAccess(auth, row, "read")) throw new Error("assignment_file_access_denied");
    // Live editor reads are not a substitute for the immutable signed download.
    if (row.workfile_status === "signed" || row.signed_at !== null || row.has_signed_snapshot === true) {
      throw new Error("custom_neighborhood_signed_snapshot_required");
    }
    if (row.workfile_status !== null && row.workfile_status !== "draft") unavailable();
    if (row.section_key === null && row.has_neighborhood_acceptance === true) unavailable();
    let output = { status: "not_accepted", account_id: accountId, assignment_file_id: assignmentFileId,
      report_file_id: row.report_file_id, acceptance: null };
    if (row.section_key !== null) {
      const section = row.section_value;
      if (row.workfile_status !== "draft" || row.section_key !== CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION
        || !UUID.test(row.organization_id) || !UUID.test(row.report_file_id)
        || !section || typeof section !== "object" || Array.isArray(section)
        || !UUID.test(section.operation_id) || !Number.isSafeInteger(row.section_revision)
        || row.section_revision < 1 || section.accepted_editor_revision !== row.section_revision) unavailable();
      const acceptance = await getCustomNeighborhoodAcceptance(client, {
        organizationId: row.organization_id, reportFileId: row.report_file_id,
        assignmentFileId, operationId: section.operation_id,
      });
      if (!acceptance || acceptance.acceptedEditorRevision !== row.section_revision
        || canonicalAssessmentJson(acceptance.snapshot.section_value) !== canonicalAssessmentJson(section)) unavailable();
      const reportProjection = projectCustomNeighborhoodReportSection({ section, expected: {
        organization_id: row.organization_id, report_file_id: row.report_file_id,
        assignment_file_id: assignmentFileId, account_id: accountId,
      } });
      output = { ...output, status: "accepted", acceptance, report_projection: reportProjection };
    }
    try { await client.query("COMMIT"); }
    catch (error) { discard = error; throw error; }
    transactionOpen = false;
    return Object.freeze(output);
  } catch (error) {
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discard = rollbackError;
        throw new AggregateError([error, rollbackError], "custom_neighborhood_read_rollback_failed");
      }
    }
    throw error;
  } finally {
    // Discard a connection with uncertain transaction state instead of pooling it.
    client.release(discard);
  }
}
