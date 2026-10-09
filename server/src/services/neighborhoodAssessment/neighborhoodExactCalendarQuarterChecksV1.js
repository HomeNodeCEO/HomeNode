import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { isIssuedExactDecimalPagedDistributionV1, getExactDecimalPagedDistributionV1Profile,
  parseExactDecimalPagedObservationV1, EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS }
  from './exactDecimalPagedDistributionV1.js';

export const EXACT_CALENDAR_QUARTER_CHECK_V1_POLICY = Object.freeze({
  minimum_observed_rows: 50, median_area_tolerance_percent: 5, maximum_quarters: 100,
  maximum_member_rows: EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS.member_count,
});
const P = EXACT_CALENDAR_QUARTER_CHECK_V1_POLICY;
/** Refuse the entire check set, not an accepted subset of calendar quarters. */
function fail(reason) { throw new TypeError(`exact_calendar_quarter_checks_${reason}`); }
/** Snapshot closed DATA without executing getters, proxies or inherited aliases. */
function data(value, required, optional = []) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('shape');
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(key => !Object.hasOwn(ds, key)) || keys.some(key => ![...required, ...optional].includes(key)
    || !ds[key].enumerable || !Object.hasOwn(ds[key], 'value'))) fail('shape');
  return Object.fromEntries(keys.map(key => [key, ds[key].value]));
}
/** Freeze newly owned profile and check output; never recursively freeze request objects. */
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Calendar ordinal arithmetic uses only bounded date integers, not economic values. */
function quarterOrdinal(date) { return Number(date.slice(0, 4)) * 4 + Math.floor((Number(date.slice(5, 7)) - 1) / 3); }
/** Preserve the exact clipped inclusive interval, including partial first/last quarters. */
function quarterInterval(ordinal, period) {
  const year = Math.floor(ordinal / 4), q = ordinal % 4, text = String(year).padStart(4, '0');
  const start = `${text}-${String(q * 3 + 1).padStart(2, '0')}-01`;
  const end = `${text}-${String(q * 3 + 3).padStart(2, '0')}-${[31, 30, 30, 31][q]}`;
  return { quarter: `${text}-Q${q + 1}`, start_date: start < period.start_date ? period.start_date : start,
    end_date: end > period.end_date ? period.end_date : end };
}
/** A fixed kernel receipt carries an exact finite median with at most 14 places. */
function medianScaled(value) {
  if (typeof value !== 'string' || value.length > 34 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)) fail('median');
  const [whole, fraction = ''] = value.split('.');
  if (whole.length + fraction.length > 32 || fraction.length > 14) fail('median');
  return BigInt(whole) * 10n ** 14n + BigInt(fraction.padEnd(14, '0'));
}
/** Reduced exact deviation percent, with no arbitrary display rounding. */
function ratio(numerator, denominator) {
  let a = numerator, b = denominator;
  while (b) { const r = a % b; a = b; b = r; }
  return { numerator: (numerator / a).toString(), denominator: (denominator / a).toString() };
}
const DEFINITION = freeze({ id: 'neighborhood-exact-calendar-quarter-checks-v1', revision: '1',
  distribution_profile: getExactDecimalPagedDistributionV1Profile().profile_ref, policy: P,
  period: 'retained_inclusive_start_lte_end_lte_effective_date_every_intersecting_calendar_quarter_including_empty',
  median: 'whole_owner_supplied_quarter_exact_decimal_type7_median_not_average_of_pages_or_groups',
  area_basis: 'current_CAD_reported_residential_area_reported_sqft_NOT_verified_at_sale_GLA',
  tolerance: 'exact_abs_median_minus_subject_times_100_lte_subject_times_5_no_float_epsilon',
  target: '50_observed_rows_across_complete_quarters_empty_or_unobserved_quarter_cannot_pass',
  receipt: 'in_process_mathematical_distribution_identity_not_source_or_membership_authority',
  authority: 'not_established',
  limitations: ['actual_owner_must_establish_complete_selected_union_and_nonduplicated_resolved_transaction_partition',
    'actual_owner_must_establish_same_homogeneous_area_basis_and_current_rights_for_subject_and_every_row',
    'no_verified_sale_eligibility_completion_consideration_currency_or_at_sale_GLA',
    'no_acquisition_capacity_increase_server_selection_publication_or_report_update', 'legacy_review_semantics_unchanged'] });
const definitionText = json(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: '1', content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionText } });
/** Immutable numerical review policy only; never an interpretation or source grant. */
export function getExactCalendarQuarterCheckV1Profile() { return PROFILE; }

/** Dormant mathematical checker. The supplying current-authorized owner MUST
 * prove the complete selected union, exact retained dates, nonduplicated eligible
 * transaction-to-quarter partition and one homogeneous current CAD area basis.
 * It supplies one ACTUAL in-process numerical distribution per exact quarter,
 * after original reconciliation. An arbitrary DATA producer can also calculate
 * such a receipt: local identity is NOT selected-union or source authority.
 * Missing subject/empty quarters never silently pass. No legacy heuristic,
 * route/default, report, choice, worker, pin or database state is changed. */
export function checkExactCalendarQuarterAreasV1(rawInput, rawOptions = {}) {
  const a = data(rawInput, ['effective_date', 'observation_period', 'subject_area', 'quarter_distributions']);
  const o = data(rawOptions, [], ['signal', 'checkBudget']), budget = o.checkBudget === undefined ? () => {} : o.checkBudget;
  if (typeof budget !== 'function' || o.signal !== undefined && (isProxy(o.signal) || !(o.signal instanceof AbortSignal))) fail('options');
  /** Check the enclosing owner budget and cancellation before/after each bounded row. */
  function check() { if (o.signal?.aborted) fail('cancelled'); budget(); if (o.signal?.aborted) fail('cancelled'); }
  const effective = assessmentDate(a.effective_date), rawPeriod = data(a.observation_period, ['start_date', 'end_date']);
  const period = { start_date: assessmentDate(rawPeriod.start_date), end_date: assessmentDate(rawPeriod.end_date) };
  if (period.start_date > period.end_date || period.end_date > effective) fail('period');
  const start = quarterOrdinal(period.start_date), end = quarterOrdinal(period.end_date), size = end - start + 1;
  if (size > P.maximum_quarters) fail('quarter_limit');
  const subject = data(a.subject_area, ['state', 'exact_value', 'unit']);
  if (!['observed', 'missing', 'invalid', 'conflicting', 'unsupported'].includes(subject.state)) fail('subject');
  let subjectValue = null;
  if (subject.state === 'observed') {
    if (subject.unit !== 'reported_sqft') fail('subject_unit'); subjectValue = parseExactDecimalPagedObservationV1(subject.exact_value) * 100n;
    if (subjectValue === 0n) fail('subject_not_positive');
  } else if (subject.exact_value !== null || subject.unit !== null) fail('subject');
  const supplied = a.quarter_distributions;
  if (isProxy(supplied) || !Array.isArray(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype) fail('quarters');
  const ds = Object.getOwnPropertyDescriptors(supplied);
  if (ds.length?.value !== size || Reflect.ownKeys(ds).length !== size + 1) fail('quarters');
  // Detach every input entry before invoking any owner budget callback.
  const entries = Array.from({ length: size }, (_, i) => {
    if (!ds[i]?.enumerable || !Object.hasOwn(ds[i], 'value')) fail('quarters');
    return data(ds[i].value, ['quarter', 'distribution']);
  });
  let members = 0, observed = 0; const rows = [];
  for (let i = 0; i < entries.length; i++) {
    check(); const interval = quarterInterval(start + i, period), entry = entries[i], d = entry.distribution;
    if (entry.quarter !== interval.quarter || !isIssuedExactDecimalPagedDistributionV1(d)) fail('quarter_receipt');
    members += d.counts.member_count; observed += d.counts.observed_count;
    if (members > P.maximum_member_rows) fail('member_limit');
    const median = d.median === null ? null : medianScaled(d.median);
    const deviation = median === null || subjectValue === null ? null : median > subjectValue ? median - subjectValue : subjectValue - median;
    const within = deviation === null ? null : deviation * 100n <= subjectValue * BigInt(P.median_area_tolerance_percent);
    rows.push({ ...interval, counts: d.counts, median_current_cad_reported_residential_area: d.median,
      exact_observation_sha256: d.exact_observation_sha256,
      deviation_percent: deviation === null ? null : ratio(deviation * 100n, subjectValue),
      within_tolerance: within, state: subjectValue === null ? 'subject_unavailable' : median === null ? 'no_observed_area'
        : within ? 'within_tolerance' : 'outside_tolerance' });
    check();
  }
  const countTarget = observed >= P.minimum_observed_rows, everyQuarter = rows.every(row => row.within_tolerance === true);
  check(); return freeze({ check_version: 1, interpretation_profile_ref: PROFILE.profile_ref,
    authority: 'not_established', population_verification: 'not_established', transaction_eligibility: 'not_established',
    retained_effective_date: effective, retained_observation_period: period, policy: P,
    area_basis: DEFINITION.area_basis, subject_area: subject, member_row_count: members, observed_row_count: observed,
    meets_observed_row_target: countTarget, every_calendar_quarter_within_tolerance: subjectValue === null ? null : everyQuarter,
    state: subjectValue === null ? 'subject_unavailable' : !countTarget ? 'insufficient_observed_rows'
      : !everyQuarter ? 'quarterly_area_mismatch_or_unavailable' : 'meets_numerical_review_targets',
    quarters: rows, report_update: 'none' });
}
