import { createHash } from 'node:crypto';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { customCohortObservationMappingVersion, customCohortObservationProjectionMatches } from './customCohortObservationMapping.js';

export const CUSTOM_COHORT_POCKET_CATALOG_LIMITS = Object.freeze({
  accounts: 50000, source_records: 100000, source_chunks: 1000, pockets: 128,
  label_utf8_bytes: 512, distinct_label_variants: 4096, output_utf8_bytes: 32000000,
  public_output_utf8_bytes: 3990000, transport_output_utf8_bytes: 4000000,
});
const L = CUSTOM_COHORT_POCKET_CATALOG_LIMITS;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...new Set(values)].sort(compare);
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missingLabels = new Set(['unknown', 'unassigned', 'n/a', 'none', 'not available']);
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_pocket_catalog_${reason}`), { code: 'CUSTOM_COHORT_POCKET_CATALOG_INVALID', reason }); }
function check(ok, reason) { if (!ok) fail(reason); }
function array(value, maximum) { check(Array.isArray(value) && value.length <= maximum, 'input_limit'); return value; }
function account(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value), 'account_identity'); return value;
}
class CatalogLimit extends Error {}
const normalize = value => value.trim().replace(/\s+/gu, ' ').toLowerCase();
const display = value => value.trim().replace(/\s+/gu, ' ');
const LIMITATIONS = Object.freeze([
  'recorded_label_match_only_not_legal_subdivision_identity', 'manual_review_required_no_recommendation_or_ranking',
  'current_cad_observations_not_historical_membership', 'housing_and_competitive_eligibility_not_established',
  'provider_coverage_not_established', 'no_builder_hoa_phase_or_development_identity_inferred',
  'no_neighborhood_boundary_or_geometry_constructed',
]);

/** Pure review-only names/membership from exact retained CAD projections and
 * preview.all.stock. Authorization, retained-graph validation and fresh target
 * checks belong to the owner. A catalog ID is a county/name key, not authority,
 * legal identity, geography, a competitive recommendation or report readiness.
 */
export function buildCustomCohortPocketCatalog({ retained_inputs: input, preview } = {}) {
  const capture = input?.acquisition?.capture_result?.source_capture;
  check(capture?.status === 'ready' && input?.acquisition?.capture_result?.query_complete === true
    && input?.spatial?.query_complete === true, 'retained_capture_required');
  const mappingVersion = customCohortObservationMappingVersion(input.acquisition);
  check(preview?.preview_version === 1 && preview.status === 'observations_only' && preview.authority === 'not_established'
    && preview.apply?.status === 'blocked' && Number.isSafeInteger(preview.selection_revision) && preview.selection_revision > 0, 'observation_preview_required');
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(preview.context_ref));
  const binding = { context_ref: context, selection_revision: preview.selection_revision };
  const sourceIdentity = snapshots => sorted(array(snapshots, L.source_chunks).map(row => `${row.id}\n${row.content_sha256}`));
  check(JSON.stringify(sourceIdentity(capture.source_snapshots)) === JSON.stringify(sourceIdentity(preview.source_snapshots))
    && preview.captured_at === input.acquisition.capture_result.captured_at && preview.effective_date === input.subject.effective_date
    && preview.observation_period.start_date === input.study.observation_period.start_date
    && preview.observation_period.end_date === input.study.observation_period.end_date, 'preview_capture_mismatch');
  for (const key of ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'appraisal_case_id', 'subject_snapshot_id']) {
    check(typeof input.subject.target[key] === 'string' && input.subject.target[key] === preview.target[key], 'target_mismatch');
    if (Object.hasOwn(capture.scope, key)) check(capture.scope[key] === input.subject.target[key], 'scope_mismatch');
  }
  const roster = sorted(array(input.spatial.account_ids, L.accounts).map(account));
  check(roster.length === input.spatial.account_ids.length, 'duplicate_account');
  const stock = array(preview.all.stock.members, L.accounts).map(row => account(row.account_id));
  check(preview.all.stock.member_count === roster.length && stock.length === roster.length && new Set(stock).size === stock.length
    && JSON.stringify(sorted(stock)) === JSON.stringify(roster)
    && JSON.stringify(sorted(array(preview.all.account_ids, L.accounts))) === JSON.stringify(roster), 'stock_roster_mismatch');
  const subjectAccount = input.subject.target.account_id, rosterSet = new Set(roster);
  const header = { catalog_version: 1, binding, basis: 'retained_discovery_accounts_and_current_cad_recorded_labels',
    authority: 'not_established', geography: null, limitations: [...LIMITATIONS],
    apply: { status: 'blocked', reasons: ['recorded_label_catalog_is_not_a_supported_assessment'] } };
  const subjectMembership = (status, assigned_pocket_id = null) => ({ account_id: subjectAccount,
    assigned_pocket_id, recorded_label_match_only: true, status });
  const incomplete = reason => freeze({ ...header, status: 'incomplete', reasons: [reason], pockets: [],
    catalog_complete: false, discovered_group_count: null,
    // No arbitrary prefix survives a limit. The whole original roster remains
    // available as unresolved membership; it is not called nameless or excluded.
    unassigned: { account_ids: [...roster], member_count: roster.length, details: [], details_complete: false,
      reason_counts: [{ reason, member_count: roster.length }] },
    unresolved_membership: { roster_location: 'unassigned.account_ids', member_count: roster.length, reason },
    coverage: { basis: 'retained_discovery_accounts', discovery_member_count: roster.length, stock_member_count: stock.length,
      assigned_account_count: 0, unassigned_account_count: roster.length, conflicting_account_count: null, invalid_account_count: null,
      account_source_row_count: null, parcel_source_row_count: null, provider_coverage: 'not_established' },
    subject_recorded_group_ids: [], subject_membership: subjectMembership(rosterSet.has(subjectAccount) ? 'catalog_incomplete' : 'not_in_discovery') });
  const accounts = new Map(roster.map(id => [id, { county: [], labels: [], account_rows: 0, parcel_rows: 0 }]));
  const variants = new Set();
  function label(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { state: 'missing', raw: null, key: null };
    if (typeof value !== 'string' || /[\u0000-\u0008\u000e-\u001f\u007f]/.test(value)) return { state: 'invalid', raw: null, key: null };
    if (value.length > L.label_utf8_bytes || Buffer.byteLength(value) > L.label_utf8_bytes) throw new CatalogLimit('recorded_label_text_limit');
    variants.add(value); if (variants.size > L.distinct_label_variants) throw new CatalogLimit('recorded_label_variant_limit');
    const key = normalize(value);
    return { state: missingLabels.has(key) ? 'placeholder' : 'known', raw: value, key };
  }
  try {
    const roles = new Set(); let records = 0, accountRows = 0, parcelRows = 0;
    for (const source of array(capture.sources, L.source_chunks)) {
      const role = source.payload?.projection?.definition?.role;
      check(customCohortObservationProjectionMatches(source.payload?.projection?.definition, mappingVersion), 'mapping_profile_mismatch');
      if (!['accounts', 'parcels'].includes(role)) continue;
      roles.add(role);
      for (const record of array(source.payload.records, L.source_records)) {
        check(++records <= L.source_records, 'input_limit');
        const mapped = record.data, raw = mapped?.raw_projection, normalized = mapped?.data;
        check(normalized?.cached_mapping_version === mappingVersion && raw && normalized.cached_projection_kind === (role === 'accounts' ? 'account' : 'parcel'),
          `mapping_v${mappingVersion}_required`);
        const id = account(normalized.account_id); check(raw.account_id === id && accounts.has(id), 'cad_account_scope');
        const facts = accounts.get(id);
        if (role === 'accounts') {
          accountRows++; facts.account_rows++; facts.county.push(label(raw.county)); facts.labels.push(label(raw.subdivision));
        } else { parcelRows++; facts.parcel_rows++; facts.labels.push(label(raw.subdivision_name)); }
      }
    }
    check(roles.size === 2, 'cad_source_roles_missing');
    const groups = new Map(), resolved = new Map(), reasonCounts = new Map();
    let countyKnown = 0, labelKnown = 0, conflicting = 0, invalid = 0, partial = 0;
    for (const id of roster) {
      const facts = accounts.get(id), reasons = [];
      const counties = sorted(facts.county.filter(row => row.state === 'known').map(row => row.key));
      const names = sorted(facts.labels.filter(row => row.state === 'known').map(row => row.key));
      const rawLabels = sorted(facts.labels.map(row => row.raw).filter(value => value !== null));
      const rawCounties = sorted(facts.county.map(row => row.raw).filter(value => value !== null));
      if (counties.length === 0) reasons.push('county_unavailable');
      if (counties.length > 1) reasons.push('conflicting_recorded_counties');
      if (facts.county.some(row => row.state === 'invalid')) reasons.push('invalid_recorded_county');
      if (names.length === 0) reasons.push('recorded_subdivision_label_unavailable');
      if (names.length > 1) reasons.push('conflicting_recorded_subdivision_labels');
      if (facts.labels.some(row => row.state === 'invalid')) reasons.push('invalid_recorded_subdivision_label');
      const countyUsable = counties.length === 1 && !reasons.includes('invalid_recorded_county');
      if (countyUsable) countyKnown++;
      if (names.length) labelKnown++;
      const hasConflict = reasons.some(reason => reason.startsWith('conflicting_'));
      const hasInvalid = reasons.some(reason => reason.startsWith('invalid_'));
      if (hasConflict) conflicting++;
      if (hasInvalid) invalid++;
      if (names.length && facts.labels.some(row => row.state !== 'known')) partial++;
      const candidates = [];
      if (countyUsable) for (const name of names) {
        const groupId = `recorded-cad:${hash({ county: counties[0], label: name })}`;
        if (!groups.has(groupId)) {
          if (groups.size >= L.pockets) throw new CatalogLimit('pocket_count_limit');
          groups.set(groupId, { id: groupId, normalized_county: counties[0], normalized_label: name,
            raw_label_variants: new Set(), raw_county_variants: new Set(), account_ids: [], conflict_ids: new Set(),
            invalid_ids: new Set(), unassigned_ids: new Set(), partial_ids: new Set() });
        }
        const group = groups.get(groupId); candidates.push(groupId);
        facts.labels.filter(row => row.state === 'known' && row.key === name).forEach(row => group.raw_label_variants.add(row.raw));
        facts.county.filter(row => row.state === 'known').forEach(row => group.raw_county_variants.add(row.raw));
        if (reasons.length === 0) { group.account_ids.push(id); if (facts.labels.some(row => row.state !== 'known')) group.partial_ids.add(id); }
        else {
          group.unassigned_ids.add(id);
          if (hasConflict) group.conflict_ids.add(id);
          if (hasInvalid) group.invalid_ids.add(id);
        }
      }
      const assigned = reasons.length === 0 ? candidates[0] : null;
      check(reasons.length > 0 || (candidates.length === 1 && assigned), 'membership_unresolved');
      for (const reason of reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      resolved.set(id, { account_id: id, assigned_pocket_id: assigned, reasons,
        candidate_pocket_ids: sorted(candidates), raw_label_variants: rawLabels, raw_county_variants: rawCounties });
    }
    const pockets = [...groups.values()].map(group => {
      const raw_label_variants = sorted(group.raw_label_variants), raw_county_variants = sorted(group.raw_county_variants);
      return { id: group.id, label: display(raw_label_variants[0]), county: display(raw_county_variants[0]),
        normalized_county: group.normalized_county, normalized_label: group.normalized_label, raw_label_variants, raw_county_variants,
        account_ids: sorted(group.account_ids), member_count: group.account_ids.length,
        conflicting_account_count: group.conflict_ids.size, invalid_account_count: group.invalid_ids.size,
        unassigned_candidate_account_count: group.unassigned_ids.size, partially_observed_account_count: group.partial_ids.size,
        disposition: 'needs_review', recorded_label_match_only: true, boundary_status: 'not_established',
        competitive_eligibility: 'not_established' };
    }).sort((a, b) => compare(a.normalized_county, b.normalized_county) || compare(a.normalized_label, b.normalized_label));
    const unassigned = [...resolved.values()].filter(row => row.assigned_pocket_id === null);
    const subject = resolved.get(subjectAccount);
    const result = { ...header, status: 'review_only', reasons: [], catalog_complete: true, discovered_group_count: pockets.length, pockets,
      unassigned: { account_ids: unassigned.map(row => row.account_id), member_count: unassigned.length,
        details: unassigned.map(({ assigned_pocket_id: _, ...row }) => row), details_complete: true,
        reason_counts: [...reasonCounts].sort(([a], [b]) => compare(a, b)).map(([reason, member_count]) => ({ reason, member_count })) },
      unresolved_membership: null,
      coverage: { basis: 'retained_discovery_accounts', discovery_member_count: roster.length, stock_member_count: stock.length,
        assigned_account_count: roster.length - unassigned.length, unassigned_account_count: unassigned.length, conflicting_account_count: conflicting,
        invalid_account_count: invalid,
        account_source_row_count: accountRows, parcel_source_row_count: parcelRows,
        accounts_with_account_row: [...accounts.values()].filter(row => row.account_rows > 0).length,
        accounts_with_parcel_row: [...accounts.values()].filter(row => row.parcel_rows > 0).length,
        accounts_with_known_county: countyKnown, accounts_with_recorded_label: labelKnown, partially_observed_account_count: partial,
        provider_coverage: 'not_established' },
      subject_recorded_group_ids: subject?.candidate_pocket_ids ?? [],
      subject_membership: subjectMembership(!subject ? 'not_in_discovery' : subject.assigned_pocket_id ? 'recorded_label_matched'
        : subject.reasons.some(reason => reason.startsWith('conflicting_')) ? 'conflicting_evidence'
          : subject.reasons.some(reason => reason.startsWith('invalid_')) ? 'invalid_evidence' : 'unassigned', subject?.assigned_pocket_id ?? null) };
    if (Buffer.byteLength(JSON.stringify(result)) > L.output_utf8_bytes) return incomplete('catalog_output_byte_limit');
    return freeze(result);
  } catch (error) {
    if (error instanceof CatalogLimit) return incomplete(error.message);
    throw error;
  }
}

/** Compact projection of this module's internal catalog and its exact numeric
 * preview, not an alternate input validator or source-policy grant. No source
 * row identifiers, raw variants or detailed conflicting evidence leave here.
 * All membership is returned once; byte overflow never clips a group/roster.
 */
export function presentCustomCohortPocketCatalog({ catalog, preview, expected } = {}) {
  check(catalog?.catalog_version === 1 && ['review_only', 'incomplete'].includes(catalog.status)
    && catalog.authority === 'not_established' && catalog.apply?.status === 'blocked', 'catalog_required');
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(expected?.context_ref));
  check(canonicalAssessmentJson(catalog.binding.context_ref) === canonicalAssessmentJson(context)
    && canonicalAssessmentJson(preview.context_ref) === canonicalAssessmentJson(context), 'context_mismatch');
  check(Number.isSafeInteger(expected.selection_revision) && expected.selection_revision > 0
    && catalog.binding.selection_revision === expected.selection_revision
    && preview.selection_revision === expected.selection_revision, 'selection_mismatch');
  // Identical key order/codepoint sorting to the numeric presentation and
  // browser selection fingerprint. These selected pockets do not filter the
  // catalog's independently captured full discovery roster.
  const pockets = preview.pockets.map(pocket => ({ account_ids: [...pocket.account_ids].sort(compare),
    id: pocket.id, label: pocket.label })).sort((a, b) => compare(a.id, b.id));
  const binding = { context_ref: context, selection_revision: expected.selection_revision,
    selection_sha256: hash({ pockets, revision: expected.selection_revision }) };
  const fields = (value, names) => Object.fromEntries(names.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const result = {
    catalog_version: 1, binding, basis: catalog.basis, status: catalog.status, reasons: [...catalog.reasons],
    catalog_complete: catalog.catalog_complete, discovered_group_count: catalog.discovered_group_count,
    authority: 'not_established', geography: null, limitations: [...catalog.limitations],
    apply: { status: 'blocked', reasons: [...catalog.apply.reasons] },
    pockets: catalog.pockets.map(pocket => ({
      ...fields(pocket, ['id', 'label', 'county', 'member_count', 'conflicting_account_count', 'invalid_account_count',
        'unassigned_candidate_account_count', 'partially_observed_account_count', 'disposition', 'recorded_label_match_only',
        'boundary_status', 'competitive_eligibility']), account_ids: [...pocket.account_ids],
    })),
    unassigned: { account_ids: [...catalog.unassigned.account_ids], member_count: catalog.unassigned.member_count,
      details_complete: false, reason_counts: catalog.unassigned.reason_counts.map(row => fields(row, ['reason', 'member_count'])) },
    unresolved_membership: catalog.unresolved_membership === null ? null
      : fields(catalog.unresolved_membership, ['roster_location', 'member_count', 'reason']),
    coverage: fields(catalog.coverage, ['basis', 'discovery_member_count', 'stock_member_count', 'assigned_account_count',
      'unassigned_account_count', 'conflicting_account_count', 'invalid_account_count', 'account_source_row_count',
      'parcel_source_row_count', 'accounts_with_account_row', 'accounts_with_parcel_row', 'accounts_with_known_county',
      'accounts_with_recorded_label', 'partially_observed_account_count', 'provider_coverage']),
    subject_recorded_group_ids: [...catalog.subject_recorded_group_ids],
    subject_membership: fields(catalog.subject_membership, ['account_id', 'assigned_pocket_id', 'recorded_label_match_only', 'status']),
    presentation: { raw_variants_omitted: true, unassigned_details_omitted: true, membership_complete: true },
  };
  const fits = value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= L.public_output_utf8_bytes;
  if (fits(result)) return freeze(result);
  const reason = 'catalog_response_byte_limit';
  const roster = sorted([...result.pockets.flatMap(pocket => pocket.account_ids), ...result.unassigned.account_ids]);
  const fallback = { ...result, status: 'incomplete', reasons: [reason], catalog_complete: false,
    discovered_group_count: null, pockets: [],
    unassigned: { account_ids: roster, member_count: roster.length, details_complete: false,
      reason_counts: [{ reason, member_count: roster.length }] },
    unresolved_membership: { roster_location: 'unassigned.account_ids', member_count: roster.length, reason },
    coverage: { basis: 'retained_discovery_accounts', discovery_member_count: roster.length,
      stock_member_count: result.coverage.stock_member_count, assigned_account_count: 0, unassigned_account_count: roster.length,
      conflicting_account_count: null, invalid_account_count: null, account_source_row_count: null,
      parcel_source_row_count: null, provider_coverage: 'not_established' },
    subject_recorded_group_ids: [], subject_membership: { ...result.subject_membership, assigned_pocket_id: null,
      status: roster.includes(result.subject_membership.account_id) ? 'catalog_incomplete' : 'not_in_discovery' },
  };
  if (fits(fallback)) return freeze(fallback);
  // Even full unresolved membership cannot fit. The transport returns an
  // explicit incomplete error, never a successful partial-membership catalog.
  throw Object.assign(new Error('custom_cohort_pocket_catalog_transport_limit'), {
    code: 'CUSTOM_COHORT_POCKET_CATALOG_LIMIT', reason: 'catalog_transport_limit',
  });
}
