import { createHash, randomUUID } from "node:crypto";
import { canonicalAssessmentJson } from "./contract.js";
import { assertNeighborhoodJsonbStorage } from "./jsonbStorage.js";
import { getNeighborhoodAttachment } from "./applicationRepository.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot, reconstructCustomNeighborhoodAcceptanceSnapshot } from "./customAcceptanceSnapshot.js";

/** Persistence only; these helpers grant no organization/assignment access.
 * The Custom workflow owner must authorize the original actor/target, acquire
 * the real target/editor locks, validate actual current values and source context,
 * and save the whole accepted section before calling the writer in that SAME
 * transaction. A reconstructed receipt is not evidence of current authorization.
 * No BEGIN/COMMIT/ROLLBACK, schema setup, connection release or latest-account
 * fallback occurs here. A failure requires the owner to roll back its transaction.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GET_KEYS = ["assignmentFileId", "operationId", "organizationId", "reportFileId"];
const WRITE_KEYS = [...GET_KEYS, "actorUserId", "attachmentId", "attachmentRevision", "receipt", "sectionHistoryId"].sort();
function fail(code) {
  throw Object.assign(new Error(`custom_neighborhood_acceptance_${code}`), { code: `custom_neighborhood_acceptance_${code}` });
}
function canonical(value) {
  const text = canonicalAssessmentJson(value);
  assertNeighborhoodJsonbStorage(JSON.parse(text));
  return text;
}
function frozen(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function clientOf(client) {
  if (typeof client?.query !== "function" || typeof client.release !== "function") fail("caller_client_required");
}
function uuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) fail(`invalid_${name}`);
  return value.toLowerCase();
}
function integer(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`invalid_${name}`);
  return value;
}
function historyId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail("invalid_section_history_id");
  return value;
}
function inputOf(input, writing) {
  const captured = JSON.parse(canonical(input));
  if (!captured || Array.isArray(captured) || typeof captured !== "object" ||
      JSON.stringify(Object.keys(captured).sort()) !== JSON.stringify(writing ? WRITE_KEYS : GET_KEYS)) fail("invalid_input");
  const target = { organizationId: uuid(captured.organizationId, "organization_id"),
    reportFileId: uuid(captured.reportFileId, "report_file_id"),
    assignmentFileId: integer(captured.assignmentFileId, "assignment_file_id"),
    operationId: uuid(captured.operationId, "operation_id") };
  if (!writing) return frozen(target);
  return frozen({ ...target, actorUserId: uuid(captured.actorUserId, "actor_user_id"),
    attachmentId: uuid(captured.attachmentId, "attachment_id"),
    attachmentRevision: integer(captured.attachmentRevision, "attachment_revision", 2147483647),
    sectionHistoryId: historyId(captured.sectionHistoryId), receipt: captured.receipt });
}
const operationTarget = input => ({ organizationId: input.organizationId, reportFileId: input.reportFileId,
  assignmentFileId: input.assignmentFileId, operationId: input.operationId });
const attachmentTarget = (input, attachmentId, attachmentRevision) => ({ organizationId: input.organizationId,
  reportFileId: input.reportFileId, workflowType: "custom_appraisal", workflowTargetId: input.assignmentFileId,
  attachmentId, attachmentRevision });

/** Exact operation lookup for the currently accepted section; not account history.
 * Old acceptances remain immutable in SQL, but cannot be replayed over a later
 * accepted section. The owning route must authorize access before this read.
 */
export async function getCustomNeighborhoodAcceptance(client, input) {
  clientOf(client);
  const target = inputOf(input, false);
  const result = await client.query(`/* custom-neighborhood-acceptance:exact-operation */
    SELECT a.*,h.section_value AS history_value,h.revision AS history_revision,
      s.section_value AS current_value,s.revision AS current_revision
    FROM app.custom_neighborhood_acceptances a
    JOIN app.report_files r ON r.id=a.report_file_id AND r.organization_id=a.organization_id
      AND r.custom_assignment_file_id=a.assignment_file_id AND r.account_id=a.account_id
      AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL
    JOIN app.assignment_files f ON f.id=a.assignment_file_id
      AND f.organization_id=a.organization_id AND f.account_id=a.account_id
    JOIN app.custom_appraisal_workfile_section_history h ON h.id=a.section_history_id
      AND h.assignment_file_id=a.assignment_file_id AND h.section_key=a.section_key AND h.revision=a.accepted_editor_revision
    JOIN app.custom_appraisal_workfile_sections s ON s.assignment_file_id=a.assignment_file_id AND s.section_key=a.section_key
    WHERE a.organization_id=$1 AND a.report_file_id=$2 AND a.assignment_file_id=$3 AND a.operation_id=$4`,
  [target.organizationId, target.reportFileId, target.assignmentFileId, target.operationId]);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || result.rows.length !== 1) fail("operation_conflict");
  const row = result.rows[0];
  const stored = await getNeighborhoodAttachment(client, attachmentTarget(target, row.attachment_id, row.attachment_revision));
  if (!stored) fail("stored_attachment_missing");
  const snapshot = reconstructCustomNeighborhoodAcceptanceSnapshot({ ...stored, actorUserId: row.actor_user_id,
    operationId: row.operation_id, decision: row.decision, acceptedEditorRevision: row.accepted_editor_revision });
  // Stored-byte integrity and semantic/canonical integrity are different checks.
  // PostgreSQL JSONB may reorder keys; never invent a SQL ECMAScript serializer.
  if (typeof row.section_json_utf8 !== "string"
    || createHash("sha256").update(row.section_json_utf8, "utf8").digest("hex") !== row.section_bytes_sha256) fail("stored_group_mismatch");
  const storedSection = canonical(JSON.parse(row.section_json_utf8)), expectedSection = canonical(snapshot.section_value);
  if (row.organization_id !== target.organizationId || row.report_file_id !== target.reportFileId ||
      String(row.assignment_file_id) !== String(target.assignmentFileId) || row.account_id !== stored.assessment.scope.account_id ||
      row.application_identity_sha256 !== stored.attachment.application_identity_sha256 ||
      row.section_key !== snapshot.section_key || storedSection !== expectedSection ||
      row.history_revision !== row.accepted_editor_revision || canonical(row.history_value) !== expectedSection) fail("stored_group_mismatch");
  if (row.current_revision !== row.accepted_editor_revision || canonical(row.current_value) !== expectedSection) fail("not_current_section");
  return frozen({ id: uuid(row.id, "stored_id"), ...target, actorUserId: uuid(row.actor_user_id, "stored_actor_user_id"),
    attachmentId: row.attachment_id, attachmentRevision: row.attachment_revision,
    sectionHistoryId: historyId(String(row.section_history_id)),
    acceptedEditorRevision: row.accepted_editor_revision, snapshot });
}

/** Record a section/history write already performed by the authorized owner.
 * The immutable SQL guard verifies exact scope, attachment, history, revision and
 * complete values together. An exact operation retry may reuse that same group;
 * altered actor, history, receipt or attachment fails instead of overwriting it.
 */
export async function recordCustomNeighborhoodAcceptance(client, input) {
  clientOf(client);
  const captured = inputOf(input, true);
  // PostgreSQL rejects SAVEPOINT in autocommit, before any acceptance write.
  await client.query("SAVEPOINT custom_neighborhood_acceptance_write");
  const stored = await getNeighborhoodAttachment(client,
    attachmentTarget(captured, captured.attachmentId, captured.attachmentRevision));
  if (!stored) fail("attachment_not_found");
  const snapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ ...stored, actorUserId: captured.actorUserId,
    operationId: captured.operationId, receipt: captured.receipt });
  const value = snapshot.section_value;
  const inserted = await client.query(`/* custom-neighborhood-acceptance:insert */
    INSERT INTO app.custom_neighborhood_acceptances
      (id,organization_id,report_file_id,assignment_file_id,account_id,attachment_id,attachment_revision,
       application_identity_sha256,operation_id,actor_user_id,section_key,section_history_id,
       accepted_editor_revision,section_bytes_sha256,section_json_utf8,decision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`,
  [randomUUID(), captured.organizationId, captured.reportFileId, captured.assignmentFileId, stored.assessment.scope.account_id,
    captured.attachmentId, captured.attachmentRevision, stored.attachment.application_identity_sha256,
    captured.operationId, captured.actorUserId, snapshot.section_key, captured.sectionHistoryId,
     captured.receipt.accepted_editor_revision, snapshot.section_value_sha256, canonical(value), canonical(value.decision)]);
  if (inserted.rowCount !== 0 && inserted.rowCount !== 1) fail("insert_conflict");
  const accepted = await getCustomNeighborhoodAcceptance(client, operationTarget(captured));
  // Section and derived receipt each retain the shared contract's size limit.
  // Their combined transport envelope is not a separately persisted constituent.
  if (!accepted || accepted.actorUserId !== captured.actorUserId || accepted.sectionHistoryId !== captured.sectionHistoryId ||
      accepted.attachmentId !== captured.attachmentId || accepted.attachmentRevision !== captured.attachmentRevision ||
      accepted.snapshot.section_key !== snapshot.section_key ||
      accepted.snapshot.section_value_sha256 !== snapshot.section_value_sha256 ||
      canonical(accepted.snapshot.section_value) !== canonical(snapshot.section_value) ||
      canonical(accepted.snapshot.receipt) !== canonical(snapshot.receipt)) fail("operation_conflict");
  await client.query("RELEASE SAVEPOINT custom_neighborhood_acceptance_write");
  return frozen({ ...accepted, reused: inserted.rowCount === 0 });
}
