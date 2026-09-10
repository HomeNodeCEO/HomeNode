import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

/** Only a verified disposable database with no source table. Never production. */
export async function checkSalesSourceMetadataDatabase(client, databaseName) {
  assert.match(databaseName, /^[a-zA-Z0-9_]+_test$/);
  const identity = (await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
  verifyNeighborhoodCiConnection(identity, client.connection?.stream?.remoteAddress, databaseName);
  assert.equal((await client.query("SELECT to_regclass('core.sales_source_records') AS relation")).rows[0].relation, null);
  const sql = await readFile(new URL('../../migrations/20261018_sales_source_metadata.sql', import.meta.url), 'utf8');
  const results = [];
  await client.query('BEGIN');
  try {
    await client.query(sql);
    assert.equal((await client.query("SELECT to_regclass('core.sales_source_records') AS relation")).rows[0].relation, null);
    results.push('absent optional source stays absent');
    await client.query(`CREATE SCHEMA IF NOT EXISTS core;
      CREATE TABLE core.sales_source_records (id bigint PRIMARY KEY, current_price numeric, source_record_hash text);
      INSERT INTO core.sales_source_records VALUES (1, 282500, 'synthetic-preserved-hash')`);
    const before = (await client.query('SELECT * FROM core.sales_source_records')).rows;
    await client.query(sql); await client.query(sql);
    const columns = (await client.query(`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema='core' AND table_name='sales_source_records'
      AND column_name IN ('source_modified_at','source_system_name') ORDER BY column_name`)).rows;
    assert.deepEqual(columns, [
      { column_name: 'source_modified_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'source_system_name', data_type: 'text', is_nullable: 'YES', column_default: null },
    ]);
    assert.deepEqual((await client.query('SELECT id,current_price,source_record_hash FROM core.sales_source_records')).rows, before);
    assert.deepEqual((await client.query('SELECT source_modified_at,source_system_name FROM core.sales_source_records')).rows,
      [{ source_modified_at: null, source_system_name: null }]);
    results.push('legacy CSV rows unchanged; missing metadata stays null; migration repeatable');
    await client.query('INSERT INTO core.sales_source_records VALUES ($1,$2,$3,$4,$5)',
      [2, 300000, 'synthetic-provider-hash', '2026-08-01T12:30:00Z', 'SYNTHETIC-PROVIDER']);
    const populated = (await client.query('SELECT * FROM core.sales_source_records ORDER BY id')).rows;
    await client.query(sql);
    assert.deepEqual((await client.query('SELECT * FROM core.sales_source_records ORDER BY id')).rows, populated);
    results.push('existing provider metadata and source rows preserved');
    return results;
  } finally { await client.query('ROLLBACK'); }
}
