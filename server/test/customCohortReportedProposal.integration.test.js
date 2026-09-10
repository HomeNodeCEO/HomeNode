import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortReportedProposalDatabase } from './helpers/customCohortReportedProposalDatabaseChecks.js';

test('reported proposal native helper is import-safe and callable without starting a database', () => {
  assert.equal(typeof checkCustomCohortReportedProposalDatabase, 'function');
});

test('Custom reported observation owner retains, proposes, atomically applies and reopens exact data in native PostgreSQL', {
  skip: !process.env.DATABASE_URL, timeout: 360000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'reported_observation_owner_ci' });
  try { await checkCustomCohortReportedProposalDatabase({ pool, databaseName: target.databaseName }); }
  finally { await pool.end(); }
});
