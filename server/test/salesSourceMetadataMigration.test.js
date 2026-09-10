import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('../migrations/20261018_sales_source_metadata.sql', import.meta.url), 'utf8');
const executable = sql.replace(/^--.*$/gm, '').trim();

test('CSV-only source metadata migration adds only nullable optional provider fields', () => {
  assert.equal(executable, 'ALTER TABLE IF EXISTS core.sales_source_records\n'
    + '  ADD COLUMN IF NOT EXISTS source_modified_at timestamptz,\n'
    + '  ADD COLUMN IF NOT EXISTS source_system_name text;');
});

test('source metadata migration runs once in the existing application owner after report observations', async () => {
  const registry = await readFile(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.equal(registry.match(/"20261018_sales_source_metadata.sql"/g)?.length, 1);
  assert.ok(registry.indexOf('20261018_sales_source_metadata.sql') > registry.indexOf('20261017_neighborhood_reported_observations.sql'));
  const runner = await readFile(new URL('../scripts/runApplicationMigrations.js', import.meta.url), 'utf8');
  assert.match(runner, /await applyMobileMigrations\(pool\)/);
});

test('column types agree with the existing CSV and Trestle ingestion owners', async () => {
  for (const path of ['../../dcad-scraper-with-api/migrations/018_trestle_replication_readiness.sql',
    '../src/services/trestleReplication.js']) {
    const owner = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(owner, /ADD COLUMN IF NOT EXISTS source_modified_at timestamptz/);
    assert.match(owner, /ADD COLUMN IF NOT EXISTS source_system_name text/);
  }
});
