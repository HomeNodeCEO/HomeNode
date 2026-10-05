import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortCaptureJobRepository }
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
