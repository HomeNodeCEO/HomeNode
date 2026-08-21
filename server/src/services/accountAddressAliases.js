import {
  normalizePropertyAddress,
  normalizePropertyCity,
  normalizeSearchText,
} from "../util/propertySearch.js";

const ALIAS_SEED_LOCK_A = 48_632_941;
const ALIAS_SEED_LOCK_B = 20_260_821;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function normalizeAddressAliasEvidence({
  address,
  city,
  county,
  postalCode,
} = {}) {
  const addressKey = normalizePropertyAddress(
    String(address || "").split(",", 1)[0],
  ).slice(0, 500);
  const cityKey = normalizePropertyCity(city).slice(0, 200);
  const countyKey = normalizeSearchText(county)
    .replace(/\s+COUNTY$/, "")
    .trim()
    .slice(0, 100);
  const postalCode5 = String(postalCode || "").match(/\b\d{5}\b/)?.[0] || null;
  return {
    address_key: addressKey || null,
    city_key: cityKey || null,
    county_key: countyKey || null,
    postal_code5: postalCode5,
  };
}

export async function ensureAccountAddressAliasSchema(pool) {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS app;

    CREATE TABLE IF NOT EXISTS app.account_address_aliases (
      account_id          text NOT NULL
                            REFERENCES core.accounts(account_id)
                            ON DELETE CASCADE,
      address_key         text NOT NULL,
      city_key            text NOT NULL,
      county_key          text,
      postal_code5        text,
      raw_address         text,
      raw_city            text,
      source_type         text NOT NULL DEFAULT 'core_accounts',
      source_priority     smallint NOT NULL DEFAULT 100,
      is_current          boolean NOT NULL DEFAULT true,
      source_observed_at  timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, address_key, city_key, source_type)
    );

    CREATE INDEX IF NOT EXISTS account_address_aliases_lookup_idx
      ON app.account_address_aliases (
        address_key, city_key, county_key, postal_code5, account_id
      )
      WHERE is_current = true;

    CREATE INDEX IF NOT EXISTS account_address_aliases_account_idx
      ON app.account_address_aliases (account_id, is_current, source_priority DESC);

    CREATE TABLE IF NOT EXISTS app.account_address_alias_seed_state (
      source_type       text PRIMARY KEY,
      last_account_id   text,
      cycle_started_at  timestamptz NOT NULL DEFAULT now(),
      cycle_completed_at timestamptz,
      next_refresh_at   timestamptz,
      rows_scanned      bigint NOT NULL DEFAULT 0,
      aliases_written   bigint NOT NULL DEFAULT 0,
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function aliasRecord(account) {
  const evidence = normalizeAddressAliasEvidence({
    address: account.address,
    city: account.city,
    county: account.county,
    postalCode: account.postal_code,
  });
  if (!evidence.address_key || !evidence.city_key) return null;
  return {
    account_id: account.account_id,
    ...evidence,
    raw_address: account.address || null,
    raw_city: account.city || null,
    source_type: "core_accounts",
    source_priority: 100,
  };
}

/**
 * Incrementally materialize current CAD situs addresses into a compact lookup
 * table. A completed pass is refreshed weekly; normal maintenance can run this
 * repeatedly without rescanning the full account inventory every time.
 */
export async function seedAccountAddressAliasBatch(pool, {
  batchSize = 10_000,
  forceRefresh = false,
  refreshDays = 7,
} = {}) {
  const safeBatchSize = boundedInteger(batchSize, 10_000, 1, 25_000);
  const safeRefreshDays = boundedInteger(refreshDays, 7, 1, 90);
  await ensureAccountAddressAliasSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
      [ALIAS_SEED_LOCK_A, ALIAS_SEED_LOCK_B],
    );
    if (!lock.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return { skipped: true, reason: "alias_seed_already_running", scanned: 0, written: 0 };
    }

    await client.query(
      `INSERT INTO app.account_address_alias_seed_state (source_type)
       VALUES ('core_accounts') ON CONFLICT (source_type) DO NOTHING`,
    );
    const stateResult = await client.query(
      `SELECT * FROM app.account_address_alias_seed_state
       WHERE source_type = 'core_accounts' FOR UPDATE`,
    );
    const state = stateResult.rows[0];
    const refreshDue = forceRefresh || !state.cycle_completed_at ||
      !state.next_refresh_at || new Date(state.next_refresh_at) <= new Date();
    if (state.cycle_completed_at && !refreshDue) {
      await client.query("COMMIT");
      return {
        skipped: true,
        reason: "alias_index_current",
        scanned: 0,
        written: 0,
        next_refresh_at: state.next_refresh_at,
      };
    }

    let cursor = state.last_account_id;
    if (state.cycle_completed_at && refreshDue) {
      cursor = null;
      await client.query(
        `UPDATE app.account_address_alias_seed_state
         SET last_account_id = NULL, cycle_started_at = now(),
             cycle_completed_at = NULL, next_refresh_at = NULL,
             rows_scanned = 0, aliases_written = 0, updated_at = now()
         WHERE source_type = 'core_accounts'`,
      );
    }

    const accountsResult = await client.query(
      `SELECT account_id, address, city, county, postal_code
       FROM core.accounts
       WHERE canonical_account_id IS NULL
         AND NULLIF(btrim(address), '') IS NOT NULL
         AND NULLIF(btrim(city), '') IS NOT NULL
         AND ($1::text IS NULL OR account_id > $1)
       ORDER BY account_id
       LIMIT $2`,
      [cursor, safeBatchSize],
    );
    const accounts = accountsResult.rows;
    const aliases = accounts.map(aliasRecord).filter(Boolean);
    const accountIds = accounts.map((row) => row.account_id);

    if (accountIds.length) {
      await client.query(
        `UPDATE app.account_address_aliases
         SET is_current = false, updated_at = now()
         WHERE source_type = 'core_accounts' AND account_id = ANY($1::text[])`,
        [accountIds],
      );
    }
    if (aliases.length) {
      await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
             account_id text, address_key text, city_key text, county_key text,
             postal_code5 text, raw_address text, raw_city text,
             source_type text, source_priority smallint
           )
         )
         INSERT INTO app.account_address_aliases (
           account_id, address_key, city_key, county_key, postal_code5,
           raw_address, raw_city, source_type, source_priority, is_current,
           source_observed_at, updated_at
         )
         SELECT account_id, address_key, city_key, county_key, postal_code5,
                raw_address, raw_city, source_type, source_priority, true,
                now(), now()
         FROM input
         ON CONFLICT (account_id, address_key, city_key, source_type)
         DO UPDATE SET county_key = EXCLUDED.county_key,
                       postal_code5 = EXCLUDED.postal_code5,
                       raw_address = EXCLUDED.raw_address,
                       raw_city = EXCLUDED.raw_city,
                       source_priority = EXCLUDED.source_priority,
                       is_current = true,
                       source_observed_at = EXCLUDED.source_observed_at,
                       updated_at = now()`,
        [JSON.stringify(aliases)],
      );
    }

    const completed = accounts.length < safeBatchSize;
    const lastAccountId = accounts.at(-1)?.account_id || cursor;
    await client.query(
      `UPDATE app.account_address_alias_seed_state
       SET last_account_id = $1,
           cycle_completed_at = CASE WHEN $2 THEN now() ELSE NULL END,
           next_refresh_at = CASE WHEN $2 THEN now() + ($3 * interval '1 day') ELSE NULL END,
           rows_scanned = rows_scanned + $4,
           aliases_written = aliases_written + $5,
           updated_at = now()
       WHERE source_type = 'core_accounts'`,
      [lastAccountId, completed, safeRefreshDays, accounts.length, aliases.length],
    );
    await client.query("COMMIT");
    return {
      skipped: false,
      scanned: accounts.length,
      written: aliases.length,
      completed,
      last_account_id: lastAccountId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveUniqueAddressAliases(queryable, requests) {
  if (!requests.length) return new Map();
  const { rows } = await queryable.query(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
         request_id text, address_key text, city_key text,
         county_key text, postal_code5 text
       )
     ), candidates AS (
       SELECT DISTINCT request.request_id, alias.account_id
       FROM requested request
       JOIN app.account_address_aliases alias
         ON alias.is_current = true
        AND alias.address_key = request.address_key
        AND alias.city_key = request.city_key
        AND (request.county_key IS NULL OR alias.county_key = request.county_key)
        AND (request.postal_code5 IS NULL OR alias.postal_code5 = request.postal_code5)
       JOIN core.accounts account
         ON account.account_id = alias.account_id
        AND account.canonical_account_id IS NULL
     ), unique_candidates AS (
       SELECT request_id, MIN(account_id) AS account_id
       FROM candidates
       GROUP BY request_id
       HAVING COUNT(DISTINCT account_id) = 1
     )
     SELECT request_id, account_id FROM unique_candidates`,
    [JSON.stringify(requests)],
  );
  return new Map(rows.map((row) => [String(row.request_id), row.account_id]));
}

export async function getAccountAddressAliasStatus(pool) {
  await ensureAccountAddressAliasSchema(pool);
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::bigint FROM app.account_address_aliases
        WHERE is_current = true) AS current_aliases,
       (SELECT COUNT(DISTINCT account_id)::bigint FROM app.account_address_aliases
        WHERE is_current = true) AS indexed_accounts,
       state.last_account_id, state.cycle_started_at, state.cycle_completed_at,
       state.next_refresh_at, state.rows_scanned, state.aliases_written
     FROM app.account_address_alias_seed_state state
     WHERE state.source_type = 'core_accounts'`,
  );
  return rows[0] || {
    current_aliases: 0,
    indexed_accounts: 0,
    last_account_id: null,
    cycle_started_at: null,
    cycle_completed_at: null,
    next_refresh_at: null,
    rows_scanned: 0,
    aliases_written: 0,
  };
}

