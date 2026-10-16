import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository } from './customCohortCaptureJobRepository.js';
import { createCustomCohortBatchSelectedStatisticsV3WorkerRepository } from './customCohortBatchSelectedStatisticsV3WorkerRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';

const METHOD = 'progressCoveredOriginalFrozenCaptureJobBatchSelectedStatisticsReferencesV3';
const failureReason = error => error?.message === 'custom_cohort_job_actor_access_revoked'
  || error?.reason === 'assignment_access_denied' ? 'access_revoked'
  : ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed'].includes(error?.reason) ? error.reason : 'capture_failed';

/** One dormant original-reconciled contribution. Native metrics DONE admits
 * the first account; the actual contribution head chooses each later ordinal
 * and distinct EMPTY. All originals/current rights and every metric-row field
 * are reconciled. Contribution DONE remains for the unfinished numeric owner. */
export async function runCustomCohortBatchSelectedStatisticsV3JobOnce({ pool, cohortService,
  claimRepositoryFactory = createCustomCohortBatchSelectedStatisticsV3WorkerRepository,
  repositoryFactory = createCustomCohortCaptureJobRepository, loadActor = loadCurrentCustomCohortJobActor,
  leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || typeof cohortService?.[METHOD] !== 'function'
    || ![claimRepositoryFactory, repositoryFactory, loadActor].every(value => typeof value === 'function')
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max
    || !Number.isInteger(heartbeatSeconds) || heartbeatSeconds < 1 || heartbeatSeconds * 3 >= leaseSeconds)
    throw new TypeError('custom_cohort_batch_selected_statistics_v3_worker_invalid_input');
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
  const heartbeat = () => { if (stopping) return;
    heartbeatPromise = checkHeartbeat().catch(() => controller.abort()).finally(() => {
      if (!stopping) timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    });
  };
  try {
    const { auth, request } = await transaction(pool, async client => ({
      auth: await loadActor(client, row.actor_user_id, scope.organization_id),
      request: await repositoryFactory(client).readRequest(claim, { scope, actorUserId: row.actor_user_id }),
    }));
    if (!(row.phase === 'frozen_selected_metrics_refs_v2' && row.progress_done === true
      || row.phase === 'frozen_selected_statistics_refs_v2' && row.progress_done === false)
      || request.execution_mode !== 'frozen-originals-v2' || request.private_sales_import
      || request.operation_id !== claim.operation_id || request.discovery?.profile_id !== 'custom-suburban-radius-v2')
      throw new TypeError('custom_cohort_batch_selected_statistics_v3_worker_invalid_job');
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    const result = await cohortService[METHOD]({ auth, accountId: scope.account_id, assignmentFileId: scope.assignment_file_id,
      operationId: request.operation_id, observationPeriod: request.observation_period, discovery: request.discovery },
    { captureJobClaim: claim, signal: controller.signal });
    const continuation = result?.continuation;
    if (result?.catalog_receipt_format !== 'cohort_recorded_catalog_batch_receipt_v3'
      || result?.status !== 'original_selected_statistics_contribution_progress_retained' || result.operation_id !== claim.operation_id
      || result.covered_neutral_originals !== true || result.covered_CAD_originals !== true || result.read_only !== false
      || result.context_complete !== false || result.pin_transfer !== false || result.report_update !== 'none'
      || continuation?.status !== 'continuation_pending' || continuation.phase !== 'frozen_selected_statistics_refs_v2'
      || continuation.attempts !== claim.attempts || continuation.fresh_claim_required !== true
      || continuation.context_complete !== false || continuation.pin_transfer !== false)
      throw new TypeError('custom_cohort_batch_selected_statistics_v3_worker_invalid_result');
    return Object.freeze({ status: 'continuation_pending', operation_id: claim.operation_id,
      context_complete: false, pin_transfer: false, report_update: 'none' });
  } catch (error) {
    try { const reason = failureReason(error), outcome = await transaction(pool, client => repositoryFactory(client).failClaim(claim, reason));
      return Object.freeze({ status: outcome.status, operation_id: claim.operation_id, reason });
    } catch (failure) {
      if (failure?.message === 'custom_cohort_capture_job_claim_lost' || failure?.outcome_unknown)
        return Object.freeze({ status: 'outcome_unknown', operation_id: claim.operation_id });
      throw failure;
    }
  } finally { stopping = true; clearTimeout(timer); await heartbeatPromise?.catch(() => {}); }
}
