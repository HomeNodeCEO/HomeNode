import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository, FROZEN_ORIGINALS_V2_EXECUTION }
  from './customCohortCaptureJobRepository.js';
import { createCustomCohortInitialV2JobRepository } from './customCohortInitialV2JobRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';

const failureReason = error => error?.message === 'custom_cohort_job_actor_access_revoked'
  || error?.reason === 'assignment_access_denied' ? 'access_revoked'
  : ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed'].includes(error?.reason)
    ? error.reason : 'capture_failed';

/** One dormant enrolled initial capture: actual frozen stock, then ONE actual
 * source-prefix page. The prefix owner alone issues the native success/release.
 * A crash between owners reopens the immutable stock on ordinary recovery.
 * No free job adoption, public route, default scheduler or publication. */
export async function runCustomCohortInitialV2JobOnce({ pool, cohortService,
  claimRepositoryFactory = createCustomCohortInitialV2JobRepository,
  repositoryFactory = createCustomCohortCaptureJobRepository,
  loadActor = loadCurrentCustomCohortJobActor, leaseSeconds = 300, heartbeatSeconds = 15 } = {}) {
  if (typeof pool?.connect !== 'function' || !['prepareFrozenCaptureJobStock', 'continueFrozenCaptureJobSourcePrefixReferencesV2Page']
    .every(method => typeof cohortService?.[method] === 'function')
    || ![claimRepositoryFactory, repositoryFactory, loadActor].every(value => typeof value === 'function')
    || !Number.isInteger(leaseSeconds) || leaseSeconds < CAPTURE_JOB_LEASE_SECONDS.min
    || leaseSeconds > CAPTURE_JOB_LEASE_SECONDS.max || !Number.isInteger(heartbeatSeconds)
    || heartbeatSeconds < 1 || heartbeatSeconds * 3 >= leaseSeconds) {
    throw new TypeError('custom_cohort_initial_v2_worker_invalid_input');
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
    if (request.execution_mode !== FROZEN_ORIGINALS_V2_EXECUTION || request.private_sales_import
      || request.operation_id !== claim.operation_id || request.discovery?.profile_id !== 'custom-suburban-radius-v2') {
      throw new TypeError('custom_cohort_initial_v2_worker_invalid_job');
    }
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    timer = setTimeout(heartbeat, heartbeatSeconds * 1000);
    const input = { auth, accountId: scope.account_id, assignmentFileId: scope.assignment_file_id,
      operationId: request.operation_id, observationPeriod: request.observation_period, discovery: request.discovery };
    const options = { captureJobClaim: claim, signal: controller.signal };
    const stock = await cohortService.prepareFrozenCaptureJobStock(input, options);
    if (stock?.status !== 'stock_prepared' || stock.operation_id !== claim.operation_id || stock.report_update !== 'none') {
      throw new TypeError('custom_cohort_initial_v2_worker_invalid_stock');
    }
    await checkHeartbeat();
    if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { reason: 'cancelled' });
    const result = await cohortService.continueFrozenCaptureJobSourcePrefixReferencesV2Page(input, options);
    const continuation = result?.continuation;
    if (result?.status !== 'source_reference_prefix_retained' || result.operation_id !== claim.operation_id
      || result.context_complete !== false || result.pin_transfer !== false || result.report_update !== 'none'
      || continuation?.status !== 'continuation_pending' || continuation.phase !== 'frozen_source_refs_v2'
      || continuation.attempts !== claim.attempts || continuation.fresh_claim_required !== true
      || continuation.context_complete !== false || continuation.pin_transfer !== false) {
      throw new TypeError('custom_cohort_initial_v2_worker_invalid_result');
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
