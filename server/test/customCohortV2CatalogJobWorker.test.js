import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortV2CatalogWorkerRepository }
  from '../src/services/neighborhoodAssessment/customCohortV2CatalogWorkerRepository.js';
import { runCustomCohortV2CatalogJobOnce }
  from '../src/services/neighborhoodAssessment/customCohortV2CatalogJobWorker.js';

const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const claim = { operation_id: id(1), claim_token: id(2), attempts: 5 };
const scope = { organization_id: id(3), report_file_id: id(4), assignment_file_id: '7', account_id: 'FIXTURE' };
const request = { operation_id: claim.operation_id, observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' },
  discovery: { profile_id: 'custom-suburban-radius-v2', radius_miles: 5 } };
const phase = 'frozen_recorded_partition_refs_v2';
const row = { claim, scope, actor_user_id: id(5), phase, progress_done: true, authority: 'not_established' };
const rawRow = { ...claim, ...scope, actor_user_id: row.actor_user_id, phase, progress_done: true };

function repositoryFixture({ success = [rawRow], recovery = [], auto = false } = {}) {
  const queries = []; let tx = 10;
  const owner = createCustomCohortV2CatalogWorkerRepository({ async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes(':transaction')) return { rowCount: 1, rows: [{ transaction_id: String(auto ? ++tx : tx) }] };
    if (sql.includes(':expire')) return { rowCount: 0, rows: [] };
    const rows = sql.includes(':claim-success') ? success : sql.includes(':claim-recovery') ? recovery : assert.fail(sql);
    return { rowCount: rows.length, rows };
  } });
  return { owner, queries };
}

test('the catalog claim consumes success once without charging another failure attempt', async () => {
  const { owner, queries } = repositoryFixture();
  const [claimed] = await owner.claimDue({ leaseSeconds: 900 });
  assert.deepEqual(claimed, row); assert.ok(Object.isFrozen(claimed.scope));
  assert.ok(!queries.some(q => q.sql.includes(':claim-recovery')));
  const query = queries.find(q => q.sql.includes(':claim-success'));
  assert.deepEqual(query.values[1], ['frozen_stock_traversal_refs_v2', 'frozen_recorded_partition_refs_v2', 'frozen_recorded_catalog_refs_v2']);
  assert.match(query.sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(query.sql, /job\.attempts=c\.issued_attempts/);
  assert.doesNotMatch(query.sql, /attempts=attempts\+1|attempts=0|ST_DWithin|DELETE/);
  assert.match(query.sql, /CASE WHEN blob\.canonical_utf8_bytes BETWEEN 1 AND 16000/);
});
test('ordinary recovery alone spends one of the existing five claims and keeps the old successful token', async () => {
  const { owner, queries } = repositoryFixture({ success: [], recovery: [rawRow] });
  assert.equal((await owner.claimDue())[0].claim.attempts, 5);
  const sql = queries.find(q => q.sql.includes(':claim-recovery')).sql;
  assert.match(sql, /c\.consumed_claim_token IS NOT NULL AND job\.attempts<5/);
  assert.match(sql, /attempts=attempts\+1/);
  assert.doesNotMatch(sql, /UPDATE app\.neighborhood_custom_cohort_v2_continuations|attempts=0|checkpoint=/);
  assert.deepEqual(await repositoryFixture({ success: [], recovery: [] }).owner.claimDue(), []);
});
test('an invalid caller transaction cannot issue a claim', async () => {
  const fixture = repositoryFixture({ auto: true });
  await assert.rejects(fixture.owner.claimDue(), /caller_transaction_required/);
  assert.equal(fixture.queries.length, 2);
});
test('caller phase, counts, callbacks, accessors and unbounded leases are refused before SQL', async () => {
  const { owner, queries } = repositoryFixture();
  for (const value of [{ leaseSeconds: 14 }, { leaseSeconds: 901 }, { leaseSeconds: 120, phase },
    { leaseSeconds: 120, readOriginal() {} }, new Proxy({ leaseSeconds: 120 }, {}),
    { get leaseSeconds() { assert.fail('accessor evaluated'); } }])
    await assert.rejects(owner.claimDue(value), /invalid_/);
  assert.equal(queries.length, 0);
});
test('malformed or unsupported routing metadata cannot become a worker claim', async () => {
  for (const invalid of [{ phase: 'frozen_selected_semantic_refs_v2' }, { progress_done: 'true' },
    { attempts: 6 }, { assignment_file_id: '9223372036854775808' }, { account_id: '\ud800' }, { actor_user_id: 'other' }])
    await assert.rejects(repositoryFixture({ success: [{ ...rawRow, ...invalid }] }).owner.claimDue(), /corrupt|invalid_claim/);
});

const methods = {
  continueOriginalFrozenCaptureJobStockTraversalReferencesV2: 'original_stock_traversal_progress_retained',
  continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2: 'original_recorded_partition_progress_retained',
  continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2: 'original_recorded_catalog_progress_retained',
  awaitOriginalFrozenCaptureJobSelectionReferencesV2: 'awaiting_selection',
};
function workerFixture({ due = [row], cancelled = false, actorError = null, originalError = null,
  invalidResult = null, failureError = null, heartbeatAction = null, originalAction = null } = {}) {
  const events = [], pool = { async connect() {
    return { async query(config) { events.push(config.text); return { rowCount: 0, rows: [] }; }, release() {} };
  } };
  const claimRepositoryFactory = () => ({ async claimDue() { events.push('claim'); return due; } });
  const repositoryFactory = () => ({
    async readRequest(value, options) { events.push(['request', value, options]); return request; },
    async heartbeat(value) {
      events.push(['heartbeat', value]);
      return heartbeatAction ? heartbeatAction() : { cancellation_requested: cancelled };
    },
    async failClaim(value, reason) {
      events.push(['fail', value, reason]); if (failureError) throw failureError;
      return { status: cancelled ? 'cancelled' : 'retry' };
    },
  });
  const loadActor = async (_client, userId, organizationId) => {
    events.push(['actor', userId, organizationId]); if (actorError) throw actorError;
    return { userId, organizations: [{ organizationId, roles: ['appraiser'] }] };
  };
  const cohortService = Object.fromEntries(Object.entries(methods).map(([method, status]) => [method, async (input, options) => {
    events.push(['original', method, input, options]);
    if (originalAction) return originalAction(input, options);
    if (originalError) throw originalError;
    return invalidResult ?? { status, operation_id: claim.operation_id, report_update: 'none',
      ...(status === 'awaiting_selection' ? { context_complete: false, pin_transfer: false, genuine_selection_intent: false }
        : { continuation: { status: 'continuation_pending', attempts: claim.attempts, fresh_claim_required: true,
          context_complete: false, pin_transfer: false } }) };
  }]));
  return { events, pool, claimRepositoryFactory, repositoryFactory, loadActor, cohortService };
}
test('an idle catalog worker does not inspect any actor or original source', async () => {
  const deps = workerFixture({ due: [] });
  assert.deepEqual(await runCustomCohortV2CatalogJobOnce(deps), { status: 'idle' });
  assert.equal(deps.events.some(e => Array.isArray(e)), false);
});
test('all six routes call only a fixed actual owner and stop at human selection', async () => {
  const cases = [
    ['frozen_stock_traversal_refs_v2', false, 'continueOriginalFrozenCaptureJobStockTraversalReferencesV2'],
    ['frozen_stock_traversal_refs_v2', true, 'continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2'],
    ['frozen_recorded_partition_refs_v2', false, 'continueOriginalFrozenCaptureJobRecordedPartitionReferencesV2'],
    ['frozen_recorded_partition_refs_v2', true, 'continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2'],
    ['frozen_recorded_catalog_refs_v2', false, 'continueOriginalFrozenCaptureJobRecordedCatalogReferencesV2'],
    ['frozen_recorded_catalog_refs_v2', true, 'awaitOriginalFrozenCaptureJobSelectionReferencesV2'],
  ];
  for (const [phase, progress_done, method] of cases) {
    const deps = workerFixture({ due: [{ ...row, phase, progress_done }] });
    const result = await runCustomCohortV2CatalogJobOnce(deps);
    assert.equal(result.status, progress_done && phase === 'frozen_recorded_catalog_refs_v2' ? 'awaiting_selection' : 'continuation_pending');
    assert.deepEqual(Object.keys(result).sort(), ['status', 'operation_id', 'context_complete', 'pin_transfer', 'report_update'].sort());
    const call = deps.events.find(e => e[0] === 'original'); assert.equal(call[1], method);
    assert.equal(call[2].auth.userId, row.actor_user_id); assert.equal(call[2].assignmentFileId, '7');
    assert.deepEqual(call[3].captureJobClaim, claim);
    assert.deepEqual(Object.keys(call[3]).sort(), ['captureJobClaim', 'signal']);
    assert.equal(deps.events.some(e => e[0] === 'fail'), false);
  }
});
test('revocation or cancellation stops before the original owner and settles the exact native claim', async () => {
  for (const options of [{ cancelled: true }, { actorError: new Error('custom_cohort_job_actor_access_revoked') }]) {
    const deps = workerFixture(options), result = await runCustomCohortV2CatalogJobOnce(deps);
    assert.equal(result.reason, options.cancelled ? 'cancelled' : 'access_revoked');
    assert.equal(deps.events.some(e => e[0] === 'original'), false);
    assert.deepEqual(deps.events.find(e => e[0] === 'fail')[1], claim);
  }
});
test('lost owner COMMIT acknowledgment cannot downgrade committed progress or waiting', async () => {
  const deps = workerFixture({ originalError: Object.assign(new Error('lost ACK'), { outcome_unknown: true }),
    failureError: new Error('custom_cohort_capture_job_claim_lost') });
  assert.deepEqual(await runCustomCohortV2CatalogJobOnce(deps), { status: 'outcome_unknown', operation_id: claim.operation_id });
});
test('a fabricated completion, human command or wrong-operation result is not accepted', async () => {
  for (const invalidResult of [{ status: 'succeeded', operation_id: claim.operation_id },
    { status: 'awaiting_selection', operation_id: id(6), context_complete: false, pin_transfer: false, report_update: 'none' },
    { status: 'awaiting_selection', operation_id: claim.operation_id, context_complete: false, pin_transfer: false,
      report_update: 'none', genuine_selection_intent: true }]) {
    const deps = workerFixture({ due: [{ ...row, phase: 'frozen_recorded_catalog_refs_v2' }], invalidResult });
    assert.equal((await runCustomCohortV2CatalogJobOnce(deps)).reason, 'capture_failed');
  }
});
test('lease loss during an original step aborts it and preserves a successor claim', { timeout: 5000 }, async () => {
  let calls = 0;
  const deps = workerFixture({ heartbeatAction: async () => {
    if (++calls > 1) throw new Error('custom_cohort_capture_job_claim_lost');
    return { cancellation_requested: false };
  }, originalAction: async (_input, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })), { once: true });
  }), failureError: new Error('custom_cohort_capture_job_claim_lost') });
  assert.equal((await runCustomCohortV2CatalogJobOnce({ ...deps, leaseSeconds: 15, heartbeatSeconds: 1 })).status, 'outcome_unknown');
  assert.equal(deps.events.filter(e => e[0] === 'original').length, 1);
});
