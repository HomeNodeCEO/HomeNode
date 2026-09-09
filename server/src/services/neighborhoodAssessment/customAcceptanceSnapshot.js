import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment,
  canonicalAssessmentJson } from "./contract.js";
import { buildNeighborhoodApplicationReceipt, prepareNeighborhoodApplicationGroup } from "./applicationGroup.js";
import { assertNeighborhoodJsonbStorage } from "./jsonbStorage.js";

export const CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION = "neighborhood_assessment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fail(code) {
  throw Object.assign(new TypeError(`custom_neighborhood_acceptance_${code}`), {
    code: `custom_neighborhood_acceptance_${code}`,
  });
}
function copy(value) {
  const result = JSON.parse(canonicalAssessmentJson(value));
  assertNeighborhoodJsonbStorage(result);
  return result;
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function equal(left, right, code) {
  if (canonicalAssessmentJson(left) !== canonicalAssessmentJson(right)) fail(code);
}
function uuid(value, name) {
  if (typeof value !== "string" || !UUID.test(value)) fail(`invalid_${name}`);
  return value.toLowerCase();
}

/** Reconstruct derived receipts; never persist unchecked duplicate digest fields.
 * This proves structural coherence, not authorization or actual previous values.
 * The owner still locks, validates and saves the entire group in one transaction.
 */
export function reconstructCustomNeighborhoodAcceptanceSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_input");
  equal(Object.keys(input).sort(), ["acceptedEditorRevision", "actorUserId", "assessment", "attachment",
    "decision", "mappedSuggestions", "operationId"].sort(), "invalid_input_shape");
  // Each constituent retains its existing contract limit; a large assessment
  // need not fit in the same canonical buffer as the much smaller saved section.
  const raw = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, copy(value)]));
  const operationId = uuid(raw.operationId, "operation_id"), actorUserId = uuid(raw.actorUserId, "actor_user_id");
  const assessment = buildNeighborhoodAssessment(raw.assessment);
  equal(raw.assessment, assessment, "assessment_changed");
  const attachment = buildNeighborhoodAttachment(assessment, raw.attachment);
  equal(raw.attachment, attachment, "attachment_changed");
  if (attachment.workflow_type !== "custom_appraisal" || attachment.uad_workfile_id !== null) fail("custom_target_required");
  if (!Number.isSafeInteger(raw.acceptedEditorRevision)
    || raw.acceptedEditorRevision > 2_147_483_647
    || raw.acceptedEditorRevision !== attachment.editor_revision + 1) fail("invalid_accepted_revision");
  const decision = raw.decision;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(decision) || !object(decision.applied) || !object(decision.reused)
    || !Array.isArray(raw.mappedSuggestions) || !raw.mappedSuggestions.length
    || raw.mappedSuggestions.length > 1000) fail("invalid_decision");
  equal(Object.keys(decision).sort(), ["applied", "reused"], "invalid_decision");
  const suggestions = [...raw.mappedSuggestions].sort((a, b) => compare(a?.id, b?.id));
  if (suggestions.some(item => !item || typeof item.id !== "string")) fail("invalid_suggestions");
  const appliedIds = Object.keys(decision.applied), reusedIds = Object.keys(decision.reused);
  if (!appliedIds.length || [...Object.values(decision.applied), ...Object.values(decision.reused)].some(value => value !== true)
    || appliedIds.some(id => Object.hasOwn(decision.reused, id))) fail("invalid_decision");
  equal([...appliedIds, ...reusedIds].sort(compare), suggestions.map(item => item.id), "incomplete_decision");
  const prepare = provenanceDigest => prepareNeighborhoodApplicationGroup({
    attachment, group: assessment.application_group, suggestions,
    expected_binding_digest: attachment.binding_digest_sha256,
    current_application_identity_sha256: attachment.application_identity_sha256,
    current_editor_revision: attachment.editor_revision,
    selected_ids: suggestions.map(item => item.id),
    existing_values: suggestions.map(item => provenanceDigest && Object.hasOwn(decision.reused, item.id)
      ? { target_key: item.target_key, target_exists: true, populated: true,
        value: item.value, provenance_digest: provenanceDigest }
      : { target_key: item.target_key, target_exists: true, populated: false }),
    // Structural closure only. Actual Custom catalog/cross-field validation and
    // comparison with the locked workfile remain the transaction owner's job.
    validate_final_group: () => ({ valid: true, issues: [] }),
  });
  // The shared engine owns provenance construction; do not duplicate its rules.
  const allApplied = prepare(null);
  if (allApplied.status !== "ready") fail("incoherent_group");
  const plan = reusedIds.length ? prepare(allApplied.acceptance_manifest.provenance_digest) : allApplied;
  if (plan.status !== "ready") fail("incoherent_group");
  const receipt = buildNeighborhoodApplicationReceipt(plan, raw.acceptedEditorRevision);
  const sectionValue = copy({ schema_version: 1, operation_id: operationId, actor_user_id: actorUserId,
    attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
    application_identity_sha256: attachment.application_identity_sha256,
    accepted_editor_revision: raw.acceptedEditorRevision, decision,
    // Objects make membership independent of JSON key order in PostgreSQL.
    mapped_values: Object.fromEntries(suggestions.map(({ id, target_key, value }) => [id, { target_key, value }])),
  });
  return freeze({ section_key: CUSTOM_NEIGHBORHOOD_ACCEPTED_SECTION, section_value: sectionValue,
    section_value_sha256: assessmentEvidenceDigest(sectionValue), receipt });
}

/** Validate the live owner's shared receipt, but persist only its closed decision.
 * `receipt` on the returned envelope is derived; it is not part of section_value.
 */
export function prepareCustomNeighborhoodAcceptanceSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_input");
  equal(Object.keys(input).sort(), ["actorUserId", "assessment", "attachment", "mappedSuggestions",
    "operationId", "receipt"].sort(), "invalid_input_shape");
  const receipt = copy(input.receipt), manifest = receipt?.acceptance_manifest;
  if (!manifest || !Array.isArray(manifest.applied) || !Array.isArray(manifest.reused)
    || !Array.isArray(input.mappedSuggestions) || !input.mappedSuggestions.length
    || input.mappedSuggestions.length > 1000) fail("invalid_manifest");
  const { receipt: _receipt, ...rest } = input;
  const result = reconstructCustomNeighborhoodAcceptanceSnapshot({ ...rest,
    acceptedEditorRevision: receipt.accepted_editor_revision,
    decision: { applied: Object.fromEntries(manifest.applied.map(item => [item?.id, true])),
      reused: Object.fromEntries(manifest.reused.map(item => [item?.id, true])) } });
  equal(receipt, result.receipt, "receipt_changed");
  return result;
}
