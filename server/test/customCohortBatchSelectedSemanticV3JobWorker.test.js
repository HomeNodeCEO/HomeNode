import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortBatchSelectedSemanticV3WorkerRepository as repository }
  from '../src/services/neighborhoodAssessment/customCohortBatchSelectedSemanticV3WorkerRepository.js';
import { runCustomCohortBatchSelectedSemanticV3JobOnce as run }
  from '../src/services/neighborhoodAssessment/customCohortBatchSelectedSemanticV3JobWorker.js';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const claim = { operation_id: id('1'), claim_token: id('2'), attempts: 5 },
  scope = { organization_id: id('3'), report_file_id: id('4'), assignment_file_id: '7', account_id: 'FIXTURE' },
  method = 'progressCoveredOriginalFrozenCaptureJobBatchSelectedSemanticReferencesV3',
  row = { claim, scope, actor_user_id: id('5'), phase: 'frozen_selected_numeric_refs_v2', progress_done: true },
  request = { operation_id: claim.operation_id, execution_mode: 'frozen-originals-v2',
    discovery: { profile_id: 'custom-suburban-radius-v2' }, observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' } };
function fixture({ due = row, job = request, actorError, cancel = false, ownerError, failureError, badResult } = {}) {
  const calls = [], failures = [];
  const args = { pool: { async connect() { return { async query() { return { rowCount: 0, rows: [] }; }, release() {} }; } },
    claimRepositoryFactory: () => ({ async claimDue() { return due ? [due] : []; } }),
    repositoryFactory: () => ({ async readRequest() { return job; }, async heartbeat() { return { cancellation_requested: cancel }; },
      async failClaim(actual, reason) { assert.deepEqual(actual, claim); failures.push(reason); if (failureError) throw failureError; return { status: 'retry' }; } }),
    async loadActor(client, actor, organization) { assert.equal(actor, row.actor_user_id); assert.equal(organization, scope.organization_id);
      if (actorError) throw actorError; return { userId: actor }; },
    cohortService: { async [method](input, options) { calls.push({ input, options }); if (ownerError) throw ownerError;
      return { catalog_receipt_format:'cohort_recorded_catalog_batch_receipt_v3', status: 'original_selected_semantic_progress_retained', operation_id: claim.operation_id,
        covered_neutral_originals: true, covered_CAD_originals: true, read_only: false, context_complete: false, pin_transfer: false,
        report_update: 'none', continuation: { status: 'continuation_pending', phase: 'frozen_selected_semantic_refs_v2',
          attempts: 5, fresh_claim_required: true, context_complete: false, pin_transfer: false }, ...badResult };
    } } };
  return { args, calls, failures };
}

test('native numeric DONE and incomplete semantic progress invoke only the actual original owner with the exact fifth claim', async () => {
  for (const due of [row, { ...row, phase: 'frozen_selected_semantic_refs_v2', progress_done: false }]) {
    const f = fixture({ due }); assert.equal((await run(f.args)).status, 'continuation_pending');
    assert.equal(f.calls[0].input.auth.userId, row.actor_user_id); assert.deepEqual(f.calls[0].options.captureJobClaim, claim);
    assert.deepEqual(Object.keys(f.calls[0].options), ['captureJobClaim', 'signal']); assert.deepEqual(f.failures, []);
  }
});
test('incomplete numeric, semantic DONE and other phases refuse before the original owner', async () => {
  for (const due of [{ ...row, progress_done: false }, { ...row, phase: 'frozen_selected_semantic_refs_v2' },
    { ...row, phase: 'frozen_identity_refs_v2' }]) {
    const f = fixture({ due }); assert.equal((await run(f.args)).reason, 'capture_failed'); assert.equal(f.calls.length, 0);
  }
  const idle = fixture({ due: null }); assert.deepEqual(await run(idle.args), { status: 'idle' });
});
test('current actor refusal, cancellation, legacy and private input cannot reach the original owner', async () => {
  for (const [options, reason] of [[{ actorError: Error('custom_cohort_job_actor_access_revoked') }, 'access_revoked'],
    [{ cancel: true }, 'cancelled'], [{ job: { ...request, execution_mode: undefined } }, 'capture_failed'],
    [{ job: { ...request, private_sales_import: {} } }, 'capture_failed']]) {
    const f = fixture(options); assert.equal((await run(f.args)).reason, reason); assert.equal(f.calls.length, 0);
  }
});
test('either coverage, mutable progress, completed context/publication or a different continuation refuses', async () => {
  for (const badResult of [{catalog_receipt_format:'cohort_recorded_catalog_receipt_v2'}, { covered_CAD_originals: false }, { covered_neutral_originals: false }, { read_only: true },
    { context_complete: true }, { pin_transfer: true }, { report_update: 'saved' },
    { continuation: { status: 'continuation_pending', phase: 'frozen_identity_refs_v2', attempts: 5 } }]) {
    assert.equal((await run(fixture({ badResult }).args)).reason, 'capture_failed');
  }
});
test('unknown real owner COMMIT cannot overwrite committed native progress', async () => {
  const f = fixture({ ownerError: Object.assign(Error('lost COMMIT'), { outcome_unknown: true }),
    failureError: Error('custom_cohort_capture_job_claim_lost') });
  assert.deepEqual(await run(f.args), { status: 'outcome_unknown', operation_id: claim.operation_id });
});
test('every claim/expiry SQL lane has both native coverage parents, immutable command and the SAME semantic-DONE exclusion', async () => {
  const calls = [], owner = repository({ async query(sql, values) { calls.push({ sql, values });
    return sql.includes(':transaction') ? { rowCount: 1, rows: [{ transaction_id: '10' }] } : { rowCount: 0, rows: [] }; } });
  assert.deepEqual(await owner.claimDue({ leaseSeconds: 120 }), []);
  for (const tag of [':expire', ':claim-success', ':claim-recovery']) {
    const sql = calls.find(c => c.sql.includes(tag)).sql;
    for (const guard of ["completed_catalog.receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3'",
      "completed_stock.receipt->>'format'='cohort_stock_traversal_batch_receipt_v3'",
      "completed_partition.receipt->>'format'='cohort_recorded_group_partition_batch_receipt_v3'",
      "workspace.section_value->'pending_capture'->>'operation_id'=job.operation_id::text",
      "workspace.section_value->'pending_capture'->'observation_period'=job.request_payload->'observation_period'",
      "workspace.section_value->'pending_capture'->'discovery'=job.request_payload->'discovery'",
      'octet_length(workspace.section_value::text)<=524288',"workspace.section_value->>'workspace_version'='7'",
      "workspace.section_value->'pending_capture'->'private_sales_import'",
      "workspace.section_value->'active'->'context_ref'->>'context_id' IS DISTINCT FROM job.operation_id::text",'neighborhood_custom_cohort_cad_success_v2_jobs', 'cad.receipt_reference=first.cad_reference',
      'cad.neutral_reference=cache.receipt_reference', "completed_cad.receipt->'after'->'done'='true'::jsonb",
      "c.phase='frozen_selected_numeric_refs_v2' AND routing.receipt->'after'->>'done'='true'",
      "c.phase='frozen_selected_semantic_refs_v2' AND routing.receipt->'after'->>'done'='false'",
      'app.neighborhood_selected_numeric_v2_checkpoint_matches', 'app.neighborhood_selected_semantic_v2_checkpoint_matches',
      'job.request_sha256=intent.request_sha256', 'first.actor_user_id=job.actor_user_id', 'FOR UPDATE OF job SKIP LOCKED'])
      assert.ok(sql.includes(guard), `${tag} ${guard}`);
  }
  const success = calls.find(c => c.sql.includes(':claim-success')); assert.deepEqual(success.values[1], ['frozen_selected_numeric_refs_v2', 'frozen_selected_semantic_refs_v2']);
  assert.doesNotMatch(success.sql, /attempts=attempts\+1|attempts=0|DELETE|ST_DWithin/);
  const recovery = calls.find(c => c.sql.includes(':claim-recovery')).sql;
  assert.match(recovery, /job.attempts<5/); assert.match(recovery, /attempts=attempts\+1/);
});
test('caller phase, cursor, token, completion, ordinal or callbacks cannot change native routing', async () => {
  const owner = repository({ async query() { assert.fail('no SQL for invalid options'); } });
  for (const key of ['phase', 'cursor', 'claim', 'done', 'ordinal', 'readOriginal'])
    await assert.rejects(owner.claimDue({ leaseSeconds: 120, [key]: true }), /invalid_input/);
});
