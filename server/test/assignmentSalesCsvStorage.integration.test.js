import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { runAssignmentSalesCsvStorageDatabaseChecks } from './helpers/assignmentSalesCsvStorageDatabaseChecks.js';

test('assignment-private CSV storage retains complete immutable receipts behind exact native assignment access', {
  skip: !process.env.DATABASE_URL, timeout: 180_000,
}, async () => {
  // The genuine CI bootstrap verifies loopback, creates a new child and runs
  // canonical migrations. No shared-database fallback or synthetic CI flags.
  const target = await prepareNeighborhoodCiDatabase();
  await runAssignmentSalesCsvStorageDatabaseChecks(target.connectionString);
});
