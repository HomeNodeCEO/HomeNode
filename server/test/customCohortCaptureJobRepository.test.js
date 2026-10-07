import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPTURE_JOB_LEASE_SECONDS, createCustomCohortCaptureJobRepository }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';

const organization = '11111111-1111-4111-8111-111111111111';
const report = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';
const scope = { organization_id: organization, report_file_id: report,
  assignment_file_id: '17', account_id: 'SYNTHETIC-ACCOUNT' };
const request = { operation_id: operation, observation_period: {
  start_date: '2024-01-01', end_date: '2024-12-31' } };

test('original job request is reopened under exact live scope/actor/claim, never taken from a replacement worker',async()=>{
  const claim={operation_id:operation,claim_token:token,attempts:1};
  const calls=[];
  const repository=createCustomCohortCaptureJobRepository({async query(sql,values){calls.push({sql,values});
    return {rowCount:1,rows:[{request_payload:request,request_sha256:assessmentEvidenceDigest(request)}]};}});
  assert.deepEqual(await repository.readRequest(claim,{scope,actorUserId:actor}),request);
  assert.deepEqual(calls[0].values,[operation,token,1,organization,report,'17','SYNTHETIC-ACCOUNT',actor]);
  assert.match(calls[0].sql,/cancellation_requested_at IS NULL/);assert.match(calls[0].sql,/lease_expires_at>clock_timestamp\(\)/);
  const corrupt=createCustomCohortCaptureJobRepository({async query(){return {rowCount:1,rows:[{request_payload:request,request_sha256:'a'.repeat(64)}]};}});
  await assert.rejects(corrupt.readRequest(claim,{scope,actorUserId:actor}),/job_corrupt/);
});

test('prepared-generation pin migration is registered after its job and index prerequisites', () => {
  const name = '20261104_custom_cohort_prepared_generation_pins.sql';
  const registry = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  for (const prerequisite of ['20261024_neighborhood_group_index.sql',
    '20261030_custom_cohort_capture_jobs.sql', '20261103_custom_cohort_catalog_membership_roots.sql']) {
    assert.ok(registry.includes(prerequisite));
    assert.ok(registry.indexOf(name) > registry.indexOf(prerequisite));
  }
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  assert.match(sql, /CREATE INDEX neighborhood_cohort_prepared_pins_generation_idx/);
  for (const match of sql.matchAll(/CREATE (?:INDEX|TRIGGER) ([a-z_]+)/g)) {
    assert.ok(Buffer.byteLength(match[1]) <= 63, 'declared PostgreSQL identifiers must not be silently truncated');
  }
  assert.match(sql, /FOREIGN KEY\(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id\)/);
  assert.match(sql, /ON DELETE RESTRICT ON UPDATE RESTRICT/);
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT/);
  assert.doesNotMatch(sql, /FOR EACH ROW|DISABLE TRIGGER|DROP TABLE|UPDATE app\.|DELETE FROM app\./);
  for (const relation of ['neighborhood_group_generations', 'neighborhood_group_parcel_facts',
    'neighborhood_group_sale_facts', 'neighborhood_group_summary']) assert.ok(sql.includes(`'${relation}'`));
});

test('shared lease bounds remain inclusive and invalid values never reach PostgreSQL', async () => {
  assert.deepEqual(CAPTURE_JOB_LEASE_SECONDS, { min: 15, max: 900 });
  assert.equal(Object.isFrozen(CAPTURE_JOB_LEASE_SECONDS), true);
  const values = [];
  const repository = createCustomCohortCaptureJobRepository({ async query(_sql, parameters) {
    values.push(parameters);
    return { rowCount: 1, rows: [{ cancellation_requested_at: null }] };
  } });
  const claim = { operation_id: operation, claim_token: token, attempts: 1 };
  for (const leaseSeconds of [14, 901, 15.5, '15']) {
    await assert.rejects(repository.heartbeat(claim, { leaseSeconds }), /invalid_lease/);
    await assert.rejects(repository.claimDue({ leaseSeconds }), /invalid_lease/);
  }
  assert.deepEqual(values, []);
  for (const leaseSeconds of [15, 900]) {
    assert.equal((await repository.heartbeat(claim, { leaseSeconds })).cancellation_requested, false);
  }
  assert.deepEqual(values.map(parameters => parameters[3]), [15, 900]);
});

test('queue request retains only admitted data, with exact scope and replay digest', async () => {
  const calls = [];
  let admitted;
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('custom-cohort-job:enqueue */')) {
      admitted = { request_sha256: values[6], request_payload: JSON.parse(values[7]), actor_user_id: actor };
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [{ ...admitted, operation_id: operation, status: 'queued' }] };
  } });
  const result = await repository.enqueue({ scope, actorUserId: actor, request });
  assert.equal(result.status, 'queued');
  assert.equal(result.request_sha256, admitted.request_sha256);
  assert.deepEqual(admitted.request_payload, request);
  assert.deepEqual(calls[0].values.slice(0, 6), [operation, organization, report,
    '17', 'SYNTHETIC-ACCOUNT', actor]);
  assert.match(calls[1].sql, /organization_id=\$2::uuid/);
  await assert.rejects(repository.enqueue({ scope, actorUserId: actor,
    request: { ...request, auth: { token: 'never-persist' } } }), /invalid_input/);
  assert.equal(calls.length, 2, 'unadmitted claims never reach PostgreSQL');
});

test('changed operation input or actor cannot replay a queued job', async () => {
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    if (sql.includes('enqueue-readback')) return { rowCount: 1, rows: [{
      operation_id: operation, request_sha256: 'a'.repeat(64),
      request_payload: request, actor_user_id: actor, status: 'queued' }] };
    return { rowCount: 0, rows: [] };
  } });
  await assert.rejects(repository.enqueue({ scope, actorUserId: actor, request }), /operation_conflict/);
});

test('lease, cancellation and success are fenced to the claim and original context', async () => {
  const statements = [];
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    statements.push({ sql, values });
    if (sql.includes('custom-cohort-job:claim')) return { rowCount: 1, rows: [{
      operation_id: operation, organization_id: organization, report_file_id: report,
      assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
      actor_user_id: actor, request_sha256: assessmentEvidenceDigest(request),
      request_payload: request, claim_token: token, attempts: 1 }] };
    if (sql.includes('custom-cohort-job:heartbeat')) return {
      rowCount: 1, rows: [{ cancellation_requested_at: new Date() }] };
    if (sql.includes('custom-cohort-job:cancel')) return { rowCount: 1, rows: [{ status: 'running' }] };
    if (sql.includes('custom-cohort-job:failure')) return { rowCount: 1, rows: [{ status: 'cancelled' }] };
    if (sql.includes('custom-cohort-job:complete')) return { rowCount: 1, rows: [{
      operation_id: operation, context_sha256: 'b'.repeat(64) }] };
    return { rowCount: 0, rows: [] };
  } });
  const [claim] = await repository.claimDue();
  assert.equal(claim.operation_id, operation);
  assert.match(statements[1].sql, /FOR UPDATE SKIP LOCKED/);
  const cancelled = await repository.heartbeat({ operation_id: operation, claim_token: token,
    attempts: 1 }, { checkpoint: { phase: 'source', evidence_refs: [
    { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '100' }] } });
  assert.equal(cancelled.cancellation_requested, true);
  assert.match(statements[2].sql, /lease_expires_at>clock_timestamp\(\)/);
  assert.equal((await repository.cancel(scope, operation)).status, 'running');
  assert.equal((await repository.failClaim({ operation_id: operation, claim_token: token,
    attempts: 1 }, 'cancelled')).status, 'cancelled');
  const completed = await repository.complete({ operation_id: operation, claim_token: token,
    attempts: 1 }, 'b'.repeat(64));
  assert.equal(completed.context_sha256, 'b'.repeat(64));
  const completionSql = statements.at(-1).sql;
  assert.match(completionSql, /FROM app\.neighborhood_custom_cohort_contexts context/);
  assert.match(completionSql, /context\.report_file_id=job\.report_file_id/);
  assert.match(completionSql, /context\.context_sha256=\$4/);
  assert.match(completionSql, /job\.cancellation_requested_at IS NULL/);
});

test('malformed checkpoints and claims cannot renew a lease', async () => {
  let queried = false;
  const repository = createCustomCohortCaptureJobRepository({ async query() { queried = true; } });
  await assert.rejects(repository.heartbeat({ operation_id: operation,
    claim_token: token, attempts: 0 }), /invalid_claim/);
  await assert.rejects(repository.heartbeat({ operation_id: operation,
    claim_token: token, attempts: 1 }, { checkpoint: { phase: 'source',
    evidence_refs: [{ content_sha256: 'bad', canonical_utf8_bytes: '100' }] } }), /invalid_checkpoint/);
  await assert.rejects(repository.claimDue({ limit: 100 }), /invalid_limit/);
  assert.equal(queried, false);
});

test('a claimed request with a changed payload cannot be resumed', async () => {
  const calls = [];
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('custom-cohort-job:claim')) return { rowCount: 1, rows: [{
      operation_id: operation, organization_id: organization, report_file_id: report,
      assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
      actor_user_id: actor, request_sha256: assessmentEvidenceDigest(request),
      request_payload: { ...request, observation_period: {
        start_date: '2023-01-01', end_date: '2024-12-31' } },
      claim_token: token, attempts: 1 }] };
    if (sql.includes('custom-cohort-job:quarantine')) return { rowCount: 1, rows: [{ operation_id: operation }] };
    return { rowCount: 0, rows: [] };
  } });
  assert.deepEqual(await repository.claimDue(), []);
  assert.match(calls.at(-1).sql, /last_error_code='job_corrupt'/);
  assert.deepEqual(calls.at(-1).values, [operation, token, 1]);
});

test('a claimed checkpoint is structurally verified before worker resume', async () => {
  const evidence = { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '100' };
  let checkpoint = { phase: 'source', evidence_refs: [evidence] };
  const repository = createCustomCohortCaptureJobRepository({ async query(sql) {
    if (sql.includes('custom-cohort-job:claim')) return { rowCount: 1, rows: [{
      operation_id: operation, organization_id: organization, report_file_id: report,
      assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
      actor_user_id: actor, request_sha256: assessmentEvidenceDigest(request),
      request_payload: request, claim_token: token, attempts: 1, checkpoint }] };
    if (sql.includes('custom-cohort-job:quarantine')) return { rowCount: 1, rows: [{ operation_id: operation }] };
    return { rowCount: 0, rows: [] };
  } });
  const [claimed] = await repository.claimDue();
  assert.deepEqual(claimed.checkpoint, checkpoint);
  assert.equal(Object.isFrozen(claimed.checkpoint.evidence_refs[0]), true);
  checkpoint = { phase: 'source', evidence_refs: [{ ...evidence, content_sha256: 'bad' }] };
  assert.deepEqual(await repository.claimDue(), []);
  checkpoint = { phase: 'unknown', evidence_refs: [] };
  assert.deepEqual(await repository.claimDue(), []);
});

test('a corrupt earlier claim does not prevent a valid claim in the same batch', async () => {
  const later = '66666666-6666-4666-8666-666666666666';
  const laterToken = '77777777-7777-4777-8777-777777777777';
  const rows = [
    { operation_id: operation, claim_token: token, attempts: 1,
      request_payload: { ...request, observation_period: {
        start_date: '2023-01-01', end_date: '2024-12-31' } } },
    { operation_id: later, claim_token: laterToken, attempts: 1,
      request_payload: { ...request, operation_id: later } },
  ].map(row => ({ organization_id: organization, report_file_id: report,
    assignment_file_id: scope.assignment_file_id, account_id: scope.account_id,
    actor_user_id: actor, request_sha256: assessmentEvidenceDigest({
      ...request, operation_id: row.operation_id }), ...row }));
  const repository = createCustomCohortCaptureJobRepository({ async query(sql) {
    if (sql.includes('custom-cohort-job:claim')) return { rowCount: 2, rows };
    if (sql.includes('custom-cohort-job:quarantine')) return { rowCount: 1,
      rows: [{ operation_id: operation }] };
    return { rowCount: 0, rows: [] };
  } });
  const claimed = await repository.claimDue({ limit: 2 });
  assert.deepEqual(claimed.map(row => row.operation_id), [later]);
});

test('scoped job status exposes no checkpoint or internal source error', async () => {
  const queries = [];
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    queries.push({ sql, values });
    return { rowCount: 1, rows: [{ status: 'succeeded', attempts: 2,
      cancellation_requested: false, context_sha256: 'b'.repeat(64),
      checkpoint: { private: 'not returned' }, last_error_code: 'source_denied' }] };
  } });
  assert.deepEqual(await repository.status(scope, operation), {
    operation_id: operation, status: 'succeeded', attempts: 2,
    cancellation_requested: false, context_ref: {
      context_id: operation, context_revision: '1', context_sha256: 'b'.repeat(64) },
  });
  assert.match(queries[0].sql, /organization_id=\$2::uuid/);
  assert.match(queries[0].sql, /report_file_id=\$3::uuid/);
  assert.deepEqual(queries[0].values, [operation, organization, report,
    scope.assignment_file_id, scope.account_id]);
});

test('job status rejects impossible completion state', async () => {
  const repository = createCustomCohortCaptureJobRepository({ async query() {
    return { rowCount: 1, rows: [{ status: 'succeeded', attempts: 1,
      cancellation_requested: false, context_sha256: null }] };
  } });
  await assert.rejects(repository.status(scope, operation), /job_corrupt/);
});

test('cancellation safely replays a terminal result under the exact scope', async () => {
  const calls = [];
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('custom-cohort-job:cancel')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ status: 'cancelled', attempts: 1,
      cancellation_requested: true, context_sha256: null }] };
  } });
  assert.deepEqual(await repository.cancel(scope, operation), { status: 'cancelled' });
  assert.match(calls[1].sql, /organization_id=\$2::uuid/);
  assert.deepEqual(calls[0].values, calls[1].values);
});

test('checkpoint reads and writes use the exact live scope, original actor and claim fence', async () => {
  const calls = [], claim = { operation_id: operation, claim_token: token, attempts: 2 };
  const options = { scope, actorUserId: actor };
  const checkpoint = { phase: 'subject', evidence_refs: [
    { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '123' }] };
  let stored = null;
  const repository = createCustomCohortCaptureJobRepository({ async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('checkpoint-save')) stored = JSON.parse(values[8]);
    return { rowCount: 1, rows: [{ checkpoint: stored }] };
  } });
  assert.equal(await repository.readCheckpoint(claim, options), null);
  assert.deepEqual(await repository.saveCheckpoint(claim, options, checkpoint), checkpoint);
  const reopened = await repository.readCheckpoint(claim, options);
  assert.deepEqual(reopened, checkpoint);
  assert.equal(Object.isFrozen(reopened.evidence_refs[0]), true);
  for (const { sql, values } of calls) {
    assert.deepEqual(values.slice(0, 8), [operation, token, 2, organization, report,
      scope.assignment_file_id, scope.account_id, actor]);
    for (const fragment of ["status='running'", 'lease_expires_at>clock_timestamp()',
      'organization_id=$4::uuid', 'report_file_id=$5::uuid', 'assignment_file_id=$6::bigint',
      'account_id=$7', 'actor_user_id=$8::uuid', 'cancellation_requested_at IS NULL']) {
      assert.ok(sql.includes(fragment), fragment);
    }
    assert.ok(!sql.includes('SET lease_expires_at'), 'checkpointing does not renew a lease');
  }
});

test('checkpoint access refuses stale claims, corrupt readback and unadmitted options', async () => {
  const claim = { operation_id: operation, claim_token: token, attempts: 1 };
  const options = { scope, actorUserId: actor };
  const checkpoint = { phase: 'subject', evidence_refs: [] };
  let calls = 0, answer = { rowCount: 0, rows: [] };
  const repository = createCustomCohortCaptureJobRepository({ async query() { calls++; return answer; } });
  await assert.rejects(repository.readCheckpoint(claim, options), /claim_lost/);
  await assert.rejects(repository.saveCheckpoint(claim, options, checkpoint), /claim_lost/);
  answer = { rowCount: 1, rows: [{ checkpoint: { phase: 'source', evidence_refs: [] } }] };
  await assert.rejects(repository.saveCheckpoint(claim, options, checkpoint), /job_corrupt/);
  answer.rows[0].checkpoint.phase = 'invalid';
  await assert.rejects(repository.readCheckpoint(claim, options), /invalid_checkpoint/);
  const before = calls;
  for (const invalid of [{ ...options, token: 'not admitted' }, { scope },
    { ...options, actorUserId: 'bad' }, { ...options, scope: { ...scope, account_id: '' } }]) {
    await assert.rejects(repository.readCheckpoint(claim, invalid), /invalid_/);
    await assert.rejects(repository.saveCheckpoint(claim, invalid, checkpoint), /invalid_/);
  }
  await assert.rejects(repository.saveCheckpoint(claim, options,
    { phase: 'subject', evidence_refs: [{ content_sha256: 'bad', canonical_utf8_bytes: '1' }] }), /invalid_checkpoint/);
  assert.equal(calls, before, 'unadmitted checkpoint input never reaches SQL');
});

function generationFixture({ autocommit=false, endingLost=false, corrupt=false, active=true }={}) {
  const generation='66666666-6666-4666-8666-666666666666',calls=[];
  let pinned=null,transactions=0,fences=0;
  const repository=createCustomCohortCaptureJobRepository({async query(sql,values) {
    calls.push({sql,values});
    if(sql.includes('generation-transaction')) return {rowCount:1,rows:[{transaction_id:autocommit?String(++transactions):'12'}]};
    if(sql.includes('generation-fence')) return ++fences===2 && endingLost
      ? {rowCount:0,rows:[]} : {rowCount:1,rows:[{operation_id:operation}]};
    if(sql.includes('generation-read')) return pinned ? {rowCount:1,rows:[{generation_id:pinned,
      status:'complete',retirement_started_at:corrupt?'2026-01-01':null,
      source_observed_at:'2026-01-01T00:00:00.000000Z',completed_at:'2026-01-01T00:01:00.000000Z',
      parcel_count:'60001',sale_count:'82',group_count:'2'}]} : {rowCount:0,rows:[]};
    if(sql.includes('generation-active')) return active ? {rowCount:1,rows:[{generation_id:generation}]} : {rowCount:0,rows:[]};
    if(sql.includes('generation-pin')) {pinned=values.at(-1);return {rowCount:1,rows:[]};}
    throw new Error('unexpected_generation_query');
  }});
  return {repository,calls,generation,set pinned(value){pinned=value;}};
}
const generationClaim={operation_id:operation,claim_token:token,attempts:1};
const generationOptions={scope,actorUserId:actor};

test('prepared generation read miss performs no preparation or source-table read',async()=>{
  const f=generationFixture();
  assert.equal(await f.repository.readPreparedGeneration(generationClaim,generationOptions),null);
  assert.equal(f.calls.some(({sql})=>sql.includes('generation-active') || sql.includes('generation-pin')),false);
  assert.equal(f.calls.some(({sql})=>sql.includes('core.') || sql.includes('gis.')),false);
});

test('prepared generation is server-picked once and never follows a newer active pointer on replay',async()=>{
  const f=generationFixture();
  const original=await f.repository.pinPreparedGeneration(generationClaim,generationOptions);
  assert.equal(original.generation_id,f.generation);
  assert.equal(original.parcel_count,'60001');
  assert.equal(Object.isFrozen(original),true);
  const before=f.calls.length;
  assert.deepEqual(await f.repository.pinPreparedGeneration(generationClaim,generationOptions),original);
  assert.deepEqual(await f.repository.readPreparedGeneration({...generationClaim,attempts:2},generationOptions),original);
  assert.equal(f.calls.slice(before).some(({sql})=>sql.includes('generation-active') || sql.includes('generation-pin')),false);
  const active=f.calls.find(({sql})=>sql.includes('generation-active')).sql;
  assert.match(active,/retirement_started_at IS NULL/);
  assert.match(active,/FOR KEY SHARE OF generation NOWAIT/);
});

test('generation pin checks the exact live job scope and actor at both ends without renewing its lease',async()=>{
  const f=generationFixture();
  await f.repository.pinPreparedGeneration(generationClaim,generationOptions);
  const fences=f.calls.filter(({sql})=>sql.includes('generation-fence'));
  assert.equal(fences.length,2);
  for(const {sql,values} of fences){
    assert.deepEqual(values,[operation,token,1,organization,report,'17','SYNTHETIC-ACCOUNT',actor]);
    assert.match(sql,/FOR SHARE NOWAIT/);
    assert.match(sql,/cancellation_requested_at IS NULL/);
    assert.match(sql,/lease_expires_at>clock_timestamp\(\)/);
    assert.doesNotMatch(sql,/SET lease_expires_at/);
  }
});

test('generation pin rejects autocommit before any job or prepared source is read or written',async()=>{
  for(const method of ['pinPreparedGeneration','readPreparedGeneration']) {
    const f=generationFixture({autocommit:true});
    await assert.rejects(f.repository[method](generationClaim,generationOptions),/caller_transaction_required/);
    assert.equal(f.calls.length,2);
    assert.ok(f.calls.every(({sql})=>sql.includes('generation-transaction')));
  }
});

test('missing complete active generation does not mint a pin or fall back to mutable data',async()=>{
  const f=generationFixture({active:false});
  await assert.rejects(f.repository.pinPreparedGeneration(generationClaim,generationOptions),/prepared_generation_unavailable/);
  assert.equal(f.calls.some(({sql})=>sql.includes('generation-pin')),false);
});

test('corrupt or retired prepared generation is refused instead of silently replaced',async()=>{
  const f=generationFixture({corrupt:true});f.pinned=f.generation;
  await assert.rejects(f.repository.readPreparedGeneration(generationClaim,generationOptions),/prepared_generation_corrupt/);
  await assert.rejects(f.repository.pinPreparedGeneration(generationClaim,generationOptions),/prepared_generation_corrupt/);
  assert.equal(f.calls.some(({sql})=>sql.includes('generation-active') || sql.includes('generation-pin')),false);
});

test('ending cancellation or claim loss refuses a staged generation result for caller rollback',async()=>{
  const f=generationFixture({endingLost:true});
  await assert.rejects(f.repository.pinPreparedGeneration(generationClaim,generationOptions),/claim_lost/);
  assert.ok(f.calls.some(({sql})=>sql.includes('generation-pin')),'the owner must roll back this attempted pin');
});

test('a browser generation, missing actor or malformed claim is rejected before SQL',async()=>{
  const f=generationFixture();
  for(const options of [{...generationOptions,generation_id:f.generation},{scope},{...generationOptions,actorUserId:'invalid'}]) {
    await assert.rejects(f.repository.pinPreparedGeneration(generationClaim,options),/invalid_/);
    await assert.rejects(f.repository.readPreparedGeneration(generationClaim,options),/invalid_/);
  }
  await assert.rejects(f.repository.pinPreparedGeneration({...generationClaim,attempts:0},generationOptions),/invalid_claim/);
  assert.equal(f.calls.length,0);
});
