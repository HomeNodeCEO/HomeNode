import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withCustomCohortJobTransaction }
  from '../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

function fixture({ failAt, socketAt, rollbackError, releaseError } = {}) {
  const calls = [], releases = [], raw = new EventEmitter();
  const error = new Error('synthetic query failure'), socketError = new Error('synthetic socket failure');
  raw.query = async config => {
    calls.push(config);
    if (socketAt && config.text.startsWith(socketAt)) raw.emit('error', socketError);
    if (failAt && config.text.startsWith(failAt)) throw error;
    if (config.text === 'ROLLBACK' && rollbackError) throw rollbackError;
    return { rowCount: 1, rows: [{ synthetic: true }] };
  };
  raw.release = reason => { releases.push(reason); if (releaseError) throw releaseError; };
  return { calls, releases, raw, error, socketError, pool: { async connect() { return raw; } } };
}

test('job transaction delivers only committed results and applies bounded SQL/driver settings', async () => {
  const deps = fixture();
  const result = await withCustomCohortJobTransaction(deps.pool, async client => {
    assert.equal(Object.isFrozen(client), true);
    assert.deepEqual(Object.keys(client), ['query']);
    await client.query('SELECT $1::text', ['synthetic']);
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.deepEqual(deps.calls.map(config => config.text), ['BEGIN',
    "SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'",
    'SELECT $1::text', 'COMMIT']);
  assert.deepEqual(deps.calls[2].values, ['synthetic']);
  assert.ok(deps.calls.every(config => config.query_timeout === 6000));
  assert.deepEqual(deps.releases, [undefined]);
  assert.equal(deps.raw.listenerCount('error'), 0);
});

test('domain failure rolls back with a short cleanup deadline and releases once', async () => {
  const deps = fixture(), denial = new Error('synthetic denied');
  await assert.rejects(withCustomCohortJobTransaction(deps.pool, async () => { throw denial; }), denial);
  assert.equal(deps.calls.at(-1).text, 'ROLLBACK');
  assert.equal(deps.calls.at(-1).query_timeout, 1000);
  assert.ok(!deps.calls.some(config => config.text === 'COMMIT'));
  assert.deepEqual(deps.releases, [undefined]);
});

test('driver failures discard uncertain connections without claiming rollback or success', async () => {
  for (const failAt of ['BEGIN', 'SET LOCAL', 'SELECT synthetic', 'COMMIT']) {
    const deps = fixture({ failAt });
    await assert.rejects(withCustomCohortJobTransaction(deps.pool,
      client => client.query('SELECT synthetic')), error => error === deps.error
        && Boolean(error.outcome_unknown) === (failAt === 'COMMIT'));
    assert.equal(deps.calls.at(-1).text.startsWith(failAt), true);
    assert.ok(!deps.calls.some(config => config.text === 'ROLLBACK'));
    assert.deepEqual(deps.releases, [deps.error]);
    assert.equal(deps.raw.listenerCount('error'), 0);
  }
});

test('failed rollback discards the connection and preserves the original domain failure', async () => {
  const rollbackError = new Error('synthetic rollback failed'), denial = new Error('synthetic denied');
  const deps = fixture({ rollbackError });
  await assert.rejects(withCustomCohortJobTransaction(deps.pool, async () => { throw denial; }), denial);
  assert.deepEqual(deps.releases, [rollbackError]);
  assert.equal(deps.raw.listenerCount('error'), 0);
});

test('socket errors on checked-out clients are owned through release and prevent late SQL', async () => {
  for (const socketAt of ['BEGIN', 'SET LOCAL', 'SELECT synthetic', 'COMMIT']) {
    const deps = fixture({ socketAt });
    await assert.rejects(withCustomCohortJobTransaction(deps.pool,
      client => client.query('SELECT synthetic')), error => error === deps.socketError
        && Boolean(error.outcome_unknown) === (socketAt === 'COMMIT'));
    assert.equal(deps.calls.at(-1).text.startsWith(socketAt), true);
    assert.deepEqual(deps.releases, [deps.socketError]);
    assert.equal(deps.raw.listenerCount('error'), 0);
  }
});

test('post-commit release failure is an unknown outcome rather than a successful acknowledgment', async () => {
  const releaseError = new Error('synthetic release failed'), deps = fixture({ releaseError });
  await assert.rejects(withCustomCohortJobTransaction(deps.pool, async () => 'not acknowledged'),
    error => error === releaseError && error.outcome_unknown === true);
  assert.equal(deps.calls.at(-1).text, 'COMMIT');
  assert.deepEqual(deps.releases, [undefined]);
  assert.equal(deps.raw.listenerCount('error'), 0);
});

test('escaped job client cannot issue SQL after its transaction owner releases it', async () => {
  const deps = fixture(); let escaped;
  await withCustomCohortJobTransaction(deps.pool, async client => { escaped = client; });
  const count = deps.calls.length;
  await assert.rejects(escaped.query('SELECT after_release'), /job_transaction_closed/);
  assert.equal(deps.calls.length, count);
});

test('late checkout after connection timeout is discarded exactly once without SQL', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, settled = false;
  const deps = fixture();
  const pool = { connect: () => new Promise(resolve => { finish = resolve; }) };
  const pending = withCustomCohortJobTransaction(pool, () => assert.fail('must not run'));
  const rejected = assert.rejects(pending, /job_transaction_connect_timeout/);
  await Promise.resolve();
  t.mock.timers.tick(5001);
  await rejected;
  finish(deps.raw);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(deps.releases.length, 1);
  assert.match(deps.releases[0].message, /job_transaction_connect_timeout/);
  assert.deepEqual(deps.calls, []);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); assert.equal(settled, true);
});

test('invalid dependencies fail before checkout', async () => {
  let checkedOut = false;
  await assert.rejects(withCustomCohortJobTransaction({}, () => {}), /invalid_input/);
  await assert.rejects(withCustomCohortJobTransaction({ connect() { checkedOut = true; } }, null), /invalid_input/);
  assert.equal(checkedOut, false);
});
