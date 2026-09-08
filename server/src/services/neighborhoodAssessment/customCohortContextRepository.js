import { canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodCohortBlobRepository } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextHeader, prepareCustomCohortContextReference, prepareCustomCohortContextScope } from './customCohortContextContract.js';

function fail(reason) { throw Object.assign(new Error(`custom_cohort_context_${reason}`), { code: `custom_cohort_context_${reason}` }); }
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 || !result.rows[0]) fail('storage_conflict');
  return result.rows[0];
}
function empty(result) { return result?.rowCount === 0 && Array.isArray(result.rows) && result.rows.length === 0; }

/** Immutable, organization-and-file-scoped header storage, NOT context issuance.
 * Caller owns the checked-out transaction, fresh original-request authorization,
 * dependency/profile validation, deadlines, target fences and rollback. No source
 * reads, head/generation changes, BEGIN/COMMIT, permission grants or HTTP endpoints.
 * A retained header is never sufficient proof for issuing facts or applying data.
 */
export function createCustomCohortContextRepository(client, scopeJson) {
  if (typeof client?.query !== 'function' || typeof client.release !== 'function') fail('caller_client_required');
  const scope = prepareCustomCohortContextScope(scopeJson), clientQuery = client.query;
  const query = (...args) => Reflect.apply(clientQuery, client, args);
  const values = [scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id];
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const transaction = async () => {
    /** @type {{ transaction_id: string }} PostgreSQL text result of the query below. */
    const row = one(await query('/* custom-cohort-context:transaction */ SELECT txid_current()::text AS transaction_id'));
    if (typeof row.transaction_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.transaction_id)) fail('caller_transaction_required');
    return row.transaction_id;
  };
  const target = async () => {
    // Check permanent file/tenant identity without rebinding history to today's
    // snapshot. The caller already holds its ordered workflow/access fences.
    const result = await query(`/* custom-cohort-context:target */ SELECT r.id FROM app.report_files r
      JOIN app.assignment_files a ON a.id=r.custom_assignment_file_id AND a.organization_id=r.organization_id AND a.account_id=r.account_id
      WHERE r.organization_id=$1 AND r.id=$2 AND r.custom_assignment_file_id=$3::bigint AND r.account_id=$4
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL`, values);
    if (empty(result)) fail('target_not_found');
    if (one(result).id !== scope.report_file_id) fail('storage_conflict');
  };
  const sameScope = prepared => {
    const t = prepared.body.target;
    if (t.organization_id !== scope.organization_id || t.report_file_id !== scope.report_file_id ||
        t.workflow_target_id !== scope.assignment_file_id || t.account_id !== scope.account_id) fail('target_mismatch');
  };
  const readBlob = async ref => {
    const text = await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
    if (text === null) fail('missing_evidence');
    return text;
  };
  const dependencies = async prepared => {
    for (const key of ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input']) await readBlob(prepared.body[key]);
  };
  const find = ref => query(`/* custom-cohort-context:read */
    SELECT context_id::text, context_revision::text, context_sha256,
      header_content_sha256, header_canonical_utf8_bytes::text
    FROM app.neighborhood_custom_cohort_contexts
    WHERE organization_id=$1 AND report_file_id=$2 AND assignment_file_id=$3::bigint AND account_id=$4 AND context_id=$5`,
  [...values, ref.context_id]);
  const checked = async (result, expected) => {
    const row = one(result);
    if (row.context_id !== expected.context_id || row.context_revision !== expected.context_revision || row.context_sha256 !== expected.context_sha256) fail('storage_conflict');
    const text = await readBlob({ content_sha256: row.header_content_sha256, canonical_utf8_bytes: row.header_canonical_utf8_bytes });
    const prepared = prepareCustomCohortContextHeader(text);
    sameScope(prepared);
    if (canonicalAssessmentJson(prepared.context_ref) !== canonicalAssessmentJson(expected)) fail('storage_conflict');
    await dependencies(prepared);
    return prepared;
  };
  return Object.freeze({
    async put(canonicalHeaderJson) {
      const prepared = prepareCustomCohortContextHeader(canonicalHeaderJson);
      sameScope(prepared);
      const started = await transaction();
      await target(); await dependencies(prepared);
      if (await transaction() !== started) fail('caller_transaction_required');
      const header = await blobs.put(canonicalHeaderJson), ref = prepared.context_ref;
      const result = await query(`/* custom-cohort-context:insert */
        INSERT INTO app.neighborhood_custom_cohort_contexts
          (organization_id,report_file_id,assignment_file_id,account_id,context_id,context_revision,context_sha256,
            header_content_sha256,header_canonical_utf8_bytes)
        VALUES ($1,$2,$3::bigint,$4,$5,1,$6,$7,$8::integer)
        ON CONFLICT (organization_id,context_id) DO NOTHING
        RETURNING context_id::text,context_revision::text,context_sha256,header_content_sha256,header_canonical_utf8_bytes::text`,
      [...values, ref.context_id, ref.context_sha256, header.content_sha256, header.canonical_utf8_bytes]);
      const reused = empty(result);
      await checked(reused ? await find(ref) : result, ref);
      if (await transaction() !== started) fail('caller_transaction_required');
      return Object.freeze({ status: reused ? 'reused' : 'stored', authority: 'not_established', context_ref: ref });
    },
    async get(canonicalReferenceJson) {
      const ref = prepareCustomCohortContextReference(canonicalReferenceJson), started = await transaction();
      await target();
      const result = await find(ref), prepared = empty(result) ? null : await checked(result, ref);
      if (await transaction() !== started) fail('caller_transaction_required');
      return prepared;
    },
  });
}
