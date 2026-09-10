import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortReportedReplacementDatabase } from './helpers/customCohortReportedReplacementDatabaseChecks.js';

test('reported replacement native helper is import-safe without starting a database', () => {
  assert.equal(typeof checkCustomCohortReportedReplacementDatabase, 'function');
});

test('Custom v2 explicit replacement uses the real occupied predecessor and preserves both atomic histories in PostgreSQL', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'reported_observation_replacement_ci' });
  try { await checkCustomCohortReportedReplacementDatabase({ pool, databaseName: target.databaseName }); }
  finally { await pool.end(); }
});
