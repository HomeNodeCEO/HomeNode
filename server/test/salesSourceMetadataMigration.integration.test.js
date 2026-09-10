import test from 'node:test';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkSalesSourceMetadataDatabase } from './helpers/salesSourceMetadataDatabaseChecks.js';

test('source metadata migration preserves CSV-only and populated provider records in PostgreSQL', {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'sales_source_metadata_migration_test' });
  try {
    await client.connect();
    await checkSalesSourceMetadataDatabase(client, target.databaseName);
  } finally { await client.end(); }
});
