import 'dotenv/config';
import pg from 'pg';
import { runNeighborhoodParcelPrecompute } from '../src/services/neighborhoodAssessment/neighborhoodParcelPrecompute.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const numberSetting = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${key.toLowerCase()}`);
  return Number(value);
};
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 65_000,
  application_name: 'homenode-neighborhood-precompute',
});
try {
  const result = await runNeighborhoodParcelPrecompute(pool, {
    batchSize: numberSetting('NEIGHBORHOOD_PRECOMPUTE_BATCH_SIZE', 500),
    maximumRuntimeMinutes: numberSetting('NEIGHBORHOOD_PRECOMPUTE_MAX_RUNTIME_MINUTES', 45),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('[neighborhood-precompute] failed', error?.code ?? error?.name ?? 'error');
  process.exitCode = 1;
} finally {
  await pool.end();
}
