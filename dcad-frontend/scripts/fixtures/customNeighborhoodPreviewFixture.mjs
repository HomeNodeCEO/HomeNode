// TEST ONLY: explicit synthetic records normalized by the existing pure core
// builder. This fixture has no reader, provider, assignment API or DB dependency.
import { buildNeighborhoodAssessment, assessmentEvidenceDigest } from '../../../server/src/services/neighborhoodAssessment/contract.js';
import { neighborhoodAssessmentFixture } from '../../../server/test/fixtures/neighborhoodAssessmentFixture.js';

export const copyCustomFixture = value => JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values)].sort();
const reference = assessment => ({ id: assessment.id, revision: assessment.revision,
  evidence_digest_sha256: assessment.evidence_digest_sha256 });

export function customControllerForAssessment(assessment) {
  const request = { target_key: 'custom:target-A', operation_key: 'custom:operation-1', preview_key: 'custom:preview-1' };
  return {
    custom_inspection_version: 1,
    current: { ...request, access: 'review', read_only: false, dirty: false, spatial_review: 'clear',
      actions: { refresh: true, open_review: true, edit_area: true } },
    load: 'complete', subject_label: 'Synthetic subject — Cedar "Court"',
    expected: { request_context: { ...request }, assignment_file_id: 73, account_id: assessment.scope.account_id,
      workfile_key: 'custom-workfile:opaque:73', scope: copyCustomFixture(assessment.scope),
      assessment_reference: reference(assessment), effective_date: assessment.effective_date,
      data_cutoff: assessment.data_cutoff, observation_period: copyCustomFixture(assessment.observation_period) },
  };
}

/** Independently extract the actual formatter contract from normalized core
 * records. This is a test expectation, never a replacement formatter. */
export function customFormatterInput(assessment) {
  return copyCustomFixture({ display_input_version: 1, source_contract_version: 1, records_kind: 'all_core_records',
    assessment_reference: reference(assessment), scope: assessment.scope,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff,
    observation_period: assessment.observation_period, populations: assessment.populations,
    statistics: assessment.statistics, source_snapshots: assessment.source_snapshots,
    required_evidence_keys: unique(['geographic_neighborhood',
      ...assessment.required_population_ids.map(id => `population:${id}`),
      ...assessment.required_statistic_ids.map(id => `statistic:${id}`),
      ...assessment.application_group.population_refs.map(row => `population:${row.id}`),
      ...assessment.application_group.required_statistic_ids.map(id => `statistic:${id}`),
      ...assessment.application_group.source_refs.map(id => `source:${id}`),
      ...assessment.geographic_neighborhood.perimeter.flatMap(edge => edge.source_refs.map(id => `source:${id}`))]),
  });
}

export function expectedCustomDisplayNotice(assessment) {
  const basis = { closing_date: 'closing date', contract_date: 'contract date', status_as_of: 'status as of', effective_date: 'effective date' };
  return 'Supplied core population, statistic and source records; this is not a complete assessment display. '
    + `Observation date basis: ${basis[assessment.observation_period.date_basis]}. Values and statuses were supplied by the producer. This preview does not verify sources or authorize report changes.`;
}

export function makeCustomNeighborhoodPreviewFixture({ zeroSales = false, incompleteGeography = false, mutateRaw } = {}) {
  const raw = neighborhoodAssessmentFixture();
  const publicSource = raw.source_snapshots[0];
  const organizationScope = { ...raw.scope, appraisal_case_id: '20000000-0000-4000-8000-000000000002',
    subject_snapshot_id: '30000000-0000-4000-8000-000000000002', account_id: 'SYNTHETIC-OTHER-CASE' };
  raw.source_snapshots.push(
    { ...copyCustomFixture(publicSource), id: 'organization:source', visibility: 'organization', scope: organizationScope },
    { ...copyCustomFixture(publicSource), id: 'assignment:source', visibility: 'assignment', scope: { ...raw.scope } },
    { ...copyCustomFixture(publicSource), id: 'boundary:only', provider: 'synthetic-boundary-record' },
    { ...copyCustomFixture(publicSource), id: 'optional:late', observed_at: '2026-09-05T00:00:00.000Z' },
    { ...copyCustomFixture(publicSource), id: 'optional:unknown', valid_from: null, historical_availability: 'unknown' },
    { ...copyCustomFixture(publicSource), id: 'shared', provider: 'synthetic-independent-namespace' },
  );
  const stock = raw.populations.find(p => p.kind === 'competitive_stock');
  Object.assign(stock, { member_count: 10, unique_property_count: 10, property_link_count: 10,
    member_set_sha256: assessmentEvidenceDigest(Array.from({ length: 10 }, (_, i) => `C${i + 1}`)),
    definition: 'Ten eligible properties in the supplied competitive stock.', source_refs: ['fixture-source', 'assignment:source'] });
  const geographic = { ...copyCustomFixture(stock), id: 'shared', kind: 'geographic_stock', member_count: 6,
    unique_property_count: 6, property_link_count: 6, definition: 'Six properties in the supplied descriptive neighborhood.',
    member_set_sha256: assessmentEvidenceDigest(['G1', 'G2', 'G3', 'G4', 'G5', 'G6']), members_resource_id: 'members:geographic:1',
    source_refs: ['fixture-source', 'organization:source', 'shared'] };
  raw.populations.push(geographic);
  raw.required_population_ids.push('shared');
  const prototype = copyCustomFixture(raw.statistics[0]);
  raw.statistics.push(
    { ...copyCustomFixture(prototype), id: 'price-low', estimator: 'exact_quantile',
      estimator_parameters: { convention: 'type_7', probability: 0 }, value: 300000 },
    { ...copyCustomFixture(prototype), id: 'price-high', estimator: 'exact_quantile',
      estimator_parameters: { convention: 'type_7', probability: 1 }, value: 390000 },
    { ...copyCustomFixture(prototype), id: 'sale-count', measurement: 'transaction_count', unit: 'transactions', estimator: 'count', value: 3 },
    { ...copyCustomFixture(prototype), id: 'shared', population_id: 'shared', measurement: 'property_count', unit: 'properties',
      estimator: 'count', value: 6, observed_count: 6, denominator_count: 6 },
    { ...copyCustomFixture(prototype), id: 'year-built', population_id: stock.id, measurement: 'year_built', unit: 'year',
      value: 2004, observed_count: 10, denominator_count: 10 },
    { ...copyCustomFixture(prototype), id: 'zero-data-coverage', population_id: stock.id, measurement: 'data_coverage_percent',
      unit: 'percent', estimator: 'ratio', estimator_parameters: { numerator_count: 0 }, value: 0,
      observed_count: 0, missing_count: 10, denominator_count: 10 },
    { ...copyCustomFixture(prototype), id: 'sale-coverage', population_id: stock.id, measurement: 'sale_coverage_percent',
      unit: 'percent', estimator: 'ratio', estimator_parameters: { numerator_count: 2 }, value: 20,
      observed_count: 10, missing_count: 0, denominator_count: 10 },
  );
  raw.required_statistic_ids.push('sale-count', 'shared');
  raw.geographic_neighborhood.cardinal_summaries.north = 'North "Cedar" Road \\ Creek — 雪';
  raw.geographic_neighborhood.perimeter[0].source_refs.push('boundary:only');
  if (zeroSales) {
    const sales = raw.populations.find(p => p.kind === 'transactions');
    Object.assign(sales, { member_count: 0, unique_property_count: 0, property_link_count: 0,
      member_set_sha256: assessmentEvidenceDigest([]), definition: 'Verified synthetic empty transaction population.' });
    for (const statistic of raw.statistics.filter(s => s.population_id === sales.id)) {
      Object.assign(statistic, { observed_count: 0, missing_count: 0, denominator_count: 0 });
      if (statistic.estimator === 'count') statistic.value = 0;
      else if (statistic.estimator !== 'unsupported') Object.assign(statistic,
        { value: null, status: 'incomplete', reason: 'no_eligible_sales_in_supplied_period' });
    }
    const coverage = raw.statistics.find(s => s.id === 'sale-coverage');
    Object.assign(coverage, { value: 0, estimator_parameters: { numerator_count: 0 } });
  }
  if (incompleteGeography) {
    Object.assign(raw.geographic_neighborhood, { status: 'incomplete', reasons: ['missing_west_road_evidence', 'synthetic_hole_not_reviewed'] });
    raw.geographic_neighborhood.cardinal_summaries.west = null;
    Object.assign(raw.geographic_neighborhood.validation, { valid: null, contains_subject: null });
  }
  mutateRaw?.(raw);
  const assessment = buildNeighborhoodAssessment(raw);
  return { raw, assessment, controller: customControllerForAssessment(assessment), formatterInput: customFormatterInput(assessment) };
}
