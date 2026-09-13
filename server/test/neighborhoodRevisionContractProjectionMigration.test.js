import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationName = '20261019_neighborhood_revision_contract_projection.sql';
const readSource = async path => (await readFile(new URL(path, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const [original, previous, sql, registry] = await Promise.all([
  readSource('../migrations/20261010_neighborhood_assessment_persistence.sql'),
  readSource('../migrations/20261017_neighborhood_reported_observations.sql'),
  readSource(`../migrations/${migrationName}`),
  readSource('../src/database/mobileMigrations.js'),
]);

// Source-level guardrails only: native PostgreSQL checks must separately verify
// generated-column writes, numeric/NULL behavior, publication and concurrency.
const functionBody = (source, name) => {
  const signature = `CREATE OR REPLACE FUNCTION app.${name}()`;
  assert.equal(source.split(signature).length - 1, 1, `${name} must be defined exactly once`);
  const start = source.indexOf(signature);
  const end = source.indexOf('END $$;', start);
  assert.ok(end > start, `${name} must have a complete body`);
  return source.slice(start, end + 'END $$;'.length);
};
const child = functionBody(sql, 'neighborhood_guard_revision_child');
const revision = functionBody(sql, 'neighborhood_guard_revision');
const replaceExactly = (source, from, to, count) => {
  assert.equal(source.split(from).length - 1, count, `expected ${count} occurrences of ${from}`);
  return source.replaceAll(from, to);
};
const compact = source => source.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const outsideFunctions = compact(sql.replace(child, '').replace(revision, ''));
const timeoutStatement = outsideFunctions.match(/SELECT set_config[^;]+;/)?.[0];
const columnStatement = outsideFunctions.match(/ALTER TABLE[^;]+;/)?.[0];
const prerequisiteStatement = outsideFunctions.match(/DO \$\$[^]*?END \$\$;/)?.[0];

test('projection is additive and preserves both released neighborhood migrations', () => {
  assert.equal(createHash('sha256').update(original).digest('hex'),
    '8b3a35e6690a02be308928e2376aa8fb47f51b5ead7fe4b8e629d8bd5e6ce2b6');
  assert.equal(createHash('sha256').update(previous).digest('hex'),
    '35d97ee32b4259d77225b72119d3a4063604b92eff32ad431cce2e22aab42891');
});

test('migration adds only one idempotent stored generated projection and replaces only two guards', () => {
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION app\.([a-z_]+)/g)].map(match => match[1]);
  assert.deepEqual(functions, ['neighborhood_guard_revision_child', 'neighborhood_guard_revision']);
  assert.equal(columnStatement,
    "ALTER TABLE app.neighborhood_assessment_revisions ADD COLUMN IF NOT EXISTS contract_version_jsonb jsonb GENERATED ALWAYS AS (assessment->'contract_version') STORED;");
  assert.ok(timeoutStatement, 'transaction-local timeout statement');
  assert.ok(prerequisiteStatement, 'preexisting-column prerequisite statement');
  assert.equal(outsideFunctions, `${timeoutStatement} ${columnStatement} ${prerequisiteStatement}`);
  assert.ok(sql.indexOf('ADD COLUMN IF NOT EXISTS contract_version_jsonb') < sql.indexOf(child));
  assert.doesNotMatch(sql, /SECURITY DEFINER|CREATE EXTENSION|CREATE TRIGGER|DROP TRIGGER|CREATE INDEX/i);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK);/m);
});

test('migration timeout clamps are transaction-local and retain stricter nonzero caller limits', () => {
  const timeoutCall = (setting, maximum) =>
    `set_config('${setting}', least(CASE WHEN current_setting('${setting}')::interval = interval '0' ` +
    `THEN ${maximum} ELSE extract(epoch FROM current_setting('${setting}')::interval) * 1000 END, ${maximum})::text || 'ms', true)`;
  assert.equal(timeoutStatement,
    `SELECT ${timeoutCall('lock_timeout', 1000)}, ${timeoutCall('statement_timeout', 30000)};`);
  assert.equal(sql.match(/\bset_config\(/g)?.length, 2);
  assert.match(registry, /await client\.query\("BEGIN"\);\s+try \{\s+await client\.query\(sql\);/);
  assert.match(registry, /await client\.query\("COMMIT"\);/);
  assert.match(registry, /await client\.query\("ROLLBACK"\)/);
});

test('idempotent column creation fails closed on a mismatched stored projection definition', () => {
  assert.equal(prerequisiteStatement, compact(`DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='app.neighborhood_assessment_revisions'::regclass
      AND a.attname='contract_version_jsonb' AND NOT a.attisdropped
      AND a.atttypid='jsonb'::regtype AND a.attgenerated='s' AND a.attidentity='' AND NOT a.attnotnull
      AND pg_get_expr(d.adbin,d.adrelid) = '(assessment -> ''contract_version''::text)'
  ) THEN RAISE EXCEPTION 'neighborhood_revision_contract_projection_mismatch'; END IF;
END $$;`));
});

test('child guard is exactly the prior guard after reversing only the projection substitutions', () => {
  let restored = replaceExactly(child, 'parent_contract_version jsonb;', 'parent_assessment jsonb;', 1);
  restored = replaceExactly(restored,
    'SELECT publication_status, contract_version_jsonb INTO parent_status, parent_contract_version',
    'SELECT publication_status, assessment INTO parent_status, parent_assessment', 2);
  restored = replaceExactly(restored, "(parent_contract_version = '2'::jsonb)",
    "(parent_assessment->'contract_version' = '2'::jsonb)", 1);
  assert.equal(restored, functionBody(previous, 'neighborhood_guard_revision_child'));
});

test('both child parent reads keep their identity predicate and FOR SHARE lock without selecting assessment', () => {
  const reads = [...child.matchAll(/SELECT publication_status[^;]+;/g)].map(match => match[0]);
  assert.equal(reads.length, 2);
  for (const [index, row] of ['OLD', 'NEW'].entries()) {
    assert.equal(compact(reads[index]),
      `SELECT publication_status, contract_version_jsonb INTO parent_status, parent_contract_version FROM app.neighborhood_assessment_revisions WHERE assessment_id = ${row}.assessment_id AND revision = ${row}.revision FOR SHARE;`);
  }
  assert.doesNotMatch(child, /\bparent_assessment\b|\bassessment\s+INTO|\bcontract_version_jsonb\s*::/);
  for (const fragment of ['neighborhood_child_revision_immutable', 'neighborhood_published_child_immutable',
    'neighborhood_account_member_identity_mismatch', 'neighborhood_private_source_scope_mismatch',
    "snapshot_scope := NEW.source_snapshot->'scope'", "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;"]) {
    assert.ok(child.includes(fragment), fragment);
  }
});

test('projection retains JSONB numeric equality and missing/null distinctions without coercion', () => {
  // Keeping ->, a jsonb local, and the same JSONB predicate preserves the
  // database's semantics for 2/2.0, string "2", JSON null and missing keys.
  // This is an expression-preservation assertion, not a JS model of SQL NULL.
  assert.match(columnStatement, /contract_version_jsonb jsonb GENERATED ALWAYS AS \(assessment->'contract_version'\) STORED/);
  assert.match(child, /parent_contract_version jsonb;/);
  assert.match(child, /IF \(parent_contract_version = '2'::jsonb\) IS DISTINCT FROM\s+\(NEW\.member_unit IN \('account', 'source_record'\)\) THEN/);
  assert.doesNotMatch(child, /\bparent_contract_version\s*(?:::|->|#>)|\b(?:COALESCE|NULLIF)\s*\(\s*parent_contract_version/i);
  assert.match(revision, /IF \(NEW\.assessment->'contract_version' IN \('1'::jsonb, '2'::jsonb\)\) IS NOT TRUE THEN\s+RAISE EXCEPTION 'neighborhood_contract_version_unsupported';/);
  assert.doesNotMatch(sql, /assessment\s*->>\s*'contract_version'|contract_version_jsonb\s+(?:text|integer|smallint|bigint|numeric)\b/i);
});

test('publication guard differs only by excluding the generated projection from both immutable rows', () => {
  assert.equal(revision.match(/\bcontract_version_jsonb\b/g)?.length, 2);
  for (const row of ['NEW', 'OLD']) {
    const immutableRow = revision.match(new RegExp(`to_jsonb\\(${row}\\)((?: - '[a-z_]+')+)`));
    assert.ok(immutableRow, `${row} immutable row comparison`);
    const excluded = [...immutableRow[1].matchAll(/- '([a-z_]+)'/g)].map(match => match[1]);
    assert.deepEqual(excluded.filter(column => column !== 'contract_version_jsonb'), ['publication_status', 'published_at']);
    assert.equal(excluded.filter(column => column === 'contract_version_jsonb').length, 1);
    assert.ok(!excluded.includes('assessment'), 'canonical assessment remains immutable');
  }
  const restored = replaceExactly(revision, " - 'contract_version_jsonb'", '', 2);
  assert.equal(restored, functionBody(previous, 'neighborhood_guard_revision'));
  assert.doesNotMatch(sql, /(?:NEW|OLD)\.contract_version_jsonb\s*:=/);
});

test('projection migration is registered once after its released prerequisites', () => {
  const migrationList = registry.match(/const MIGRATIONS = Object\.freeze\(\[([^]*?)\]\);/);
  assert.ok(migrationList, 'migration registry');
  const names = [...migrationList[1].matchAll(/"([^"]+\.sql)"/g)].map(match => match[1]);
  assert.equal(names.filter(name => name === migrationName).length, 1);
  const projectionIndex = names.indexOf(migrationName);
  assert.equal(names[projectionIndex - 1], '20261018_sales_source_metadata.sql');
  for (const prerequisite of ['20261010_neighborhood_assessment_persistence.sql',
    '20261017_neighborhood_reported_observations.sql']) {
    assert.ok(names.indexOf(prerequisite) >= 0 && names.indexOf(prerequisite) < projectionIndex, prerequisite);
  }
});
