import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import test from 'node:test';
import { neighborhoodSnapshotCiPlan, runNeighborhoodSnapshotCi, executeNeighborhoodSnapshotCi } from '../scripts/runNeighborhoodSnapshotCi.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL } from './helpers/neighborhoodCiDatabase.js';

// Pure synthetic plans and injected I/O only. Never alter process.env, spoof the
// host's CI identity, import pg, spawn a process or connect to any database.
const NONCE = '11111111-2222-4333-8444-555555555555';
const NAME = 'neighborhood_snapshot_11111111222243338444555555555555_test';
const env = () => ({ CI: 'true', GITHUB_ACTIONS: 'true', NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://fixture_user:fixture_secret@127.0.0.1:5432/parent_test',
  PATH: 'synthetic-path', GITHUB_RUN_ID: '123', ORDINARY_CONTEXT: 'keep' });
const tap = '# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const summary = () => ({ database: NAME, tests: 9, passed: 9 });
const clean = () => neighborhoodSnapshotCiPlan(env(), NONCE).bootstrapEnv;

test('plan uses one fresh prefixed UUID database on exactly the provided loopback service', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    const input = { ...env(), DATABASE_URL: 'postgresql://fixture_user:fixture_secret@' + host + ':55432/parent_test' };
    const plan = neighborhoodSnapshotCiPlan(input, NONCE);
    assert.equal(plan.child.databaseName, NAME);
    assert.ok(Buffer.byteLength(NAME) < 63);
    const parent = new URL(plan.parent.connectionString), child = new URL(plan.child.connectionString);
    for (const key of ['protocol', 'hostname', 'port', 'username', 'password']) assert.equal(child[key], parent[key]);
    assert.equal(child.pathname, '/' + NAME);
    assert.equal(plan.bootstrapEnv.DATABASE_URL, input.DATABASE_URL);
    assert.equal(plan.testEnv.DATABASE_URL, child.href);
    assert.equal(plan.testEnv.NEIGHBORHOOD_SNAPSHOT_DATABASE_URL, child.href);
    assert.equal(plan.bootstrapEnv.CI, 'true'); assert.equal(plan.bootstrapEnv.GITHUB_ACTIONS, 'true');
    assert.equal(plan.bootstrapEnv.GITHUB_RUN_ID, '123');
  }
});

test('plan removes PG, DOTENV, every NODE_* and case-variant URL override without mutating input', () => {
  const input = { ...env(), PGHOST: 'foreign', pguser: 'foreign', PGSERVICE: 'foreign', PGSERVICEFILE: 'foreign',
    PGPASSFILE: 'foreign', PGOPTIONS: 'foreign', DOTENV_CONFIG_PATH: 'foreign', dotenv_config_override: 'true',
    NODE_OPTIONS: '--import=foreign', NODE_PATH: 'foreign', NODE_EXTRA_CA_CERTS: 'foreign', NODE_TEST_CONTEXT: 'foreign',
    node_env: 'production', database_url: 'foreign', neighborhood_snapshot_database_url: 'foreign',
    NEIGHBORHOOD_SNAPSHOT_DATABASE_URL: 'foreign' };
  const original = structuredClone(input), plan = neighborhoodSnapshotCiPlan(input, NONCE);
  assert.deepEqual(input, original);
  for (const output of [plan.bootstrapEnv, plan.testEnv]) {
    for (const key of Object.keys(input)) {
      if (/^(PG|DOTENV|NODE_|database_url$|neighborhood_snapshot_database_url$)/i.test(key)
        && !['DATABASE_URL', 'NODE_ENV', 'DOTENV_CONFIG_PATH', 'NEIGHBORHOOD_SNAPSHOT_DATABASE_URL'].includes(key)) {
        assert.equal(Object.hasOwn(output, key), false, key);
      }
    }
    assert.equal(output.NODE_ENV, 'test');
    assert.equal(output.DOTENV_CONFIG_PATH, devNull); assert.equal(output.DOTENV_CONFIG_QUIET, 'true');
    assert.equal(output.PATH, 'synthetic-path'); assert.equal(output.ORDINARY_CONTEXT, 'keep');
  }
  assert.equal(Object.hasOwn(plan.bootstrapEnv, 'NEIGHBORHOOD_SNAPSHOT_DATABASE_URL'), false);
});

test('CI, mode, URL and generated-name guards reject before child execution or driver import', async () => {
  const bad = [
    { CI: undefined }, { CI: '1' }, { GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: 'false' },
    { NODE_ENV: 'production' }, { DATABASE_URL: undefined },
    { DATABASE_URL: 'postgresql://fixture_secret@remote.invalid/parent_test' },
    { DATABASE_URL: 'postgresql://fixture_secret@127.0.0.1/production' },
    { DATABASE_URL: 'postgresql://fixture_secret@127.0.0.1/parent_test?host=remote.invalid' },
    { DATABASE_URL: 'postgresql://fixture_secret@127.0.0.1/parent_test#override' },
    { DATABASE_URL: 'postgresql://fixture_secret@127.0.0.1/' + NAME },
  ];
  for (const change of bad) {
    let calls = 0;
    await assert.rejects(runNeighborhoodSnapshotCi({ ...env(), ...change }, { nonce: NONCE,
      executeFile: async () => { calls++; assert.fail('Must not execute'); } }), error => {
      assert.doesNotMatch(error.message, /fixture_secret|remote\.invalid|postgresql:\/\//); return true;
    });
    await assert.rejects(executeNeighborhoodSnapshotCi({ ...env(), ...change }, NONCE, {
      loadPg: async () => { calls++; assert.fail('Must not import driver'); },
    }));
    assert.equal(calls, 0);
  }
  for (const nonce of ['bad', NONCE.toUpperCase().replace('1111', 'ABCD'), NONCE + '"; DROP DATABASE x;--', null]) {
    assert.throws(() => neighborhoodSnapshotCiPlan(env(), nonce), /nonce/);
  }
});

test('launcher uses the absolute Node executable with a clean worker environment and bounded output', async () => {
  let calls = 0;
  const input = { ...env(), NODE_OPTIONS: '--require=foreign', PGHOST: 'foreign' };
  const result = await runNeighborhoodSnapshotCi(input, { nonce: NONCE, executeFile: async (exe, args, options) => {
    calls++;
    assert.equal(exe, process.execPath); assert.match(args[0], /scripts[\\/]runNeighborhoodSnapshotCi\.js$/);
    assert.deepEqual(args.slice(1), ['--isolated', NONCE]);
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 90_000); assert.equal(options.maxBuffer, 2_000_000);
    assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(options.env, 'PGHOST'), false);
    assert.equal(options.env.DATABASE_URL, env().DATABASE_URL);
    return { stdout: JSON.stringify(summary()) };
  } });
  assert.deepEqual(result, summary()); assert.equal(calls, 1);
});

function worker({ failAt, identity, remoteAddress = '127.0.0.1', stdout = tap, failClose = false } = {}) {
  const calls = [], testCalls = [], imports = [];
  const sensitive = () => new Error('fixture_secret postgresql://private.invalid/private sensitive-output');
  class Client {
    constructor(config) {
      calls.push(['constructor', config]);
      this.connection = { stream: { remoteAddress } };
      if (failAt === 'constructor') throw sensitive();
    }
    async connect() { calls.push(['connect']); if (failAt === 'connection') throw sensitive(); }
    async query(sql) {
      calls.push(['query', sql]);
      if (sql === NEIGHBORHOOD_CI_IDENTITY_SQL) {
        if (failAt === 'identity') throw sensitive();
        return { rows: [identity ?? { database_name: 'parent_test', server_address: '172.18.0.2' }] };
      }
      assert.equal(sql, 'CREATE DATABASE "' + NAME + '" TEMPLATE template0');
      if (failAt === 'creation') throw sensitive();
      return { rows: [] };
    }
    async end() { calls.push(['end']); if (failClose) throw sensitive(); }
  }
  return { calls, testCalls, imports, io: {
    loadPg: async () => { imports.push(true); if (failAt === 'import') throw sensitive(); return { default: { Client } }; },
    executeFile: async (...args) => { testCalls.push(args); if (failAt === 'native') throw sensitive(); return { stdout }; },
  } };
}

test('worker verifies parent socket/server identity before CREATE, closes bootstrap, then runs the exact native test', async () => {
  const fake = worker();
  const result = await executeNeighborhoodSnapshotCi(clean(), NONCE, fake.io);
  assert.deepEqual(result, summary());
  assert.deepEqual(fake.calls.map(call => call[0]), ['constructor', 'connect', 'query', 'query', 'end']);
  assert.equal(fake.calls[0][1].connectionString, env().DATABASE_URL);
  assert.equal(fake.calls[0][1].connectionTimeoutMillis, 3000);
  assert.equal(fake.calls[2][1], NEIGHBORHOOD_CI_IDENTITY_SQL);
  assert.equal(fake.testCalls.length, 1);
  const [exe, args, options] = fake.testCalls[0];
  assert.equal(exe, process.execPath);
  assert.deepEqual(args.slice(0, 2), ['--test', '--test-reporter=tap']);
  assert.match(args[2], /test[\\/]neighborhoodCachedSourceReaderSnapshot\.integration\.test\.js$/);
  assert.equal(options.env.NEIGHBORHOOD_SNAPSHOT_DATABASE_URL, options.env.DATABASE_URL);
  assert.equal(new URL(options.env.DATABASE_URL).pathname, '/' + NAME);
  assert.equal(options.env.NODE_ENV, 'test');
  assert.equal(options.shell, false); assert.equal(options.timeout, 75_000);
  assert.doesNotMatch(fake.calls.filter(call => call[0] === 'query').map(call => call[1]).join('\n'), /\bDROP\b|IF NOT EXISTS/i);
});

test('worker refuses inherited overrides even when directly invoked, before driver loading', async () => {
  for (const overrides of [{ PGHOST: 'foreign' }, { node_options: '--import=foreign' },
    { DOTENV_CONFIG_PATH: 'foreign' }, { NEIGHBORHOOD_SNAPSHOT_DATABASE_URL: 'foreign' }]) {
    const fake = worker();
    await assert.rejects(executeNeighborhoodSnapshotCi({ ...clean(), ...overrides }, NONCE, fake.io), /sanitized/);
    assert.equal(fake.imports.length, 0);
  }
});

test('foreign server/socket or wrong database identity refuses CREATE and native execution', async () => {
  for (const input of [
    { remoteAddress: '10.0.0.5' },
    { identity: { database_name: 'other_test', server_address: '127.0.0.1' } },
    { identity: { database_name: 'parent_test', server_address: '8.8.8.8' } },
  ]) {
    const fake = worker(input);
    await assert.rejects(executeNeighborhoodSnapshotCi(clean(), NONCE, fake.io), /identity failed/);
    assert.equal(fake.calls.filter(call => call[0] === 'query').length, 1);
    assert.equal(fake.calls.at(-1)[0], 'end');
    assert.equal(fake.testCalls.length, 0);
  }
});

test('all bootstrap/native errors are redacted without fallback, retries or DROP', async () => {
  for (const failAt of ['import', 'constructor', 'connection', 'identity', 'creation', 'native']) {
    const fake = worker({ failAt });
    await assert.rejects(executeNeighborhoodSnapshotCi(clean(), NONCE, fake.io), error => {
      assert.match(error.message, /details suppressed/);
      assert.doesNotMatch(error.message, /fixture_secret|private\.invalid|sensitive-output/); return true;
    });
    assert.equal(fake.imports.length, 1);
    assert.ok(fake.calls.filter(call => call[0] === 'query' && call[1].startsWith('CREATE DATABASE')).length <= 1);
    assert.equal(fake.testCalls.length, failAt === 'native' ? 1 : 0);
  }
  const close = worker({ failClose: true });
  await assert.rejects(executeNeighborhoodSnapshotCi(clean(), NONCE, close.io), /connection close failed/);
  assert.equal(close.testCalls.length, 0);
});

test('exit-zero native runs still fail for skipped, zero, missing or inconsistent test summaries', async () => {
  for (const stdout of ['', tap.replace('# tests 9', '# tests 0'), tap.replace('# skipped 0', '# skipped 1'),
    tap.replace('# pass 9', '# pass 8'), tap.replace('# todo 0', '# todo 1'), tap + '# tests 9\n']) {
    const fake = worker({ stdout });
    await assert.rejects(executeNeighborhoodSnapshotCi(clean(), NONCE, fake.io), /native summary failed/);
    assert.equal(fake.testCalls.length, 1);
  }
});

test('launcher suppresses child output and rejects forged worker summaries', async () => {
  for (const stdout of ['fixture_secret', '{}', JSON.stringify({ ...summary(), database: 'parent_test' }),
    JSON.stringify({ ...summary(), tests: 0 }), JSON.stringify({ ...summary(), extra: 'fixture_secret' })]) {
    await assert.rejects(runNeighborhoodSnapshotCi(env(), { nonce: NONCE, executeFile: async () => ({ stdout }) }), error => {
      assert.equal(error.message.includes('fixture_secret'), false); return true;
    });
  }
  await assert.rejects(runNeighborhoodSnapshotCi(env(), { nonce: NONCE, executeFile: async () => {
    throw Object.assign(new Error('fixture_secret'), { stdout: 'fixture_secret', stderr: 'fixture_secret' });
  } }), /isolated worker failed/);
});

test('ordinary UAD migration CI invokes the isolated runner; workflow already provides a loopback test service', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['test:uad-migration'], /&& node scripts\/runNeighborhoodSnapshotCi\.js && node --test /);
  const workflow = readFileSync(new URL('../../.github/workflows/uad-foundation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npm run test:uad-migration/);
  assert.match(workflow, /NODE_ENV: test/);
  assert.match(workflow, /DATABASE_URL: postgresql:\/\/[^\r\n]+@127\.0\.0\.1:\d+\/[a-z_]+_test/);
});
