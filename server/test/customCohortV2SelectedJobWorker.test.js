import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortV2SelectedWorkerRepository }
  from '../src/services/neighborhoodAssessment/customCohortV2SelectedWorkerRepository.js';
import { runCustomCohortV2SelectedJobOnce }
  from '../src/services/neighborhoodAssessment/customCohortV2SelectedJobWorker.js';

const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const claim = { operation_id: id(1), claim_token: id(2), attempts: 5 };
const scope = { organization_id: id(3), report_file_id: id(4), assignment_file_id: '7', account_id: 'FIXTURE' };
const request = { operation_id: claim.operation_id, observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' },
  discovery: { profile_id: 'custom-suburban-radius-v2', radius_miles: 5 } };
const phases = ['union', 'eligibility', 'evidence', 'metrics', 'statistics', 'numeric', 'semantic']
  .map(stage => `frozen_selected_${stage}_refs_v2`);
const row = { claim, scope, actor_user_id: id(5), phase: phases[0], progress_done: false, authority: 'not_established' };
const rawRow = { ...claim, ...scope, actor_user_id: row.actor_user_id, phase: row.phase, progress_done: false };
const methods = [
  ['continueOriginalFrozenCaptureJobSelectedStockUnionReferencesV2', 'original_selected_stock_union_replay_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2', 'original_selected_recorded_eligibility_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedEvidenceReferencesV2', 'original_selected_evidence_traversal_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedMetricReferencesV2', 'original_selected_reported_metric_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedStatisticsReferencesV2', 'original_selected_statistics_contribution_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedNumericReferencesV2', 'original_selected_numeric_progress_retained'],
  ['progressOriginalFrozenCaptureJobSelectedSemanticReferencesV2', 'original_selected_semantic_progress_retained'],
];

function repositoryFixture({ success = [rawRow], recovery = [], auto = false } = {}) {
  const queries = []; let tx = 10;
  const owner = createCustomCohortV2SelectedWorkerRepository({ async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes(':transaction')) return { rowCount: 1, rows: [{ transaction_id: String(auto ? ++tx : tx) }] };
    if (sql.includes(':expire')) return { rowCount: 0, rows: [] };
    const rows = sql.includes(':claim-success') ? success : sql.includes(':claim-recovery') ? recovery : assert.fail(sql);
    return { rowCount: rows.length, rows };
  } });
  return { owner, queries };
}
test('success claims only selected issued continuations and keeps even the fifth failure attempt', async () => {
  const { owner, queries } = repositoryFixture();
  assert.deepEqual((await owner.claimDue({ leaseSeconds: 900 }))[0], row);
  const query = queries.find(q => q.sql.includes(':claim-success'));
  assert.deepEqual(query.values[1], phases);
  assert.match(query.sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(query.sql, /job\.attempts=c\.issued_attempts/);
  assert.match(query.sql, /JOIN app\.neighborhood_custom_cohort_v2_selection_intents intent/);
  assert.match(query.sql, /routing\.receipt->>'command_id'=intent\.command_id::text/);
  assert.match(query.sql, /blob\.canonical_utf8_bytes BETWEEN 1 AND 16000/);
  assert.doesNotMatch(query.sql, /attempts=attempts\+1|attempts=0|ST_DWithin|DELETE/);
});
test('only ordinary recovery spends a failure attempt; completed semantic tokens stay untouched in both paths', async () => {
  const { owner, queries } = repositoryFixture({ success: [], recovery: [rawRow] });
  assert.equal((await owner.claimDue())[0].claim.attempts, 5);
  const sql = queries.find(q => q.sql.includes(':claim-recovery')).sql;
  assert.match(sql, /c\.consumed_claim_token IS NOT NULL AND job\.attempts<5/);
  assert.match(sql, /attempts=attempts\+1/);
  assert.doesNotMatch(sql, /UPDATE app\.neighborhood_custom_cohort_v2_continuations|attempts=0|checkpoint=/);
  for (const query of queries.filter(q => /:claim-/.test(q.sql))) {
    assert.match(query.sql, /c\.phase<>'frozen_selected_semantic_refs_v2' OR routing\.receipt->'after'->>'done'='false'/);
    assert.doesNotMatch(query.sql, /frozen_selected_transaction_index_refs_v2|frozen_recorded_catalog_refs_v2/);
  }
  assert.deepEqual(await repositoryFixture({ success: [], recovery: [] }).owner.claimDue(), []);
});
test('each installed receipt format matches its actual original-owner builder', () => {
  const capture = readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortContextCapture.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/services/neighborhoodAssessment/customCohortV2SelectedWorkerRepository.js', import.meta.url), 'utf8');
  const formats = [...source.matchAll(/THEN '(cohort_selected_[a-z_]+receipt_v2)'|ELSE '(cohort_selected_[a-z_]+receipt_v2)'/g)]
    .map(match => match[1] ?? match[2]);
  assert.equal(formats.length, 7);
  for (const format of formats) assert.ok(capture.includes(`format:'${format}'`), format);
});
test('caller phases, sources, accessors, proxies and unsafe leases refuse before SQL', async () => {
  const { owner, queries } = repositoryFixture();
  for (const options of [{ leaseSeconds: 14 }, { leaseSeconds: 901 }, { leaseSeconds: 120, phase: phases[0] },
    { leaseSeconds: 120, source() {} }, new Proxy({ leaseSeconds: 120 }, {}),
    { get leaseSeconds() { assert.fail('accessor evaluated'); } }]) await assert.rejects(owner.claimDue(options), /invalid_/);
  assert.equal(queries.length, 0);
  const auto = repositoryFixture({ auto: true });
  await assert.rejects(auto.owner.claimDue(), /caller_transaction_required/); assert.equal(auto.queries.length, 2);
});
test('malformed, initial, finished or unregistered claims are refused', async () => {
  for (const invalid of [{ phase: 'frozen_recorded_catalog_refs_v2' }, { phase: 'frozen_selected_transaction_index_refs_v2' },
    { phase: phases[6], progress_done: true }, { progress_done: 'false' }, { attempts: 6 },
    { assignment_file_id: '9223372036854775808' }, { account_id: '\ud800' }, { actor_user_id: 'other' }])
    await assert.rejects(repositoryFixture({ success: [{ ...rawRow, ...invalid }] }).owner.claimDue(), /corrupt|invalid_claim/);
});

function workerFixture({ due = [row], cancelled = false, actorError = null, originalError = null,
  invalidResult = null, failureError = null, heartbeatAction = null, originalAction = null, claimCommitError = false } = {}) {
  const events = [], pool = { async connect() {
    return { async query(config) { events.push(config.text);
      if (claimCommitError && config.text === 'COMMIT') throw new Error('lost claim COMMIT');
      return { rowCount: 0, rows: [] }; }, release() {} };
  } };
  const claimRepositoryFactory = () => ({ async claimDue() { events.push('claim'); return due; } });
  const repositoryFactory = () => ({
    async readRequest(value, options) { events.push(['request', value, options]); return request; },
    async heartbeat(value) { events.push(['heartbeat', value]);
      return heartbeatAction ? heartbeatAction() : { cancellation_requested: cancelled }; },
    async failClaim(value, reason) { events.push(['fail', value, reason]); if (failureError) throw failureError;
      return { status: cancelled ? 'cancelled' : 'retry' }; },
  });
  const loadActor = async (_client, userId, organizationId) => {
    events.push(['actor', userId, organizationId]); if (actorError) throw actorError;
    return { userId, organizations: [{ organizationId, roles: ['appraiser'] }] };
  };
  const cohortService = Object.fromEntries(methods.map(([method, status], index) => [method, async (input, options) => {
    events.push(['original', method, input, options]);
    if (originalAction) return originalAction(input, options);
    if (originalError) throw originalError;
    return invalidResult ?? { status, operation_id: claim.operation_id, report_update: 'none', context_complete: false, pin_transfer: false,
      continuation: { status: 'continuation_pending', phase: phases[index], attempts: claim.attempts,
        fresh_claim_required: true, context_complete: false, pin_transfer: false } };
  }]));
  return { events, pool, claimRepositoryFactory, repositoryFactory, loadActor, cohortService };
}
test('idle and unknown claim COMMIT never inspect actors or original data', async () => {
  for (const options of [{ due: [] }, { claimCommitError: true }]) {
    const deps = workerFixture(options);
    assert.equal((await runCustomCohortV2SelectedJobOnce(deps)).status, options.claimCommitError ? 'outcome_unknown' : 'idle');
    assert.equal(deps.events.some(e => Array.isArray(e)), false);
  }
});
test('all thirteen routes invoke fixed actual original owners with saved identity and no caller source material', async () => {
  for (let index = 0; index < phases.length; index++) for (const progress_done of [false, true]) {
    if (index === 6 && progress_done) continue;
    const deps = workerFixture({ due: [{ ...row, phase: phases[index], progress_done }] });
    const result = await runCustomCohortV2SelectedJobOnce(deps), target = index + Number(progress_done);
    assert.deepEqual(result, { status: 'continuation_pending', operation_id: claim.operation_id,
      context_complete: false, pin_transfer: false, report_update: 'none' });
    const call = deps.events.find(e => e[0] === 'original'); assert.equal(call[1], methods[target][0]);
    assert.equal(call[2].auth.userId, row.actor_user_id); assert.equal(call[2].assignmentFileId, '7');
    assert.deepEqual(call[2].observationPeriod, request.observation_period); assert.deepEqual(call[2].discovery, request.discovery);
    assert.deepEqual(call[3].captureJobClaim, claim); assert.deepEqual(Object.keys(call[3]).sort(), ['captureJobClaim', 'signal']);
    assert.equal(deps.events.some(e => e[0] === 'fail'), false);
  }
});
test('semantic DONE cannot dispatch an unregistered stage even with forged claim-repository metadata', async () => {
  const deps = workerFixture({ due: [{ ...row, phase: phases[6], progress_done: true }] });
  assert.equal((await runCustomCohortV2SelectedJobOnce(deps)).reason, 'capture_failed');
  assert.equal(deps.events.some(e => e[0] === 'original'), false);
});
test('current revocation and cancellation stop before original data and settle the exact native claim', async () => {
  for (const options of [{ cancelled: true }, { actorError: new Error('custom_cohort_job_actor_access_revoked') }]) {
    const deps = workerFixture(options), result = await runCustomCohortV2SelectedJobOnce(deps);
    assert.equal(result.reason, options.cancelled ? 'cancelled' : 'access_revoked');
    assert.equal(deps.events.some(e => e[0] === 'original'), false);
    assert.deepEqual(deps.events.find(e => e[0] === 'fail')[1], claim);
  }
});
test('lost owner COMMIT cannot downgrade committed progress or replace a successor claim', async () => {
  const deps = workerFixture({ originalError: Object.assign(new Error('lost ACK'), { outcome_unknown: true }),
    failureError: new Error('custom_cohort_capture_job_claim_lost') });
  assert.deepEqual(await runCustomCohortV2SelectedJobOnce(deps), { status: 'outcome_unknown', operation_id: claim.operation_id });
});
test('wrong phase, attempts, completion, pins or report publication are not accepted as progress', async () => {
  const valid = { status: methods[0][1], operation_id: claim.operation_id, report_update: 'none', context_complete: false, pin_transfer: false,
    continuation: { status: 'continuation_pending', phase: phases[0], attempts: 5, fresh_claim_required: true, context_complete: false, pin_transfer: false } };
  for (const invalid of [{ context_complete: true }, { pin_transfer: true }, { report_update: 'published' }, { operation_id: id(6) },
    { continuation: { ...valid.continuation, phase: phases[1] } }, { continuation: { ...valid.continuation, attempts: 1 } }]) {
    const deps = workerFixture({ invalidResult: { ...valid, ...invalid } });
    assert.equal((await runCustomCohortV2SelectedJobOnce(deps)).reason, 'capture_failed');
  }
});
test('in-flight lease loss aborts original work and preserves native successor ownership', { timeout: 5000 }, async () => {
  let calls = 0;
  const deps = workerFixture({ heartbeatAction: async () => {
    if (++calls > 1) throw new Error('custom_cohort_capture_job_claim_lost');
    return { cancellation_requested: false };
  }, originalAction: async (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })), { once: true });
  }), failureError: new Error('custom_cohort_capture_job_claim_lost') });
  assert.equal((await runCustomCohortV2SelectedJobOnce({ ...deps, leaseSeconds: 15, heartbeatSeconds: 1 })).status, 'outcome_unknown');
  assert.equal(deps.events.filter(e => e[0] === 'original').length, 1);
});
