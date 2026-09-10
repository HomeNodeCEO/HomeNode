import assert from 'node:assert/strict';
import { auditSalesRetention } from '../../src/services/salesRetentionAudit.js';
import { checkedNeighborhoodDatabaseUrl, verifyNeighborhoodCiConnection, NEIGHBORHOOD_CI_IDENTITY_SQL } from './neighborhoodCiDatabase.js';

// Synthetic audit fixtures only. Intentionally omit a canonical-source FK so
// an orphan can be observed without disabling a real constraint. No deletion,
// retention authorization, production source record or provider claim exists.
const REQUIRED_SCHEMA = `CREATE SCHEMA core; CREATE SCHEMA app;
CREATE TABLE core.sales_source_records(id bigint PRIMARY KEY,record_type text,close_date date,
  source_filename text NOT NULL DEFAULT 'SYNTHETIC_PRIVATE_FILENAME.csv',raw_payload jsonb NOT NULL DEFAULT '{"private_marker":"SYNTHETIC_PRIVATE_ROW"}');
CREATE TABLE core.sales(id bigint PRIMARY KEY,source_record_id bigint,closing_date text);`;
const SOURCES = [
  [1, 'closed_sale', '2020-12-31'], [2, 'closed_sale', '2021-01-01'], [3, 'closed_sale', '2022-01-01'],
  [4, 'listing', '2020-12-31'], [5, 'closed_sale', null], [6, 'closed_sale', 'infinity'],
  [7, 'closed_sale', '2020-12-31'], [8, 'closed_sale', '2020-12-31'], [9, 'closed_sale', '2019-12-31'],
  [10, 'closed_sale', '2020-12-31'], [11, 'closed_sale', '2020-12-31'], [12, null, '2020-12-31'],
  [21, 'closed_sale', '2020-12-31'], [22, 'closed_sale', '2021-01-01'], [23, 'closed_sale', '2022-01-01'],
  [24, 'listing', '2020-12-31'], [25, 'closed_sale', null], [26, 'closed_sale', 'infinity'],
  [27, 'closed_sale', '-infinity'], [28, null, '2020-12-31'],
];
const SALES = [
  [101, 1, '2020-12-31'], [102, 1, '2020-12-31'], [103, 2, '2021-01-01'], [104, 3, '2022-01-01'],
  [105, 4, '2020-12-31'], [106, 5, '2020-12-31'], [107, 6, '2020-12-31'], [108, 7, null],
  [109, 8, '-infinity'], [110, 9, '2020-12-31'], [111, 10, '2020-12-31'], [112, 10, '2021-01-01'],
  [113, 11, '2020-12-31'], [114, 11, null], [115, 12, '2020-12-31'], [116, 999, '2020-12-31'],
  [201, null, '2020-12-31'], [202, null, '2021-01-01'], [203, null, '2022-01-01'],
  [204, null, null], [205, null, 'infinity'], [206, null, '-infinity'],
];
const count = (total, before, after, nonclosed, missing, nonfinite, conflict = 0, orphan = 0) => ({
  total: String(total), review_before_cutoff: String(before), not_before_cutoff: String(after),
  excluded_nonclosed: String(nonclosed), excluded_missing_date: String(missing), excluded_nonfinite_date: String(nonfinite),
  excluded_conflicting_date: String(conflict), excluded_missing_source: String(orphan),
});
const expectedLanes = year => ({
  canonical_source_linked: count(16, year === 2026 ? 4 : 5, year === 2026 ? 2 : 1, 2, 3, 2, 2, 1),
  canonical_legacy: count(6, year === 2026 ? 1 : 2, year === 2026 ? 2 : 1, 0, 1, 2),
  source_only: count(8, year === 2026 ? 1 : 2, year === 2026 ? 2 : 1, 2, 1, 2),
});
const sqlText = query => typeof query === 'string' ? query : query.text;
const executable = query => sqlText(query).replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '').trim();

/** Import-safe: no environment/driver/database activity until explicitly called.
 * Requires a fresh, caller-created test database; no shared schema fallback,
 * schema cleanup, database creation/drop, roles, global settings or native
 * service startup. All setup writes below are clearly synthetic fixture work.
 */
export async function runSalesRetentionAuditDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  assert.match(target.databaseName, /^sales_retention_[a-f0-9]{32}_test$/, 'requires a fresh explicitly named sales-retention test database');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 3, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'sales_retention_audit_native_test' });
  const checks = [];
  try {
    const probe = await pool.connect();
    try {
      verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
        probe.connection?.stream?.remoteAddress, target.databaseName);
      assert.equal((await probe.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('core','app')")).rowCount, 0,
        'refuse any existing application/test schema before fixture writes');
    } finally { probe.release(); }
    const run = async (options, onFirstRead) => {
      const calls = [], snapshots = [], releases = []; let connects = 0, firstRead = true;
      const wrapped = { async connect() {
        connects++; const client = await pool.connect();
        return { getTransactionStatus: () => client.getTransactionStatus(),
          release(error) { releases.push(error); client.release(error); }, async query(config, values) {
          const text = executable(config); calls.push(text);
          assert.match(text, /^(?:BEGIN\b|SET\b|SELECT\b|WITH\b|COMMIT\b|ROLLBACK\b)/i, 'audit must issue read/transaction statements only');
          assert.doesNotMatch(text, /^(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY)\b/i);
          const result = await client.query(config, values);
          if (/^(?:SELECT|WITH)\b/i.test(text)) {
            const state = (await client.query(`SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS read_only,current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout') AS lock_timeout,pg_current_snapshot()::text AS snapshot,
              transaction_timestamp()::text AS transaction_started_at`)).rows[0];
            assert.equal(state.isolation, 'repeatable read'); assert.equal(state.read_only, 'on');
            assert.notEqual(state.statement_timeout, '0'); assert.notEqual(state.lock_timeout, '0');
            snapshots.push(state);
            if (firstRead) { firstRead = false; if (onFirstRead) await onFirstRead(); }
          }
          return result;
        } };
      } };
      const result = await auditSalesRetention(wrapped, options);
      assert.equal(connects, 1); assert.deepEqual(releases, [undefined]);
      assert.equal(calls.filter(text => /^BEGIN\b/i.test(text)).length, 1);
      assert.equal(calls.at(-1), 'COMMIT'); assert.ok(snapshots.length > 0);
      for (const state of snapshots) assert.deepEqual(state, snapshots[0], 'all audit reads use one actual native snapshot and transaction');
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_FILENAME|SYNTHETIC_PRIVATE_ROW/);
      return result;
    };
    const absent = await run({ asOfDate: '2026-09-10' });
    assert.equal(absent.cohorts.status, 'unavailable');
    assert.equal(absent.cohorts.lanes, null); assert.equal(absent.cohorts.distinct_review_source_records, null);
    assert.equal((await pool.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('core','app')")).rowCount, 0);
    await pool.query(REQUIRED_SCHEMA);
    const incompatible = await run({ asOfDate: '2026-09-10' });
    assert.equal(incompatible.cohorts.status, 'unavailable', 'text closing dates are not silently treated as installed date columns');
    await pool.query('ALTER TABLE core.sales ALTER COLUMN closing_date TYPE date USING closing_date::date');
    for (const values of SOURCES) await pool.query('INSERT INTO core.sales_source_records(id,record_type,close_date) VALUES($1,$2,$3::date)', values);
    for (const values of SALES) await pool.query('INSERT INTO core.sales(id,source_record_id,closing_date) VALUES($1,$2,$3::date)', values);
    checks.push('native missing/incompatible required schema is unavailable; actual single RR read-only transaction and no implicit schema setup');
    const rows = async () => ({
      sources: (await pool.query('SELECT id::text,record_type,close_date::text,source_filename,raw_payload FROM core.sales_source_records ORDER BY id')).rows,
      sales: (await pool.query('SELECT id::text,source_record_id::text,closing_date::text FROM core.sales ORDER BY id')).rows,
    });
    const before = await rows();
    const initial = {};
    for (const year of [2026, 2027]) {
      const result = await run({ asOfDate: `${year}-09-10` });
      assert.equal(result.cohorts.status, 'complete'); assert.deepEqual(result.cohorts.lanes, expectedLanes(year));
      assert.equal(result.cutoff_date, `${year - 5}-01-01`);
      assert.equal(result.cohorts.distinct_review_source_records, year === 2026 ? '2' : '4',
        'duplicate canonical rows count once per source; any ineligible linked sibling prevents source review');
      assert.equal(result.mode, 'review_only'); assert.equal(result.automatic_deletion, false);
      assert.equal(result.protection.coverage, 'not_established'); assert.equal(result.reclaimable_bytes, null);
      assert.deepEqual(result.samples.rows, []); assert.equal(result.samples.returned_count, 0);
      assert.equal(result.samples.truncated, true);
      for (const dependency of result.dependencies.filter(d => d.relation !== 'core.sales')) {
        assert.equal(dependency.status, 'unavailable'); assert.equal(dependency.reason, 'not_installed');
        assert.equal(dependency.review_source_row_count, null, 'missing optional dependencies are unknown, not zero');
      }
      initial[year] = result;
      assert.deepEqual(await rows(), before);
    }
    checks.push('native exclusive 2021/2022 cutoffs classify closed/source-only/legacy lanes, canonical conflicts, missing/nonfinite dates and orphan references without multiplying canonical rows');

    // Real catalog metadata, not hardcoded production assumptions. Deliberately
    // use different delete actions and an unvalidated history FK; the audit
    // inventories these declarations and never exercises a deletion.
    await pool.query(`CREATE TABLE core.sale_parcels(id bigint PRIMARY KEY,source_record_id bigint,
      CONSTRAINT synthetic_parcels_source_fk FOREIGN KEY(source_record_id) REFERENCES core.sales_source_records(id) ON DELETE CASCADE);
      CREATE TABLE core.sales_source_media(id bigint PRIMARY KEY,source_record_id bigint,
        CONSTRAINT synthetic_media_source_fk FOREIGN KEY(source_record_id) REFERENCES core.sales_source_records(id) ON DELETE RESTRICT);
      CREATE TABLE app.sale_characteristic_reviews(source_record_id bigint PRIMARY KEY,
        CONSTRAINT synthetic_current_review_source_fk FOREIGN KEY(source_record_id) REFERENCES core.sales_source_records(id) ON DELETE CASCADE);
      CREATE TABLE app.sale_characteristic_review_history(id bigint PRIMARY KEY,source_record_id bigint);
      ALTER TABLE app.sale_characteristic_review_history ADD CONSTRAINT synthetic_history_source_fk
        FOREIGN KEY(source_record_id) REFERENCES core.sales_source_records(id) ON DELETE NO ACTION NOT VALID;
      CREATE TABLE app.sales_reconciliation_history(source_record_id text);
      CREATE TABLE core.synthetic_retention_links(id bigint PRIMARY KEY,source_record_id bigint,
        CONSTRAINT synthetic_unknown_source_fk FOREIGN KEY(source_record_id) REFERENCES core.sales_source_records(id) ON DELETE RESTRICT);
      CREATE TABLE app.synthetic_retention_notes(id bigint PRIMARY KEY,parent_id bigint,
        CONSTRAINT synthetic_transitive_link_fk FOREIGN KEY(parent_id) REFERENCES core.synthetic_retention_links(id) ON DELETE CASCADE);
      CREATE FUNCTION app.synthetic_retention_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$;
      CREATE TRIGGER synthetic_retention_observation AFTER UPDATE ON core.sales
        FOR EACH ROW EXECUTE FUNCTION app.synthetic_retention_noop();
      CREATE TABLE app.report_file_archives(id bigint PRIMARY KEY,legal_hold boolean,retention_until timestamptz);`);
    const children = {
      'core.sale_parcels': [1, 1, 1, 21, 21, 10, 10, 10, 10, 2],
      'core.sales_source_media': [1, 1, 21, 2, 2, 22, 9],
      'app.sale_characteristic_review_history': [1, 1, 21, 21, 21, 2, 2, 2, 2, 22, 10, 10],
    };
    for (const [relation, sources] of Object.entries(children)) {
      for (const [index, source] of sources.entries()) await pool.query(`INSERT INTO ${relation}(id,source_record_id) VALUES($1,$2)`, [index + 1, source]);
    }
    await pool.query(`INSERT INTO app.sale_characteristic_reviews(source_record_id) VALUES(1),(21),(10),(2);
      INSERT INTO app.sales_reconciliation_history(source_record_id) VALUES('1');
      INSERT INTO core.synthetic_retention_links(id,source_record_id) VALUES(1,1);
      INSERT INTO app.synthetic_retention_notes(id,parent_id) VALUES(1,1);
      INSERT INTO app.report_file_archives VALUES
        (1,true,'2026-09-10T00:00:00Z'),(2,false,'2026-09-09T23:59:59Z'),(3,NULL,NULL),(4,false,'infinity');`);
    const dependencies = year => ({
      'core.sales': year === 2026 ? '2' : '3', 'core.sale_parcels': year === 2026 ? '5' : '6',
      'core.sales_source_media': year === 2026 ? '3' : '6', 'app.sale_characteristic_reviews': year === 2026 ? '2' : '3',
      'app.sale_characteristic_review_history': year === 2026 ? '5' : '10',
    });
    const childRows = async () => {
      const result = {};
      for (const relation of [...Object.keys(children), 'app.sale_characteristic_reviews', 'app.sales_reconciliation_history',
        'core.synthetic_retention_links', 'app.synthetic_retention_notes', 'app.report_file_archives']) {
        result[relation] = (await pool.query(`SELECT to_jsonb(d) AS value FROM ${relation} d ORDER BY to_jsonb(d)::text COLLATE "C"`)).rows;
      }
      return result;
    };
    const childrenBefore = await childRows(), installed = {};
    for (const year of [2026, 2027]) {
      const result = await run({ asOfDate: `${year}-09-10`, sampleLimit: 50 }); installed[year] = result;
      assert.deepEqual(result.cohorts, initial[year].cohorts, 'adding child multiplicity cannot change the canonical/source cohort');
      for (const [relation, value] of Object.entries(dependencies(year))) {
        assert.deepEqual(result.dependencies.find(d => d.relation === relation),
          { relation, status: 'complete', reason: null, review_source_row_count: value });
      }
      assert.deepEqual(result.dependencies.find(d => d.relation === 'app.sales_reconciliation_history'), {
        relation: 'app.sales_reconciliation_history', status: 'unavailable', reason: 'incompatible_schema', review_source_row_count: null,
      });
      assert.equal(result.holds.status, 'not_established'); assert.equal(result.holds.scope, 'global_inventory_not_candidate_protection');
      assert.deepEqual(result.holds.inventories.find(h => h.relation === 'app.report_file_archives'), {
        relation: 'app.report_file_archives', status: 'complete', reason: null, total_rows: '4', legal_hold_rows: '1',
        retention_not_expired_as_of_date_rows: year === 2026 ? '2' : '1', missing_retention_date_rows: '1',
      });
      assert.equal(result.holds.inventories.find(h => h.relation === 'app.inspection_photos').total_rows, null);
      assert.equal(result.samples.returned_count, year === 2026 ? 6 : 9); assert.equal(result.samples.truncated, false);
      assert.ok(result.samples.rows.some(r => r.lane === 'canonical_source_linked' && r.source_record_id === '10'),
        'row review samples do not falsely mean the entire conflicting source is a deletion candidate');
      assert.deepEqual(await rows(), before); assert.deepEqual(await childRows(), childrenBefore);
    }
    checks.push('native dependent rows count distinct eligible source membership without join multiplication; missing/incompatible dependencies and global holds remain explicit protection gaps');
    const metadata = installed[2026].metadata;
    assert.equal(metadata.foreign_keys.total_count, '6'); assert.equal(metadata.foreign_keys.truncated, false);
    for (const [name, relation, referenced, action, validated, allowlisted] of [
      ['synthetic_parcels_source_fk', 'core.sale_parcels', 'core.sales_source_records', 'cascade', true, true],
      ['synthetic_media_source_fk', 'core.sales_source_media', 'core.sales_source_records', 'restrict', true, true],
      ['synthetic_current_review_source_fk', 'app.sale_characteristic_reviews', 'core.sales_source_records', 'cascade', true, true],
      ['synthetic_history_source_fk', 'app.sale_characteristic_review_history', 'core.sales_source_records', 'no_action', false, true],
      ['synthetic_unknown_source_fk', 'core.synthetic_retention_links', 'core.sales_source_records', 'restrict', true, false],
      ['synthetic_transitive_link_fk', 'app.synthetic_retention_notes', 'core.synthetic_retention_links', 'cascade', true, false],
    ]) {
      const key = metadata.foreign_keys.rows.find(row => row.name === name); assert.ok(key, name);
      assert.equal(key.relation, relation); assert.equal(key.referenced_relation, referenced); assert.equal(key.delete_action, action);
      assert.equal(key.validated, validated); assert.equal(key.allowlisted_direct_source_dependency, allowlisted);
      assert.deepEqual(key.columns, [name === 'synthetic_transitive_link_fk' ? 'parent_id' : 'source_record_id']);
      assert.deepEqual(key.referenced_columns, ['id']);
    }
    assert.equal(metadata.triggers.total_count, '1'); assert.equal(metadata.triggers.rows[0].name, 'synthetic_retention_observation');
    assert.equal(metadata.triggers.rows[0].relation, 'core.sales');
    assert.ok(installed[2026].issues.some(issue => issue.code === 'unmeasured_foreign_key_dependency'));
    assert.ok(installed[2026].issues.some(issue => issue.code === 'trigger_effects_not_evaluated'));
    checks.push('native FK catalog reports real actions, unvalidated and unknown/transitive references; actual user trigger remains an unevaluated effect, never deletion approval');

    const sample = await run({ asOfDate: '2026-09-10', sampleLimit: 2 });
    assert.deepEqual(sample.samples.rows, [
      { lane: 'canonical_legacy', id: '201', source_record_id: null },
      { lane: 'canonical_source_linked', id: '101', source_record_id: '1' },
    ]);
    assert.equal(sample.samples.truncated, true); assert.equal(sample.samples.returned_count, 2);
    assert.deepEqual(sample.cohorts, installed[2026].cohorts);
    const appendedId = '9007199254740993'; let appended = false;
    const snapshotAudit = await run({ asOfDate: '2026-09-10', sampleLimit: 50 }, async () => {
      const inserted = await pool.query('INSERT INTO core.sales_source_records(id,record_type,close_date) VALUES($1,\'closed_sale\',\'2020-12-31\')', [appendedId]);
      assert.equal(inserted.rowCount, 1); appended = true;
    });
    assert.ok(appended); assert.deepEqual(snapshotAudit.cohorts, installed[2026].cohorts);
    assert.deepEqual(snapshotAudit.dependencies, installed[2026].dependencies);
    assert.deepEqual(snapshotAudit.samples, installed[2026].samples);
    const afterAppend = await rows();
    assert.deepEqual(afterAppend.sources.filter(row => row.id !== appendedId), before.sources);
    assert.deepEqual(afterAppend.sales, before.sales); assert.deepEqual(await childRows(), childrenBefore);
    const next = await run({ asOfDate: '2026-09-10', sampleLimit: 50 });
    assert.equal(next.cohorts.lanes.source_only.total, '9'); assert.equal(next.cohorts.lanes.source_only.review_before_cutoff, '2');
    assert.equal(next.cohorts.distinct_review_source_records, '3');
    assert.deepEqual(next.cohorts.lanes.canonical_source_linked, expectedLanes(2026).canonical_source_linked);
    assert.deepEqual(next.cohorts.lanes.canonical_legacy, expectedLanes(2026).canonical_legacy);
    assert.deepEqual(next.samples.rows.find(row => row.id === appendedId), { lane: 'source_only', id: appendedId, source_record_id: appendedId });
    assert.deepEqual(await rows(), afterAppend); assert.deepEqual(await childRows(), childrenBefore);
    checks.push('native bounded deterministic samples preserve bigint identities; second-client insert is invisible throughout the RR audit and visible only in a subsequent audit');

    // BEGIN in an existing transaction can preserve earlier pending writes even
    // when its requested modes are applied. Delegate the driver's real status:
    // the audit must refuse this already-active transaction before any BEGIN.
    const poisoned = await pool.connect(), pendingId = '9007199254740994';
    const poisonedCalls = [], poisonedReleases = []; let poisonedConnects = 0, released = false, refusal;
    try {
      await poisoned.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
      assert.deepEqual((await poisoned.query(`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS read_only`)).rows[0], { isolation: 'repeatable read', read_only: 'off' });
      assert.equal((await poisoned.query(`INSERT INTO core.sales_source_records(id,record_type,close_date)
        VALUES($1,'closed_sale','2020-12-31')`, [pendingId])).rowCount, 1);
      assert.equal((await pool.query('SELECT id FROM core.sales_source_records WHERE id=$1', [pendingId])).rowCount, 0,
        'synthetic leaked-transaction row is not committed before the audit');
      await assert.rejects(() => auditSalesRetention({ async connect() {
        poisonedConnects++;
        return {
          getTransactionStatus: () => poisoned.getTransactionStatus(),
          async query(config, values) { poisonedCalls.push(sqlText(config)); return poisoned.query(config, values); },
          release(error) { poisonedReleases.push(error); released = true; poisoned.release(error); },
        };
      } }, { asOfDate: '2026-09-10' }), error => {
        assert.equal(error.code, 'sales_retention_audit_transaction_state');
        assert.equal(error.message, 'sales_retention_audit_transaction_state'); refusal = error; return true;
      });
      assert.equal(poisonedConnects, 1); assert.deepEqual(poisonedReleases, [refusal]);
      assert.deepEqual(poisonedCalls, ['ROLLBACK'], 'active transaction is refused before BEGIN, settings or inventory');
      assert.ok(poisonedCalls.every(sql => !/^COMMIT\b/i.test(sql) && !/sales-retention:(?:schema|cohorts|samples|dependencies|foreign-keys|triggers|holds)/.test(sql)),
        'poisoned transaction must never be committed or used for inventory');
    } finally {
      if (!released) {
        try { await poisoned.query('ROLLBACK'); } finally { poisoned.release(new Error('Synthetic poisoned-client cleanup')); }
      }
    }
    assert.equal((await pool.query('SELECT id FROM core.sales_source_records WHERE id=$1', [pendingId])).rowCount, 0,
      'actual audit refusal rolls back the pending synthetic write');
    assert.deepEqual(await rows(), afterAppend); assert.deepEqual(await childRows(), childrenBefore);
    checks.push('native leaked RR read-write transaction is refused before inventory, rolled back and discarded without committing its pending synthetic row');
    return { checks, cohorts: { as_of_2026: initial[2026].cohorts, as_of_2027: initial[2027].cohorts },
      native_snapshot: 'repeatable_read_read_only', foreign_keys_observed: metadata.foreign_keys.total_count,
      fixture_records_preserved: true, concurrent_fixture_insert_preserved: true };
  } finally { await pool.end(); }
}
