import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository }
  from './customCohortCaptureJobRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';

const PASSTHROUGH_FAILURE_REASONS = new Set(['cancelled', 'deadline_exceeded',
  'subject_changed', 'market_policy_changed']);

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function claimIdentity(row) {
  return Object.freeze({ operation_id: row.operation_id,
    claim_token: row.claim_token, attempts: row.attempts });
}

function captureInput(row, auth) {
  const request = row.request_payload;
  return { auth, accountId: row.account_id,
    assignmentFileId: row.assignment_file_id,
    operationId: request.operation_id,
    observationPeriod: request.observation_period,
    ...(request.discovery ? { discovery: request.discovery } : {}),
    ...(request.private_sales_import
      ? { privateSalesImport: request.private_sales_import } : {}) };
}

function failureReason(error) {
  if (error?.message === 'custom_cohort_job_actor_access_revoked'
    || error?.reason === 'assignment_access_denied') return 'access_revoked';
  if (PASSTHROUGH_FAILURE_REASONS.has(error?.reason)) return error.reason;
  return 'capture_failed';
}

/** Process one fenced capture off the web request path. This intentionally
 * retains the installed capture's 50k ceiling until every larger-area read,
 * statistics, map and publication budget is versioned together. `capture()`
 * completes the claim in its context registration transaction, so a cancelled
 * or lost lease cannot publish an orphaned context. A retry rechecks current
 * rights and replays the exact context if registration already committed.
 */
export async function runCustomCohortCaptureJobOnce({ pool, cohortService,
  repositoryFactory = createCustomCohortCaptureJobRepository,
  loadActor = loadCurrentCustomCohortJobActor,
  leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || typeof cohortService?.capture !== 'function'
    || typeof repositoryFactory !== 'function' || typeof loadActor !== 'function'
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
    || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max
    || !Number.isInteger(heartbeatSeconds) || heartbeatSeconds < 1
    || heartbeatSeconds * 3 >= leaseSeconds) {
    throw new TypeError('custom_cohort_capture_job_worker_invalid_input');
  }
  const [row] = await transaction(pool, client =>
    repositoryFactory(client).claimDue({ limit: 1, leaseSeconds }));
  if (!row) return Object.freeze({ status: 'idle' });
  const claim = claimIdentity(row);
  const controller = new AbortController();
  let timer, heartbeatPromise, stopping = false;
  const checkHeartbeat = async () => {
    const state = await transaction(pool, client => repositoryFactory(client)
      .heartbeat(claim, { leaseSeconds }));
    if (state.cancellation_requested) controller.abort();
  };
  const heartbeat = () => {
    if (stopping) return;
    heartbeatPromise = checkHeartbeat().catch(() => controller.abort()).finally(() => {
      if (!stopping) timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    });
  };
  try {
    // The row contains a user ID, never a saved token or role claims.
    const auth = await transaction(pool, client =>
      loadActor(client, row.actor_user_id, row.organization_id));
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    const result = await cohortService.capture(captureInput(row, auth), {
      signal: controller.signal, captureJobClaim: claim,
    });
    if (result?.status !== 'registered'
      || result.context_ref?.context_id !== row.operation_id
      || !/^[a-f0-9]{64}$/.test(result.context_ref?.context_sha256 ?? '')) {
      throw new TypeError('custom_cohort_capture_job_worker_invalid_result');
    }
    return Object.freeze({ status: 'succeeded', operation_id: row.operation_id,
      context_ref: result.context_ref });
  } catch (error) {
    const reason = failureReason(error);
    try {
      const outcome = await transaction(pool, client => repositoryFactory(client)
        .failClaim(claim, reason));
      return Object.freeze({ status: outcome.status, operation_id: row.operation_id,
        reason });
    } catch (failure) {
      // The original operation may have committed while its acknowledgment
      // was lost, or another worker may now own the lease. Do not overwrite it.
      if (failure?.message === 'custom_cohort_capture_job_claim_lost')
        return Object.freeze({ status: 'outcome_unknown', operation_id: row.operation_id });
      throw failure;
    }
  } finally {
    stopping = true;
    clearTimeout(timer);
    await heartbeatPromise?.catch(() => {});
  }
}
