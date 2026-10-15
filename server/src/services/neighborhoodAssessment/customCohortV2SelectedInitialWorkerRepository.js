import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = reason => { throw new TypeError(`custom_cohort_selected_initial_worker_${reason}`); };
const OUTPUT = `job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,
  job.report_file_id::text,job.assignment_file_id::text,job.account_id,job.actor_user_id::text`;
const INITIAL_FENCE = `job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL
  AND job.checkpoint=intent.checkpoint AND job.request_sha256=intent.request_sha256
  AND job.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2'
  AND jsonb_array_length(job.checkpoint->'evidence_refs')=9
  AND job.attempts>=intent.issued_attempts`;
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

/** Adopt one actual human-resumed claim once, or recover its ordinary failure.
 * The caller owns a short ledger transaction. No browser token, groups, receipt,
 * source callback or permission decision is accepted. This ledger grants none.
 */
export function createCustomCohortV2SelectedInitialWorkerRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  const transactionId = async () => {
    const result = await client.query('/* custom-cohort-selected-initial-worker:transaction */ SELECT txid_current()::text AS transaction_id');
    const id = result?.rows?.[0]?.transaction_id;
    if (result?.rowCount !== 1 || result.rows.length !== 1
      || typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) fail('caller_transaction_required');
    return id;
  };
  return Object.freeze({ async claimDue(options = { leaseSeconds: 300 }) {
    const leaseSeconds = leaseOf(options), started = await transactionId();
    if (await transactionId() !== started) fail('caller_transaction_required');
    await client.query(`/* custom-cohort-selected-initial-worker:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents intent
        ON intent.operation_id=job.operation_id AND intent.organization_id=job.organization_id
      WHERE job.status='running' AND job.lease_expires_at<=clock_timestamp()
        AND job.checkpoint=intent.checkpoint AND job.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2'
        AND (job.cancellation_requested_at IS NOT NULL OR job.attempts>=5)
      ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        claim_token=NULL,lease_expires_at=NULL,
        last_error_code=CASE WHEN job.cancellation_requested_at IS NULL THEN 'attempts_exhausted' ELSE 'cancelled' END,
        updated_at=clock_timestamp()
      FROM expired WHERE job.operation_id=expired.operation_id`);
    let recovering = false;
    let result = await client.query(`/* custom-cohort-selected-initial-worker:adopt */
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
      result = await client.query(`/* custom-cohort-selected-initial-worker:recover */
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
      const adopted = await client.query(`/* custom-cohort-selected-initial-worker:adopt-recovery */
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
