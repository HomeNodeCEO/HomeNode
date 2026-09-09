import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runCustomCohortContextCaptureDatabaseChecks } from './helpers/customCohortContextCaptureDatabaseChecks.js';

test('Custom context capture composes real discovery, immutable retention, freshness and retry', {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  await runCustomCohortContextCaptureDatabaseChecks(target.connectionString);
});
