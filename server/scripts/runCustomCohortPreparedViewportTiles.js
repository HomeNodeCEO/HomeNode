import 'dotenv/config';
import pg from 'pg';
import { runCustomCohortPreparedViewportTileJob } from '../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';
import { customCohortCaptureJobPoolOptions }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const setting = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new TypeError(`invalid_${name.toLowerCase()}`);
  return Number(value);
};
// Keep the offline worker serial and reuse the reviewed URL/TLS boundary.
// pg must not reinterpret URL options or silently use plaintext remotely.
const pool = new pg.Pool({ ...customCohortCaptureJobPoolOptions(process.env.DATABASE_URL), max: 1,
  statement_timeout: 120_000,
  application_name: 'homenode-custom-cohort-prepared-tiles' });
pool.on('error', () => {
  process.exitCode = 1;
  console.error('[neighborhood-tiles] failed', 'database_connection_failed');
});
try {
  const result = await runCustomCohortPreparedViewportTileJob(pool, {
    maximumContexts: setting('NEIGHBORHOOD_TILE_MAX_CONTEXTS', 10),
    maximumRuntimeMinutes: setting('NEIGHBORHOOD_TILE_MAX_RUNTIME_MINUTES', 80),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error?.message;
  console.error('[neighborhood-tiles] failed',
    typeof message === 'string' && /^custom_cohort_prepared_tiles_[a-z_]+$/.test(message)
      ? message : 'job_failed');
  process.exitCode = 1;
} finally { await pool.end(); }
