import { buildNeighborhoodRelevanceDistributions, scoreNeighborhoodCandidate,
  NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION, NEIGHBORHOOD_RELEVANCE_WEIGHTS } from '../neighborhoodRelevance.js';
import { buildCustomCohortObservationPreview } from './customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from './customCohortPocketCatalog.js';
import { buildCustomCohortCurrentCadBaseline } from './customCohortCurrentCadBaseline.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint } from './customWorkspaceCheckpoint.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY = freeze({
  id: 'custom-current-observation-review-v1', revision: 1, curve_methodology_version: 6,
  weights: { gla: 0.4, age: 0.3, housing_type: 0.2, site_size: 1 / 30, proximity: 1 / 30, sale_price: 1 / 30 },
  minimum_mean_lower_bound: 55, minimum_mean_known_weight_percent: 70,
  denominator: 'every_unique_account_in_group_including_unknowns',
  calibration: 'initial_review_heuristic_not_empirical_reliability', output_utf8_bytes: 48_000_000,
});
const P = CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY;
const KEYS = Object.keys(P.weights), UNASSIGNED = 'discovery:unassigned';
const PHYSICAL = { gla: 'gla_sqft', age: 'year_built', site_size: 'site_area_sqft' };
const UNAVAILABLE = {
  housing_type: 'comparable_current_housing_taxonomy_not_retained',
  proximity: 'comparable_property_distance_not_retained',
  sale_price: 'comparable_unadjusted_sale_consideration_not_established',
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const rounded = n => Math.round(Math.max(0, Math.min(100, n)) * 10000) / 10000;
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_pocket_recommendation_${reason}`), {
    code: 'CUSTOM_COHORT_POCKET_RECOMMENDATION_INVALID', reason,
  });
}
function physical(value, key, year) {
  const literal = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!literal || literal.length > 128 || !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(literal)) return null;
  const number = Number(literal);
  return Number.isFinite(number) && number > 0
    && (key !== 'age' || (Number.isInteger(number) && number >= 1600 && number <= year)) ? number : null;
}
const cell = (state, value = null, origin = null) => ({ state, value, origin });
function observed(raw, key, year, origin) {
  if (!raw || raw.state !== 'observed') return cell(raw?.state ?? 'missing', null, origin);
  const value = physical(raw.exact_value ?? raw.value, key, year);
  return cell(value === null ? 'invalid' : 'observed', value, origin);
}
function materialCell(node, field, key, year, origin) {
  if (!node || node.state === 'absent') return null;
  if (node.state !== 'present') return cell(node.state, null, origin);
  const fieldCell = node.value?.[field];
  if (!fieldCell || fieldCell.state === 'absent') return null;
  if (fieldCell.state !== 'present') return cell(fieldCell.state, null, origin);
  const value = physical(fieldCell.value, key, year);
  return cell(value === null ? 'invalid' : 'observed', value, origin);
}
function materialSite(rows, year, origin) {
  if (!rows || rows.state === 'absent') return null;
  if (rows.state !== 'present') return cell(rows.state, null, origin);
  // Multiple retained land lines may overlap or describe different interests.
  // No unproven summation or fallback through an explicit empty/invalid edit.
  if (!Array.isArray(rows.entries) || rows.entries.length !== 1) return cell(rows.entries?.length ? 'ambiguous_rows' : 'missing', null, origin);
  return materialCell({ state: 'present', value: rows.entries[0].fields }, 'area_sqft', 'site_size', year, origin)
    ?? cell('missing', null, origin);
}
function materialPhysical(node, key, year, origin) {
  if (key === 'age') return materialCell(node, 'year_built', key, year, origin);
  // Match the Custom report's GLA alias precedence within the SAME source.
  // An explicit canonical null/invalid value blocks the alias and other sources.
  return materialCell(node, 'living_area_sqft', key, year, origin)
    ?? materialCell(node, 'total_living_area', key, year, origin);
}
function subjectObservations(input, stock, year) {
  const material = input.subject.material, target = input.subject.target;
  check(material?.material_input_version === 1 && material.profile_id === 'custom-neighborhood-physical-stock-inputs-v1'
    && material.profile_revision === '1' && material.workflow_type === 'custom_appraisal'
    && ['account_id', 'assignment_file_id', 'report_file_id'].every(key => material[key] === target[key]), 'subject_material_binding');
  const characteristics = material.assignment_sections.property_characteristics;
  const land = material.assignment_sections.land_details;
  check(['absent', 'object'].includes(characteristics.storage_state) && ['absent', 'object'].includes(land.storage_state), 'subject_material_state');
  const main = characteristics.projection?.main_improvement, current = material.retained_public;
  return Object.fromEntries(Object.entries(PHYSICAL).map(([key, field]) => [key, key === 'site_size'
    ? materialSite(land.projection?.land_detail, year, 'saved_subject')
      ?? materialSite(current.land, year, 'retained_subject_public')
      ?? observed(stock?.observations[field], key, year, 'current_subject_cad')
    : materialPhysical(main, key, year, 'saved_subject')
      ?? materialPhysical(current.improvement, key, year, 'retained_subject_public')
      ?? observed(stock?.observations[field], key, year, 'current_subject_cad')]));
}
function bounds(factors) {
  let lower = 0, weight = 0;
  for (const key of KEYS) if (factors[key].score !== null) { lower += P.weights[key] * factors[key].score; weight += P.weights[key]; }
  return { lower: rounded(lower), upper: rounded(lower + (1 - weight) * 100), known_weight_percent: rounded(weight * 100) };
}
function aggregate(rows) {
  const count = rows.length;
  const mean = key => count ? rounded(rows.reduce((sum, row) => sum + row.similarity[key], 0) / count) : null;
  return { member_count: count, similarity: { lower: mean('lower'), upper: mean('upper'), known_weight_percent: mean('known_weight_percent') },
    member_lower_bound_range: count ? { low: Math.min(...rows.map(row => row.similarity.lower)), high: Math.max(...rows.map(row => row.similarity.lower)) } : null,
    factor_coverage: Object.fromEntries(KEYS.map(key => {
      const states = {};
      for (const row of rows) states[row.factors[key].state] = (states[row.factors[key].state] ?? 0) + 1;
      return [key, { observed_count: states.observed ?? 0, unknown_count: count - (states.observed ?? 0), states }];
    })) };
}

/** Diagnostic consumer of an owner-authorized, exact retained context. Like the
 * observation preview/catalog, this does NOT re-admit graph bytes or confer
 * source rights/eligibility. The owner must prepare/load/freshness-check first.
 * No I/O, automatic selection, report writes or supported-fact publication.
 */
export function buildCustomCohortPocketRecommendation({ context_ref, retained_inputs: input, selection } = {}) {
  check(NEIGHBORHOOD_RELEVANCE_METHODOLOGY_VERSION === P.curve_methodology_version
    && KEYS.every(key => NEIGHBORHOOD_RELEVANCE_WEIGHTS[key] === P.weights[key]), 'curve_policy_changed');
  const intent = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: 1, active: {
    context_ref, observation_period: input?.study?.observation_period, selection,
  }, pending_capture: null }).active;
  const preview = buildCustomCohortObservationPreview({ context_ref: intent.context_ref, retained_inputs: input,
    selection: { revision: intent.selection.revision, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: input, preview });
  const groups = [...catalog.pockets, ...(catalog.unassigned.member_count ? [{ id: UNASSIGNED, label: 'Unassigned recorded group',
    county: null, account_ids: catalog.unassigned.account_ids, member_count: catalog.unassigned.member_count }] : [])];
  const groupIds = new Set(groups.map(group => group.id)), included = new Set(intent.selection.included_recorded_group_ids);
  check([...included].every(id => groupIds.has(id)), 'unknown_group_id');
  const groupByAccount = new Map();
  for (const group of groups) for (const id of group.account_ids) {
    check(!groupByAccount.has(id), 'overlapping_catalog_accounts'); groupByAccount.set(id, group.id);
  }
  const members = preview.all.stock.members;
  check(groupByAccount.size === members.length && members.every(row => groupByAccount.has(row.account_id)), 'catalog_roster_mismatch');
  const subjectAccount = preview.target.account_id, subjectStock = members.find(row => row.account_id === subjectAccount);
  const year = Number(preview.captured_at.slice(0, 4));
  check(Number.isInteger(year) && year >= 1600 && year <= 9999, 'capture_year');
  const subject = subjectObservations(input, subjectStock, year);
  const reference = Object.fromEntries(Object.entries(PHYSICAL).map(([key, field]) => [field, subject[key].value]));
  const candidateRows = members.map(row => ({ account_id: row.account_id, ...Object.fromEntries(Object.entries(PHYSICAL)
    .map(([key, field]) => [field, observed(row.observations[field], key, year).value])) }));
  // All captured accounts establish one fixed curve baseline; toggling groups
  // cannot silently alter a property's score. Ignore the legacy renormalized
  // total, legal-neighborhood protection, exclusions and confidence entirely.
  const distributions = buildNeighborhoodRelevanceDistributions(reference, candidateRows);
  let outputBytes = 16000;
  const charge = value => { outputBytes += Buffer.byteLength(JSON.stringify(value)); check(outputBytes <= P.output_utf8_bytes, 'output_byte_limit'); return value; };
  const properties = members.map((row, index) => {
    const scored = scoreNeighborhoodCandidate({ subject: reference, candidate: candidateRows[index], distributions });
    const factors = Object.fromEntries(KEYS.map(key => {
      if (UNAVAILABLE[key]) return [key, { score: null, state: 'not_established' }];
      const candidate = observed(row.observations[PHYSICAL[key]], key, year);
      let state = subject[key].state !== 'observed' ? `subject_${subject[key].state}`
        : candidate.state !== 'observed' ? `candidate_${candidate.state}` : 'observed';
      const score = scored.factors[key].score;
      if (state === 'observed' && (!Number.isFinite(score) || score < 0 || score > 100)) state = 'calculation_unavailable';
      return [key, { score: state === 'observed' ? score : null, state }];
    }));
    const groupId = groupByAccount.get(row.account_id);
    return charge({ account_id: row.account_id, recorded_group_id: groupId, is_subject: row.account_id === subjectAccount,
      selected: included.has(groupId), similarity: bounds(factors), factors,
      partially_observed_factors: Object.entries(PHYSICAL).filter(([, field]) => row.observations[field].state === 'observed'
        && row.observations[field].missing_record_count > 0).map(([key]) => key) });
  });
  const byAccount = new Map(properties.map(row => [row.account_id, row]));
  const subjectGroup = catalog.subject_membership.assigned_pocket_id;
  const pockets = groups.map(group => {
    const result = aggregate(group.account_ids.map(id => byAccount.get(id)));
    const meetsPolicy = result.member_count > 0 && result.similarity.known_weight_percent >= P.minimum_mean_known_weight_percent
      && result.similarity.lower >= P.minimum_mean_lower_bound;
    return charge({ id: group.id, label: group.label, county: group.county, account_ids: [...group.account_ids],
      selected: included.has(group.id), contains_subject: group.account_ids.includes(subjectAccount),
      subject_group_review: group.id === subjectGroup, recorded_label_match_only: true,
      boundary_status: 'not_established', competitive_eligibility: 'not_established', result,
      meets_review_policy: meetsPolicy, suggested_for_review: catalog.catalog_complete && !!subjectStock && group.id !== UNASSIGNED && meetsPolicy });
  }).sort((a, b) => (b.result.similarity.lower ?? -1) - (a.result.similarity.lower ?? -1)
    || (b.result.similarity.known_weight_percent ?? -1) - (a.result.similarity.known_weight_percent ?? -1) || compare(a.id, b.id));
  pockets.forEach((pocket, index) => { pocket.review_rank = index + 1; });
  const selected = properties.filter(row => row.selected);
  const result = {
    recommendation_version: 1, policy: P, status: catalog.catalog_complete && subjectStock
      && subject.gla.state === 'observed' && subject.age.state === 'observed' ? 'recommendation_for_review' : 'insufficient_observations',
    basis: 'current_retained_observations', authority: 'not_established',
    binding: { context_ref: preview.context_ref, target: preview.target, selection_revision: intent.selection.revision,
      observation_period: preview.observation_period, captured_at: preview.captured_at }, selection: intent.selection,
    subject: { account_id: subjectAccount, in_discovery: !!subjectStock, in_selected_union: selected.some(row => row.is_subject),
      observations: subject, recorded_group_review_ids: subjectGroup ? [subjectGroup] : [], membership: catalog.subject_membership },
    properties, pockets, all: aggregate(properties), selected: { ...aggregate(selected), account_ids: selected.map(row => row.account_id) },
    recommended_recorded_group_ids: pockets.filter(pocket => pocket.suggested_for_review).map(pocket => pocket.id),
    coverage: { ...catalog.coverage, catalog_complete: catalog.catalog_complete, source_records_examined: preview.work.source_records },
    unavailable_factors: UNAVAILABLE,
    limitations: ['current_observations_not_historical_housing_population', 'similarity_bounds_not_probability_confidence_or_reliability',
      'all_unique_accounts_count_equally_including_missing_invalid_conflicting', 'subject_group_review_does_not_force_selection_or_raise_score',
      'recorded_names_not_legal_neighborhood_boundaries', 'no_builder_hoa_phase_or_amenity_identity_inferred',
      'source_current_price_and_cad_assessed_value_not_used_as_sale_consideration', 'median_is_not_predominant_cod_is_not_reliability',
      'no_automatic_inclusion_exclusion_or_report_apply', ...catalog.reasons],
    apply: { status: 'blocked', reasons: ['current_observation_recommendation_is_not_a_supported_assessment'] },
  };
  const cad = buildCustomCohortCurrentCadBaseline({ retained_inputs: input, preview, groups });
  if (cad !== null) result.cad_recorded_evidence = cad;
  charge({ all: result.all, selected: result.selected, subject: result.subject });
  // Incremental checks limit construction. Count the COMPLETE final envelope as
  // well, including both ID lists, ranks, separators and binding/disclosures.
  check(Buffer.byteLength(JSON.stringify(result)) <= P.output_utf8_bytes, 'output_byte_limit');
  return freeze(result);
}
