import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentEvidenceDigest, buildNeighborhoodAssessment } from '../src/services/neighborhoodAssessment/contract.js';
import { buildNeighborhoodApplicationReceipt } from '../src/services/neighborhoodAssessment/applicationGroup.js';
import { prepareCustomNeighborhoodAcceptanceSnapshot } from '../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js';
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply, prepareCustomNeighborhoodReportReplacement,
  projectCustomNeighborhoodReportSection } from '../src/services/neighborhoodAssessment/customReportMapping.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from './fixtures/neighborhoodAssessmentFixture.js';

const uuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000001`;
function fixture() {
  const f = reportedObservationAssessmentFixture(), assessment = buildNeighborhoodAssessment(f.input);
  const old = buildCustomNeighborhoodReportCandidate({ assessment, target: f.target });
  assert.equal(old.status, 'ready');
  const first = prepareCustomNeighborhoodReportApply({ assessment, target: old.attachment,
    current_application_identity_sha256: old.attachment.application_identity_sha256, current_editor_revision: old.attachment.editor_revision,
    existing_values: old.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    request: { selected_ids: old.suggestions.map(item => item.id), binding_digest_sha256: old.attachment.binding_digest_sha256 } });
  const saved = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: old.attachment, mappedSuggestions: old.suggestions,
    actorUserId: uuid(7), operationId: uuid(8), receipt: buildNeighborhoodApplicationReceipt(first, f.target.editor_revision + 1) });
  const nextRaw = structuredClone(f.input); nextRaw.id = uuid(9); nextRaw.selection.revision = '2';
  nextRaw.geographic_neighborhood.cardinal_summaries.north = 'Explicitly revised north boundary';
  const nextAssessment = buildNeighborhoodAssessment(nextRaw), target = { ...f.target, attachment_id: uuid(10), editor_revision: saved.receipt.accepted_editor_revision };
  const next = buildCustomNeighborhoodReportCandidate({ assessment: nextAssessment, target });
  assert.equal(next.status, 'ready');
  const input = { assessment: nextAssessment, target: next.attachment, current_editor_revision: target.editor_revision,
    current_application_identity_sha256: next.attachment.application_identity_sha256,
    request: { selected_ids: next.suggestions.map(item => item.id), binding_digest_sha256: next.attachment.binding_digest_sha256 },
    existing_values: Object.values(saved.section_value.mapped_values).map(item => ({ ...item, target_exists: true, populated: true,
      provenance_digest: saved.receipt.acceptance_manifest.provenance_digest })),
    predecessor: { assessment, attachment: old.attachment, receipt: saved.receipt } };
  return { f, old, next, input, saved, first };
}

test('explicit v2 replacement applies all five ACTUAL occupied parts with a standard new receipt and section', () => {
  const { input, next, saved } = fixture(), before = structuredClone(input);
  const plan = prepareCustomNeighborhoodReportReplacement(input);
  assert.equal(plan.status, 'ready', JSON.stringify(plan)); assert.equal(plan.writes.length, 5);
  assert.equal(plan.acceptance_manifest.applied.length, 5); assert.deepEqual(plan.acceptance_manifest.reused, []);
  assert.equal(plan.acceptance_manifest.base_editor_revision, saved.receipt.accepted_editor_revision);
  const successor = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment: input.assessment, attachment: next.attachment,
    mappedSuggestions: next.suggestions, actorUserId: uuid(11), operationId: uuid(12),
    receipt: buildNeighborhoodApplicationReceipt(plan, input.current_editor_revision + 1) });
  assert.equal(successor.receipt.receipt_version, 1); assert.equal(successor.section_value.schema_version, 1);
  assert.equal(Object.keys(successor.section_value.decision.applied).length, 5);
  assert.notEqual(successor.section_value_sha256, saved.section_value_sha256);
  assert.equal(saved.section_value.actor_user_id, uuid(7)); assert.equal(successor.section_value.actor_user_id, uuid(11));
  assert.deepEqual(input, before); assert.ok(Object.isFrozen(plan.writes[0]));
  const projected = projectCustomNeighborhoodReportSection({ section: successor.section_value, expected: {
    organization_id: input.assessment.scope.organization_id, report_file_id: input.target.report_file_id,
    assignment_file_id: input.target.custom_assignment_file_id, account_id: input.assessment.scope.account_id } });
  assert.equal(projected.status, 'ready'); assert.deepEqual(projected.assessment, input.assessment);
  const defaultPlan = prepareCustomNeighborhoodReportApply(input);
  assert.equal(defaultPlan.status, 'conflict'); assert.deepEqual(defaultPlan.writes, []);
});

for (const [name, mutate] of [
  ['old value', x => { x.existing_values[0].value = 'manual unrelated field'; }],
  ['old provenance', x => { x.existing_values[0].provenance_digest = 'a'.repeat(64); }],
  ['missing part', x => { x.existing_values.pop(); }],
  ['extra part', x => { x.existing_values.push({ ...x.existing_values[0], target_key: 'custom_neighborhood:other' }); }],
  ['duplicate part', x => { x.existing_values[0] = x.existing_values[1]; }],
  ['fake empty slot', x => { x.existing_values[0].populated = false; }],
  ['missing target', x => { x.existing_values[0].target_exists = false; }],
  ['partial new selection', x => { x.request.selected_ids.pop(); }],
  ['foreign report', x => { x.target.report_file_id = uuid(91); }],
  ['foreign assignment', x => { x.target.custom_assignment_file_id = 92; }],
  ['foreign scope', x => { x.target.scope.subject_snapshot_id = uuid(93); }],
  ['stale editor', x => { x.current_editor_revision++; }],
  ['stale binding', x => { x.request.binding_digest_sha256 = 'a'.repeat(64); }],
  ['changed identity', x => { x.current_application_identity_sha256 = 'b'.repeat(64); }],
  ['missing receipt', x => { x.predecessor.receipt = null; }],
  ['altered old receipt', x => { x.predecessor.receipt.accepted_editor_revision++; }],
  ['forged old attachment', x => { x.predecessor.attachment.attachment_id = uuid(94); }],
  ['old v1 relabel', x => { x.predecessor.assessment.contract_version = 1; }],
  ['new v1 relabel', x => { x.assessment.contract_version = 1; }],
  ['UAD target', x => { x.target.workflow_type = 'uad_3_6'; x.target.uad_workfile_id = uuid(95); }],
]) test(`${name} prevents every replacement write`, () => {
  const input = structuredClone(fixture().input); mutate(input);
  const result = prepareCustomNeighborhoodReportReplacement(input);
  assert.equal(result.status, 'conflict'); assert.deepEqual(result.writes, []); assert.equal(result.acceptance_manifest, null);
});

test('receipt and populated values cannot replace themselves as a new application', () => {
  const { input, old } = fixture(); input.assessment = input.predecessor.assessment; input.target = old.attachment;
  input.current_application_identity_sha256 = old.attachment.application_identity_sha256;
  input.request.binding_digest_sha256 = old.attachment.binding_digest_sha256;
  assert.equal(prepareCustomNeighborhoodReportReplacement(input).status, 'conflict');
});

test('explicit entry does not admit a genuine v1 predecessor', () => {
  const { input } = fixture(), assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const old = buildCustomNeighborhoodReportCandidate({ assessment, target: neighborhoodTargetFixture('custom_appraisal') });
  assert.equal(old.status, 'ready'); input.predecessor = { ...input.predecessor, assessment, attachment: old.attachment };
  assert.equal(prepareCustomNeighborhoodReportReplacement(input).status, 'conflict');
});

test('replacement is invariant to actual occupied row order and does not recalculate unchanged measures', () => {
  const { input } = fixture(), first = prepareCustomNeighborhoodReportReplacement(input);
  input.existing_values.reverse(); input.request.selected_ids.reverse();
  const reordered = prepareCustomNeighborhoodReportReplacement(input);
  assert.deepEqual(reordered, first);
  assert.deepEqual(first.writes.find(item => item.target_key === 'custom_neighborhood:statistics').value,
    input.predecessor.assessment.statistics);
  assert.notEqual(first.acceptance_manifest.provenance_digest, input.predecessor.receipt.acceptance_manifest.provenance_digest);
  assert.equal(assessmentEvidenceDigest(input.predecessor.assessment.statistics), assessmentEvidenceDigest(input.assessment.statistics));
});
