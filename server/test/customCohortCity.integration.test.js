import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runCustomCohortContextCaptureDatabaseChecks } from './helpers/customCohortContextCaptureDatabaseChecks.js';
import { runCustomCohortCityDatabaseChecks } from './helpers/customCohortCityDatabaseChecks.js';

test('actual city owner retains exact installed polygon and source closure without radius, retrospective or permission shortcuts', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  await runCustomCohortContextCaptureDatabaseChecks(target.connectionString);
  const result = await runCustomCohortCityDatabaseChecks(target.connectionString);
  assert.equal(result.checks.length, 8);
  assert.equal(result.fixture.checkpoint.workspace_version, 4);
  assert.equal(result.fixture.discovery.profile_id, 'custom-city-polygon-v1');
});
