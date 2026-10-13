import 'dotenv/config';
import pg from 'pg';
import { runNeighborhoodGroupIndexRetirement } from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';

// Operator-only recovery. It is intentionally absent from scheduled maintenance
// and does not build or publish a prepared generation.
if (process.env.NEIGHBORHOOD_GROUP_RETIREMENT_RECOVERY !== '1')
  throw new Error('neighborhood_group_retirement_recovery_not_enabled');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname || !databaseUrl.pathname.slice(1))
  throw new TypeError('invalid_database_url');
const setting = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return number;
};
const batchSize = setting('NEIGHBORHOOD_GROUP_RETIREMENT_BATCH_SIZE', 1000);
const maximumRuntimeMinutes = setting('NEIGHBORHOOD_GROUP_RETIREMENT_MAX_RUNTIME_MINUTES', 15);
if (batchSize > 5000 || maximumRuntimeMinutes > 180) throw new TypeError('invalid_neighborhood_group_retirement_budget');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, statement_timeout: 125_000,
  application_name: 'homenode-neighborhood-group-retirement-recovery' });
try {
  const result = await runNeighborhoodGroupIndexRetirement(pool, { batchSize, maximumRuntimeMinutes });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('[neighborhood-group-retirement-recovery] failed', error?.code ?? error?.name ?? 'error');
  process.exitCode = 1;
} finally { await pool.end(); }
