// Startup used to request ACCESS EXCLUSIVE on core.accounts on every boot,
// even when all columns already existed. A long reader could then make an
// otherwise ready instance fail its required initialization permanently.
// Inspect only the fixed catalog objects first; never use a table-row scan or
// relax the existing DDL/query timeout or the required-readiness gate.
const ACCOUNT_QUALITY_SCHEMA_READY_SQL = `/* account-quality:schema-ready */
  WITH expected(relation_name, column_name, type_name, required) AS (VALUES
    ('core.accounts','data_quality_status','text',false),
    ('core.accounts','data_quality_flags','text[]',true),
    ('core.accounts','canonical_account_id','text',false),
    ('app.dcad_account_reconciliations','source_account_id','text',true),
    ('app.dcad_account_reconciliations','canonical_account_id','text',false),
    ('app.dcad_account_reconciliations','source_address','text',false),
    ('app.dcad_account_reconciliations','source_city','text',false),
    ('app.dcad_account_reconciliations','source_postal_code','text',false),
    ('app.dcad_account_reconciliations','status','text',true),
    ('app.dcad_account_reconciliations','match_method','text',false),
    ('app.dcad_account_reconciliations','match_confidence','numeric',false),
    ('app.dcad_account_reconciliations','candidate_count','integer',true),
    ('app.dcad_account_reconciliations','attempts','integer',true),
    ('app.dcad_account_reconciliations','next_attempt_at','timestamp with time zone',true),
    ('app.dcad_account_reconciliations','last_attempt_at','timestamp with time zone',false),
    ('app.dcad_account_reconciliations','lease_expires_at','timestamp with time zone',false),
    ('app.dcad_account_reconciliations','worker_id','text',false),
    ('app.dcad_account_reconciliations','last_error','text',false),
    ('app.dcad_account_reconciliations','evidence','jsonb',true),
    ('app.dcad_account_reconciliations','resolved_at','timestamp with time zone',false),
    ('app.dcad_account_reconciliations','created_at','timestamp with time zone',true),
    ('app.dcad_account_reconciliations','updated_at','timestamp with time zone',true)
  ) SELECT NOT EXISTS (
    SELECT 1 FROM expected e
    LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(e.relation_name) AND c.relkind IN ('r','p')
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name
      AND a.attnum>0 AND NOT a.attisdropped
    WHERE a.attname IS NULL OR a.atttypid<>pg_catalog.to_regtype(e.type_name)
      OR a.attnotnull<>e.required
      OR (e.column_name='match_confidence' AND pg_catalog.format_type(a.atttypid,a.atttypmod)<>'numeric(5,4)')
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=pg_catalog.to_regclass('core.accounts') AND a.attname='data_quality_flags'
      AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='ARRAY[]::text[]'
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint p
    JOIN pg_catalog.pg_attribute a ON a.attrelid=p.conrelid AND a.attname='source_account_id'
    WHERE p.conrelid=pg_catalog.to_regclass('app.dcad_account_reconciliations')
      AND p.contype='p' AND p.convalidated AND p.conkey=ARRAY[a.attnum]::smallint[]
  ) AND EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=c.relam AND am.amname='btree'
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attname='canonical_account_id'
    WHERE i.indexrelid=pg_catalog.to_regclass('core.accounts_canonical_account_idx')
      AND i.indrelid=pg_catalog.to_regclass('core.accounts') AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=a.attnum
      AND i.indexprs IS NULL AND pg_catalog.pg_get_expr(i.indpred,i.indrelid)='(canonical_account_id IS NOT NULL)'
  ) AS ready`;

async function accountQualitySchemaReady(pool) {
  const result = await pool.query(ACCOUNT_QUALITY_SCHEMA_READY_SQL);
  if (result?.rows?.length !== 1 || typeof result.rows[0].ready !== 'boolean') {
    throw new Error('account_quality_schema_probe_invalid');
  }
  return result.rows[0].ready;
}

export async function ensureAccountQualitySchema(pool) {
  if (await accountQualitySchemaReady(pool)) return;
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    ALTER TABLE core.accounts
      ADD COLUMN IF NOT EXISTS data_quality_status text,
      ADD COLUMN IF NOT EXISTS data_quality_flags text[] NOT NULL DEFAULT ARRAY[]::text[],
      ADD COLUMN IF NOT EXISTS canonical_account_id text;

    CREATE TABLE IF NOT EXISTS app.dcad_account_reconciliations (
      source_account_id     text PRIMARY KEY,
      canonical_account_id  text,
      source_address        text,
      source_city           text,
      source_postal_code    text,
      status                text NOT NULL DEFAULT 'pending_search',
      match_method          text,
      match_confidence      numeric(5, 4),
      candidate_count       integer NOT NULL DEFAULT 0,
      attempts              integer NOT NULL DEFAULT 0,
      next_attempt_at       timestamptz NOT NULL DEFAULT now(),
      last_attempt_at       timestamptz,
      lease_expires_at      timestamptz,
      worker_id             text,
      last_error            text,
      evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
      resolved_at           timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS accounts_canonical_account_idx
      ON core.accounts (canonical_account_id)
      WHERE canonical_account_id IS NOT NULL;
  `);
  if (!await accountQualitySchemaReady(pool)) throw new Error('account_quality_schema_unavailable');
}

export async function resolveCanonicalAccountId(pool, requestedAccountId) {
  let current = String(requestedAccountId || "").trim().toUpperCase();
  const visited = new Set();
  for (let depth = 0; depth < 5 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    const { rows } = await pool.query(
      `SELECT NULLIF(BTRIM(canonical_account_id), '') AS canonical_account_id
       FROM core.accounts
       WHERE account_id = $1`,
      [current],
    );
    const next = String(rows?.[0]?.canonical_account_id || "").trim().toUpperCase();
    if (!next || next === current) break;
    current = next;
  }
  return current;
}
