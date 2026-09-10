import type { CustomCohortContextRef, CustomCohortPreviewInput } from './customCohortPreviewController';

export interface PrivateSalesObservedMetric {
  readonly basis: string; readonly unit: string | null; readonly status: 'observed' | 'unavailable';
  readonly estimator: 'exact_reported_decimal_order_statistics'; readonly member_count: number; readonly count: number;
  readonly missing_count: number; readonly invalid_count: number; readonly conflicting_count: number; readonly unsupported_count: number;
  readonly low: string | null; readonly median: string | null; readonly high: string | null;
}
export const PRIVATE_SALES_OBSERVED_METRICS = Object.freeze({
  reported_transaction_price: 'Designated reported total / source record', reported_single_property_price: 'Designated total / single-account source record',
  current_price: 'CurrentPrice (separate reported value)', close_price: 'ClosePrice (separate reported value)',
  reported_living_area: 'Reported living area', reported_site_area: 'Reported site area',
  reported_year_built: 'Reported year built', reported_days_on_market: 'Designated reported marketing time',
});
export const PRIVATE_SALES_OBSERVATION_LIMITATIONS = Object.freeze([
  'matched_identity_is_not_complete_economic_membership', 'source_records_are_not_canonical_sale_events',
  'current_price_is_not_automatically_close_price', 'historical_stock_not_established', 'source_rights_not_established_by_reviewer_declaration',
  'no_package_price_allocation', 'no_current_CAD_physical_fallback', 'reported_units_not_independent_measurement_verification',
]);
const DISPOSITIONS = ['duplicate', 'identity_conflict', 'rejected', 'empty', 'unreviewed', 'explicitly_excluded', 'cleared',
  'outside_selection', 'nonclosed_listing', 'unknown_record_type', 'closing_date_unavailable', 'future_closing_date', 'outside_observation_period', 'included'];
export interface PrivateSalesObservedPopulation {
  readonly retained_row_count: number; readonly confirmed_match_row_count: number; readonly included_source_record_count: number;
  readonly included_full_account_count: number; readonly single_account_source_record_count: number; readonly multi_account_source_record_count: number;
  readonly partially_selected_full_account_set_count: number; readonly disposition_counts: Readonly<Record<string, number>>;
  readonly metrics: Readonly<Record<keyof typeof PRIVATE_SALES_OBSERVED_METRICS, PrivateSalesObservedMetric>>;
}
export interface CheckedPrivateSalesObservations {
  readonly private_sales_observation_version: 1; readonly status: 'observations_only'; readonly profile_id: 'assignment-private-reviewed-sales-v1';
  readonly authority: 'not_established'; readonly basis: 'assignment_private_source_records_not_verified_sales_or_housing_stock';
  readonly binding: {
    readonly context_ref: CustomCohortContextRef;
    readonly target: { readonly organization_id: string; readonly report_file_id: string; readonly assignment_file_id: string; readonly account_id: string };
    readonly batch: { readonly batch_id: string; readonly source_sha256: string; readonly preparation_sha256: string };
    readonly review: { readonly revision: number; readonly head_review_id: string; readonly source_review_id: string };
    readonly selection_revision: number; readonly selection_sha256: string; readonly selected_account_set_sha256: string;
  };
  readonly effective_date: string; readonly observation_period: { readonly start_date: string; readonly end_date: string }; readonly captured_at: string;
  readonly source_interpretation: { readonly source_name: string; readonly currency: 'USD' | null; readonly living_area_unit: 'sqft' | 'sqm' | null;
    readonly site_area_unit: 'sqft' | 'acre' | 'sqm' | null; readonly consideration_field: 'close_price' | 'current_price' | null;
    readonly marketing_time_field: 'days_on_market' | 'cumulative_days_on_market' | null };
  readonly all: PrivateSalesObservedPopulation; readonly selected: PrivateSalesObservedPopulation;
  readonly limitations: readonly string[]; readonly apply: { readonly status: 'blocked'; readonly reasons: readonly ['private_source_observations_only'] };
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, SHA = /^[a-f0-9]{64}$/;
const check: (ok: unknown) => asserts ok = ok => { if (!ok) throw new TypeError('invalid_custom_cohort_private_sales_summary'); };
function object(value: unknown): Record<string, unknown> {
  check(value && Object.getPrototypeOf(value) === Object.prototype); return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]) {
  const row = object(value); check(Reflect.ownKeys(row).length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(row, key); return d?.enumerable && Object.hasOwn(d, 'value');
  })); return row;
}
const count = (value: unknown, max = 10000): number => { check(Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max); return Number(value); };
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
function date(value: unknown): string {
  check(matches(value, /^\d{4}-\d\d-\d\d$/)); const parsed = new Date(`${value}T00:00:00.000Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value); return value;
}
function sameContext(value: unknown, expected: CustomCohortContextRef) {
  const ref = exact(value, ['context_id', 'context_revision', 'context_sha256']);
  check(matches(ref.context_id, UUID) && ref.context_revision === '1' && matches(ref.context_sha256, SHA)
    && ref.context_id === expected.context_id && ref.context_revision === expected.context_revision && ref.context_sha256 === expected.context_sha256);
}
function decimal(value: unknown): bigint {
  check(matches(value, /^(?:0|[1-9]\d{0,29})(?:\.\d{0,12}[1-9])?$/));
  check(value.replace('.', '').length <= 31);
  const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 13n + BigInt(fraction.padEnd(13, '0'));
}
/** Display only: exact nonnegative decimal rounded half-up to at most two
 * places, with grouping. Never use Number; callers retain the original title. */
export function formatPrivateSalesObservedDecimal(value: string | null, grouping = true): string {
  if (value === null) return 'Unavailable';
  const hundredths = (decimal(value) + 50_000_000_000n) / 100_000_000_000n;
  const digits = (hundredths / 100n).toString(), whole = grouping ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits;
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
function fixedStrings(value: unknown, expected: readonly string[]) {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === expected.length
    && Reflect.ownKeys(value).length === expected.length + 1);
  expected.forEach((item, i) => { const d = Object.getOwnPropertyDescriptor(value, String(i));
    check(d?.enumerable && Object.hasOwn(d, 'value') && d.value === item); });
}
function metric(raw: unknown, members: number, basis: string, unit: unknown) {
  const row = exact(raw, ['basis', 'unit', 'status', 'estimator', 'member_count', 'count', 'missing_count', 'invalid_count',
    'conflicting_count', 'unsupported_count', 'low', 'median', 'high']);
  check(row.basis === basis && row.unit === unit && row.estimator === 'exact_reported_decimal_order_statistics'
    && count(row.member_count) === members);
  const counts = ['count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'].map(key => count(row[key], members));
  check(counts.reduce((a, b) => a + b, 0) === members);
  if (counts[0] === 0) check(row.status === 'unavailable' && row.low === null && row.median === null && row.high === null);
  else { check(row.status === 'observed'); const low = decimal(row.low), median = decimal(row.median), high = decimal(row.high);
    check(low <= median && median <= high); }
  return row as unknown as PrivateSalesObservedMetric;
}
function population(raw: unknown, source: CheckedPrivateSalesObservations['source_interpretation']): PrivateSalesObservedPopulation {
  const row = exact(raw, ['retained_row_count', 'confirmed_match_row_count', 'included_source_record_count', 'included_full_account_count',
    'single_account_source_record_count', 'multi_account_source_record_count', 'partially_selected_full_account_set_count', 'disposition_counts', 'metrics']);
  const retained = count(row.retained_row_count), confirmed = count(row.confirmed_match_row_count, retained);
  const included = count(row.included_source_record_count, confirmed), single = count(row.single_account_source_record_count, included);
  const multi = count(row.multi_account_source_record_count, included), full = count(row.included_full_account_count, included * 5);
  check(single + multi === included && count(row.partially_selected_full_account_set_count, multi) <= multi
    && (included === 0 ? full === 0 : full >= (multi > 0 ? 2 : 1)));
  const dispositions = object(row.disposition_counts), keys = Object.keys(dispositions);
  check(Reflect.ownKeys(dispositions).length === keys.length && keys.every(key => DISPOSITIONS.includes(key)));
  let total = 0; for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(dispositions, key); check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    total += count(dispositions[key], retained);
  }
  check(total === retained && (dispositions.included ?? 0) === included);
  const nonConfirmed = ['duplicate', 'identity_conflict', 'rejected', 'empty', 'unreviewed', 'explicitly_excluded', 'cleared'];
  check(keys.filter(key => !nonConfirmed.includes(key)).reduce((sum, key) => sum + Number(dispositions[key]), 0) === confirmed);
  const metrics = exact(row.metrics, Object.keys(PRIVATE_SALES_OBSERVED_METRICS));
  const definitions: Record<keyof typeof PRIVATE_SALES_OBSERVED_METRICS, [number, string, unknown]> = {
    reported_transaction_price: [included, 'reviewer_designated_reported_total_per_source_record_not_canonical_event', source.currency],
    reported_single_property_price: [single, 'reviewer_designated_reported_total_single_account_source_records_only', source.currency],
    current_price: [included, 'current_price_reported_value_not_verified_consideration', source.currency],
    close_price: [included, 'close_price_reported_value_not_verified_consideration', source.currency],
    reported_living_area: [included, 'reported_living_area_not_verified_GLA_at_sale', source.living_area_unit],
    reported_site_area: [included, 'reported_lot_area_no_unit_conversion', source.site_area_unit],
    reported_year_built: [included, 'reported_year_built_not_historical_stock', 'year'],
    reported_days_on_market: [included, source.marketing_time_field === 'cumulative_days_on_market' ? 'cumulative_days_on_market_not_retained_by_v1_preparation'
      : 'reviewer_designated_source_days_on_market', 'days'],
  };
  for (const [key, [members, basis, unit]] of Object.entries(definitions)) metric(metrics[key], members, basis, unit);
  for (const [key, [members, , unit]] of Object.entries(definitions)) {
    if (unit === null || key.startsWith('reported_') && key.endsWith('_price') && source.consideration_field === null
      || key === 'reported_days_on_market' && source.marketing_time_field !== 'days_on_market')
      check((metrics[key] as PrivateSalesObservedMetric).unsupported_count === members);
  }
  return row as unknown as PrivateSalesObservedPopulation;
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Closed summary-only server projection. SHA syntax is not evidence authority:
 * context/revision and the existing exact selection fingerprint must also match.
 * No raw rows, review notes, provider permissions or latest-review lookup. */
export function checkCustomCohortPrivateSales(raw: unknown, input: CustomCohortPreviewInput, selectionSha256: string): CheckedPrivateSalesObservations {
  const value = exact(raw, ['private_sales_observation_version', 'status', 'profile_id', 'authority', 'binding', 'effective_date',
    'observation_period', 'captured_at', 'basis', 'source_interpretation', 'all', 'selected', 'limitations', 'apply']);
  check(value.private_sales_observation_version === 1 && value.status === 'observations_only' && value.authority === 'not_established'
    && value.profile_id === 'assignment-private-reviewed-sales-v1' && value.basis === 'assignment_private_source_records_not_verified_sales_or_housing_stock');
  const binding = exact(value.binding, ['context_ref', 'target', 'batch', 'review', 'selection_revision', 'selection_sha256', 'selected_account_set_sha256']);
  sameContext(binding.context_ref, input.contextRef); const target = exact(binding.target, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
  check(matches(target.organization_id, UUID) && matches(target.report_file_id, UUID) && target.account_id === input.accountId
    && target.assignment_file_id === input.assignmentFileId && Number.isSafeInteger(binding.selection_revision) && Number(binding.selection_revision) > 0
    && binding.selection_revision === input.selection.revision && matches(binding.selection_sha256, SHA) && matches(selectionSha256, SHA)
    && binding.selection_sha256 === selectionSha256 && matches(binding.selected_account_set_sha256, SHA));
  const batch = exact(binding.batch, ['batch_id', 'source_sha256', 'preparation_sha256']), review = exact(binding.review, ['revision', 'head_review_id', 'source_review_id']);
  check(matches(batch.batch_id, UUID) && matches(batch.source_sha256, SHA) && matches(batch.preparation_sha256, SHA)
    && count(review.revision, 2147483647) > 0 && matches(review.head_review_id, UUID) && matches(review.source_review_id, UUID));
  const period = exact(value.observation_period, ['start_date', 'end_date']), effective = date(value.effective_date);
  check(date(period.start_date) <= date(period.end_date) && String(period.end_date) <= effective);
  check(matches(value.captured_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
    && Number.isFinite(Date.parse(value.captured_at)) && new Date(value.captured_at).toISOString() === `${value.captured_at.slice(0, 23)}Z`);
  const source = exact(value.source_interpretation, ['source_name', 'currency', 'living_area_unit', 'site_area_unit', 'consideration_field', 'marketing_time_field']);
  check(typeof source.source_name === 'string' && source.source_name.length > 0 && source.source_name.length <= 200 && source.source_name.trim() === source.source_name
    && !/\p{Cc}/u.test(source.source_name) && Array.from(source.source_name).every(c => c.length === 2 || !/[\ud800-\udfff]/.test(c)));
  for (const [key, allowed] of [['currency', ['USD']], ['living_area_unit', ['sqft', 'sqm']], ['site_area_unit', ['sqft', 'acre', 'sqm']],
    ['consideration_field', ['close_price', 'current_price']], ['marketing_time_field', ['days_on_market', 'cumulative_days_on_market']]] as const)
    check(source[key] === null || (allowed as readonly unknown[]).includes(source[key]));
  const interpreted = source as unknown as CheckedPrivateSalesObservations['source_interpretation'];
  const all = population(value.all, interpreted), selected = population(value.selected, interpreted);
  check(all.retained_row_count === selected.retained_row_count && all.confirmed_match_row_count === selected.confirmed_match_row_count
    && all.partially_selected_full_account_set_count === 0 && (all.disposition_counts.outside_selection ?? 0) === 0);
  for (const key of ['included_source_record_count', 'included_full_account_count', 'single_account_source_record_count', 'multi_account_source_record_count'] as const)
    check(selected[key] <= all[key]);
  for (const key of ['duplicate', 'identity_conflict', 'rejected', 'empty', 'unreviewed', 'explicitly_excluded', 'cleared'])
    check((selected.disposition_counts[key] ?? 0) === (all.disposition_counts[key] ?? 0));
  for (const key of Object.keys(PRIVATE_SALES_OBSERVED_METRICS) as (keyof typeof PRIVATE_SALES_OBSERVED_METRICS)[]) {
    const a = all.metrics[key], s = selected.metrics[key];
    for (const field of ['count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'] as const) check(s[field] <= a[field]);
    if (s.count) check(decimal(s.low) >= decimal(a.low) && decimal(s.high) <= decimal(a.high));
  }
  fixedStrings(value.limitations, PRIVATE_SALES_OBSERVATION_LIMITATIONS);
  const apply = exact(value.apply, ['status', 'reasons']); check(apply.status === 'blocked');
  fixedStrings(apply.reasons, ['private_source_observations_only']);
  const json = JSON.stringify(value); check(new TextEncoder().encode(json).byteLength <= 2 * 1024 * 1024);
  return freeze(JSON.parse(json)) as CheckedPrivateSalesObservations;
}
