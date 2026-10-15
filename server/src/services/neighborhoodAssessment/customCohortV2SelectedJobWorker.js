import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository }
  from './customCohortCaptureJobRepository.js';
import { createCustomCohortV2SelectedWorkerRepository }
  from './customCohortV2SelectedWorkerRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';

// Fixed installed original owners only. No read-only/fixed-first helper or
// unregistered transaction-index owner can be substituted for a population pass.
const STAGES = Object.freeze([
  ['frozen_selected_union_refs_v2', 'continueOriginalFrozenCaptureJobSelectedStockUnionReferencesV2',
    'original_selected_stock_union_replay_progress_retained'],
  ['frozen_selected_eligibility_refs_v2', 'progressOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2',
    'original_selected_recorded_eligibility_progress_retained'],
  ['frozen_selected_evidence_refs_v2', 'progressOriginalFrozenCaptureJobSelectedEvidenceReferencesV2',
    'original_selected_evidence_traversal_progress_retained'],
  ['frozen_selected_metrics_refs_v2', 'progressOriginalFrozenCaptureJobSelectedMetricReferencesV2',
    'original_selected_reported_metric_progress_retained'],
  ['frozen_selected_statistics_refs_v2', 'progressOriginalFrozenCaptureJobSelectedStatisticsReferencesV2',
    'original_selected_statistics_contribution_progress_retained'],
  ['frozen_selected_numeric_refs_v2', 'progressOriginalFrozenCaptureJobSelectedNumericReferencesV2',
    'original_selected_numeric_progress_retained'],
  ['frozen_selected_semantic_refs_v2', 'progressOriginalFrozenCaptureJobSelectedSemanticReferencesV2',
    'original_selected_semantic_progress_retained'],
].map(Object.freeze));
const failureReason = error => error?.message === 'custom_cohort_job_actor_access_revoked'
  || error?.reason === 'assignment_access_denied' ? 'access_revoked'
  : ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed'].includes(error?.reason)
    ? error.reason : 'capture_failed';

/** One dormant selected-study continuation. The actual bounded owner reopens
 * every required original/cache/native parent and all current/ending rights.
 * Returns status only; semantic DONE is left unclaimed, not publication or a
 * completed context. No route, default worker, CLI or schedule imports this.
 */
export async function runCustomCohortV2SelectedJobOnce({ pool, cohortService,
  claimRepositoryFactory = createCustomCohortV2SelectedWorkerRepository,
  repositoryFactory = createCustomCohortCaptureJobRepository,
  loadActor = loadCurrentCustomCohortJobActor, leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || !STAGES.every(([, method]) => typeof cohortService?.[method] === 'function')
    || ![claimRepositoryFactory, repositoryFactory, loadActor].every(value => typeof value === 'function')
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
    || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max || !Number.isInteger(heartbeatSeconds)
    || heartbeatSeconds < 1 || heartbeatSeconds * 3 >= leaseSeconds) {
    throw new TypeError('custom_cohort_v2_selected_worker_invalid_input');
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
    if (index < 0 || typeof row.progress_done !== 'boolean' || index === STAGES.length - 1 && row.progress_done
      || request.private_sales_import || request.operation_id !== claim.operation_id
      || request.discovery?.profile_id !== 'custom-suburban-radius-v2') {
      throw new TypeError('custom_cohort_v2_selected_worker_invalid_job');
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
      throw new TypeError('custom_cohort_v2_selected_worker_invalid_result');
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
