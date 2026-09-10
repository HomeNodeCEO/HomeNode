import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortRecordedProximityDatabase } from './helpers/customCohortRecordedProximityDatabaseChecks.js';

test('actual new Custom CAD capture supports retained housing and proximity without changing the accepted report', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase(), { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'recorded_housing_ci' });
  try {
    const result = await checkCustomCohortRecordedProximityDatabase({ pool, databaseName: target.databaseName, recordedHousing: true });
    assert.equal(result.checks.length, 5);
  } finally { await pool.end(); }
});
