import 'dotenv/config';
import pg from 'pg';
import { runCustomCohortPreparedMapOpeningJob } from '../src/services/neighborhoodAssessment/customCohortPreparedMapOpeningJob.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const setting = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return Number(value);
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1,
  connectionTimeoutMillis: 5000, statement_timeout: 120_000,
  application_name: 'homenode-custom-cohort-map-openings' });
try {
  console.log(JSON.stringify(await runCustomCohortPreparedMapOpeningJob(pool, {
    maximumContexts: setting('NEIGHBORHOOD_MAP_OPENING_MAX_CONTEXTS', 10),
    maximumRuntimeMinutes: setting('NEIGHBORHOOD_MAP_OPENING_MAX_RUNTIME_MINUTES', 80),
  })));
} catch (error) {
  const message = error?.message;
  console.error('[neighborhood-map-openings] failed',
    typeof message === 'string' && /^custom_cohort_prepared_map_opening_[a-z_]+$/.test(message)
      ? message : error?.code ?? error?.name ?? 'error');
  process.exitCode = 1;
} finally { await pool.end(); }
