export const AUTH_SESSION_RETENTION_MIGRATION_NAME = "20261022_auth_session_retention.sql";

const INDEX_NAME = "web_sessions_retention_cleanup_idx";

const INDEX_STATUS_SQL = `
  SELECT pg_index.indisvalid,
         pg_index.indisready,
         pg_index.indislive,
         pg_index.indpred IS NULL AS unfiltered,
         pg_index.indnkeyatts AS key_count,
         pg_index.indoption[0] AS first_options,
         pg_index.indoption[1] AS second_options,
         pg_get_indexdef(pg_index.indexrelid, 1, true) AS first_key,
         pg_get_indexdef(pg_index.indexrelid, 2, true) AS second_key,
         access_method.amname AS access_method
  FROM pg_catalog.pg_index
  JOIN pg_catalog.pg_class index_catalog
    ON index_catalog.oid = pg_index.indexrelid
  JOIN pg_catalog.pg_am access_method
    ON access_method.oid = index_catalog.relam
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_catalog.relnamespace
  WHERE index_namespace.nspname = 'app_auth'
    AND index_catalog.relname = '${INDEX_NAME}'
    AND pg_index.indrelid = 'app_auth.web_sessions'::regclass
`;

function currentIndexIsUsable(row) {
  const firstKey = String(row?.first_key || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\((least\(.*\))\)$/, "$1");
  return row?.indisvalid === true
    && row?.indisready === true
    && row?.indislive === true
    && row?.unfiltered === true
    && row?.access_method === "btree"
    && Number(row?.key_count) === 2
    && Number(row?.first_options) === 0
    && Number(row?.second_options) === 0
    && firstKey === "least(expires_at,coalesce(revoked_at,expires_at))"
    && String(row?.second_key || "").trim().toLowerCase() === "id";
}

/**
 * Install the retention index outside the migration transaction so existing
 * session creation, refresh, and revocation writes remain available. A crash
 * before the migration ledger insert is safe to retry, including when
 * PostgreSQL left an invalid concurrent index behind.
 */
export async function applyAuthSessionRetentionPostMigration(client, { logger = console } = {}) {
  const existingIndex = await client.query(INDEX_STATUS_SQL);
  if (!currentIndexIsUsable(existingIndex.rows?.[0])) {
    if (existingIndex.rows?.length) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS app_auth.${INDEX_NAME}`);
    }
    await client.query(`
      CREATE INDEX CONCURRENTLY ${INDEX_NAME}
      ON app_auth.web_sessions (
        (LEAST(expires_at, COALESCE(revoked_at, expires_at))),
        id
      )
    `);
  }
  logger.info?.("[migration] web session retention index is ready");
  return { index_ready: true };
}
