import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { isCustomCohortObservationPreview, customCohortObservationMembers } from './customCohortObservationPreview.js';
import { customCohortCatalogGroupLimit } from './customCohortPocketCatalog.js';
import { CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES, CUSTOM_COHORT_RECORDED_HOUSING_STATES,
  CUSTOM_COHORT_RECORDED_HOUSING_BASIS, getCustomCohortRecordedHousingProfile } from './customCohortRecordedHousing.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_STOCK_COMPOSITION_LIMITS = Object.freeze({ accounts: 50_000, groups: 1025,
  output_utf8_bytes: 256_000 });
const L = CUSTOM_COHORT_STOCK_COMPOSITION_LIMITS;
const FIELDS = ['gla_sqft', 'year_built', 'site_area_sqft'];
const STATES = ['observed', 'partial', 'missing', 'invalid', 'conflicting'];
const SUBJECT_FIELDS = ['gla', 'age', 'site_size'];
const SUBJECT_STATES = ['observed', 'missing', 'invalid', 'conflicting', 'json_null', 'ambiguous_rows'];
const ORIGINS = ['saved_subject', 'retained_subject_public', 'current_subject_cad'];
const HS = CUSTOM_COHORT_RECORDED_HOUSING_STATES, HC = CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES;
const UNASSIGNED = 'discovery:unassigned';
const GROUP_REASONS = ['not_in_discovery', 'unassigned', 'conflicting_evidence', 'invalid_evidence'];
const DEFINITION = freeze({ id: 'custom-current-stock-composition-v1', revision: 1,
  basis: 'within_context_binned_current_stock_observations', authority: 'not_established',
  limits: L,
  numeric_fields: FIELDS, numeric_units: ['ft2', 'year', 'ft2'], numeric_states: STATES,
  numeric_count_shape: ['state_counts', 'bin_counts'], housing_count_shape: ['state_counts', 'category_counts'],
  population_shape: ['member_count', 'numeric_counts', 'housing_counts'],
  pocket_shape: ['original_pocket_id', 'member_count', 'numeric_counts', 'housing_counts'],
  subject_numeric_shape: ['state', 'value', 'origin'], subject_housing_shape: ['state', 'category', 'origin'],
  subject_numeric_states: SUBJECT_STATES, subject_origins: ORIGINS,
  housing_states: [...HS], housing_categories: [...HC],
  housing_profiles: [getCustomCohortRecordedHousingProfile(4), getCustomCohortRecordedHousingProfile(5)],
  denominator: 'every_unique_account_once_in_exact_original_leaf_partition_including_nonempty_unassigned',
  numeric_values: 'existing_preview_number_values_only;existing_decimal_conflicts_remain_conflicting',
  partial: 'observed_cell_with_missing_record_count_above_zero;included_in_bins_and_separate_partial_state',
  binning: { method: 'type_7', fractions: [0.25, 0.5, 0.75],
    reference: 'all_observed_and_partial_unique_accounts_in_same_context',
    interpolation: 'sorted[lower]*(1-fractional_position)+sorted[upper]*fractional_position',
    intervals: ['(-infinity,q1)', '[q1,q2)', '[q2,q3)', '[q3,infinity)'],
    equality: 'ties_go_right;repeated_cuts_retained;zero_width_bins_remain_empty',
    empty: 'null_cuts_and_four_zero_counts',
    comparison: 'within_exact_context_only;bin_equality_is_not_full_distribution_equality' },
  subject: 'copy_existing_resolved_recommendation_observations;no_new_fallback_or_numeric_origin_inference',
  reference: 'exact_catalog_assigned_subject_leaf_only;frontend_may_union_its_explicit_review_family_leaf_ids',
  limitations: ['descriptive_composition_not_calibrated_reliability', 'not_sales_sample_representativeness',
    'provider_and_historical_population_coverage_not_established', 'missing_states_are_not_imputed',
    'no_legal_subdivision_identity_or_name_family_inferred', 'no_similarity_weight_score_or_selection_change'],
});
export const CUSTOM_COHORT_STOCK_COMPOSITION_PROFILE = freeze({ id: DEFINITION.id, revision: DEFINITION.revision,
  content_sha256: createHash('sha256').update(json(DEFINITION)).digest('hex') });
const COUNTY_DEFINITION = freeze({ ...DEFINITION, id: 'custom-current-stock-composition-v2', revision: 2,
  housing_profiles: [getCustomCohortRecordedHousingProfile(4, 2), getCustomCohortRecordedHousingProfile(5, 2)] });
export const CUSTOM_COHORT_COUNTY_STOCK_COMPOSITION_PROFILE = freeze({ id: COUNTY_DEFINITION.id, revision: COUNTY_DEFINITION.revision,
  content_sha256: createHash('sha256').update(json(COUNTY_DEFINITION)).digest('hex') });
export function getCustomCohortStockCompositionDefinition(version = 1) {
  check(version === 1 || version === 2, 'composition_version');
  return version === 1 ? DEFINITION : COUNTY_DEFINITION;
}
export function getCustomCohortStockCompositionProfile(version = 1) {
  check(version === 1 || version === 2, 'composition_version');
  return version === 1 ? CUSTOM_COHORT_STOCK_COMPOSITION_PROFILE : CUSTOM_COHORT_COUNTY_STOCK_COMPOSITION_PROFILE;
}
const issued = new WeakSet();
function issue(value) { freeze(value); issued.add(value); return value; }
/** Identity-only request-local derivation proof, not retained evidence or rights.
 * A copy/reopen must be rebuilt from checked inputs; no public receipt mint. */
export function readCustomCohortStockComposition(value, expected) {
  check(issued.has(value), 'unissued_composition');
  check(same(value.binding.context_ref, context(get(expected, 'context_ref')))
    && value.binding.captured_at === get(expected, 'captured_at'), 'binding');
  return value;
}

function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_stock_composition_${reason}`), {
    code: 'CUSTOM_COHORT_STOCK_COMPOSITION_INVALID', reason,
  });
}
function object(value) {
  check(value && typeof value === 'object' && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'plain_object');
  return value;
}
function get(value, key, optional = false) {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
  check(optional && !descriptor || descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'data_property');
  return descriptor?.value;
}
function list(value, maximum) {
  check(Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum, 'input_limit');
  check(Reflect.ownKeys(value).length === value.length + 1, 'array_shape');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    check(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'), 'data_property');
  }
  return value;
}
function count(value) { check(Number.isSafeInteger(value) && value >= 0, 'count'); return value; }
function id(value, maximum = 100) {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value), 'identity'); return value;
}
function context(value) {
  const result = Object.fromEntries(['context_id', 'context_revision', 'context_sha256'].map(key => {
    const scalar = get(value, key); check(typeof scalar === 'string', 'binding'); return [key, scalar];
  }));
  return prepareCustomCohortContextReference(json(result));
}
const same = (a, b) => json(a) === json(b);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const zeros = n => Array(n).fill(0);
const population = () => [0, FIELDS.map(() => [zeros(STATES.length), zeros(4)]), [zeros(HS.length), zeros(HC.length)]];
function add(target, source) {
  target[0] += source[0];
  for (let field = 0; field < FIELDS.length; field++) for (let part = 0; part < 2; part++) {
    source[1][field][part].forEach((n, index) => { target[1][field][part][index] += n; });
  }
  for (let part = 0; part < 2; part++) source[2][part].forEach((n, index) => { target[2][part][index] += n; });
}
function numericCell(cell, index) {
  const state = get(cell, 'state'), value = get(cell, 'value');
  const missing = count(get(cell, 'missing_record_count')), invalid = count(get(cell, 'invalid_record_count'));
  const observed = count(get(cell, 'observed_record_count'));
  check(['observed', 'missing', 'invalid', 'conflicting'].includes(state), 'numeric_state');
  if (state === 'observed') {
    check(Number.isFinite(value) && observed > 0 && invalid === 0, 'numeric_value');
    check(index === 0 ? value > 0 : index === 1 ? Number.isSafeInteger(value) && value >= 1600 && value <= 9999
      : value >= 0, 'numeric_value');
    return [missing > 0 ? 1 : 0, value];
  }
  check(value === null, 'numeric_value');
  check(state !== 'missing' || observed === 0 && invalid === 0, 'numeric_state');
  check(state !== 'invalid' || invalid > 0, 'numeric_state');
  check(state !== 'conflicting' || observed > 1, 'numeric_state');
  return [STATES.indexOf(state), null];
}
function housingCell(row, subject = false) {
  const state = get(row, 'state'), category = get(row, 'category'), origin = get(row, 'origin');
  check(HS.includes(state) && (state === 'observed' ? HC.includes(category) : category === null), 'housing_state');
  check(subject ? ORIGINS.includes(origin) : origin === 'retained_current_cad', 'housing_origin');
  return [state, category, origin];
}
function quartiles(values) {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return DEFINITION.binning.fractions.map(fraction => {
    const position = (values.length - 1) * fraction, lower = Math.floor(position), upper = Math.ceil(position);
    const value = values[lower] * (1 - (position - lower)) + values[upper] * (position - lower);
    check(Number.isFinite(value), 'numeric_calculation'); return value;
  });
}

/** Pure, optional sidecar AFTER the owner's existing retained validation and
 * subject resolution. Inputs are the existing preview, internal full catalog,
 * recommendation.subject and full recordedHousing result, never raw sources.
 * It does not mint authority or re-resolve missing subject fields. Its counts
 * describe captured current stock, not sales eligibility or empirical reliability.
 * A caller may omit this whole sidecar when its remaining presentation budget
 * cannot fit it; never omit any existing recommendation to make room for it.
 */
export function buildCustomCohortStockComposition(args = {}) {
  const batches = customCohortStockCompositionBatches(args);
  let step = batches.next();
  while (!step.done) step = batches.next();
  return step.value;
}

/** The same kernel for yield* inside an existing owner-budgeted generator.
 * Yields contain no result; identity is issued only on final completion. No
 * independent scheduler, source reads, deadline, cache or background work. */
export function* customCohortStockCompositionBatches(args = {}) {
  const preview = get(args, 'preview'), catalog = get(args, 'catalog');
  object(preview); object(catalog);
  // Guard the legacy resolver's few direct representation-property accesses
  // before using it. Do not traverse unrelated private preview/source payloads.
  const previewVersion = get(preview, 'preview_version');
  if (previewVersion === 2) get(preview, 'representation');
  if (previewVersion === 1) {
    get(preview, 'selected');
    for (const pocket of list(get(preview, 'pockets'), 128)) get(pocket, 'result');
  }
  check(isCustomCohortObservationPreview(preview) && get(preview, 'status') === 'observations_only'
    && get(preview, 'authority') === 'not_established' && get(get(preview, 'apply'), 'status') === 'blocked', 'preview');
  const binding = { context_ref: context(get(preview, 'context_ref')), captured_at: get(preview, 'captured_at') };
  check(typeof binding.captured_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(binding.captured_at)
    && Number.isFinite(Date.parse(binding.captured_at)) && new Date(binding.captured_at).toISOString() === binding.captured_at, 'captured_at');
  const cb = get(catalog, 'binding');
  check(count(get(preview, 'selection_revision')) > 0, 'binding');
  check(same(context(get(cb, 'context_ref')), binding.context_ref)
    && get(cb, 'selection_revision') === get(preview, 'selection_revision'), 'binding');
  check(get(catalog, 'authority') === 'not_established' && get(get(catalog, 'apply'), 'status') === 'blocked', 'catalog');
  const maximum = get(args, 'maximumBytes', true) ?? L.output_utf8_bytes;
  check(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= L.output_utf8_bytes, 'byte_limit');
  const version = Object.hasOwn(args, 'composition_version') ? get(args, 'composition_version') : 1;
  check(version === 1 || version === 2, 'composition_version');
  const definition = getCustomCohortStockCompositionDefinition(version);
  const header = { composition_version: version, profile: getCustomCohortStockCompositionProfile(version), binding };
  // Unavailable is a diagnostic envelope, not a payload promised to fit a zero
  // remaining transport budget. The composing owner can omit that envelope too.
  const unavailable = reason => issue({ ...header, status: 'unavailable', reason });
  const complete = get(catalog, 'catalog_complete'); check(typeof complete === 'boolean', 'catalog');
  if (!complete) return unavailable('catalog_incomplete');
  const groupLimit = customCohortCatalogGroupLimit(get(catalog, 'catalog_version')) + 1;
  const all = get(preview, 'all'), stock = get(all, 'stock'), n = count(get(stock, 'member_count'));
  if (n > L.accounts) return unavailable('account_limit');
  const housing = get(args, 'housing');
  if (housing === null) return unavailable('housing_interpretation_unavailable');
  const mapping = get(housing, 'mapping_version');
  check([4, 5].includes(mapping) && get(housing, 'housing_version') === version
    && get(housing, 'basis') === CUSTOM_COHORT_RECORDED_HOUSING_BASIS
    && get(housing, 'authority') === 'not_established', 'housing');
  const hp = get(housing, 'profile');
  const expectedHousingProfile = getCustomCohortRecordedHousingProfile(mapping, version);
  check(['id', 'revision', 'content_sha256'].every(key => get(hp, key) === expectedHousingProfile[key]), 'housing_profile');
  const hb = get(housing, 'binding');
  check(same(context(get(hb, 'context_ref')), binding.context_ref) && get(hb, 'captured_at') === binding.captured_at, 'housing_binding');
  for (let i = 0; i < FIELDS.length; i++) {
    const metric = get(get(stock, 'metrics'), FIELDS[i]);
    check(get(metric, 'unit') === DEFINITION.numeric_units[i] && get(metric, 'interpretation') === 'captured_observations_only', 'numeric_units');
  }
  if (previewVersion === 1) check(!isProxy(get(stock, 'members')), 'input_limit');
  const members = list(customCohortObservationMembers(preview, all, 'stock'), L.accounts);
  check(members.length === n && get(stock, 'unique_account_count') === n, 'stock_roster');
  const roster = new Map(), values = FIELDS.map(() => []); let work = 0;
  for (const member of members) {
    if (work++ % 250 === 0) yield;
    const account = id(get(member, 'account_id')); check(!roster.has(account), 'duplicate_account');
    const observations = get(member, 'observations');
    const cells = FIELDS.map((field, index) => {
      const cell = numericCell(get(observations, field), index);
      if (cell[1] !== null) values[index].push(cell[1]);
      return cell;
    });
    roster.set(account, { cells, housing: null, group: null });
  }
  const ids = list(get(all, 'account_ids'), L.accounts);
  check(ids.length === n && new Set(ids).size === n && ids.every(account => roster.has(account)), 'stock_roster');
  const rawGroups = get(catalog, 'pockets');
  check(Array.isArray(rawGroups) && !isProxy(rawGroups), 'input_limit');
  // The composition profile's own 1025-group ceiling is unchanged by catalog
  // v3. Return its bounded diagnostic before the profile-limited array reader.
  if (rawGroups.length > groupLimit - 1 || rawGroups.length > L.groups) return unavailable('group_limit');
  const groups = list(rawGroups, L.groups).map(group => ({
    id: id(get(group, 'id')), ids: list(get(group, 'account_ids'), L.accounts), n: count(get(group, 'member_count')),
  }));
  const unassigned = get(catalog, 'unassigned'), unassignedIds = list(get(unassigned, 'account_ids'), L.accounts);
  check(count(get(unassigned, 'member_count')) === unassignedIds.length, 'catalog_roster');
  if (unassignedIds.length) groups.push({ id: UNASSIGNED, ids: unassignedIds, n: unassignedIds.length });
  if (groups.length > groupLimit || groups.length > L.groups) return unavailable('group_limit');
  const groupIds = new Set(); let memberships = 0;
  for (const group of groups) {
    if (work++ % 250 === 0) yield;
    check(!groupIds.has(group.id) && group.ids.length === group.n, 'catalog_groups'); groupIds.add(group.id);
    for (const account of group.ids) {
      if (work++ % 250 === 0) yield;
      const row = roster.get(account);
      check(row && row.group === null, 'catalog_partition'); row.group = group.id; memberships++;
    }
  }
  check(memberships === n && get(get(catalog, 'coverage'), 'stock_member_count') === n
    && get(get(catalog, 'coverage'), 'discovery_member_count') === n, 'catalog_partition');
  const housingRows = list(get(housing, 'accounts'), L.accounts), housingTotals = zeros(HS.length);
  check(housingRows.length === n, 'housing_roster');
  for (const row of housingRows) {
    if (work++ % 250 === 0) yield;
    const entry = roster.get(id(get(row, 'account_id')));
    check(entry && entry.housing === null, 'housing_roster');
    entry.housing = housingCell(row); housingTotals[HS.indexOf(entry.housing[0])]++;
  }
  const coverage = get(housing, 'coverage');
  check(get(coverage, 'account_count') === n && get(coverage, 'observed_count') === housingTotals[0]
    && get(coverage, 'unknown_count') === n - housingTotals[0]
    && HS.every((state, i) => get(get(coverage, 'states'), state) === housingTotals[i]), 'housing_coverage');
  const subject = get(args, 'subject'), account = id(get(subject, 'account_id'));
  const membership = get(catalog, 'subject_membership');
  check(account === get(get(preview, 'target'), 'account_id') && get(membership, 'account_id') === account
    && get(subject, 'in_discovery') === roster.has(account), 'subject_binding');
  const groupId = get(membership, 'assigned_pocket_id'), groupStatus = get(membership, 'status');
  check(get(membership, 'recorded_label_match_only') === true
    && (groupId === null ? GROUP_REASONS.includes(groupStatus) : groupStatus === 'recorded_label_matched'
      && groupId !== UNASSIGNED && roster.get(account)?.group === groupId), 'subject_group');
  check(groupStatus === 'not_in_discovery' ? !roster.has(account) : roster.has(account), 'subject_group');
  if (groupId === null && roster.has(account)) check(roster.get(account).group === UNASSIGNED, 'subject_group');
  const subjectMembership = get(subject, 'membership');
  check(['account_id', 'assigned_pocket_id', 'recorded_label_match_only', 'status']
    .every(key => get(subjectMembership, key) === get(membership, key)), 'subject_group');
  check(same(list(get(subject, 'recorded_group_review_ids'), 1), groupId === null ? [] : [groupId]), 'subject_group');
  const subjectNumeric = SUBJECT_FIELDS.map(key => {
    const cell = get(get(subject, 'observations'), key), state = get(cell, 'state'), value = get(cell, 'value'), origin = get(cell, 'origin');
    check(SUBJECT_STATES.includes(state) && ORIGINS.includes(origin)
      && (state === 'observed' ? Number.isFinite(value) : value === null), 'subject_numeric');
    return [state, value, origin];
  });
  const cuts = [], total = population(), pockets = [];
  for (const fieldValues of values) { yield; cuts.push(quartiles(fieldValues)); }
  yield;
  for (const group of groups.sort((a, b) => compare(a.id, b.id))) {
    if (work++ % 250 === 0) yield;
    const result = population(); result[0] = group.n;
    for (const accountId of group.ids) {
      if (work++ % 250 === 0) yield;
      const row = roster.get(accountId);
      row.cells.forEach(([state, value], index) => {
        result[1][index][0][state]++;
        if (value !== null) {
          let bin = 0; while (bin < 3 && value >= cuts[index][bin]) bin++;
          result[1][index][1][bin]++;
        }
      });
      result[2][0][HS.indexOf(row.housing[0])]++;
      if (row.housing[1] !== null) result[2][1][HC.indexOf(row.housing[1])]++;
    }
    add(total, result); pockets.push([group.id, ...result]);
  }
  const result = { ...header, status: 'available', reason: null, mapping_version: mapping,
    housing_profile: expectedHousingProfile, definition, bin_cuts: cuts,
    subject: { numeric: subjectNumeric, housing: housingCell(get(housing, 'subject'), true),
      recorded_group_id: groupId, group_reason: groupId === null ? groupStatus : null }, all: total, pockets };
  if (Buffer.byteLength(JSON.stringify(result)) > maximum) return unavailable('output_byte_limit');
  return issue(result);
}
