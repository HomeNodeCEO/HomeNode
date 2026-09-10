import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortReportedProposalDatabase } from './helpers/customCohortReportedProposalDatabaseChecks.js';

const discovery = Object.freeze({ profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' });

test('expanded reported proposal helper is import-safe and validates its optional choice before any connection', async () => {
  const pool = { connect() { assert.fail('invalid fixture input must not connect'); } };
  for (const invalid of [null, {}, { ...discovery, radius_metres: 8046.72 }, { ...discovery, radius_metres: '16093.44' }]) {
    await assert.rejects(checkCustomCohortReportedProposalDatabase({ pool, databaseName: 'synthetic_reported_test', discovery: invalid }));
  }
});

test('five-mile Custom context remains bound through real proposal, atomic five-part Apply and fresh accepted reopen', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  // This creates a separate migrated CI database. Never reuse the default v1
  // helper's source namespace, broaden its guards, or run against live data.
  const target = await prepareNeighborhoodCiDatabase();
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'reported_discovery_owner_ci' });
  try {
    const result = await checkCustomCohortReportedProposalDatabase({ pool, databaseName: target.databaseName, discovery });
    assert.deepEqual(result.discovery, discovery);
    assert.ok(result.checks.some(check => check.includes('saved ten-mile checkpoint')));
    assert.ok(result.checks.some(check => check.includes('Apply refuses changed saved discovery')));
    assert.ok(result.checks.some(check => check.includes('actual four-mile CAD account')));
  } finally { await pool.end(); }
});
