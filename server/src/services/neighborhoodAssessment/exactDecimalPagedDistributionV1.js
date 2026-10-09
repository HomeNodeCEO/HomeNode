import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { EXACT_PAGED_DISTRIBUTION_LIMITS } from './exactPagedDistribution.js';

const SCALE = 10n ** 12n;
const issuedResults = new WeakSet();
const STATES = ['observed', 'missing', 'invalid', 'conflicting', 'unsupported'];
export const EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS = Object.freeze({
  page_values: EXACT_PAGED_DISTRIBUTION_LIMITS.page_values,
  member_count: EXACT_PAGED_DISTRIBUTION_LIMITS.observation_values,
  canonical_digits: 30, fractional_digits: 12, token_bytes: 32,
});
const L = EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS;
/** Refuse the whole numerical result; no prefix or partial summary is delivered. */
function fail(reason) { throw new TypeError(`exact_decimal_paged_distribution_${reason}`); }
/** Snapshot closed DATA options without executing getters or proxy traps. */
function data(value, required, optional = []) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(k => !Object.hasOwn(ds, k)) || keys.some(k => ![...required, ...optional].includes(k)
    || !ds[k].enumerable || !Object.hasOwn(ds[k], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
/** Freeze newly owned output and fixed profile DATA. */
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Parse only canonical nonnegative decimal observations, never JS Number values. */
function scaled(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > L.token_bytes
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)) fail('invalid_observation');
  const [whole, fraction = ''] = value.split('.');
  if (whole.length + fraction.length > L.canonical_digits || fraction.length > L.fractional_digits) fail('invalid_observation');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
/** Shared fixed-profile syntax/ordering parser for dormant derived decimal runs.
 * This validates representation only, never a metric, unit or source receipt. */
export function parseExactDecimalPagedObservationV1(value) { return scaled(value); }
/** Encode an exact finite decimal with no rounding or exponent notation. */
function decimal(value, digits) {
  const text = value.toString().padStart(digits + 1, '0'), fraction = text.slice(-digits).replace(/0+$/, '');
  return text.slice(0, -digits) + (fraction ? `.${fraction}` : '');
}
/** Reduce a nonnegative exact rational instead of inventing a display rounding rule. */
function ratio(numerator, denominator) {
  if (denominator === 0n) return null;
  let a = numerator, b = denominator;
  while (b) { const r = a % b; a = b; b = r; }
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
}
/** Detach one bounded dense decimal page before any callback or cooperative yield. */
function pageOf(value, length) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('invalid_page');
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (ds.length?.value !== length || keys.length !== length + 1) fail('invalid_page');
  return Array.from({ length }, (_, i) => {
    if (!ds[i]?.enumerable || !Object.hasOwn(ds[i], 'value')) fail('invalid_page');
    const text = ds[i].value; return { text, value: scaled(text) };
  });
}
const DEFINITION = freeze({ id: 'neighborhood-exact-decimal-paged-distribution-v1', revision: '1', limits: L,
  input: 'canonical_nonnegative_decimal_strings_with_owner_derived_exhaustive_five_state_counts',
  quantiles: 'whole_observed_population_Hyndman_Fan_type7_q1_median_q3_exact_no_page_median_average',
  mean_and_dispersion: 'reduced_exact_nonnegative_rationals_no_display_rounding',
  cod_percent: '100_times_sum_absolute_deviation_from_exact_median_divided_by_count_times_median',
  zero_median: 'COD_null_not_zero_or_infinite', missing: 'all_five_states_remain_in_member_denominator',
  traversal: 'two_complete_fresh_global_sorted_passes_same_exact_ordered_decimal_digest_including_empty',
  memory: 'one_detached_bounded_page_and_at_most_six_quantile_observations_not_full_population',
  authority: 'not_established', unit: 'owner_must_establish_one_homogeneous_metric_unit_before_call',
  limitations: ['not_source_or_population_membership_verification', 'not_selected_union_or_traversal_receipt',
    'not_sale_eligibility_currency_measurement_or_historical_support', 'not_COD_reliability_or_predominant_value',
    'not_a_sorted_run_producer_SQL_owner_publication_or_capture_capacity_increase', 'legacy_Number_kernel_unchanged'] });
const definitionText = canonicalAssessmentJson(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionText } });
/** Immutable numerical definition only, never a membership or source grant. */
export function getExactDecimalPagedDistributionV1Profile() { return PROFILE; }
/** Local mathematical result identity only, NOT source, membership, unit or
 * current authorization. Serialized/copied JSON is not this calculation receipt. */
export function isIssuedExactDecimalPagedDistributionV1(value) { return issuedResults.has(value); }

/** Bounded exact-decimal numerical primitive. The actual owner must verify the
 * entire selected union, every original, all five counts and one homogeneous
 * metric/unit, and supply fresh globally sorted iterators in its own budget.
 * The stream digest detects pass changes, not authenticity or complete source
 * acquisition. Current rights, retained dates, SQL/sort runs, lifecycle and
 * coherent publication remain outside this dormant helper. Legacy reports and
 * Number statistics are unchanged. No economic value is converted to Number. */
export async function exactDecimalDistributionFromSortedPagesV1(rawOptions) {
  const o = data(rawOptions, ['pages', 'counts'], ['minimum_count', 'signal', 'checkBudget']);
  const counts = data(o.counts, ['member_count', ...STATES.map(s => `${s}_count`)]);
  const minimum = o.minimum_count === undefined ? 1 : o.minimum_count;
  const budget = o.checkBudget === undefined ? () => {} : o.checkBudget;
  if (typeof o.pages !== 'function' || typeof budget !== 'function'
    || o.signal !== undefined && (isProxy(o.signal) || !(o.signal instanceof AbortSignal))) fail('invalid_options');
  if (Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0 || n > L.member_count)
    || STATES.reduce((n, s) => n + counts[`${s}_count`], 0) !== counts.member_count) fail('invalid_counts');
  if (!Number.isSafeInteger(minimum) || minimum < 1) fail('invalid_minimum');
  const count = counts.observed_count;
  /** Apply cancellation and the enclosing owner's aggregate budget at every suspension boundary. */
  function check() { if (o.signal?.aborted) fail('cancelled'); budget(); if (o.signal?.aborted) fail('cancelled'); }
  check();
  const positions = [1, 2, 3].map(k => ({ lower: Math.floor((count - 1) * k / 4), remainder: ((count - 1) * k) % 4 }));
  const sought = new Set(count ? positions.flatMap(p => [p.lower, p.lower + (p.remainder ? 1 : 0)]) : []);
  const quantiles = new Map();
  let low = null, high = null, sum = 0n, deviationsQuarterScale = 0n;
  /** Exhaust one fresh owner iterator; refuse extra, missing, changed or unordered observations. */
  async function pass(onValue) {
    check(); const stream = await o.pages();
    if (isProxy(stream) || !stream || !['object', 'function'].includes(typeof stream)) fail('invalid_iterator');
    const asyncMethod = stream[Symbol.asyncIterator];
    if (asyncMethod != null && typeof asyncMethod !== 'function') fail('invalid_iterator');
    const asynchronous = typeof asyncMethod === 'function', method = asynchronous ? asyncMethod : stream[Symbol.iterator];
    if (typeof method !== 'function') fail('invalid_iterator');
    const iterator = method.call(stream);
    if (!iterator || isProxy(iterator)) fail('invalid_iterator');
    const next = iterator.next, close = iterator.return;
    if (typeof next !== 'function' || close != null && typeof close !== 'function') fail('invalid_iterator');
    const hash = createHash('sha256').update('[', 'utf8');
    let observed = 0, previous = null, exhausted = false;
    try {
      // Capture cleanup before checking a factory that settled with cancellation.
      check();
      while (true) {
        check(); const pending = next.call(iterator), receipt = asynchronous ? await pending : pending; check();
        const r = data(receipt, ['done'], ['value']);
        if (typeof r.done !== 'boolean') fail('invalid_receipt');
        if (r.done) { exhausted = true; break; }
        if (!Object.hasOwn(r, 'value')) fail('invalid_receipt');
        if (observed >= count) fail('extra_page');
        const page = pageOf(r.value, Math.min(L.page_values, count - observed));
        hash.update(`${observed ? ',' : ''}${page.map(v => v.text).join(',')}`, 'utf8');
        for (const entry of page) {
          if (previous !== null && entry.value < previous) fail('invalid_order');
          onValue(entry.value, observed); previous = entry.value; observed++;
          if (observed % 125 === 0) { check(); await yieldToRequests(); check(); }
        }
        check();
      }
    } finally {
      if (!exhausted && typeof close === 'function') { const closing = close.call(iterator); if (asynchronous) await closing; }
    }
    check(); if (observed !== count) fail('missing_observations');
    return hash.update(']', 'utf8').digest('hex');
  }
  const first = await pass((value, index) => {
    if (index === 0) low = value; high = value; sum += value;
    if (sought.has(index)) quantiles.set(index, value);
  });
  /** Exact Type-7 numerator in quarter-scale units; integer positions need no interpolation. */
  const at = p => !count ? null : quantiles.get(p.lower) * BigInt(4 - p.remainder)
    + (p.remainder ? quantiles.get(p.lower + 1) * BigInt(p.remainder) : 0n);
  const q = positions.map(at), median = q[1];
  const second = await pass(value => { const d = value * 4n - median; deviationsQuarterScale += d < 0n ? -d : d; });
  if (first !== second) fail('observations_changed'); check();
  /** Convert quarter-scale quantiles to exact finite decimals with at most 14 places. */
  const quarterDecimal = value => value === null ? null : decimal(value * 25n, 14);
  const result = freeze({ distribution_version: 1, interpretation_profile_ref: PROFILE.profile_ref,
    authority: 'not_established', population_verification: 'not_established',
    state: count >= minimum ? 'ready' : 'insufficient',
    reason: count === 0 ? 'no_observations' : count < minimum ? 'below_minimum_count' : null,
    estimator: 'exact_decimal_member_type_7_quantiles', counts, minimum_count: minimum,
    coverage_percent: counts.member_count ? ratio(BigInt(count) * 100n, BigInt(counts.member_count)) : null,
    low: low === null ? null : decimal(low, 12), q1: quarterDecimal(q[0]), median: quarterDecimal(median),
    q3: quarterDecimal(q[2]), high: high === null ? null : decimal(high, 12),
    mean: count ? ratio(sum, BigInt(count) * SCALE) : null,
    mean_absolute_deviation: count ? ratio(deviationsQuarterScale, BigInt(count) * 4n * SCALE) : null,
    cod_percent: count && median !== 0n ? ratio(deviationsQuarterScale * 100n, BigInt(count) * median) : null,
    exact_observation_sha256: first, report_update: 'none' });
  issuedResults.add(result); return result;
}
