import { assessmentEvidenceDigest, canonicalAssessmentJson } from "./contract.js";

/** Pure preflight of a SERVER-PRODUCED, format-specific coherent operation.
 * Not an authorization gate or a writer. The workflow owner supplies canonical
 * catalog target keys/values, locks its target revision, validates its relevant
 * cross-field rules and writes this manifest with the accepted revision/audit.
 * Never pass caller-defined group membership as the server manifest.
 */
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const snapshot = value => freeze(JSON.parse(canonicalAssessmentJson(value)));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const isRevision = value => Number.isSafeInteger(value) && value >= 0;
const isDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Construct a receipt to persist INSIDE the owner's successful transaction.
 * This function does not save, sign, authorize, or prove that a write happened.
 * Preflight accepts receipts only from the owner's trusted persistence lookup.
 */
export function buildNeighborhoodApplicationReceipt(prepared, accepted_editor_revision) {
  const plan = snapshot(prepared);
  const manifest = plan.acceptance_manifest;
  if (plan.status !== "ready" || plan.conflicts.length || !manifest ||
      !isRevision(accepted_editor_revision) || !isRevision(manifest.base_editor_revision) ||
      accepted_editor_revision <= manifest.base_editor_revision) {
    throw new TypeError("invalid_neighborhood_application_receipt");
  }
  const receipt = { receipt_version: 1, accepted_editor_revision, acceptance_manifest: manifest };
  return snapshot({ ...receipt, receipt_digest_sha256: assessmentEvidenceDigest(receipt) });
}

export function neighborhoodMappedManifestDigest(suggestions) {
  return assessmentEvidenceDigest(suggestions.map(item => ({ ...item,
    dependency_ids: [...item.dependency_ids].sort(compare), evidence_refs: [...item.evidence_refs].sort(compare),
  })).sort((a, b) => compare(a.id, b.id)));
}

export function prepareNeighborhoodApplicationGroup(input) {
  try { return snapshot(prepare(input)); }
  catch { return snapshot({ status: "conflict", http_status: 409,
    conflicts: [{ code: "invalid_application_manifest", target_key: null }], writes: [], acceptance_manifest: null }); }
}

function prepare({
  attachment, expected_binding_digest, group, suggestions, selected_ids,
  current_application_identity_sha256, current_editor_revision,
  accepted_application = null, existing_values, validate_final_group,
}) {
  attachment = snapshot(attachment);
  group = snapshot(group);
  const conflicts = [];
  const add = (code, target_key = null) => conflicts.push({ code, target_key });
  const rejected = () => ({ status: "conflict", http_status: 409, conflicts, writes: [], acceptance_manifest: null });
  if (!attachment) { add("missing_attachment"); return rejected(); }
  const { binding_digest_sha256: digest, review_status: _reviewStatus, ...binding } = attachment;
  if (assessmentEvidenceDigest(binding) !== digest) { add("changed_attachment"); return rejected(); }
  const { application_identity_sha256: applicationIdentity, editor_revision: _editorRevision,
    attachment_revision: _attachmentRevision, ...stableBinding } = binding;
  const minimumEditorRevision = attachment.workflow_type === "uad_3_6" ? 1 : 0;
  if (assessmentEvidenceDigest(stableBinding) !== applicationIdentity ||
      applicationIdentity !== current_application_identity_sha256 || !isRevision(current_editor_revision) ||
      current_editor_revision < minimumEditorRevision) {
    add("stale_application_identity"); return rejected();
  }
  if (!group || group.application_mode !== "atomic" || group.status !== "ready" ||
      group.id !== attachment.application_group_id || group.revision !== attachment.application_group_revision ||
      group.effective_date !== attachment.effective_date || group.data_cutoff !== attachment.data_cutoff ||
      assessmentEvidenceDigest(group) !== attachment.application_group_sha256) {
    add("incompatible_application_group"); return rejected();
  }
  if (!Array.isArray(suggestions) || suggestions.length === 0 || suggestions.length > 1000 ||
      !Array.isArray(selected_ids) || selected_ids.length > 1000 ||
      !Array.isArray(existing_values) || existing_values.length > 1000 || typeof validate_final_group !== "function" ||
      suggestions.some(item => !Array.isArray(item?.dependency_ids) || item.dependency_ids.length > 1000 ||
        !Array.isArray(item?.evidence_refs) || item.evidence_refs.length > 1000)) {
    add("invalid_application_manifest"); return rejected();
  }
  suggestions = snapshot([...suggestions].sort((a, b) => compare(a.id, b.id)));
  existing_values = snapshot(existing_values);
  if (neighborhoodMappedManifestDigest(suggestions) !== attachment.mapped_manifest_sha256) {
    add("changed_mapped_manifest"); return rejected();
  }
  const byId = new Map();
  const targets = new Set();
  const evidenceRefs = new Set();
  for (const item of suggestions) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.target_key !== "string" || !item.target_key ||
        item.application_group_id !== group.id || !Array.isArray(item.dependency_ids) ||
        !Array.isArray(item.evidence_refs) || !Object.hasOwn(item, "value") ||
        [...item.dependency_ids, ...item.evidence_refs].some(id => typeof id !== "string" || !id || id.length > 300) ||
        new Set(item.dependency_ids).size !== item.dependency_ids.length ||
        new Set(item.evidence_refs).size !== item.evidence_refs.length) {
      add("invalid_suggestion"); continue;
    }
    if (byId.has(item.id)) add("duplicate_suggestion_id", item.target_key);
    if (targets.has(item.target_key)) add("duplicate_target_key", item.target_key);
    byId.set(item.id, item); targets.add(item.target_key);
    item.evidence_refs.forEach(ref => evidenceRefs.add(ref));
  }
  if (!["geographic_neighborhood", ...group.required_statistic_ids.map(id => `statistic:${id}`),
    ...group.population_refs.map(item => `population:${item.id}`), ...group.source_refs.map(id => `source:${id}`)]
    .every(ref => evidenceRefs.has(ref))) add("missing_group_evidence_mapping");
  const selected = new Set(selected_ids);
  if (selected.size !== selected_ids.length) add("duplicate_selection");
  // The complete mapper-produced group is required, including existing source
  // entities. Callers cannot prune a boundary/source and keep only the prices.
  if (selected.size !== byId.size || [...byId.keys()].some(id => !selected.has(id))) add("partial_atomic_group");
  if ([...selected].some(id => !byId.has(id))) add("unknown_selection");
  for (const item of byId.values()) {
    if (item.dependency_ids.some(id => !byId.has(id))) add("missing_dependency", item.target_key);
  }
  const old = new Map();
  for (const item of existing_values) {
    if (!item || typeof item.target_key !== "string" || old.has(item.target_key)) {
      add("duplicate_or_invalid_existing_target"); continue;
    }
    old.set(item.target_key, item);
  }
  const provenance = {
    application_identity_sha256: applicationIdentity,
    attachment_id: attachment.attachment_id,
    report_file_id: attachment.report_file_id, workflow_type: attachment.workflow_type,
    custom_assignment_file_id: attachment.custom_assignment_file_id, uad_workfile_id: attachment.uad_workfile_id,
    mapped_manifest_sha256: attachment.mapped_manifest_sha256, source_digest_sha256: attachment.source_digest_sha256,
    assessment_id: attachment.assessment_id, assessment_revision: attachment.assessment_revision,
    assessment_digest: attachment.evidence_digest_sha256,
    application_group_id: group.id, application_group_revision: group.revision,
    scope: attachment.scope, effective_date: group.effective_date, data_cutoff: group.data_cutoff,
    geometry_sha256: group.geometry_sha256, population_refs: group.population_refs, source_refs: group.source_refs,
    mapper_version: attachment.mapper_version, specification_release: attachment.specification_release,
  };
  const provenanceDigest = assessmentEvidenceDigest(provenance);
  // Receipt lookup precedes ordinary optimistic binding checks: the first save
  // advances the editor revision itself. Only that exact accepted revision may
  // replay. A later unrelated edit is still a conflict, even if these values match.
  let acceptedManifest = null;
  if (accepted_application !== null) {
    const { receipt_digest_sha256: receiptDigest, ...receipt } = snapshot(accepted_application);
    const saved = receipt.acceptance_manifest;
    if (receipt.receipt_version !== 1 || !isDigest(receiptDigest) || assessmentEvidenceDigest(receipt) !== receiptDigest ||
        !saved || saved.application_identity_sha256 !== applicationIdentity ||
        saved.attachment_id !== attachment.attachment_id || !isRevision(saved.attachment_revision) || saved.attachment_revision < 1 ||
        !isDigest(saved.binding_digest_sha256) || !isRevision(saved.base_editor_revision) ||
        saved.base_editor_revision < minimumEditorRevision ||
        assessmentEvidenceDigest({ ...binding, editor_revision: saved.base_editor_revision,
          attachment_revision: saved.attachment_revision }) !== saved.binding_digest_sha256 ||
        !isRevision(receipt.accepted_editor_revision) || receipt.accepted_editor_revision <= saved.base_editor_revision ||
        saved.mapped_manifest_sha256 !== attachment.mapped_manifest_sha256 ||
        saved.provenance_digest !== provenanceDigest || assessmentEvidenceDigest(saved.provenance) !== provenanceDigest ||
        !Array.isArray(saved.applied) || !Array.isArray(saved.reused) ||
        canonicalAssessmentJson([...saved.applied, ...saved.reused].sort((a, b) => compare(a.id, b.id))) !==
          canonicalAssessmentJson(suggestions.map(({ id, target_key, value }) => ({ id, target_key, value })))) {
      add("incompatible_application_receipt"); return rejected();
    }
    if (receipt.accepted_editor_revision !== current_editor_revision) {
      add("stale_accepted_application"); return rejected();
    }
    acceptedManifest = saved;
  } else if (attachment.binding_digest_sha256 !== expected_binding_digest || attachment.editor_revision !== current_editor_revision) {
    add("stale_attachment"); return rejected();
  }
  const writes = [], reused = [], finalValues = [];
  for (const item of byId.values()) {
    const previous = old.get(item.target_key);
    if (previous?.target_exists === false) {
      add("missing_target", item.target_key); continue;
    }
    if (!previous || previous.target_exists !== true) {
      add("unresolved_target", item.target_key); continue;
    }
    if (previous.populated === true) {
      if (canonicalAssessmentJson(previous.value) !== canonicalAssessmentJson(item.value) ||
          previous.provenance_digest !== provenanceDigest) {
        add("incompatible_existing_value", item.target_key); continue;
      }
      reused.push({ id: item.id, target_key: item.target_key, value: item.value });
    } else if (previous.populated === false) {
      writes.push({ id: item.id, target_key: item.target_key, value: item.value });
    } else { add("unknown_existing_value_state", item.target_key); continue; }
    finalValues.push({ target_key: item.target_key, value: item.value });
  }
  if (acceptedManifest && (writes.length || acceptedManifest.prepared_values_sha256 !== assessmentEvidenceDigest(finalValues))) {
    add("changed_accepted_values");
  }
  if (!acceptedManifest && !writes.length && reused.length) add("missing_application_receipt");
  if (conflicts.length) return rejected();
  const validation = validate_final_group(snapshot(finalValues));
  if (!validation || validation.valid !== true || !Array.isArray(validation.issues) || validation.issues.length) {
    add("invalid_final_group"); return rejected();
  }
  return {
    status: acceptedManifest ? "already_applied" : "ready", http_status: 200, conflicts: [], writes,
    acceptance_manifest: acceptedManifest ?? {
      application_identity_sha256: applicationIdentity, base_editor_revision: current_editor_revision,
      attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
      binding_digest_sha256: digest, provenance, provenance_digest: provenanceDigest,
      mapped_manifest_sha256: attachment.mapped_manifest_sha256,
      prepared_values_sha256: assessmentEvidenceDigest(finalValues),
      applied: writes, reused,
    },
  };
}
