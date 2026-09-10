import { canonicalAssessmentJson as json } from './contract.js';
import { buildCustomCohortPocketRecommendation, CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY as POLICY } from './customCohortPocketRecommendation.js';

export const CUSTOM_COHORT_POCKET_RECOMMENDATION_PRESENTATION_LIMITS = Object.freeze({ pockets: 129,
  output_utf8_bytes: 512_000, text_utf8_bytes: 1024 });
const L = CUSTOM_COHORT_POCKET_RECOMMENDATION_PRESENTATION_LIMITS;
const FACTORS = Object.keys(POLICY.weights), UNASSIGNED = 'discovery:unassigned';
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_recommendation_presentation_${reason}`), {
    code: 'CUSTOM_COHORT_RECOMMENDATION_PRESENTATION_INVALID', reason,
  });
}
const count = n => { check(Number.isSafeInteger(n) && n >= 0, 'count'); return n; };
const flag = value => { check(typeof value === 'boolean', 'flag'); return value; };
function text(value) {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= L.text_utf8_bytes
    && !/[\u0000-\u001f\u007f]/.test(value), 'text'); return value;
}
function percent(value, empty = false) {
  check(empty ? value === null : Number.isFinite(value) && value >= 0 && value <= 100, 'bounds'); return value;
}
function aggregate(value) {
  const n = count(value.member_count), empty = n === 0;
  const similarity = Object.fromEntries(['lower', 'upper', 'known_weight_percent'].map(key => [key, percent(value.similarity[key], empty)]));
  check(empty || similarity.lower <= similarity.upper, 'bounds');
  const range = value.member_lower_bound_range;
  check(empty ? range === null : range && range.low <= range.high, 'range');
  const coverage = Object.fromEntries(FACTORS.map(key => {
    const field = value.factor_coverage[key], observed = count(field.observed_count), unknown = count(field.unknown_count);
    check(observed + unknown === n, 'denominator');
    const entries = Object.entries(field.states); check(entries.length <= 20, 'states');
    const states = Object.fromEntries(entries.map(([state, amount]) => [text(state), count(amount)]));
    check(Object.values(states).reduce((sum, amount) => sum + amount, 0) === n
      && (states.observed ?? 0) === observed, 'denominator');
    return [key, { observed_count: observed, unknown_count: unknown, states }];
  }));
  return { member_count: n, similarity, member_lower_bound_range: empty ? null : { low: percent(range.low), high: percent(range.high) },
    factor_coverage: coverage };
}

/** A compact full-discovery review baseline attached to an already bounded
 * catalog. Never expose per-property scores, raw subject material, member lists,
 * private target/source identities or selected-union calculations here. Rights,
 * exact retained loading and final freshness checks remain with the owner.
 */
export function presentCustomCohortPocketRecommendation({ recommendation, catalog, expected } = {}) {
  check(recommendation?.recommendation_version === 1 && recommendation.authority === 'not_established'
    && recommendation.apply?.status === 'blocked' && ['recommendation_for_review', 'insufficient_observations'].includes(recommendation.status), 'recommendation');
  check(catalog?.catalog_version === 1 && catalog.authority === 'not_established' && catalog.apply?.status === 'blocked', 'catalog');
  check(json(recommendation.policy) === json(POLICY), 'policy');
  check(json(recommendation.binding.context_ref) === json(expected.context_ref)
    && json(catalog.binding.context_ref) === json(expected.context_ref)
    && recommendation.binding.selection_revision === expected.selection_revision
    && catalog.binding.selection_revision === expected.selection_revision, 'binding');
  check(typeof catalog.binding.selection_sha256 === 'string' && /^[a-f0-9]{64}$/.test(catalog.binding.selection_sha256), 'binding');
  check(recommendation.selection.included_recorded_group_ids.length === 0, 'full_discovery_baseline_required');
  const groups = new Map(catalog.pockets.map(group => [group.id, group.member_count]));
  if (catalog.unassigned.member_count) groups.set(UNASSIGNED, catalog.unassigned.member_count);
  check(Array.isArray(recommendation.pockets) && recommendation.pockets.length <= L.pockets
    && recommendation.pockets.length === groups.size, 'groups');
  const seen = new Set(), ranks = new Set();
  const pockets = recommendation.pockets.map(pocket => {
    check(groups.has(pocket.id) && !seen.has(pocket.id), 'groups'); seen.add(pocket.id);
    const result = aggregate(pocket.result);
    check(result.member_count === groups.get(pocket.id), 'denominator');
    check(Number.isSafeInteger(pocket.review_rank) && pocket.review_rank >= 1
      && pocket.review_rank <= groups.size && !ranks.has(pocket.review_rank), 'rank'); ranks.add(pocket.review_rank);
    return { id: pocket.id, ...result, review_rank: pocket.review_rank,
      suggested_for_review: flag(pocket.suggested_for_review), subject_group_review: flag(pocket.subject_group_review),
      contains_subject: flag(pocket.contains_subject), meets_review_policy: flag(pocket.meets_review_policy) };
  });
  const ids = recommendation.recommended_recorded_group_ids;
  check(Array.isArray(ids) && json(ids) === json(pockets.filter(pocket => pocket.suggested_for_review).map(pocket => pocket.id))
    && !ids.includes(UNASSIGNED), 'suggestions');
  const all = aggregate(recommendation.all);
  check(all.member_count === catalog.coverage.stock_member_count
    && pockets.reduce((sum, pocket) => sum + pocket.member_count, 0) === all.member_count, 'denominator');
  const subjectIds = recommendation.subject.recorded_group_review_ids;
  check(Array.isArray(subjectIds) && subjectIds.length <= 1 && subjectIds.every(id => groups.has(id)), 'subject');
  check(Array.isArray(recommendation.limitations) && recommendation.limitations.length <= 64, 'limitations');
  const result = { presentation_version: 1, recommendation_version: 1, status: recommendation.status,
    basis: 'current_retained_observations', selection_scope: 'all_retained_discovery_accounts_independent_of_included_groups',
    authority: 'not_established', binding: JSON.parse(json(catalog.binding)),
    policy: Object.fromEntries(['id', 'revision', 'curve_methodology_version', 'weights', 'minimum_mean_lower_bound',
      'minimum_mean_known_weight_percent', 'denominator', 'calibration'].map(key => [key, structuredClone(POLICY[key])])),
    subject: { in_discovery: flag(recommendation.subject.in_discovery), recorded_group_review_ids: [...subjectIds] },
    all, pockets, recommended_recorded_group_ids: [...ids],
    unavailable_factors: Object.fromEntries(['housing_type', 'proximity', 'sale_price'].map(key => [key, text(recommendation.unavailable_factors[key])])),
    limitations: recommendation.limitations.map(text),
    apply: { status: 'blocked', reasons: ['current_observation_recommendation_is_not_a_supported_assessment'] } };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_byte_limit');
  return freeze(result);
}

/** Optional catalog composition. Public byte limits may collapse an internally
 * complete named catalog into a usable whole unresolved roster. Never rebuild
 * named suggestions that contradict that public result. Authorization of both
 * existing exposures still happens before/after this helper in the owner.
 */
export function buildCustomCohortPocketRecommendationPresentation({ catalog, expected, retained_inputs } = {}) {
  check(catalog?.catalog_version === 1 && typeof catalog.catalog_complete === 'boolean'
    && catalog.authority === 'not_established' && catalog.apply?.status === 'blocked', 'catalog');
  if (!catalog.catalog_complete) return null;
  return presentCustomCohortPocketRecommendation({ catalog, expected,
    recommendation: buildCustomCohortPocketRecommendation({ context_ref: expected.context_ref, retained_inputs,
      selection: { revision: expected.selection_revision, included_recorded_group_ids: [] } }),
  });
}
