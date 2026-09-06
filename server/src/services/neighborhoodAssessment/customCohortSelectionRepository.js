import { canonicalAssessmentJson } from './contract.js';
import { prepareCohortLocalQueryEvidenceV1 } from './cohortEvidenceContract.js';
import { createCustomCohortSubjectRepository } from './customCohortSubjectRepository.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob,
  prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

// This is a retained-input link, NOT the c74 issuer context, a selected current
// head, original acquisition completion, or evidence of source/license coverage.
const USAGE = 'retained_selection_inputs_only';
const MAX_BLOBS = 1003, MAX_BUNDLE_BYTES = 8_000_000;
function fail(reason) { throw Object.assign(new Error(`custom_cohort_selection_${reason}`), { code: `custom_cohort_selection_${reason}` }); }
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail('invalid_shape');
}
function reference(value) {
  closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  return prepareNeighborhoodCohortBlobReference(value.content_sha256, value.canonical_utf8_bytes);
}
function admitted(inputJson) {
  const result = prepareCohortLocalQueryEvidenceV1(inputJson);
  if (result.status !== 'syntax_valid') fail(result.status === 'limit_exceeded' ? 'input_limit' : 'invalid_evidence');
  return result;
}
function metadataOf(evidence) {
  const byHash = new Map(evidence.blobs.map(blob => [blob.ref.content_sha256, blob.canonical_json]));
  const preimage = JSON.parse(byHash.get(evidence.query_preimage.content_sha256));
  return JSON.parse(byHash.get(preimage.compact_metadata.content_sha256));
}
function checkSubject(subject, evidence) {
  const metadata = metadataOf(evidence), target = subject.target;
  const scope = metadata.scope, authorization = metadata.authorization.target;
  if (scope.organization_id !== target.organization_id || scope.account_id !== target.account_id ||
      scope.appraisal_case_id !== target.appraisal_case_id || scope.subject_snapshot_id !== target.subject_snapshot_id ||
      authorization.report_file_id !== target.report_file_id || authorization.workflow_type !== 'custom_appraisal' ||
      authorization.workflow_target_id !== target.assignment_file_id || metadata.effective_date !== subject.effective_date) fail('subject_mismatch');
}
function headerOf(subjectRef, evidence) {
  return { selection_input_version: 1, usage: USAGE, subject_inputs: subjectRef,
    query_bundle: { version: evidence.version, producer_profile: evidence.producer_profile,
      query_preimage: evidence.query_preimage, captured_query_selection_sha256: evidence.captured_query_selection_sha256,
      blob_refs: evidence.blobs.map(blob => blob.ref) } };
}
function checkedHeader(value) {
  closed(value, ['selection_input_version', 'usage', 'subject_inputs', 'query_bundle']);
  if (value.selection_input_version !== 1 || value.usage !== USAGE) fail('invalid_evidence');
  reference(value.subject_inputs);
  const bundle = value.query_bundle;
  closed(bundle, ['version', 'producer_profile', 'query_preimage', 'captured_query_selection_sha256', 'blob_refs']);
  if (bundle.version !== 1 || bundle.producer_profile !== 'local-capture-v3' ||
      typeof bundle.captured_query_selection_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundle.captured_query_selection_sha256)) fail('invalid_evidence');
  reference(bundle.query_preimage);
  if (!Array.isArray(bundle.blob_refs) || bundle.blob_refs.length < 4 || bundle.blob_refs.length > MAX_BLOBS) fail('input_limit');
  let previous = null, bytes = 0;
  for (const item of bundle.blob_refs) {
    const ref = reference(item);
    if (previous !== null && ref.content_sha256 <= previous) fail('invalid_evidence');
    previous = ref.content_sha256;
    bytes += Number(ref.canonical_utf8_bytes);
    if (bytes > MAX_BUNDLE_BYTES) fail('input_limit');
  }
  if (!bundle.blob_refs.some(ref => ref.content_sha256 === bundle.query_preimage.content_sha256 &&
      ref.canonical_utf8_bytes === bundle.query_preimage.canonical_utf8_bytes)) fail('invalid_evidence');
  return value;
}

/** Caller owns fresh exact Custom assignment access, original acquisition
 * provenance, one bounded transaction/deadline and rollback on any failure.
 * Retention links the COMPLETE existing query bundle to its original subject.
 * It never selects a current analysis, changes report data, queries providers,
 * invents a license grant, or turns self-consistent hashes into trusted facts.
 * Do not expose as a generic blob API. Later context registration must consume
 * the genuine acquisition runtime, not accept this reference as authority.
 */
export function createCustomCohortSelectionRepository(client, scopeJson) {
  const subjects = createCustomCohortSubjectRepository(client, scopeJson);
  const scope = JSON.parse(scopeJson); // already admitted by the subject repository
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const query = client.query.bind(client);
  const read = async ref => {
    const text = await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
    if (text === null) fail('missing_evidence');
    return text;
  };
  const transaction = async () => {
    const result = await query('/* custom-cohort-selection:transaction */ SELECT txid_current()::text AS transaction_id');
    const id = result?.rows?.[0]?.transaction_id;
    if (result?.rowCount !== 1 || result.rows.length !== 1 || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  return Object.freeze({
    async retain(subjectReference, originalBundleJson) {
      const subjectRef = reference(subjectReference), result = admitted(originalBundleJson);
      const evidence = result.evidence;
      const header = checkedHeader(headerOf(subjectRef, evidence));
      const headerJson = canonicalAssessmentJson(header);
      // Preflight ALL storage representations before any insertion, including
      // storage's tighter JSONB/numeric/Unicode limits and wrapper overhead.
      prepareNeighborhoodCohortBlob(headerJson);
      for (const blob of evidence.blobs) prepareNeighborhoodCohortBlob(blob.canonical_json);
      const started = await transaction();
      const subject = await subjects.load(subjectRef);
      checkSubject(subject, evidence);
      if (await transaction() !== started) fail('caller_transaction_required');
      for (const blob of evidence.blobs) await blobs.put(blob.canonical_json);
      return blobs.put(headerJson);
    },
    async load(selectionReference) {
      const selectionRef = reference(selectionReference);
      const header = checkedHeader(JSON.parse(await read(selectionRef)));
      // Recheck actual file/organization/account integrity and follow retained
      // subject bytes, never today's replacement snapshot/sections.
      const subject = await subjects.load(header.subject_inputs);
      const queryBlobs = [];
      for (const ref of header.query_bundle.blob_refs) queryBlobs.push({ ref, canonical_json: await read(ref) });
      const stored = header.query_bundle;
      const result = admitted(JSON.stringify({ version: stored.version, producer_profile: stored.producer_profile,
        query_preimage: stored.query_preimage, captured_query_selection_sha256: stored.captured_query_selection_sha256,
        blobs: queryBlobs }));
      checkSubject(subject, result.evidence);
      return Object.freeze({ status: 'retained', authority: 'not_established', selection_reference: selectionRef,
        subject_inputs: header.subject_inputs, subject, query: result });
    },
  });
}
