import 'dotenv/config';
import pg from 'pg';
import { runCustomCohortPreparedViewportTileJob } from '../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const setting = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return Number(value);
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, statement_timeout: 120_000,
  application_name: 'homenode-custom-cohort-prepared-tiles' });
try {
  const result = await runCustomCohortPreparedViewportTileJob(pool, {
    maximumContexts: setting('NEIGHBORHOOD_TILE_MAX_CONTEXTS', 10),
    maximumRuntimeMinutes: setting('NEIGHBORHOOD_TILE_MAX_RUNTIME_MINUTES', 80),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error('[neighborhood-tiles] failed', error?.code ?? error?.name ?? 'error');
  process.exitCode = 1;
} finally { await pool.end(); }
