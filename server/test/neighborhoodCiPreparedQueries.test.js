import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { observeNeighborhoodCiPreparedQueries, NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT as LIMIT }
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
  const { client } = fixture(function (...args) {
    calls.push(args); if (args[0]?.text === 'SELECT $1::text AS failure') throw failure;
    if (typeof args.at(-1) === 'function') args.at(-1).call(this, null, answer);
    return answer;
  });
  let callbackThis, callbackResult;
  const callback = function (error, result) { assert.equal(error, null); callbackThis = this; callbackResult = result; };
  const values = ['current']; assert.equal(client.query('SELECT $1::text', values, callback), answer);
  assert.equal(calls[0][1], values); assert.equal(calls[0][2], callback);
  assert.equal(callbackThis, client); assert.equal(callbackResult, answer);
  assert.throws(() => client.query({ text: 'SELECT $1::text AS failure', values }), error => error === failure);
  assert.equal(calls.length, 2, 'failed query is neither skipped nor retried');
  const named = { text: 'SELECT $1::text', values, name: 'existing' }, custom = { text: 'SELECT $1::text', values, submit() {} };
  client.query(named); client.query(custom); assert.equal(calls[2][0], named); assert.equal(calls[3][0], custom);
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
