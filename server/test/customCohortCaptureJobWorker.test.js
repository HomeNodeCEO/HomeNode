import test from 'node:test';
import assert from 'node:assert/strict';
import { runCustomCohortCaptureJobOnce }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';

const organization = '11111111-1111-4111-8111-111111111111';
const report = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const operation = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';
const claim = { operation_id: operation, claim_token: token, attempts: 1 };
const context_ref = { context_id: operation, context_revision: '1',
  context_sha256: 'a'.repeat(64) };
const row = { ...claim, organization_id: organization, report_file_id: report,
  assignment_file_id: '17', account_id: 'SYNTHETIC-ACCOUNT', actor_user_id: actor,
  request_payload: { operation_id: operation, observation_period: {
    start_date: '2024-01-01', end_date: '2024-12-31' } } };

function fixture({ due = [row], cancelled = false, actorError = null,
  captureError = null, captureResult = { status: 'registered', context_ref } } = {}) {
  const events = [];
  const pool = { async connect() {
    events.push('connect');
    return { async query(sql) { events.push(sql); }, release() { events.push('release'); } };
  } };
  const repositoryFactory = () => ({
    async claimDue(options) { events.push(['claim', options]); return due; },
    async heartbeat(value, options) {
      events.push(['heartbeat', value, options]);
      return { cancellation_requested: cancelled };
    },
    async failClaim(value, reason) {
      events.push(['fail', value, reason]);
      return { status: cancelled ? 'cancelled' : 'retry' };
    },
  });
  const loadActor = async (_client, userId, organizationId) => {
    events.push(['actor', userId, organizationId]);
    if (actorError) throw actorError;
    return { userId, organizations: [{ organizationId, roles: ['appraiser'] }] };
  };
  const cohortService = { async capture(input, options) {
    events.push(['capture', input, options]);
    if (captureError) throw captureError;
    return captureResult;
  } };
  return { events, pool, repositoryFactory, loadActor, cohortService };
}

test('an idle worker neither reads actor rights nor starts a capture', async () => {
  const deps = fixture({ due: [] });
  assert.deepEqual(await runCustomCohortCaptureJobOnce(deps), { status: 'idle' });
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'actor'), false);
});

test('a claimed job reloads current roles and carries only its fenced claim to capture', async () => {
  const deps = fixture();
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.context_ref, context_ref);
  assert.deepEqual(deps.events.find(event => event[0] === 'actor'),
    ['actor', actor, organization]);
  const [, input, options] = deps.events.find(event => event[0] === 'capture');
  assert.deepEqual(Object.keys(input).sort(), ['accountId', 'assignmentFileId', 'auth',
    'observationPeriod', 'operationId'].sort());
  assert.equal(input.accountId, row.account_id);
  assert.deepEqual(options.captureJobClaim, claim);
  assert.equal(options.signal.aborted, false);
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'fail'), false);
});

test('a cancelled lease does not start a capture and settles as cancelled', async () => {
  const deps = fixture({ cancelled: true });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'cancelled');
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'capture'), false);
  assert.equal(deps.events.find(event => event[0] === 'fail')[2], 'cancelled');
});

test('revoked roles are never replaced by stale queue-time claims', async () => {
  const deps = fixture({ actorError: new TypeError('custom_cohort_job_actor_access_revoked') });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'retry');
  assert.equal(result.reason, 'access_revoked');
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'capture'), false);
});

test('capture failure retains the old study and retries only the fenced job', async () => {
  const deps = fixture({ captureError: Object.assign(new Error('denied'), {
    reason: 'market_policy_changed' }) });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'retry');
  assert.equal(result.reason, 'market_policy_changed');
  assert.deepEqual(deps.events.find(event => event[0] === 'fail')[1], claim);
});

test('a malformed success acknowledgment cannot be presented as complete', async () => {
  const deps = fixture({ captureResult: { status: 'registered', context_ref: {
    ...context_ref, context_id: '66666666-6666-4666-8666-666666666666' } } });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'retry');
  assert.equal(result.reason, 'capture_failed');
});

test('invalid timing bounds fail before claiming a job', async () => {
  const deps = fixture();
  await assert.rejects(runCustomCohortCaptureJobOnce({ ...deps,
    leaseSeconds: 30, heartbeatSeconds: 10 }), /invalid_input/);
  assert.deepEqual(deps.events, []);
});
