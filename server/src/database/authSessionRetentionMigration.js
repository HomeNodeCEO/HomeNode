export const AUTH_SESSION_RETENTION_MIGRATION_NAME = "20261022_auth_session_retention.sql";

const INDEX_NAME = "web_sessions_retention_cleanup_idx";

const INDEX_STATUS_SQL = `
  SELECT pg_index.indisvalid,
         pg_get_indexdef(pg_index.indexrelid) AS definition
  FROM pg_catalog.pg_index
  JOIN pg_catalog.pg_class index_catalog
    ON index_catalog.oid = pg_index.indexrelid
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_catalog.relnamespace
  WHERE index_namespace.nspname = 'app_auth'
    AND index_catalog.relname = '${INDEX_NAME}'
    AND pg_index.indrelid = 'app_auth.web_sessions'::regclass
`;

function currentIndexIsUsable(row) {
  const definition = String(row?.definition || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return row?.indisvalid === true
    && definition.includes("using btree")
    && definition.includes("least(expires_at, coalesce(revoked_at, expires_at))")
    && definition.includes(" id");
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
