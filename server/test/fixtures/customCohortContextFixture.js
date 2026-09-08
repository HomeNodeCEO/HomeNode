import { prepareNeighborhoodCohortBlob as blob } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

export function contextFixture() {
  const uuid = tail => `10000000-0000-4000-8000-${tail.padStart(12, '0')}`;
  const dependency = blob('{"synthetic":true}');
  return { context_version: 1, context_id: uuid('5'), context_revision: '1', target: {
    organization_id: uuid('1'), report_file_id: uuid('2'), workflow_type: 'custom_appraisal',
    workflow_target_id: '9223372036854775807', account_id: '0000123-R', appraisal_case_id: uuid('3'),
    subject_snapshot_id: uuid('4'), snapshot_version: 1 }, effective_date: '2024-02-29',
  snapshot_evidence: { ...dependency }, subject_dependencies: { ...dependency },
  selection_input: { ...dependency }, study_input: { ...dependency } };
}
