import { assessmentEvidenceDigest as digest, buildNeighborhoodAssessment } from './contract.js';
import { neighborhoodMemberContentDigest, neighborhoodMemberSetDigest, prepareNeighborhoodPublication } from './assessmentRepository.js';
import { REPORTED_OBSERVATION_PROFILE, REPORTED_OBSERVATION_PROFILE_ID } from './reportedObservationContract.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreview,
  customCohortObservationMembers } from './customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from './customCohortPocketCatalog.js';
import { buildCustomCohortPrivateSalesObservations } from './customCohortPrivateSales.js';
import { buildCustomCohortReportedSharedSales } from './customCohortReportedSharedSales.js';
import { customCohortCurrentStockSupport } from './customCohortTemporalSupport.js';
import { customCohortReportGeographyForReportedAssessment } from './customCohortReportGeography.js';
import { buildCustomNeighborhoodReportCandidate } from './customReportMapping.js';
import { types as utilTypes } from 'node:util';

const profile = { contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value);
} return value; };
function check(ok, reason) { if (!ok) throw new TypeError(`custom_cohort_reported_assessment_${reason}`); }
const emptyCounts = () => ({ observed_count: 0, missing_count: 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0 });
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)
  && value.replace('.', '').length <= 31 && (value.split('.')[1]?.length ?? 0) <= 12;
const scale = 10n ** 12n;
const scaled = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * scale + BigInt(fraction.padEnd(12, '0')); };
function unscale(value, digits = 12) {
  const text = value.toString().padStart(digits + 1, '0'), fraction = text.slice(-digits).replace(/0+$/, '');
  return text.slice(0, -digits) + (fraction ? `.${fraction}` : '');
}
// Input cells preserve the existing preview's per-account conflict/missing
// decisions. Only admitted decimal observations enter these order statistics.
function accountMetric(cells, unit) {
  const counts = emptyCounts(), values = [];
  for (const cell of cells) {
    const state = cell.state === 'observed' && !decimal(cell.exact_value) ? 'unsupported' : cell.state;
    check(Object.hasOwn(counts, `${state}_count`), 'cell_state'); counts[`${state}_count`]++;
    if (state === 'observed') values.push(scaled(cell.exact_value));
  }
  values.sort(compare); const n = values.length, mid = Math.floor(n / 2);
  return { ...counts, unit, low: n ? unscale(values[0]) : null, high: n ? unscale(values.at(-1)) : null,
    median: !n ? null : n % 2 ? unscale(values[mid]) : unscale((values[mid - 1] + values[mid]) * 5n, 13) };
}
function privateMetric(value) {
  return { observed_count: value.count, missing_count: value.missing_count, invalid_count: value.invalid_count,
    conflicting_count: value.conflicting_count, unsupported_count: value.unsupported_count,
    unit: value.unit, low: value.low, median: value.median, high: value.high };
}
function proposalBinding(value, target) {
  if (value === undefined) return null;
  check(value && !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'proposal_binding');
  const keys = ['operation_id', 'actor_user_id', 'expected_editor_revision'], descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable), 'proposal_binding');
  const result = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  check(uuid(result.operation_id) && uuid(result.actor_user_id) && Number.isInteger(result.expected_editor_revision)
    && result.expected_editor_revision >= 0 && result.expected_editor_revision < 2147483647
    && result.expected_editor_revision === target.editor_revision, 'proposal_binding');
  return Object.freeze(result);
}

/** Internal retained-data consumer only. The workflow owner must authenticate,
 * load this exact graph/checkpoint, run native geography validation, and recheck
 * the saved revisions and source-use grants before publication or presentation.
 * No current-source lookup, user-supplied member roster, implicit top-N sampling,
 * economic-property inference, temporal promotion, or report writes occur here.
 */
export function buildCustomCohortReportedAssessment({ context_ref, retained_inputs, selection, target,
  preparation_identity: identity, report_geography, derived_at, proposal_binding }) {
  // Distinguish independently authorized proposal operations without changing
  // their observations or inventing a later clock. This is audit identity, not
  // source truth, report rights or reviewer licensure. Omission preserves the
  // original pure preparation profile/content exactly.
  const proposal = proposalBinding(proposal_binding, target);
  const retained = retained_inputs, effective = retained.subject.effective_date;
  check(target.effective_date === effective && target.data_cutoff === effective, 'effective_date');
  check(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']
    .every(key => target.scope[key] === retained.subject.target[key])
    && target.report_file_id === retained.subject.target.report_file_id
    && String(target.custom_assignment_file_id) === retained.subject.target.assignment_file_id, 'target');
  const temporal = customCohortCurrentStockSupport({ effective_date: effective,
    retained_capture_at: retained.acquisition.capture_result.captured_at });
  if (temporal.status === 'historical_stock_evidence_required') return freeze({ status: 'incomplete', assessment: null,
    publication_bundle: null, candidate: null, issues: [{ code: temporal.status }] });
  check(Number.isSafeInteger(selection?.revision) && selection.revision > 0
    && Array.isArray(selection.included_recorded_group_ids)
    && new Set(selection.included_recorded_group_ids).size === selection.included_recorded_group_ids.length, 'selection');
  const discovery = buildCustomCohortObservationPreview({ context_ref, retained_inputs: retained,
    selection: { revision: selection.revision, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: retained, preview: discovery });
  check(catalog.catalog_complete === true, 'catalog_incomplete');
  const groups = new Map(catalog.pockets.map(group => [group.id, group]));
  if (catalog.unassigned.member_count) groups.set('discovery:unassigned', { id: 'discovery:unassigned',
    label: 'Unassigned retained accounts', account_ids: catalog.unassigned.account_ids });
  check(selection.included_recorded_group_ids.every(id => groups.has(id)), 'selection_membership');
  // Catalog labels allow 512 UTF-8 bytes and saved intent allows 128 named
  // groups plus unassigned. The numeric preview's presentation pockets have
  // narrower bounds. Compute the exact union, not 129 redundant per-group
  // previews; retain every original group ID separately in report selection.
  const selectedAccounts = [...new Set(selection.included_recorded_group_ids
    .flatMap(id => groups.get(id).account_ids))].sort(compare);
  const pockets = selectedAccounts.length ? [{ id: 'reported-selected-accounts',
    label: 'Selected retained accounts', account_ids: selectedAccounts }] : [];
  const preview = buildCustomCohortIndexedObservationPreview({ context_ref, retained_inputs: retained,
    selection: { revision: selection.revision, pockets } });
  const selected = customCohortObservationMembers(preview, preview.selected, 'stock');
  const period = { ...preview.observation_period, date_basis: 'closing_date' };
  const privateCapture = retained.private_sales?.capture;
  const privateSales = privateCapture ? buildCustomCohortPrivateSalesObservations({ supplement: privateCapture,
    context_ref, effective_date: effective, observation_period: preview.observation_period,
    selection: { revision: selection.revision, account_ids: preview.selected.account_ids } }) : null;
  if (privateSales) check(['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']
    .every(key => privateSales.binding.target[key] === retained.subject.target[key]), 'private_target');
  const binding = { context_ref, selection_revision: selection.revision,
    selected_account_set_sha256: neighborhoodMemberSetDigest(preview.selected.account_ids), derived_at,
    ...(proposal ? { proposal_binding: proposal } : {}) };
  const geography = customCohortReportGeographyForReportedAssessment(report_geography, { target, binding });
  const sources = [geography.source], snapshots = [geography.source_snapshot], members = [], populations = [], statistics = [];
  const addSource = (id, payload, observed_at, provider) => {
    sources.push({ id, payload }); snapshots.push({ id, revision: '1', provider, content_sha256: digest(payload),
      visibility: 'assignment', scope: target.scope, valid_from: null, valid_to: null, observed_at, historical_availability: 'unknown' });
    return id;
  };
  function population(id, rows, capturedAt, payload, definition, account = false, membershipBasis = 'reviewed_source_record_matches') {
    const sourceId = addSource(`${id}:observations`, { reported_observation_source_version: 2, binding, ...payload }, capturedAt, definition);
    const added = rows.map(row => ({ population_id: id, member_unit: account ? 'account' : 'source_record',
      member_id: row.id, account_ids: row.accounts, member_data: { source_refs: [sourceId], ...row.data } }));
    members.push(...added);
    const captureId = addSource(`${id}:members`, { capture_type: 'neighborhood_population_members_v2', ...profile,
      population_id: id, member_unit: account ? 'account' : 'source_record', member_content_sha256: neighborhoodMemberContentDigest(added, profile) },
    capturedAt, 'Exact retained reported-observation member content');
    const p = { id, revision: String(selection.revision), kind: account ? 'account_observations' : 'source_record_observations',
      member_unit: account ? 'account' : 'source_record', definition,
      observation_period: account ? { start_date: capturedAt.slice(0, 10), end_date: capturedAt.slice(0, 10), date_basis: 'capture_date' } : period,
      captured_at: capturedAt, capture_source_ref: sourceId, temporal_basis: account ? 'current_cad_capture_reference' : 'reported_closing_dates_observed_at_capture',
      membership_basis: account ? 'retained_cad_accounts' : membershipBasis,
      completeness_basis: 'complete_retained_roster', provider_coverage: 'not_established', member_count: added.length,
      unique_account_count: new Set(added.flatMap(row => row.account_ids)).size,
      account_link_count: added.reduce((n, row) => n + row.account_ids.length, 0),
      member_set_sha256: neighborhoodMemberSetDigest(added.map(row => row.member_id)), members_resource_id: captureId,
      pocket_ids: [...selection.included_recorded_group_ids].sort(compare), completeness: 'complete', reasons: [], source_refs: [sourceId, captureId] };
    populations.push(p);
    statistics.push({ id: `${id}:count`, population_id: id, measurement: account ? 'account_count' : 'source_record_count',
      unit: account ? 'accounts' : 'source_records', estimator: 'count', estimator_parameters: {}, value: added.length,
      status: 'ready', reason: null, ...emptyCounts(), observed_count: added.length, denominator_count: added.length,
      denominator_basis: 'population_members', source_refs: [...p.source_refs] });
    return p;
  }
  function distribution(pop, measurement, metric) {
    const { unit, low, median, high, ...counts } = metric;
    check(Object.values(counts).reduce((sum, n) => sum + n, 0) === pop.member_count, 'metric_denominator');
    for (const [name, value] of [['low', low], ['median', median], ['high', high]]) {
      const unavailable = unit === null || counts.observed_count === 0;
      statistics.push({ id: `${pop.id}:${measurement}:${name}`, population_id: pop.id, measurement, unit,
        estimator: name === 'median' ? 'exact_median' : 'exact_quantile',
        estimator_parameters: name === 'median' ? {} : { convention: 'type_7', probability: name === 'low' ? 0 : 1 },
        value: unavailable ? null : value, status: unavailable ? 'incomplete' : 'ready',
        reason: unavailable ? unit === null ? 'reported_unit_not_established' : 'no_usable_reported_observations' : null,
        ...counts, denominator_count: pop.member_count, denominator_basis: 'population_members', source_refs: [...pop.source_refs] });
    }
  }
  const cad = population('selected-cad-accounts', selected.map(row => ({ id: row.account_id, accounts: [row.account_id],
    data: { captured_account_observations: row } })), preview.captured_at,
  { source_snapshots: preview.source_snapshots, source_basis: 'current_cad_observations_not_historical_housing_stock' },
  'Selected retained CAD accounts; current reported characteristics, not verified economic-property inventory', true);
  const year = Number(effective.slice(0, 4));
  for (const [field, name, unit] of [['gla_sqft', 'current_cad_living_area', 'ft2'], ['site_area_sqft', 'current_cad_parcel_area', 'ft2'],
    ['year_built', 'current_cad_year_built', 'year']]) {
    const cells = selected.map(row => {
      const cell = row.observations[field];
      return field === 'year_built' && cell.state === 'observed' && Number(cell.exact_value) > year
        ? { state: 'invalid', exact_value: null } : cell;
    });
    distribution(cad, name, accountMetric(cells, unit));
  }
  distribution(cad, 'current_cad_calendar_age', accountMetric(selected.map(row => {
    const cell = row.observations.year_built;
    if (cell.state !== 'observed') return cell;
    return Number(cell.exact_value) > year ? { state: 'invalid', exact_value: null }
      : { state: 'observed', exact_value: String(year - Number(cell.exact_value)) };
  }), 'years'));
  const shared = buildCustomCohortReportedSharedSales({ retained_inputs: retained, selected_account_ids: preview.selected.account_ids });
  const sharedSales = population('selected-shared-source-records', shared.rows, shared.captured_at,
    { source_snapshots: preview.source_snapshots, disposition_counts: shared.disposition_counts,
      source_basis: 'locally_stored_source_records_not_canonical_transactions' },
    'Selected locally stored closed source records; reported dates and full observed account associations, not verified sale events',
    false, 'retained_source_account_associations');
  for (const [measurement, metric] of Object.entries(shared.metrics)) distribution(sharedSales, measurement, metric);
  if (privateSales) {
    const dispositions = new Map(privateSales.rows.map(row => [row.receipt_id, row]));
    const rows = privateCapture.rows.filter(row => dispositions.get(row.receipt_id)?.disposition === 'included');
    check(rows.length === privateSales.selected.included_source_record_count, 'private_member_count');
    const sales = population('selected-private-source-records', rows.map(row => ({ id: `${privateCapture.batch.batch_id}:${row.receipt_id}`,
      accounts: row.review.account_ids, data: { retained_private_record: row,
        reported_close_date: row.record_data.values.close_date } })), privateSales.captured_at,
    { batch: privateSales.binding.batch, review: privateSales.binding.review, source_interpretation: privateSales.source_interpretation,
      disposition_counts: privateSales.selected.disposition_counts,
      partially_selected_full_account_set_count: privateSales.selected.partially_selected_full_account_set_count },
    'Reviewed assignment-private closed source records; full matched account sets retained, not canonical transactions');
    for (const [field, name] of [['close_price', 'reported_close_price'], ['current_price', 'reported_current_price'],
      ['reported_living_area', 'reported_living_area'], ['reported_site_area', 'reported_site_area'],
      ['reported_year_built', 'reported_year_built'], ['reported_days_on_market', 'reported_days_on_market']]) {
      distribution(sales, name, privateMetric(privateSales.selected.metrics[field]));
    }
  }
  const assessment = buildNeighborhoodAssessment({ contract_version: 2, id: identity.assessment_id, revision: identity.assessment_revision,
    scope: target.scope, effective_date: effective, data_cutoff: effective, generated_at: derived_at, observation_period: period,
    subject_facts: { basis: 'retained_subject_reference', authority: 'not_established' },
    methodology: { version: 'reported-observations-v2', geometry_version: 'appraiser-defined-observation-boundary-v1', configuration: REPORTED_OBSERVATION_PROFILE },
    source_snapshots: snapshots, discovery: { complete: true, basis: 'complete_retained_roster', provider_coverage: 'not_established' },
    selection: { revision: String(selection.revision), pocket_ids: [...selection.included_recorded_group_ids].sort(compare), overrides: [] },
    geographic_neighborhood: geography.geography, populations, statistics,
    required_population_ids: populations.map(pop => pop.id), required_statistic_ids: populations.map(pop => `${pop.id}:count`),
    development_evidence: { status: 'not_established', reasons: ['builder_HOA_and_development_facts_require_separate_evidence'] },
    diagnostics: { authority: 'not_established', limitations: ['reported_observations_not_verified_market_facts',
      'current_cad_capture_not_historical_stock', 'median_is_not_predominant_value', 'no_package_price_allocation',
      'selected_data_may_differ_from_broad_manual_boundary', 'dispersion_is_not_reliability',
      ...(privateSales ? [] : ['no_assignment_private_sales_capture'])] } });
  const publication = prepareNeighborhoodPublication(assessment, members, sources);
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment: publication.assessment, target: { ...target,
    attachment_id: identity.attachment_id, attachment_revision: identity.attachment_revision,
    workflow_type: 'custom_appraisal', uad_workfile_id: null, specification_release: null } });
  return freeze({ status: candidate.status, assessment: publication.assessment, publication_bundle: publication, candidate,
    issues: candidate.issues ?? [], binding });
}
