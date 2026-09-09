import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment,
  canonicalAssessmentJson } from "./contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest, prepareNeighborhoodApplicationGroup } from "./applicationGroup.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "./customAcceptanceSnapshot.js";
import { normalizeCustomAppraisalSectionValue } from "../customAppraisalSectionValue.js";

export const CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION = "custom-neighborhood-report-v1";
// These are the five dependent values of the reserved workfile section, NOT
// assignment_details aliases. Keeping a median in its typed statistic avoids
// silently exporting it into the old form's "predominant" field.
const PARTS = Object.freeze(["geography", "selection", "populations", "statistics", "evidence"]);
const key = part => `custom_neighborhood:${part}`;
const id = part => `custom-neighborhood-report:${part}`;
const equal = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const copy = value => JSON.parse(canonicalAssessmentJson(value));
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function requireThat(condition, code) {
  if (!condition) throw new TypeError(`custom_neighborhood_report_${code}`);
}
function targetOf(assessment, target) {
  requireThat(target.workflow_type === "custom_appraisal" && target.uad_workfile_id === null
    && target.specification_release === null, "custom_target_required");
  requireThat(equal(target.scope, assessment.scope), "scope_mismatch");
  return { organization_id: assessment.scope.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.custom_assignment_file_id, account_id: assessment.scope.account_id };
}
function partition(assessment, target) {
  const { geographic_neighborhood: geography, selection, populations, statistics, ...rest } = assessment;
  return { geography, selection, populations, statistics,
    evidence: { mapper_version: CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION, target, assessment: rest } };
}
function suggestionsFor(assessment, target) {
  const parts = partition(assessment, target), group = assessment.application_group;
  const references = {
    geography: ["geographic_neighborhood"], selection: [],
    populations: assessment.populations.map(item => `population:${item.id}`),
    statistics: assessment.statistics.map(item => `statistic:${item.id}`),
    evidence: assessment.source_snapshots.map(item => `source:${item.id}`),
  };
  const dependencies = { geography: [], selection: ["geography"], populations: ["geography", "selection"],
    statistics: ["geography", "selection", "populations"], evidence: [] };
  return PARTS.map(part => ({ id: id(part), target_key: key(part), value: parts[part],
    application_group_id: group.id, dependency_ids: dependencies[part].map(id), evidence_refs: references[part] }))
    .sort((a, b) => a.id < b.id ? -1 : 1);
}
function checkedAssessment(value) {
  const assessment = buildNeighborhoodAssessment(copy(value));
  requireThat(equal(value, assessment), "assessment_changed");
  requireThat(assessment.application_group.status === "ready", "incomplete_assessment");
  return assessment;
}

/** Pure Custom catalog mapper. Source/context resolution and authorization stay
 * with the workflow owner. It maps ALL populations/statistics, including honest
 * unsupported optional measures, without recomputing or pooling their values.
 * The catalog is consumed as one read-only report group by screen and export.
 */
export function buildCustomNeighborhoodReportCandidate({ assessment: input, target }) {
  try {
    const assessment = checkedAssessment(input);
    const binding = targetOf(assessment, target);
    const suggestions = suggestionsFor(assessment, binding);
    const attachment = buildNeighborhoodAttachment(assessment, { ...target,
      mapper_version: CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION,
      mapped_manifest_sha256: neighborhoodMappedManifestDigest(suggestions),
      source_digest_sha256: assessmentEvidenceDigest({ target: binding, assessment,
        mapper_version: CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION }) });
    // The same limits used by persistence apply here, before offering Apply.
    canonicalAssessmentJson(suggestions);
    // Capacity rehearsal only, never actual occupancy, authorization or a receipt
    // to return/save. Shared manifests duplicate some values, so checking just
    // the suggestion bytes would incorrectly advertise oversized groups as ready.
    const capacity = prepareNeighborhoodApplicationGroup({ attachment, group: assessment.application_group, suggestions,
      selected_ids: suggestions.map(item => item.id), expected_binding_digest: attachment.binding_digest_sha256,
      current_application_identity_sha256: attachment.application_identity_sha256, current_editor_revision: attachment.editor_revision,
      existing_values: suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
      validate_final_group: () => ({ valid: true, issues: [] }) });
    requireThat(capacity.status === "ready", "candidate_capacity");
    const capacitySnapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment, mappedSuggestions: suggestions,
      actorUserId: "00000001-0000-4000-8000-000000000001", operationId: "00000002-0000-4000-8000-000000000002",
      receipt: buildNeighborhoodApplicationReceipt(capacity, attachment.editor_revision + 1) });
    normalizeCustomAppraisalSectionValue(capacitySnapshot.section_value);
    return freeze({ status: "ready", mapper_version: CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION,
      attachment, group: assessment.application_group, suggestions });
  } catch (error) {
    return freeze({ status: "incomplete", issues: [{ code: error.message }], suggestions: [] });
  }
}

/** The workflow owner must supply ACTUAL locked occupancy, not empty synthetic
 * slots. This function creates a plan only; it neither authorizes nor saves it.
 * Current identity/revision/receipt are server-resolved, never browser claims.
 */
export function prepareCustomNeighborhoodReportApply({ assessment, target, existing_values, request,
  current_application_identity_sha256, current_editor_revision, accepted_application = null }) {
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target });
  if (candidate.status !== "ready") return freeze({ status: "conflict", writes: [], acceptance_manifest: null,
    conflicts: candidate.issues });
  return prepareNeighborhoodApplicationGroup({ attachment: candidate.attachment, group: candidate.group,
    suggestions: candidate.suggestions, selected_ids: request?.selected_ids,
    expected_binding_digest: request?.binding_digest_sha256,
    current_application_identity_sha256, current_editor_revision, accepted_application, existing_values,
    validate_final_group: values => {
      const order = items => items.map(({ target_key, value }) => ({ target_key, value }))
        .sort((a, b) => a.target_key < b.target_key ? -1 : 1);
      const valid = equal(order(values), order(candidate.suggestions));
      return { valid, issues: valid ? [] : [{ code: "custom_neighborhood_report_catalog_changed" }] };
    } });
}

/** Reconstruct ONLY the exact saved catalog group. Call after the owner has
 * authenticated/authorized and verified this section against its acceptance
 * history, or from an already verified immutable signed snapshot. No latest
 * lookup, legacy field fallback, source query, or recalculation is performed.
 */
export function projectCustomNeighborhoodReportSection({ section, expected }) {
  try {
    requireThat(section?.schema_version === 1 && section.mapped_values && typeof section.mapped_values === "object"
      && !Array.isArray(section.mapped_values), "invalid_section");
    const mapped = Object.entries(section.mapped_values);
    requireThat(mapped.length === PARTS.length && PARTS.every(part => Object.hasOwn(section.mapped_values, id(part))), "catalog_mismatch");
    const parts = Object.fromEntries(PARTS.map(part => {
      const item = section.mapped_values[id(part)];
      requireThat(item?.target_key === key(part) && equal(Object.keys(item).sort(), ["target_key", "value"]), "catalog_mismatch");
      return [part, item.value];
    }));
    requireThat(parts.evidence?.mapper_version === CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION, "mapper_mismatch");
    requireThat(expected && equal(Object.keys(expected).sort(), ["account_id", "assignment_file_id", "organization_id", "report_file_id"])
      && equal(expected, parts.evidence.target), "target_mismatch");
    const assessment = checkedAssessment({ ...parts.evidence.assessment, geographic_neighborhood: parts.geography,
      selection: parts.selection, populations: parts.populations, statistics: parts.statistics });
    requireThat(assessment.scope.organization_id === expected.organization_id && assessment.scope.account_id === expected.account_id,
      "scope_mismatch");
    const rebuilt = suggestionsFor(assessment, expected);
    requireThat(equal(section.mapped_values, Object.fromEntries(rebuilt.map(item => [item.id,
      { target_key: item.target_key, value: item.value }]))), "catalog_changed");
    const decision = section.decision;
    requireThat(decision && equal(Object.keys(decision).sort(), ["applied", "reused"])
      && decision.applied && decision.reused && !Array.isArray(decision.applied) && !Array.isArray(decision.reused), "decision_invalid");
    const decisions = [...Object.entries(decision.applied), ...Object.entries(decision.reused)];
    requireThat(Object.keys(decision.applied).length > 0 && decisions.length === PARTS.length
      && new Set(decisions.map(([name]) => name)).size === PARTS.length
      && decisions.every(([name, accepted]) => accepted === true && PARTS.some(part => id(part) === name)), "partial_group");
    return freeze({ status: "ready", mapper_version: CUSTOM_NEIGHBORHOOD_REPORT_MAPPER_VERSION,
      operation_id: section.operation_id, accepted_editor_revision: section.accepted_editor_revision, assessment });
  } catch (error) {
    return freeze({ status: "unavailable", reason: error.message, assessment: null });
  }
}
