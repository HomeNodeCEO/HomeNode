import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository }
  from './customCohortCaptureJobRepository.js';
import { createCustomCohortSourcePrefixV2ContinuationRepository }
  from './customCohortSourcePrefixV2ContinuationRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';

// Fixed original prefix and graph owners only; native metadata routes the step.
const STAGES = Object.freeze([
  ['frozen_source_refs_v2', 'continueFrozenCaptureJobSourcePrefixReferencesV2Page', 'source_reference_prefix_retained'],
  ['frozen_verify_refs_v2', 'continueFrozenCaptureJobSourceReferencesV2Page', 'original_graph_progress_retained'],
].map(Object.freeze));
const failureReason = error => error?.message === 'custom_cohort_job_actor_access_revoked'
  || error?.reason === 'assignment_access_denied' ? 'access_revoked'
  : ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed'].includes(error?.reason)
    ? error.reason : 'capture_failed';

/** One dormant successful prefix continuation. Each actual owner
 * performs its original queries and unchanged current/ending rights fences.
 * Returns status only; the actual completed prefix enters the graph owner.
 * No queued-job/stock adoption, route, default worker, CLI or schedule.
 */
export async function runCustomCohortSourcePrefixV2JobOnce({ pool, cohortService,
  claimRepositoryFactory = createCustomCohortSourcePrefixV2ContinuationRepository,
  repositoryFactory = createCustomCohortCaptureJobRepository,
  loadActor = loadCurrentCustomCohortJobActor, leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || !STAGES.every(([, method]) => typeof cohortService?.[method] === 'function')
    || ![claimRepositoryFactory, repositoryFactory, loadActor].every(value => typeof value === 'function')
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
    || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max || !Number.isInteger(heartbeatSeconds)
    || heartbeatSeconds < 1 || heartbeatSeconds * 3 >= leaseSeconds) {
    throw new TypeError('custom_cohort_prefix_v2_worker_invalid_input');
  }
  let row;
  try { [row] = await transaction(pool, client => claimRepositoryFactory(client).claimDue({ leaseSeconds })); }
  catch (error) { if (error?.outcome_unknown) return Object.freeze({ status: 'outcome_unknown' }); throw error; }
  if (!row) return Object.freeze({ status: 'idle' });
  const { claim, scope } = row, controller = new AbortController();
  let timer, heartbeatPromise, stopping = false;
  const checkHeartbeat = async () => {
    const state = await transaction(pool, client => repositoryFactory(client).heartbeat(claim, { leaseSeconds }));
    if (state.cancellation_requested) controller.abort();
  };
  const heartbeat = () => {
    if (stopping) return;
    heartbeatPromise = checkHeartbeat().catch(() => controller.abort()).finally(() => {
      if (!stopping) timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    });
  };
  try {
    const { auth, request } = await transaction(pool, async client => ({
      auth: await loadActor(client, row.actor_user_id, scope.organization_id),
      request: await repositoryFactory(client).readRequest(claim, { scope, actorUserId: row.actor_user_id }),
    }));
    const index = STAGES.findIndex(([phase]) => phase === row.phase);
    if (index < 0 || typeof row.progress_done !== 'boolean' || index !== 0
      || request.private_sales_import || request.operation_id !== claim.operation_id
      || request.discovery?.profile_id !== 'custom-suburban-radius-v2') {
      throw new TypeError('custom_cohort_prefix_v2_worker_invalid_job');
    }
    const [phase, method, status] = STAGES[index + Number(row.progress_done)];
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    const result = await cohortService[method]({ auth, accountId: scope.account_id,
      assignmentFileId: scope.assignment_file_id, operationId: request.operation_id,
      observationPeriod: request.observation_period, discovery: request.discovery }, {
      captureJobClaim: claim, signal: controller.signal,
    });
    const continuation = result?.continuation;
    if (result?.status !== status || result.operation_id !== claim.operation_id
      || result.context_complete !== false || result.pin_transfer !== false || result.report_update !== 'none'
      || continuation?.status !== 'continuation_pending' || continuation.phase !== phase
      || continuation.attempts !== claim.attempts || continuation.fresh_claim_required !== true
      || continuation.context_complete !== false || continuation.pin_transfer !== false) {
      throw new TypeError('custom_cohort_prefix_v2_worker_invalid_result');
    }
    return Object.freeze({ status: 'continuation_pending', operation_id: claim.operation_id,
      context_complete: false, pin_transfer: false, report_update: 'none' });
  } catch (error) {
    try {
      const reason = failureReason(error), outcome = await transaction(pool,
        client => repositoryFactory(client).failClaim(claim, reason));
      return Object.freeze({ status: outcome.status, operation_id: claim.operation_id, reason });
    } catch (failure) {
      if (failure?.message === 'custom_cohort_capture_job_claim_lost' || failure?.outcome_unknown)
        return Object.freeze({ status: 'outcome_unknown', operation_id: claim.operation_id });
      throw failure;
    }
  } finally {
    stopping = true; clearTimeout(timer); await heartbeatPromise?.catch(() => {});
  }
}
