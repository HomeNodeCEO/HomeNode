import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNeighborhoodAssessment } from '../src/services/neighborhoodAssessment/contract.js';
import { buildNeighborhoodApplicationReceipt } from '../src/services/neighborhoodAssessment/applicationGroup.js';
import { prepareCustomNeighborhoodAcceptanceSnapshot } from '../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply,
  projectCustomNeighborhoodReportSection, CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION } from '../src/services/neighborhoodAssessment/customReportMapping.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';

function mapped() {
  const fixture = reportedObservationAssessmentFixture(), assessment = buildNeighborhoodAssessment(fixture.input);
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target: fixture.target });
  assert.equal(candidate.status, 'ready', JSON.stringify(candidate));
  const input = { assessment, target: fixture.target,
    existing_values: candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    request: { selected_ids: candidate.suggestions.map(item => item.id), binding_digest_sha256: candidate.attachment.binding_digest_sha256 },
    current_application_identity_sha256: candidate.attachment.application_identity_sha256,
    current_editor_revision: fixture.target.editor_revision };
  const plan = prepareCustomNeighborhoodReportApply(input);
  assert.equal(plan.status, 'ready', JSON.stringify(plan));
  const snapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: candidate.attachment,
    mappedSuggestions: candidate.suggestions, operationId: 'abcdef01-0000-4000-8000-000000000002',
    actorUserId: 'abcdef02-0000-4000-8000-000000000002', receipt: buildNeighborhoodApplicationReceipt(plan, fixture.target.editor_revision + 1) });
  return { assessment, candidate, input, snapshot, expected: { organization_id: assessment.scope.organization_id,
    report_file_id: fixture.target.report_file_id, assignment_file_id: fixture.target.custom_assignment_file_id,
    account_id: assessment.scope.account_id } };
}

test('reported-observation group uses an independent mapper and exact five-part saved projection', () => {
  const value = mapped();
  assert.equal(value.candidate.mapper_version, CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION);
  assert.equal(value.candidate.suggestions.length, 5);
  const projected = projectCustomNeighborhoodReportSection({ section: value.snapshot.section_value, expected: value.expected });
  assert.equal(projected.status, 'ready');
  assert.equal(projected.mapper_version, CUSTOM_REPORTED_OBSERVATION_MAPPER_VERSION);
  assert.deepEqual(projected.assessment, value.assessment);
  assert.equal(projected.assessment.statistics.find(item => item.id === 'reported-price-median').value, '282500.01');
  assert.equal(projected.assessment.statistics.find(item => item.id === 'reported-dom-median').value, '0');
  assert.equal(projected.assessment.populations[0].member_unit, 'account');
  assert.ok(projected.assessment.populations.every(item => !Object.hasOwn(item, 'unique_property_count')));
});

for (const field of ['geography', 'selection', 'populations', 'statistics', 'evidence']) {
  test(`reported observations cannot apply without ${field}`, () => {
    const { input } = mapped();
    input.request.selected_ids = input.request.selected_ids.filter(id => id !== `custom-neighborhood-report:${field}`);
    const result = prepareCustomNeighborhoodReportApply(input);
    assert.equal(result.status, 'conflict'); assert.deepEqual(result.writes, []);
  });
}

test('old mapper label cannot disguise the reported-observation group', () => {
  const value = mapped(), section = structuredClone(value.snapshot.section_value);
  section.mapped_values['custom-neighborhood-report:evidence'].value.mapper_version = 'custom-neighborhood-report-v1';
  const result = projectCustomNeighborhoodReportSection({ section, expected: value.expected });
  assert.equal(result.status, 'unavailable'); assert.equal(result.assessment, null);
});

test('reported-observation candidate is Custom-only and stale/manual occupancy is not overwritten', () => {
  const { assessment, input } = mapped();
  assert.equal(buildCustomNeighborhoodReportCandidate({ assessment, target: { ...input.target,
    workflow_type: 'uad_3_6', custom_assignment_file_id: null, uad_workfile_id: '10000000-0000-4000-8000-000000000001' } }).status, 'incomplete');
  input.existing_values[0] = { ...input.existing_values[0], populated: true, value: 'appraiser edit', provenance_digest: null };
  assert.equal(prepareCustomNeighborhoodReportApply(input).status, 'conflict');
});
