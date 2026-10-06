import { canonicalAssessmentJson } from './contract.js';
import { decodeNeighborhoodOriginalValue } from './originalValueDecoding.js';

const same = (left, right) => canonicalAssessmentJson(left) === canonicalAssessmentJson(right);
function fail(reason = 'checkpoint_conflict') {
  throw Object.assign(new Error(`custom_cohort_capture_${reason}`), {
    code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason,
  });
}
function closed(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail();
}
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** Resume only original subject-stage evidence, never a source grant. The
 * transaction owner must first reload current actor/assignment rights and read
 * this checkpoint from the exact live fenced job. Repositories are already
 * bound to that organization/report/account. Missing or changed originals
 * refuse the retry; they are not replaced by a new subject under the same job.
 */
export async function resumeCustomCohortSubjectCheckpoint({ checkpoint, blobs, subjects,
  input, study, reportedProfile, housingProfile }) {
  closed(checkpoint, ['phase', 'evidence_refs']);
  if (checkpoint.phase !== 'subject' || !Array.isArray(checkpoint.evidence_refs)
    || checkpoint.evidence_refs.length !== 1) fail();
  const reference = checkpoint.evidence_refs[0];
  closed(reference, ['content_sha256', 'canonical_utf8_bytes']);
  const text = await blobs.get(reference.content_sha256, reference.canonical_utf8_bytes);
  if (text === null) fail();
  const body = JSON.parse(text);
  closed(body, ['intent_version', 'operation_id', 'actor_user_id', 'subject_inputs',
    'target', 'effective_date', 'study', 'created_at', 'recorded_housing_interpretation',
    ...(reportedProfile ? ['reported_sale_interpretation'] : []),
    ...(input.privateSalesImport ? ['private_sales_import'] : [])]);
  if (body.intent_version !== (input.privateSalesImport ? 2 : 1) + (reportedProfile ? 2 : 0) + 4
    || body.operation_id !== input.operationId || body.actor_user_id !== input.auth.userId
    || !same(body.study, study)
    || !same(body.recorded_housing_interpretation, housingProfile)
    || (reportedProfile && !same(body.reported_sale_interpretation, reportedProfile))
    || (input.privateSalesImport && !same(body.private_sales_import, input.privateSalesImport))
    || decodeNeighborhoodOriginalValue('utc6', 'present', body.created_at).status !== 'decoded') fail();
  const subjectReference = body.subject_inputs;
  const subject = await subjects.load(subjectReference);
  if (!same(body.target, subject.target) || body.effective_date !== subject.effective_date
    || study.observation_period.end_date > subject.effective_date) fail();
  if ((await subjects.compareCurrent(subjectReference)).status !== 'matched') fail('subject_changed');
  const point = await subjects.loadRecordedPoint(subjectReference);
  if (point.status !== 'represented') fail('recorded_point_required');
  return freeze({ subject, subjectReference, point, intent: { reference, body } });
}
