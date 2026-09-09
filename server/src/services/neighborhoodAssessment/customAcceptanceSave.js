import { canonicalAssessmentJson } from "./contract.js";
import { getNeighborhoodAttachment } from "./applicationRepository.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "./customAcceptanceSnapshot.js";
import { getCustomNeighborhoodAcceptance, recordCustomNeighborhoodAcceptance } from "./customAcceptanceRepository.js";
import { saveCustomAppraisalWorkfileSectionInTransaction } from "../customAppraisalWorkfiles.js";

const KEYS = ["organizationId", "reportFileId", "assignmentFileId", "operationId", "actorUserId",
  "attachmentId", "attachmentRevision", "receipt"].sort();
const SAVEPOINT = "custom_neighborhood_group_save";

/** Internal persistence composition, NOT a browser Apply endpoint or permission.
 * The workflow owner must authorize the original actor/assignment, lock and
 * validate current source/catalog/occupancy context, then supply the real shared
 * receipt in its checked-out transaction. No client-supplied section, account,
 * reviewer name, history ID or arbitrary value mapping is accepted here.
 *
 * The real Custom save writes the complete section/history, followed by its exact
 * acceptance link. Failure rolls this group's writes back to our savepoint; the
 * owner still owns the outer transaction and must COMMIT before reporting success.
 * No schema setup, outer BEGIN/COMMIT, connection acquisition/release or UAD write.
 */
export async function saveCustomNeighborhoodAcceptanceInTransaction(client, input) {
  if (typeof client?.query !== "function" || typeof client.release !== "function") {
    throw new TypeError("custom_neighborhood_save_caller_client_required");
  }
  const captured = JSON.parse(canonicalAssessmentJson(input));
  if (!captured || typeof captured !== "object" || Array.isArray(captured)
    || JSON.stringify(Object.keys(captured).sort()) !== JSON.stringify(KEYS)) {
    throw new TypeError("custom_neighborhood_save_invalid_input");
  }
  // Must fail in autocommit before reading or modifying the target.
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const { organizationId, reportFileId, assignmentFileId, operationId } = captured;
    const stored = await getNeighborhoodAttachment(client, { organizationId, reportFileId,
      workflowType: "custom_appraisal", workflowTargetId: assignmentFileId,
      attachmentId: captured.attachmentId, attachmentRevision: captured.attachmentRevision });
    if (!stored) throw new Error("custom_neighborhood_save_attachment_not_found");
    const snapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ ...stored,
      operationId, actorUserId: captured.actorUserId, receipt: captured.receipt });
    const existing = await getCustomNeighborhoodAcceptance(client,
      { organizationId, reportFileId, assignmentFileId, operationId });
    let sectionHistoryId = existing?.sectionHistoryId;
    if (!existing) {
      const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, {
        accountId: stored.assessment.scope.account_id, assignmentFileId,
        sectionKey: snapshot.section_key, sectionValue: snapshot.section_value,
        expectedRevision: stored.attachment.editor_revision, saveReason: "manual_save",
        // Stable original actor identity, not a browser-entered reviewer label.
        reviewer: snapshot.section_value.actor_user_id,
      });
      if (saved.key !== snapshot.section_key || saved.revision !== snapshot.receipt.accepted_editor_revision
        || canonicalAssessmentJson(saved.value) !== canonicalAssessmentJson(snapshot.section_value)) {
        throw new Error("custom_neighborhood_save_section_mismatch");
      }
      // Existing save API remains unchanged. This exact unique history lookup
      // uses the same client while the Custom workfile/section locks are held.
      const history = await client.query(`/* custom-neighborhood-save:history */
        SELECT id FROM app.custom_appraisal_workfile_section_history
        WHERE assignment_file_id=$1 AND section_key=$2 AND revision=$3
          AND section_value=$4::jsonb AND changed_by=$5 AND event_type='manual_save'`,
      [assignmentFileId, snapshot.section_key, saved.revision,
        canonicalAssessmentJson(snapshot.section_value), snapshot.section_value.actor_user_id]);
      if (history.rowCount !== 1 || history.rows.length !== 1) {
        throw new Error("custom_neighborhood_save_history_mismatch");
      }
      sectionHistoryId = String(history.rows[0].id);
    }
    // Also validates exact retries (including actor, receipt and signed/current
    // state); a retry never creates another section revision or history row.
    const accepted = await recordCustomNeighborhoodAcceptance(client, { ...captured, sectionHistoryId });
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return accepted;
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "custom_neighborhood_save_rollback_failed");
    }
    throw error;
  }
}
