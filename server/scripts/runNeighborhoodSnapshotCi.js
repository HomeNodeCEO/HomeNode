import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { checkedNeighborhoodDatabaseUrl, verifyNeighborhoodCiConnection, NEIGHBORHOOD_CI_IDENTITY_SQL } from '../test/helpers/neighborhoodCiDatabase.js';

const runFile = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const directory = fileURLToPath(new URL('../', import.meta.url));
const nativeTest = fileURLToPath(new URL('../test/neighborhoodCachedSourceReaderSnapshot.integration.test.js', import.meta.url));
const controlled = /^(?:PG|DOTENV|NODE_|DATABASE_URL$|NEIGHBORHOOD_SNAPSHOT_DATABASE_URL$)/i;
const noncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure = stage => new Error('Neighborhood snapshot CI ' + stage + ' failed; details suppressed, no shared-database fallback');
const options = (env, timeout) => ({ cwd: directory, env, timeout, maxBuffer: 2_000_000,
  windowsHide: true, shell: false, killSignal: 'SIGKILL' });

/** Pure plan only: supplied CI flags in a unit fixture never execute a database. */
export function neighborhoodSnapshotCiPlan(environment, nonce = randomUUID()) {
  if (environment.CI !== 'true' || environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('Neighborhood snapshot runner requires GitHub Actions CI');
  }
  const parent = checkedNeighborhoodDatabaseUrl(environment.DATABASE_URL, environment.NODE_ENV);
  if (typeof nonce !== 'string' || !noncePattern.test(nonce)) throw new Error('Invalid neighborhood snapshot CI nonce');
  const databaseName = 'neighborhood_snapshot_' + nonce.replaceAll('-', '') + '_test';
  if (databaseName === parent.databaseName) throw new Error('Neighborhood snapshot CI database must be new');
  const url = new URL(parent.connectionString);
  url.pathname = '/' + databaseName;
  const child = checkedNeighborhoodDatabaseUrl(url.href, 'test');
  const bootstrapEnv = Object.fromEntries(Object.entries(environment).filter(([key]) => !controlled.test(key)));
  Object.assign(bootstrapEnv, { DATABASE_URL: parent.connectionString, NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: devNull, DOTENV_CONFIG_QUIET: 'true' });
  const testEnv = { ...bootstrapEnv, DATABASE_URL: child.connectionString,
    NEIGHBORHOOD_SNAPSHOT_DATABASE_URL: child.connectionString };
  return { parent, child, bootstrapEnv, testEnv, nonce };
}

function nativeCounts(stdout) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...String(stdout).matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1) throw failure('native summary');
    counts[key] = Number(matches[0][1]);
    if (!Number.isSafeInteger(counts[key])) throw failure('native summary');
  }
  if (counts.tests < 1 || counts.pass !== counts.tests || counts.fail || counts.cancelled || counts.skipped || counts.todo) {
    throw failure('native summary');
  }
  return { tests: counts.tests, passed: counts.pass };
}

/** Internal sanitized worker. Driver loading occurs only after CI/URL/env guards.
 * Injectable I/O is for bounded unit tests, never runtime request configuration. */
export async function executeNeighborhoodSnapshotCi(environment, nonce, {
  loadPg = () => import('pg'), executeFile = runFile,
} = {}) {
  const plan = neighborhoodSnapshotCiPlan(environment, nonce);
  // Direct --isolated invocation cannot bypass the clean-process boundary.
  if (Object.entries(environment).some(([key, value]) => controlled.test(key) && plan.bootstrapEnv[key] !== value)) {
    throw new Error('Neighborhood snapshot CI worker requires sanitized environment');
  }
  let admin, stage = 'connection';
  try {
    const { default: pg } = await loadPg();
    admin = new pg.Client({ connectionString: plan.parent.connectionString, connectionTimeoutMillis: 3000,
      statement_timeout: 8000, query_timeout: 10_000, application_name: 'neighborhood_snapshot_ci_bootstrap' });
    await admin.connect();
    stage = 'identity';
    const result = await admin.query(NEIGHBORHOOD_CI_IDENTITY_SQL);
    verifyNeighborhoodCiConnection(result.rows?.[0], admin.connection?.stream?.remoteAddress, plan.parent.databaseName);
    // Exact generated ASCII identifier; template0 is empty, never the shared DB.
    stage = 'creation';
    await admin.query('CREATE DATABASE "' + plan.child.databaseName + '" TEMPLATE template0');
  } catch {
    throw failure(stage);
  } finally {
    if (admin) {
      try { await admin.end(); } catch { throw failure('connection close'); }
    }
  }
  let result;
  try {
    result = await executeFile(process.execPath, ['--test', '--test-reporter=tap', nativeTest], options(plan.testEnv, 75_000));
  } catch {
    throw failure('native execution'); // Never print child stdout/stderr or a URL.
  }
  return { database: plan.child.databaseName, ...nativeCounts(result.stdout) };
}

/** Re-exec before pg import so PG/DOTENV/NODE_* cannot redirect the bootstrap.
 * No process.execArgv inheritance, shell, service startup, migrations or DROP. */
export async function runNeighborhoodSnapshotCi(environment = process.env, {
  nonce = randomUUID(), executeFile = runFile,
} = {}) {
  const plan = neighborhoodSnapshotCiPlan(environment, nonce);
  let result;
  try {
    result = await executeFile(process.execPath, [script, '--isolated', nonce], options(plan.bootstrapEnv, 90_000));
    const summary = JSON.parse(result.stdout);
    if (!summary || Object.keys(summary).sort().join(',') !== 'database,passed,tests'
      || summary.database !== plan.child.databaseName || !Number.isSafeInteger(summary.tests)
      || summary.tests < 1 || summary.passed !== summary.tests) throw failure('worker summary');
    return summary;
  } catch {
    throw failure('isolated worker');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args.length === 0) result = await runNeighborhoodSnapshotCi();
    else if (args.length === 2 && args[0] === '--isolated') result = await executeNeighborhoodSnapshotCi(process.env, args[1]);
    else throw failure('arguments');
    // Only generated database name and validated numeric counts reach CI logs.
    console.log(JSON.stringify(result));
  } catch {
    console.error('Neighborhood snapshot CI runner failed; details suppressed to protect credentials. No shared-database fallback.');
    process.exitCode = 1;
  }
}
