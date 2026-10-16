// Inactive V3-only locator; the actual original owner supplies current authority.
import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PHASES = Object.freeze(['frozen_recorded_catalog_refs_v2']);
const fail = reason => { throw new TypeError(`custom_cohort_batch_selection_wait_v3_worker_${reason}`); };
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
  job.checkpoint->>'phase'=ANY($2::text[]) AND c.phase=job.checkpoint->>'phase'
  AND c.progress_reference=job.checkpoint->'evidence_refs'->-1
  AND jsonb_array_length(job.checkpoint->'evidence_refs')=9
  AND blob.canonical_utf8_bytes::text=c.progress_reference->>'canonical_utf8_bytes'
  AND jsonb_typeof(routing.receipt->'after'->'done')='boolean'
  AND routing.receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3'
  AND routing.receipt->'after'->>'done'='true'
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents intent
    WHERE intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id)
  AND job.request_payload->>'execution_mode'='frozen-originals-v2'
  AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges first
    JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e
      USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads cache ON cache.operation_id=e.operation_id AND cache.organization_id=e.organization_id
    JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors h ON h.operation_id=e.operation_id AND h.organization_id=e.organization_id
    JOIN app.neighborhood_cohort_evidence_blobs stock_blob ON stock_blob.organization_id=h.organization_id
      AND stock_blob.content_sha256=h.receipt_reference->>'content_sha256'
      AND stock_blob.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes'
      AND stock_blob.canonical_utf8_bytes BETWEEN 1 AND 16000
    CROSS JOIN LATERAL(SELECT CASE WHEN octet_length(stock_blob.canonical_utf8)<=16000
      THEN stock_blob.canonical_utf8::jsonb END AS receipt) completed_stock
    JOIN app.neighborhood_custom_cohort_recorded_partition_v2_heads partition
      ON partition.operation_id=h.operation_id AND partition.organization_id=h.organization_id
      AND partition.traversal_reference=h.receipt_reference AND partition.source_reference=h.source_reference
      AND partition.root_reference=h.root_reference AND partition.graph_reference=h.graph_reference
      AND partition.geographic_reference=h.geographic_reference AND partition.identity_reference=h.identity_reference
      AND partition.stock_reference=h.stock_reference
    JOIN app.neighborhood_cohort_evidence_blobs partition_blob ON partition_blob.organization_id=partition.organization_id
      AND partition_blob.content_sha256=partition.receipt_reference->>'content_sha256'
      AND partition_blob.canonical_utf8_bytes::text=partition.receipt_reference->>'canonical_utf8_bytes'
      AND partition_blob.canonical_utf8_bytes BETWEEN 1 AND 16000
    CROSS JOIN LATERAL(SELECT CASE WHEN octet_length(partition_blob.canonical_utf8)<=16000
      THEN partition_blob.canonical_utf8::jsonb END AS receipt) completed_partition
    JOIN app.neighborhood_custom_cohort_recorded_catalog_v2_heads catalog
      ON catalog.operation_id=partition.operation_id AND catalog.organization_id=partition.organization_id
    WHERE first.operation_id=job.operation_id AND first.organization_id=job.organization_id AND first.report_file_id=job.report_file_id
      AND first.assignment_file_id=job.assignment_file_id AND first.account_id=job.account_id AND first.actor_user_id=job.actor_user_id
      AND first.request_sha256=job.request_sha256 AND first.completed_reference IS NOT NULL
      AND e.sequence=first.cache_sequence AND e.receipt_reference=first.cache_reference AND e.consumed_claim_token IS NULL
      AND cache.sequence=e.sequence AND cache.receipt_reference=e.receipt_reference AND cache.identity_reference=e.identity_reference
      AND h.receipt_reference=job.checkpoint->'evidence_refs'->6 AND h.identity_reference=e.identity_reference
      AND completed_stock.receipt->>'format'='cohort_stock_traversal_batch_receipt_v3'
      AND completed_stock.receipt->'after'->'done'='true'::jsonb
      AND partition.receipt_reference=job.checkpoint->'evidence_refs'->7
      AND completed_partition.receipt->>'format'='cohort_recorded_group_partition_batch_receipt_v3'
      AND completed_partition.receipt->'after'->'done'='true'::jsonb
      AND (catalog.receipt_reference=c.progress_reference
          AND catalog.partition_reference=partition.receipt_reference AND catalog.traversal_reference=h.receipt_reference
          AND catalog.profile_reference=partition.profile_reference AND catalog.source_reference=h.source_reference
          AND catalog.root_reference=h.root_reference AND catalog.graph_reference=h.graph_reference
          AND catalog.geographic_reference=h.geographic_reference AND catalog.identity_reference=h.identity_reference
          AND catalog.stock_reference=h.stock_reference)
      AND h.root_reference=cache.root_reference AND h.source_reference=cache.source_reference
      AND h.graph_reference=cache.graph_reference AND h.geographic_reference=cache.geographic_reference AND h.stock_reference=cache.stock_reference)
  AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL`;
// This is only a bounded locator for a real pending editor command. The owner
// reopens the entire V7 value/prior head under its normal locks and validates
// the exact target at both ends. No pending value or choice is manufactured.
const PENDING_TARGET = `
  AND EXISTS(SELECT 1 FROM app.custom_appraisal_workfile_sections workspace
    WHERE workspace.assignment_file_id=job.assignment_file_id AND workspace.section_key='neighborhood_workspace'
      AND octet_length(workspace.section_value::text)<=524288
      AND workspace.section_value->>'workspace_version'='7'
      AND workspace.section_value->'pending_capture'->>'operation_id'=job.operation_id::text
      AND workspace.section_value->'pending_capture'->'observation_period'=job.request_payload->'observation_period'
      AND workspace.section_value->'pending_capture'->'discovery'=job.request_payload->'discovery'
      AND COALESCE(workspace.section_value->'pending_capture'->'private_sales_import','null'::jsonb)
        =COALESCE(job.request_payload->'private_sales_import','null'::jsonb)
      AND workspace.section_value->'active'->'context_ref'->>'context_id' IS DISTINCT FROM job.operation_id::text)`;

// This owner handles catalog DONE only until an actual immutable human
// command exists. Its resume lease, including expiry/cancellation, is excluded.
const EXPIRY_FENCE=ROUTING_FENCE.replace(' AND job.cancellation_requested_at IS NULL','').replaceAll('$2','$1');
const RETURN_CLAIM = `job.operation_id::text,job.claim_token::text,job.attempts,
  job.organization_id::text,job.report_file_id::text,job.assignment_file_id::text,
  job.account_id,job.actor_user_id::text,due.phase,due.progress_done`;

/** Native covered catalog-DONE adoption for an existing pending study only.
 * A successful continuation consumes its native token once without increasing
 * attempts. An ordinary failed/expired claim spends the existing failure budget.
 * The caller owns one short ledger transaction, including native COMMIT guards.
 */
export function createCustomCohortBatchSelectionWaitV3WorkerRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  const transactionId = async () => {
    const result = await client.query('/* custom-cohort-batch-selection-wait-v3:transaction */ SELECT txid_current()::text AS transaction_id');
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
    // Finish only expired catalog claims before any human command exists.
    // Retain their original graph and generation pin for the separate owner.
    await client.query(`/* custom-cohort-batch-selection-wait-v3:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING_RECEIPT}
      WHERE ${EXPIRY_FENCE} AND job.status='running' AND job.lease_expires_at<=clock_timestamp()
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
    let result = await client.query(`/* custom-cohort-batch-selection-wait-v3:claim-success */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id,c.phase,(routing.receipt->'after'->>'done')::boolean AS progress_done
        FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING_RECEIPT}
        WHERE ${ROUTING_FENCE} ${PENDING_TARGET} AND c.consumed_claim_token IS NULL
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
      result = await client.query(`/* custom-cohort-batch-selection-wait-v3:claim-recovery */
        WITH due AS MATERIALIZED (
          SELECT job.operation_id,c.phase,(routing.receipt->'after'->>'done')::boolean AS progress_done
          FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING_RECEIPT}
          WHERE ${ROUTING_FENCE} ${PENDING_TARGET} AND c.consumed_claim_token IS NOT NULL AND job.attempts<5
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
      if (!PHASES.includes(row.phase) || row.progress_done !== true
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
