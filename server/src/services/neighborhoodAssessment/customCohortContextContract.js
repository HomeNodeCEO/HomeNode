import { createHash } from 'node:crypto';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET_KEYS = ['organization_id', 'report_file_id', 'workflow_type', 'workflow_target_id',
  'account_id', 'appraisal_case_id', 'subject_snapshot_id', 'snapshot_version'];
const EVIDENCE_KEYS = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
function fail(reason) { throw Object.assign(new Error(`custom_cohort_context_${reason}`), { code: `custom_cohort_context_${reason}` }); }
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail('invalid_shape');
}
function uuid(value) { if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) fail('invalid_identity'); }
function assignment(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('invalid_identity');
}
function account(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_identity');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonicalValue(text, limit) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > limit) fail('input_limit');
  // Scan original tokens before parsing. In particular duplicate keys, rounded
  // numeric identifiers and noncanonical JSON must not acquire a new identity.
  prepareNeighborhoodCohortBlob(text);
  return JSON.parse(text);
}
export function prepareCustomCohortContextScope(canonicalJson) {
  const scope = canonicalValue(canonicalJson, 4096);
  closed(scope, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
  uuid(scope.organization_id); uuid(scope.report_file_id); assignment(scope.assignment_file_id); account(scope.account_id);
  return freeze(scope);
}
export function prepareCustomCohortContextReference(canonicalJson) {
  const value = canonicalValue(canonicalJson, 4096);
  closed(value, ['context_id', 'context_revision', 'context_sha256']);
  uuid(value.context_id);
  if (value.context_revision !== '1' || typeof value.context_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.context_sha256)) fail('invalid_reference');
  return freeze(value);
}

/** Exact c74 context HEADER representation only. This does not establish fresh
 * authorization, material/source truth, installed profiles, acquisition closure,
 * current selection, or fact-issuer authority. The private runtime must validate
 * those dependencies before using this header; never expose this as a public API.
 */
export function prepareCustomCohortContextHeader(canonicalJson) {
  const body = canonicalValue(canonicalJson, 128_000);
  closed(body, ['context_version', 'context_id', 'context_revision', 'target', 'effective_date', ...EVIDENCE_KEYS]);
  if (body.context_version !== 1 || body.context_revision !== '1') fail('invalid_version');
  uuid(body.context_id);
  closed(body.target, TARGET_KEYS);
  const target = body.target;
  for (const key of ['organization_id', 'report_file_id', 'appraisal_case_id', 'subject_snapshot_id']) uuid(target[key]);
  if (target.workflow_type !== 'custom_appraisal') fail('invalid_workflow');
  assignment(target.workflow_target_id); account(target.account_id);
  if (!Number.isInteger(target.snapshot_version) || target.snapshot_version < 1 || target.snapshot_version > 2147483647) fail('invalid_identity');
  assessmentDate(body.effective_date);
  for (const key of EVIDENCE_KEYS) {
    closed(body[key], ['content_sha256', 'canonical_utf8_bytes']);
    prepareNeighborhoodCohortBlobReference(body[key].content_sha256, body[key].canonical_utf8_bytes);
  }
  const preimage = canonicalAssessmentJson({ domain: 'cohort-issuer-context-v1', version: 1, body });
  return freeze({ status: 'represented', authority: 'not_established', body,
    context_ref: { context_id: body.context_id, context_revision: body.context_revision,
      context_sha256: createHash('sha256').update(preimage, 'utf8').digest('hex') },
    header_blob: { ref: prepareNeighborhoodCohortBlob(canonicalJson), canonical_json: canonicalJson } });
}
