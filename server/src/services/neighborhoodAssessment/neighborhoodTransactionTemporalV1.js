import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { prepareNeighborhoodTypedTransactionV2 } from './neighborhoodFrozenTypedTransactionV2.js';

const fail = reason => { throw new TypeError(`neighborhood_transaction_temporal_${reason}`); };
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS = Object.freeze({ row_utf8_bytes: 8192, page_utf8_bytes: 2100000 });
const DEFINITION = freeze({
  id: 'neighborhood-retained-transaction-temporal-v1', revision: '1',
  shared_typed_profile: getNeighborhoodFrozenTypedOriginalV2Profile(),
  scope: 'one_original_closing_date_and_effective_year_projection_before_resolution_not_a_transaction',
  owner_dates: 'current_authorized_retained_subject_effective_date_and_exact_retained_study_period',
  period: { keys: ['start_date', 'end_date'], basis: 'closing_date_only', bounds: 'inclusive_start_lte_end_lte_effective_date',
    normalized: { source_records: 'close_date', sales: 'closing_date', sale_links: null },
    same_payload_reported: 'CloseDate_only', fallback: 'none_between_normalized_reported_or_rows',
    links: 'no_date_inheritance_until_complete_package_resolution',
    unavailable: 'preserve_missing_invalid_unsupported_no_capture_or_loaded_at_substitution' },
  year: { before: 'account_transaction_resolution_and_aggregation', maximum: 'retained_effective_date_year',
    future: 'invalid_null_value_and_unit_with_explicit_reason_original_neutral_evidence_retained' },
  reported_record: 'same_payload_status_then_close_date_disposition_syntax_only_not_verified_completion',
  source_less_sale: 'retain_exact_row_and_date_no_fabricated_reported_witness_or_source',
  originals: 'exact_native_kind_row_key_payload_hash_bytes_and_fixed_neutral_profile_retained_cache_unchanged',
  coverage: 'one_kind_page_not_complete_population_or_association_union', authority: 'not_established',
  limitations: ['no_provider_dictionary_or_source_rights', 'no_cross_source_transaction_equivalence_or_price_allocation',
    'no_verified_completion_consideration_historical_stock_or_at_sale_GLA', 'no_selection_statistics_publication_or_report_update'],
  limits: NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS,
});
const definitionText = canonicalAssessmentJson(DEFINITION), blob = prepareNeighborhoodCohortBlob(definitionText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: '1', content_sha256: blob.content_sha256 },
  definition_blob: { ref: blob, canonical_json: definitionText } });
export function getNeighborhoodTransactionTemporalV1Profile() { return PROFILE; }

export function prepareNeighborhoodTransactionRetainedPeriodV1(value, effectiveDate) {
  const effective = assessmentDate(effectiveDate);
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_period');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== 2 || !['start_date', 'end_date'].every(k => ds[k]?.enumerable && Object.hasOwn(ds[k], 'value')))
    fail('invalid_period');
  const start = assessmentDate(ds.start_date.value), end = assessmentDate(ds.end_date.value);
  if (start > end || end > effective) fail('future_or_reversed_period');
  return freeze({ start_date: start, end_date: end });
}
const compactCell = ({ state, exact_value, unit, reason }) => ({ state, exact_value, unit, reason });
const compactDate = ({ state, exact_value, reason }) => ({ state, exact_value, reason });
function yearCell(cell, effective) {
  if (cell.state === 'observed' && BigInt(cell.exact_value) > BigInt(effective.slice(0, 4)))
    return { state: 'invalid', exact_value: null, unit: null, reason: 'year_after_retained_effective_year' };
  return compactCell(cell);
}
function disposition(cell, period) {
  if (cell === null) return { state: 'unsupported', exact_date: null, reason: 'date_not_present_in_link_original' };
  if (cell.state !== 'observed') return { state: cell.state, exact_date: null, reason: cell.reason };
  const inside = cell.exact_value >= period.start_date && cell.exact_value <= period.end_date;
  return { state: inside ? 'in_period' : 'outside_period', exact_date: cell.exact_value,
    reason: inside ? null : 'outside_retained_observation_period' };
}
function reportedDisposition(record, date) {
  if (record.state === 'conflicting') return 'conflicting_record_type';
  if (record.state === 'unknown') return 'unknown_record_type';
  if (record.state === 'nonclosed') return 'nonclosed';
  return date.state === 'in_period' ? 'closed_in_period_syntax_only'
    : date.state === 'outside_period' ? 'outside_period' : `${date.state}_close_date`;
}

/** DATA projection only. The actual owner supplies retained dates and all
 * current authorization/issued-head/cache fences. No evidence is discarded,
 * inferred from another row, made a transaction, or written back to the cache. */
export function projectNeighborhoodTransactionTemporalV1(value, effectiveDate, observationPeriod) {
  if (arguments.length !== 3) fail('invalid_arguments');
  const effective = assessmentDate(effectiveDate), period = prepareNeighborhoodTransactionRetainedPeriodV1(observationPeriod, effective);
  const row = prepareNeighborhoodTypedTransactionV2(value), typed = row.typed;
  const cells = Object.fromEntries(Object.entries(typed.observations).map(([name, cell]) =>
    [name, name === 'normalized_year_built' ? yearCell(cell, effective) : compactCell(cell)]));
  const dates = Object.fromEntries(Object.entries(typed.dates).map(([name, cell]) => [name, compactDate(cell)]));
  const dateField = DEFINITION.period.normalized[row.kind], normalizedDate = dateField === null ? null : typed.dates[dateField];
  const reported = typed.same_payload_reported_sale;
  const reportedDate = reported === null ? null : disposition(reported.close_date, period);
  const result = { projection_version: 1, kind: row.kind, row_key: row.row_key, account_id: row.account_id,
    source_record_id: row.source_record_id, original: typed.original, markers: typed.markers,
    retained_effective_date: effective, retained_observation_period: period,
    normalized: { observations: cells, dates, period_date_field: dateField, period_disposition: disposition(normalizedDate, period) },
    same_payload_reported_sale: reported === null ? null : {
      observations: Object.fromEntries(Object.entries(reported.observations).map(([name, cell]) =>
        [name, name === 'reported_year_built' ? yearCell(cell, effective) : compactCell(cell)])),
      record_type: reported.record_type, close_date: compactDate(reported.close_date), period_disposition: reportedDate,
      closed_record_disposition: reportedDisposition(reported.record_type, reportedDate) },
    authority: 'not_established', transaction_eligibility: 'not_established', association_resolution: 'not_established',
    source_freshness: 'not_established', historical_stock: 'not_established', report_update: 'none' };
  if (Buffer.byteLength(canonicalAssessmentJson(result)) > NEIGHBORHOOD_TRANSACTION_TEMPORAL_V1_LIMITS.row_utf8_bytes) fail('row_limit');
  return freeze(result);
}
