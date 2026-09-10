import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortRecordedProximityDatabase } from './helpers/customCohortRecordedProximityDatabaseChecks.js';

test('recorded proximity native helper can be imported without connecting', () => {
  assert.equal(typeof checkCustomCohortRecordedProximityDatabase, 'function');
});

test('actual retained native proximity, catalog authorization and report preservation', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase(), { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'recorded_proximity_ci' });
  try {
    const result = await checkCustomCohortRecordedProximityDatabase({ pool, databaseName: target.databaseName });
    assert.equal(result.checks.length, 4);
  } finally { await pool.end(); }
});
