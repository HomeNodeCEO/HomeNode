import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { neighborhoodMemberSetDigest } from './assessmentRepository.js';
import { serializePreparedSalesValue } from '../assignmentSalesCsv/receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from '../assignmentSalesCsv/review.js';
import { normalizeAssignmentSalesObservations } from '../assignmentSalesCsv/observations.js';

export const CUSTOM_COHORT_PRIVATE_SALES_PROFILE = 'assignment-private-reviewed-sales-v1';
export const CUSTOM_COHORT_PRIVATE_SALES_LIMITS = Object.freeze({ rows: 10000, supplement_utf8_bytes: 64 * 1024 * 1024,
  output_utf8_bytes: 16 * 1024 * 1024, public_utf8_bytes: 2 * 1024 * 1024, selected_accounts: 50000 });
const L = CUSTOM_COHORT_PRIVATE_SALES_LIMITS;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const DISPOSITIONS = ['prepared', 'needs_review', 'duplicate', 'identity_conflict', 'rejected', 'empty'];
const ROW_KEYS = ['source_row_number', 'source_line_number', 'byte_start', 'byte_end', 'raw_cells', 'record_sha256',
  'preparation_disposition', 'issues', 'values', 'group_id', 'duplicate_of_source_row_number', 'persisted', 'matching_status', 'analysis_status'];
const VALUE_KEYS = Object.keys(normalizeAssignmentSalesObservations({}).values);
const INTEGER_FIELDS = ['bedrooms_total', 'bathrooms_total_integer', 'bathrooms_full', 'bathrooms_half', 'days_on_market', 'year_built'];
const BOOLEAN_FIELDS = ['garage_yn', 'pool_yn'];
const DECIMAL_FIELDS = ['living_area', 'lot_size_area', 'current_price', 'close_price', 'ratio_current_price_by_living_area',
  'ratio_close_price_by_list_price', 'ratio_close_price_by_original_list_price', 'ratio_close_price_by_living_area', 'seller_contributions', 'garage_spaces'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_private_sales_${reason}`), {
  code: 'CUSTOM_COHORT_PRIVATE_SALES_INVALID', reason,
}); }
function check(ok, reason = 'shape') { if (!ok) fail(reason); }
function closed(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const ds = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(ds).length === keys.length && keys.every(key => ds[key]?.enumerable && Object.hasOwn(ds[key], 'value')));
}
function array(value, max) {
  check(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= max && Reflect.ownKeys(value).length === value.length + 1, 'array');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i)); check(d?.enumerable && Object.hasOwn(d, 'value'), 'array');
  }
}
function encoded(value) {
  try { return serializePreparedSalesValue(value); }
  catch { fail('bounded_plain_data'); }
}
const copied = value => JSON.parse(encoded(value));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const decimalText = value => typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)
  && value !== '-0' && value.replace(/[-.]/g, '').length <= 30 && (value.split('.')[1]?.length ?? 0) <= 12;
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`, 'capture_time');
}
function dataRow(data, ordinal) {
  closed(data, ROW_KEYS);
  check(data.source_row_number === ordinal && integer(data.source_line_number, 1, 8388608)
    && integer(data.byte_start, 0, 8388608) && integer(data.byte_end, data.byte_start, 8388608)
    && DISPOSITIONS.includes(data.preparation_disposition) && data.persisted === false
    && data.matching_status === 'not_evaluated' && data.analysis_status === 'not_evaluated', 'original_row');
  array(data.raw_cells, 128); array(data.issues, 128);
  check(data.raw_cells.every(v => typeof v === 'string' && Buffer.byteLength(v) <= 16384)
    && data.issues.every(v => typeof v === 'string' && /^[a-z][a-z0-9_]*$/.test(v) && v.length <= 100), 'original_row');
  check(data.group_id === null || /^rows:[1-9][0-9]{0,4}$/.test(data.group_id), 'original_row');
  check(data.duplicate_of_source_row_number === null || integer(data.duplicate_of_source_row_number, 2, ordinal - 1), 'original_row');
  if (['empty', 'rejected'].includes(data.preparation_disposition)) {
    check(data.values === null && data.record_sha256 === null, 'original_row'); return;
  }
  check(SHA.test(data.record_sha256) && data.record_sha256 === hash(JSON.stringify(data.raw_cells)), 'original_row_hash');
  closed(data.values, VALUE_KEYS);
  for (const [key, value] of Object.entries(data.values)) {
    if (value === null) continue;
    check(INTEGER_FIELDS.includes(key) ? integer(value, -2147483648, 2147483647)
      : BOOLEAN_FIELDS.includes(key) ? typeof value === 'boolean'
      : DECIMAL_FIELDS.includes(key) ? decimalText(value)
      : typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'observation_type');
  }
  check(['closed_sale', 'listing', 'unknown'].includes(data.values.record_type)
    && ['attached', 'detached', 'mixed', 'unknown'].includes(data.values.attachment_type), 'observation_type');
  for (const key of ['close_date', 'listing_contract_date']) if (data.values[key] !== null) assessmentDate(data.values[key]);
}

/** Pure admission of OWNER-LOADED immutable originals. No hash, review name or
 * source-use declaration establishes authorization, provider rights, source
 * truth, complete economic membership or historical stock. The DB owner must
 * verify the original preparation digest and exact review/target fences. */
export function prepareCustomCohortPrivateSalesSupplement(value) {
  closed(value, ['private_sales_capture_version', 'profile_id', 'target', 'batch', 'review', 'source_interpretation', 'captured_at', 'rows']);
  array(value.rows, L.rows);
  const { rows: omitted, ...rawMetadata } = value, metadata = copied(rawMetadata);
  check(metadata.private_sales_capture_version === 1 && metadata.profile_id === CUSTOM_COHORT_PRIVATE_SALES_PROFILE, 'profile');
  prepareCustomCohortContextScope(canonicalAssessmentJson(metadata.target));
  closed(metadata.batch, ['batch_id', 'source_sha256', 'preparation_sha256']);
  check(UUID.test(metadata.batch.batch_id) && SHA.test(metadata.batch.source_sha256) && SHA.test(metadata.batch.preparation_sha256), 'batch');
  closed(metadata.review, ['revision', 'head_review_id', 'source_review_id']);
  check(integer(metadata.review.revision, 1, 2147483647) && UUID.test(metadata.review.head_review_id)
    && UUID.test(metadata.review.source_review_id), 'review');
  timestamp(metadata.captured_at);
  let normalized;
  try { normalized = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0,
    source_interpretation: metadata.source_interpretation, row_decisions: [] }).source_interpretation; }
  catch { fail('source_interpretation'); }
  check(normalized?.source_use_confirmed === true
    && serializePreparedSalesValue(normalized) === serializePreparedSalesValue(metadata.source_interpretation), 'source_interpretation');
  let bytes = Buffer.byteLength(serializePreparedSalesValue(metadata)) + 12;
  const receipts = new Set(), rows = value.rows.map((raw, index) => {
    closed(raw, ['receipt_id', 'source_row_number', 'record_data', 'review']);
    // Charge the whole row before building a second large graph. The existing
    // serializer bounds each original record and rejects getters/proxies.
    const { record_data: original, ...rowMetadata } = raw;
    const rowMetadataJson = encoded(rowMetadata), originalJson = encoded(original);
    bytes += Buffer.byteLength(rowMetadataJson) + Buffer.byteLength(originalJson) + 17;
    check(bytes <= L.supplement_utf8_bytes, 'supplement_limit');
    const row = { ...JSON.parse(rowMetadataJson), record_data: JSON.parse(originalJson) };
    check(UUID.test(row.receipt_id) && !receipts.has(row.receipt_id) && row.source_row_number === index + 2, 'row_identity');
    receipts.add(row.receipt_id); dataRow(row.record_data, row.source_row_number);
    if (row.review !== null) {
      closed(row.review, ['review_id', 'revision', 'decision', 'account_ids', 'note']);
      check(UUID.test(row.review.review_id) && integer(row.review.revision, 1, metadata.review.revision), 'row_review');
      const { review_id, revision, ...decision } = row.review;
      let checked;
      try { checked = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0, source_interpretation: null,
        row_decisions: [{ receipt_id: row.receipt_id, source_row_number: row.source_row_number, ...decision }] }).row_decisions[0]; }
      catch { fail('row_review'); }
      check(serializePreparedSalesValue(checked.account_ids) === serializePreparedSalesValue(decision.account_ids), 'row_review');
      if (decision.decision === 'confirm_proposed_match') check(['prepared', 'needs_review'].includes(row.record_data.preparation_disposition), 'row_review');
    }
    return row;
  });
  return freeze({ ...metadata, rows });
}

// Exact decimal low/median/high, including half-cents and values outside the
// Number-safe range. This is NOT the report statistics engine or predominant.
const SCALE = 10n ** 12n;
function scaled(value) {
  const text = String(value), [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'));
}
function outputDecimal(value, digits = 12) {
  const text = value.toString().padStart(digits + 1, '0'), whole = text.slice(0, -digits), fraction = text.slice(-digits).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
const unitAliases = { sqft: ['sqft', 'sq ft', 'square feet'], sqm: ['sqm', 'sq m', 'square meters', 'square metres'], acre: ['acre', 'acres'] };
function units(values, declared, kind) {
  if (declared === null) return 'unsupported';
  const known = values.filter(value => value !== null && value !== undefined);
  const canonical = value => kind === 'currency' ? (value.trim().toUpperCase() === 'USD' ? 'USD' : null)
    : Object.keys(unitAliases).find(key => unitAliases[key].includes(value.trim().toLowerCase())) ?? null;
  if (known.some(value => canonical(value) !== declared)) return 'conflicting';
  return 'observed';
}
function metric(rows, field, { basis, unit, support = () => 'observed', zero = false, year = null } = {}) {
  const counts = { count: 0, missing_count: 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0 }, values = [];
  for (const row of rows) {
    const raw = field === null ? null : row.record_data.values[field], state = support(row.record_data.values);
    if (field === null || state !== 'observed') { counts[`${state === 'observed' ? 'unsupported' : state}_count`]++; continue; }
    if (raw === null) {
      counts[row.record_data.issues.includes(`invalid_${field}`) ? 'invalid_count' : 'missing_count']++; continue;
    }
    const text = String(raw);
    if (text.startsWith('-') || (!zero && text === '0') || (year !== null && (!integer(raw, 1600, year)))) {
      counts.invalid_count++; continue;
    }
    values.push(scaled(raw)); counts.count++;
  }
  values.sort(compare); const n = values.length, middle = Math.floor(n / 2);
  const median = !n ? null : n % 2 ? outputDecimal(values[middle]) : outputDecimal((values[middle - 1] + values[middle]) * 5n, 13);
  return { basis, unit, status: n ? 'observed' : 'unavailable', estimator: 'exact_reported_decimal_order_statistics',
    member_count: rows.length, ...counts, low: n ? outputDecimal(values[0]) : null, median, high: n ? outputDecimal(values.at(-1)) : null };
}
function disposition(row, period, effectiveDate, selected) {
  const data = row.record_data, review = row.review;
  if (['duplicate', 'identity_conflict', 'rejected', 'empty'].includes(data.preparation_disposition)) return data.preparation_disposition;
  if (review === null) return 'unreviewed';
  if (review.decision === 'exclude') return 'explicitly_excluded';
  if (review.decision === 'clear') return 'cleared';
  if (selected !== null && !review.account_ids.some(id => selected.has(id))) return 'outside_selection';
  if (data.values.record_type === 'listing') return 'nonclosed_listing';
  if (data.values.record_type !== 'closed_sale') return 'unknown_record_type';
  const date = data.values.close_date;
  if (date === null) return 'closing_date_unavailable';
  if (date > effectiveDate) return 'future_closing_date';
  if (date < period.start_date || date > period.end_date) return 'outside_observation_period';
  return 'included';
}

/** Current/private SOURCE-RECORD observations only. Full confirmed account
 * sets intersect selection; package totals are never assigned to properties.
 * Upload dates do not replace closing dates. No report readiness, sale-event
 * equivalence, housing eligibility, current-CAD fallback, unit conversion,
 * confidence/reliability, population sampling or accepted-report mutation. */
export function buildCustomCohortPrivateSalesObservations(input) {
  closed(input, ['supplement', 'context_ref', 'effective_date', 'observation_period', 'selection']);
  const supplement = prepareCustomCohortPrivateSalesSupplement(input.supplement);
  const context = prepareCustomCohortContextReference(serializePreparedSalesValue(input.context_ref));
  const effectiveDate = assessmentDate(input.effective_date), period = copied(input.observation_period), selection = copied(input.selection);
  closed(period, ['start_date', 'end_date']); assessmentDate(period.start_date); assessmentDate(period.end_date);
  check(period.start_date <= period.end_date && period.end_date <= effectiveDate, 'period');
  closed(selection, ['revision', 'account_ids']); array(selection.account_ids, L.selected_accounts);
  check(Number.isSafeInteger(selection.revision) && selection.revision > 0, 'selection');
  check(selection.account_ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128 && id.trim() === id && !/\p{Cc}/u.test(id))
    && new Set(selection.account_ids).size === selection.account_ids.length, 'selection');
  const chosen = new Set(selection.account_ids), source = supplement.source_interpretation;
  const priceOptions = field => ({ unit: source.currency, basis: `${field}_reported_value_not_verified_consideration`,
    support: values => units([values.currency, values.price_currency, values[`${field}_currency`]], source.currency, 'currency') });
  function population(selected) {
    const counts = {}, included = [], matched = new Set(); let partial = 0, confirmed = 0;
    for (const row of supplement.rows) {
      const d = disposition(row, period, effectiveDate, selected); counts[d] = (counts[d] ?? 0) + 1;
      if (row.review?.decision === 'confirm_proposed_match') confirmed++;
      if (d !== 'included') continue;
      included.push(row); row.review.account_ids.forEach(id => matched.add(id));
      if (selected !== null && row.review.account_ids.some(id => !selected.has(id))) partial++;
    }
    const one = included.filter(row => row.review.account_ids.length === 1), field = source.consideration_field;
    const total = metric(included, field, { ...priceOptions(field), basis: 'reviewer_designated_reported_total_per_source_record_not_canonical_event' });
    return { retained_row_count: supplement.rows.length, confirmed_match_row_count: confirmed,
      included_source_record_count: included.length, included_full_account_count: matched.size,
      single_account_source_record_count: one.length, multi_account_source_record_count: included.length - one.length,
      partially_selected_full_account_set_count: partial, disposition_counts: counts,
      metrics: {
        reported_transaction_price: total,
        reported_single_property_price: metric(one, field, { ...priceOptions(field), basis: 'reviewer_designated_reported_total_single_account_source_records_only' }),
        current_price: metric(included, 'current_price', priceOptions('current_price')),
        close_price: metric(included, 'close_price', priceOptions('close_price')),
        reported_living_area: metric(included, 'living_area', { basis: 'reported_living_area_not_verified_GLA_at_sale', unit: source.living_area_unit,
          support: values => units([values.living_area_units], source.living_area_unit, 'area') }),
        reported_site_area: metric(included, 'lot_size_area', { basis: 'reported_lot_area_no_unit_conversion', unit: source.site_area_unit,
          support: values => units([values.lot_size_units], source.site_area_unit, 'area') }),
        reported_year_built: metric(included, 'year_built', { basis: 'reported_year_built_not_historical_stock', unit: 'year', year: Number(effectiveDate.slice(0, 4)) }),
        reported_days_on_market: metric(included, source.marketing_time_field === 'days_on_market' ? 'days_on_market' : null,
          { basis: source.marketing_time_field === 'cumulative_days_on_market' ? 'cumulative_days_on_market_not_retained_by_v1_preparation'
            : 'reviewer_designated_source_days_on_market', unit: 'days', zero: true }),
      } };
  }
  const result = { private_sales_observation_version: 1, status: 'observations_only', profile_id: CUSTOM_COHORT_PRIVATE_SALES_PROFILE,
    authority: 'not_established', binding: { context_ref: context, target: supplement.target, batch: supplement.batch,
      review: supplement.review, selection_revision: selection.revision,
      selected_account_set_sha256: neighborhoodMemberSetDigest([...chosen].sort(compare)) },
    effective_date: effectiveDate, observation_period: period, captured_at: supplement.captured_at,
    basis: 'assignment_private_source_records_not_verified_sales_or_housing_stock',
    source_interpretation: source, all: population(null), selected: population(chosen),
    rows: supplement.rows.map(row => ({ receipt_id: row.receipt_id, source_row_number: row.source_row_number,
      preparation_disposition: row.record_data.preparation_disposition, review_decision: row.review?.decision ?? null,
      confirmed_account_ids: row.review?.decision === 'confirm_proposed_match' ? row.review.account_ids : [],
      disposition: disposition(row, period, effectiveDate, chosen) })),
    limitations: ['matched_identity_is_not_complete_economic_membership', 'source_records_are_not_canonical_sale_events',
      'current_price_is_not_automatically_close_price', 'historical_stock_not_established', 'source_rights_not_established_by_reviewer_declaration',
      'no_package_price_allocation', 'no_current_CAD_physical_fallback', 'reported_units_not_independent_measurement_verification'],
    apply: { status: 'blocked', reasons: ['private_source_observations_only'] } };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_limit');
  return freeze(result);
}

const OBSERVATION_KEYS = ['private_sales_observation_version', 'status', 'profile_id', 'authority', 'binding', 'effective_date',
  'observation_period', 'captured_at', 'basis', 'source_interpretation', 'all', 'selected', 'rows', 'limitations', 'apply'];
const POPULATION_KEYS = ['retained_row_count', 'confirmed_match_row_count', 'included_source_record_count', 'included_full_account_count',
  'single_account_source_record_count', 'multi_account_source_record_count', 'partially_selected_full_account_set_count', 'disposition_counts', 'metrics'];
const METRIC_NAMES = ['reported_transaction_price', 'reported_single_property_price', 'current_price', 'close_price',
  'reported_living_area', 'reported_site_area', 'reported_year_built', 'reported_days_on_market'];
const METRIC_BASES = {
  reported_transaction_price: ['reviewer_designated_reported_total_per_source_record_not_canonical_event'],
  reported_single_property_price: ['reviewer_designated_reported_total_single_account_source_records_only'],
  current_price: ['current_price_reported_value_not_verified_consideration'],
  close_price: ['close_price_reported_value_not_verified_consideration'],
  reported_living_area: ['reported_living_area_not_verified_GLA_at_sale'],
  reported_site_area: ['reported_lot_area_no_unit_conversion'],
  reported_year_built: ['reported_year_built_not_historical_stock'],
  reported_days_on_market: ['reviewer_designated_source_days_on_market', 'cumulative_days_on_market_not_retained_by_v1_preparation'],
};
const METRIC_KEYS = ['basis', 'unit', 'status', 'estimator', 'member_count', 'count', 'missing_count', 'invalid_count',
  'conflicting_count', 'unsupported_count', 'low', 'median', 'high'];
const PUBLIC_SOURCE_KEYS = ['source_name', 'currency', 'living_area_unit', 'site_area_unit', 'consideration_field', 'marketing_time_field'];

/** Summary projection of the preceding builder's result, not another capture
 * admission or permission check. Rows, notes, provenance and source-use claims
 * never cross this public boundary. Caller supplies the SAME accepted preview
 * binding; no browser-provided hash establishes authority or source membership. */
export function presentCustomCohortPrivateSalesObservations(input) {
  closed(input, ['observations', 'binding']);
  const observations = input.observations; closed(observations, OBSERVATION_KEYS);
  const expected = copied(input.binding); closed(expected, ['context_ref', 'selection_revision', 'selection_sha256']);
  prepareCustomCohortContextReference(encoded(expected.context_ref));
  check(Number.isSafeInteger(expected.selection_revision) && expected.selection_revision > 0 && SHA.test(expected.selection_sha256), 'presentation_binding');
  closed(observations.source_interpretation, [...PUBLIC_SOURCE_KEYS, 'provenance_note', 'source_use_confirmed']);
  const { rows, source_interpretation, ...body } = observations;
  let checkedSource;
  try { checkedSource = validateAssignmentSalesReviewCommand({ review_version: 1, expected_revision: 0,
    source_interpretation, row_decisions: [] }).source_interpretation; } catch { fail('presentation'); }
  check(checkedSource?.source_use_confirmed === true && encoded(checkedSource) === encoded(source_interpretation), 'presentation');
  const output = copied({ ...body, source_interpretation: Object.fromEntries(PUBLIC_SOURCE_KEYS.map(key => [key, source_interpretation[key]])) });
  check(output.private_sales_observation_version === 1 && output.status === 'observations_only'
    && output.profile_id === CUSTOM_COHORT_PRIVATE_SALES_PROFILE && output.authority === 'not_established'
    && output.basis === 'assignment_private_source_records_not_verified_sales_or_housing_stock', 'presentation');
  closed(output.binding, ['context_ref', 'target', 'batch', 'review', 'selection_revision', 'selected_account_set_sha256']);
  prepareCustomCohortContextScope(canonicalAssessmentJson(output.binding.target));
  closed(output.binding.batch, ['batch_id', 'source_sha256', 'preparation_sha256']);
  closed(output.binding.review, ['revision', 'head_review_id', 'source_review_id']);
  check(UUID.test(output.binding.batch.batch_id) && SHA.test(output.binding.batch.source_sha256)
    && SHA.test(output.binding.batch.preparation_sha256) && SHA.test(output.binding.selected_account_set_sha256)
    && integer(output.binding.review.revision, 1, 2147483647) && UUID.test(output.binding.review.head_review_id)
    && UUID.test(output.binding.review.source_review_id), 'presentation_binding');
  check(encoded(output.binding.context_ref) === encoded(expected.context_ref)
    && output.binding.selection_revision === expected.selection_revision, 'presentation_binding');
  assessmentDate(output.effective_date); timestamp(output.captured_at);
  closed(output.observation_period, ['start_date', 'end_date']);
  assessmentDate(output.observation_period.start_date); assessmentDate(output.observation_period.end_date);
  check(output.observation_period.start_date <= output.observation_period.end_date
    && output.observation_period.end_date <= output.effective_date, 'presentation');
  array(output.limitations, 8); check(output.limitations.every(value => typeof value === 'string' && /^[a-zA-Z_]+$/.test(value)
    && value.length <= 100), 'presentation');
  closed(output.apply, ['status', 'reasons']);
  check(output.apply.status === 'blocked' && encoded(output.apply.reasons) === '["private_source_observations_only"]', 'presentation');
  for (const population of [output.all, output.selected]) {
    closed(population, POPULATION_KEYS); closed(population.metrics, METRIC_NAMES);
    check(POPULATION_KEYS.slice(0, 7).every(key => integer(population[key], 0, key === 'included_full_account_count' ? 50000 : L.rows)), 'presentation');
    for (const [metricName, metricValue] of Object.entries(population.metrics)) {
      closed(metricValue, METRIC_KEYS);
      check(METRIC_BASES[metricName].includes(metricValue.basis)
        && [null, 'USD', 'sqft', 'sqm', 'acre', 'year', 'days'].includes(metricValue.unit)
        && ['observed', 'unavailable'].includes(metricValue.status)
        && metricValue.estimator === 'exact_reported_decimal_order_statistics'
        && METRIC_KEYS.slice(4, 10).every(key => integer(metricValue[key], 0, L.rows))
        && ['low', 'median', 'high'].every(key => metricValue[key] === null || typeof metricValue[key] === 'string'
          && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(metricValue[key]) && metricValue[key].replace('.', '').length <= 31
          && (metricValue[key].split('.')[1]?.length ?? 0) <= 13), 'presentation');
    }
    check(Object.entries(population.disposition_counts).every(([reason, count]) => [...DISPOSITIONS.slice(2), 'unreviewed',
      'explicitly_excluded', 'cleared', 'outside_selection', 'nonclosed_listing', 'unknown_record_type', 'closing_date_unavailable',
      'future_closing_date', 'outside_observation_period', 'included'].includes(reason) && integer(count, 0, L.rows)), 'presentation');
  }
  output.binding.selection_sha256 = expected.selection_sha256;
  check(Buffer.byteLength(JSON.stringify(output)) <= L.public_utf8_bytes, 'public_limit');
  return freeze(output);
}
