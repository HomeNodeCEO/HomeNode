import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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
  captureError = null, captureResult = { status: 'registered', context_ref },
  heartbeatAction = null, failureAction = null, captureAction = null } = {}) {
  const events = [];
  let heartbeatCalls = 0;
  const pool = { async connect() {
    events.push('connect');
    return { async query(sql) { events.push(sql); }, release() { events.push('release'); } };
  } };
  const repositoryFactory = () => ({
    async claimDue(options) { events.push(['claim', options]); return due; },
    async heartbeat(value, options) {
      events.push(['heartbeat', value, options]);
      if (heartbeatAction) return heartbeatAction(++heartbeatCalls, value, options);
      return { cancellation_requested: cancelled };
    },
    async failClaim(value, reason) {
      events.push(['fail', value, reason]);
      if (failureAction) return failureAction(value, reason);
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
    if (captureAction) return captureAction(input, options);
    if (captureError) throw captureError;
    return captureResult;
  } };
  return { events, pool, repositoryFactory, loadActor, cohortService };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function abortedCapture(entered, completion) {
  return (_input, { signal }) => {
    signal.addEventListener('abort', () => completion.reject(
      Object.assign(new Error('synthetic capture cancelled'), { reason: 'cancelled' })), { once: true });
    entered.resolve(signal);
    return completion.promise;
  };
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

test('an initial heartbeat failure is not mistaken for a successful capture', async () => {
  const deps = fixture({ heartbeatAction: async () => { throw new Error('synthetic heartbeat failure'); } });
  assert.deepEqual(await runCustomCohortCaptureJobOnce(deps), {
    status: 'retry', operation_id: operation, reason: 'capture_failed',
  });
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'capture'), false);
});

test('revoked roles are never replaced by stale queue-time claims', async () => {
  const deps = fixture({ actorError: new TypeError('custom_cohort_job_actor_access_revoked') });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.status, 'retry');
  assert.equal(result.reason, 'access_revoked');
  assert.equal(deps.events.some(event => Array.isArray(event) && event[0] === 'capture'), false);
});

test('assignment access lost during capture is recorded as revoked access', async () => {
  const deps = fixture({ captureError: Object.assign(new Error('synthetic access denied'), {
    reason: 'assignment_access_denied' }) });
  const result = await runCustomCohortCaptureJobOnce(deps);
  assert.equal(result.reason, 'access_revoked');
  assert.deepEqual(deps.events.find(event => Array.isArray(event) && event[0] === 'fail'),
    ['fail', claim, 'access_revoked']);
});

test('cancellation during running capture aborts work and settles only its fenced claim', {
  timeout: 10_000,
}, async t => {
  const entered = deferred(), completion = deferred();
  const deps = fixture({
    heartbeatAction: async count => ({ cancellation_requested: count > 1 }),
    failureAction: async (_claim, reason) => ({ status: reason === 'cancelled' ? 'cancelled' : 'retry' }),
    captureAction: abortedCapture(entered, completion),
  });
  const pending = runCustomCohortCaptureJobOnce({ ...deps, heartbeatSeconds: 1, leaseSeconds: 15 });
  t.after(async () => { completion.resolve({ status: 'registered', context_ref }); await pending.catch(() => {}); });
  const signal = await entered.promise;
  assert.equal(signal.aborted, false);
  assert.deepEqual(await pending, { status: 'cancelled', operation_id: operation, reason: 'cancelled' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(deps.events.filter(event => Array.isArray(event) && event[0] === 'fail'),
    [['fail', claim, 'cancelled']]);
});

test('a lost heartbeat lease aborts capture without overwriting the successor claim', {
  timeout: 10_000,
}, async t => {
  const entered = deferred(), completion = deferred();
  const deps = fixture({
    heartbeatAction: async count => {
      if (count > 1) throw new TypeError('custom_cohort_capture_job_claim_lost');
      return { cancellation_requested: false };
    },
    failureAction: async () => { throw new TypeError('custom_cohort_capture_job_claim_lost'); },
    captureAction: abortedCapture(entered, completion),
  });
  const pending = runCustomCohortCaptureJobOnce({ ...deps, heartbeatSeconds: 1, leaseSeconds: 15 });
  t.after(async () => { completion.resolve({ status: 'registered', context_ref }); await pending.catch(() => {}); });
  const signal = await entered.promise;
  assert.deepEqual(await pending, { status: 'outcome_unknown', operation_id: operation });
  assert.equal(signal.aborted, true);
  assert.deepEqual(deps.events.filter(event => Array.isArray(event) && event[0] === 'fail'),
    [['fail', claim, 'cancelled']]);
});

test('slow heartbeat queries do not overlap and shutdown waits for the in-flight query', {
  timeout: 10_000,
}, async t => {
  const entered = deferred(), completion = deferred(), heartbeatEntered = deferred(), heartbeatCompletion = deferred();
  const deps = fixture({
    heartbeatAction: async count => {
      if (count === 1) return { cancellation_requested: false };
      heartbeatEntered.resolve();
      return heartbeatCompletion.promise;
    },
    captureAction: (_input, { signal }) => { entered.resolve(signal); return completion.promise; },
  });
  const pending = runCustomCohortCaptureJobOnce({ ...deps, heartbeatSeconds: 1, leaseSeconds: 15 });
  t.after(async () => {
    heartbeatCompletion.resolve({ cancellation_requested: false });
    completion.resolve({ status: 'registered', context_ref });
    await pending.catch(() => {});
  });
  await entered.promise;
  await heartbeatEntered.promise;
  await delay(1100);
  assert.equal(deps.events.filter(event => Array.isArray(event) && event[0] === 'heartbeat').length, 2);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  completion.resolve({ status: 'registered', context_ref });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the worker must join its checked-out heartbeat before returning');
  heartbeatCompletion.resolve({ cancellation_requested: false });
  assert.equal((await pending).status, 'succeeded');
  const finishedEventCount = deps.events.length;
  await delay(1100);
  assert.equal(deps.events.length, finishedEventCount, 'no heartbeat may run after shutdown');
});

test('a lost registration acknowledgment cannot downgrade an already committed job', async () => {
  const deps = fixture({
    captureError: Object.assign(new Error('synthetic lost commit acknowledgment'), { outcome_unknown: true }),
    failureAction: async () => { throw new TypeError('custom_cohort_capture_job_claim_lost'); },
  });
  assert.deepEqual(await runCustomCohortCaptureJobOnce(deps), {
    status: 'outcome_unknown', operation_id: operation,
  });
  assert.deepEqual(deps.events.filter(event => Array.isArray(event) && event[0] === 'fail'),
    [['fail', claim, 'capture_failed']]);
});

test('capture failure retains the old study and retries only the fenced job', async () => {
  for (const reason of ['cancelled', 'deadline_exceeded', 'subject_changed', 'market_policy_changed']) {
    const deps = fixture({ captureError: Object.assign(new Error('synthetic capture failure'), { reason }) });
    const result = await runCustomCohortCaptureJobOnce(deps);
    assert.equal(result.status, 'retry');
    assert.equal(result.reason, reason);
    assert.deepEqual(deps.events.find(event => event[0] === 'fail')[1], claim);
  }
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
  for (const timing of [{ leaseSeconds: 14 }, { leaseSeconds: 901 }, { leaseSeconds: 15.5 },
    { leaseSeconds: 30, heartbeatSeconds: 10 }]) {
    await assert.rejects(runCustomCohortCaptureJobOnce({ ...deps, ...timing }), /invalid_input/);
  }
  assert.deepEqual(deps.events, []);
  for (const leaseSeconds of [15, 900]) {
    assert.equal((await runCustomCohortCaptureJobOnce({ ...fixture({ due: [] }),
      leaseSeconds, heartbeatSeconds: 1 })).status, 'idle');
  }
});
