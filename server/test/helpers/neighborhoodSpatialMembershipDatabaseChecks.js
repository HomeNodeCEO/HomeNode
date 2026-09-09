import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL,
  verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { ensurePropertyContextSchema } from '../../src/services/propertyContextStore.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';

export async function runNeighborhoodSpatialMembershipDatabaseChecks(connectionString) {
  const checked = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const require = createRequire(import.meta.url);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: checked.connectionString, max: 3, connectionTimeoutMillis: 5000 });
  let reader;
  try {
    const probe = await pool.connect();
    try {
      const identity = (await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
      verifyNeighborhoodCiConnection(identity, probe.connection?.stream?.remoteAddress, checked.databaseName);
    } finally { probe.release(); }
    assert.equal((await pool.query("SELECT to_regnamespace('gis')::text AS existing")).rows[0].existing, null,
      'Requires a fresh fixture database; never replace an existing GIS cache');
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await ensurePropertyContextSchema(pool);
    const syncId = randomUUID();
    await pool.query(`INSERT INTO gis.source_sync_runs(id,source_key,mode,status,completed_at)
      VALUES($1,'dcad_parcels','full','complete',now())`, [syncId]);
    const geometry = { geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
      coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.63', '32.88'], source_sha256: 'a'.repeat(64) };
    const insert = async (objectId, account, minLon, maxLon) => pool.query(`
      INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,sync_run_id,geom)
      VALUES($1,$2,$3,$4,ST_Multi(ST_MakeEnvelope($5,32.8799,$6,32.8801,4326)))`,
    [objectId, account, 'b'.repeat(64), syncId, minLon, maxLon]);
    await insert(1, '0001', -96.6301, -96.6299);
    await insert(2, '0001', -96.6298, -96.6296); // Same account, different parcel geometry/identity.
    await insert(3, '0003', -95.6301, -95.6299); // Outside the full polygon distance.
    await insert(4, '0004', -96.595, -96.43); // Polygon enters radius but centroid is outside.
    await insert(5, '0005', -96.6302, -96.63);
    assert.equal((await pool.query(`SELECT ST_DWithin(ST_Centroid(geom)::geography,
      ST_SetSRID(ST_MakePoint(-96.63,32.88),4326)::geography,4828.032,true) AS near
      FROM gis.dcad_parcels WHERE object_id=4`)).rows[0].near, false);
    reader = await pool.connect();
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await reader.query("SET LOCAL statement_timeout='5000ms'");
    const original = await captureNeighborhoodSpatialMembership(reader, geometry, { page_size: 2 });
    assert.equal(original.status, 'captured');
    assert.deepEqual(original.parcels.map(row => row.object_id), ['1', '2', '4', '5']);
    assert.deepEqual(original.account_ids, ['0001', '0004', '0005']);
    // These writes use a separate connection while the original read transaction stays open.
    await pool.query(`UPDATE gis.dcad_parcels SET geom=ST_Translate(geom,1,0) WHERE object_id=1`);
    await pool.query('DELETE FROM gis.dcad_parcels WHERE object_id=2');
    await insert(6, '0006', -96.6301, -96.6299);
    const sameSnapshot = await captureNeighborhoodSpatialMembership(reader, geometry, { page_size: 2 });
    assert.equal(sameSnapshot.status, 'captured');
    assert.equal(sameSnapshot.membership_sha256, original.membership_sha256);
    assert.deepEqual(sameSnapshot.parcels, original.parcels);
    await reader.query('ROLLBACK');
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await reader.query("SET LOCAL statement_timeout='5000ms'");
    const fresh = await captureNeighborhoodSpatialMembership(reader, geometry, { page_size: 2 });
    assert.equal(fresh.status, 'captured');
    assert.deepEqual(fresh.parcels.map(row => row.object_id), ['4', '5', '6']);
    assert.notEqual(fresh.membership_sha256, original.membership_sha256);
    const overflow = await captureNeighborhoodSpatialMembership(reader, geometry, { parcels: 2, page_size: 2 });
    assert.equal(overflow.status, 'incomplete'); assert.equal(overflow.reason, 'parcel_limit');
    await reader.query('ROLLBACK');
    const originalAccount = (await pool.query('SELECT account_id FROM gis.dcad_parcels WHERE object_id=5')).rows[0].account_id;
    for (const malformed of ['   ', '000\t1', '000\u007f1']) {
      await pool.query('UPDATE gis.dcad_parcels SET account_id=$1 WHERE object_id=5', [malformed]);
      await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const unresolved = await captureNeighborhoodSpatialMembership(reader, geometry);
      assert.equal(unresolved.status, 'incomplete'); assert.equal(unresolved.reason, 'parcel_account_unresolved');
      assert.equal(unresolved.parcels, undefined); assert.equal(unresolved.membership_sha256, undefined);
      await reader.query('ROLLBACK');
    }
    await pool.query('UPDATE gis.dcad_parcels SET account_id=$1 WHERE object_id=5', [originalAccount]);
    await pool.query(`UPDATE gis.dcad_parcels SET geom=ST_Multi(ST_GeomFromText(
      'POLYGON((-96.64 32.87,-96.62 32.89,-96.64 32.89,-96.62 32.87,-96.64 32.87))',4326)) WHERE object_id=5`);
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const invalid = await captureNeighborhoodSpatialMembership(reader, geometry);
    assert.equal(invalid.status, 'incomplete'); assert.equal(invalid.reason, 'cached_geometry_ineligible');
    await reader.query('ROLLBACK');
    const noTransaction = await captureNeighborhoodSpatialMembership(reader, geometry);
    assert.equal(noTransaction.reason, 'repeatable_read_read_only_transaction_required');
    return { status: 'passed', checks: ['polygon_not_centroid', 'duplicate_account_parcels', 'keyset_pagination',
      'same_snapshot_add_move_delete', 'fresh_snapshot_change_detection', 'overflow_incomplete',
      'invalid_geometry_incomplete', 'transaction_required', 'malformed_account_incomplete'], original_membership_sha256: original.membership_sha256,
    fresh_membership_sha256: fresh.membership_sha256, authority: 'not_established' };
  } finally {
    if (reader) {
      let releaseError;
      try { await reader.query('ROLLBACK'); } catch (error) { releaseError = error; }
      reader.release(releaseError);
    }
    await pool.end();
  }
}
