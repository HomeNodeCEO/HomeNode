import { randomUUID } from "node:crypto";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from "./contract.js";
import { neighborhoodMappedManifestDigest, prepareNeighborhoodApplicationGroup } from "./applicationGroup.js";
import { assertNeighborhoodJsonbStorage } from "./jsonbStorage.js";

/** Caller-owned transaction helpers, NOT authorization or signing controls.
 * Supply a checked-out pg PoolClient (query + release; it may also have connect).
 * The workflow owner must authorize the exact target, lock the workfile/report
 * in its established order, reject signed/protected state, check editor/source
 * concurrency and catalog/cross-field rules, then write values/revision/audit and
 * receipt with this SAME client/transaction. These helpers never BEGIN, COMMIT,
 * ROLLBACK, release clients, fetch providers, or grant appraisal signing authority.
 * Report registry_revision is not a Custom editor concurrency token. Custom
 * proposals are supported; Custom acceptance is intentionally not implemented.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => {
  const encoded = canonicalAssessmentJson(value);
  assertNeighborhoodJsonbStorage(JSON.parse(encoded));
  return encoded;
};
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const capture = value => freeze(JSON.parse(canonical(value)));
function fail(code) { throw Object.assign(new Error(`neighborhood_application_${code}`), { code: `neighborhood_application_${code}` }); }
function uuid(value, name) { if (typeof value !== "string" || !UUID.test(value)) fail(`invalid_${name}`); return value.toLowerCase(); }
function hash(value, name) { if (typeof value !== "string" || !HASH.test(value)) fail(`invalid_${name}`); return value; }
function integer(value, name, minimum = 1, maximum = 2_147_483_647) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`invalid_${name}`); return value; }
function clientOf(client) { if (typeof client?.query !== "function" || typeof client.release !== "function") fail("caller_client_required"); return client; }
function one(result, code) { if (result.rowCount !== 1 || result.rows.length !== 1) fail(code); return result.rows[0]; }
function equals(left, right, code) { if (canonical(left) !== canonical(right)) fail(code); }
function targetOf(input) {
  const workflow = input.workflowType;
  if (!["uad_3_6", "custom_appraisal"].includes(workflow)) fail("invalid_workflow");
  return { organizationId: uuid(input.organizationId, "organization_id"), reportFileId: uuid(input.reportFileId, "report_file_id"),
    workflowType: workflow, workflowTargetId: workflow === "uad_3_6" ? uuid(input.workflowTargetId, "uad_workfile_id")
      : integer(input.workflowTargetId, "custom_assignment_file_id", 1, Number.MAX_SAFE_INTEGER) };
}
const targetFromAttachment = attachment => targetOf({ organizationId: attachment.scope.organization_id,
  reportFileId: attachment.report_file_id, workflowType: attachment.workflow_type,
  workflowTargetId: attachment.workflow_type === "uad_3_6" ? attachment.uad_workfile_id : attachment.custom_assignment_file_id });
const targetValues = target => [target.organizationId, target.reportFileId, target.workflowType, String(target.workflowTargetId)];

const CONTEXT_COLUMNS = `r.id AS report_file_id,r.organization_id,r.account_id,r.appraisal_case_id,r.subject_snapshot_id,
  r.workflow_type,r.custom_assignment_file_id::text,r.uad_workfile_id,
  c.organization_id AS case_organization_id,c.account_id AS case_account_id,c.effective_date::text AS case_effective_date,
  s.appraisal_case_id AS snapshot_case_id,s.effective_date::text AS snapshot_effective_date,
  COALESCE(s.effective_date,c.effective_date)::text AS canonical_effective_date,
  CASE WHEN r.workflow_type='uad_3_6' THEN u.organization_id ELSE custom.organization_id END AS target_organization_id,
  CASE WHEN r.workflow_type='uad_3_6' THEN u.account_id ELSE custom.account_id END AS target_account_id`;
const CONTEXT_JOINS = `JOIN app.report_files r ON r.id=a.report_file_id
  JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id
  JOIN app.appraisal_subject_snapshots s ON s.id=r.subject_snapshot_id AND s.appraisal_case_id=c.id
  LEFT JOIN appraisal.uad_workfiles u ON r.workflow_type='uad_3_6' AND u.id=r.uad_workfile_id
  LEFT JOIN app.assignment_files custom ON r.workflow_type='custom_appraisal' AND custom.id=r.custom_assignment_file_id`;
const TARGET_WHERE = `r.organization_id=$1 AND r.id=$2 AND r.workflow_type=$3
  AND CASE WHEN r.workflow_type='uad_3_6' THEN r.uad_workfile_id::text ELSE r.custom_assignment_file_id::text END=$4`;

function verifyContext(row, assessment, target) {
  const scope = assessment.scope;
  equals({ organizationId: row.organization_id, reportFileId: row.report_file_id, workflowType: row.workflow_type,
    workflowTargetId: row.workflow_type === "uad_3_6" ? row.uad_workfile_id : Number(row.custom_assignment_file_id) }, target, "target_mismatch");
  if (row.appraisal_case_id !== scope.appraisal_case_id || row.subject_snapshot_id !== scope.subject_snapshot_id || row.account_id !== scope.account_id ||
      row.organization_id !== scope.organization_id || row.case_organization_id !== scope.organization_id || row.case_account_id !== scope.account_id ||
      row.snapshot_case_id !== scope.appraisal_case_id || row.target_organization_id !== scope.organization_id || row.target_account_id !== scope.account_id ||
      row.canonical_effective_date !== assessment.effective_date ||
      (row.case_effective_date !== null && row.snapshot_effective_date !== null && row.case_effective_date !== row.snapshot_effective_date)) fail("scope_mismatch");
  if (target.workflowType === "uad_3_6" ? row.custom_assignment_file_id !== null : row.uad_workfile_id !== null) fail("workflow_mapping_mismatch");
}
function verifiedAssessment(raw, storedDigest, storedId, storedRevision) {
  const assessment = buildNeighborhoodAssessment(raw);
  equals(raw, assessment, "stored_assessment_changed");
  if (assessment.evidence_digest_sha256 !== storedDigest || assessment.id !== storedId || assessment.revision !== storedRevision) fail("stored_assessment_digest_mismatch");
  return assessment;
}
function prepareMapping(assessment, attachment, rawSuggestions) {
  const input = capture(rawSuggestions);
  if (!Array.isArray(input) || !input.length || input.length > 1000 || input.some(item => !Array.isArray(item.dependency_ids) || !Array.isArray(item.evidence_refs)) ||
      neighborhoodMappedManifestDigest(input) !== attachment.mapped_manifest_sha256) fail("mapped_manifest_mismatch");
  const suggestions = capture(input.map(item => ({ ...item, dependency_ids: [...item.dependency_ids].sort(compare),
    evidence_refs: [...item.evidence_refs].sort(compare) })).sort((a, b) => compare(a.id, b.id)));
  const plan = prepareNeighborhoodApplicationGroup({ attachment, expected_binding_digest: attachment.binding_digest_sha256,
    current_application_identity_sha256: attachment.application_identity_sha256, current_editor_revision: attachment.editor_revision,
    group: assessment.application_group, suggestions, selected_ids: suggestions.map(item => item.id),
    existing_values: suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    // Structural/evidence closure only. The owner MUST perform actual catalog and
    // relevant cross-field validation against its locked final document.
    validate_final_group: () => ({ valid: true, issues: [] }) });
  if (plan.status !== "ready") fail("incoherent_mapping");
  return { suggestions, plan };
}
function verifiedStoredAttachment(row, target) {
  const assessment = verifiedAssessment(row.assessment, row.stored_evidence_digest, row.stored_assessment_id, row.stored_assessment_revision);
  verifyContext(row, assessment, target);
  const attachment = buildNeighborhoodAttachment(assessment, row.attachment);
  equals(row.attachment, attachment, "stored_attachment_changed");
  if (row.binding_digest_sha256 !== attachment.binding_digest_sha256 || row.application_identity_sha256 !== attachment.application_identity_sha256 ||
      row.attachment_id !== attachment.attachment_id || row.attachment_revision !== attachment.attachment_revision) fail("stored_attachment_columns_mismatch");
  const mapping = prepareMapping(assessment, attachment, row.mapped_suggestions);
  return { assessment, attachment, ...mapping };
}

/** Immutable proposal insert, or byte-equivalent canonical content replay only. */
export async function persistNeighborhoodAttachment(client, { assessment: rawAssessment, attachment: rawAttachment, mappedSuggestions }) {
  clientOf(client);
  const assessment = capture(rawAssessment), attachment = capture(rawAttachment);
  const target = targetFromAttachment(attachment);
  equals(buildNeighborhoodAttachment(assessment, attachment), attachment, "attachment_mismatch");
  const mapping = prepareMapping(assessment, attachment, mappedSuggestions);
  const row = one(await client.query(`/* neighborhood-application:published-context */
    SELECT n.assessment,n.assessment_id AS stored_assessment_id,n.revision AS stored_assessment_revision,
      n.evidence_digest_sha256 AS stored_evidence_digest,${CONTEXT_COLUMNS}
      FROM app.neighborhood_assessment_revisions n
      JOIN app.neighborhood_assessments h ON h.id=n.assessment_id
      JOIN app.report_files r ON r.id=$2 AND r.organization_id=h.organization_id
        AND r.appraisal_case_id=h.appraisal_case_id AND r.subject_snapshot_id=h.subject_snapshot_id AND r.account_id=h.account_id
      JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id
      JOIN app.appraisal_subject_snapshots s ON s.id=r.subject_snapshot_id AND s.appraisal_case_id=c.id
      LEFT JOIN appraisal.uad_workfiles u ON r.workflow_type='uad_3_6' AND u.id=r.uad_workfile_id
      LEFT JOIN app.assignment_files custom ON r.workflow_type='custom_appraisal' AND custom.id=r.custom_assignment_file_id
     WHERE ${TARGET_WHERE} AND n.assessment_id=$5 AND n.revision=$6 AND n.publication_status='published'`,
  [...targetValues(target), assessment.id, assessment.revision]), "published_assessment_not_found");
  equals(verifiedAssessment(row.assessment, row.stored_evidence_digest, row.stored_assessment_id, row.stored_assessment_revision), assessment, "assessment_mismatch");
  verifyContext(row, assessment, target);
  const inserted = await client.query(`/* neighborhood-application:insert-attachment */
    INSERT INTO app.neighborhood_assessment_attachments
      (attachment_id,attachment_revision,assessment_id,assessment_revision,report_file_id,organization_id,workflow_type,
       custom_assignment_file_id,uad_workfile_id,application_identity_sha256,binding_digest_sha256,attachment,mapped_suggestions)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
    ON CONFLICT DO NOTHING RETURNING attachment_id`, [attachment.attachment_id, attachment.attachment_revision,
    assessment.id, assessment.revision, target.reportFileId, target.organizationId, target.workflowType,
    attachment.custom_assignment_file_id, attachment.uad_workfile_id, attachment.application_identity_sha256,
    attachment.binding_digest_sha256, canonical(attachment), canonical(mapping.suggestions)]);
  if (inserted.rowCount === 1) return freeze({ attachment, reused: false });
  const existing = await getNeighborhoodAttachment(client, { ...target, attachmentId: attachment.attachment_id, attachmentRevision: attachment.attachment_revision });
  if (!existing) fail("attachment_conflict");
  equals(existing.attachment, attachment, "attachment_conflict");
  equals(existing.mappedSuggestions, mapping.suggestions, "attachment_conflict");
  return freeze({ attachment: existing.attachment, reused: true });
}

/** Exact target + attachment ID/revision only: never a latest/account fallback. */
export async function getNeighborhoodAttachment(client, input) {
  clientOf(client); const target = targetOf(input);
  const attachmentId = uuid(input.attachmentId, "attachment_id"), revision = integer(input.attachmentRevision, "attachment_revision");
  const rows = await client.query(`/* neighborhood-application:exact-attachment */
    SELECT a.attachment,a.mapped_suggestions,a.attachment_id,a.attachment_revision,a.binding_digest_sha256,a.application_identity_sha256,
      n.assessment,n.assessment_id AS stored_assessment_id,n.revision AS stored_assessment_revision,
      n.evidence_digest_sha256 AS stored_evidence_digest,${CONTEXT_COLUMNS}
      FROM app.neighborhood_assessment_attachments a ${CONTEXT_JOINS}
      JOIN app.neighborhood_assessment_revisions n ON n.assessment_id=a.assessment_id AND n.revision=a.assessment_revision AND n.publication_status='published'
      JOIN app.neighborhood_assessments h ON h.id=n.assessment_id AND h.organization_id=r.organization_id
        AND h.appraisal_case_id=r.appraisal_case_id AND h.subject_snapshot_id=r.subject_snapshot_id AND h.account_id=r.account_id
     WHERE ${TARGET_WHERE} AND a.attachment_id=$5 AND a.attachment_revision=$6 AND a.organization_id=r.organization_id`,
  [...targetValues(target), attachmentId, revision]);
  if (!rows.rowCount) return null;
  const stored = verifiedStoredAttachment(one(rows, "attachment_conflict"), target);
  return freeze({ assessment: stored.assessment, attachment: stored.attachment, mappedSuggestions: stored.suggestions });
}

function verifiedReceipt(raw, stored) {
  const receipt = capture(raw);
  const { receipt_digest_sha256: receiptDigest, ...body } = receipt;
  if (receipt.receipt_version !== 1 || hash(receiptDigest, "receipt_digest") !== assessmentEvidenceDigest(body)) fail("receipt_digest_mismatch");
  integer(receipt.accepted_editor_revision, "accepted_editor_revision");
  const manifest = receipt.acceptance_manifest, expected = stored.plan.acceptance_manifest;
  if (!manifest || !Array.isArray(manifest.applied) || !Array.isArray(manifest.reused) ||
      !manifest.applied.length || manifest.applied.length + manifest.reused.length > 1000 ||
      receipt.accepted_editor_revision <= stored.attachment.editor_revision) fail("invalid_receipt_manifest");
  const values = [...manifest.applied, ...manifest.reused].sort((a, b) => compare(a.id, b.id));
  const mappedValues = stored.suggestions.map(({ id, target_key, value }) => ({ id, target_key, value }));
  equals(values, mappedValues, "receipt_mapped_values_mismatch");
  const { applied: _applied, reused: _reused, ...manifestIdentity } = manifest;
  const { applied: _expectedApplied, reused: _expectedReused, ...expectedIdentity } = expected;
  equals(manifestIdentity, expectedIdentity, "receipt_manifest_mismatch");
  equals(Object.keys(receipt).sort(), ["receipt_version", "accepted_editor_revision", "acceptance_manifest", "receipt_digest_sha256"].sort(), "receipt_shape_mismatch");
  if (manifest.prepared_values_sha256 !== assessmentEvidenceDigest(mappedValues.map(({ target_key, value }) => ({ target_key, value }))) ||
      manifest.provenance_digest !== assessmentEvidenceDigest(manifest.provenance)) fail("receipt_provenance_mismatch");
  return receipt;
}

function auditId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) fail("invalid_audit_event_id");
  return value;
}
function applicationRecord(input, attachment, receipt) {
  const record = { attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
    report_file_id: attachment.report_file_id, application_identity_sha256: attachment.application_identity_sha256,
    operation_id: uuid(input.operationId, "operation_id"), actor_user_id: uuid(input.actorUserId, "actor_user_id"),
    accepted_editor_revision: receipt.accepted_editor_revision, uad_revision_id: uuid(input.uadRevisionId, "uad_revision_id"),
    uad_audit_event_id: auditId(input.auditEventId), receipt };
  return { ...record, request_digest_sha256: assessmentEvidenceDigest(record) };
}
function verifyUadLinks(row, record, stored, { requireCurrent = false } = {}) {
  const attachment = stored.attachment, manifest = record.receipt.acceptance_manifest;
  if (attachment.workflow_type !== "uad_3_6") fail("custom_acceptance_not_supported");
  if (row.linked_revision_id !== record.uad_revision_id || row.linked_revision_workfile_id !== attachment.uad_workfile_id ||
      row.linked_revision_number !== record.accepted_editor_revision || row.linked_revision_actor !== record.actor_user_id ||
      row.linked_specification_release !== attachment.specification_release ||
      String(row.linked_audit_id) !== record.uad_audit_event_id || row.linked_audit_workfile_id !== attachment.uad_workfile_id ||
      row.linked_audit_actor !== record.actor_user_id || row.linked_event_type !== "uad_neighborhood_assessment.applied" ||
      row.linked_entity_type !== "uad_neighborhood_application" || row.linked_entity_id !== record.operation_id) fail("uad_link_mismatch");
  if (requireCurrent && (row.linked_current_revision !== record.accepted_editor_revision || row.linked_signed_at !== null ||
      ["signed", "exported", "submitted", "cancelled"].includes(row.linked_workfile_status))) fail("uad_target_not_editable");
  const metadata = row.linked_metadata;
  const expectedMetadata = { operation_id: record.operation_id, uad_revision_id: record.uad_revision_id,
    uad_revision_number: record.accepted_editor_revision, application_identity_sha256: record.application_identity_sha256,
    receipt_digest_sha256: record.receipt.receipt_digest_sha256, mapped_manifest_sha256: attachment.mapped_manifest_sha256,
    prepared_values_sha256: manifest.prepared_values_sha256 };
  if (!metadata || Object.entries(expectedMetadata).some(([key, value]) => canonical(metadata[key] ?? null) !== canonical(value))) fail("uad_audit_metadata_mismatch");
  const after = row.linked_after_data;
  const expectedAfter = { attachment_id: attachment.attachment_id, assessment_id: attachment.assessment_id,
    assessment_revision: attachment.assessment_revision, application_group_id: attachment.application_group_id,
    application_group_revision: attachment.application_group_revision };
  if (!after || Object.entries(expectedAfter).some(([key, value]) => canonical(after[key] ?? null) !== canonical(value))) fail("uad_audit_after_mismatch");
  for (const [key, items] of [["applied_suggestion_ids", manifest.applied], ["reused_suggestion_ids", manifest.reused]]) {
    if (!Array.isArray(after[key])) fail("uad_audit_suggestions_mismatch");
    equals([...after[key]].sort(compare), items.map(item => item.id).sort(compare), "uad_audit_suggestions_mismatch");
  }
}
const LINK_COLUMNS = `v.id AS linked_revision_id,v.workfile_id AS linked_revision_workfile_id,
  v.revision_number AS linked_revision_number,v.created_by_user_id AS linked_revision_actor,
  v.specification_release_key AS linked_specification_release,
  e.id::text AS linked_audit_id,e.workfile_id AS linked_audit_workfile_id,e.actor_user_id AS linked_audit_actor,
  e.event_type AS linked_event_type,e.entity_type AS linked_entity_type,e.entity_id AS linked_entity_id,
  e.metadata AS linked_metadata,e.after_data AS linked_after_data`;

/** Exact identity receipt lookup for the owner's pure preflight; SELECT only.
 * Historical receipts remain readable after later edits/signing. The owner's
 * current editor/signed-state gates still decide whether any application may run.
 */
async function loadVerifiedAcceptance(client, input) {
  clientOf(client); const target = targetOf(input), identity = hash(input.applicationIdentitySha256, "application_identity");
  if (target.workflowType !== "uad_3_6") fail("custom_acceptance_not_supported");
  const rows = await client.query(`/* neighborhood-application:accepted-receipt */
    SELECT x.*,a.attachment,a.mapped_suggestions,a.binding_digest_sha256,
      n.assessment,n.assessment_id AS stored_assessment_id,n.revision AS stored_assessment_revision,
      n.evidence_digest_sha256 AS stored_evidence_digest,${CONTEXT_COLUMNS},${LINK_COLUMNS}
      FROM app.neighborhood_assessment_applications x
      JOIN app.neighborhood_assessment_attachments a ON a.attachment_id=x.attachment_id AND a.attachment_revision=x.attachment_revision
        AND a.report_file_id=x.report_file_id AND a.application_identity_sha256=x.application_identity_sha256
      ${CONTEXT_JOINS}
      JOIN app.neighborhood_assessment_revisions n ON n.assessment_id=a.assessment_id AND n.revision=a.assessment_revision AND n.publication_status='published'
      JOIN app.neighborhood_assessments h ON h.id=n.assessment_id AND h.organization_id=r.organization_id
        AND h.appraisal_case_id=r.appraisal_case_id AND h.subject_snapshot_id=r.subject_snapshot_id AND h.account_id=r.account_id
      JOIN appraisal.uad_revisions v ON v.id=x.uad_revision_id
      JOIN appraisal.uad_audit_events e ON e.id=x.uad_audit_event_id
     WHERE ${TARGET_WHERE} AND x.application_identity_sha256=$5 AND a.organization_id=r.organization_id`, [...targetValues(target), identity]);
  if (!rows.rowCount) return null;
  const row = one(rows, "receipt_conflict"), stored = verifiedStoredAttachment(row, target);
  if (stored.attachment.application_identity_sha256 !== identity) fail("receipt_identity_mismatch");
  const receipt = verifiedReceipt(row.receipt, stored);
  const record = applicationRecord({ operationId: row.operation_id, actorUserId: row.actor_user_id,
    uadRevisionId: row.uad_revision_id, auditEventId: row.uad_audit_event_id }, stored.attachment, receipt);
  if (record.request_digest_sha256 !== row.request_digest_sha256 || row.accepted_editor_revision !== receipt.accepted_editor_revision) fail("stored_receipt_changed");
  verifyUadLinks(row, record, stored);
  return { row, record, receipt };
}

/** Preserve the existing four-key receipt API, including historical reads. */
export async function getAcceptedNeighborhoodApplication(client, input) {
  const found = await loadVerifiedAcceptance(client, input);
  return found === null ? null : found.receipt;
}

/** Additive, SELECT-only parent linkage; not authorization or proof of COMMIT.
 * Validate the previously unused parent PK only here, preserving the old API.
 * The core receipt is already detached/frozen. Bound only the seven scalars so
 * this extra wrapper does not shrink its existing byte/node/depth allowance.
 */
export async function getAcceptedNeighborhoodApplicationRecord(client, input) {
  const found = await loadVerifiedAcceptance(client, input);
  if (found === null) return null;
  const metadata = {
    record_version: 1,
    application_id: uuid(found.row.id, "application_id"),
    operation_id: found.record.operation_id,
    actor_user_id: found.record.actor_user_id,
    accepted_editor_revision: found.receipt.accepted_editor_revision,
    uad_revision_id: found.record.uad_revision_id,
    uad_audit_event_id: found.record.uad_audit_event_id,
  };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 512) fail("application_record_limit");
  return Object.freeze({ ...metadata, receipt: found.receipt });
}

/** Call only AFTER the owner writes its complete values, new revision and the
 * confirmed UAD neighborhood audit event in the SAME locked transaction. Any
 * error must abort the entire owner operation. No conflict is repaired by UPDATE.
 */
export async function recordNeighborhoodApplicationAcceptance(client, input) {
  clientOf(client);
  input = capture(input);
  integer(input.uadRevisionNumber, "uad_revision_number");
  const receiptInput = capture(input.receipt), manifest = receiptInput.acceptance_manifest;
  const attachmentId = uuid(input.attachmentId, "attachment_id"), identity = hash(input.applicationIdentitySha256, "application_identity");
  if (!manifest?.provenance) fail("invalid_receipt_manifest");
  if (manifest.provenance.workflow_type !== "uad_3_6") fail("custom_acceptance_not_supported");
  if (manifest.attachment_id !== attachmentId || manifest.application_identity_sha256 !== identity) fail("receipt_identity_mismatch");
  const target = targetOf({ organizationId: manifest.provenance.scope?.organization_id, reportFileId: manifest.provenance.report_file_id,
    workflowType: manifest.provenance.workflow_type, workflowTargetId: manifest.provenance.uad_workfile_id });
  const existing = await getNeighborhoodAttachment(client, { ...target, attachmentId, attachmentRevision: manifest.attachment_revision });
  if (!existing) fail("attachment_not_found");
  if (existing.attachment.application_identity_sha256 !== identity) fail("receipt_identity_mismatch");
  const stored = { ...existing, ...prepareMapping(existing.assessment, existing.attachment, existing.mappedSuggestions) };
  const receipt = verifiedReceipt(receiptInput, stored), record = applicationRecord(input, stored.attachment, receipt);
  if (input.uadRevisionNumber !== receipt.accepted_editor_revision) fail("uad_revision_number_mismatch");
  const links = one(await client.query(`/* neighborhood-application:acceptance-links */
    SELECT ${LINK_COLUMNS},w.current_revision AS linked_current_revision,w.signed_at AS linked_signed_at,w.status AS linked_workfile_status
      FROM appraisal.uad_revisions v JOIN appraisal.uad_workfiles w ON w.id=v.workfile_id
      JOIN appraisal.uad_audit_events e ON e.id=$2
     WHERE v.id=$1 AND w.id=$3 AND w.organization_id=$4 AND w.account_id=$5`,
  [record.uad_revision_id, record.uad_audit_event_id, stored.attachment.uad_workfile_id,
    target.organizationId, stored.attachment.scope.account_id]), "uad_links_not_found");
  verifyUadLinks(links, record, stored, { requireCurrent: true });
  const inserted = await client.query(`/* neighborhood-application:insert-acceptance */
    INSERT INTO app.neighborhood_assessment_applications
      (id,attachment_id,attachment_revision,report_file_id,application_identity_sha256,operation_id,actor_user_id,
       request_digest_sha256,accepted_editor_revision,uad_revision_id,uad_audit_event_id,receipt)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), record.attachment_id, record.attachment_revision,
    record.report_file_id, record.application_identity_sha256, record.operation_id, record.actor_user_id,
    record.request_digest_sha256, record.accepted_editor_revision, record.uad_revision_id, record.uad_audit_event_id, canonical(receipt)]);
  if (inserted.rowCount === 1) return freeze({ receipt, application_id: one(inserted, "receipt_conflict").id, reused: false });
  const conflict = one(await client.query(`/* neighborhood-application:acceptance-conflict */
    SELECT id,request_digest_sha256 FROM app.neighborhood_assessment_applications
     WHERE report_file_id=$1 AND (operation_id=$2 OR application_identity_sha256=$3)`,
  [record.report_file_id, record.operation_id, identity]), "receipt_conflict");
  if (conflict.request_digest_sha256 !== record.request_digest_sha256) fail("receipt_conflict");
  const saved = await getAcceptedNeighborhoodApplication(client, { ...target, applicationIdentitySha256: identity });
  equals(saved, receipt, "receipt_conflict");
  return freeze({ receipt: saved, application_id: conflict.id, reused: true });
}
