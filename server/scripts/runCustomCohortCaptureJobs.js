import 'dotenv/config';
import pg from 'pg';
import { createCustomNeighborhoodConfiguration, createCustomNeighborhoodCohortService }
  from '../src/application/customNeighborhoodComposition.js';
import { runCustomCohortCaptureJobOnce }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const configuration = createCustomNeighborhoodConfiguration();
if (!configuration.enabled) throw new Error('custom_neighborhood_workspace_disabled');
const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 3, connectionTimeoutMillis: 5_000,
  application_name: 'homenode-custom-cohort-capture-jobs' });
try {
  const cohortService = createCustomNeighborhoodCohortService({ pool, configuration });
  const result = await runCustomCohortCaptureJobOnce({ pool, cohortService });
  // Job status only. Do not log private source rows, tokens or actor details.
  console.log(JSON.stringify(result));
  if (result.status === 'outcome_unknown') process.exitCode = 1;
} finally { await pool.end(); }
