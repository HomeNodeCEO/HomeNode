import type { CheckedPocketCatalog } from './customCohortPocketCatalog';

const FACTORS = ['gla', 'age', 'housing_type', 'site_size', 'proximity', 'sale_price'] as const;
type Factor = typeof FACTORS[number];
interface Similarity { readonly lower: number | null; readonly upper: number | null; readonly known_weight_percent: number | null }
interface Population {
  readonly member_count: number; readonly similarity: Similarity;
  readonly member_lower_bound_range: { readonly low: number; readonly high: number } | null;
  readonly factor_coverage: Readonly<Record<Factor, { readonly observed_count: number; readonly unknown_count: number;
    readonly states: Readonly<Record<string, number>> }>>;
}
export interface CheckedPocketRecommendation {
  readonly status: 'recommendation_for_review' | 'insufficient_observations';
  readonly policy: { readonly id: string; readonly revision: 1; readonly minimum_mean_lower_bound: number;
    readonly minimum_mean_known_weight_percent: number };
  readonly subject: { readonly in_discovery: boolean; readonly recorded_group_review_ids: readonly string[] };
  readonly pockets: readonly (Population & { readonly id: string; readonly review_rank: number;
    readonly suggested_for_review: boolean; readonly subject_group_review: boolean;
    readonly contains_subject: boolean; readonly meets_review_policy: boolean })[];
  readonly all: Population;
  readonly recommended_recorded_group_ids: readonly string[];
  readonly limitations: readonly string[];
}
type Catalog = Pick<CheckedPocketCatalog, 'status' | 'binding' | 'pockets' | 'unassigned' | 'coverage' | 'subject_membership'>;
const WEIGHTS = { gla: .4, age: .3, housing_type: .2, site_size: 1 / 30, proximity: 1 / 30, sale_price: 1 / 30 };
const STATES = new Set(['observed', 'not_established', 'calculation_unavailable',
  'subject_missing', 'subject_invalid', 'subject_conflicting', 'subject_json_null', 'subject_ambiguous_rows',
  'candidate_missing', 'candidate_invalid', 'candidate_conflicting']);
const ensure: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('Invalid pocket recommendation'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const own = Reflect.ownKeys(value);
  ensure(own.length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    ensure(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 200): string {
  ensure(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value);
  ensure(!Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)); return value;
}
function array(value: unknown, maximum: number): unknown[] {
  ensure(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    ensure(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
  }
  return value;
}
function count(value: unknown): number { ensure(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 50_000); return Number(value); }
function score(value: unknown): number { ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100); return value; }
function flag(value: unknown): boolean { ensure(typeof value === 'boolean'); return value; }
function ids(value: unknown): string[] {
  const result = array(value, 129).map(id => text(id, 100)); ensure(new Set(result).size === result.length); return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function population(value: Record<string, unknown>): Population {
  const member_count = count(value.member_count), raw = object(value.similarity, ['lower', 'upper', 'known_weight_percent']);
  const similarity = member_count ? { lower: score(raw.lower), upper: score(raw.upper), known_weight_percent: score(raw.known_weight_percent) }
    : { lower: null, upper: null, known_weight_percent: null };
  if (!member_count) ensure(Object.values(raw).every(v => v === null));
  else ensure(similarity.lower! <= similarity.upper! && similarity.lower! <= similarity.known_weight_percent! + .0002
    && Math.abs(similarity.upper! - similarity.lower! - 100 + similarity.known_weight_percent!) <= .0003);
  let range: Population['member_lower_bound_range'] = null;
  if (member_count) {
    const r = object(value.member_lower_bound_range, ['low', 'high']); range = { low: score(r.low), high: score(r.high) };
    ensure(range.low <= range.high && range.low <= similarity.lower! + .0002 && range.high >= similarity.lower! - .0002);
  } else ensure(value.member_lower_bound_range === null);
  const coverage = object(value.factor_coverage, FACTORS), pairs = FACTORS.map(key => {
    const c = object(coverage[key], ['observed_count', 'unknown_count', 'states']);
    const observed_count = count(c.observed_count), unknown_count = count(c.unknown_count);
    ensure(observed_count + unknown_count === member_count);
    ensure(c.states !== null && typeof c.states === 'object');
    const stateKeys = Object.keys(c.states); ensure(stateKeys.length <= STATES.size && stateKeys.every(state => STATES.has(state)));
    const states = Object.fromEntries(Object.entries(object(c.states, stateKeys)).map(([state, n]) => [state, count(n)]));
    ensure(Object.values(states).reduce((sum, n) => sum + n, 0) === member_count && (states.observed ?? 0) === observed_count);
    return [key, { observed_count, unknown_count, states }] as const;
  });
  if (member_count) ensure(Math.abs(pairs.reduce((sum, [key, c]) => sum + WEIGHTS[key] * c.observed_count / member_count * 100, 0)
    - similarity.known_weight_percent!) <= .0003);
  return { member_count, similarity, member_lower_bound_range: range,
    factor_coverage: Object.fromEntries(pairs) as unknown as Population['factor_coverage'] };
}

/** Static ALL-discovery recommendation only. Bind it to the same checked
 * catalog, never to the current selected-union statistics. This admits just
 * public display fields, not retained source rows/material or report authority. */
export function checkCustomCohortPocketRecommendation(value: unknown, catalog: Catalog, selectionFingerprint: unknown): CheckedPocketRecommendation {
  const r = object(value, ['presentation_version', 'recommendation_version', 'status', 'basis', 'selection_scope', 'authority',
    'binding', 'policy', 'subject', 'pockets', 'all', 'recommended_recorded_group_ids', 'unavailable_factors', 'limitations', 'apply']);
  ensure(r.presentation_version === 1 && r.recommendation_version === 1
    && (r.status === 'recommendation_for_review' || r.status === 'insufficient_observations')
    && r.basis === 'current_retained_observations' && r.authority === 'not_established'
    && r.selection_scope === 'all_retained_discovery_accounts_independent_of_included_groups');
  const binding = object(r.binding, ['context_ref', 'selection_revision', 'selection_sha256']);
  const ref = object(binding.context_ref, ['context_id', 'context_revision', 'context_sha256']);
  ensure(Object.entries(catalog.binding.context_ref).every(([key, expected]) => ref[key] === expected)
    && binding.selection_revision === catalog.binding.selection_revision
    && typeof selectionFingerprint === 'string' && /^[a-f0-9]{64}$/.test(selectionFingerprint)
    && binding.selection_sha256 === selectionFingerprint);
  const p = object(r.policy, ['id', 'revision', 'curve_methodology_version', 'weights', 'minimum_mean_lower_bound',
    'minimum_mean_known_weight_percent', 'denominator', 'calibration']);
  ensure(p.id === 'custom-current-observation-review-v1' && p.revision === 1 && p.curve_methodology_version === 6
    && p.minimum_mean_lower_bound === 55 && p.minimum_mean_known_weight_percent === 70
    && p.denominator === 'every_unique_account_in_group_including_unknowns'
    && p.calibration === 'initial_review_heuristic_not_empirical_reliability');
  const weights = object(p.weights, FACTORS); ensure(FACTORS.every(key => weights[key] === WEIGHTS[key]));
  const known = new Map(catalog.pockets.map(group => [group.id, { count: group.member_count, subject: group.account_ids.includes(catalog.subject_membership.account_id) }]));
  if (catalog.unassigned.member_count) known.set('discovery:unassigned', { count: catalog.unassigned.member_count,
    subject: catalog.unassigned.account_ids.includes(catalog.subject_membership.account_id) });
  const subject = object(r.subject, ['in_discovery', 'recorded_group_review_ids']), in_discovery = flag(subject.in_discovery);
  ensure(in_discovery === [...known.values()].some(group => group.subject));
  const subjectIds = ids(subject.recorded_group_review_ids), assigned = catalog.subject_membership.assigned_pocket_id;
  ensure(subjectIds.length === (assigned ? 1 : 0) && (!assigned || subjectIds[0] === assigned));
  const seen = new Set<string>(), pockets = array(r.pockets, 129).map((raw, index) => {
    const group = object(raw, ['id', 'member_count', 'review_rank', 'similarity', 'factor_coverage', 'member_lower_bound_range',
      'suggested_for_review', 'subject_group_review', 'contains_subject', 'meets_review_policy']);
    const id = text(group.id, 100), expected = known.get(id); ensure(expected && !seen.has(id)); seen.add(id);
    const stats = population(group); ensure(stats.member_count === expected.count && group.review_rank === index + 1);
    const contains_subject = flag(group.contains_subject), subject_group_review = flag(group.subject_group_review);
    ensure(contains_subject === expected.subject && subject_group_review === (assigned === id));
    const meets_review_policy = flag(group.meets_review_policy);
    ensure(meets_review_policy === (stats.member_count > 0 && stats.similarity.lower! >= 55 && stats.similarity.known_weight_percent! >= 70));
    const suggested_for_review = flag(group.suggested_for_review);
    ensure(suggested_for_review === (catalog.status === 'review_only' && in_discovery && id !== 'discovery:unassigned' && meets_review_policy));
    return { ...stats, id, review_rank: index + 1, contains_subject, subject_group_review, meets_review_policy, suggested_for_review };
  });
  ensure(seen.size === known.size);
  const recommended = ids(r.recommended_recorded_group_ids), suggested = pockets.filter(group => group.suggested_for_review).map(group => group.id);
  ensure(recommended.length === suggested.length && recommended.every((id, index) => id === suggested[index]));
  const all = population(object(r.all, ['member_count', 'similarity', 'factor_coverage', 'member_lower_bound_range']));
  ensure(all.member_count === catalog.coverage.discovery_member_count);
  const unavailable = object(r.unavailable_factors, ['housing_type', 'proximity', 'sale_price']);
  Object.values(unavailable).forEach(value => text(value));
  const apply = object(r.apply, ['status', 'reasons']); ensure(apply.status === 'blocked');
  array(apply.reasons, 64).forEach(value => text(value));
  const limitations = array(r.limitations, 64).map(value => text(value));
  // The closed, bounded structure has now been checked before serialization.
  ensure(new TextEncoder().encode(JSON.stringify(value)).length <= 512_000);
  return freeze({ status: r.status, policy: { id: p.id, revision: 1, minimum_mean_lower_bound: 55, minimum_mean_known_weight_percent: 70 },
    subject: { in_discovery, recorded_group_review_ids: subjectIds }, pockets, all, recommended_recorded_group_ids: recommended, limitations });
}
