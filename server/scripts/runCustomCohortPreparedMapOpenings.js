import 'dotenv/config';
import pg from 'pg';
import { runCustomCohortPreparedMapOpeningJob } from '../src/services/neighborhoodAssessment/customCohortPreparedMapOpeningJob.js';
import { customCohortCaptureJobPoolOptions }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const setting = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return Number(value);
};
// Reuse the reviewed URL/TLS boundary; pg must not reinterpret untrusted URL
// options or silently use plaintext for a remote database. Keep this job serial.
const pool = new pg.Pool({ ...customCohortCaptureJobPoolOptions(process.env.DATABASE_URL), max: 1,
  statement_timeout: 120_000,
  application_name: 'homenode-custom-cohort-map-openings' });
pool.on('error', () => {
  process.exitCode = 1;
  console.error('[neighborhood-map-openings] failed', 'database_connection_failed');
});
try {
  console.log(JSON.stringify(await runCustomCohortPreparedMapOpeningJob(pool, {
    maximumContexts: setting('NEIGHBORHOOD_MAP_OPENING_MAX_CONTEXTS', 10),
    maximumRuntimeMinutes: setting('NEIGHBORHOOD_MAP_OPENING_MAX_RUNTIME_MINUTES', 80),
  })));
} catch (error) {
  const message = error?.message;
  console.error('[neighborhood-map-openings] failed',
    typeof message === 'string' && /^custom_cohort_prepared_map_opening_[a-z_]+$/.test(message)
      ? message : 'job_failed');
  process.exitCode = 1;
} finally { await pool.end(); }
