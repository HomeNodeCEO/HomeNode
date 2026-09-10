import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { customCohortObservationMappingVersion, customCohortObservationProjectionMatches } from './customCohortObservationMapping.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
export const CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES = Object.freeze([
  'detached_single_family', 'townhouse', 'condominium', 'duplex', 'apartment', 'mobile_home', 'manufactured_home',
]);
export const CUSTOM_COHORT_RECORDED_HOUSING_STATES = Object.freeze(['observed', 'missing', 'unknown', 'partial', 'conflicting']);
export const CUSTOM_COHORT_RECORDED_HOUSING_ORIGINS = Object.freeze([
  'saved_subject', 'retained_subject_public', 'current_subject_cad', 'retained_current_cad',
]);
export const CUSTOM_COHORT_RECORDED_HOUSING_BASIS = 'retained_current_housing_observations';
export const CUSTOM_COHORT_RECORDED_HOUSING_LIMITS = Object.freeze({
  accounts: 50000, source_records: 100000, source_chunks: 1000, groups: 129,
  cad_literal_utf8_bytes: 4096, subject_literal_utf8_bytes: 8192, input_literal_utf8_bytes: 32000000,
  membership_work: 2000000, output_utf8_bytes: 12000000,
});
export const CUSTOM_COHORT_RECORDED_HOUSING_LIMITATIONS = Object.freeze([
  'recorded_categories_not_verified_property_classifications', 'current_observations_not_historical_housing_population',
  'numeric_cad_class_and_structure_codes_not_interpreted', 'mobile_and_manufactured_homes_not_equated',
  'all_accounts_and_all_retained_parcel_observations_required', 'no_majority_or_first_parcel_resolution',
  'subject_profile_provenance_and_confidence_not_verification', 'no_cross_source_subject_housing_merge',
  'no_completion_unit_interest_or_market_eligibility_inferred', 'no_source_rights_or_report_apply_authority',
]);
// Source-specific legacy categories, not numeric GIS CLASSCD or building-quality
// STRCLASS codes. Official cross-reference effective tax year2022 (07/22):
// https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5COther%5CPTAD_PROP_CLASS.pdf&type=1
// A11's detached meaning is explicit in the official 2025 SFR summary (07/22/2025):
// https://www.dallascad.org/ViewPDFs.aspx?id=%5C%5CDCAD.ORG%5CWEB%5CWEBDATA%5CWEBFORMS%5CAVG+HOUSE+VAL%5C2025AvgValSFR.pdf&type=1
const LEGACY = { A11: 'detached_single_family', A12: 'townhouse', A13: 'condominium',
  A20: 'mobile_home', B11: 'apartment', B12: 'duplex' };
const CAD_DESCRIPTIONS = { 'SINGLE FAMILY RESIDENCES': 'detached_single_family', 'SFR - TOWNHOUSES': 'townhouse',
  'SFR - CONDOMINIUMS': 'condominium', 'MOBILE HOME ON OWNERS LAND': 'mobile_home',
  'MFR - APARTMENTS': 'apartment', 'MFR - DUPLEXES': 'duplex' };
const LABELS = {
  'SINGLE FAMILY DETACHED': 'detached_single_family', 'SINGLE DETACHED': 'detached_single_family',
  'DETACHED SINGLE FAMILY': 'detached_single_family', 'DETACHED SINGLE FAMILY RESIDENCE': 'detached_single_family',
  TOWNHOUSE: 'townhouse', TOWNHOME: 'townhouse', CONDOMINIUM: 'condominium', 'CONDOMINIUM UNIT': 'condominium',
  CONDO: 'condominium', DUPLEX: 'duplex', APARTMENT: 'apartment', APARTMENTS: 'apartment',
  'MOBILE HOME': 'mobile_home', 'MANUFACTURED HOME': 'manufactured_home',
};
const ALTERNATIVES = ['MIXED', 'MIXED/REVIEW', 'MIXED USE', 'MIXED USE DEVELOPMENT', 'CONDO/TOWNHOME',
  'CONDO / TOWNHOME', 'CONDOMINIUM/TOWNHOUSE', 'ATTACHED/DUPLEX', 'ATTACHED / DUPLEX',
  'ATTACHED OR 1/2 DUPLEX', '1/2 DUPLEX', 'HALF DUPLEX', 'SINGLE DETACHED, ATTACHED', 'SINGLE DETACHED/ATTACHED'];
const UNKNOWN = ['UNKNOWN', 'OTHER', 'UNASSIGNED', 'N/A', 'NOT KNOWN'];
const DEFINITION = freeze({
  id: 'custom-recorded-housing-v1', revision: 1, mapping_version: 4,
  basis: CUSTOM_COHORT_RECORDED_HOUSING_BASIS, authority: 'not_established',
  normalization: 'whole_value_trim_and_case_only_no_substring_or_numeric_code_inference',
  cad_county: 'DALLAS', legacy_codes: LEGACY, cad_descriptions: CAD_DESCRIPTIONS, explicit_labels: LABELS,
  alternatives: ALTERNATIVES, unknown_markers: UNKNOWN,
  subject_detached_pair: { labels: ['SINGLE FAMILY', 'SINGLE FAMILY RESIDENCE'], attachment: 'DETACHED' },
  subject_precedence: 'saved_then_retained_public_then_subject_CAD;only_absent_observations_fall_back;no_cross_source_merge',
  subject_primary_label: 'housing_type_then_structural_style_if_absent;explicit_null_blank_unknown_blocks_fallback',
  supplementary_fields: 'unknown_codes_and_descriptions_do_not_override_exact_known_labels;recognized_conflicts_and_explicit_alternatives_block',
  parcel_aggregation: 'every_retained_parcel;known_plus_unresolved_partial;conflicts_never_choose_majority',
  categories: CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES, states: CUSTOM_COHORT_RECORDED_HOUSING_STATES,
  limitations: CUSTOM_COHORT_RECORDED_HOUSING_LIMITATIONS,
});
export const CUSTOM_COHORT_RECORDED_HOUSING_PROFILE = freeze({ id: DEFINITION.id, revision: DEFINITION.revision,
  content_sha256: createHash('sha256').update(canonicalAssessmentJson(DEFINITION)).digest('hex') });
const L = CUSTOM_COHORT_RECORDED_HOUSING_LIMITS, STATES = CUSTOM_COHORT_RECORDED_HOUSING_STATES;
const TARGET = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'appraisal_case_id', 'subject_snapshot_id'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const categoryFor = (dictionary, key) => Object.hasOwn(dictionary, key) ? dictionary[key] : null;
const resolution = (state, category = null) => ({ state, category: state === 'observed' ? category : null });
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_recorded_housing_${reason}`), {
    code: 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID', reason,
  });
}
function object(value) { check(value && typeof value === 'object' && !isProxy(value)
  && Object.getPrototypeOf(value) === Object.prototype, 'plain_object'); return value; }
function get(value, key, optional = false) {
  const d = Object.getOwnPropertyDescriptor(object(value), key);
  check(optional && !d || d?.enumerable && Object.hasOwn(d, 'value'), 'data_property');
  return d?.value;
}
function list(value, maximum) {
  check(Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length <= maximum, 'input_limit');
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i));
    check(d?.enumerable && Object.hasOwn(d, 'value'), 'data_property'); }
  return value;
}
function id(value, maximum = 100) { check(typeof value === 'string' && value.length > 0 && value.length <= maximum
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'identity'); return value; }

/** Synchronous consumer AFTER the existing owner retained loader, just like the
 * CAD literal baseline. Not a second retained-graph verifier or source grant.
 * No query, clock, score, selection mutation, supported fact or report output.
 */
export function buildCustomCohortRecordedHousing(args = {}) {
  object(args); const input = get(args, 'retained_inputs'), acquisition = get(input, 'acquisition');
  const metadata = get(acquisition, 'compact_metadata_json', true);
  if (customCohortObservationMappingVersion(metadata === undefined ? {} : { compact_metadata_json: metadata }) !== 4) return null;
  const preview = get(args, 'preview'), groups = get(args, 'groups'), subject = get(input, 'subject');
  const captureResult = get(acquisition, 'capture_result'), capture = get(captureResult, 'source_capture');
  check(get(capture, 'status') === 'ready' && get(captureResult, 'query_complete') === true
    && get(preview, 'preview_version') === 1 && get(preview, 'status') === 'observations_only'
    && get(preview, 'authority') === 'not_established' && get(get(preview, 'apply'), 'status') === 'blocked', 'observation_preview_required');
  const capturedAt = get(preview, 'captured_at');
  check(typeof capturedAt === 'string' && capturedAt === get(captureResult, 'captured_at')
    && get(preview, 'effective_date') === get(subject, 'effective_date'), 'preview_capture_mismatch');
  const target = get(subject, 'target');
  for (const key of TARGET) check(id(get(target, key)) === get(get(preview, 'target'), key), 'target_mismatch');
  const contextRaw = get(preview, 'context_ref');
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(Object.fromEntries(
    ['context_id', 'context_revision', 'context_sha256'].map(key => [key, get(contextRaw, key)]))));
  const identities = value => list(value, L.source_chunks).map(row => `${id(get(row, 'id'), 200)}\n${id(get(row, 'content_sha256'))}`).sort(compare);
  check(JSON.stringify(identities(get(capture, 'source_snapshots'))) === JSON.stringify(identities(get(preview, 'source_snapshots'))), 'preview_capture_mismatch');
  const stock = get(get(preview, 'all'), 'stock'), spatial = get(input, 'spatial');
  const roster = list(get(stock, 'members'), L.accounts).map(row => id(get(row, 'account_id'))).sort(compare);
  check(new Set(roster).size === roster.length && get(stock, 'member_count') === roster.length
    && JSON.stringify(roster) === JSON.stringify(list(get(spatial, 'account_ids'), L.accounts).map(value => id(value)).sort(compare)), 'stock_roster_mismatch');
  const members = new Map(roster.map(account => [account, { counties: [], parcels: [] }]));
  const partition = new Set(), groupIds = new Set();
  const orderedGroups = list(groups, L.groups).map(group => {
    const groupId = id(get(group, 'id'), 200), accounts = list(get(group, 'account_ids'), L.accounts).map(value => id(value));
    check(!groupIds.has(groupId), 'group_identity'); groupIds.add(groupId);
    for (const account of accounts) { check(members.has(account) && !partition.has(account), 'group_partition'); partition.add(account); }
    return { id: groupId, accounts };
  }).sort((a, b) => compare(a.id, b.id));
  check(partition.size === roster.length, 'group_partition');
  let literalBytes = 0, work = 0, recordCount = 0;
  function text(value, maximum = L.cad_literal_utf8_bytes) {
    check(value === null || typeof value === 'string' && value.isWellFormed() && value.length <= maximum, 'literal_type');
    if (value === null) return '';
    const bytes = Buffer.byteLength(value); literalBytes += bytes;
    check(bytes <= maximum && literalBytes <= L.input_literal_utf8_bytes && ++work <= L.membership_work, 'literal_limit');
    return /[\u0000-\u001f\u007f]/.test(value) ? value : value.trim().toUpperCase();
  }
  function labels(values, code = null) {
    const categories = new Set(code ? [code] : []);
    for (const value of values) { const found = categoryFor(LABELS, value) ?? categoryFor(CAD_DESCRIPTIONS, value);
      if (found) categories.add(found); }
    return categories.size > 1 ? resolution('conflicting') : values.some(value => ALTERNATIVES.includes(value)) ? resolution('unknown')
      : categories.size === 1 ? resolution('observed', [...categories][0]) : resolution(values.some(Boolean) ? 'unknown' : 'missing');
  }
  const roles = new Set(), seen = new Set();
  for (const source of list(get(capture, 'sources'), L.source_chunks)) {
    const payload = get(source, 'payload'), definition = get(get(payload, 'projection'), 'definition');
    const role = get(definition, 'role');
    check(customCohortObservationProjectionMatches({ mapping_version: get(definition, 'mapping_version') }, 4), 'mapping_profile_mismatch');
    if (!['accounts', 'parcels'].includes(role)) continue;
    roles.add(role);
    for (const record of list(get(payload, 'records'), L.source_records)) {
      check(++recordCount <= L.source_records, 'source_record_limit');
      const key = `${role}\n${id(get(record, 'record_id'), 1000)}`;
      check(!seen.has(key), 'duplicate_source_record'); seen.add(key);
      const mapped = get(record, 'data'), raw = get(mapped, 'raw_projection'), normalized = get(mapped, 'data');
      check(get(normalized, 'cached_mapping_version') === 4
        && get(normalized, 'cached_projection_kind') === (role === 'accounts' ? 'account' : 'parcel'), 'mapping_v4_required');
      const account = id(get(normalized, 'account_id'));
      check(get(raw, 'account_id') === account && members.has(account), 'cad_account_scope');
      if (role === 'accounts') members.get(account).counties.push(text(get(raw, 'county', true) ?? null));
      else {
        const code = text(get(raw, 'class_code'));
        const values = ['class_description', 'use_description', 'structure_type'].map(field => text(get(raw, field)));
        const built = get(raw, 'built_up'); check(built === null || typeof built === 'boolean', 'literal_type');
        const resolved = labels(values, categoryFor(LEGACY, code));
        if (resolved.state === 'missing' && code) resolved.state = 'unknown';
        members.get(account).parcels.push(resolved);
      }
    }
  }
  check(roles.size === 2, 'cad_source_roles_missing');
  function aggregateParcel(row) {
    if (!row || !row.parcels.length) return resolution('missing');
    if (!row.counties.length || row.counties.some(value => value !== 'DALLAS')) return resolution('unknown');
    const categories = new Set(row.parcels.filter(item => item.state === 'observed').map(item => item.category));
    if (row.parcels.some(item => item.state === 'conflicting') || categories.size > 1) return resolution('conflicting');
    if (categories.size) return row.parcels.every(item => item.state === 'observed')
      ? resolution('observed', [...categories][0]) : resolution('partial');
    return resolution(row.parcels.every(item => item.state === 'missing') ? 'missing' : 'unknown');
  }
  const accounts = roster.map(account_id => ({ account_id, ...aggregateParcel(members.get(account_id)), origin: 'retained_current_cad' }));
  const byAccount = new Map(accounts.map(row => [row.account_id, row]));
  const material = get(subject, 'material');
  check(get(material, 'material_input_version') === 1 && get(material, 'profile_id') === 'custom-neighborhood-physical-stock-inputs-v1'
    && get(material, 'profile_revision') === '1' && get(material, 'workflow_type') === 'custom_appraisal'
    && ['account_id', 'assignment_file_id', 'report_file_id'].every(key => get(material, key) === get(target, key)), 'subject_material_binding');
  function materialCell(fields, key) {
    const value = get(fields, key), state = get(value, 'state'), raw = get(value, 'value');
    check(['absent', 'json_null', 'present'].includes(state)
      && (state === 'present' ? typeof raw === 'string' : raw === null), 'subject_material_state');
    return { state, value: state === 'present' ? text(raw, L.subject_literal_utf8_bytes) : '' };
  }
  function subjectNode(node, origin) {
    const state = get(node, 'state');
    check(['absent', 'json_null', 'present'].includes(state), 'subject_material_state');
    if (state === 'absent') return null;
    if (state === 'json_null') return { ...resolution('missing'), origin };
    const fields = get(node, 'value'), type = materialCell(fields, 'housing_type'), style = materialCell(fields, 'structural_style');
    const attachment = materialCell(fields, 'attachment_type'), primary = type.state === 'absent' ? style : type;
    if (primary.state === 'absent' && attachment.state === 'absent') return null;
    if (primary.state === 'json_null' || primary.state === 'present' && !primary.value) return { ...resolution('missing'), origin };
    if (UNKNOWN.includes(primary.value)) return { ...resolution('unknown'), origin };
    const primaryCategory = categoryFor(LABELS, primary.value);
    const genericSingle = ['SINGLE FAMILY', 'SINGLE FAMILY RESIDENCE'].includes(primary.value);
    const pairedCategory = genericSingle && attachment.value === 'DETACHED' ? 'detached_single_family' : null;
    // An explicit unmapped primary never borrows meaning from a secondary style.
    // An unknown attachment is supplementary to an explicit full primary label;
    // it cannot supply the missing detached meaning of generic Single Family.
    if (!primaryCategory && !pairedCategory) return { ...resolution('unknown'), origin };
    const categories = new Set([primaryCategory ?? pairedCategory]);
    const secondaryCategory = type.state === 'absent' ? null : categoryFor(LABELS, style.value);
    if (secondaryCategory) categories.add(secondaryCategory);
    const mixed = [type.value, style.value, attachment.value].some(value => ALTERNATIVES.includes(value));
    const attachmentConflict = categories.has('detached_single_family') && attachment.value === 'ATTACHED'
      || categories.has('townhouse') && attachment.value === 'DETACHED';
    const result = categories.size > 1 || attachmentConflict ? resolution('conflicting') : mixed ? resolution('unknown')
      : categories.size === 1 ? resolution('observed', [...categories][0]) : resolution('unknown');
    return { ...result, origin };
  }
  const characteristics = get(get(material, 'assignment_sections'), 'property_characteristics');
  const storage = get(characteristics, 'storage_state');
  check(['absent', 'object'].includes(storage), 'subject_material_state');
  const saved = storage === 'absent' ? null : subjectNode(get(get(characteristics, 'projection'), 'housing_profile'), 'saved_subject');
  const publicSubject = saved ?? subjectNode(get(get(material, 'retained_public'), 'housing_profile'), 'retained_subject_public');
  const subjectResult = publicSubject ?? { ...aggregateParcel(members.get(get(target, 'account_id'))), origin: 'current_subject_cad' };
  function coverage(ids) {
    const states = Object.fromEntries(STATES.map(state => [state, 0]));
    for (const account of ids) { check(++work <= L.membership_work, 'membership_work_limit'); states[byAccount.get(account).state]++; }
    return { account_count: ids.length, observed_count: states.observed, unknown_count: ids.length - states.observed, states };
  }
  const result = { housing_version: 1, mapping_version: 4, profile: CUSTOM_COHORT_RECORDED_HOUSING_PROFILE,
    basis: CUSTOM_COHORT_RECORDED_HOUSING_BASIS, authority: 'not_established', binding: { context_ref: context, captured_at: capturedAt },
    subject: subjectResult, accounts, coverage: coverage(roster), pockets: orderedGroups.map(group => ({ id: group.id, ...coverage(group.accounts) })),
    limitations: [...CUSTOM_COHORT_RECORDED_HOUSING_LIMITATIONS] };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_byte_limit');
  return freeze(result);
}
