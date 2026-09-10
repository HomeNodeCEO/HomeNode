import { buildNeighborhoodAssessment } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildNeighborhoodApplicationReceipt } from '../../src/services/neighborhoodAssessment/applicationGroup.js';
import { prepareCustomNeighborhoodAcceptanceSnapshot } from '../../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply, projectCustomNeighborhoodReportSection } from '../../src/services/neighborhoodAssessment/customReportMapping.js';
import { reportedObservationAssessmentFixture } from './reportedObservationAssessmentFixture.js';
import { customAppraisalReportFixture } from './customAppraisalReportFixture.js';

/** Explicit synthetic v2 evidence through the real five-part Apply/snapshot and
 * projector. This fixture supplies no source, topology, signature or auth grant. */
export function reportedObservationReportFixture(mutateRaw) {
  const { snapshot, property } = customAppraisalReportFixture();
  const fixture = reportedObservationAssessmentFixture();
  fixture.input.scope.account_id = property.account.account_id;
  for (const source of fixture.input.source_snapshots) source.scope.account_id = property.account.account_id;
  mutateRaw?.(fixture.input);
  const assessment = buildNeighborhoodAssessment(fixture.input);
  const target = { ...fixture.target, scope: assessment.scope, custom_assignment_file_id: snapshot.assignment_file_id };
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target });
  if (candidate.status !== 'ready') throw new Error(JSON.stringify(candidate));
  const plan = prepareCustomNeighborhoodReportApply({ assessment, target,
    existing_values: candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    request: { selected_ids: candidate.suggestions.map(item => item.id), binding_digest_sha256: candidate.attachment.binding_digest_sha256 },
    current_application_identity_sha256: candidate.attachment.application_identity_sha256, current_editor_revision: target.editor_revision });
  if (plan.status !== 'ready') throw new Error(JSON.stringify(plan));
  const operationId = 'abcdef01-0000-4000-8000-000000000001';
  const saved = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: candidate.attachment,
    mappedSuggestions: candidate.suggestions, operationId, actorUserId: 'abcdef02-0000-4000-8000-000000000002',
    receipt: buildNeighborhoodApplicationReceipt(plan, target.editor_revision + 1) });
  const section = { value: structuredClone(saved.section_value), revision: saved.section_value.accepted_editor_revision };
  const expected = { organization_id: assessment.scope.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: snapshot.assignment_file_id, account_id: assessment.scope.account_id };
  const projected = projectCustomNeighborhoodReportSection({ section: section.value, expected });
  snapshot.assignment.organization_id = assessment.scope.organization_id;
  snapshot.signature = { organization_id: assessment.scope.organization_id };
  snapshot.sections.neighborhood_assessment = section;
  snapshot.evidence = { ...snapshot.evidence, property_report_data: property, report_files: [{ id: target.report_file_id,
    organization_id: assessment.scope.organization_id, account_id: assessment.scope.account_id, workflow_type: 'custom_appraisal',
    custom_assignment_file_id: snapshot.assignment_file_id, uad_workfile_id: null, tax_protest_file_id: null }] };
  const response = { ok: true, account_id: expected.account_id, neighborhood: { status: 'accepted', account_id: expected.account_id,
    assignment_file_id: expected.assignment_file_id, report_file_id: expected.report_file_id, report_projection: projected,
    acceptance: { organizationId: expected.organization_id, assignmentFileId: expected.assignment_file_id, reportFileId: expected.report_file_id,
      acceptedEditorRevision: section.revision, operationId, attachmentId: section.value.attachment_id,
      attachmentRevision: section.value.attachment_revision, snapshot: saved } } };
  return { snapshot, property, assessment, target, projected, section, response, match: { response, section,
    accountId: expected.account_id, assignmentFileId: expected.assignment_file_id } };
}
