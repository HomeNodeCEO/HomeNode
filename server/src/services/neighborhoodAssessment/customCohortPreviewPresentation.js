import { createHash } from 'node:crypto';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';

export const CUSTOM_COHORT_PREVIEW_PRESENTATION_LIMITS = Object.freeze({
  pockets: 128, pocket_memberships: 100000, population_members: 100000,
  page_members: 50, summary_utf8_bytes: 2000000, page_utf8_bytes: 256000,
  text_utf8_bytes: 1024, identity_utf8_bytes: 800, metrics_per_population: 15,
});
const L = CUSTOM_COHORT_PREVIEW_PRESENTATION_LIMITS;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_preview_presentation_${reason}`), { code: 'CUSTOM_COHORT_PREVIEW_PRESENTATION_INVALID', reason }); }
function check(ok, reason) { if (!ok) fail(reason); }
function object(value) { check(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_shape'); return value; }
function array(value, maximum = L.population_members) { check(Array.isArray(value) && value.length <= maximum, 'array_limit'); return value; }
function text(value, maximum = L.text_utf8_bytes) {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && Buffer.byteLength(value) <= maximum && !/[\u0000-\u001f\u007f]/.test(value), 'text_limit'); return value;
}
const maybeText = value => value === null ? null : text(value);
function count(value) { check(Number.isSafeInteger(value) && value >= 0, 'invalid_count'); return value; }
const maybeCount = value => value === null ? null : count(value);
function finite(value) { check(value === null || (typeof value === 'number' && Number.isFinite(value)), 'invalid_number'); return value; }
function oneOf(value, choices) { check(choices.includes(value), 'unsupported_value'); return value; }
function exactMetricKeys(value, keys) {
  object(value); check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'unsupported_metrics');
}
const METRICS = Object.freeze({
  stock: ['year_built', 'gla_sqft', 'site_area_sqft', 'assessed_value'],
  transactions: ['recorded_total_price'],
  source_reported: ['living_area', 'lot_size_area', 'year_built', 'bedrooms_total', 'bathrooms_total_integer',
    'bathrooms_full', 'bathrooms_half', 'garage_spaces', 'days_on_market', 'current_price'],
});
const NUMBER_FIELDS = ['low', 'q1', 'median', 'q3', 'high', 'mean', 'cod_percent', 'coverage_percent'];
const COUNT_FIELDS = ['member_count', 'count', 'missing_count', 'minimum_count', 'conflicting_count', 'invalid_count', 'absent_count', 'partially_observed_count'];
const UNAVAILABLE = ['property_sale_price', 'sale_price_per_square_foot', 'age_at_sale', 'age_at_effective_date', 'predominant_value', 'market_trend', 'reliability'];
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const perSquareFootFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const yearFormat = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 2 });
function displayed(value, unit, field) {
  if (value === null) return 'Unavailable';
  if (field.endsWith('_percent')) return `${numberFormat.format(value)}%`;
  // The current observation contract has no verified currency. Never prepend
  // a currency symbol based on an amount-like field name or the user's locale.
  return (unit?.endsWith('/ft2') ? perSquareFootFormat : unit === 'year' ? yearFormat : numberFormat).format(value);
}
function strings(values) { return array(values, 64).map(value => text(value)); }

export function customCohortPreviewBinding(preview, expected) {
  object(preview); object(expected);
  check(preview.preview_version === 1 && preview.status === 'observations_only'
    && preview.authority === 'not_established' && preview.apply?.status === 'blocked', 'unsupported_preview');
  const actual = prepareCustomCohortContextReference(canonicalAssessmentJson(preview.context_ref));
  const requested = prepareCustomCohortContextReference(canonicalAssessmentJson(expected.context_ref));
  check(canonicalAssessmentJson(actual) === canonicalAssessmentJson(requested), 'context_mismatch');
  check(count(preview.selection_revision) > 0 && preview.selection_revision === expected.selection_revision, 'selection_mismatch');
  let memberships = 0; const pocketIds = new Set();
  const pockets = array(preview.pockets, L.pockets).map(pocket => {
    const id = text(pocket.id, L.identity_utf8_bytes), label = text(pocket.label);
    check(!pocketIds.has(id), 'duplicate_pocket'); pocketIds.add(id);
    const account_ids = array(pocket.account_ids, 50000).map(account => text(account, 400)).sort(compare);
    memberships += account_ids.length;
    check(memberships <= L.pocket_memberships && new Set(account_ids).size === account_ids.length, 'pocket_membership_limit');
    return { account_ids, id, label };
  }).sort((a, b) => compare(a.id, b.id));
  // This exact insertion/key order is shared with the browser controller.
  // It is a content identity only, never permission or a signed token.
  const selection_sha256 = hash(JSON.stringify({ pockets, revision: preview.selection_revision }));
  return { context_ref: actual, selection_revision: preview.selection_revision, selection_sha256 };
}
const bindingOf = customCohortPreviewBinding;
function header(preview, binding) {
  const period = { start_date: assessmentDate(preview.observation_period.start_date), end_date: assessmentDate(preview.observation_period.end_date) };
  check(period.start_date <= period.end_date, 'invalid_period');
  const unavailable = object(preview.unavailable_metrics);
  check(Object.keys(unavailable).length === UNAVAILABLE.length && UNAVAILABLE.every(key => Object.hasOwn(unavailable, key)), 'unsupported_metrics');
  return { presentation_version: 1, preview_version: 1, status: 'observations_only', binding,
    effective_date: assessmentDate(preview.effective_date), observation_period: period, captured_at: text(preview.captured_at, 64),
    authority: 'not_established', provider_coverage: 'not_established', historical_applicability: 'not_established',
    metric_readiness: 'descriptive_calculation_only_not_report_readiness',
    support_gaps: strings(preview.support_gaps), unavailable_metrics: Object.fromEntries(UNAVAILABLE.map(key => [key, text(unavailable[key])])),
    apply: { status: 'blocked', reasons: strings(preview.apply.reasons) } };
}
function distribution(metric, denominator) {
  object(metric);
  const counters = Object.fromEntries(COUNT_FIELDS.map(key => [key, count(metric[key])]));
  check(counters.member_count === denominator && counters.count + counters.missing_count === denominator
    && counters.conflicting_count + counters.invalid_count + counters.absent_count === counters.missing_count
    && counters.partially_observed_count <= counters.count, 'denominator_mismatch');
  const numbers = Object.fromEntries(NUMBER_FIELDS.map(key => [key, finite(metric[key])]));
  check(numbers.coverage_percent === null || (numbers.coverage_percent >= 0 && numbers.coverage_percent <= 100), 'invalid_coverage');
  const unit = maybeText(metric.unit);
  check(metric.currency === null && metric.interpretation === 'captured_observations_only'
    && metric.denominator_basis === 'population_members' && metric.cod_interpretation === 'descriptive_dispersion_not_reliability', 'unsupported_semantics');
  return { label: text(metric.label), unit, currency: null, interpretation: metric.interpretation,
    denominator_basis: metric.denominator_basis, state: oneOf(metric.state, ['ready', 'insufficient', 'incomplete']),
    reason: maybeText(metric.reason), numeric_issues: strings(metric.numeric_issues), estimator: text(metric.estimator),
    ...counters, ...numbers, cod_interpretation: metric.cod_interpretation,
    display: Object.fromEntries(NUMBER_FIELDS.map(key => [key, displayed(numbers[key], unit, key)])) };
}
function memberArray(population, kind) {
  return array(kind === 'omitted_transactions' ? population.transactions.omitted : population[kind].members);
}
function descriptor(group, kind, pocket_id) { return { group, ...(group === 'pocket' ? { pocket_id } : {}), kind }; }
function summaryPopulation(population, group, pocket_id) {
  object(population);
  const result = { id: text(population.id), account_count: count(array(population.account_ids, 50000).length) };
  for (const kind of ['stock', 'transactions', 'source_reported']) {
    const p = object(population[kind]), members = memberArray(population, kind), n = count(p.member_count);
    check(members.length === n, 'member_count_mismatch'); exactMetricKeys(p.metrics, METRICS[kind]);
    const base = { definition: text(p.definition), member_unit: text(p.member_unit), member_count: n,
      inspection: { population: descriptor(group, kind, pocket_id), total_count: n, maximum_page_size: L.page_members },
      metrics: Object.fromEntries(METRICS[kind].map(key => [key, distribution(p.metrics[key], n)])) };
    if (kind === 'stock') Object.assign(base, { unique_account_count: count(p.unique_account_count), parcel_object_count: count(p.parcel_object_count),
      temporal_basis: text(p.temporal_basis), assessment_tax_year: maybeCount(p.assessment_tax_year), housing_eligible_count: maybeCount(p.housing_eligible_count) });
    if (kind === 'source_reported') Object.assign(base, { temporal_basis: text(p.temporal_basis), without_canonical_transaction_count: count(p.without_canonical_transaction_count) });
    if (kind === 'transactions') Object.assign(base, {
      observation_period: { start_date: assessmentDate(p.observation_period.start_date), end_date: assessmentDate(p.observation_period.end_date), date_basis: text(p.observation_period.date_basis) },
      unique_associated_account_count: count(p.unique_associated_account_count), unique_selected_associated_account_count: count(p.unique_selected_associated_account_count),
      package_evidence_transaction_count: count(p.package_evidence_transaction_count), market_eligible_count: maybeCount(p.market_eligible_count),
      omitted_count: memberArray(population, 'omitted_transactions').length,
      omitted_inspection: { population: descriptor(group, 'omitted_transactions', pocket_id),
        total_count: p.omitted.length, maximum_page_size: L.page_members } });
    result[kind] = base;
  }
  return result;
}
function boundedResult(value, maximum) {
  check(Buffer.byteLength(JSON.stringify(value)) <= maximum, 'output_bytes_limit'); return freeze(value);
}

/** Browser-shaped data, not HTML or authority. Call only after exact authorized
 * retained loading/numeric computation, and retain the owner's final access and
 * material fences. Projection is by explicit field, never object spread of raw
 * members, snapshots, provider keys or authorization envelopes.
 */
export function presentCustomCohortPreview({ preview, expected } = {}) {
  const binding = bindingOf(preview, expected);
  const all = summaryPopulation(preview.all, 'all'), selected = summaryPopulation(preview.selected, 'selected');
  const pockets = [...preview.pockets].sort((a, b) => compare(a.id, b.id)).map(pocket => ({
    id: text(pocket.id), label: text(pocket.label), disposition: oneOf(pocket.disposition, ['needs_review']),
    overlap_account_count: count(pocket.overlap_account_count), result: summaryPopulation(pocket.result, 'pocket', pocket.id),
  }));
  return boundedResult({ ...header(preview, binding), contents: 'population_summaries_only', members_included: false,
    all, selected, pockets }, L.summary_utf8_bytes);
}

function findPopulation(preview, requested) {
  object(requested);
  const group = oneOf(requested.group, ['all', 'selected', 'pocket']);
  const kind = oneOf(requested.kind, ['stock', 'transactions', 'omitted_transactions', 'source_reported']);
  check(Object.keys(requested).length === (group === 'pocket' ? 3 : 2), 'invalid_population');
  if (group !== 'pocket') return { population: preview[group], key: descriptor(group, kind), kind };
  const id = text(requested.pocket_id, L.identity_utf8_bytes), pocket = preview.pockets.find(p => p.id === id);
  check(pocket, 'population_not_found');
  return { population: pocket.result, key: descriptor(group, kind, id), kind };
}
function observation(cell, metric) {
  object(cell);
  const state = oneOf(cell.state, ['observed', 'missing', 'conflicting', 'invalid']), value = finite(cell.value);
  check((state === 'observed') === (value !== null), 'observation_state_mismatch');
  const exact_value = cell.exact_value === null ? null : text(cell.exact_value, 128);
  check(state === 'observed' ? exact_value !== null && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(exact_value) : exact_value === null, 'invalid_exact_value');
  return { state, value, exact_value, display_value: displayed(value, metric.unit, 'value'), label: text(metric.label), unit: maybeText(metric.unit), currency: null,
    observed_record_count: count(cell.observed_record_count), missing_record_count: count(cell.missing_record_count), invalid_record_count: count(cell.invalid_record_count) };
}
function inspectMember(row, id, kind, population) {
  object(row);
  const result = { member_id: id, provenance: { status: 'retained_references_not_verification',
    reference_count: array(row.source_references).length }, temporal_support: 'not_established' };
  if (kind === 'stock') {
    // Public cadastral identity is useful for a map link; only this bounded
    // page exposes it. Private source/listing/canonical IDs never leave here.
    result.account_id = text(row.account_id, 400); result.parcel_object_count = array(row.parcel_object_ids).length;
  } else {
    result.associated_account_count = array(row.associated_account_ids).length;
    result.has_source_disagreement = array(row.capability_gaps, 64).some(value => typeof value === 'string' && value.endsWith('_conflict'));
    if (kind === 'source_reported') result.canonical_transaction_count = array(row.canonical_transaction_ids).length;
    else Object.assign(result, { sale_date: row.sale_date === null ? null : assessmentDate(row.sale_date),
      disposition: oneOf(row.disposition, ['in_period', 'outside_period', 'missing_date', 'conflicting_date']),
      multiple_parcel_evidence: oneOf(row.multiple_parcel_evidence, [true, false]), unresolved_link_count: count(row.unresolved_link_count),
      membership_complete: oneOf(row.membership_complete, [null]), market_eligible: oneOf(row.market_eligible, [null]),
      amount_semantics: 'stored_canonical_total_not_verified_property_price_or_consideration' });
  }
  const metricKind = kind === 'omitted_transactions' ? 'transactions' : kind;
  exactMetricKeys(population[metricKind].metrics, METRICS[metricKind]);
  result.observations = Object.fromEntries(METRICS[metricKind].map(key => [key,
    observation(metricKind === 'transactions' ? row.recorded_total_price : row.observations[key], population[metricKind].metrics[key])]));
  return result;
}

/** Opaque deterministic member IDs double as cursors. Every ID binds context,
 * selection content/revision, population and the ordered safe member projection.
 * Unknown cursors fail; they never silently start another page or population.
 */
export function inspectCustomCohortPreviewMembers({ preview, expected, population: requested, page } = {}) {
  const binding = bindingOf(preview, expected), resolved = findPopulation(preview, requested);
  object(page); check(Object.keys(page).length === 2 && Object.hasOwn(page, 'limit') && Object.hasOwn(page, 'after_member_id'), 'invalid_page');
  check(Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= L.page_members, 'page_limit');
  check(page.after_member_id === null || (typeof page.after_member_id === 'string' && /^member:[a-f0-9]{64}$/.test(page.after_member_id)), 'invalid_cursor');
  const rows = memberArray(resolved.population, resolved.kind), metricKind = resolved.kind === 'omitted_transactions' ? 'transactions' : resolved.kind;
  if (resolved.kind !== 'omitted_transactions') check(count(resolved.population[metricKind].member_count) === rows.length, 'member_count_mismatch');
  const identityKey = resolved.kind === 'stock' ? 'account_id' : resolved.kind === 'source_reported' ? 'source_record_id' : 'canonical_transaction_id';
  const ordered = rows.map(row => ({ key: text(row[identityKey], 400), row })).sort((a, b) => compare(a.key, b.key));
  check(new Set(ordered.map(row => row.key)).size === ordered.length, 'duplicate_member');
  const membership = createHash('sha256');
  // Original private IDs determine stable ordering internally, but do not enter
  // a browser-visible hash preimage: low-entropy sequential IDs are enumerable.
  // The retained context binds original evidence; this digest binds only the
  // ordered safe view. A change of visible values/counts also invalidates cursors.
  for (const entry of ordered) membership.update(JSON.stringify(inspectMember(entry.row, null, resolved.kind, resolved.population))).update('\n');
  const population_id = `population:${hash(JSON.stringify({ binding, population: resolved.key, member_count: rows.length, membership_sha256: membership.digest('hex') }))}`;
  let start = 0;
  const ids = ordered.map((_, member_index) => `member:${hash(JSON.stringify({ population_id, member_index }))}`);
  if (page.after_member_id !== null) {
    const previous = ids.indexOf(page.after_member_id); check(previous !== -1, 'cursor_mismatch'); start = previous + 1;
  }
  const end = Math.min(start + page.limit, rows.length), has_more = end < rows.length;
  const members = ordered.slice(start, end).map((entry, index) => inspectMember(entry.row, ids[start + index], resolved.kind, resolved.population));
  return boundedResult({ ...header(preview, binding), contents: 'member_page', population: resolved.key, population_id,
    member_unit: resolved.population[metricKind].member_unit, total_count: rows.length, returned_count: members.length,
    start_index: start, end_index_exclusive: end, is_full_population: start === 0 && end === rows.length,
    has_more, next_after_member_id: has_more ? ids[end - 1] : null, members }, L.page_utf8_bytes);
}
