import { customCohortObservationMappingVersion, customCohortObservationProjectionMatches } from './customCohortObservationMapping.js';

export const CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITS = Object.freeze({
  accounts: 50000, source_records: 100000, source_chunks: 1000, groups: 129,
  literal_utf8_bytes: 4096, input_literal_utf8_bytes: 32000000, membership_work: 2000000,
  distribution_literals: 64, distribution_utf8_bytes: 65536, output_utf8_bytes: 8000000,
});
export const CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS = Object.freeze({
  class_code: 'Recorded CAD class code', class_description: 'Recorded CAD class description',
  use_description: 'Recorded CAD use description', structure_type: 'Recorded CAD structure description',
  built_up: 'Local CAD built-up indicator; not house completion',
});
export const CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITATIONS = Object.freeze([
  'recorded_literals_not_a_housing_type_dictionary', 'one_unit_does_not_establish_detached_housing',
  'built_up_is_a_local_indicator_not_completed_home_evidence', 'literal_match_not_housing_similarity_or_eligibility',
  'source_clock_not_historical_validity', 'all_accounts_retained_in_denominators',
  'distributions_count_accounts_per_literal_and_can_overlap', 'no_score_rank_selection_or_report_fact_changes',
]);
const L = CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITS, FIELDS = Object.keys(CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_current_cad_baseline_${reason}`), {
    code: 'CUSTOM_COHORT_CURRENT_CAD_BASELINE_INVALID', reason,
  });
}
function list(value, maximum) { check(Array.isArray(value) && value.length <= maximum, 'input_limit'); return value; }
function account(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value), 'account_identity'); return value;
}
const cell = () => ({ record_count: 0, missing_record_count: 0, literals: new Set(), known: new Set() });
function state(value) {
  return value.known.size > 1 ? 'conflicting' : value.known.size === 0 ? 'missing'
    : value.missing_record_count ? 'partial' : 'observed';
}

/** Called by the existing recommendation kernel, AFTER owner admission and its
 * actual observation preview/catalog. This is neither another retained-graph
 * verifier nor a source/housing/temporal authority. No numeric cells, scores,
 * weights, rankings, eligibility, selection or report facts are recalculated.
 */
export function buildCustomCohortCurrentCadBaseline({ retained_inputs: input, preview, groups } = {}) {
  const mapping = customCohortObservationMappingVersion(input?.acquisition);
  if (mapping !== 4) return null;
  const capture = input.acquisition.capture_result?.source_capture;
  check(capture?.status === 'ready' && input.acquisition.capture_result.query_complete === true
    && preview?.preview_version === 1 && preview.status === 'observations_only'
    && preview.authority === 'not_established' && preview.apply?.status === 'blocked', 'observation_preview_required');
  check(preview.captured_at === input.acquisition.capture_result.captured_at
    && preview.effective_date === input.subject.effective_date, 'preview_capture_mismatch');
  for (const key of ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'appraisal_case_id', 'subject_snapshot_id']) {
    check(input.subject.target[key] === preview.target?.[key], 'target_mismatch');
  }
  const identities = snapshots => list(snapshots, L.source_chunks).map(row => `${row.id}\n${row.content_sha256}`).sort(compare);
  check(JSON.stringify(identities(capture.source_snapshots)) === JSON.stringify(identities(preview.source_snapshots)), 'preview_capture_mismatch');
  const roster = list(preview.all?.stock?.members, L.accounts).map(row => account(row.account_id));
  check(new Set(roster).size === roster.length && preview.all.stock.member_count === roster.length
    && JSON.stringify([...roster].sort(compare)) === JSON.stringify([...list(input.spatial.account_ids, L.accounts)].sort(compare)), 'stock_roster_mismatch');
  const members = new Map(roster.map(id => [id, { county: cell(), fields: Object.fromEntries(FIELDS.map(field => [field, cell()])) }]));
  const partition = new Set(), groupIds = new Set();
  const orderedGroups = list(groups, L.groups).map(group => {
    check(typeof group.id === 'string' && group.id.length > 0 && group.id.length <= 200 && !groupIds.has(group.id), 'group_identity');
    groupIds.add(group.id);
    const ids = list(group.account_ids, L.accounts).map(account);
    for (const id of ids) { check(members.has(id) && !partition.has(id), 'group_partition'); partition.add(id); }
    return { id: group.id, account_ids: ids };
  }).sort((a, b) => compare(a.id, b.id));
  check(partition.size === roster.length, 'group_partition');
  let literalBytes = 0, work = 0, records = 0;
  const meter = (amount = 1) => { work += amount; check(work <= L.membership_work, 'membership_work_limit'); };
  // Intern exact typed literals once. Account sets prevent duplicate parcel rows
  // from inflating a literal's account count. Null/blank remain visible literals
  // in distributions but are missing observations, never false/zero defaults.
  const literals = [], literalKeys = [], interned = new Map();
  function add(target, value, field) {
    meter();
    check(value === null || (field === 'built_up' ? typeof value === 'boolean' : typeof value === 'string'), 'literal_type');
    if (typeof value === 'string') {
      check(value.length <= L.literal_utf8_bytes && value.isWellFormed() && !value.includes('\0'), 'literal_text');
      const size = Buffer.byteLength(value); check(size <= L.literal_utf8_bytes, 'literal_text');
      literalBytes += size; check(literalBytes <= L.input_literal_utf8_bytes, 'input_literal_byte_limit');
    }
    const key = JSON.stringify(value);
    let id = interned.get(key);
    if (id === undefined) { id = literals.length; interned.set(key, id); literalKeys.push(key); literals.push(value); }
    target.record_count++; target.literals.add(id);
    if (value === null || (typeof value === 'string' && value.trim() === '')) target.missing_record_count++;
    else target.known.add(id);
  }
  const roles = new Set(), seen = new Set();
  for (const source of list(capture.sources, L.source_chunks)) {
    const definition = source.payload?.projection?.definition, role = definition?.role;
    check(customCohortObservationProjectionMatches(definition, 4), 'mapping_profile_mismatch');
    if (!['accounts', 'parcels'].includes(role)) continue;
    roles.add(role);
    for (const record of list(source.payload.records, L.source_records)) {
      check(++records <= L.source_records, 'source_record_limit');
      const key = `${role}\n${record.record_id}`;
      check(!seen.has(key), 'duplicate_source_record'); seen.add(key);
      const mapped = record.data, raw = mapped?.raw_projection, normalized = mapped?.data;
      check(normalized?.cached_mapping_version === 4 && raw
        && normalized.cached_projection_kind === (role === 'accounts' ? 'account' : 'parcel'), 'mapping_v4_required');
      const id = account(normalized.account_id); check(raw.account_id === id && members.has(id), 'cad_account_scope');
      const target = members.get(id);
      if (role === 'accounts') add(target.county, raw.county ?? null, 'county');
      else for (const field of FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, field);
        check(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'cad_field_required');
        add(target.fields[field], descriptor.value, field);
      }
    }
  }
  check(roles.size === 2, 'cad_source_roles_missing');
  const subject = members.get(input.subject.target.account_id), subjectCounty = subject?.county ?? cell();
  const subjectFields = Object.fromEntries(FIELDS.map(field => [field, subject?.fields[field] ?? cell()]));
  const literalOf = value => value.known.size === 1 ? literals[value.known.values().next().value] : null;
  function summary(ids) {
    return { member_count: ids.length, fields: Object.fromEntries(FIELDS.map(field => {
      const result = { label: CUSTOM_COHORT_CURRENT_CAD_BASELINE_FIELDS[field], observed_count: 0, partial_count: 0,
        missing_count: 0, conflicting_count: 0, record_count: 0, observed_record_count: 0, missing_record_count: 0 };
      const frequencies = new Map(), comparisons = { same_literal_count: 0, different_literal_count: 0, unavailable_count: 0 };
      const subjectField = subjectFields[field];
      for (const id of ids) {
        meter();
        const row = members.get(id), fieldCell = row.fields[field], fieldState = state(fieldCell);
        result[`${fieldState}_count`]++; result.record_count += fieldCell.record_count;
        result.missing_record_count += fieldCell.missing_record_count;
        result.observed_record_count += fieldCell.record_count - fieldCell.missing_record_count;
        for (const literal of fieldCell.literals) { meter(); frequencies.set(literal, (frequencies.get(literal) ?? 0) + 1); }
        if (fieldState !== 'observed' || state(subjectField) !== 'observed'
          || state(row.county) !== 'observed' || state(subjectCounty) !== 'observed'
          || literalOf(row.county) !== literalOf(subjectCounty)) comparisons.unavailable_count++;
        else comparisons[literalOf(fieldCell) === literalOf(subjectField) ? 'same_literal_count' : 'different_literal_count']++;
      }
      const distribution = { basis: 'accounts_with_literal_any_parcel_row_nonexclusive', status: 'complete', reason: null,
        distinct_literal_count: frequencies.size, entries: [] };
      let reason = frequencies.size > L.distribution_literals ? 'distinct_literal_limit' : null;
      if (!reason) {
        const ordered = [...frequencies].sort(([a], [b]) => compare(literalKeys[a], literalKeys[b]));
        let entryBytes = 2;
        for (const [id, account_count] of ordered) {
          const entry = { literal: literals[id], account_count }; entryBytes += bytes(entry) + 1;
          if (entryBytes > L.distribution_utf8_bytes) { reason = 'distribution_byte_limit'; break; }
          distribution.entries.push(entry);
        }
      }
      if (reason) Object.assign(distribution, { status: 'details_unavailable', reason, entries: null });
      return [field, { ...result, distribution, subject_comparison: comparisons }];
    })) };
  }
  const result = { cad_baseline_version: 1, mapping_version: 4, basis: 'retained_current_cad_observations', authority: 'not_established',
    binding: { context_ref: structuredClone(preview.context_ref), captured_at: preview.captured_at },
    comparison_basis: 'exact_literal_same_recorded_county_not_housing_similarity',
    temporal_basis: 'observation_availability_not_historical_validity',
    subject: { in_discovery: !!subject, county_state: state(subjectCounty), fields: Object.fromEntries(FIELDS.map(field =>
      [field, { state: state(subjectFields[field]), literal: literalOf(subjectFields[field]) }])) },
    all: summary(roster), pockets: orderedGroups.map(group => ({ id: group.id, ...summary(group.account_ids) })),
    limitations: [...CUSTOM_COHORT_CURRENT_CAD_BASELINE_LIMITATIONS] };
  // Never return a prefix of categories/populations as the complete answer. On
  // aggregate detail overflow retain ALL exact counts, omitting ALL detail lists.
  if (bytes(result) > L.output_utf8_bytes) for (const population of [result.all, ...result.pockets]) {
    for (const field of Object.values(population.fields)) if (field.distribution.status === 'complete') {
      Object.assign(field.distribution, { status: 'details_unavailable', reason: 'baseline_output_byte_limit', entries: null });
    }
  }
  check(bytes(result) <= L.output_utf8_bytes, 'output_byte_limit');
  return freeze(result);
}
