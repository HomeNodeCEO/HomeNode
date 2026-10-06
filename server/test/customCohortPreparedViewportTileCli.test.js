import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { customCohortCaptureJobPoolOptions }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';

// Exercise the real CLI body with synthetic ports, never a live connection or
// source. Strip only the exact reviewed imports; a new import fails this harness
// instead of acquiring access to a real driver, environment file or worker.
const script = (await readFile(new URL('../scripts/runCustomCohortPreparedViewportTiles.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n');
let body = script;
for (const statement of [
  "import 'dotenv/config';",
  "import pg from 'pg';",
  "import { runCustomCohortPreparedViewportTileJob } from '../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';",
  "import { customCohortCaptureJobPoolOptions }\n  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';",
]) {
  assert.equal(body.split(statement).length, 2, 'exact CLI import');
  body = body.replace(statement, '');
}
assert.doesNotMatch(body, /\bimport\s/);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const run = new AsyncFunction('pg', 'runCustomCohortPreparedViewportTileJob',
  'customCohortCaptureJobPoolOptions', 'process', 'console', body);

function fixture(databaseUrl, { env = {}, worker = async () => ({ status: 'complete', completed: 0 }) } = {}) {
  const state = { pools: [], calls: [], ended: 0, errors: [], logs: [], handler: null };
  const process = { env: { DATABASE_URL: databaseUrl, ...env }, exitCode: 0 };
  class Pool {
    constructor(options) { state.pools.push(options); }
    on(event, handler) { assert.equal(event, 'error'); state.handler = handler; }
    async end() { state.ended++; }
  }
  return { state, process, async execute() {
    await run({ Pool }, async (pool, options) => {
      assert.ok(pool instanceof Pool); state.calls.push(options); return worker(state);
    }, customCohortCaptureJobPoolOptions, process, {
      error: (...args) => state.errors.push(args), log: (...args) => state.logs.push(args),
    });
  } };
}

test('tile CLI verifies remote TLS before constructing its single-connection bounded pool', async () => {
  const f = fixture('postgresql://synthetic:PRIVATE-PASSWORD@database.internal/test?sslmode=require');
  await f.execute();
  assert.equal(f.state.pools.length, 1);
  const options = f.state.pools[0];
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(options.connectionString).search, '');
  assert.equal(options.max, 1);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.statement_timeout, 120000);
  assert.equal(options.application_name, 'homenode-custom-cohort-prepared-tiles');
  assert.deepEqual(f.state.calls, [{ maximumContexts: 10, maximumRuntimeMinutes: 80 }]);
  assert.equal(f.state.ended, 1);
  assert.equal(f.process.exitCode, 0);
});

test('tile CLI refuses insecure or driver-overriding remote URLs before pool or worker I/O', async () => {
  for (const query of ['sslmode=disable', 'ssl=false', 'sslmode=require&host=localhost',
    'sslmode=require&sslmode=require', 'connect_timeout=0']) {
    const f = fixture(`postgres://synthetic:PRIVATE-PASSWORD@database.internal/test?${query}`);
    await assert.rejects(f.execute(), { message: 'custom_cohort_job_database_configuration_invalid' });
    assert.equal(f.state.pools.length, 0); assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.errors.length, 0);
  }
});

test('tile CLI preserves loopback development and explicit bounded canary settings', async () => {
  const f = fixture('postgres://synthetic@localhost/test', {
    env: { NEIGHBORHOOD_TILE_MAX_CONTEXTS: '1', NEIGHBORHOOD_TILE_MAX_RUNTIME_MINUTES: '1' },
  });
  await f.execute();
  assert.equal(f.state.pools[0].ssl, false);
  assert.deepEqual(f.state.calls, [{ maximumContexts: 1, maximumRuntimeMinutes: 1 }]);
  assert.equal(f.state.ended, 1);
});

test('tile CLI owns idle pool errors without echoing raw driver data', async () => {
  const f = fixture('postgres://synthetic@database.internal/test', { worker: async state => {
    state.handler(new Error('PRIVATE-PASSWORD raw driver message'));
    return { status: 'complete', completed: 0 };
  } });
  await f.execute();
  assert.equal(f.process.exitCode, 1);
  assert.deepEqual(f.state.errors, [['[neighborhood-tiles] failed', 'database_connection_failed']]);
  assert.equal(f.state.ended, 1);
});

test('tile CLI closes its pool and emits only checked operational error codes', async () => {
  for (const [message, expected] of [
    ['PRIVATE-PASSWORD raw driver message', 'job_failed'],
    ['custom_cohort_prepared_tiles_time_budget_exceeded', 'custom_cohort_prepared_tiles_time_budget_exceeded'],
  ]) {
    const f = fixture('postgres://synthetic@database.internal/test', { worker: async () => {
      throw Object.assign(new Error(message), { code: 'PRIVATE-PASSWORD', name: 'PRIVATE-PASSWORD' });
    } });
    await f.execute();
    assert.equal(f.process.exitCode, 1);
    assert.deepEqual(f.state.errors, [['[neighborhood-tiles] failed', expected]]);
    assert.equal(f.state.ended, 1);
  }
});

test('tile CLI rejects malformed canary settings without invoking its worker', async () => {
  const f = fixture('postgres://synthetic@database.internal/test', {
    env: { NEIGHBORHOOD_TILE_MAX_CONTEXTS: '1;PRIVATE-PASSWORD' },
  });
  await f.execute();
  assert.equal(f.process.exitCode, 1);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.ended, 1);
  assert.deepEqual(f.state.errors, [['[neighborhood-tiles] failed', 'job_failed']]);
});
