import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PHASES = Object.freeze(['frozen_stock_traversal_refs_v2',
  'frozen_recorded_partition_refs_v2', 'frozen_recorded_catalog_refs_v2']);
const fail = reason => { throw new TypeError(`custom_cohort_v2_catalog_worker_${reason}`); };
function data(value, keys) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || !keys.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

// These bounded immutable receipts choose a route only. Their fields are never
// source authority: the selected original owner independently reopens ALL of
// its prerequisites, originals, caches and current permissions before writing.
const ROUTING_RECEIPT = `
  JOIN app.neighborhood_custom_cohort_v2_continuations c
    ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs blob
    ON blob.organization_id=job.organization_id
      AND blob.content_sha256=job.checkpoint->'evidence_refs'->-1->>'content_sha256'
  CROSS JOIN LATERAL (SELECT CASE WHEN blob.canonical_utf8_bytes BETWEEN 1 AND 16000
      AND octet_length(blob.canonical_utf8)<=16000 THEN blob.canonical_utf8::jsonb END AS receipt) routing`;
const ROUTING_FENCE = `
  job.checkpoint->>'phase'=ANY($2::text[])
  AND c.phase=job.checkpoint->>'phase'
  AND c.progress_reference=job.checkpoint->'evidence_refs'->-1
  AND jsonb_array_length(job.checkpoint->'evidence_refs')=CASE c.phase
    WHEN 'frozen_stock_traversal_refs_v2' THEN 7
    WHEN 'frozen_recorded_partition_refs_v2' THEN 8 ELSE 9 END
  AND routing.receipt->>'format'=CASE c.phase
    WHEN 'frozen_stock_traversal_refs_v2' THEN 'cohort_stock_traversal_receipt_v2'
    WHEN 'frozen_recorded_partition_refs_v2' THEN 'cohort_recorded_group_partition_receipt_v2'
    ELSE 'cohort_recorded_catalog_receipt_v2' END
  AND jsonb_typeof(routing.receipt->'after'->'done')='boolean'
  -- A genuine NEW-study command keeps the catalog checkpoint until its first
  -- union step. That job belongs to the selected-union owner, even on failure
  -- recovery; never spend its claims trying to return it to selection-wait.
  AND NOT EXISTS (SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents intent
    WHERE intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id)
  AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL`;
const RETURN_CLAIM = `job.operation_id::text,job.claim_token::text,job.attempts,
  job.organization_id::text,job.report_file_id::text,job.assignment_file_id::text,
  job.account_id,job.actor_user_id::text,due.phase,due.progress_done`;

/** Internal catalog-stage claims only; no enqueue, source grant or activation.
 * A successful continuation consumes its native token once without increasing
 * attempts. An ordinary failed/expired claim spends the existing failure budget.
 * The caller owns one short ledger transaction, including native COMMIT guards.
 */
export function createCustomCohortV2CatalogWorkerRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  const transactionId = async () => {
    const result = await client.query('/* custom-cohort-v2-catalog-worker:transaction */ SELECT txid_current()::text AS transaction_id');
    const id = result?.rows?.[0]?.transaction_id;
    if (result?.rowCount !== 1 || result.rows.length !== 1
      || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  return Object.freeze({ async claimDue(rawOptions = { leaseSeconds: 300 }) {
    const { leaseSeconds } = data(rawOptions, ['leaseSeconds']);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
      || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max) fail('invalid_options');
    const started = await transactionId();
    if (await transactionId() !== started) fail('caller_transaction_required');
    // Finish only expired terminal claims in this worker's installed phases.
    // Retain their original graph and generation pin for the separate owner.
    await client.query(`/* custom-cohort-v2-catalog-worker:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
      WHERE job.status='running' AND job.lease_expires_at<=clock_timestamp()
        AND job.checkpoint->>'phase'=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents intent
          WHERE intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id)
        AND (job.cancellation_requested_at IS NOT NULL OR job.attempts>=5)
      ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        claim_token=NULL,lease_expires_at=NULL,
        last_error_code=CASE WHEN job.cancellation_requested_at IS NULL THEN 'attempts_exhausted' ELSE 'cancelled' END,
        updated_at=clock_timestamp()
      FROM expired WHERE job.operation_id=expired.operation_id`, [PHASES]);
    let result = await client.query(`/* custom-cohort-v2-catalog-worker:claim-success */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id,c.phase,(routing.receipt->'after'->>'done')::boolean AS progress_done
        FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING_RECEIPT}
        WHERE ${ROUTING_FENCE} AND c.consumed_claim_token IS NULL
          AND job.status='retry' AND job.attempts=c.issued_attempts AND job.attempts BETWEEN 1 AND 5
          AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.run_after<=clock_timestamp()
        ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      ), consumed AS (
        UPDATE app.neighborhood_custom_cohort_v2_continuations c SET consumed_claim_token=gen_random_uuid()
        FROM due WHERE c.operation_id=due.operation_id AND c.consumed_claim_token IS NULL
        RETURNING c.operation_id,c.consumed_claim_token
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=consumed.consumed_claim_token,
        lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
        FROM consumed,due WHERE job.operation_id=consumed.operation_id AND job.operation_id=due.operation_id
        RETURNING ${RETURN_CLAIM}`, [leaseSeconds, PHASES]);
    if (result?.rowCount === 0 && Array.isArray(result.rows) && result.rows.length === 0) {
      result = await client.query(`/* custom-cohort-v2-catalog-worker:claim-recovery */
        WITH due AS MATERIALIZED (
          SELECT job.operation_id,c.phase,(routing.receipt->'after'->>'done')::boolean AS progress_done
          FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING_RECEIPT}
          WHERE ${ROUTING_FENCE} AND c.consumed_claim_token IS NOT NULL AND job.attempts<5
            AND ((job.status='retry' AND job.run_after<=clock_timestamp())
              OR (job.status='running' AND job.lease_expires_at<=clock_timestamp()))
          ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
        ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status='running',attempts=attempts+1,claim_token=gen_random_uuid(),
            lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
          FROM due WHERE job.operation_id=due.operation_id RETURNING ${RETURN_CLAIM}`, [leaseSeconds, PHASES]);
    }
    if (!Array.isArray(result?.rows) || result.rowCount !== result.rows.length || result.rows.length > 1) fail('corrupt');
    const rows = result.rows.map(row => {
      const claim = prepareCustomCohortCaptureJobClaim({ operation_id: row.operation_id,
        claim_token: row.claim_token, attempts: row.attempts });
      if (!PHASES.includes(row.phase) || typeof row.progress_done !== 'boolean'
        || ![row.organization_id, row.report_file_id, row.actor_user_id]
          .every(value => typeof value === 'string' && UUID.test(value))
        || typeof row.assignment_file_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.assignment_file_id)
        || BigInt(row.assignment_file_id) > 9223372036854775807n
        || typeof row.account_id !== 'string' || !row.account_id || row.account_id.length > 64
        || !row.account_id.isWellFormed() || row.account_id.trim() !== row.account_id
        || /[\u0000-\u001f\u007f]/.test(row.account_id)) fail('corrupt');
      return Object.freeze({ claim, scope: Object.freeze({ organization_id: row.organization_id,
        report_file_id: row.report_file_id, assignment_file_id: row.assignment_file_id, account_id: row.account_id }),
      actor_user_id: row.actor_user_id, phase: row.phase, progress_done: row.progress_done,
      authority: 'not_established' });
    });
    if (await transactionId() !== started) fail('caller_transaction_required');
    return Object.freeze(rows);
  } });
}
