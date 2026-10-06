import 'dotenv/config';
import pg from 'pg';
import { createCustomNeighborhoodConfiguration, createCustomNeighborhoodCohortService }
  from '../src/application/customNeighborhoodComposition.js';
import { runCustomCohortCaptureJobOnce }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';
import { customCohortCaptureJobPoolOptions }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobPool.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const configuration = createCustomNeighborhoodConfiguration();
if (!configuration.enabled) throw new Error('custom_neighborhood_workspace_disabled');
const pool = new pg.Pool(customCohortCaptureJobPoolOptions(process.env.DATABASE_URL));
pool.on('error', () => {
  // Idle socket failures must not print driver messages or connection details.
  process.exitCode = 1;
  console.error('[neighborhood-capture-jobs] failed', 'database_connection_failed');
});
try {
  const cohortService = createCustomNeighborhoodCohortService({ pool, configuration });
  const result = await runCustomCohortCaptureJobOnce({ pool, cohortService });
  // Job status only. Do not log private source rows, tokens or actor details.
  console.log(JSON.stringify(result));
  if (result.status === 'outcome_unknown') process.exitCode = 1;
} catch (error) {
  // Never print driver messages, connection details or source-row values.
  console.error('[neighborhood-capture-jobs] failed',
    error?.outcome_unknown ? 'outcome_unknown' : 'job_failed');
  process.exitCode = 1;
} finally { await pool.end(); }
