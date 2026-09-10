import { assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodMemberContentDigest, neighborhoodMemberSetDigest } from '../../src/services/neighborhoodAssessment/assessmentRepository.js';
import { REPORTED_OBSERVATION_PROFILE, REPORTED_OBSERVATION_PROFILE_ID } from '../../src/services/neighborhoodAssessment/reportedObservationContract.js';

export const REPORTED_OBSERVATION_SCOPE = Object.freeze({ organization_id: '10000000-0000-4000-8000-000000000001',
  appraisal_case_id: '20000000-0000-4000-8000-000000000001', subject_snapshot_id: '30000000-0000-4000-8000-000000000001',
  account_id: 'SYNTHETIC-P1' });

/** Synthetic native-v2 fixture, not a relabeled v1 capture or production input.
 * Numeric observations and unknown historical/source authority are deliberate. */
export function reportedObservationAssessmentFixture({ scope = REPORTED_OBSERVATION_SCOPE, effectiveDate = '2026-09-10',
  accountIds = [scope.account_id, 'SYNTHETIC-P2'] } = {}) {
  const accounts = [...new Set(accountIds)].sort();
  if (!accounts.length || accounts.length > 5) throw new TypeError('fixture_accounts');
  const captured = `${effectiveDate}T12:00:00.123456Z`, generated = `${effectiveDate}T13:00:00.000000Z`;
  const period = { start_date: `${effectiveDate.slice(0, 4)}-01-01`, end_date: effectiveDate, date_basis: 'closing_date' };
  const observed = { id: 'observed-source', payload: { observation_fixture_version: 2,
    basis: 'synthetic_current_CAD_and_reported_CSV', captured_at: captured } };
  const members = accounts.map(account_id => ({ population_id: 'accounts', member_id: account_id, member_unit: 'account',
    account_ids: [account_id], member_data: { source_refs: [observed.id], current_cad_living_area: '1800',
      observation_basis: 'retained_account_not_economic_property' } }));
  members.push({ population_id: 'records', member_id: 'batch:synthetic:receipt:1', member_unit: 'source_record',
    account_ids: accounts, member_data: { source_refs: [observed.id], reported_close_date: effectiveDate,
      reported_close_price: '282500.01', reported_living_area: '1800', reported_days_on_market: 0,
      observation_basis: 'source_record_not_canonical_transaction' } });
  const captures = ['accounts', 'records'].map(population_id => {
    const rows = members.filter(row => row.population_id === population_id);
    return { id: `members-${population_id}`, payload: { capture_type: 'neighborhood_population_members_v2',
      contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID, population_id, member_unit: rows[0].member_unit,
      member_content_sha256: neighborhoodMemberContentDigest(rows, { contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID }) } };
  });
  const sources = [observed, ...captures];
  const source_snapshots = sources.map(source => ({ id: source.id, revision: '1', provider: 'Synthetic recorded observations',
    content_sha256: assessmentEvidenceDigest(source.payload), visibility: 'assignment', scope: { ...scope },
    valid_from: null, valid_to: null, observed_at: captured, historical_availability: 'unknown' }));
  const populations = ['accounts', 'records'].map(id => {
    const stock = id === 'accounts', rows = members.filter(row => row.population_id === id);
    return { id, revision: '1', kind: stock ? 'account_observations' : 'source_record_observations',
      member_unit: stock ? 'account' : 'source_record', definition: stock ? 'Retained CAD-account observations, not eligible housing inventory'
        : 'Source-reported records, not canonical transactions or a complete market census',
      observation_period: stock ? { start_date: effectiveDate, end_date: effectiveDate, date_basis: 'capture_date' } : { ...period },
      captured_at: captured, capture_source_ref: observed.id,
      temporal_basis: stock ? 'current_cad_capture_reference' : 'reported_closing_dates_observed_at_capture',
      membership_basis: stock ? 'retained_cad_accounts' : 'reviewed_source_record_matches',
      completeness_basis: 'complete_retained_roster', provider_coverage: 'not_established', member_count: rows.length,
      unique_account_count: accounts.length, account_link_count: rows.reduce((n, row) => n + row.account_ids.length, 0),
      member_set_sha256: neighborhoodMemberSetDigest(rows.map(row => row.member_id)), members_resource_id: `members-${id}`,
      pocket_ids: ['recorded-pocket'], completeness: 'complete', reasons: [], source_refs: [observed.id, `members-${id}`] };
  });
  const metric = (id, population_id, measurement, unit, value, estimator = 'exact_median') => {
    const p = populations.find(population => population.id === population_id);
    return { id, population_id, measurement, unit, estimator, estimator_parameters: {}, value, status: 'ready', reason: null,
      observed_count: p.member_count, missing_count: 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0,
      denominator_count: p.member_count, denominator_basis: 'population_members', source_refs: [...p.source_refs] };
  };
  const input = { contract_version: 2, id: '40000000-0000-4000-8000-000000000002', revision: 1,
    scope: { ...scope }, effective_date: effectiveDate, data_cutoff: effectiveDate, generated_at: generated, observation_period: period,
    subject_facts: { basis: 'retained_subject_reference', authority: 'not_established' },
    methodology: { version: 'reported-observations-v2', geometry_version: 'appraiser-defined-observation-boundary-v1',
      configuration: { ...REPORTED_OBSERVATION_PROFILE } }, source_snapshots,
    discovery: { complete: true, basis: 'complete_retained_roster', provider_coverage: 'not_established' },
    selection: { revision: '1', pocket_ids: ['recorded-pocket'], overrides: [] },
    geographic_neighborhood: { basis: 'appraiser_defined_observation_boundary', manual_source: 'appraiser_defined_area_manual_v2',
      status: 'ready', reasons: [], revision: 'manual-1', crs: 'EPSG:4326',
      geometry: { type: 'Polygon', coordinates: [[[-97.01, 32.99], [-96.99, 32.99], [-96.99, 33.01], [-97.01, 33.01], [-97.01, 32.99]]] },
      perimeter: [1, 2, 3, 4].map(n => ({ edge_id: `edge-${n}`, from_node: `node-${n}`, to_node: `node-${n % 4 + 1}`,
        name: null, source_refs: [observed.id] })),
      validation: { valid: true, connected: true, covers_recorded_subject_point: true, engine: 'synthetic-native-observation', revision: '1' },
      cardinal_summaries: { north: 'Appraiser north boundary', east: 'Appraiser east boundary', south: 'Appraiser south boundary', west: 'Appraiser west boundary' } },
    populations, statistics: [metric('account-count', 'accounts', 'account_count', 'accounts', accounts.length, 'count'),
      metric('record-count', 'records', 'source_record_count', 'source_records', 1, 'count'),
      metric('reported-price-median', 'records', 'reported_close_price', 'USD', '282500.01'),
      metric('reported-dom-median', 'records', 'reported_days_on_market', 'days', '0')],
    required_statistic_ids: ['account-count', 'record-count'], required_population_ids: ['accounts', 'records'],
    development_evidence: { status: 'not_established', reasons: ['not_researched'] },
    diagnostics: { authority: 'not_established', limitations: ['reported_observations_not_verified_market_facts', 'historical_stock_not_established'] } };
  const target = { attachment_id: '50000000-0000-4000-8000-000000000002', attachment_revision: 1,
    effective_date: effectiveDate, data_cutoff: effectiveDate, scope: { ...scope }, report_file_id: '60000000-0000-4000-8000-000000000002',
    workflow_type: 'custom_appraisal', custom_assignment_file_id: 1, uad_workfile_id: null, editor_revision: 5,
    source_digest_sha256: assessmentEvidenceDigest({ fixture: 'reported-observations-v2' }),
    mapped_manifest_sha256: assessmentEvidenceDigest({ fixture: 'reported-mapper' }),
    mapper_version: 'synthetic-custom-reported-observations-v2', specification_release: null };
  return { input, members, sources, target };
}
