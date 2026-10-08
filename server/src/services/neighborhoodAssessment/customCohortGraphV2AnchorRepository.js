import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE = `job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`;
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
function fail(reason) { throw new TypeError(`custom_cohort_graph_v2_anchor_${reason}`); }
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
function ref(value) {
  const r = data(value, ['content_sha256', 'canonical_utf8_bytes']);
  const result = prepareNeighborhoodCohortBlobReference(r.content_sha256, r.canonical_utf8_bytes);
  if (Number(result.canonical_utf8_bytes) > 16000) fail('invalid_reference');
  return result;
}
function anchorOf(raw) {
  if (raw === null) return null;
  const a = data(raw, ['source_reference', 'root_reference', 'receipt_reference', 'sequence']);
  if (!Number.isInteger(a.sequence) || a.sequence < 1 || a.sequence > 200000) fail('corrupt');
  return Object.freeze({ source_reference: ref(a.source_reference), root_reference: ref(a.root_reference),
    receipt_reference: ref(a.receipt_reference), sequence: a.sequence });
}
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('claim_lost');
  return result.rows[0];
}

/** Server-only issuance anchor, independent of mutable checkpoint JSON and
 * arbitrary content-addressed blob insertion. The current-authorized owner
 * reproduces the original page before advance; this primitive does not grant
 * rights or verify payloads. Atomic CAS plus the database head/edge/count guard
 * forbids reset, rewind, detached-node replacement and skipped continuations.
 * A fully compromised database able to change triggers/rights/originals is not
 * a trust boundary supplied by unkeyed content hashes. */
export function createCustomCohortGraphV2AnchorRepository(raw) {
  const { client, claim: rawClaim, scope: rawScope, actorUserId, source_reference, root_reference } = data(raw,
    ['client', 'claim', 'scope', 'actorUserId', 'source_reference', 'root_reference']);
  if (typeof client?.query !== 'function') fail('invalid_input');
  const claim = prepareCustomCohortCaptureJobClaim(rawClaim);
  const scope = data(rawScope, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
  if (![scope.organization_id, scope.report_file_id, actorUserId].every(v => typeof v === 'string' && UUID.test(v))
    || typeof scope.assignment_file_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    || BigInt(scope.assignment_file_id) > 9223372036854775807n || typeof scope.account_id !== 'string'
    || !scope.account_id || scope.account_id.length > 64 || !scope.account_id.isWellFormed()
    || scope.account_id.trim() !== scope.account_id || /[\u0000-\u001f\u007f]/.test(scope.account_id)) fail('invalid_scope');
  const source = ref(source_reference), root = ref(root_reference);
  const values = [claim.operation_id, claim.claim_token, claim.attempts, scope.organization_id,
    scope.report_file_id, scope.assignment_file_id, scope.account_id, actorUserId];
  const read = async () => {
    const row = one(await client.query(`/* custom-cohort-graph-v2:anchor-read */
      SELECT anchor.source_reference,anchor.root_reference,anchor.receipt_reference,anchor.sequence
      FROM app.neighborhood_custom_cohort_capture_jobs job
      LEFT JOIN app.neighborhood_custom_cohort_graph_v2_anchors anchor ON anchor.operation_id=job.operation_id
      WHERE ${FENCE}`, values));
    if (row.sequence === null && row.source_reference === null && row.root_reference === null && row.receipt_reference === null) return null;
    const anchor = anchorOf(row);
    if (!same(anchor.source_reference, source) || !same(anchor.root_reference, root)) fail('binding_changed');
    return anchor;
  };
  const transactionId = async () => {
    const id = one(await client.query('/* custom-cohort-graph-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  return Object.freeze({ read,
    /** Call before saving the new fenced checkpoint, in the SAME transaction
     * as receipt retention and the owner's ending current-rights checks. */
    async advance(rawExpected, rawReceipt) {
      const expected = anchorOf(rawExpected), receipt = ref(rawReceipt), sequence = (expected?.sequence ?? 0) + 1;
      if (sequence > 200000 || expected && (!same(expected.source_reference, source) || !same(expected.root_reference, root)))
        fail('binding_changed');
      const started = await transactionId();
      if (await transactionId() !== started) fail('caller_transaction_required');
      if (!same(await read(), expected)) fail('conflict');
      const sourceJson = canonicalAssessmentJson(source), rootJson = canonicalAssessmentJson(root), receiptJson = canonicalAssessmentJson(receipt);
      const result = expected === null
        ? await client.query(`/* custom-cohort-graph-v2:anchor-insert */
          INSERT INTO app.neighborhood_custom_cohort_graph_v2_anchors
            (operation_id,organization_id,source_reference,root_reference,receipt_reference,sequence)
          SELECT job.operation_id,job.organization_id,$9::jsonb,$10::jsonb,$11::jsonb,1
          FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
          ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`, [...values, sourceJson, rootJson, receiptJson])
        : await client.query(`/* custom-cohort-graph-v2:anchor-advance */
          UPDATE app.neighborhood_custom_cohort_graph_v2_anchors anchor
          SET receipt_reference=$9::jsonb,sequence=$10::integer
          FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
            AND anchor.operation_id=job.operation_id AND anchor.organization_id=job.organization_id
            AND anchor.source_reference=$11::jsonb AND anchor.root_reference=$12::jsonb
            AND anchor.receipt_reference=$13::jsonb AND anchor.sequence=$14::integer
          RETURNING anchor.sequence`, [...values, receiptJson, sequence, sourceJson, rootJson,
          canonicalAssessmentJson(expected.receipt_reference), expected.sequence]);
      if (one(result).sequence !== sequence) fail('corrupt');
      const stored = await read(), wanted = { source_reference: source, root_reference: root, receipt_reference: receipt, sequence };
      if (!same(stored, wanted)) fail('corrupt');
      if (await transactionId() !== started) fail('caller_transaction_required');
      return stored;
    },
  });
}
