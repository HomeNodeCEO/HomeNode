import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runCustomCohortContextCaptureDatabaseChecks } from './helpers/customCohortContextCaptureDatabaseChecks.js';
import { runCustomCitySpatialDatabaseChecks } from './helpers/customCitySpatialDatabaseChecks.js';

test('city native helper is import-safe and rejects nonisolated targets before connecting', async () => {
  assert.equal(typeof runCustomCitySpatialDatabaseChecks, 'function');
  await assert.rejects(runCustomCitySpatialDatabaseChecks('postgresql://example.invalid/production'));
  await assert.rejects(runCustomCitySpatialDatabaseChecks('postgresql://127.0.0.1/not_a_disposable_database'));
});

test('actual city polygon membership, original geometry and complete capacity refusals', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  // Existing CI helper creates a fresh migrated child; never point this test at
  // the shared parent or invent test topology/grants in a production database.
  const target = await prepareNeighborhoodCiDatabase();
  await runCustomCohortContextCaptureDatabaseChecks(target.connectionString);
  const result = await runCustomCitySpatialDatabaseChecks(target.connectionString);
  assert.equal(result.checks.length, 5);
  assert.equal(Object.keys(result.fixture.account_ids).length, 7);
  assert.equal(result.fixture.subject_point.type, 'Point');
});
