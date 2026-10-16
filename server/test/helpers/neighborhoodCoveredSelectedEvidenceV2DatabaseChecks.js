import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as mainClaims } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { runCustomCohortInitialV2JobOnce as runInitial } from '../../src/services/neighborhoodAssessment/customCohortInitialV2JobWorker.js';
import { runCustomCohortSourcePrefixV2JobOnce as runPrefix } from '../../src/services/neighborhoodAssessment/customCohortSourcePrefixV2JobWorker.js';
import { runCustomCohortV2EarlyJobOnce as runEarly } from '../../src/services/neighborhoodAssessment/customCohortV2EarlyJobWorker.js';
import { runCustomCohortNeutralCacheV2JobOnce as runCache } from '../../src/services/neighborhoodAssessment/customCohortNeutralCacheV2JobWorker.js';
import { runCustomCohortCadCacheV2JobOnce as runCad } from '../../src/services/neighborhoodAssessment/customCohortCadCacheV2JobWorker.js';
import { runCustomCohortCacheStockV2JobOnce as runBridge } from '../../src/services/neighborhoodAssessment/customCohortCacheStockV2JobWorker.js';
import { runCustomCohortCoveredStockV2JobOnce as runStock } from '../../src/services/neighborhoodAssessment/customCohortCoveredStockV2JobWorker.js';
import { runCustomCohortCoveredPartitionV2JobOnce as runPartition } from '../../src/services/neighborhoodAssessment/customCohortCoveredPartitionV2JobWorker.js';
import { runCustomCohortCoveredCatalogV2JobOnce as runCatalog } from '../../src/services/neighborhoodAssessment/customCohortCoveredCatalogV2JobWorker.js';
import { runCustomCohortCoveredSelectionWaitV2JobOnce as runWait } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectionWaitV2JobWorker.js';
import { runCustomCohortCoveredSelectedInitialV2JobOnce as runSelectedInitial } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2JobWorker.js';
import { runCustomCohortCoveredSelectedProgressV2JobOnce as runSelectedProgress } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedProgressV2JobWorker.js';
import { runCustomCohortCoveredSelectedEvidenceV2JobOnce as runEvidence } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedEvidenceV2JobWorker.js';
import { NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import { CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as CAD_RIGHTS }
  from '../../src/security/customNeighborhoodCadImprovementSourcePolicy.js';

/** Independent real job/parents; no old receipt, head, checkpoint or native
 * selection is copied. Existing earlier boundary/failure fixtures stay intact.
 * Same matrix/deadline; real fixture-only selection is never a production choice. */
export async function runNeighborhoodCoveredSelectedEvidenceV2DatabaseChecks({ pool, input: sourceInput, scope, actor,
  authorizeMarketData, authorizeCadImprovementData }) {
  const input = { ...sourceInput, operationId: randomUUID() }, operation = input.operationId;
  let fault = null, originalReads = 0;
  const observed = { async connect() { const raw = await pool.connect(); return { release: raw.release.bind(raw), async query(c) {
    const text = typeof c === 'string' ? c : c.text, orphan = fault === 'orphan' && text.includes('custom-cohort-v2-continuation:yield');
    if (orphan) await raw.query('SAVEPOINT synthetic_evidence_orphan');
    const result = await raw.query(c);
    if (orphan) { fault = null; await raw.query('ROLLBACK TO SAVEPOINT synthetic_evidence_orphan'); await raw.query('RELEASE SAVEPOINT synthetic_evidence_orphan'); }
    if (text === PACKET) {
      originalReads++;
      if (fault === 'role') { fault = null; await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2', [scope.organization_id, actor]); }
      if (fault === 'workspace') { fault = null; await raw.query(`UPDATE app.custom_appraisal_workfile_sections
        SET section_value=jsonb_set(section_value,'{pending_capture,operation_id}',to_jsonb($2::text))
        WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id, randomUUID()]); }
      if (fault === 'cad') { fault = null; await raw.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text,'revoked_at'],
        to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=$1`, [scope.organization_id, CAD_RIGHTS]); }
    }
    if (fault === 'ack' && text === 'COMMIT') { fault = null; throw Error('lost actual evidence owner COMMIT ACK'); }
    return result;
  } }; } }, service = createCustomCohortContextCapture({ pool: observed, sourceMode: 'combined-witness2-v1', authorizeMarketData, authorizeCadImprovementData }),
    args = { pool, cohortService: service, leaseSeconds: 900 }, job = async () => (await pool.query(
      'SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1', [operation])).rows[0],
    workspace = async () => (await pool.query(`SELECT revision,section_value FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id])).rows[0];
  const drain = async (worker, limit) => {
    for (let i = 0; i < limit; i++) { const r = await worker(args); if (r.status === 'idle') return;
      assert.equal(r.operation_id, operation); assert.equal(r.status, 'continuation_pending'); }
    assert.fail('bounded independent evidence parent lane did not end');
  };
  await service.queueFrozenOriginalCaptureJobV2(input); assert.equal((await runInitial(args)).status, 'continuation_pending');
  for (const [worker, limit] of [[runPrefix, 12], [runEarly, 100], [runCache, 50], [runCad, 10]]) await drain(worker, limit);
  assert.equal((await runBridge(args)).status, 'continuation_pending');
  for (const worker of [runStock, runPartition, runCatalog]) await drain(worker, 10);
  const beforeWorkspace = await workspace(), stored = await service.startRecordedGroupCapture({ auth: input.auth, accountId: input.accountId,
    assignmentFileId: input.assignmentFileId, expectedWorkspaceRevision: beforeWorkspace?.revision ?? 0,
    expectedWorkspaceCheckpoint: beforeWorkspace?.section_value ?? { workspace_version: 7, active: null, pending_capture: null },
    pendingCapture: { operation_id: operation, observation_period: input.observationPeriod, discovery: input.discovery } });
  assert.equal(stored.status, 'stored'); assert.equal((await runWait(args)).status, 'awaiting_selection');
  const pendingWorkspace = await workspace(), catalog = (await pool.query(
    'SELECT * FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    selectedIds = (await pool.query('SELECT group_id FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=$1 ORDER BY group_id', [operation])).rows.map(r => r.group_id);
  const command = { command_id: randomUUID(), catalog_reference: catalog.receipt_reference,
    workspace_revision: pendingWorkspace.revision, included_recorded_group_ids: selectedIds };
  await service.resumeCoveredOriginalFrozenCaptureJobSelectionIntentReferencesV2(input, { selectionIntent: command });
  assert.equal((await runSelectedInitial(args)).status, 'continuation_pending'); await drain(runSelectedProgress, 12);
  assert.equal((await job()).checkpoint.phase, 'frozen_selected_eligibility_refs_v2');
  const nativeParents = async () => ({ neutral: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=$1', [operation])).rows,
    cad: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1', [operation])).rows,
    union: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1', [operation])).rows,
    eligibility: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1', [operation])).rows,
    intent: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1', [operation])).rows,
    pins: (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1', [operation])).rows }),
    parents = await nativeParents(), evidence = async () => (await pool.query(
      'SELECT * FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    method = 'progressCoveredOriginalFrozenCaptureJobSelectedEvidenceReferencesV2';
  fault = 'cad'; assert.equal((await runEvidence(args)).reason, 'capture_failed'); assert.equal(fault, null);
  assert.equal((await job()).attempts, 1); assert.equal(await evidence(), undefined); assert.deepEqual(await nativeParents(), parents);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1', [operation]);
  let ownerClaim;
  const firstArgs = { ...args, cohortService: { async [method](value, options) {
    ownerClaim = options.captureJobClaim; assert.equal(ownerClaim.attempts, 2); const claimed = await job();
    for (const [probe, reason] of [['workspace', /custom_cohort_group_workspace_study_changed/], ['role', /job_actor_access_revoked/],
      ['cad', /market_data_access_denied/], ['orphan', e => e.outcome_unknown === true && e.code === '55000']]) {
      fault = probe; const reads = originalReads; await assert.rejects(service[method](value, options), reason);
      assert.equal(fault, null); assert.equal(originalReads, reads + 1);
      if (probe === 'role') await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [scope.organization_id, actor]);
      assert.deepEqual(await job(), claimed); assert.equal(await evidence(), undefined); assert.deepEqual(await nativeParents(), parents);
      assert.deepEqual(await workspace(), pendingWorkspace);
    }
    fault = 'ack'; return service[method](value, options);
  } } };
  assert.equal((await runEvidence(firstArgs)).status, 'outcome_unknown'); assert.equal(fault, null);
  const first = await evidence(); assert.equal(first.sequence, 1); assert.equal((await job()).attempts, 2);
  await assert.rejects(service[method](input, { captureJobClaim: ownerClaim }), /claim_lost/);
  const entries = [];
  for (const done of [false, true]) {
    const result = await runEvidence({ ...args, cohortService: { async [method](value, options) {
      assert.equal(options.captureJobClaim.attempts, 2); assert.notEqual(options.captureJobClaim.claim_token, ownerClaim.claim_token);
      const step = await service[method](value, options); entries.push(step.selected_entry);
      assert.equal(step.covered_CAD_originals, true); assert.equal(step.covered_neutral_originals, true);
      assert.equal(step.read_only, false); assert.equal(step.progress.done, done); assert.equal(step.context_complete, false);
      assert.equal(step.pin_transfer, false); assert.equal(step.report_update, 'none'); assert.ok(Buffer.byteLength(JSON.stringify(step)) <= 16000);
      return step;
    } } });
    assert.equal(result.status, 'continuation_pending'); assert.equal((await job()).attempts, 2);
    assert.equal((await job()).last_error_code, 'capture_failed');
  }
  assert.equal(entries[0].ordinal, 2); assert.equal(entries[1], null); assert.equal((await evidence()).sequence, 3);
  assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  const doneJob = await job(); assert.equal(doneJob.checkpoint.phase, 'frozen_selected_evidence_refs_v2');
  assert.equal(doneJob.checkpoint.evidence_refs.length, 12); assert.equal(doneJob.context_sha256, null);
  assert.deepEqual(await runEvidence(args), { status: 'idle' }); assert.deepEqual(await runEvidence(args), { status: 'idle' });
  assert.deepEqual(await job(), doneJob);
  const [nextOwner] = await tx(pool, client => mainClaims(client).claimDue({ limit: 1, leaseSeconds: 900 }));
  assert.equal(nextOwner.claim.operation_id, operation); assert.equal(nextOwner.claim.attempts, 2);
  await pool.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [operation]);
  await tx(pool, client => jobs(client).cancel(scope, operation)); const nextPending = await job();
  assert.deepEqual(await runEvidence(args), { status: 'idle' }); assert.deepEqual(await job(), nextPending,
    'both claim AND expiry leave the expired/cancelled evidence-DONE numerical owner untouched');
  assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  console.info('[native-covered-selected-original-evidence-population-v2]', { independent_actual_original_job_and_all_native_parents: true,
    actual_complete_selected_two_accounts_and_distinct_EMPTY: true, same_selected_subject_CAD_transaction_whole_original_packet: true,
    ending_CAD_role_workspace_and_orphan_COMMIT_refuse_atomically: true, genuine_failure_then_attempt2_success_history_preserved: true,
    real_lost_ACK_fresh_next_ordinal_and_terminal_EMPTY: true, evidence_DONE_all_claim_and_expiry_lanes_excluded: true,
    native_parents_originals_selection_workspace_pins_preserved: true, unchanged_aggregate_original_bytes_queries_deadline_output_caps: true,
    complete_selected_numerics: false, context_complete: false, publication: false, pin_transfer: false,
    licensed_large_area: false, production_speed: false });
}
