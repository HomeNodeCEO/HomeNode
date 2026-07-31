export async function ensureAccountQualitySchema(pool) {
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
