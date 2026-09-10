import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { checkCustomCohortReportedProposalDatabase } from './helpers/customCohortReportedProposalDatabaseChecks.js';

test('actual city discovery preserves atomic report Apply, replay and accepted workfile reopen', {
  skip: !process.env.DATABASE_URL, timeout: 420000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase(), { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 3, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'city_report_apply_ci' });
  try {
    const catalog = JSON.parse(await readFile(new URL('../data/neighborhood-city-boundaries/catalog.json', import.meta.url), 'utf8'));
    const entry = catalog.cities.find(city => city.geoid === '4819000'); assert.ok(entry);
    const discovery = { profile_id: 'custom-city-polygon-v1',
      city: { geoid: entry.geoid, vintage: catalog.vintage, asset_sha256: entry.sha256 } };
    const result = await checkCustomCohortReportedProposalDatabase({ pool, databaseName: target.databaseName, discovery, recordedHousing: true });
    assert.equal(result.checks.length, 11);
    assert.deepEqual(result.discovery, discovery);
  } finally { await pool.end(); }
});
