import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createNeighborhoodAssessmentRepositoryInTransaction,
  neighborhoodCallerCleanupFailure as cleanupFailure } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { customCohortReadDiagnostic } from '../src/services/neighborhoodAssessment/customCohortReadDiagnostics.js';
import { reportedReplacementOwnerFixture } from './fixtures/customCohortReportedReplacementOwnerFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

const INTERRUPTED = { error: 'neighborhood_request_interrupted' };
const FAILED = { error: 'neighborhood_request_failed' };
const UNKNOWN = { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true };
const secret = 'PRIVATE SQL source account path';
async function rejected(action) {
  let caught;
  await assert.rejects(action, error => { caught = error; return true; });
  return caught;
}

// The actual repository creates the aggregate; there is no test-only mint or
// exported classification setter. This client is an in-memory SQL double.
async function aggregate(primary, cleanup) {
  const calls = [], repository = createNeighborhoodAssessmentRepositoryInTransaction({ release() { assert.fail('owner release'); },
    async query(text) {
      calls.push(text);
      if (text === 'SAVEPOINT neighborhood_repository_owner') return { rows: [], rowCount: 0 };
      if (text.includes('caller-transaction')) throw primary;
      if (text === 'ROLLBACK TO SAVEPOINT neighborhood_repository_owner') throw cleanup;
      assert.fail('unexpected SQL');
    } });
  const error = await rejected(() => repository.getCurrent(ASSESSMENT_SCOPE));
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'neighborhood_caller_cleanup_failed');
  assert.deepEqual(error.errors, [primary, cleanup]);
  assert.equal(calls.length, 3);
  return error;
}

// Invoke the actual async Express route handler with request/response doubles:
// no socket, browser, HTTP request, database or production environment is used.
async function routeFailure(error) {
  const logs = [], callback = async () => { throw error; };
  const router = createCustomNeighborhoodCohortRouter({ logger: { warn(...args) { logs.push(args); } }, cohortService: {
    capture: callback, catalog: callback, present: callback, inspect: callback, prepareReportedObservations: callback,
  } });
  const handler = router.stack.find(layer => layer.route?.path.endsWith('/reported-proposal')).route.stack.at(-1).handle;
  const req = Object.assign(new EventEmitter(), { mobileAuth: { userId: '10000000-0000-4000-8000-000000000001' },
    params: { id: 'R-001' }, body: { assignment_file_id: '41', context_ref: {}, expected_workspace_revision: 9,
      expected_editor_revision: 0, operation_id: '80000000-0000-4000-8000-000000000001' } });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false,
    set() { return this; }, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; this.writableFinished = true; return this; } });
  await handler(req, res);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  assert.equal(JSON.stringify([res.body, logs]).includes(secret), false);
  return { status: res.statusCode, body: res.body, logs };
}

function assertNoPublication(f) {
  for (const key of ['jobs', 'assessments', 'attachments', 'acceptances', 'histories']) assert.equal(f.state.db[key].size, 0);
  assert.equal(f.state.db.section, null);
}
function releaseHook(f, failure = null) {
  const connect = f.pool.connect.bind(f.pool), released = [];
  f.pool.connect = async () => {
    const client = await connect(), release = client.release.bind(client);
    client.release = error => { released.push(error); release(error); if (f.state.phases === 2 && failure) throw failure; };
    return client;
  };
  return released;
}
async function trustedInterruption(f, reason) {
  const controller = new AbortController(); controller.abort();
  const error = await rejected(() => f.service.prepareReportedObservations(f.input,
    reason === 'cancelled' ? { signal: controller.signal } : { deadline: performance.now() }));
  assert.equal(error.code, 'CUSTOM_COHORT_CAPTURE_FAILED'); assert.equal(error.reason, reason);
  return error;
}

test('repository provenance is exact identity, read-only and one level; it does not inspect caller shapes', async () => {
  const primary = new Error(secret), cleanup = new Error('cleanup');
  const error = await aggregate(primary, cleanup), pair = cleanupFailure(error);
  assert.deepEqual(pair, { primary, cleanup }); assert.ok(Object.isFrozen(pair));
  assert.equal(pair.primary, primary); assert.equal(pair.cleanup, cleanup);
  assert.equal(cleanupFailure(error), pair);
  assert.throws(() => { pair.primary = null; }, TypeError);
  let reads = 0;
  const accessor = { get errors() { reads++; throw new Error('getter'); } };
  const proxy = new Proxy(error, { get() { reads++; throw new Error('proxy'); } });
  for (const other of [null, undefined, 1, 'neighborhood_caller_cleanup_failed', accessor, proxy,
    { ...error }, structuredClone(error), new AggregateError(error.errors, error.message),
    new AggregateError([error], 'outer'), new Error('outer', { cause: error })]) {
    assert.equal(cleanupFailure(other), null);
  }
  assert.equal(reads, 0);
  const nested = await aggregate(error, cleanup);
  assert.equal(cleanupFailure(nested).primary, error, 'Lookup never recursively flattens the primary');
  // Public AggregateError children are not a classification channel. The
  // private pair retains original identities even if a consumer edits errors.
  error.errors = [new Error('replacement')];
  assert.equal(cleanupFailure(error).primary, primary);
});

for (const reason of ['deadline_exceeded', 'cancelled']) {
  for (const [stage, needle] of [['enqueue', 'neighborhood:caller-transaction'],
    ['claim', 'neighborhood:exact-job-lock'], ['publication', 'neighborhood:members']]) {
    test(`${reason} during ${stage} preserves the actual aggregate after connection discard and maps503`, async t => {
      const f = await reportedReplacementOwnerFixture(), controller = new AbortController(); let clock = 1000, fired = false;
      const released = releaseHook(f); t.mock.method(performance, 'now', () => clock);
      f.state.afterQuery = text => {
        if (!fired && f.state.phases === 2 && text.includes(needle)) {
          fired = true; if (reason === 'cancelled') controller.abort(); else clock += 60_000;
        }
      };
      const error = await rejected(() => f.service.prepareReportedObservations(f.input, { signal: controller.signal }));
      assert.equal(fired, true); assert.ok(error instanceof AggregateError);
      const pair = cleanupFailure(error); assert.ok(pair);
      assert.equal(error.code, 'CUSTOM_COHORT_CAPTURE_FAILED'); assert.equal(error.reason, reason);
      assert.equal(error.message, 'neighborhood_caller_cleanup_failed');
      assert.equal(error.errors[0], pair.primary); assert.equal(error.errors[1], pair.cleanup);
      assert.equal(pair.primary.reason, reason); assert.equal(pair.cleanup.reason, reason);
      assert.equal(Object.hasOwn(pair.primary, 'errors'), false);
      assert.equal(released.length, 2); assert.ok(released[1] instanceof Error);
      assert.equal(f.state.commits, 1); assertNoPublication(f);
      assert.ok(!f.state.calls.some(call => call.phase === 2 && call.text === 'COMMIT'));
      assert.ok(f.state.calls.at(-1).text.includes(needle), 'Expired savepoint cleanup sends no new SQL; owner discards');
      const response = await routeFailure(error);
      assert.equal(response.status, 503); assert.deepEqual(response.body, INTERRUPTED);
      assert.deepEqual(response.logs, [['[neighborhood] read refused', { action: 'reported-proposal', family: 'coordinator', check: reason }]]);
    });
  }
}

for (const rollbackFails of [false, true]) {
  test(`deadline between statements preserves outer ${rollbackFails ? 'rollback failure then discard' : 'successful rollback'} before normalization`, async t => {
    const f = await reportedReplacementOwnerFixture(), rollbackFailure = new Error(secret); let clock = 1000, arm = null, fired = false;
    const released = releaseHook(f);
    t.mock.method(performance, 'now', () => { if (arm !== null && arm-- === 0) clock += 60_000; return clock; });
    f.state.afterQuery = text => {
      if (!fired && text.includes('neighborhood:caller-transaction')) { fired = true; arm = 1; }
    };
    f.state.beforeQuery = text => { if (text === 'ROLLBACK' && rollbackFails) throw rollbackFailure; };
    const error = await rejected(() => f.service.prepareReportedObservations(f.input));
    assert.equal(error.reason, 'deadline_exceeded'); assert.ok(cleanupFailure(error));
    assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
    assert.equal(released[1], rollbackFails ? rollbackFailure : undefined);
    assert.equal(f.state.commits, 1); assertNoPublication(f);
    const response = await routeFailure(error); assert.equal(response.status, 503); assert.deepEqual(response.body, INTERRUPTED);
  });
}

test('release failure overrides a normalized interruption instead of claiming successful cleanup', async t => {
  const f = await reportedReplacementOwnerFixture(), failure = new Error(secret); let clock = 1000;
  const released = releaseHook(f, failure); t.mock.method(performance, 'now', () => clock);
  f.state.afterQuery = text => { if (text.includes('neighborhood:members')) clock += 60_000; };
  const error = await rejected(() => f.service.prepareReportedObservations(f.input));
  assert.equal(error, failure); assert.equal(cleanupFailure(error), null); assert.ok(released[1]);
  assertNoPublication(f);
  const response = await routeFailure(error); assert.equal(response.status, 500); assert.deepEqual(response.body, FAILED);
  assert.deepEqual(response.logs, []);
});

// Injection here tests only diagnostic provenance, never source or grant
// validity. Rejected errors are fed through the actual owner transaction catch.
async function ownerInjected(f, error) {
  f.state.beforeQuery = text => { if (f.state.phases === 2 && text.includes('report-editor')) throw error; };
  const thrown = await rejected(() => f.service.prepareReportedObservations(f.input));
  assertNoPublication(f); return thrown;
}
for (const where of ['aggregate', 'primary', 'cleanup']) for (const releaseFails of [false, true]) {
  test(`${where} outcome uncertainty beats interruption${releaseFails ? ' and survives a release failure' : ''}`, async () => {
    const f = await reportedReplacementOwnerFixture(), primary = await trustedInterruption(f, 'deadline_exceeded');
    const cleanup = new Error(secret), error = await aggregate(primary, cleanup), failure = new Error('release');
    if (where === 'aggregate') error.outcome_unknown = true;
    else if (where === 'primary') primary.outcome_unknown = true;
    else cleanup.outcome_unknown = true;
    if (releaseFails) releaseHook(f, failure);
    const actual = await ownerInjected(f, error);
    assert.equal(actual, releaseFails ? failure : error); assert.equal(actual.outcome_unknown, true);
    if (!releaseFails) {
      assert.equal(actual.errors[0], primary); assert.equal(actual.errors[1], cleanup);
      assert.equal(Object.hasOwn(actual, 'reason'), false);
    }
    const response = await routeFailure(actual); assert.equal(response.status, 409); assert.deepEqual(response.body, UNKNOWN);
    assert.deepEqual(response.logs, []);
  });
}

for (const kind of ['lookalike', 'structured clone', 'spread copy', 'nested known aggregate', 'cause wrapper', 'typed primary lookalike']) {
  test(`${kind} cannot acquire owner interruption provenance`, async () => {
    const f = await reportedReplacementOwnerFixture(), primary = await trustedInterruption(f, 'cancelled'), cleanup = new Error(secret);
    const issued = await aggregate(primary, cleanup);
    const error = kind === 'lookalike' ? new AggregateError(issued.errors, issued.message)
      : kind === 'structured clone' ? structuredClone(issued)
        : kind === 'spread copy' ? Object.assign(new Error(issued.message), { ...issued, errors: issued.errors })
          : kind === 'nested known aggregate' ? await aggregate(issued, cleanup)
            : kind === 'cause wrapper' ? new Error('outer', { cause: issued })
              : await aggregate(Object.assign(new Error(primary.message), { code: primary.code, reason: primary.reason }), cleanup);
    const actual = await ownerInjected(f, error);
    assert.equal(actual, error); assert.equal(Object.hasOwn(actual, 'reason'), false);
    const response = await routeFailure(actual); assert.equal(response.status, 500); assert.deepEqual(response.body, FAILED);
    assert.deepEqual(response.logs, []);
  });
}

test('only exact owner-issued code/reason pairs normalize; altered typed metadata stays unclassified', async () => {
  for (const change of [primary => { primary.code = '57014'; }, primary => { primary.reason = 'policy_timeout'; }]) {
    const f = await reportedReplacementOwnerFixture(), primary = await trustedInterruption(f, 'cancelled'); change(primary);
    const error = await aggregate(primary, new Error(secret)), actual = await ownerInjected(f, error);
    assert.equal(actual, error); assert.equal(Object.hasOwn(actual, 'reason'), false);
    assert.equal((await routeFailure(actual)).status, 500);
  }
});

for (const [kind, code, status] of [['PG cancellation', '57014', 503], ['plain driver timeout', null, 500],
  ['socket failure', 'ECONNRESET', 500]]) {
  test(`${kind} before the aggregate deadline retains its original error and public status`, async () => {
    const f = await reportedReplacementOwnerFixture(), failure = Object.assign(new Error(secret), code ? { code } : {});
    let fired = false;
    f.state.afterQuery = text => { if (!fired && text.includes('neighborhood:caller-transaction')) { fired = true; throw failure; } };
    const actual = await rejected(() => f.service.prepareReportedObservations(f.input));
    assert.equal(actual, failure); assert.equal(cleanupFailure(actual), null); assertNoPublication(f);
    const response = await routeFailure(actual); assert.equal(response.status, status);
    assert.deepEqual(response.body, status === 503 ? INTERRUPTED : FAILED); assert.deepEqual(response.logs, []);
  });
}

test('raw SQL cancellation plus failed cleanup is not reclassified as an owner deadline', async () => {
  const f = await reportedReplacementOwnerFixture(), primary = Object.assign(new Error(secret), { code: '57014' });
  const cleanup = Object.assign(new Error(secret), { code: 'ECONNRESET' });
  const error = await aggregate(primary, cleanup), actual = await ownerInjected(f, error);
  assert.equal(actual, error); assert.equal(Object.hasOwn(actual, 'reason'), false);
  const response = await routeFailure(actual); assert.equal(response.status, 500); assert.deepEqual(response.body, FAILED);
  assert.deepEqual(response.logs, []);
});

for (const releaseFails of [false, true]) {
  test(`uncertain COMMIT remains409${releaseFails ? ' even when release also fails' : ''}`, async () => {
    const f = await reportedReplacementOwnerFixture(), failure = new Error(secret), releaseFailure = new Error('release');
    if (releaseFails) releaseHook(f, releaseFailure);
    f.state.beforeQuery = text => { if (f.state.phases === 2 && text === 'COMMIT') throw failure; };
    const actual = await rejected(() => f.service.prepareReportedObservations(f.input));
    assert.equal(actual, releaseFails ? releaseFailure : failure); assert.equal(actual.outcome_unknown, true);
    const response = await routeFailure(actual); assert.equal(response.status, 409); assert.deepEqual(response.body, UNKNOWN);
  });
}

test('direct owner deadline before a repository savepoint remains503 without an aggregate', async t => {
  const f = await reportedReplacementOwnerFixture(); let clock = 1000, fired = false;
  t.mock.method(performance, 'now', () => clock);
  f.state.beforeQuery = text => { if (!fired && text === 'SAVEPOINT neighborhood_repository_owner') { fired = true; clock += 60_000; } };
  const error = await rejected(() => f.service.prepareReportedObservations(f.input));
  assert.equal(error.reason, 'deadline_exceeded'); assert.equal(cleanupFailure(error), null); assertNoPublication(f);
  const response = await routeFailure(error); assert.equal(response.status, 503); assert.deepEqual(response.body, INTERRUPTED);
});

test('interruption diagnostics are fixed, code-qualified, proposal-only and never unwrap raw errors', () => {
  for (const reason of ['deadline_exceeded', 'cancelled']) {
    const error = Object.assign(new Error(secret), { code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason, detail: secret, cause: secret });
    assert.deepEqual(customCohortReadDiagnostic('reported-proposal', error),
      { action: 'reported-proposal', family: 'coordinator', check: reason });
    for (const action of ['capture', 'reported-apply', 'catalog', 'preview', 'members']) assert.equal(customCohortReadDiagnostic(action, error), null);
    assert.equal(customCohortReadDiagnostic('reported-proposal', Object.assign(new Error(secret), { reason })), null);
    error.outcome_unknown = true; assert.equal(customCohortReadDiagnostic('reported-proposal', error), null);
    assert.equal(customCohortReadDiagnostic('reported-proposal', new AggregateError([error], secret)), null);
  }
  assert.equal(customCohortReadDiagnostic('reported-proposal', Object.assign(new Error(secret),
    { code: 'CUSTOM_COHORT_CAPTURE_FAILED', reason: secret })), null);
});
