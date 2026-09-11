import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export const NEIGHBORHOOD_SPATIAL_INDEX_NAMES = Object.freeze([
  'dcad_parcels_neighborhood_invalid_idx', 'dcad_parcels_neighborhood_geography_gix',
]);
const inventorySql = `SELECT ci.relname AS index_name, i.indisvalid, i.indisready,
  nt.nspname AS table_schema, ct.relname AS table_name, am.amname AS method,
  pg_get_indexdef(ci.oid) AS definition
  FROM pg_class ci JOIN pg_namespace ni ON ni.oid=ci.relnamespace
  JOIN pg_index i ON i.indexrelid=ci.oid JOIN pg_class ct ON ct.oid=i.indrelid
  JOIN pg_namespace nt ON nt.oid=ct.relnamespace JOIN pg_am am ON am.oid=ci.relam
  WHERE ni.nspname='gis' AND ci.relname=ANY($1::text[]) ORDER BY ci.relname`;

export function spatialIndexStatements(sql) {
  const statements = sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  if (statements.length !== 2 || statements.some((s, n) =>
    !s.startsWith(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NEIGHBORHOOD_SPATIAL_INDEX_NAMES[n]}\n`))) {
    throw new Error('unexpected_spatial_index_maintenance_sql');
  }
  return statements;
}

/** Explicit operator maintenance, never an HTTP startup or transactional migration.
 * No data update, DROP, index rebuild, auth change, or timeout increase on web requests.
 * A failed concurrent build can leave an invalid index: stop for reviewed repair.
 */
export async function prepareNeighborhoodSpatialIndexes(client, { apply = false, log = console.log } = {}) {
  const sql = await fs.readFile(new URL('../maintenance/neighborhoodSpatialIndexes.sql', import.meta.url), 'utf8');
  const statements = spatialIndexStatements(sql.replaceAll('\r\n', '\n'));
  const inventory = async () => (await client.query(inventorySql, [NEIGHBORHOOD_SPATIAL_INDEX_NAMES])).rows;
  const validate = rows => {
    for (const row of rows) {
      if (!row.indisvalid || !row.indisready || row.table_schema !== 'gis' || row.table_name !== 'dcad_parcels'
        || row.method !== (row.index_name.endsWith('_gix') ? 'gist' : 'btree')) {
        throw new Error('spatial_index_requires_manual_review');
      }
    }
  };
  const before = await inventory(); validate(before);
  if (!apply) return { mode: 'inspection_only', indexes: before, missing: NEIGHBORHOOD_SPATIAL_INDEX_NAMES.filter(name => !before.some(r => r.index_name === name)) };
  // These limits apply only to this dedicated maintenance connection.
  await client.query("SELECT set_config('lock_timeout','5s',false), set_config('statement_timeout','10min',false), set_config('maintenance_work_mem','64MB',false)");
  for (const [n, name] of NEIGHBORHOOD_SPATIAL_INDEX_NAMES.entries()) {
    if (before.some(row => row.index_name === name)) continue;
    log(JSON.stringify({ stage: 'building_online_index', index: name }));
    await client.query(statements[n]);
    validate(await inventory());
  }
  const after = await inventory(); validate(after);
  if (after.length !== 2) throw new Error('spatial_index_preparation_incomplete');
  return { mode: 'prepared', indexes: after };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('usage_prepare_neighborhood_spatial_indexes_optional_apply');
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, application_name: 'homenode-neighborhood-index-maintenance' });
  try { await client.connect(); console.log(JSON.stringify(await prepareNeighborhoodSpatialIndexes(client, { apply: args.includes('--apply') }))); }
  finally { await client.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ error: /^[a-z_]+$/.test(error.message) ? error.message : 'spatial_index_preparation_failed', code: error.code ?? null })); process.exitCode = 1; });
}
