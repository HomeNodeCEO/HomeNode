import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository }
  from './customCohortCaptureJobRepository.js';
import { createCustomCohortV2CatalogWorkerRepository }
  from './customCohortV2CatalogWorkerRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';

const ROUTES = Object.freeze({
  frozen_stock_traversal_refs_v2: Object.freeze(['continueOriginalFrozenCaptureJobStockTraversalReferencesV2',
    'continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2']),
  frozen_recorded_partition_refs_v2: Object.freeze(['continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2',
    'continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2']),
  frozen_recorded_catalog_refs_v2: Object.freeze(['continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2',
    'awaitOriginalFrozenCaptureJobSelectionReferencesV2']),
});
const METHODS = [...new Set(Object.values(ROUTES).flat())];
const RESULT_STATUSES = Object.freeze({
  continueOriginalFrozenCaptureJobStockTraversalReferencesV2: 'original_stock_traversal_progress_retained',
  continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2: 'original_recorded_partition_progress_retained',
  continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2: 'original_recorded_catalog_progress_retained',
  awaitOriginalFrozenCaptureJobSelectionReferencesV2: 'awaiting_selection',
});
function failureReason(error) {
  if (error?.message === 'custom_cohort_job_actor_access_revoked'
    || error?.reason === 'assignment_access_denied') return 'access_revoked';
  return ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed'].includes(error?.reason)
    ? error.reason : 'capture_failed';
}

/** One dormant V2 catalog step using the actual original-reconciling owner.
 * This never enqueues or starts capture, chooses human groups, completes a
 * context, transfers pins or publishes a report. Every step requires fresh DB
 * actor/assignment/subject/source authorization inside that existing owner.
 * No default worker, HTTP route, CLI or schedule imports this entry point.
 */
export async function runCustomCohortV2CatalogJobOnce({ pool, cohortService,
  claimRepositoryFactory = createCustomCohortV2CatalogWorkerRepository,
  repositoryFactory = createCustomCohortCaptureJobRepository,
  loadActor = loadCurrentCustomCohortJobActor, leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || !METHODS.every(method => typeof cohortService?.[method] === 'function')
    || ![claimRepositoryFactory, repositoryFactory, loadActor].every(value => typeof value === 'function')
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
    || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max || !Number.isInteger(heartbeatSeconds)
    || heartbeatSeconds < 1 || heartbeatSeconds * 3 >= leaseSeconds) {
    throw new TypeError('custom_cohort_v2_catalog_worker_invalid_input');
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
    const { auth, request } = await transaction(pool, async client => {
      const auth = await loadActor(client, row.actor_user_id, scope.organization_id);
      const request = await repositoryFactory(client).readRequest(claim, { scope, actorUserId: row.actor_user_id });
      return { auth, request };
    });
    // The route hint cannot change request identity, discovery, dates or a
    // source decision. An unsupported or changed phase refuses in the owner.
    const route = ROUTES[row.phase];
    if (!route || typeof row.progress_done !== 'boolean' || request.private_sales_import
      || request.operation_id !== claim.operation_id
      || request.discovery?.profile_id !== 'custom-suburban-radius-v2') {
      throw new TypeError('custom_cohort_v2_catalog_worker_invalid_job');
    }
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    const method = route[row.progress_done ? 1 : 0];
    const result = await cohortService[method]({ auth, accountId: scope.account_id,
      assignmentFileId: scope.assignment_file_id, operationId: request.operation_id,
      observationPeriod: request.observation_period, discovery: request.discovery }, {
      captureJobClaim: claim, signal: controller.signal,
    });
    const waiting = method === 'awaitOriginalFrozenCaptureJobSelectionReferencesV2';
    if (result?.operation_id !== claim.operation_id || result.status !== RESULT_STATUSES[method]
      || result.context_complete === true || result.pin_transfer === true || result.report_update !== 'none'
      || (waiting ? result.context_complete !== false || result.pin_transfer !== false || result.genuine_selection_intent !== false
        : result.continuation?.status !== 'continuation_pending'
          || result.continuation.context_complete !== false || result.continuation.pin_transfer !== false
          || result.continuation.fresh_claim_required !== true || result.continuation.attempts !== claim.attempts)) {
      throw new TypeError('custom_cohort_v2_catalog_worker_invalid_result');
    }
    // Status only: no original rows, source-derived counts, auth or claim token.
    return Object.freeze({ status: waiting ? 'awaiting_selection' : 'continuation_pending',
      operation_id: claim.operation_id, context_complete: false, pin_transfer: false, report_update: 'none' });
  } catch (error) {
    try {
      const reason = failureReason(error), outcome = await transaction(pool,
        client => repositoryFactory(client).failClaim(claim, reason));
      return Object.freeze({ status: outcome.status, operation_id: claim.operation_id, reason });
    } catch (failure) {
      // The original owner may have committed its success/wait while its ACK
      // was lost. Never downgrade that state or overwrite a successor lease.
      if (failure?.message === 'custom_cohort_capture_job_claim_lost' || failure?.outcome_unknown)
        return Object.freeze({ status: 'outcome_unknown', operation_id: claim.operation_id });
      throw failure;
    }
  } finally {
    stopping = true; clearTimeout(timer);
    await heartbeatPromise?.catch(() => {});
  }
}
