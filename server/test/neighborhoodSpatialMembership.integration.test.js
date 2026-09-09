import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runNeighborhoodSpatialMembershipDatabaseChecks } from './helpers/neighborhoodSpatialMembershipDatabaseChecks.js';

test('native exact-radius membership and concurrent cache changes', { skip: !process.env.DATABASE_URL }, async () => {
  const { connectionString } = await prepareNeighborhoodCiDatabase();
  await runNeighborhoodSpatialMembershipDatabaseChecks(connectionString);
});
