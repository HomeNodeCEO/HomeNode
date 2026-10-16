import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runNeighborhoodGroupIndex } from '../../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';
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
import { runCustomCohortCoveredSelectedMetricsV2JobOnce as runMetrics } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedMetricsV2JobWorker.js';
import { runCustomCohortCoveredSelectedStatisticsV2JobOnce as runStatistics } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedStatisticsV2JobWorker.js';
import { runCustomCohortCoveredSelectedNumericV2JobOnce as runNumeric } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedNumericV2JobWorker.js';
import { runCustomCohortCoveredSelectedSemanticV2JobOnce as runSemantic } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedSemanticV2JobWorker.js';
import { NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as METRIC_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as STATISTICS_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL as NUMERIC_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL as SEMANTIC_PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import { CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as CAD_RIGHTS }
  from '../../src/security/customNeighborhoodCadImprovementSourcePolicy.js';

/** Independent real job/parents; no old receipt, head, checkpoint or native
 * selection is copied. Existing earlier boundary/failure fixtures stay intact.
 * Same matrix/deadline; real fixture-only selection is never a production choice. */
export async function runNeighborhoodCoveredSelectedEvidenceV2DatabaseChecks({ pool, input: sourceInput, scope, actor,
  authorizeMarketData, authorizeCadImprovementData }) {
  const input = { ...sourceInput, operationId: randomUUID() }, operation = input.operationId;
  // The preceding independent fixture already exercises its large original
  // byte boundary. Capture a NEW positive-worker source from live fixture
  // tables, without cloning/rebinding any old original, cache, parent or head.
  // Every worker below still reopens this generation's COMPLETE originals.
  const priorGeneration = (await pool.query('SELECT generation_id::text FROM app.neighborhood_group_active WHERE id=true')).rows[0].generation_id,
    priorLargeOriginal = async () => (await pool.query(`SELECT row_key,payload::text AS original FROM app.neighborhood_frozen_source_rows
      WHERE generation_id=$1 AND kind='accounts' AND account_id='CLOSURE-A' ORDER BY row_key LIMIT 2`, [priorGeneration])).rows,
    largeBefore = await priorLargeOriginal(), sync = randomUUID();
  assert.equal(largeBefore.length, 1); assert.ok(Buffer.byteLength(largeBefore[0].original) > 480000);
  await pool.query("UPDATE core.accounts SET legal_description='Independent covered worker positive source' WHERE account_id='CLOSURE-A'");
  await pool.query("INSERT INTO gis.source_sync_runs(id,source_key,status,records_seen) VALUES($1,'dcad_parcels','complete',5)", [sync]);
  await pool.query("UPDATE gis.source_sync_state SET status='complete',last_run_id=$1 WHERE source_key='dcad_parcels'", [sync]);
  const positiveSource = await runNeighborhoodGroupIndex(pool, { batchSize: 2, logger: { info() {} },
    retainOriginalSources: true, retainCadImprovementOriginals: true });
  assert.notEqual(positiveSource.generationId, priorGeneration); assert.deepEqual(await priorLargeOriginal(), largeBefore);
  assert.equal((await pool.query(`SELECT payload->>'legal_description' AS original FROM app.neighborhood_frozen_source_rows
    WHERE generation_id=$1 AND kind='accounts' AND account_id='CLOSURE-A'`, [positiveSource.generationId])).rows[0].original,
  'Independent covered worker positive source');
  let fault = null, originalReads = 0;
  const observed = { async connect() { const raw = await pool.connect(); return { release: raw.release.bind(raw), async query(c) {
    const text = typeof c === 'string' ? c : c.text, orphan = fault === 'orphan' && text.includes('custom-cohort-v2-continuation:yield');
    if (orphan) await raw.query('SAVEPOINT synthetic_evidence_orphan');
    const result = await raw.query(c);
    if (orphan) { fault = null; await raw.query('ROLLBACK TO SAVEPOINT synthetic_evidence_orphan'); await raw.query('RELEASE SAVEPOINT synthetic_evidence_orphan'); }
    if ([PACKET, METRIC_PACKET, STATISTICS_PACKET, NUMERIC_PACKET, SEMANTIC_PACKET].includes(text)) {
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
  let beforeWorkspace = await workspace();
  if (beforeWorkspace?.section_value.pending_capture) {
    // The earlier independent fixture intentionally leaves its pending study.
    // Respect the real closed transition: explicitly cancel THAT fixture-only
    // pending command through its current scoped owner, preserving active data.
    const activeBefore = beforeWorkspace.section_value.active;
    const cancelled = await service.cancelRecordedGroupCapture({ auth: input.auth, accountId: input.accountId,
      assignmentFileId: input.assignmentFileId, expectedWorkspaceRevision: beforeWorkspace.revision,
      expectedWorkspaceCheckpoint: beforeWorkspace.section_value });
    assert.equal(cancelled.status, 'stored');
    const cleared = await workspace(); assert.equal(cleared.revision, beforeWorkspace.revision + 1);
    assert.equal(cleared.section_value.pending_capture, null); assert.deepEqual(cleared.section_value.active, activeBefore);
    beforeWorkspace = cleared;
  }
  const stored = await service.startRecordedGroupCapture({ auth: input.auth, accountId: input.accountId,
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
  // Extend this independently issued job through the genuine next owner.
  // No receipt/head/checkpoint is copied, no expired claim is restored, and
  // the earlier evidence-boundary and failure assertions remain above.
  const evidenceDone = await evidence(), metricMethod = 'progressCoveredOriginalFrozenCaptureJobSelectedMetricReferencesV2',
    metrics = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    metricRows = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_rows WHERE operation_id=$1 ORDER BY ordinal', [operation])).rows;
  fault = 'cad'; assert.equal((await runMetrics(args)).reason, 'capture_failed'); assert.equal(fault, null);
  assert.equal((await job()).attempts, 2); assert.equal(await metrics(), undefined); assert.deepEqual(await metricRows(), []);
  assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1', [operation]);
  let metricClaim;
  assert.equal((await runMetrics({ ...args, cohortService: { async [metricMethod](value, options) {
    metricClaim = options.captureJobClaim; assert.equal(metricClaim.attempts, 3); const claimed = await job();
    for (const [probe, reason] of [['workspace', /custom_cohort_group_workspace_study_changed/], ['role', /job_actor_access_revoked/],
      ['cad', /market_data_access_denied/], ['orphan', e => e.outcome_unknown === true && e.code === '55000']]) {
      fault = probe; const reads = originalReads; await assert.rejects(service[metricMethod](value, options), reason);
      assert.equal(fault, null); assert.equal(originalReads, reads + 1);
      if (probe === 'role') await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [scope.organization_id, actor]);
      assert.deepEqual(await job(), claimed); assert.equal(await metrics(), undefined); assert.deepEqual(await metricRows(), []);
      assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
    }
    fault = 'ack'; return service[metricMethod](value, options);
  } } })).status, 'outcome_unknown');
  assert.equal(fault, null); assert.equal((await metrics()).sequence, 1); assert.equal((await metricRows()).length, 1);
  await assert.rejects(service[metricMethod](input, { captureJobClaim: metricClaim }), /claim_lost/);
  for (const done of [false, true]) {
    assert.equal((await runMetrics({ ...args, cohortService: { async [metricMethod](value, options) {
      assert.equal(options.captureJobClaim.attempts, 3); assert.notEqual(options.captureJobClaim.claim_token, metricClaim.claim_token);
      const reads = originalReads, step = await service[metricMethod](value, options); assert.equal(originalReads, reads + 1);
      assert.equal(step.covered_CAD_originals, true); assert.equal(step.covered_neutral_originals, true);
      assert.equal(step.read_only, false); assert.equal(step.progress.done, done); assert.equal(step.metric_row_retained, !done);
      assert.equal(step.original_reconciled_reported_metric_rows_complete, done); assert.equal(step.statistics, 'not_established');
      assert.equal(step.context_complete, false); assert.equal(step.pin_transfer, false); assert.equal(step.report_update, 'none');
      assert.ok(Buffer.byteLength(JSON.stringify(step)) <= 16000); return step;
    } } })).status, 'continuation_pending');
    assert.equal((await job()).attempts, 3); assert.equal((await job()).last_error_code, 'capture_failed');
  }
  const rows = await metricRows(); assert.deepEqual(rows.map(r => r.ordinal), [1, 2]); assert.notEqual(rows[0].account_id, rows[1].account_id);
  assert.equal((await metrics()).sequence, 3); const metricsDoneJob = await job();
  assert.equal(metricsDoneJob.checkpoint.phase, 'frozen_selected_metrics_refs_v2'); assert.equal(metricsDoneJob.checkpoint.evidence_refs.length, 13);
  assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  assert.deepEqual(await runMetrics(args), { status: 'idle' }); assert.deepEqual(await runMetrics(args), { status: 'idle' });
  assert.deepEqual(await runEvidence(args), { status: 'idle' }); assert.deepEqual(await job(), metricsDoneJob);
  const metricHeadDone = await metrics(), statisticsMethod = 'progressCoveredOriginalFrozenCaptureJobSelectedStatisticsReferencesV2',
    statistics = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    contributionRows = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows WHERE operation_id=$1 ORDER BY ordinal', [operation])).rows;
  fault = 'cad'; assert.equal((await runStatistics(args)).reason, 'capture_failed'); assert.equal(fault, null);
  assert.equal((await job()).attempts, 3); assert.equal(await statistics(), undefined); assert.deepEqual(await contributionRows(), []);
  assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1', [operation]);
  let statisticsClaim;
  assert.equal((await runStatistics({ ...args, cohortService: { async [statisticsMethod](value, options) {
    statisticsClaim = options.captureJobClaim; assert.equal(statisticsClaim.attempts, 4); const claimed = await job();
    for (const [probe, reason] of [['workspace', /custom_cohort_group_workspace_study_changed/], ['role', /job_actor_access_revoked/],
      ['cad', /market_data_access_denied/], ['orphan', e => e.outcome_unknown === true && e.code === '55000']]) {
      fault = probe; const reads = originalReads; await assert.rejects(service[statisticsMethod](value, options), reason);
      assert.equal(fault, null); assert.equal(originalReads, reads + 1);
      if (probe === 'role') await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [scope.organization_id, actor]);
      assert.deepEqual(await job(), claimed); assert.equal(await statistics(), undefined); assert.deepEqual(await contributionRows(), []);
      assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
      assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
    }
    fault = 'ack'; return service[statisticsMethod](value, options);
  } } })).status, 'outcome_unknown');
  assert.equal(fault, null); assert.equal((await statistics()).sequence, 1); assert.equal((await contributionRows()).length, 1);
  await assert.rejects(service[statisticsMethod](input, { captureJobClaim: statisticsClaim }), /claim_lost/);
  for (const done of [false, true]) {
    assert.equal((await runStatistics({ ...args, cohortService: { async [statisticsMethod](value, options) {
      assert.equal(options.captureJobClaim.attempts, 4); assert.notEqual(options.captureJobClaim.claim_token, statisticsClaim.claim_token);
      const reads = originalReads, step = await service[statisticsMethod](value, options); assert.equal(originalReads, reads + 1);
      assert.equal(step.covered_CAD_originals, true); assert.equal(step.covered_neutral_originals, true);
      assert.equal(step.read_only, false); assert.equal(step.progress.done, done); assert.equal(step.statistics_contribution_retained, !done);
      assert.equal(step.complete_original_reconciled_contribution_pass, done); assert.equal(step.statistics, 'not_established');
      assert.equal(step.exact_distributions, false); assert.equal(step.frequency_ledger, false);
      assert.equal(step.context_complete, false); assert.equal(step.pin_transfer, false); assert.equal(step.report_update, 'none');
      assert.ok(Buffer.byteLength(JSON.stringify(step)) <= 16000); return step;
    } } })).status, 'continuation_pending');
    assert.equal((await job()).attempts, 4); assert.equal((await job()).last_error_code, 'capture_failed');
  }
  const contributions = await contributionRows(); assert.deepEqual(contributions.map(r => r.ordinal), [1, 2]);
  for (let i = 0; i < rows.length; i++) { assert.equal(contributions[i].account_id, rows[i].account_id);
    assert.deepEqual(contributions[i].metric_row_reference, rows[i].row_reference); }
  assert.equal((await statistics()).sequence, 3); const statisticsDoneJob = await job();
  assert.equal(statisticsDoneJob.checkpoint.phase, 'frozen_selected_statistics_refs_v2'); assert.equal(statisticsDoneJob.checkpoint.evidence_refs.length, 14);
  assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
  assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  assert.deepEqual(await runStatistics(args), { status: 'idle' }); assert.deepEqual(await runStatistics(args), { status: 'idle' });
  assert.deepEqual(await runMetrics(args), { status: 'idle' }); assert.deepEqual(await runEvidence(args), { status: 'idle' });
  assert.deepEqual(await job(), statisticsDoneJob);
  const statisticsHeadDone = await statistics(), numericMethod = 'progressCoveredOriginalFrozenCaptureJobSelectedNumericReferencesV2',
    numeric = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    numericRows = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows WHERE operation_id=$1 ORDER BY ordinal', [operation])).rows,
    numericIndex = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_index_v2_rows WHERE operation_id=$1 ORDER BY ordinal', [operation])).rows,
    indexBefore = await numericIndex();
  assert.deepEqual(indexBefore.map(r => r.ordinal), [1, 2]);
  fault = 'cad'; assert.equal((await runNumeric(args)).reason, 'capture_failed'); assert.equal(fault, null);
  assert.equal((await job()).attempts, 4); assert.equal(await numeric(), undefined); assert.deepEqual(await numericRows(), []);
  assert.deepEqual(await statistics(), statisticsHeadDone); assert.deepEqual(await contributionRows(), contributions); assert.deepEqual(await numericIndex(), indexBefore);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1', [operation]);
  let numericClaim;
  assert.equal((await runNumeric({ ...args, cohortService: { async [numericMethod](value, options) {
    numericClaim = options.captureJobClaim; assert.equal(numericClaim.attempts, 5); const claimed = await job();
    for (const [probe, reason] of [['workspace', /custom_cohort_group_workspace_study_changed/], ['role', /job_actor_access_revoked/],
      ['cad', /market_data_access_denied/], ['orphan', e => e.outcome_unknown === true && e.code === '55000']]) {
      fault = probe; const reads = originalReads; await assert.rejects(service[numericMethod](value, options), reason);
      assert.equal(fault, null); assert.equal(originalReads, reads + 1);
      if (probe === 'role') await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [scope.organization_id, actor]);
      assert.deepEqual(await job(), claimed); assert.equal(await numeric(), undefined); assert.deepEqual(await numericRows(), []);
      assert.deepEqual(await statistics(), statisticsHeadDone); assert.deepEqual(await contributionRows(), contributions); assert.deepEqual(await numericIndex(), indexBefore);
      assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
      assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
    }
    fault = 'ack'; return service[numericMethod](value, options);
  } } })).status, 'outcome_unknown');
  assert.equal(fault, null); assert.equal((await numeric()).sequence, 1); assert.equal((await numericRows()).length, 1);
  await assert.rejects(service[numericMethod](input, { captureJobClaim: numericClaim }), /claim_lost/);
  for (const done of [false, true]) {
    assert.equal((await runNumeric({ ...args, cohortService: { async [numericMethod](value, options) {
      assert.equal(options.captureJobClaim.attempts, 5); assert.notEqual(options.captureJobClaim.claim_token, numericClaim.claim_token);
      const reads = originalReads, step = await service[numericMethod](value, options); assert.equal(originalReads, reads + 1);
      assert.equal(step.covered_CAD_originals, true); assert.equal(step.covered_neutral_originals, true);
      assert.equal(step.read_only, false); assert.equal(step.progress.done, done); assert.equal(step.complete_original_reconciled_index_pass, done);
      assert.equal(step.complete_indexed_metric_population, done); assert.equal(step.statistics, 'not_established'); assert.equal(step.exact_distributions, false);
      assert.equal(step.context_complete, false); assert.equal(step.pin_transfer, false); assert.equal(step.report_update, 'none');
      assert.ok(Buffer.byteLength(JSON.stringify(step)) <= 16000); return step;
    } } })).status, 'continuation_pending');
    assert.equal((await job()).attempts, 5); assert.equal((await job()).last_error_code, 'capture_failed');
  }
  const numericCompletedRows = await numericRows(); assert.deepEqual(numericCompletedRows.map(r => r.ordinal), [1, 2]);
  assert.equal((await numeric()).sequence, 3); const numericDoneJob = await job();
  assert.equal(numericDoneJob.checkpoint.phase, 'frozen_selected_numeric_refs_v2'); assert.equal(numericDoneJob.checkpoint.evidence_refs.length, 15);
  assert.deepEqual(await statistics(), statisticsHeadDone); assert.deepEqual(await contributionRows(), contributions); assert.deepEqual(await numericIndex(), indexBefore);
  assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
  assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  assert.deepEqual(await runNumeric(args), { status: 'idle' }); assert.deepEqual(await runNumeric(args), { status: 'idle' });
  assert.deepEqual(await runStatistics(args), { status: 'idle' }); assert.deepEqual(await runMetrics(args), { status: 'idle' }); assert.deepEqual(await job(), numericDoneJob);
  const numericHeadDone = await numeric(), semanticMethod = 'progressCoveredOriginalFrozenCaptureJobSelectedSemanticReferencesV2',
    semantic = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=$1', [operation])).rows[0],
    semanticRows = async () => (await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_semantic_v2_rows WHERE operation_id=$1 ORDER BY ordinal', [operation])).rows,
    blobCount = async () => (await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [scope.organization_id])).rows[0].n;
  let semanticClaim;
  assert.equal((await runSemantic({ ...args, cohortService: { async [semanticMethod](value, options) {
    semanticClaim = options.captureJobClaim; assert.equal(semanticClaim.attempts, 5); const claimed = await job(), beforeBlobs = await blobCount();
    // The real failure ceiling is already5. Probe the actual owner's rollback
    // inside THIS valid claim; never manufacture a sixth recovery or refund.
    for (const [probe, reason] of [['workspace', /custom_cohort_group_workspace_study_changed/], ['role', /job_actor_access_revoked/],
      ['cad', /market_data_access_denied/], ['orphan', e => e.outcome_unknown === true && e.code === '55000']]) {
      fault = probe; const reads = originalReads; await assert.rejects(service[semanticMethod](value, options), reason);
      assert.equal(fault, null); assert.equal(originalReads, reads + 1);
      if (probe === 'role') await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [scope.organization_id, actor]);
      assert.deepEqual(await job(), claimed); assert.equal(await semantic(), undefined); assert.deepEqual(await semanticRows(), []); assert.equal(await blobCount(), beforeBlobs);
      assert.deepEqual(await numeric(), numericHeadDone); assert.deepEqual(await numericRows(), numericCompletedRows);
      assert.deepEqual(await statistics(), statisticsHeadDone); assert.deepEqual(await contributionRows(), contributions); assert.deepEqual(await numericIndex(), indexBefore);
      assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await metricRows(), rows);
      assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
    }
    fault = 'ack'; return service[semanticMethod](value, options);
  } } })).status, 'outcome_unknown');
  assert.equal(fault, null); assert.equal((await semantic()).sequence, 1); assert.equal((await semanticRows()).length, 1);
  await assert.rejects(service[semanticMethod](input, { captureJobClaim: semanticClaim }), /claim_lost/);
  let exactStatistics;
  for (const done of [false, true]) {
    assert.equal((await runSemantic({ ...args, cohortService: { async [semanticMethod](value, options) {
      assert.equal(options.captureJobClaim.attempts, 5); assert.notEqual(options.captureJobClaim.claim_token, semanticClaim.claim_token);
      const reads = originalReads, step = await service[semanticMethod](value, options); assert.equal(originalReads, reads + 1);
      assert.equal(step.covered_CAD_originals, true); assert.equal(step.covered_neutral_originals, true); assert.equal(step.read_only, false);
      assert.equal(step.progress.done, done); assert.equal(step.complete_original_reconciled_selected_union, done);
      if (done) { assert.ok(step.exact_statistics); exactStatistics = step.exact_statistics; } else assert.equal(step.exact_statistics, null);
      assert.equal(step.calendar_quarters, 'not_established'); assert.equal(step.economic_transactions, 'not_established'); assert.equal(step.publication, 'not_established');
      assert.equal(step.context_complete, false); assert.equal(step.pin_transfer, false); assert.equal(step.report_update, 'none');
      assert.ok(Buffer.byteLength(JSON.stringify(step)) <= 16000); return step;
    } } })).status, 'continuation_pending');
    assert.equal((await job()).attempts, 5); assert.equal((await job()).last_error_code, 'capture_failed');
  }
  // Independent exact two-account golden arithmetic, after the actual owner
  // reconciled EVERY indexed field to the whole originals again. Fixture DATA
  // supplies expected math only, never production source/population authority.
  const scaled = text => { const [whole, fraction = ''] = String(text).split('.'); return BigInt(whole + fraction.padEnd(14, '0')); },
    finite = n => { const v=n.toString().padStart(15,'0'),fraction=v.slice(-14).replace(/0+$/,''); return v.slice(0,-14)+(fraction?'.'+fraction:''); },
    ratio = (a,b) => { let x=a,y=b; while(y){const t=x%y;x=y;y=t;} return {numerator:(a/x).toString(),denominator:(b/x).toString()}; };
  for (const key of ['reported_year_built','reported_residential_area','reported_site_area']) {
    const values=indexBefore.map(r=>r[key]).filter(v=>v!==null).map(scaled).sort((a,b)=>a<b?-1:a>b?1:0),n=values.length,actual=exactStatistics[key];
    assert.equal(n,key==='reported_site_area'?2:1,'the independently captured fixture has genuine eligible observations');
    assert.equal(actual.selected_count,2); assert.equal(actual.observed_count,n);
    const median=n===0?null:n===1?values[0]:(values[0]+values[1])/2n;
    assert.equal(actual.median,median===null?null:finite(median));
    assert.equal(actual.q1,n===0?null:finite(n===1?values[0]:(3n*values[0]+values[1])/4n));
    assert.equal(actual.q3,n===0?null:finite(n===1?values[0]:(values[0]+3n*values[1])/4n));
    assert.deepEqual(actual.cod_percent,n===0||median===0n?null:ratio(100n*values.reduce((sum,v)=>sum+(v>median?v-median:median-v),0n),BigInt(n)*median));
    assert.equal(actual.cod_reason,!n?'no_eligible_observations':median===0n?'zero_median':null);
  }
  assert.equal(exactStatistics.reported_year_built.median,'1960');
  assert.equal(exactStatistics.reported_residential_area.median,'1000.01');
  assert.equal(exactStatistics.reported_site_area.q1,'2000'); assert.equal(exactStatistics.reported_site_area.median,'4000');
  assert.equal(exactStatistics.reported_site_area.q3,'6000');
  assert.deepEqual(exactStatistics.reported_site_area.cod_percent,{numerator:'100',denominator:'1'});
  const semanticCompletedRows=await semanticRows(); assert.deepEqual(semanticCompletedRows.map(r=>r.ordinal),[1,2]);
  assert.equal((await semantic()).sequence,3); const semanticDoneJob=await job();
  assert.equal(semanticDoneJob.checkpoint.phase,'frozen_selected_semantic_refs_v2'); assert.equal(semanticDoneJob.checkpoint.evidence_refs.length,16);
  assert.deepEqual(await runSemantic(args),{status:'idle'}); assert.deepEqual(await runSemantic(args),{status:'idle'}); assert.deepEqual(await runNumeric(args),{status:'idle'});
  assert.deepEqual(await job(),semanticDoneJob); assert.deepEqual(await numeric(),numericHeadDone); assert.deepEqual(await numericIndex(),indexBefore);
  const [nextOwner] = await tx(pool, client => mainClaims(client).claimDue({ limit: 1, leaseSeconds: 900 }));
  assert.equal(nextOwner.claim.operation_id, operation); assert.equal(nextOwner.claim.attempts, 5);
  await pool.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1", [operation]);
  await tx(pool, client => jobs(client).cancel(scope, operation)); const nextPending = await job();
  assert.deepEqual(await runEvidence(args), { status: 'idle' }); assert.deepEqual(await job(), nextPending,
    'both claim AND expiry leave the expired/cancelled evidence-DONE numerical owner untouched');
  assert.deepEqual(await runMetrics(args), { status: 'idle' }); assert.deepEqual(await job(), nextPending,
    'all metric claim AND expiry lanes leave the expired/cancelled metrics-DONE statistics owner untouched');
  assert.deepEqual(await runStatistics(args), { status: 'idle' }); assert.deepEqual(await job(), nextPending,
    'all contribution claim AND expiry lanes leave the expired/cancelled statistics-DONE numeric owner untouched');
  assert.deepEqual(await runNumeric(args), { status: 'idle' }); assert.deepEqual(await job(), nextPending,
    'all numeric claim AND expiry lanes leave the expired/cancelled numeric-DONE semantic owner untouched even at attempt5');
  assert.deepEqual(await runSemantic(args),{status:'idle'}); assert.deepEqual(await job(),nextPending,
    'all semantic claim AND expiry lanes leave the expired/cancelled semantic-DONE transaction owner untouched at attempt5');
  assert.deepEqual(await nativeParents(), parents); assert.deepEqual(await workspace(), pendingWorkspace);
  assert.deepEqual(await evidence(), evidenceDone); assert.deepEqual(await metricRows(), rows);
  assert.deepEqual(await metrics(), metricHeadDone); assert.deepEqual(await contributionRows(), contributions);
  assert.deepEqual(await statistics(), statisticsHeadDone); assert.deepEqual(await numericRows(), numericCompletedRows); assert.deepEqual(await numericIndex(), indexBefore);
  assert.deepEqual(await numeric(),numericHeadDone); assert.deepEqual(await semanticRows(),semanticCompletedRows);
  console.info('[native-covered-selected-original-exact-statistics-population-v2]', { actual_numeric_DONE_parent_and_independent_job:true,
    every_selected_whole_original_entire_cache_metric_contribution_index_and_ninth_field_reconciled_again:true,
    two_selected_semantic_rows_then_fresh_EMPTY_before_exact_statistics:true, independent_exact_fixture_median_quartile_COD_checks:true,
    ending_CAD_role_workspace_orphan_COMMIT_roll_back_summary_blobs_rows_head_and_release:true,
    lost_ACK_fresh_NEXT_stale_claim_refusal_and_success_at_attempt5_preserve_history:true, semantic_DONE_all_claim_expiry_lanes_excluded_at_attempt5:true,
    all_originals_indexes_prior_heads_rows_choices_workspace_pins_unchanged:true, all_aggregate_budgets_deadlines_failure_ceiling_unchanged:true,
    calendar_quarters:false,economic_historical_transaction_completeness:false,publication:false,pin_transfer:false,licensed_large_area:false,production_speed:false });
  console.info('[native-covered-selected-original-indexed-population-v2]', { actual_statistics_DONE_parent_and_independent_job: true,
    independent_actual_compact_source_capture_and_prior_large_original_preserved: true,
    whole_stock_CAD_transaction_subject_originals_entire_caches_every_metric_contribution_and_index_field_reconciled: true,
    native_two_selected_ordinals_and_fresh_EMPTY_same_TX_rows_head_checkpoint_release: true,
    ending_CAD_role_workspace_and_orphan_COMMIT_roll_back_head_and_rows: true,
    actual_failure_then_attempt5_fresh_success_preserves_failure_history: true, lost_ACK_fresh_NEXT_and_stale_claim_refusal: true,
    numeric_DONE_all_claim_and_expiry_lanes_excluded_at_attempt5: true, all_originals_metric_contribution_index_parents_choices_workspace_and_pins_preserved: true,
    aggregate_original_byte_query_runtime_and_output_caps_unchanged: true, complete_statistics: false,
    economic_historical_calendar_quarter_completeness: false, publication: false, pin_transfer: false, licensed_large_area: false, production_speed: false });
  console.info('[native-covered-selected-original-statistics-contribution-population-v2]', { actual_metrics_DONE_parent_and_independent_job: true,
    whole_stock_CAD_transaction_subject_originals_entire_caches_and_every_metric_row_field_reconciled: true,
    native_two_selected_contribution_rows_and_fresh_EMPTY_same_TX_head_checkpoint_release: true,
    ending_CAD_role_workspace_and_orphan_COMMIT_roll_back_head_and_rows: true,
    actual_failure_then_attempt4_fresh_success_preserves_failure_history: true, lost_ACK_fresh_NEXT_and_stale_claim_refusal: true,
    contribution_DONE_all_claim_and_expiry_lanes_excluded: true, all_metric_rows_heads_parents_choices_workspace_and_pins_preserved: true,
    aggregate_original_byte_query_runtime_and_output_caps_unchanged: true, complete_statistics: false,
    economic_historical_calendar_quarter_completeness: false, publication: false, pin_transfer: false, licensed_large_area: false, production_speed: false });
  console.info('[native-covered-selected-original-reported-metric-population-v2]', { actual_evidence_DONE_parent_and_independent_job: true,
    whole_stock_CAD_transaction_subject_originals_and_entire_caches_each_ordinal: true,
    native_two_distinct_selected_metric_rows_and_fresh_EMPTY_same_TX_head_checkpoint_release: true,
    ending_CAD_role_workspace_and_orphan_COMMIT_roll_back_head_and_rows: true,
    actual_failure_then_attempt3_fresh_success_preserves_failure_history: true, lost_ACK_fresh_NEXT_and_stale_claim_refusal: true,
    metric_DONE_all_claim_and_expiry_lanes_excluded: true, originals_parents_evidence_selection_workspace_and_pins_preserved: true,
    aggregate_original_byte_query_runtime_and_output_caps_unchanged: true, complete_statistics: false,
    economic_historical_calendar_quarter_completeness: false, publication: false, pin_transfer: false, licensed_large_area: false, production_speed: false });
  console.info('[native-covered-selected-original-evidence-population-v2]', { independent_actual_original_job_and_all_native_parents: true,
    actual_complete_selected_two_accounts_and_distinct_EMPTY: true, same_selected_subject_CAD_transaction_whole_original_packet: true,
    ending_CAD_role_workspace_and_orphan_COMMIT_refuse_atomically: true, genuine_failure_then_attempt2_success_history_preserved: true,
    real_lost_ACK_fresh_next_ordinal_and_terminal_EMPTY: true, evidence_DONE_all_claim_and_expiry_lanes_excluded: true,
    native_parents_originals_selection_workspace_pins_preserved: true, unchanged_aggregate_original_bytes_queries_deadline_output_caps: true,
    complete_selected_numerics: false, context_complete: false, publication: false, pin_transfer: false,
    licensed_large_area: false, production_speed: false });
}
