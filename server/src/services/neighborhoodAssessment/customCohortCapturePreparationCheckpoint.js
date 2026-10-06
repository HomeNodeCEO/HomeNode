import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextHeader } from './customCohortContextContract.js';
import { resumeCustomCohortSubjectCheckpoint } from './customCohortCaptureSubjectCheckpoint.js';

const same = (left, right) => canonicalAssessmentJson(left) === canonicalAssessmentJson(right);
function fail() {
  throw Object.assign(new Error('custom_cohort_capture_checkpoint_conflict'), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: 'checkpoint_conflict',
  });
}

/** A staged header is not a registered context or a source grant. The owner
 * must first reload current actor/assignment rights and read this checkpoint
 * from the exact live fenced job. It must then authorize the original source
 * purpose before loading/validating the complete immutable graph, and recheck
 * all publication fences before registering any context.
 */
export async function resumeCustomCohortPreparationCheckpoint(options) {
  const { checkpoint, blobs, input } = options;
  if (!checkpoint || Object.getPrototypeOf(checkpoint) !== Object.prototype
    || Object.keys(checkpoint).length !== 2 || checkpoint.phase !== 'preparation'
    || !Array.isArray(checkpoint.evidence_refs) || checkpoint.evidence_refs.length !== 2) fail();
  const resumed = await resumeCustomCohortSubjectCheckpoint({ ...options,
    checkpoint: { phase: 'subject', evidence_refs: [checkpoint.evidence_refs[0]] } });
  const headerRef = checkpoint.evidence_refs[1];
  if (!headerRef || Object.getPrototypeOf(headerRef) !== Object.prototype
    || Object.keys(headerRef).length !== 2
    || !Object.hasOwn(headerRef, 'content_sha256') || !Object.hasOwn(headerRef, 'canonical_utf8_bytes')) fail();
  const text = await blobs.get(headerRef.content_sha256, headerRef.canonical_utf8_bytes);
  if (text === null) fail();
  const stagedHeader = prepareCustomCohortContextHeader(text);
  const t = resumed.subject.target;
  const expectedTarget = { organization_id: t.organization_id, report_file_id: t.report_file_id,
    workflow_type: 'custom_appraisal', workflow_target_id: t.assignment_file_id,
    account_id: t.account_id, appraisal_case_id: t.appraisal_case_id,
    subject_snapshot_id: t.subject_snapshot_id, snapshot_version: t.snapshot_version };
  if (!same(stagedHeader.header_blob.ref, headerRef)
    || stagedHeader.body.context_id !== input.operationId
    || !same(stagedHeader.body.target, expectedTarget)
    || stagedHeader.body.effective_date !== resumed.subject.effective_date
    || !same(stagedHeader.body.snapshot_evidence, resumed.subject.snapshot_evidence)) fail();
  return Object.freeze({ ...resumed, stagedHeader });
}
