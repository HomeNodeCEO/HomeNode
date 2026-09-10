import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { parseSalesRetentionAuditArgs as parse, salesRetentionAuditPoolOptions as poolOptions,
  runSalesRetentionAudit as run } from '../scripts/auditSalesRetention.js';

const DATE = '--as-of=2026-09-10';
const SECRET = 'postgresql://private-user:private-password@database.example/private-database';
const cli = new URL('../scripts/auditSalesRetention.js', import.meta.url);
function fixture() {
  const state = { envReads: 0, creates: [], audits: [], ends: 0, stdout: [], stderr: [] }, pool = new EventEmitter();
  pool.end = async () => { state.ends++; };
  const deps = {
    loadEnvironment: async () => { state.envReads++; return { DATABASE_URL: SECRET }; },
    createPool: async options => { state.creates.push(options); return pool; },
    audit: async (actual, options) => { assert.equal(actual, pool); state.audits.push(options); return { mode: 'review_only', count: '9007199254740993' }; },
    stdout: value => state.stdout.push(value), stderr: value => state.stderr.push(value),
  };
  return { state, pool, deps };
}

test('required as-of is calendar-checked; optional samples are explicit, canonical and bounded', () => {
  assert.deepEqual(parse([DATE]), { asOfDate: '2026-09-10', sampleLimit: 0 });
  for (const limit of [0, 1, 50]) {
    assert.deepEqual(parse([`--sample-limit=${limit}`, DATE]), { asOfDate: '2026-09-10', sampleLimit: limit });
  }
  assert.equal(parse(['--as-of=2024-02-29']).asOfDate, '2024-02-29');
  assert.equal(parse(['--as-of=0006-01-01']).asOfDate, '0006-01-01');
});

const malformed = [[], ['--sample-limit=1'], [DATE, DATE], [DATE, '--sample-limit=1', '--sample-limit=2'],
  ['--as-of=2026-02-29'], ['--as-of=2026-09-31'], ['--as-of=2026-13-01'], ['--as-of=2026-9-10'],
  ['--as-of=0005-12-31'], ['--as-of=0000-01-01'],
  ['--as-of=2026-09-10T00:00:00Z'], ['--as-of= 2026-09-10'], [DATE, '--sample-limit=-1'], [DATE, '--sample-limit=51'],
  [DATE, '--sample-limit=01'], [DATE, '--sample-limit=1.0'], [DATE, '--sample-limit=1e1'], [DATE, '--sample-limit='],
  [DATE, '--unknown=private-password'], ['--as-of', '2026-09-10'], [DATE, '--help'], [null], null];
for (const args of malformed) test(`invalid arguments reject before environment or connection: ${JSON.stringify(args)}`, async () => {
  const { state, deps } = fixture();
  assert.equal(await run(args, deps), 2);
  assert.equal(state.envReads, 0); assert.equal(state.creates.length, 0); assert.equal(state.audits.length, 0);
  assert.equal(state.stdout.length, 0); assert.match(state.stderr[0], /^sales_retention_audit_invalid_arguments\nUsage:/);
  assert.doesNotMatch(state.stderr.join(''), /private-password/);
});

test('JSON is emitted only after a successful audit and pool shutdown, preserving exact count strings', async () => {
  const { state, deps } = fixture();
  deps.stdout = value => { assert.equal(state.ends, 1); state.stdout.push(value); };
  assert.equal(await run([DATE, '--sample-limit=3'], deps), 0);
  assert.equal(state.envReads, 1); assert.equal(state.creates.length, 1); assert.equal(state.ends, 1);
  assert.deepEqual(state.audits, [{ asOfDate: '2026-09-10', sampleLimit: 3 }]);
  assert.deepEqual(JSON.parse(state.stdout[0]), { mode: 'review_only', count: '9007199254740993' });
  assert.deepEqual(state.stderr, []);
});

test('actual pg parameters retain verified TLS and finite limits despite legacy require URL syntax', () => {
  const options = poolOptions(`${SECRET}?sslmode=require`), params = new pg.Client(options).connectionParameters;
  assert.deepEqual(options.ssl, { rejectUnauthorized: true }); assert.deepEqual(params.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(options.connectionString).search, '');
  assert.equal(options.max, 1); assert.equal(options.connectionTimeoutMillis, 5_000);
  assert.equal(options.statement_timeout, 5_000); assert.equal(options.query_timeout, 6_000);
  assert.equal(options.idle_in_transaction_session_timeout, 10_000);
  for (const url of [SECRET, `${SECRET}?sslmode=verify-full`, `${SECRET}?ssl=true`, `${SECRET}?ssl=1`]) {
    assert.equal(new pg.Client(poolOptions(url)).connectionParameters.ssl.rejectUnauthorized, true);
  }
});

test('only literal loopback targets can omit TLS; requesting TLS still verifies the certificate', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `postgresql://tester@${host}/synthetic`;
    assert.equal(poolOptions(url).ssl, false); assert.equal(poolOptions(`${url}?sslmode=disable`).ssl, false);
    assert.equal(poolOptions(`${url}?sslmode=require`).ssl.rejectUnauthorized, true);
  }
});

test('unsafe or unsupported connection overrides are rejected without creating a pool or exposing configuration', async () => {
  for (const url of [undefined, '', 'not-a-url-private-password', `https://user:private-password@database.example/db`,
    `${SECRET}?sslmode=no-verify`, `${SECRET}?sslmode=disable`, `${SECRET}?ssl=false`, `${SECRET}?sslmode=prefer`,
    `${SECRET}?sslmode=require&sslmode=disable`, `${SECRET}?sslmode=require&ssl=0`, `${SECRET}?uselibpqcompat=true`,
    `${SECRET}?connectionTimeoutMillis=0`, `${SECRET}?sslrootcert=private-password`,
    'postgresql://user@localhost/db?host=database.example', `${SECRET}#private-password`]) {
    const { state, deps } = fixture(); deps.loadEnvironment = async () => ({ DATABASE_URL: url });
    assert.equal(await run([DATE], deps), 1); assert.equal(state.creates.length, 0); assert.equal(state.ends, 0);
    assert.deepEqual(state.stdout, []); assert.deepEqual(state.stderr, ['sales_retention_audit_failed\n']);
  }
});

for (const stage of ['environment', 'create', 'audit', 'close', 'idle', 'serialization']) test(`${stage} failure is secret-free and closes an acquired pool`, async () => {
  const { state, deps, pool } = fixture(), problem = () => { throw new Error(SECRET); };
  if (stage === 'environment') deps.loadEnvironment = problem;
  if (stage === 'create') deps.createPool = problem;
  if (stage === 'audit') deps.audit = problem;
  if (stage === 'close') pool.end = async () => { state.ends++; problem(); };
  if (stage === 'idle') deps.audit = async () => { pool.emit('error', new Error(SECRET)); return { count: 0 }; };
  if (stage === 'serialization') deps.audit = async () => ({ toJSON: problem });
  assert.equal(await run([DATE], deps), 1);
  assert.equal(state.ends, ['environment', 'create'].includes(stage) ? 0 : 1);
  assert.deepEqual(state.stdout, []); assert.deepEqual(state.stderr, ['sales_retention_audit_failed\n']);
});

test('import is inert and actual CLI entrypoint rejects malformed input with a finite nonzero exit', async () => {
  const invoke = promisify(execFile), options = { timeout: 3_000, windowsHide: true,
    env: { ...process.env, DATABASE_URL: SECRET } };
  const imported = await invoke(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(cli.href)}); process.stdout.write('import-safe\\n');`], options);
  assert.equal(imported.stdout, 'import-safe\n'); assert.equal(imported.stderr, '');
  await assert.rejects(invoke(process.execPath, [fileURLToPath(cli), '--unknown=private-password'], options), error => {
    assert.equal(error.code, 2); assert.equal(error.stdout, '');
    assert.match(error.stderr, /^sales_retention_audit_invalid_arguments\nUsage:/);
    assert.doesNotMatch(error.stderr, /private-password|database\.example/); return true;
  });
});
