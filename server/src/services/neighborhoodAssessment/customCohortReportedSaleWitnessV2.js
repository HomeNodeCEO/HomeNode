import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { CACHED_SALE_WITNESS_V2_FIELDS, CACHED_SALE_WITNESS_V2_LIMITS, prepareCachedSaleWitnessV2 } from './cachedSaleWitnessV2.js';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const CUSTOM_COHORT_REPORTED_SALE_WITNESS_V2_LIMITS = Object.freeze({
  numeric_token_characters: 128, canonical_digits: 30, fractional_digits: 12, integer_max: 2_147_483_647,
  year_min: 1600, output_utf8_bytes: 65_536,
});
const L = CUSTOM_COHORT_REPORTED_SALE_WITNESS_V2_LIMITS;

// Fixed local syntax/interpretation, NOT a provider dictionary or source grant.
// This definition also pins the later caller's population/aggregation duties;
// this isolated module interprets one witness and performs no graph traversal.
const DEFINITION = freeze({
  id: 'custom-local-reported-sale-witness-v2', revision: '1', cached_mapping_version: 5, witness_version: 2,
  authority: 'not_established', provider_meaning: 'not_established', scope: 'one_admitted_same_payload_witness',
  observation_basis: 'same_payload_scalar_witness_reported_not_verified',
  fields: {
    reported_close_price: { value_field: 'ClosePrice', unit_field: 'ClosePriceCurrency', policy: 'nonnegative', units: ['USD'] },
    reported_current_price: { value_field: 'CurrentPrice', unit_field: 'CurrentPriceCurrency', policy: 'nonnegative', units: ['USD'] },
    reported_living_area: { value_field: 'LivingArea', unit_field: 'LivingAreaUnits', policy: 'positive', units: ['sqft', 'sqm'] },
    reported_site_area: { value_field: 'LotSizeArea', unit_field: 'LotSizeUnits', policy: 'nonnegative', units: ['sqft', 'sqm', 'acre'] },
    reported_year_built: { value_field: 'YearBuilt', unit_field: null, policy: 'year', units: ['year'] },
    reported_days_on_market: { value_field: 'DaysOnMarket', unit_field: null, policy: 'integer', units: ['days'] },
  },
  scalar: {
    admitted_json_types: ['string', 'number'], token_length_before_trim: false, trim: 'ECMAScript_String_trim',
    grammar: '^\\+?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$',
    canonicalization: ['remove_one_leading_plus', 'remove_leading_integer_zeroes_keep_one', 'remove_trailing_fractional_zeroes'],
    digit_bounds_after_canonicalization: true, integer_policy: 'canonical_fraction_empty_and_nonnegative_int32',
    year_policy: 'integer_1600_through_effective_date_year_inclusive',
    zero: { price: 'reported_zero_allowed_not_proof_of_consideration', site_area: 'reported_zero_allowed_not_proof_of_usable_parcel',
      living_area: 'invalid', days_on_market: 'observed', year_built: 'invalid' },
    forbidden: ['minus_including_negative_zero', 'exponent', 'commas', 'currency_symbols', 'nonfinite', 'floating_point_conversion'],
    numeric_limits: L,
  },
  states: {
    exhaustive: ['observed', 'missing', 'invalid', 'conflicting', 'unsupported'],
    value_precedence: ['absent_json_null_or_blank_string_missing', 'payload_unavailable_or_oversize_unsupported',
      'non_scalar_wrong_type_or_bad_numeric_invalid', 'valid_numeric_then_metadata'],
    value_reason_prefix: 'raw_value_', value_reasons: ['absent', 'json_null', 'blank', 'payload_unavailable', 'oversize',
      'non_scalar', 'type_invalid', 'invalid'],
    exact_value: 'observed_or_unsupported_or_conflicting_retains_valid_numeric_otherwise_null',
    unit: 'non_null_only_for_observed', observed_reason: null,
  },
  units: {
    required_type: 'nonblank_scalar_string', trim: true, area_case: 'lowercase', currency_case: 'uppercase',
    aliases: { sqft: ['sqft', 'sq ft', 'square feet'], sqm: ['sqm', 'sq m', 'square meters', 'square metres'], acre: ['acre', 'acres'] },
    currencies: ['USD'],
    required_metadata_precedence: ['missing', 'unavailable', 'invalid_type', 'currency_generic_vetoes', 'unsupported_literal', 'observed'],
    reasons: { missing: 'raw_unit_missing', unavailable: 'raw_unit_unavailable', invalid: 'raw_unit_invalid', unsupported: 'raw_unit_unsupported' },
    generic_currency_fields: ['Currency', 'PriceCurrency'], generic_currency_policy: 'veto_only_never_affirmative_or_fallback',
    generic_evaluated_only_with: 'nonblank_scalar_string_field_specific_currency',
    generic_neutral: ['absent', 'json_null', 'blank_scalar_string'],
    generic_precedence: ['invalid_type', 'unavailable_or_oversize', 'distinct_trimmed_uppercase_token_conflict'],
    generic_reasons: { invalid: 'raw_currency_invalid', unavailable: 'raw_currency_unavailable', conflicting: 'raw_currency_conflict' },
    other_price_currency: 'not_consulted', conversion: 'none', heterogeneous_observed_units: 'no_preferred_unit_or_pooled_statistic',
  },
  record_type: {
    population_label: 'source-reported closed records', primary_field: 'MlsStatus', consistency_field: 'StandardStatus',
    required_type: 'scalar_string', normalization: 'trim_then_lowercase', closed_tokens: ['closed'],
    nonclosed_tokens: ['active', 'active option contract', 'active contingent', 'active kick out', 'active under contract',
      'pending', 'coming soon', 'hold', 'withdrawn', 'expired', 'canceled', 'cancelled', 'temp off market', 'temporarily off market', 'incomplete'],
    consistency_missing: 'neutral', primary_missing: 'unknown_record_type', primary_unknown: 'unknown_record_type',
    consistency_unknown_or_unavailable_or_malformed: 'unknown_record_type', opposite_recognized_classes: 'conflicting_record_type',
    different_recognized_nonclosed_tokens: 'nonclosed', primary_fallback: 'none',
    precedence: ['primary_missing_or_unknown', 'consistency_unknown', 'opposite_classes', 'primary_recognized_class'],
    diagnostic_reason_prefix: 'raw_status_', diagnostic_reasons: ['absent', 'json_null', 'blank', 'payload_unavailable',
      'oversize', 'non_scalar', 'type_invalid', 'unrecognized'],
  },
  close_date: {
    field: 'CloseDate', required_type: 'scalar_string', trim: true,
    grammars: ['^(\\d{4})-(\\d{2})-(\\d{2})$', '^(\\d{1,2})/(\\d{1,2})/(\\d{4})$'],
    slash_order: 'month_day_year', calendar: 'Gregorian_divisible_by_4_except_centuries_unless_divisible_by_400',
    minimum_year: 1, maximum_year: 9999, canonical: 'YYYY-MM-DD',
    missing: ['absent', 'json_null', 'blank_scalar_string'], missing_reason: 'missing_close_date',
    unsupported: ['payload_unavailable', 'oversize'], unsupported_reason: 'unsupported_close_date',
    otherwise_invalid_reason: 'invalid_close_date', diagnostics: 'retain_exact_original_state_type_text_and_bytes',
    no_timestamp_timezone_or_modification_date_fallback: true,
    period: 'caller_checks_start_lte_end_lte_effective_date_and_inclusive_start_end_no_capture_date_filter',
    future_raw_date: 'preserved_valid_calendar_date_then_caller_outside_period', conflicting_close_date_count: 'zero_for_one_identical_witness',
  },
  no_fallback_fields: ['AboveGradeFinishedArea', 'LotSizeSquareFeet', 'LotSizeAcres', 'ListPrice', 'OriginalListPrice',
    'CumulativeDaysOnMarket', 'ModificationTimestamp', 'source_current_price', 'source_living_area', 'source_lot_size_area',
    'source_year_built', 'source_days_on_market', 'source_close_date', 'sale_closing_date', 'sale_price', 'ratios', 'current_CAD'],
  duplicate_source_rule: 'one_source_record_observation_full_canonical_witness_equality_or_whole_result_source_witness_mismatch',
  associations: 'preserve_complete_one_hop_account_set_including_outside_discovery_and_unresolved_no_second_hop_or_price_allocation',
  source_less_canonical_row: 'legacy_source_record_unavailable_no_fabricated_witness_or_member',
  disposition_order: ['associations_unavailable', 'outside_selection', 'conflicting_record_type', 'unknown_record_type', 'nonclosed',
    'conflicting_close_date', 'unsupported_close_date', 'invalid_close_date', 'missing_close_date', 'outside_period', 'included'],
  aggregation: {
    denominator: 'each_included_source_record_once_per_metric_including_all_five_states',
    no_observed_cells: 'null_price_area_unit_and_values_fixed_year_day_units',
    one_observed_unit: 'only_observed_values_exact_BigInt_scale12_low_median_high',
    multiple_observed_units: 'null_unit_and_low_median_high_preserve_observed_cells_and_counts',
    even_median: 'exact_up_to_13_fractional_digits_no_float',
  },
  witness_admission: { fields: CACHED_SALE_WITNESS_V2_FIELDS, limits: CACHED_SALE_WITNESS_V2_LIMITS,
    exact_closed_data_properties: true, getter_proxy_or_version_mismatch: 'reject_not_missing' },
  caller_resources: { chunks: 1000, records_per_chunk: 100000, selected_accounts: 50000, accounts_per_record: 1000,
    account_links: 250000, output_utf8_bytes: 32000000, default_total_records: 100000, maximum_dense_total_records: 200000,
    dense_limit_requires: 'already_admitted_original_mapping5_metadata_record_budget', limits_not_grants: true },
  caller_obligations: ['mapping5_only_no_version_upgrade', 'complete_graph_roster_scope_projection_snapshot_routing_admission',
    'source_rights_and_freshness', 'historical_stock_gate', 'retain_exact_definition_and_profile_ref_in_report_evidence',
    'existing_reports_reopen_retained_semantics_not_current_defaults'],
  limitations: ['local_interpretation_not_an_official_NTREIS_or_Trestle_dictionary', 'stored_JSONB_scalar_text_not_original_file_bytes',
    'no_source_rights_or_fact_authority', 'generic_currency_scope_not_established', 'raw_typed_agreement_not_common_revision_proof',
    'reported_living_area_not_verified_GLA_at_sale', 'no_measurement_standard_or_unit_conversion',
    'no_verified_completion_consideration_historical_stock_market_eligibility_or_economic_property_equivalence',
    'heterogeneous_observed_units_are_not_pooled', 'old_imports_or_captures_cannot_acquire_discarded_raw_evidence'],
});
const definitionJson = canonicalAssessmentJson(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionJson);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionJson } });
export function getCustomCohortReportedSaleWitnessV2Profile() { return PROFILE; }
const FIELD_ENTRIES = Object.entries(DEFINITION.fields);
const DIAGNOSTIC_KEYS = [...new Set([...FIELD_ENTRIES.flatMap(([, field]) => [field.value_field, field.unit_field]).filter(Boolean),
  ...DEFINITION.units.generic_currency_fields, 'MlsStatus', 'StandardStatus', 'CloseDate'])];

function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_reported_sale_witness_v2_${reason}`), {
  code: 'CUSTOM_COHORT_REPORTED_SALE_WITNESS_V2_INVALID', reason,
}); }
const missing = cell => cell.state === 'absent' || cell.state === 'json_null'
  || (cell.state === 'scalar' && cell.json_type === 'string' && cell.value_text.trim() === '');
const unavailable = cell => cell.state === 'oversize' || cell.state === 'payload_unavailable';
const stringCell = cell => cell.state === 'scalar' && cell.json_type === 'string';
const rawReason = cell => cell.state === 'scalar' ? cell.json_type === 'string' && !cell.value_text.trim() ? 'blank' : 'type_invalid' : cell.state;
const cellResult = (state, exact, unit, reason) => ({ state,
  exact_value: ['observed', 'unsupported', 'conflicting'].includes(state) ? exact : null,
  unit: state === 'observed' ? unit : null, reason });

function decimal(text, policy, effectiveYear) {
  const token = text.trim();
  if (token.length > L.numeric_token_characters || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return null;
  let [whole, fraction = ''] = token.replace(/^\+/, '').split('.');
  whole = whole.replace(/^0+/, '') || '0'; fraction = fraction.replace(/0+$/, '');
  if (whole.length + fraction.length > L.canonical_digits || fraction.length > L.fractional_digits
    || (policy === 'positive' && whole === '0' && !fraction)
    || (['integer', 'year'].includes(policy) && (fraction || BigInt(whole) > BigInt(L.integer_max)))
    || (policy === 'year' && (BigInt(whole) < BigInt(L.year_min) || BigInt(whole) > effectiveYear))) return null;
  return whole + (fraction ? `.${fraction}` : '');
}
function metadata(fields, descriptor) {
  if (descriptor.unit_field === null) return { state: 'observed', unit: descriptor.units[0], reason: null };
  const cell = fields[descriptor.unit_field];
  if (missing(cell)) return { state: 'unsupported', reason: 'raw_unit_missing' };
  if (unavailable(cell)) return { state: 'unsupported', reason: 'raw_unit_unavailable' };
  if (!stringCell(cell)) return { state: 'invalid', reason: 'raw_unit_invalid' };
  const currency = descriptor.units[0] === 'USD', token = currency ? cell.value_text.trim().toUpperCase() : cell.value_text.trim().toLowerCase();
  if (currency) {
    const generic = DEFINITION.units.generic_currency_fields.map(key => fields[key]).filter(cell => !missing(cell));
    if (generic.some(cell => !unavailable(cell) && !stringCell(cell))) return { state: 'invalid', reason: 'raw_currency_invalid' };
    if (generic.some(unavailable)) return { state: 'unsupported', reason: 'raw_currency_unavailable' };
    if (generic.some(cell => cell.value_text.trim().toUpperCase() !== token)) return { state: 'conflicting', reason: 'raw_currency_conflict' };
  }
  const unit = currency ? token === 'USD' ? 'USD' : null
    : descriptor.units.find(unit => DEFINITION.units.aliases[unit].includes(token));
  return unit ? { state: 'observed', unit, reason: null } : { state: 'unsupported', reason: 'raw_unit_unsupported' };
}
function observation(fields, descriptor, effectiveYear) {
  const cell = fields[descriptor.value_field];
  if (missing(cell)) return cellResult('missing', null, null, `raw_value_${rawReason(cell)}`);
  if (unavailable(cell)) return cellResult('unsupported', null, null, `raw_value_${cell.state}`);
  if (cell.state !== 'scalar' || !['string', 'number'].includes(cell.json_type)) return cellResult('invalid', null, null, `raw_value_${rawReason(cell)}`);
  const exact = decimal(cell.value_text, descriptor.policy, effectiveYear);
  if (exact === null) return cellResult('invalid', null, null, 'raw_value_invalid');
  const paired = metadata(fields, descriptor);
  return cellResult(paired.state, exact, paired.unit ?? null, paired.reason);
}
function status(cell) {
  if (missing(cell)) return { classification: 'missing', reason: `raw_status_${rawReason(cell)}` };
  if (!stringCell(cell)) return { classification: 'unknown', reason: `raw_status_${rawReason(cell)}` };
  const token = cell.value_text.trim().toLowerCase();
  return DEFINITION.record_type.closed_tokens.includes(token) ? { classification: 'closed', reason: null }
    : DEFINITION.record_type.nonclosed_tokens.includes(token) ? { classification: 'nonclosed', reason: null }
      : { classification: 'unknown', reason: 'raw_status_unrecognized' };
}
function recordType(primary, secondary) {
  if (['missing', 'unknown'].includes(primary.classification) || secondary.classification === 'unknown') return { state: 'unknown', reason: 'unknown_record_type' };
  if (secondary.classification !== 'missing' && primary.classification !== secondary.classification) return { state: 'conflicting', reason: 'conflicting_record_type' };
  return { state: primary.classification, reason: primary.classification === 'closed' ? null : 'nonclosed' };
}
// Syntax-only copy of the installed private CSV calendar algorithm. Keeping it
// local avoids changing that normalizer's distinct numeric/status policies.
function calendarDate(text) {
  const token = text.trim(), iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token), csv = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(token);
  if (!iso && !csv) return null;
  const [year, month, day] = iso ? iso.slice(1).map(Number) : [Number(csv[3]), Number(csv[1]), Number(csv[2])];
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function closeDate(cell) {
  if (missing(cell)) return { state: 'missing', exact_value: null, reason: 'missing_close_date' };
  if (unavailable(cell)) return { state: 'unsupported', exact_value: null, reason: 'unsupported_close_date' };
  const date = stringCell(cell) ? calendarDate(cell.value_text) : null;
  return date === null ? { state: 'invalid', exact_value: null, reason: 'invalid_close_date' }
    : { state: 'observed', exact_value: date, reason: null };
}

/** Pure opt-in local interpretation. Does not accept a policy, read originals,
 * aggregate records, bind a source/subject, or grant authority. Its caller must
 * admit original mapping5 and complete source/roster/rights before using results.
 */
export function interpretCustomCohortReportedSaleWitnessV2(value, effectiveDate) {
  if (arguments.length !== 2) fail('arguments');
  const witness = prepareCachedSaleWitnessV2(value), effective = assessmentDate(effectiveDate, 'effective_date');
  const fields = witness.fields, primary = status(fields.MlsStatus), secondary = status(fields.StandardStatus), effectiveYear = BigInt(effective.slice(0, 4));
  const result = { interpretation_profile_ref: PROFILE.profile_ref, observation_basis: DEFINITION.observation_basis,
    observations: Object.fromEntries(FIELD_ENTRIES.map(([key, descriptor]) => [key, observation(fields, descriptor, effectiveYear)])),
    record_type: recordType(primary, secondary), close_date: closeDate(fields.CloseDate),
    diagnostics: { root_state: witness.root_state, root_json_type: witness.root_json_type,
      raw_fields: Object.fromEntries(DIAGNOSTIC_KEYS.map(key => [key, fields[key]])),
      status_interpretations: { MlsStatus: primary, StandardStatus: secondary } } };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > L.output_utf8_bytes) fail('output_limit');
  return freeze(result);
}
