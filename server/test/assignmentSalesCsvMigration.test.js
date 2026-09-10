import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { applyMobileMigrations } from '../src/database/mobileMigrations.js';

const migrationName = '20261015_assignment_sales_csv_imports.sql';
const migration = await fs.readFile(new URL(`../migrations/${migrationName}`, import.meta.url), 'utf8');
const runner = await fs.readFile(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
const compact = migration.replace(/\s+/g, ' ');
const batchSql = migration.slice(migration.indexOf('CREATE TABLE'), migration.indexOf('CREATE INDEX'));
const rowSql = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS app.assignment_sales_import_rows'),
  migration.indexOf('CREATE OR REPLACE FUNCTION'));
const checksum = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');

test('private CSV migration registers once immediately after the current application migrations', () => {
  assert.equal(runner.split(`"${migrationName}"`).length - 1, 1);
  assert.match(runner, /"20261014_custom_neighborhood_review_commands\.sql",\s*"20261015_assignment_sales_csv_imports\.sql",/);
});

test('private batches declare exact report ownership, actor and scoped operation identities', () => {
  for (const field of ['batch_id uuid PRIMARY KEY', 'organization_id uuid NOT NULL',
    'report_file_id uuid NOT NULL', 'assignment_file_id bigint NOT NULL', 'account_id text NOT NULL',
    'actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT', 'operation_id uuid NOT NULL']) {
    assert.ok(batchSql.includes(field), field);
  }
  assert.match(compact, /UNIQUE \(organization_id, report_file_id, operation_id\)/);
  assert.match(compact, /FOREIGN KEY \(organization_id, report_file_id, assignment_file_id, account_id\) REFERENCES app\.report_files \(organization_id, id, custom_assignment_file_id, account_id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(batchSql, /UNIQUE\s*\(source_sha256\)/);
});

test('original bytes are mandatory, bounded and checked against the actual PostgreSQL SHA-256', () => {
  assert.match(batchSql, /source_bytes bytea NOT NULL/);
  assert.match(batchSql, /source_byte_length BETWEEN 1 AND 8388608/);
  assert.match(batchSql, /source_byte_length = pg_catalog\.octet_length\(source_bytes\)/);
  assert.match(batchSql, /source_sha256 = pg_catalog\.encode\(pg_catalog\.sha256\(source_bytes\), 'hex'\)/);
  assert.ok(batchSql.includes("source_sha256 ~ '^[a-f0-9]{64}$'"));
  assert.doesNotMatch(migration, /CREATE EXTENSION|digest\(/i);
});

test('preparation profile, complete header, exact row bounds and name controls are explicit', () => {
  assert.ok(batchSql.includes("preparation_profile = 'private_sales_csv_preparation_v1'"));
  assert.match(batchSql, /preparation_version = 1/);
  assert.ok(batchSql.includes("preparation_sha256 ~ '^[a-f0-9]{64}$'"));
  assert.match(batchSql, /row_count BETWEEN 0 AND 10000/);
  assert.match(batchSql, /char_length\(file_name\) <= 255/);
  assert.ok(batchSql.includes(String.raw`file_name !~ U&'[\0001-\001F\007F-\009F]'`));
  assert.match(batchSql, /pg_catalog\.jsonb_typeof\(preparation_header\) = 'object'/);
  assert.match(batchSql, /pg_catalog\.octet_length\(pg_catalog\.convert_to\(preparation_header::text, 'UTF8'\)\) <= 2097152/);
});

test('receipt ownership is exclusively inherited from a non-cascading batch FK', () => {
  assert.match(rowSql, /batch_id uuid NOT NULL REFERENCES app\.assignment_sales_import_batches\(batch_id\) ON DELETE RESTRICT/);
  assert.match(rowSql, /receipt_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid\(\)/);
  assert.match(rowSql, /PRIMARY KEY \(batch_id, source_row_number\)/);
  assert.match(rowSql, /source_row_number BETWEEN 2 AND 10001/);
  assert.doesNotMatch(rowSql, /organization_id|report_file_id|assignment_file_id|account_id/);
  assert.doesNotMatch(migration, /ON DELETE (CASCADE|SET NULL)/);
});

test('stored row objects have a bounded representation and cannot contradict their receipt ordinal', () => {
  assert.match(rowSql, /record_data jsonb NOT NULL/);
  assert.match(rowSql, /pg_catalog\.jsonb_typeof\(record_data\) = 'object'/);
  assert.match(rowSql, /pg_catalog\.octet_length\(pg_catalog\.convert_to\(record_data::text, 'UTF8'\)\) <= 2097152/);
  assert.match(rowSql, /\(record_data->'source_row_number'\) IS NOT DISTINCT FROM pg_catalog\.to_jsonb\(source_row_number\)/);
  assert.doesNotMatch(rowSql, /record_data[^;]*::(?:integer|bigint|numeric)/);
});

test('both tables reject statement-level update, delete and truncate and revoke these public privileges', () => {
  for (const suffix of ['batches', 'rows']) {
    assert.match(compact, new RegExp(`BEFORE UPDATE OR DELETE OR TRUNCATE ON app\\.assignment_sales_import_${suffix} FOR EACH STATEMENT EXECUTE FUNCTION app\\.reject_assignment_sales_import_mutation\\(\\)`));
    assert.ok(migration.includes(`REVOKE UPDATE, DELETE, TRUNCATE ON app.assignment_sales_import_${suffix} FROM PUBLIC;`));
  }
  assert.ok(migration.includes("RAISE EXCEPTION 'assignment_sales_import_immutable' USING ERRCODE = '55000'"));
});

test('an immediate parent-range guard prohibits all ordinals outside the immutable declared population', () => {
  assert.match(compact, /SELECT row_count INTO expected_rows FROM app\.assignment_sales_import_batches WHERE batch_id = NEW\.batch_id/);
  assert.match(compact, /IF NOT FOUND OR NEW\.source_row_number IS NULL OR NEW\.source_row_number < 2 OR NEW\.source_row_number > expected_rows \+ 1 THEN/);
  assert.match(compact, /BEFORE INSERT ON app\.assignment_sales_import_rows FOR EACH ROW EXECUTE FUNCTION app\.guard_assignment_sales_import_row_range\(\)/);
});

test('one deferred batch constraint checks completeness, including zero rows and contiguous end points', () => {
  assert.equal((migration.match(/CREATE CONSTRAINT TRIGGER/g) || []).length, 1);
  assert.match(compact, /CREATE CONSTRAINT TRIGGER assignment_sales_import_batch_complete AFTER INSERT ON app\.assignment_sales_import_batches DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app\.check_assignment_sales_import_batch_complete\(\)/);
  assert.match(compact, /SELECT count\(\*\), min\(source_row_number\), max\(source_row_number\) INTO actual_rows, first_row, last_row FROM app\.assignment_sales_import_rows WHERE batch_id = NEW\.batch_id/);
  assert.match(compact, /actual_rows <> NEW\.row_count/);
  assert.match(compact, /NEW\.row_count = 0 AND \(first_row IS NOT NULL OR last_row IS NOT NULL\)/);
  assert.match(compact, /first_row IS DISTINCT FROM 2 OR last_row IS DISTINCT FROM NEW\.row_count \+ 1/);
});

test('migration adds only private intake storage, without shared publication, existing-row rewrites or source authority', () => {
  assert.doesNotMatch(migration, /\bcore\.|ALTER TABLE|INSERT INTO|UPDATE\s+app\.|DELETE FROM|DROP TABLE|CREATE POLICY|SECURITY DEFINER/i);
  assert.equal((migration.match(/SET search_path = pg_catalog, app/g) || []).length, 3);
  assert.ok(migration.includes('No automatic expiration'));
  assert.ok(migration.includes('Storage does not establish source rights'));
});

// Exercise the actual migration runner without a database. The source-contract
// assertions above do not claim PostgreSQL execution or concurrency coverage;
// the separately owned native integration helper provides those checks.
async function runnerFixture({ failMigration = false } = {}) {
  const names = [...runner.matchAll(/"([^"\n]+\.sql)"/g)].map((entry) => entry[1]);
  const ledger = new Map();
  for (const name of names.filter((name) => name !== migrationName)) {
    ledger.set(name, checksum(await fs.readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')));
  }
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT checksum_sha256')) {
        const hash = ledger.get(parameters[0]);
        return { rows: hash ? [{ checksum_sha256: hash }] : [] };
      }
      if (sql === migration && failMigration) throw new Error('synthetic_migration_failure');
      if (sql.includes('INSERT INTO app.schema_migrations')) ledger.set(parameters[0], parameters[1]);
      return { rows: [] };
    },
    release() { released += 1; },
  };
  return { calls, ledger, released: () => released, pool: { query: client.query, connect: async () => client } };
}

test('application runner applies the new migration transactionally and records its normalized checksum once', async () => {
  const fixture = await runnerFixture();
  const result = await applyMobileMigrations(fixture.pool, { logger: {} });
  assert.deepEqual(result.find(row => row.migration_name === migrationName), { migration_name: migrationName, status: 'applied' });
  const index = fixture.calls.findIndex(({ sql }) => sql === migration);
  assert.equal(fixture.calls[index - 1].sql, 'BEGIN');
  assert.match(fixture.calls[index + 1].sql, /INSERT INTO app.schema_migrations/);
  assert.deepEqual(fixture.calls[index + 1].parameters, [migrationName, checksum(migration)]);
  assert.equal(fixture.calls[index + 2].sql, 'COMMIT');
  const second = await applyMobileMigrations(fixture.pool, { logger: {} });
  assert.deepEqual(second.find(row => row.migration_name === migrationName), { migration_name: migrationName, status: 'already_applied' });
  assert.equal(fixture.calls.filter(({ sql }) => sql === migration).length, 1);
  assert.equal(fixture.released(), 2);
});

test('application runner rolls back a failed new migration and releases the advisory lock and connection', async () => {
  const fixture = await runnerFixture({ failMigration: true });
  await assert.rejects(applyMobileMigrations(fixture.pool, { logger: {} }), /synthetic_migration_failure/);
  const index = fixture.calls.findIndex(({ sql }) => sql === migration);
  assert.equal(fixture.calls[index + 1].sql, 'ROLLBACK');
  assert.match(fixture.calls.at(-1).sql, /pg_advisory_unlock/);
  assert.equal(fixture.ledger.has(migrationName), false);
  assert.equal(fixture.released(), 1);
});

test('application runner refuses a changed checksum rather than replaying an existing migration', async () => {
  const fixture = await runnerFixture();
  fixture.ledger.set(migrationName, '0'.repeat(64));
  await assert.rejects(applyMobileMigrations(fixture.pool, { logger: {} }),
    new RegExp(`migration_checksum_mismatch:${migrationName.replaceAll('.', '\\.')}`));
  assert.equal(fixture.calls.some(({ sql }) => sql === migration), false);
  assert.equal(fixture.released(), 1);
});
