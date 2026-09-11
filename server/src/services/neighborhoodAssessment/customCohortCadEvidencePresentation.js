import { canonicalAssessmentJson as json } from './contract.js';
import { customCohortCatalogGroupLimit } from './customCohortPocketCatalog.js';
import { CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS as LABELS,
  CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITS as LIMITS,
  CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITATIONS as LIMITATIONS } from './customCohortCurrentCadBaseline.js';

const FIELDS = Object.keys(LABELS), STATES = ['observed', 'partial', 'missing', 'conflicting'];
const COUNTS = [...STATES.map(state => `${state}_count`), 'record_count', 'observed_record_count', 'missing_record_count'];
const COMPARISONS = ['same_literal_count', 'different_literal_count', 'unavailable_count'];
const REASONS = ['distinct_literal_limit', 'distribution_byte_limit', 'baseline_output_byte_limit'];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_cad_evidence_presentation_${reason}`), {
    code: 'CUSTOM_COHORT_CAD_EVIDENCE_PRESENTATION_INVALID', reason,
  });
}
function object(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'object');
  const own = Reflect.ownKeys(value);
  check(own.length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'keys');
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'data_property');
  }
  return value;
}
function array(value, maximum) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1, 'array');
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'data_property');
  }
  return value;
}
function count(value, maximum = LIMITS.source_records) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'count'); return value;
}
function literal(value, field) {
  check(value === null || (field === 'built_up' ? typeof value === 'boolean' : typeof value === 'string'), 'literal_type');
  if (typeof value === 'string') check(value.length <= LIMITS.literal_utf8_bytes && value.isWellFormed()
    && !value.includes('\0') && Buffer.byteLength(value) <= LIMITS.literal_utf8_bytes, 'literal_text');
  return value;
}
const missing = value => value === null || (typeof value === 'string' && value.trim() === '');

function summary(value, memberCount, subject, id) {
  object(value, [...(id === undefined ? [] : ['id']), 'member_count', 'fields']);
  check(value.member_count === memberCount && (id === undefined || value.id === id), 'denominator');
  count(memberCount, LIMITS.accounts); object(value.fields, FIELDS);
  const fields = Object.fromEntries(FIELDS.map(field => {
    const source = object(value.fields[field], ['label', ...COUNTS, 'distribution', 'subject_comparison']);
    check(source.label === LABELS[field], 'label');
    const counts = Object.fromEntries(COUNTS.map(key => [key, count(source[key])]));
    check(STATES.reduce((sum, state) => sum + counts[`${state}_count`], 0) === memberCount
      && counts.observed_record_count + counts.missing_record_count === counts.record_count
      && counts.observed_record_count >= counts.observed_count + counts.partial_count + 2 * counts.conflicting_count
      && counts.missing_record_count >= counts.partial_count, 'denominator');
    const comparison = object(source.subject_comparison, COMPARISONS);
    const subject_comparison = Object.fromEntries(COMPARISONS.map(key => [key, count(comparison[key], memberCount)]));
    check(COMPARISONS.reduce((sum, key) => sum + subject_comparison[key], 0) === memberCount
      && subject_comparison.same_literal_count + subject_comparison.different_literal_count <= counts.observed_count,
    'comparison_denominator');
    if (!subject.in_discovery || subject.county_state !== 'observed' || subject.fields[field].state !== 'observed') {
      check(subject_comparison.unavailable_count === memberCount, 'comparison_support');
    }
    const raw = object(source.distribution, ['basis', 'status', 'reason', 'distinct_literal_count', 'entries']);
    check(raw.basis === 'accounts_with_literal_any_parcel_row_nonexclusive', 'distribution_basis');
    const distinct_literal_count = count(raw.distinct_literal_count, counts.record_count);
    let entries = null;
    if (raw.status === 'complete') {
      check(raw.reason === null, 'distribution_reason');
      entries = array(raw.entries, LIMITS.distribution_literals).map(entry => {
        object(entry, ['literal', 'account_count']);
        const value = literal(entry.literal, field), amount = count(entry.account_count, memberCount);
        check(amount > 0 && amount <= (missing(value)
          ? counts.missing_count + counts.partial_count + counts.conflicting_count
          : counts.observed_count + counts.partial_count + counts.conflicting_count), 'distribution_denominator');
        return { literal: value, account_count: amount };
      });
      const keys = entries.map(entry => JSON.stringify(entry.literal));
      check(new Set(keys).size === keys.length && entries.length === distinct_literal_count
        && bytes(entries) <= LIMITS.distribution_utf8_bytes
        && entries.reduce((sum, entry) => sum + entry.account_count, 0) <= counts.record_count,
      'distribution_denominator');
      check((counts.record_count === 0) === (entries.length === 0), 'distribution_denominator');
      const knownFrequencies = entries.filter(entry => !missing(entry.literal));
      const knownTotal = knownFrequencies.reduce((sum, entry) => sum + entry.account_count, 0);
      const missingTotal = entries.filter(entry => missing(entry.literal)).reduce((sum, entry) => sum + entry.account_count, 0);
      check(knownTotal >= counts.observed_count + counts.partial_count + 2 * counts.conflicting_count
        && knownTotal <= counts.observed_record_count && missingTotal >= counts.partial_count
        && missingTotal <= counts.missing_record_count, 'distribution_denominator');
      const sameTotal = knownFrequencies.find(entry => entry.literal === subject.fields[field].literal)?.account_count ?? 0;
      check(subject_comparison.same_literal_count <= sameTotal
        && subject_comparison.different_literal_count <= knownTotal - sameTotal, 'comparison_distribution');
    } else {
      check(raw.status === 'details_unavailable' && REASONS.includes(raw.reason) && raw.entries === null,
        'distribution_disposition');
      if (raw.reason === 'distinct_literal_limit') check(distinct_literal_count > LIMITS.distribution_literals, 'distribution_reason');
    }
    return [field, { label: LABELS[field], ...counts, distribution: { basis: raw.basis, status: raw.status,
      reason: raw.reason, distinct_literal_count, entries }, subject_comparison }];
  }));
  return { ...(id === undefined ? {} : { id }), member_count: memberCount, fields };
}

/** Optional explanatory CAD evidence, not a scoring input. Validate the entire
 * population before applying display budgets. A byte limit may hide all detail
 * lists, never a convenient prefix of properties or categories. The owning
 * recommendation keeps its complete original counts/ranks in every case.
 */
export function presentCustomCohortCadEvidence({ evidence, expected, pockets, member_count, in_discovery, maximumBytes, catalog_version = 1 } = {}) {
  const groupLimit = customCohortCatalogGroupLimit(catalog_version) + 1;
  object(evidence, ['cad_baseline_version', 'mapping_version', 'basis', 'authority', 'binding', 'comparison_basis',
    'temporal_basis', 'subject', 'all', 'pockets', 'limitations']);
  check(evidence.cad_baseline_version === 1 && evidence.mapping_version === 4
    && evidence.basis === 'retained_current_cad_observations' && evidence.authority === 'not_established'
    && evidence.comparison_basis === 'exact_literal_same_recorded_county_not_housing_similarity'
    && evidence.temporal_basis === 'observation_availability_not_historical_validity', 'profile');
  object(evidence.binding, ['context_ref', 'captured_at']);
  check(json(evidence.binding.context_ref) === json(expected.context_ref)
    && evidence.binding.captured_at === expected.captured_at
    && typeof evidence.binding.captured_at === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(evidence.binding.captured_at)
    && Number.isFinite(Date.parse(evidence.binding.captured_at)), 'binding');
  const rawSubject = object(evidence.subject, ['in_discovery', 'county_state', 'fields']);
  check(typeof rawSubject.in_discovery === 'boolean' && rawSubject.in_discovery === in_discovery
    && STATES.includes(rawSubject.county_state), 'subject');
  object(rawSubject.fields, FIELDS);
  const subject = { in_discovery, county_state: rawSubject.county_state,
    fields: Object.fromEntries(FIELDS.map(field => {
      const cell = object(rawSubject.fields[field], ['state', 'literal']);
      check(STATES.includes(cell.state), 'subject_state');
      const value = literal(cell.literal, field);
      check(['missing', 'conflicting'].includes(cell.state) ? value === null : !missing(value), 'subject_literal');
      check(in_discovery || (cell.state === 'missing' && value === null), 'subject');
      return [field, { state: cell.state, literal: value }];
    })) };
  check(in_discovery || subject.county_state === 'missing', 'subject');
  const all = summary(evidence.all, member_count, subject), byId = new Map(pockets.map(pocket => [pocket.id, pocket.member_count]));
  check(byId.size === pockets.length, 'groups');
  const seen = new Set(), summaries = array(evidence.pockets, groupLimit).map(pocket => {
    const descriptor = pocket && Object.getOwnPropertyDescriptor(pocket, 'id');
    check(descriptor && Object.hasOwn(descriptor, 'value') && byId.has(descriptor.value) && !seen.has(descriptor.value), 'groups');
    seen.add(descriptor.value); return summary(pocket, byId.get(descriptor.value), subject, descriptor.value);
  });
  check(seen.size === byId.size && summaries.reduce((sum, pocket) => sum + pocket.member_count, 0) === member_count, 'groups');
  for (const field of FIELDS) {
    const total = all.fields[field];
    for (const key of COUNTS) check(summaries.reduce((sum, pocket) => sum + pocket.fields[field][key], 0) === total[key], 'population_totals');
    for (const key of COMPARISONS) check(summaries.reduce((sum, pocket) => sum + pocket.fields[field].subject_comparison[key], 0)
      === total.subject_comparison[key], 'population_totals');
    if ([all, ...summaries].every(population => population.fields[field].distribution.status === 'complete')) {
      const sums = new Map();
      for (const pocket of summaries) for (const entry of pocket.fields[field].distribution.entries) {
        const key = JSON.stringify(entry.literal); sums.set(key, (sums.get(key) ?? 0) + entry.account_count);
      }
      check(sums.size === total.distribution.entries.length && total.distribution.entries.every(entry =>
        sums.get(JSON.stringify(entry.literal)) === entry.account_count), 'distribution_totals');
    }
  }
  check(json(array(evidence.limitations, LIMITATIONS.length)) === json(LIMITATIONS), 'limitations');
  const metadata = { cad_baseline_version: 1, mapping_version: 4, basis: evidence.basis, authority: evidence.authority,
    binding: { context_ref: JSON.parse(json(expected.context_ref)), captured_at: expected.captured_at },
    comparison_basis: evidence.comparison_basis, temporal_basis: evidence.temporal_basis };
  const result = { ...metadata, status: 'available', reason: null, subject, all, pockets: summaries, limitations: [...LIMITATIONS] };
  check(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= (catalog_version === 2 ? 2_500_000 : 512_000), 'byte_budget');
  if (bytes(result) > maximumBytes) for (const population of [all, ...summaries]) {
    for (const field of Object.values(population.fields)) if (field.distribution.status === 'complete') {
      Object.assign(field.distribution, { status: 'details_unavailable', reason: 'presentation_byte_limit', entries: null });
    }
  }
  if (bytes(result) <= maximumBytes) return result;
  const unavailable = { ...metadata, status: 'details_unavailable', reason: 'presentation_byte_limit', member_count, pocket_count: pockets.length };
  check(bytes(unavailable) <= maximumBytes, 'output_byte_limit');
  return unavailable;
}
