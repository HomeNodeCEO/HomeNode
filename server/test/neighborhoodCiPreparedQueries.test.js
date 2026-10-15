import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { observeNeighborhoodCiPreparedQueries, NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT as LIMIT,
  NEIGHBORHOOD_CI_PROTOCOL_SESSION_OPTIONS as SESSION_OPTIONS }
  from './helpers/neighborhoodCiPreparedQueries.js';

function fixture(actual) {
  const pool = new EventEmitter(), observer = observeNeighborhoodCiPreparedQueries(pool), client = { query: actual };
  pool.emit('connect', client); return { pool, observer, client };
}

test('CI names reuse only exact SQL, not current values/results or authority', async () => {
  const calls = [], receivers = [], result = { rows: [{ value: 'current' }] };
  const { observer, client } = fixture(function (...args) { receivers.push(this); calls.push(args); return Promise.resolve(result); });
  const original = { text: 'SELECT $1::text AS value', values: ['first'], rowMode: 'array' };
  assert.equal(await client.query(original), result);
  const next = { ...original, values: ['revoked'] };
  assert.equal(await client.query(next), result);
  assert.equal(Object.hasOwn(original, 'name'), false); assert.equal(Object.hasOwn(next, 'name'), false);
  assert.equal(calls[0][0].name, calls[1][0].name); assert.equal(calls[1][0].values, next.values);
  assert.equal(calls[0][0].rowMode, 'array'); assert.ok(calls[0][0].name.length < 63);
  await client.query('SELECT $1::text AS other_value', ['first']);
  assert.notEqual(calls[2][0].name, calls[0][0].name); assert.deepEqual(calls[2][1], ['first']);
  assert.ok(receivers.every(value => value === client));
  assert.deepEqual(observer.snapshot(), { connections: 1, named_parameterized_calls: 3,
    repeated_parameterized_calls: 1, statement_texts: 2, ordinary_calls: 0,
    per_connection_statement_limit: LIMIT, parameters_or_results_cached: false,
    query_or_failure_skips: false, authority_or_commit_evidence: false, production_speed_acceptance: false });
});

test('CI execution preserves callbacks, synchronous errors, explicit names, custom objects and real transaction calls', () => {
  const calls = [], answer = {}, failure = new Error('actual native failure');
  const { client, observer } = fixture(function (...args) {
    calls.push(args); if (args[0]?.text === 'SELECT $1::text AS failure') throw failure;
    if (typeof args.at(-1) === 'function') args.at(-1).call(this, null, answer);
    return answer;
  });
  let callbackThis, callbackResult;
  const callback = function (error, result) { assert.equal(error, null); callbackThis = this; callbackResult = result; };
  const values = ['current']; assert.equal(client.query('SELECT $1::text', values, callback), answer);
  assert.equal(calls[0][1], values); assert.equal(calls[0][2], callback);
  assert.equal(callbackThis, client); assert.equal(callbackResult, answer);
  assert.deepEqual(observer.timings(), [], 'callback execution is not misreported as synchronous timing');
  assert.throws(() => client.query({ text: 'SELECT $1::text AS failure', values }), error => error === failure);
  assert.equal(calls.length, 2, 'failed query is neither skipped nor retried');
  const named = { text: 'SELECT $1::text', values, name: 'existing' }, custom = { text: 'SELECT $1::text', values, submit() {} };
  client.query(named);
  const beforeCustom = observer.timings();
  client.query(custom); assert.equal(calls[2][0], named); assert.equal(calls[3][0], custom);
  assert.deepEqual(observer.timings(), beforeCustom, 'custom query objects are not timed or replaced');
  for (const text of ['BEGIN ISOLATION LEVEL READ COMMITTED', 'COMMIT', 'ROLLBACK', 'SELECT 1']) {
    client.query(text); assert.equal(calls.at(-1)[0], text);
  }
});

test('CI statement plans stay connection-local and bounded, with ordinary execution after cap', () => {
  const calls = [], { pool, observer, client } = fixture((...args) => { calls.push(args); return args; });
  for (let index = 0; index <= LIMIT; index++) client.query(`SELECT $1::integer AS value_${index}`, [index]);
  assert.equal(typeof calls[LIMIT][0], 'string'); assert.equal(observer.snapshot().statement_texts, LIMIT);
  client.query('SELECT $1::integer AS value_0', [999]); assert.equal(calls.at(-1)[0].name, calls[0][0].name);
  const second = { query: (...args) => { calls.push(args); return args; } }; pool.emit('connect', second);
  second.query('SELECT $1::integer AS value_0', [123]); assert.notEqual(calls.at(-1)[0].name, calls[0][0].name);
  assert.equal(observer.snapshot().connections, 2); assert.equal(observer.snapshot().statement_texts, LIMIT + 1);
});

test('native graph fixture keeps deadlines, complete original probes and ninth recovery unchanged', () => {
  const source = readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js', import.meta.url), 'utf8');
  assert.match(source, /timeout:180_000/); assert.match(source, /statement_timeout:120_000/);
  assert.match(source, /const preparedCiQueries=observeNeighborhoodCiPreparedQueries\(pool\)/);
  for (const name of ['numericRefusals', 'stock_cells_mismatch', 'cad_original_text', 'tx_original_text',
    'numeric_orphan_commit', 'synthetic_numeric_reclaim', 'actual_ninth_ordinary_failure_and_fifth_claim_resume']) assert.ok(source.includes(name));
  assert.match(source, /repeat\(chr\(92\),480000\)/);
  assert.match(source, /\[native-original-protocol-prepared-CI-queries\]/);
});

test('CI timing preserves exact result/error identity without swallowing or retrying native failures', async () => {
  const answer = { rows: [{ original: 'not logged' }] }, success = Promise.resolve(answer), failure = new Error('actual COMMIT ACK lost');
  const rejected = Promise.reject(failure); let calls = 0;
  const { client, observer } = fixture(() => ++calls === 1 ? success : rejected);
  const actual = client.query('/* original-owner:read */ SELECT $1::text', ['private source value']);
  assert.equal(await actual, answer);
  const refused = client.query('/* original-owner:commit */ COMMIT');
  await assert.rejects(refused, error => error === failure);
  assert.equal(calls, 2);
  const times = observer.timings(); assert.ok(Object.isFrozen(times)); assert.equal(times.length, 2);
  assert.equal(times.find(entry => entry.family === 'original-owner:read').completed, 1);
  assert.equal(times.find(entry => entry.family === 'original-owner:commit').errors, 1);
  for (const entry of times) {
    assert.ok(Object.isFrozen(entry)); assert.ok(entry.total_ms >= 0 && entry.maximum_ms >= 0);
    assert.deepEqual(Object.keys(entry).sort(), ['family', 'completed', 'errors', 'total_ms', 'maximum_ms'].sort());
  }
  assert.doesNotMatch(JSON.stringify(times), /private source value|not logged|SELECT|COMMIT ACK/);
});

test('CI diagnostics do not hide an unawaited native rejection from the test process', () => {
  const helper = new URL('./helpers/neighborhoodCiPreparedQueries.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e',
    `import { EventEmitter } from 'node:events';
     import { observeNeighborhoodCiPreparedQueries } from ${JSON.stringify(helper)};
     const pool=new EventEmitter();observeNeighborhoodCiPreparedQueries(pool);
     const client={query(){return Promise.reject(new Error('unobserved_native_failure'));}};
     pool.emit('connect',client);client.query('SELECT $1::text',['fixture']);`],
  { encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.ifError(child.error); assert.notEqual(child.status, 0);
  assert.match(child.stderr, /unobserved_native_failure/);
});

test('CI timing families and reported output stay bounded without retaining SQL or parameters', () => {
  const { client, observer } = fixture(() => ({ rows: [] }));
  for (let index = 0; index < 1000; index++) client.query(`/* family:${index} */ SELECT $1::text`, [`secret-${index}`]);
  const times = observer.timings(); assert.equal(times.length, 12);
  assert.ok(times.some(entry => entry.family === 'other' && entry.completed === 872));
  assert.doesNotMatch(JSON.stringify(times), /secret-|SELECT|family:999/);
});

test('only disposable CI graph sessions use generic plans without JIT; budgets and source checks stay installed', () => {
  assert.equal(SESSION_OPTIONS, '-c jit=off -c plan_cache_mode=force_generic_plan');
  assert.doesNotMatch(SESSION_OPTIONS, /timeout|replication|constraint|trigger|role|authorization|row_security/);
  const source = readFileSync(new URL('./neighborhoodGroupIndex.integration.test.js', import.meta.url), 'utf8');
  assert.ok(source.includes('connectionString:target.connectionString,max:2,statement_timeout:120_000,options:NEIGHBORHOOD_CI_PROTOCOL_SESSION_OPTIONS'));
  assert.ok(source.includes("current_setting('jit') AS jit,current_setting('plan_cache_mode') AS plan_cache_mode"));
  assert.ok(source.includes("assert.deepEqual(protocolQueryOptions,{jit:'off',plan_cache_mode:'force_generic_plan'})"));
  assert.ok(source.includes('preparedCiQueries.timings()')); assert.ok(source.includes('production_speed_acceptance:false'));
});
