import {
  assessmentDate, assessmentEvidenceDigest, buildNeighborhoodAssessment,
  buildNeighborhoodAttachment, canonicalAssessmentJson,
} from "../../services/neighborhoodAssessment/contract.js";
import {
  buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest,
  prepareNeighborhoodApplicationGroup,
} from "../../services/neighborhoodAssessment/applicationGroup.js";
import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";
import { getUadField, normalizeAndValidateUadValue } from "./fieldCatalog.js";
import { isUadWorkfileMutable } from "./workfileLifecycle.js";

// Dormant pure adapter. All inputs other than `request` must come from trusted,
// authorized server resolution. Hashes detect changed evidence, not authority.
export const UAD_NEIGHBORHOOD_MAPPER_VERSION = "uad-neighborhood-market-v1";
const SUPPORTED_RELEASE = "uad-3.6-2026-08-13-h1.5";
const KEYS = Object.freeze({
  boundary: "market:3000.0008", criteria: "market:3000.0010", months: "market:3000.0009",
  count: "market_total_sales:3000.0026", low: "market_total_sales:3000.0028",
  median: "market_total_sales:3000.0029", high: "market_total_sales:3000.0027",
});
const DIGEST = /^[a-f0-9]{64}$/;
const equal = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const copy = value => JSON.parse(canonicalAssessmentJson(value));
const fail = code => { throw new Error(code); };
const requireThat = (value, code) => { if (!value) fail(code); };
const rejected = (code, details = []) => freeze({ status: "conflict", conflicts: [{ code }, ...details],
  writes: [], acceptance_manifest: null });

function field(key) {
  const [context, uid] = key.split(":");
  const result = getUadField(context, uid);
  requireThat(result && result.section === "market" && !result.entityType, "unsupported_catalog_target");
  return result;
}

function catalog(release) {
  requireThat(release === SUPPORTED_RELEASE && CURRENT_UAD_RELEASE_KEY === SUPPORTED_RELEASE,
    "unsupported_specification_release");
  return assessmentEvidenceDigest(Object.values(KEYS).map(key => field(key)));
}

function validateValue(key, value) {
  const definition = field(key);
  // No loss-producing truncation, clamping, numeric-string or blank coercion.
  requireThat(definition.dataType === "text" ? typeof value === "string" && value.trim().length > 0
    : typeof value === "number" && Number.isFinite(value), "invalid_catalog_value");
  const result = normalizeAndValidateUadValue(definition, value);
  requireThat(!result.error && equal(result.value, value), "invalid_catalog_value");
  return value;
}

function validateFinal(values) {
  try {
    const byKey = new Map();
    for (const item of values) {
      requireThat(Object.values(KEYS).includes(item.target_key) && !byKey.has(item.target_key), "invalid_catalog_target");
      byKey.set(item.target_key, validateValue(item.target_key, item.value));
    }
    for (const name of ["boundary", "criteria", "months", "count"]) requireThat(byKey.has(KEYS[name]), "missing_market_companion");
    const prices = [KEYS.low, KEYS.median, KEYS.high];
    if (byKey.get(KEYS.count) > 0) {
      requireThat(prices.every(key => byKey.has(key)), "missing_market_companion");
      requireThat(byKey.get(KEYS.low) <= byKey.get(KEYS.median) && byKey.get(KEYS.median) <= byKey.get(KEYS.high), "market_sale_price_order");
    } else requireThat(prices.every(key => !byKey.has(key)), "zero_sales_with_prices");
    return { valid: true, issues: [] };
  } catch (error) { return { valid: false, issues: [{ code: error.message }] }; }
}

// Inclusive calendar-month periods only. Other date conventions need their own
// reviewed mapper version; a guessed/rounded number of months is not accepted.
function validateLookback(period, months, effectiveDate) {
  validateValue(KEYS.months, months);
  requireThat(period.date_basis === "closing_date" && period.end_date === effectiveDate,
    "unsupported_market_period");
  const end = new Date(`${assessmentDate(period.end_date)}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  requireThat(period.start_date === end.toISOString().slice(0, 10), "lookback_period_mismatch");
}

function normalizedContext(assessment, value) {
  const context = copy(value);
  requireThat(context.context_version === 1 && context.assessment_digest_sha256 === assessment.evidence_digest_sha256,
    "changed_market_context");
  const population = assessment.populations.find(item => item.id === context.population_ref?.id);
  requireThat(population && equal(context.population_ref, {
    id: population.id, revision: population.revision, member_set_sha256: population.member_set_sha256,
  }), "changed_market_population");
  requireThat(assessment.required_population_ids.includes(population.id) && population.completeness === "complete" &&
    population.kind === "transactions" && population.member_unit === "canonical_transaction" &&
    population.property_link_count === population.member_count &&
    context.transaction_scope === "closed_single_property_sales", "unsupported_market_population");
  requireThat(equal(context.observation_period, population.observation_period) &&
    equal(context.observation_period, assessment.observation_period) && assessment.data_cutoff === assessment.effective_date,
    "market_period_mismatch");
  validateLookback(context.observation_period, context.lookback_months, assessment.effective_date);
  const geometry = context.analysis_geometry;
  requireThat(geometry && ["geographic_neighborhood", "competitive_market"].includes(geometry.role) &&
    typeof geometry.revision === "string" && geometry.revision.length > 0 && geometry.revision.length <= 200 &&
    DIGEST.test(geometry.geometry_sha256), "missing_market_geography");
  if (geometry.role === "geographic_neighborhood") requireThat(
    geometry.geometry_sha256 === assessment.application_group.geometry_sha256 &&
    geometry.revision === assessment.geographic_neighborhood.revision &&
    geometry.boundary_description === ["north", "east", "south", "west"].map(direction =>
      `${direction[0].toUpperCase()}${direction.slice(1)}: ${assessment.geographic_neighborhood.cardinal_summaries[direction]}`
    ).join("; ") + ".", "market_geography_mismatch");
  validateValue(KEYS.boundary, geometry.boundary_description);
  validateValue(KEYS.criteria, context.search_criteria);
  requireThat(Array.isArray(context.source_refs) && context.source_refs.length > 0 && context.source_refs.length <= 1000 &&
    new Set(context.source_refs).size === context.source_refs.length &&
    context.source_refs.every(id => assessment.application_group.source_refs.includes(id)), "unbound_market_context_source");
  requireThat(context.statistic_ids && equal(Object.keys(context.statistic_ids).sort(), ["count", "high", "low", "median"]),
    "invalid_market_statistic_selection");
  // Explicit allowlist: undocumented input properties do not become evidence.
  return { context_version: 1, assessment_digest_sha256: context.assessment_digest_sha256,
    population_ref: context.population_ref, transaction_scope: context.transaction_scope,
    observation_period: context.observation_period, lookback_months: context.lookback_months,
    analysis_geometry: { role: geometry.role, revision: geometry.revision, geometry_sha256: geometry.geometry_sha256,
      boundary_description: geometry.boundary_description }, search_criteria: context.search_criteria,
    source_refs: [...context.source_refs].sort(), statistic_ids: context.statistic_ids };
}

function mappedStatistics(assessment, context) {
  const selected = context.statistic_ids;
  const count = assessment.statistics.find(item => item.id === selected.count);
  const population = assessment.populations.find(item => item.id === context.population_ref.id);
  const check = (item, measurement, estimator) => requireThat(item &&
    assessment.required_statistic_ids.includes(item.id) && item.status === "ready" && item.reason === null &&
    item.population_id === population.id && item.measurement === measurement && item.estimator === estimator &&
    item.denominator_basis === "population_members" && item.missing_count === 0 &&
    item.observed_count === population.member_count && item.denominator_count === population.member_count &&
    equal(item.observation_period, context.observation_period), "incomplete_market_statistic");
  check(count, "transaction_count", "count");
  const result = [{ name: "count", statistic: count }];
  if (count.value === 0) requireThat([selected.low, selected.median, selected.high].every(id => id === null), "zero_sales_with_prices");
  else for (const [name, estimator, probability] of [
    ["low", "exact_quantile", 0], ["median", "exact_median", null], ["high", "exact_quantile", 1],
  ]) {
    const item = assessment.statistics.find(stat => stat.id === selected[name]);
    check(item, "recorded_sale_price", estimator);
    if (probability !== null) requireThat(item.estimator_parameters.probability === probability, "unsupported_price_estimator");
    result.push({ name, statistic: item });
  }
  requireThat(new Set(result.map(item => item.statistic.id)).size === result.length &&
    equal(result.map(item => item.statistic.id).sort(), [...assessment.required_statistic_ids].sort()),
    "unmapped_required_statistic");
  return result;
}

/** Build from an immutable assessment and a server-resolved dated study context.
 * The context asserts the actual analysis geography/filters; this module does
 * not infer them from a descriptive neighborhood or an arbitrary first study.
 */
export function buildUadNeighborhoodCandidate({ assessment: input, target, market_context }) {
  try {
    const assessment = buildNeighborhoodAssessment(copy(input));
    requireThat(input.evidence_digest_sha256 === assessment.evidence_digest_sha256, "changed_assessment");
    requireThat(target.workflow_type === "uad_3_6", "wrong_workflow");
    const catalogDigest = catalog(target.specification_release);
    requireThat(assessment.application_group.status === "ready", "incomplete_assessment");
    const context = normalizedContext(assessment, market_context);
    const statistics = mappedStatistics(assessment, context);
    const group = assessment.application_group;
    const ids = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, `uad-neighborhood:${key}`]));
    const allEvidence = ["geographic_neighborhood", ...group.population_refs.map(item => `population:${item.id}`),
      ...group.source_refs.map(id => `source:${id}`)];
    const suggestion = (name, value, evidenceRefs, dependencies) => ({ id: ids[name], target_key: KEYS[name],
      value: validateValue(KEYS[name], value), application_group_id: group.id,
      dependency_ids: dependencies, evidence_refs: [...new Set(evidenceRefs)].sort() });
    const suggestions = [
      suggestion("boundary", context.analysis_geometry.boundary_description, allEvidence, []),
      suggestion("criteria", context.search_criteria, allEvidence, [ids.boundary]),
      suggestion("months", context.lookback_months, [`population:${context.population_ref.id}`], [ids.boundary, ids.criteria]),
      ...statistics.map(({ name, statistic }) => suggestion(name, statistic.value,
        [`statistic:${statistic.id}`, `population:${statistic.population_id}`, ...statistic.source_refs.map(id => `source:${id}`)],
        [ids.boundary, ids.criteria, ids.months])),
    ].sort((a, b) => a.id.localeCompare(b.id, "en"));
    requireThat(validateFinal(suggestions).valid, "invalid_market_companions");
    const evidence = { mapper_version: UAD_NEIGHBORHOOD_MAPPER_VERSION,
      assessment_digest_sha256: assessment.evidence_digest_sha256,
      catalog_digest_sha256: catalogDigest, market_context: context,
      geographic_neighborhood: { geometry_sha256: group.geometry_sha256,
        revision: group.geometry_revision, cardinal_summaries: assessment.geographic_neighborhood.cardinal_summaries },
      populations: assessment.populations.filter(item => assessment.required_population_ids.includes(item.id)),
      statistics: statistics.map(item => item.statistic),
      sources: assessment.source_snapshots.filter(item => group.source_refs.includes(item.id)) };
    const attachment = buildNeighborhoodAttachment(assessment, { ...target,
      source_digest_sha256: assessmentEvidenceDigest(evidence), mapped_manifest_sha256: neighborhoodMappedManifestDigest(suggestions),
      mapper_version: UAD_NEIGHBORHOOD_MAPPER_VERSION });
    const candidate = { candidate_version: 1, mapper_version: UAD_NEIGHBORHOOD_MAPPER_VERSION,
      status: "ready", attachment, group, suggestions, selected_suggestion_ids: [],
      evidence,
      omissions: ["active_listing_coverage_not_mapped", "pending_sales_coverage_not_mapped", "price_trend_review_required",
        "housing_trend_review_required", "land_use_has_no_verified_section17_mapping", "development_project_evidence_not_mapped"],
    };
    return freeze(copy({ ...candidate, candidate_digest_sha256: assessmentEvidenceDigest({
      application_identity_sha256: attachment.application_identity_sha256, mapper_version: candidate.mapper_version,
    }) }));
  } catch (error) {
    return freeze({ status: "incomplete", issues: [{ code: error.message }], suggestions: [], selected_suggestion_ids: [] });
  }
}

function validateOccupancy(candidate, existingValues) {
  requireThat(Array.isArray(existingValues) && existingValues.length <= 1000, "invalid_market_occupancy");
  const zeroSales = candidate.suggestions.find(item => item.target_key === KEYS.count).value === 0;
  const priceKeys = [KEYS.low, KEYS.median, KEYS.high];
  for (const key of Object.values(KEYS)) {
    const matches = existingValues.filter(item => item?.target_key === key);
    requireThat(matches.length === 1 && matches[0].target_exists === true, "unresolved_market_occupancy");
    const row = matches[0];
    requireThat((row.populated === false && row.value === null) ||
      (row.populated === true && row.value !== null && row.value !== undefined), "unknown_market_occupancy");
    if (zeroSales && priceKeys.includes(key)) requireThat(row.populated === false, "zero_sales_existing_prices");
  }
}

/** Pure write plan, not an HTTP handler or DB mutation. Regenerate with trusted
 * current assessment/target/context/occupancy/receipt, never a browser candidate.
 * Occupancy/provenance records use the accepted shared applicationGroup contract.
 */
export function prepareUadNeighborhoodApply({ assessment, target, market_context, existing_values, request, accepted_receipt = null }) {
  try {
    requireThat(isUadWorkfileMutable(target.status) && target.signed_at === null && target.has_signatures === false,
      "uad_workfile_status_locked");
    requireThat(request?.confirmed === true && request.preserve_existing === true, "appraiser_confirmation_required");
    const candidate = buildUadNeighborhoodCandidate({ assessment, target, market_context });
    requireThat(candidate.status === "ready", "neighborhood_candidate_incomplete");
    validateOccupancy(candidate, existing_values);
    requireThat(request.expected_candidate_digest_sha256 === candidate.candidate_digest_sha256, "stale_neighborhood_candidate");
    const saved = accepted_receipt === null ? null : checkedReceipt(accepted_receipt);
    const permittedRevision = saved ? saved.core_receipt.acceptance_manifest.base_editor_revision : target.editor_revision;
    requireThat(request.expected_revision === permittedRevision || (saved && request.expected_revision === target.editor_revision), "stale_editor_revision");
    requireThat(request.expected_binding_digest_sha256 === candidate.attachment.binding_digest_sha256 ||
      (saved && request.expected_binding_digest_sha256 === saved.core_receipt.acceptance_manifest.binding_digest_sha256), "stale_attachment");
    const plan = prepareNeighborhoodApplicationGroup({
      attachment: candidate.attachment, expected_binding_digest: request.expected_binding_digest_sha256,
      group: candidate.group, suggestions: candidate.suggestions, selected_ids: request.selected_suggestion_ids,
      current_application_identity_sha256: candidate.attachment.application_identity_sha256,
      current_editor_revision: target.editor_revision, accepted_application: saved?.core_receipt ?? null,
      existing_values, validate_final_group: validateFinal,
    });
    return freeze({ ...plan, candidate_digest_sha256: candidate.candidate_digest_sha256 });
  } catch (error) { return rejected(error.message); }
}

function checkedReceipt(input) {
  const receipt = copy(input);
  const { receipt_digest_sha256, ...body } = receipt;
  requireThat(receipt.receipt_version === 1 && DIGEST.test(receipt_digest_sha256) &&
    assessmentEvidenceDigest(body) === receipt_digest_sha256, "changed_uad_neighborhood_receipt");
  const candidate = receipt.candidate;
  requireThat(candidate?.status === "ready" && candidate.mapper_version === UAD_NEIGHBORHOOD_MAPPER_VERSION &&
    candidate.attachment.mapper_version === candidate.mapper_version &&
    neighborhoodMappedManifestDigest(candidate.suggestions) === candidate.attachment.mapped_manifest_sha256 &&
    candidate.candidate_digest_sha256 === assessmentEvidenceDigest({
      application_identity_sha256: candidate.attachment.application_identity_sha256, mapper_version: candidate.mapper_version,
    }), "changed_uad_neighborhood_receipt");
  const evidence = candidate.evidence;
  requireThat(candidate.attachment.source_digest_sha256 === assessmentEvidenceDigest(evidence) &&
    evidence.catalog_digest_sha256 === catalog(candidate.attachment.specification_release), "changed_uad_neighborhood_receipt");
  return receipt;
}

/** Caller persists this in the SAME successful transaction as canonical fields,
 * one revision and audit event. Construction is not proof of a committed save.
 */
export function buildUadNeighborhoodReceipt(candidate, plan, accepted_editor_revision) {
  requireThat(candidate.status === "ready" && plan.status === "ready" && plan.conflicts.length === 0 &&
    plan.acceptance_manifest?.application_identity_sha256 === candidate.attachment.application_identity_sha256 &&
    plan.acceptance_manifest.mapped_manifest_sha256 === candidate.attachment.mapped_manifest_sha256 &&
    accepted_editor_revision === candidate.attachment.editor_revision + 1, "invalid_uad_neighborhood_receipt");
  const body = { receipt_version: 1, candidate: copy(candidate),
    core_receipt: buildNeighborhoodApplicationReceipt(plan, accepted_editor_revision) };
  const receipt = { ...body, receipt_digest_sha256: assessmentEvidenceDigest(body) };
  const acceptedValues = candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true,
    populated: true, value: item.value, provenance_digest: plan.acceptance_manifest.provenance_digest }));
  for (const key of Object.values(KEYS)) if (!acceptedValues.some(item => item.target_key === key)) {
    acceptedValues.push({ target_key: key, target_exists: true, populated: false, value: null });
  }
  requireThat(projectUadNeighborhoodExport({ receipt, target: { ...candidate.attachment, editor_revision: accepted_editor_revision },
    existing_values: acceptedValues }).status === "ready", "invalid_uad_neighborhood_receipt");
  return freeze(receipt);
}

/** Read only the receipt and the requested, persisted report-revision snapshot.
 * No latest-assessment input or provider lookup. This is internal export support,
 * not an XML extension and not a signature/compliance certificate.
 */
export function projectUadNeighborhoodExport({ receipt: input, target, existing_values }) {
  try {
    const receipt = checkedReceipt(input);
    const { candidate, core_receipt: core } = receipt;
    validateOccupancy(candidate, existing_values);
    const binding = candidate.attachment;
    for (const key of ["scope", "report_file_id", "uad_workfile_id", "workflow_type", "custom_assignment_file_id",
      "effective_date", "data_cutoff", "specification_release", "attachment_id"]) {
      requireThat(equal(target[key], binding[key]), "export_target_mismatch");
    }
    requireThat(Number.isSafeInteger(target.editor_revision) && target.editor_revision >= core.accepted_editor_revision,
      "export_revision_predates_acceptance");
    const replay = prepareNeighborhoodApplicationGroup({ attachment: binding, group: candidate.group,
      suggestions: candidate.suggestions, selected_ids: candidate.suggestions.map(item => item.id),
      expected_binding_digest: binding.binding_digest_sha256, current_application_identity_sha256: binding.application_identity_sha256,
      current_editor_revision: core.accepted_editor_revision, accepted_application: core, existing_values, validate_final_group: validateFinal });
    requireThat(replay.status === "already_applied", "export_values_or_receipt_changed");
    return freeze({ status: "ready", report_file_id: binding.report_file_id, uad_workfile_id: binding.uad_workfile_id,
      revision: target.editor_revision, accepted_revision: core.accepted_editor_revision,
      fields: candidate.suggestions.map(item => ({ entity_id: null, field_key: item.target_key, value: item.value })),
      provenance: copy(core.acceptance_manifest.provenance), evidence: copy(candidate.evidence),
      receipt_digest_sha256: receipt.receipt_digest_sha256 });
  } catch (error) { return freeze({ status: "conflict", issues: [{ code: error.message }], fields: [], provenance: null }); }
}
