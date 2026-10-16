import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortCoveredSelectedInitialV2WorkerRepository as repository }
  from '../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2WorkerRepository.js';
import { runCustomCohortCoveredSelectedInitialV2JobOnce as run }
  from '../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2JobWorker.js';

const id = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const claim = { operation_id: id(1), claim_token: id(2), attempts: 2 };
const scope = { organization_id: id(3), report_file_id: id(4), assignment_file_id: '7', account_id: 'FIXTURE' };
const row = { claim, scope, actor_user_id: id(5), authority: 'not_established' };
const rawRow = { ...claim, ...scope, actor_user_id: id(5) };
const request = { operation_id: claim.operation_id, execution_mode: 'frozen-originals-v2', observation_period: { start_date: '2024-01-01', end_date: '2024-12-31' },
  discovery: { profile_id: 'custom-suburban-radius-v2', radius_miles: 5 } };
const method = 'continueCoveredOriginalFrozenCaptureJobSelectedStockUnionReferencesV2';
function ledger({ adopted = [rawRow], recovered = [], auto = false } = {}) {
  const calls = []; let tx = 10;
  return { calls, owner: repository({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes(':transaction')) return { rowCount: 1, rows: [{ transaction_id: String(auto ? ++tx : tx) }] };
    if (sql.includes(':expire')) return { rowCount: 0, rows: [] };
    if (sql.includes(':adopt-recovery')) return { rowCount: 1, rows: [{ operation_id: claim.operation_id }] };
    const rows = sql.includes(':adopt') ? adopted : sql.includes(':recover') ? recovered : assert.fail(sql);
    return { rowCount: rows.length, rows };
  } }) };
}
test('one initial adopter preserves the real human lease and its failure history', async () => {
  const fixture = ledger(); assert.deepEqual(await fixture.owner.claimDue(), [row]);
  const sql = fixture.calls.find(c => c.sql.includes(':adopt')).sql;
  assert.match(sql, /FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql, /ON CONFLICT\(operation_id,claim_token\) DO NOTHING/);
  assert.match(sql, /job\.checkpoint=intent\.checkpoint/);
  assert.doesNotMatch(sql, /SET status=|attempts=attempts|lease_expires_at=|included_group_ids|ST_DWithin/);
  assert.equal(fixture.calls.some(c => c.sql.includes(':recover')), false);
});
test('ordinary initial-claim recovery is capped and adopts only its fresh native token', async () => {
  const fixture = ledger({ adopted: [], recovered: [{ ...rawRow, attempts: 3, claim_token: id(6) }] });
  const [recovered] = await fixture.owner.claimDue({ leaseSeconds: 900 });
  assert.equal(recovered.claim.attempts, 3); assert.notEqual(recovered.claim.claim_token, claim.claim_token);
  const sql = fixture.calls.find(c => c.sql.includes(':recover')).sql;
  assert.match(sql, /job\.attempts<5/); assert.match(sql, /attempts=attempts\+1/);
  assert.match(sql, /claim_token=gen_random_uuid\(\)/);
  const adoption = fixture.calls.find(c => c.sql.includes(':adopt-recovery'));
  assert.match(adoption.sql, /INSERT INTO app\.neighborhood_custom_cohort_selected_initial_dispatch_v2/);
  assert.deepEqual(adoption.values, [claim.operation_id, id(6), 3]);
  assert.doesNotMatch(sql, /attempts=0|SET checkpoint|included_group_ids|neighborhood_custom_cohort_v2_continuations/);
  assert.deepEqual(await ledger({ adopted: [], recovered: [] }).owner.claimDue(), []);
});
test('caller commands, tokens, source adapters, hostile options and broken transactions are refused', async () => {
  const fixture = ledger();
  for (const value of [{ leaseSeconds: 14 }, { leaseSeconds: 901 }, { leaseSeconds: 120, claim },
    { leaseSeconds: 120, included_group_ids: [] }, { leaseSeconds: 120, readOriginal() {} },
    new Proxy({ leaseSeconds: 120 }, {}), { get leaseSeconds() { assert.fail('getter'); } }])
    await assert.rejects(fixture.owner.claimDue(value), /invalid_options/);
  assert.equal(fixture.calls.length, 0);
  const broken = ledger({ auto: true }); await assert.rejects(broken.owner.claimDue(), /caller_transaction_required/);
  assert.equal(broken.calls.length, 2);
});
test('malformed native claims cannot become source authority', async () => {
  for (const changed of [{ attempts: 6 }, { account_id: '\ud800' }, { assignment_file_id: '0' },
    { actor_user_id: 'foreign' }, { claim_token: 'invented' }])
    await assert.rejects(ledger({ adopted: [{ ...rawRow, ...changed }] }).owner.claimDue(), /corrupt|invalid_/);
});
test('dormant native adoption is immutable, current-claim bound and deferred at actual COMMIT', () => {
  const name = '20261207_custom_cohort_selected_initial_worker_v2.sql';
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  const registry = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.equal(registry.includes(name), false);
  for (const required of ['UNIQUE(operation_id,attempts)', 'job.checkpoint=intent.checkpoint',
    "job.status='running'", 'job.lease_expires_at>clock_timestamp()', 'job.cancellation_requested_at IS NULL',
    'token=intent.resume_claim_token', 'DEFERRABLE INITIALLY DEFERRED', 'issued_transaction_id<>txid_current()',
    'neighborhood_selected_initial_dispatch_v2_orphan_claim', 'BEFORE INSERT OR UPDATE OR DELETE', 'BEFORE TRUNCATE'])
    assert.ok(sql.includes(required), required);
  assert.doesNotMatch(sql, /DISABLE TRIGGER|DROP |UPDATE app\.|DELETE FROM|ST_DWithin/);
});

function worker({ due = [row], cancelled = false, actorError = null, sourceError = null,
  failureError = null, resultOverride = null, claimError = null, slow = false } = {}) {
  const events = [];
  const pool = { async connect() { return { async query(config) { events.push(config.text); }, release() {} }; } };
  const claimRepositoryFactory = () => ({ async claimDue() { if (claimError) throw claimError; return due; } });
  let heartbeats = 0;
  const repositoryFactory = () => ({
    async readRequest(value, options) { events.push(['request', value, options]); return request; },
    async heartbeat() { return { cancellation_requested: cancelled || slow && ++heartbeats > 1 }; },
    async failClaim(value, reason) { events.push(['fail', value, reason]); if (failureError) throw failureError;
      return { status: cancelled ? 'cancelled' : 'retry' }; },
  });
  const loadActor = async (_client, userId, organizationId) => {
    events.push(['actor', userId, organizationId]); if (actorError) throw actorError;
    return { userId, organizations: [{ organizationId, roles: ['appraiser'] }] };
  };
  const cohortService = { async [method](input, options) {
    events.push(['source', input, options]);
    if (slow) return new Promise((resolve, reject) => options.signal.addEventListener('abort',
      () => reject(Object.assign(new Error('cancelled'), { reason: 'cancelled' })), { once: true }));
    if (sourceError) throw sourceError;
    return resultOverride ?? { covered_neutral_originals: true, status: 'original_selected_stock_union_replay_progress_retained', operation_id: claim.operation_id,
      context_complete: false, pin_transfer: false, report_update: 'none', continuation: {
        status: 'continuation_pending', phase: 'frozen_selected_union_refs_v2', attempts: claim.attempts,
        fresh_claim_required: true, context_complete: false, pin_transfer: false } };
  } };
  return { events, pool, claimRepositoryFactory, repositoryFactory, loadActor, cohortService };
}
test('an idle initial worker does not inspect actor or source data', async () => {
  const fixture = worker({ due: [] }); assert.deepEqual(await run(fixture), { status: 'idle' });
  assert.equal(fixture.events.some(e => Array.isArray(e)), false);
});
test('actual source owner receives only the saved request and native claim, never human choices from the worker', async () => {
  const fixture = worker();
  assert.deepEqual(await run(fixture), { status: 'continuation_pending', operation_id: claim.operation_id,
    context_complete: false, pin_transfer: false, report_update: 'none' });
  const call = fixture.events.find(e => e[0] === 'source');
  assert.deepEqual(call[1], { auth: { userId: id(5), organizations: [{ organizationId: scope.organization_id, roles: ['appraiser'] }] },
    accountId: scope.account_id, assignmentFileId: '7', operationId: claim.operation_id,
    observationPeriod: request.observation_period, discovery: request.discovery });
  assert.deepEqual(Object.keys(call[2]).sort(), ['captureJobClaim', 'signal']);
  assert.deepEqual(call[2].captureJobClaim, claim); assert.equal(fixture.events.some(e => e[0] === 'fail'), false);
});
test('current actor revocation and cancellation refuse before the original owner', async () => {
  for (const options of [{ actorError: new Error('custom_cohort_job_actor_access_revoked') }, { cancelled: true }]) {
    const fixture = worker(options), result = await run(fixture);
    assert.equal(result.reason, options.cancelled ? 'cancelled' : 'access_revoked');
    assert.equal(fixture.events.some(e => e[0] === 'source'), false);
  }
});
test('lost claim and owner COMMIT acknowledgments remain unknown without overwriting a successor', async () => {
  assert.deepEqual(await run(worker({ claimError: Object.assign(new Error('lost claim ACK'), { outcome_unknown: true }) })),
    { status: 'outcome_unknown' });
  assert.deepEqual(await run(worker({ sourceError: Object.assign(new Error('lost owner ACK'), { outcome_unknown: true }),
    failureError: new Error('custom_cohort_capture_job_claim_lost') })), { status: 'outcome_unknown', operation_id: claim.operation_id });
});
test('a fabricated completion or waiting result cannot replace selected-union progress', async () => {
  for (const resultOverride of [{ status: 'succeeded' }, { status: 'awaiting_selection' },
    { status: 'original_selected_stock_union_replay_progress_retained', operation_id: id(6) }])
    assert.equal((await run(worker({ resultOverride }))).reason, 'capture_failed');
});
test('in-flight cancellation aborts a bounded original step', { timeout: 5000 }, async () => {
  const fixture = worker({ slow: true });
  assert.equal((await run({ ...fixture, leaseSeconds: 15, heartbeatSeconds: 1 })).reason, 'cancelled');
  assert.equal(fixture.events.find(e => e[0] === 'source')[2].signal.aborted, true);
});

test('all initial claim and expiry lanes require the same completed native covered lineage', async()=>{
  const f=ledger({adopted:[],recovered:[rawRow]});await f.owner.claimDue();
  for(const tag of [':expire',':adopt',':recover',':adopt-recovery']){
    const sql=f.calls.find(c=>c.sql.includes(tag)).sql;
    for(const guard of ['neighborhood_custom_cohort_cache_stock_v2_bridges','neighborhood_custom_cohort_neutral_success_v2_jobs',
      'neighborhood_custom_cohort_neutral_cache_v2_heads','neighborhood_custom_cohort_stock_traversal_v2_anchors',
      'neighborhood_custom_cohort_recorded_partition_v2_heads','neighborhood_custom_cohort_recorded_catalog_v2_heads',
      'first.report_file_id=job.report_file_id','first.assignment_file_id=job.assignment_file_id','first.actor_user_id=job.actor_user_id',
      'first.request_sha256=job.request_sha256',"job.request_payload->>'execution_mode'='frozen-originals-v2'",
      "completed_catalog.receipt->'after'->'done'='true'::jsonb",'job.checkpoint=intent.checkpoint'])assert.ok(sql.includes(guard),tag+' '+guard);
  }
});
test('a legacy request and an uncovered owner result cannot be adopted as covered progress',async()=>{
  const bad=worker();bad.repositoryFactory=()=>({async readRequest(){return {...request,execution_mode:undefined};},
    async failClaim(){return {status:'retry'};}});
  assert.equal((await run(bad)).reason,'capture_failed');assert.equal(bad.events.some(e=>e[0]==='source'),false);
  const f=worker({resultOverride:{status:'original_selected_stock_union_replay_progress_retained',operation_id:claim.operation_id,
    context_complete:false,pin_transfer:false,report_update:'none',continuation:{status:'continuation_pending',phase:'frozen_selected_union_refs_v2',
      attempts:claim.attempts,fresh_claim_required:true,context_complete:false,pin_transfer:false}}});
  assert.equal((await run(f)).reason,'capture_failed');
});
