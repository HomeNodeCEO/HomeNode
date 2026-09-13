import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createCustomCohortOwnerReplayTiming } from './helpers/customCohortOwnerReplayTiming.js';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

function fixture(options = {}) {
  let clock = 100;
  const calls = [], releases = [], result = Object.freeze({ rowCount: 3, rows: Object.freeze([{ secret: 'PRIVATE_RESULT' }]) });
  const client = new EventEmitter();
  client.query = function (...args) { assert.equal(this, client); calls.push(args); return Promise.resolve(result); };
  client.release = function (...args) { assert.equal(this, client); releases.push(args); };
  const pool = new EventEmitter();
  pool.connect = function () { assert.equal(this, pool); return Promise.resolve(client); };
  pool.query = function (...args) { assert.equal(this, pool); calls.push(args); return Promise.resolve(result); };
  const timing = createCustomCohortOwnerReplayTiming({ pool, now: () => clock++, ...options });
  return { timing, pool, client, calls, releases, result, advance: amount => { clock += amount; } };
}
const ownerInput = () => ({ auth: { userId: '80000000-0000-4000-8000-000000000001', organizations: [] },
  accountId: '00026355500170360000', assignmentFileId: '9007199254740993',
  operationId: '70000000-0000-4000-8000-000000000001',
  observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } });

test('query forwards exact frozen configuration, values, this, and result identity', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  const values = Object.freeze(['PRIVATE_PARAMETER']);
  const config = Object.freeze({ text: '/* custom-cohort-capture:time */ SELECT PRIVATE_SQL', values,
    name: 'PRIVATE_PREPARED_NAME', query_timeout: 50 });
  assert.equal(await client.query(config), f.result);
  assert.equal(f.calls[0][0], config); assert.equal(f.calls[0][0].values, values);
  const extracted = client.query;
  assert.equal(await extracted('SELECT PRIVATE_SQL', values), f.result);
  assert.equal(f.calls[1][1], values);
  const snapshot = f.timing.snapshot();
  assert.equal(snapshot.queries[0].label, 'custom-cohort-capture:time');
  assert.equal(snapshot.queries[0].rows, 3);
  assert.equal(snapshot.queries[1].label, 'other');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test('synchronous query throw stays synchronous and rejected error stays identical', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  const error = Object.assign(new Error('PRIVATE_ERROR'), { code: '57014', reason: 'deadline_exceeded' });
  f.client.query = function () { assert.equal(this, f.client); throw error; };
  assert.throws(() => client.query('SELECT secret'), actual => actual === error);
  f.client.query = () => Promise.reject(error);
  await assert.rejects(client.query('SELECT secret'), actual => actual === error);
  const snapshot = f.timing.snapshot();
  assert.equal(snapshot.counts.query_errors, 2);
  for (const event of snapshot.queries) {
    assert.equal(event.success, false);
    assert.deepEqual(event.error, { code: '57014', reason: 'deadline_exceeded' });
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_ERROR|secret/);
});

test('source/member INSERT string-parameter bytes are separate, exact and not retained', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  let getters = 0;
  const sourceValues = Object.freeze(['PRIVATE_SOURCE_\u00e9', 41, null, { toJSON() { throw new Error('must not serialize'); } }]);
  const memberValues = ['PRIVATE_MEMBER_\u4e2d\ud83d\ude00', false, Buffer.from('PRIVATE_BUFFER')];
  Object.defineProperty(memberValues, '3', { get() { getters += 1; return 'PRIVATE_GETTER'; } });
  Object.freeze(memberValues);
  const config = Object.freeze({ text: '/* neighborhood:source */ INSERT PRIVATE', values: sourceValues });
  await client.query(config);
  await client.query('/* neighborhood:members */ INSERT PRIVATE', memberValues);
  await client.query('/* neighborhood-cohort-blob:insert */ INSERT PRIVATE', sourceValues);
  const q = f.timing.snapshot().queries;
  assert.equal(q[0].label, 'neighborhood:source'); assert.equal(q[1].label, 'neighborhood:members');
  assert.equal(q[0].string_parameter_utf8_bytes, Buffer.byteLength(sourceValues[0], 'utf8'));
  assert.equal(q[1].string_parameter_utf8_bytes, Buffer.byteLength(memberValues[0], 'utf8'));
  assert.equal(q[2].string_parameter_utf8_bytes, null);
  assert.equal(f.calls[0][0], config); assert.equal(f.calls[1][1], memberValues);
  assert.equal(getters, 0);
  assert.doesNotMatch(JSON.stringify(f.timing.snapshot()), /PRIVATE/);
});

test('fixed source/report policy SQL labels identify separate query wall times', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  const labels = ['custom-neighborhood-source-policy:organization',
    'custom-neighborhood-report-observation-policy:organization'];
  for (const label of labels) {
    await client.query(`/* ${label} */ SELECT PRIVATE_POLICY_SQL`, ['PRIVATE_ORGANIZATION']);
  }
  const snapshot = f.timing.snapshot();
  assert.deepEqual(snapshot.queries.map(event => event.label), labels);
  assert.ok(snapshot.queries.every(event => event.wall_ms === 1 && event.success === true
    && event.string_parameter_utf8_bytes === null));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test('callback query preserves arguments, callback this, result/error and driver return', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  const config = Object.freeze({ text: '/* neighborhood:members */ INSERT PRIVATE' });
  const values = Object.freeze(['PRIVATE']), token = {}, callbackThis = {};
  f.client.query = function (...args) {
    assert.equal(this, f.client); assert.equal(args[0], config); assert.equal(args[1], values);
    assert.equal(args[2].call(callbackThis, null, f.result, token), 'callback-return');
    return token;
  };
  let callbacks = 0;
  assert.equal(client.query(config, values, function (error, result, extra) {
    callbacks += 1; assert.equal(this, callbackThis); assert.equal(error, null);
    assert.equal(result, f.result); assert.equal(extra, token); return 'callback-return';
  }), token);
  const error = new Error('PRIVATE');
  f.client.query = function (actualConfig, callback) { assert.equal(actualConfig, config); callback(error); return token; };
  assert.equal(client.query(config, actual => { callbacks += 1; assert.equal(actual, error); }), token);
  assert.equal(callbacks, 2);
  assert.equal(f.timing.snapshot().counts.query_completions, 2);
  assert.equal(f.timing.snapshot().counts.query_errors, 1);
});

test('callback exceptions are not swallowed or reclassified as query failures', async () => {
  const f = fixture(), client = await f.timing.pool.connect(), sentinel = new Error('callback');
  f.client.query = (sql, callback) => callback(null, f.result);
  assert.throws(() => client.query('SELECT 1', () => { throw sentinel; }), error => error === sentinel);
  assert.equal(f.timing.snapshot().queries[0].success, true);
  assert.equal(f.timing.snapshot().counts.query_errors, 0);
});

test('callback argument arity is preserved when no result is supplied', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  f.client.query = (sql, callback) => callback(null);
  let called = false;
  client.query('SELECT 1', function () { called = true; assert.equal(arguments.length, 1); });
  assert.equal(called, true);
});

test('async callbacks and callback connect retain ownership, release and identities', async () => {
  const f = fixture(), token = {}, callbackThis = {}, release = () => 'release';
  f.pool.connect = function (callback) {
    assert.equal(this, f.pool);
    queueMicrotask(() => callback.call(callbackThis, null, f.client, release));
    return token;
  };
  let observed;
  await new Promise((resolve, reject) => {
    const returned = f.timing.pool.connect(function (error, client, done) {
      try {
        assert.equal(this, callbackThis); assert.equal(error, null); assert.equal(done, release);
        observed = client; assert.notEqual(client, f.client); resolve();
      } catch (failure) { reject(failure); }
    });
    assert.equal(returned, token);
  });
  f.client.query = function (config, callback) { queueMicrotask(() => callback(null, f.result)); return token; };
  await new Promise((resolve, reject) => {
    assert.equal(observed.query(Object.freeze({ text: 'SELECT 1' }), (error, result) => {
      try { assert.equal(error, null); assert.equal(result, f.result); resolve(); } catch (failure) { reject(failure); }
    }), token);
  });
  assert.equal(f.timing.snapshot().counts.query_completions, 1);
});

test('connect synchronous and Promise errors pass through without a client or release', async () => {
  const f = fixture(), error = Object.assign(new Error('PRIVATE_CONNECT'), { code: 'ECONNREFUSED' });
  f.pool.connect = () => { throw error; };
  assert.throws(() => f.timing.pool.connect(), actual => actual === error);
  f.pool.connect = () => Promise.reject(error);
  await assert.rejects(f.timing.pool.connect(), actual => actual === error);
  f.pool.connect = callback => callback(error);
  let called = false;
  f.timing.pool.connect(actual => { called = true; assert.equal(actual, error); });
  assert.equal(called, true);
  const snapshot = f.timing.snapshot();
  assert.equal(snapshot.counts.connection_errors, 3);
  assert.equal(snapshot.counts.clients, 0); assert.equal(snapshot.counts.releases, 0);
});

test('late awaited connections remain releasable exactly once, including discard identity', async () => {
  const f = fixture(), error = new Error('PRIVATE_DISCARD');
  let resolve;
  f.pool.connect = () => new Promise(done => { resolve = done; });
  const pending = f.timing.pool.connect();
  assert.equal(f.timing.snapshot().connections[0].end_ms, null);
  resolve(f.client);
  const client = await pending;
  client.release(error);
  assert.deepEqual(f.releases, [[error]]);
  assert.equal(f.timing.snapshot().releases[0].discard, true);
  assert.doesNotMatch(JSON.stringify(f.timing.snapshot()), /PRIVATE_DISCARD/);
});

test('client and pool listeners delegate without observer listeners or removal', async () => {
  const f = fixture(), existing = () => {}, owner = function (error) {
    assert.equal(this, f.client); assert.equal(error, sentinel);
  }, sentinel = new Error('driver-event');
  f.client.on('error', existing);
  const client = await f.timing.pool.connect();
  assert.equal(client.on('error', owner), client);
  assert.deepEqual(f.client.listeners('error'), [existing, owner]);
  assert.equal(client.listenerCount('error'), 2);
  client.emit('error', sentinel);
  assert.equal(client.off('error', owner), client);
  assert.deepEqual(f.client.listeners('error'), [existing]);
  assert.equal(f.timing.pool.on('connect', existing), f.timing.pool);
  assert.equal(f.pool.listenerCount('connect'), 1);
  f.timing.pool.off('connect', existing);
  client.off('error', existing);
  assert.throws(() => client.emit('error', sentinel), error => error === sentinel);
});

test('release forwards return/exception and refreshes driver method after checkout', async () => {
  const f = fixture(), client = await f.timing.pool.connect(), token = {}, error = new Error('release');
  f.client.release = function (actual) { assert.equal(this, f.client); assert.equal(actual, error); return token; };
  assert.equal(client.release(error), token);
  f.client.release = function () { assert.equal(this, f.client); throw error; };
  const again = await f.timing.pool.connect();
  assert.equal(again, client);
  assert.throws(() => again.release(), actual => actual === error);
  assert.equal(f.timing.snapshot().counts.clients, 1);
  assert.equal(f.timing.snapshot().counts.releases, 2);
  assert.equal(f.timing.snapshot().counts.release_errors, 1);
});

test('real owner owns socket errors and removes only its own listener on release', async () => {
  const f = fixture(), sentinel = new Error('PRIVATE_SOCKET'), preexisting = () => {};
  f.client.on('error', preexisting);
  f.client.query = function ({ text }) {
    assert.equal(this, f.client);
    if (text.startsWith('SET LOCAL')) f.client.emit('error', sentinel);
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  const owner = createCustomCohortContextCapture({ pool: f.timing.pool,
    authorizeMarketData: f.timing.wrapPolicy('authorizeMarketData', () => assert.fail('must not authorize')) });
  await assert.rejects(owner.capture(ownerInput()), actual => actual === sentinel);
  assert.deepEqual(f.releases, [[sentinel]]);
  assert.deepEqual(f.client.listeners('error'), [preexisting]);
  assert.deepEqual(f.timing.snapshot().queries.map(event => event.label), ['begin', 'set']);
  assert.equal(f.timing.snapshot().counts.releases, 1);
});

test('real owner connect failure is still original and never acquires cleanup ownership', async () => {
  const f = fixture(), sentinel = new Error('connect');
  f.pool.connect = () => Promise.reject(sentinel);
  const owner = createCustomCohortContextCapture({ pool: f.timing.pool, authorizeMarketData: () => assert.fail('policy') });
  await assert.rejects(owner.capture(ownerInput()), actual => actual === sentinel);
  assert.deepEqual(f.releases, []);
  assert.equal(f.timing.snapshot().counts.clients, 0);
});

test('real owner awaiting a synchronous driver throw retains that exact cleanup error', async () => {
  for (const failureAt of ['BEGIN', 'SET LOCAL']) {
    const f = fixture(), sentinel = new Error('PRIVATE_SYNCHRONOUS_DRIVER');
    f.client.query = function ({ text }) {
      assert.equal(this, f.client);
      if (text.startsWith(failureAt)) throw sentinel;
      return Promise.resolve({ rows: [], rowCount: 0 });
    };
    const owner = createCustomCohortContextCapture({ pool: f.timing.pool, authorizeMarketData: () => assert.fail('policy') });
    await assert.rejects(owner.capture(ownerInput()), actual => actual === sentinel);
    assert.deepEqual(f.releases, [[sentinel]]);
    assert.equal(f.client.listenerCount('error'), 0);
    assert.equal(f.timing.snapshot().counts.query_errors, 1);
  }
});

test('policy wrappers call the real policy with exact this/args and preserve all outcomes', async () => {
  const f = fixture(), context = {}, args = [{ secret: 'PRIVATE_AUTH' }, Object.freeze({ decision_id: 'PRIVATE_ID' })];
  const decision = Object.freeze({ allowed: false, decision_id: 'PRIVATE_POLICY' });
  const sync = f.timing.wrapPolicy('authorizeMarketData', function (...actual) {
    assert.equal(this, context); assert.equal(actual[0], args[0]); assert.equal(actual[1], args[1]); return decision;
  });
  assert.equal(sync.call(context, ...args), decision);
  assert.equal(await f.timing.wrapPolicy('authorizePrivateSales', async () => decision)(), decision);
  const error = Object.assign(new Error('PRIVATE_POLICY_FAILURE'), { reason: 'market_data_access_denied' });
  assert.throws(() => f.timing.wrapPolicy('authorizeReportedObservations', () => { throw error; })(), actual => actual === error);
  await assert.rejects(f.timing.wrapPolicy('authorizeMarketData', () => Promise.reject(error))(), actual => actual === error);
  const snapshot = f.timing.snapshot();
  assert.equal(snapshot.counts.policies, 4); assert.equal(snapshot.counts.policy_errors, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|allowed|decision_id/);
});

test('phases and transaction attempts carry only explicit boundaries, not inferred function stages', async () => {
  const f = fixture();
  assert.equal(f.timing.begin('blank_cardinals'), 1);
  const client = await f.timing.pool.connect();
  for (const sql of ['BEGIN ISOLATION LEVEL READ COMMITTED', "SET LOCAL timezone='UTC'",
    '/* custom-cohort-context:read */ SELECT 1', 'COMMIT']) await client.query(sql);
  f.advance(200);
  for (const sql of ['BEGIN', 'SAVEPOINT neighborhood_repository_owner',
    '/* neighborhood:exact-claim */ UPDATE secret', 'RELEASE SAVEPOINT neighborhood_repository_owner']) await client.query(sql);
  f.advance(400);
  for (const sql of ['SAVEPOINT secret', 'ROLLBACK TO SAVEPOINT secret', 'RELEASE SAVEPOINT secret', 'COMMIT']) await client.query(sql);
  client.release(); f.timing.end('blank_cardinals');
  f.timing.begin('committed_retry');
  await f.timing.pool.query('SELECT secret'); f.timing.end('committed_retry');
  const snapshot = f.timing.snapshot(), q = snapshot.queries;
  assert.deepEqual(q.slice(0, 4).map(event => event.transaction_ordinal), [1, 1, 1, 1]);
  assert.ok(q.slice(4, 12).every(event => event.transaction_ordinal === 2));
  assert.equal(q[12].transaction_ordinal, 0); assert.equal(q[12].client_ordinal, 0);
  assert.equal(q[12].phase, 'committed_retry'); assert.equal(q[12].phase_ordinal, 2);
  assert.ok(q[4].start_ms - q[3].end_ms >= 200);
  assert.ok(q[8].start_ms - q[7].end_ms >= 400);
  assert.equal(snapshot.counts.transactions, 2); assert.equal(snapshot.counts.commits, 2);
  assert.equal(snapshot.counts.rollbacks, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /builder|publication_gap|secret|neighborhood_repository_owner/);
});

test('failed COMMIT retains local transaction until rollback; release ends attribution', async () => {
  const f = fixture(), client = await f.timing.pool.connect(), sentinel = new Error('uncertain');
  await client.query('BEGIN');
  f.client.query = () => Promise.reject(sentinel);
  await assert.rejects(client.query('COMMIT'), error => error === sentinel);
  f.client.query = () => Promise.resolve(f.result);
  await client.query('ROLLBACK');
  await client.query('SELECT 1'); client.release();
  assert.deepEqual(f.timing.snapshot().queries.map(event => event.transaction_ordinal), [1, 1, 1, 0]);
  assert.equal(f.timing.snapshot().counts.commits, 0); assert.equal(f.timing.snapshot().counts.rollbacks, 1);
});

test('unknown/dynamic tags and error fields cannot leak, and metadata getters are never called', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  let getters = 0;
  const config = Object.freeze({ get text() { getters += 1; return 'PRIVATE_SQL'; } });
  const result = Object.freeze({ get rowCount() { getters += 1; return 55; }, rows: ['PRIVATE_ROWS'] });
  f.client.query = actual => { assert.equal(actual, config); return Promise.resolve(result); };
  assert.equal(await client.query(config), result);
  const error = Object.assign(new Error('PRIVATE'), { code: 'PRIVATE_CODE', reason: 'PRIVATE_REASON', detail: 'PRIVATE_DETAIL' });
  f.client.query = () => Promise.reject(error);
  await assert.rejects(client.query('/* custom-cohort-capture:time-PRIVATE_ID */ SELECT 1'), actual => actual === error);
  const accessorError = { get code() { getters += 1; return '23505'; }, get reason() { getters += 1; return 'cancelled'; } };
  f.client.query = () => { throw accessorError; };
  assert.throws(() => client.query('/* neighborhood-cache:accounts-PRIVATE_ID */ SELECT 1'), actual => actual === accessorError);
  assert.equal(getters, 0);
  const snapshot = f.timing.snapshot();
  assert.ok(snapshot.queries.every(event => event.label === 'other'));
  assert.equal(snapshot.queries[0].rows, null);
  assert.deepEqual(snapshot.queries[1].error, { code: 'other', reason: 'other' });
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|SELECT/);
});

test('recording caps bound all event arrays without suppressing queries/policies/releases', async () => {
  const f = fixture({ maximumQueries: 2 });
  for (let index = 0; index < 5; index += 1) {
    const client = await f.timing.pool.connect();
    await client.query('SELECT 1');
    f.timing.wrapPolicy('authorizeMarketData', () => false)();
    client.release();
  }
  const snapshot = f.timing.snapshot();
  assert.equal(f.calls.length, 5); assert.equal(f.releases.length, 5);
  for (const kind of ['queries', 'connections', 'policies', 'releases']) {
    assert.equal(snapshot[kind].length, 2); assert.equal(snapshot.counts[kind], 5);
    assert.equal(snapshot.counts[`dropped_${kind}`], 3);
  }
});

test('snapshots are detached deeply frozen records, including pending queries', async () => {
  const f = fixture(), client = await f.timing.pool.connect();
  let resolve;
  f.client.query = () => new Promise(done => { resolve = done; });
  f.timing.begin('setup');
  const pending = client.query('SELECT 1'), before = f.timing.snapshot();
  assert.ok(Object.isFrozen(before) && Object.isFrozen(before.queries) && Object.isFrozen(before.queries[0]));
  assert.throws(() => { before.queries[0].start_ms = -10; }, TypeError);
  f.timing.end('setup'); resolve(f.result);
  assert.equal(await pending, f.result);
  assert.equal(before.queries[0].end_ms, null); assert.equal(before.phases[0].end_ms, null);
  const after = f.timing.snapshot();
  assert.equal(after.queries[0].phase, 'setup'); assert.ok(after.queries[0].end_ms > after.queries[0].start_ms);
  assert.ok(after.phases[0].end_ms > after.phases[0].start_ms);
});

test('invalid labels/options fail before work and clock failures cannot replace owner outcomes', async () => {
  const f = fixture();
  for (const maximumQueries of [-1, 1.1, 100001, Infinity]) {
    assert.throws(() => createCustomCohortOwnerReplayTiming({ pool: f.pool, maximumQueries }), /invalid_options/);
  }
  assert.throws(() => f.timing.begin('PRIVATE'), /invalid_phase_begin/);
  assert.throws(() => f.timing.end('setup'), /invalid_phase_end/);
  assert.throws(() => f.timing.wrapPolicy('PRIVATE', () => true), /invalid_policy/);
  f.timing.begin('complete_cardinals');
  assert.throws(() => f.timing.begin('setup'), /invalid_phase_begin/);
  assert.throws(() => f.timing.end('blank_cardinals'), /invalid_phase_end/);
  f.timing.end('complete_cardinals');
  const broken = fixture({ now: () => { throw new Error('PRIVATE_CLOCK'); } });
  const client = await broken.timing.pool.connect();
  assert.equal(await client.query('SELECT 1'), broken.result);
  const snapshot = broken.timing.snapshot();
  assert.ok(snapshot.counts.clock_errors >= 4);
  assert.equal(snapshot.queries[0].wall_ms, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_CLOCK/);
});
