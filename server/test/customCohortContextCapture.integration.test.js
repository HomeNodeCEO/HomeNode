import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection }
  from './helpers/neighborhoodCiDatabase.js';
import { runCustomCohortContextCaptureDatabaseChecks } from './helpers/customCohortContextCaptureDatabaseChecks.js';
import { run as runCustomNeighborhoodSourcePolicyDatabaseChecks } from './helpers/customNeighborhoodSourcePolicyDatabaseChecks.js';
import { runCustomWorkspaceCheckpointDatabaseChecks } from './helpers/customWorkspaceCheckpointDatabaseChecks.js';

test('Custom context capture composes real discovery, retention, source policy, checkpoint persistence and retry', {
  skip: !process.env.DATABASE_URL, timeout: 360_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  await runCustomCohortContextCaptureDatabaseChecks(target.connectionString);
  // All three helpers use this one freshly migrated disposable child. The
  // checkpoint helper requires the exact coordinator fixture; policy fixtures
  // roll back and must not replace that assignment or its retained source data.
  const { Client } = createRequire(import.meta.url)('pg');
  const client = new Client({ connectionString: target.connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'custom_cohort_source_policy_ci_test' });
  try {
    await client.connect();
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, target.databaseName);
    await runCustomNeighborhoodSourcePolicyDatabaseChecks(client);
  } finally { await client.end(); }
  await runCustomWorkspaceCheckpointDatabaseChecks(target.connectionString);
});
