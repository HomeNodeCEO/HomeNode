// Inactive V3-only batch catalog lane; no source authority or selection choice.
import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = reason => { throw new TypeError(`custom_cohort_batch_selected_initial_v3_worker_${reason}`); };
const OUTPUT = `job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,
  job.report_file_id::text,job.assignment_file_id::text,job.account_id,job.actor_user_id::text`;
const INITIAL_FENCE = `job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL
  AND job.checkpoint=intent.checkpoint AND job.request_sha256=intent.request_sha256
  AND job.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2'
  AND jsonb_array_length(job.checkpoint->'evidence_refs')=9
  AND job.attempts>=intent.issued_attempts AND job.attempts BETWEEN 1 AND 5
  AND job.request_payload->>'execution_mode'='frozen-originals-v2'
  AND EXISTS(SELECT 1 FROM app.custom_appraisal_workfile_sections workspace
    WHERE workspace.assignment_file_id=job.assignment_file_id AND workspace.section_key='neighborhood_workspace'
      AND octet_length(workspace.section_value::text)<=524288
      AND workspace.section_value->>'workspace_version'='7'
      AND workspace.section_value->'pending_capture'->>'operation_id'=job.operation_id::text
      AND workspace.section_value->'pending_capture'->'observation_period'=job.request_payload->'observation_period'
      AND workspace.section_value->'pending_capture'->'discovery'=job.request_payload->'discovery'
      AND COALESCE(workspace.section_value->'pending_capture'->'private_sales_import','null'::jsonb)
        =COALESCE(job.request_payload->'private_sales_import','null'::jsonb)
      AND workspace.section_value->'active'->'context_ref'->>'context_id' IS DISTINCT FROM job.operation_id::text)
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
    JOIN app.neighborhood_cohort_evidence_blobs catalog_blob ON catalog_blob.organization_id=catalog.organization_id
      AND catalog_blob.content_sha256=catalog.receipt_reference->>'content_sha256'
      AND catalog_blob.canonical_utf8_bytes::text=catalog.receipt_reference->>'canonical_utf8_bytes'
      AND catalog_blob.canonical_utf8_bytes BETWEEN 1 AND 16000
    CROSS JOIN LATERAL(SELECT CASE WHEN octet_length(catalog_blob.canonical_utf8)<=16000
      THEN catalog_blob.canonical_utf8::jsonb END AS receipt) completed_catalog
    JOIN app.neighborhood_cohort_evidence_blobs source_blob ON source_blob.organization_id=cache.organization_id
      AND source_blob.content_sha256=cache.source_reference->>'content_sha256'
      AND source_blob.canonical_utf8_bytes::text=cache.source_reference->>'canonical_utf8_bytes'
      AND source_blob.canonical_utf8_bytes BETWEEN 1 AND 16000
    CROSS JOIN LATERAL(SELECT CASE WHEN octet_length(source_blob.canonical_utf8)<=16000
      THEN source_blob.canonical_utf8::jsonb END AS receipt) issued_source
    WHERE completed_catalog.receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3'
      AND completed_catalog.receipt->'after'->'done'='true'::jsonb
      AND issued_source.receipt->>'source_stage_version'='2'
      AND issued_source.receipt->>'usage'='frozen_source_reference_prefix_only'
      AND issued_source.receipt->'root'=cache.root_reference
      AND issued_source.receipt->'selection'->'subject_intent'=job.checkpoint->'evidence_refs'->0
      AND cache.stock_reference=job.checkpoint->'evidence_refs'->1
      AND cache.source_reference=job.checkpoint->'evidence_refs'->2
      AND cache.graph_reference=job.checkpoint->'evidence_refs'->3
      AND cache.geographic_reference=job.checkpoint->'evidence_refs'->4
      AND cache.identity_reference=job.checkpoint->'evidence_refs'->5
      AND first.operation_id=job.operation_id AND first.organization_id=job.organization_id AND first.report_file_id=job.report_file_id
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
      AND (catalog.receipt_reference=job.checkpoint->'evidence_refs'->8
          AND catalog.partition_reference=partition.receipt_reference AND catalog.traversal_reference=h.receipt_reference
          AND catalog.profile_reference=partition.profile_reference AND catalog.source_reference=h.source_reference
          AND catalog.root_reference=h.root_reference AND catalog.graph_reference=h.graph_reference
          AND catalog.geographic_reference=h.geographic_reference AND catalog.identity_reference=h.identity_reference
          AND catalog.stock_reference=h.stock_reference)
      AND h.root_reference=cache.root_reference AND h.source_reference=cache.source_reference
      AND h.graph_reference=cache.graph_reference AND h.geographic_reference=cache.geographic_reference AND h.stock_reference=cache.stock_reference)`;
const EXPIRY_FENCE=INITIAL_FENCE.replace(' AND job.cancellation_requested_at IS NULL','');
function leaseOf(value) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_options');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.leaseSeconds?.enumerable
    || !Object.hasOwn(descriptors.leaseSeconds, 'value')) fail('invalid_options');
  const seconds = descriptors.leaseSeconds.value;
  if (!Number.isInteger(seconds) || seconds < CAPTURE_JOB_LEASE_SECONDS.min
    || seconds > CAPTURE_JOB_LEASE_SECONDS.max) fail('invalid_options');
  return seconds;
}

/** Adopt one actual human-resumed covered catalog claim once, or recover its ordinary failure.
 * The caller owns a short ledger transaction. No browser token, groups, receipt,
 * source callback or permission decision is accepted. This ledger grants none.
 */
export function createCustomCohortBatchSelectedInitialV3WorkerRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  const transactionId = async () => {
    const result = await client.query('/* custom-cohort-batch-selected-initial-v3:transaction */ SELECT txid_current()::text AS transaction_id');
    const id = result?.rows?.[0]?.transaction_id;
    if (result?.rowCount !== 1 || result.rows.length !== 1
      || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  return Object.freeze({ async claimDue(options = { leaseSeconds: 300 }) {
    const leaseSeconds = leaseOf(options), started = await transactionId();
    if (await transactionId() !== started) fail('caller_transaction_required');
    await client.query(`/* custom-cohort-batch-selected-initial-v3:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents intent
        ON intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id
      WHERE job.status='running' AND job.lease_expires_at<=clock_timestamp()
        AND ${EXPIRY_FENCE}
        AND (job.cancellation_requested_at IS NOT NULL OR job.attempts>=5)
      ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        claim_token=NULL,lease_expires_at=NULL,
        last_error_code=CASE WHEN job.cancellation_requested_at IS NULL THEN 'attempts_exhausted' ELSE 'cancelled' END,
        updated_at=clock_timestamp()
      FROM expired WHERE job.operation_id=expired.operation_id`);
    let recovering = false;
    let result = await client.query(`/* custom-cohort-batch-selected-initial-v3:adopt */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id,intent.command_id FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_v2_selection_intents intent
          ON intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id
        WHERE ${INITIAL_FENCE} AND job.status='running' AND job.lease_expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 dispatched
            WHERE dispatched.operation_id=job.operation_id AND dispatched.claim_token=job.claim_token)
        ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      ), adopted AS (
        INSERT INTO app.neighborhood_custom_cohort_selected_initial_dispatch_v2
          (operation_id,organization_id,command_id,claim_token,attempts,actor_user_id)
        SELECT job.operation_id,job.organization_id,due.command_id,job.claim_token,job.attempts,job.actor_user_id
        FROM due JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id)
        ON CONFLICT(operation_id,claim_token) DO NOTHING RETURNING operation_id
      ) SELECT ${OUTPUT} FROM adopted JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id)`);
    if (result?.rowCount === 0 && Array.isArray(result.rows) && result.rows.length === 0) {
      recovering = true;
      result = await client.query(`/* custom-cohort-batch-selected-initial-v3:recover */
        WITH due AS MATERIALIZED (
          SELECT job.operation_id,intent.command_id FROM app.neighborhood_custom_cohort_capture_jobs job
          JOIN app.neighborhood_custom_cohort_v2_selection_intents intent
            ON intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id
          WHERE ${INITIAL_FENCE} AND job.attempts<5
            AND ((job.status='retry' AND job.run_after<=clock_timestamp())
              OR (job.status='running' AND job.lease_expires_at<=clock_timestamp()))
          ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
        ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status='running',attempts=attempts+1,claim_token=gen_random_uuid(),
            lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
          FROM due WHERE job.operation_id=due.operation_id RETURNING ${OUTPUT}`, [leaseSeconds]);
    }
    if (!Array.isArray(result?.rows) || result.rowCount !== result.rows.length || result.rows.length > 1) fail('corrupt');
    const rows = result.rows.map(row => {
      const claim = prepareCustomCohortCaptureJobClaim({ operation_id: row.operation_id, claim_token: row.claim_token, attempts: row.attempts });
      if (![row.organization_id, row.report_file_id, row.actor_user_id].every(value => typeof value === 'string' && UUID.test(value))
        || typeof row.assignment_file_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.assignment_file_id)
        || BigInt(row.assignment_file_id) > 9223372036854775807n
        || typeof row.account_id !== 'string' || !row.account_id || row.account_id.length > 64
        || !row.account_id.isWellFormed() || row.account_id.trim() !== row.account_id
        || /[\u0000-\u001f\u007f]/.test(row.account_id)) fail('corrupt');
      return Object.freeze({ claim, actor_user_id: row.actor_user_id, authority: 'not_established',
        scope: Object.freeze({ organization_id: row.organization_id, report_file_id: row.report_file_id,
          assignment_file_id: row.assignment_file_id, account_id: row.account_id }) });
    });
    if (recovering && rows.length === 1) {
      // A separate statement guarantees the native adoption trigger sees the
      // new job token/attempt, not a sibling DML-CTE snapshot. Both statements
      // and the deferred guard still share this one caller-owned transaction.
      const { claim } = rows[0];
      const adopted = await client.query(`/* custom-cohort-batch-selected-initial-v3:adopt-recovery */
        INSERT INTO app.neighborhood_custom_cohort_selected_initial_dispatch_v2
          (operation_id,organization_id,command_id,claim_token,attempts,actor_user_id)
        SELECT job.operation_id,job.organization_id,intent.command_id,job.claim_token,job.attempts,job.actor_user_id
        FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_v2_selection_intents intent
          ON intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
          AND ${INITIAL_FENCE} AND job.status='running' AND job.lease_expires_at>clock_timestamp()
        RETURNING operation_id::text`, [claim.operation_id, claim.claim_token, claim.attempts]);
      if (adopted?.rowCount !== 1 || adopted.rows?.length !== 1
        || adopted.rows[0].operation_id !== claim.operation_id) fail('corrupt');
    }
    if (await transactionId() !== started) fail('caller_transaction_required');
    return Object.freeze(rows);
  } });
}
