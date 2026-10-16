import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureAccountQualitySchema } from '../src/services/accountQuality.js';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';

test('native account-quality startup avoids redundant DDL locks and refuses catalog drift', {
  skip: !process.env.DATABASE_URL, timeout: 90_000,
}, async () => {
  // The existing CI helper creates a fresh guarded loopback *_test database;
  // it refuses a local/non-CI/production target before any connection or DDL.
  const target = await prepareNeighborhoodCiDatabase();
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 2,
    connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  let blocker, reader;
  try {
    // Prove fresh creation/verification and normal repeated boot first.
    await ensureAccountQualitySchema(pool);
    await ensureAccountQualitySchema(pool);
    blocker = await pool.connect(); reader = await pool.connect();
    await reader.query("SET lock_timeout='150ms'");
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE core.accounts IN ACCESS SHARE MODE');
    // This is the old boot's actual unnecessary lock request, not a timer or
    // mocked lock oracle. The long reader remains held throughout both calls.
    await assert.rejects(reader.query(`ALTER TABLE core.accounts
      ADD COLUMN IF NOT EXISTS data_quality_status text`), error => error.code === '55P03');
    const calls = [];
    await ensureAccountQualitySchema({ async query(sql) { calls.push(sql); return reader.query(sql); } });
    assert.equal(calls.length, 1); assert.match(calls[0], /account-quality:schema-ready/);
    assert.equal((await blocker.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
      WHERE pid=pg_backend_pid() AND relation='core.accounts'::regclass
        AND mode='AccessShareLock' AND granted) AS held`)).rows[0].held, true);
    await blocker.query('ROLLBACK'); blocker.release(); blocker = null;
    reader.release(); reader = null;

    // Missing index needs genuine idempotent DDL; renaming a disposable index
    // leaves every original row intact and avoids any production dependency.
    await pool.query('ALTER INDEX core.accounts_canonical_account_idx RENAME TO prior_canonical_account_idx');
    await ensureAccountQualitySchema(pool);
    assert.ok((await pool.query("SELECT to_regclass('core.accounts_canonical_account_idx')::text AS name")).rows[0].name);
    // An existing wrong column type cannot be fixed by ADD IF NOT EXISTS.
    // Post-DDL verification must refuse it instead of declaring readiness.
    await pool.query('ALTER TABLE core.accounts ALTER COLUMN canonical_account_id TYPE varchar(100)');
    await assert.rejects(ensureAccountQualitySchema(pool), /account_quality_schema_unavailable/);
    await pool.query('ALTER TABLE core.accounts ALTER COLUMN canonical_account_id TYPE text');
    await ensureAccountQualitySchema(pool);
    console.info('[native-account-quality-startup-schema-preflight]', {
      actual_unnecessary_ALTER_refused_while_reader_lock_held: true,
      actual_catalog_only_ready_probe_succeeds_under_same_lock: true,
      fresh_creation_and_missing_index_repair_verified: true,
      existing_wrong_type_refused_after_DDL_not_marked_ready: true,
      restored_schema_reopens: true, no_readiness_bypass_or_deadline_increase: true,
    });
  } finally {
    if (reader) reader.release();
    if (blocker) { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
    await pool.end();
  }
});
