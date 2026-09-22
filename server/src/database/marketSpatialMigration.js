export const MARKET_SPATIAL_MIGRATION_NAME = "20261020_market_spatial_runtime.sql";

const BATCH_SIZE = 1_000;
const INDEX_NAME = "account_locations_geom_gist_idx";

const BATCH_TIMEOUTS_SQL = `
  SELECT set_config('lock_timeout',
      least(CASE WHEN current_setting('lock_timeout')::interval = interval '0'
        THEN 5000 ELSE extract(epoch FROM current_setting('lock_timeout')::interval) * 1000 END, 5000)::text || 'ms', true),
    set_config('statement_timeout',
      least(CASE WHEN current_setting('statement_timeout')::interval = interval '0'
        THEN 120000 ELSE extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 END, 120000)::text || 'ms', true)
`;

export const MARKET_SPATIAL_BACKFILL_SQL = `
  WITH pending AS MATERIALIZED (
    SELECT location.ctid
    FROM core.account_locations location
    WHERE location.latitude IS NOT NULL
      AND location.longitude IS NOT NULL
      AND (
        location.location_geom IS NULL
        OR ST_X(location.location_geom) IS DISTINCT FROM location.longitude
        OR ST_Y(location.location_geom) IS DISTINCT FROM location.latitude
      )
    ORDER BY location.account_id
    LIMIT ${BATCH_SIZE}
    FOR UPDATE
  )
  UPDATE core.account_locations location
  SET location_geom = ST_SetSRID(
    ST_MakePoint(location.longitude, location.latitude),
    4326
  )
  FROM pending
  WHERE location.ctid = pending.ctid
  RETURNING location.account_id
`;

const INDEX_STATUS_SQL = `
  SELECT pg_index.indisvalid,
         pg_get_indexdef(pg_index.indexrelid) AS definition
  FROM pg_catalog.pg_index
  JOIN pg_catalog.pg_class index_catalog
    ON index_catalog.oid = pg_index.indexrelid
  JOIN pg_catalog.pg_namespace index_namespace
    ON index_namespace.oid = index_catalog.relnamespace
  WHERE index_namespace.nspname = 'core'
    AND index_catalog.relname = '${INDEX_NAME}'
    AND pg_index.indrelid = 'core.account_locations'::regclass
`;

function currentIndexIsUsable(row) {
  const definition = String(row?.definition || "").toLowerCase();
  return row?.indisvalid === true
    && definition.includes("using gist (location_geom)")
    && definition.includes("where (location_geom is not null)")
    && !definition.includes("status");
}

/**
 * Runs after the schema transaction commits but before its migration ledger
 * record is written. Every repair batch commits independently, so an outage or
 * timeout resumes from remaining mismatched rows on the next deployment.
 */
export async function applyMarketSpatialPostMigration(client, { logger = console } = {}) {
  let updatedRows = 0;
  let batches = 0;
  for (;;) {
    await client.query("BEGIN");
    await client.query(BATCH_TIMEOUTS_SQL);
    const result = await client.query(MARKET_SPATIAL_BACKFILL_SQL);
    await client.query("COMMIT");
    const batchRows = Number(result.rowCount ?? result.rows?.length ?? 0);
    if (!batchRows) break;
    updatedRows += batchRows;
    batches += 1;
  }

  const existingIndex = await client.query(INDEX_STATUS_SQL);
  if (!currentIndexIsUsable(existingIndex.rows?.[0])) {
    if (existingIndex.rows?.length) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS core.${INDEX_NAME}`);
    }
    await client.query(`
      CREATE INDEX CONCURRENTLY ${INDEX_NAME}
      ON core.account_locations
      USING GIST (location_geom)
      WHERE location_geom IS NOT NULL
    `);
  }
  logger.info?.(`[migration] market spatial repair committed ${updatedRows} rows in ${batches} batches`);
  return { updated_rows: updatedRows, batches };
}
