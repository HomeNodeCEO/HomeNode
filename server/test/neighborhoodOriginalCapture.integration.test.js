import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runNeighborhoodOriginalCaptureDatabaseChecks } from './helpers/neighborhoodOriginalCaptureDatabaseChecks.js';

test('original cached acquisition retains real PostgreSQL query bytes without rereading mutable rows', {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  await runNeighborhoodOriginalCaptureDatabaseChecks(target.connectionString);
});
