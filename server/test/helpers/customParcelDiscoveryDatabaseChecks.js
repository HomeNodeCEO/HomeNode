import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensurePropertyContextSchema } from '../../src/services/propertyContextStore.js';
import { auditCustomParcelDiscoveryReadiness } from '../../src/services/neighborhoodAssessment/customParcelDiscoveryReadiness.js';

/** Called only by the isolated native neighborhood database harness. */
export async function checkCustomParcelDiscoveryDatabase(pool) {
  const client = await pool.connect();
  const audit = () => auditCustomParcelDiscoveryReadiness(client);
  const probe = async action => {
    await client.query('SAVEPOINT discovery_probe');
    try { await action(); }
    finally {
      await client.query('ROLLBACK TO SAVEPOINT discovery_probe');
      await client.query('RELEASE SAVEPOINT discovery_probe');
    }
  };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '20s'");
    // Exercise the application's real schema producer, not a mock table copied
    // from the audit's expectations. All DDL/data below is rolled back.
    await ensurePropertyContextSchema(client);
    const empty = await audit();
    assert.equal(empty.counts.total_rows, '0', 'Use a fresh synthetic database, never a populated GIS cache');
    assert.ok(empty.blockers.includes('empty_parcel_table'));
    assert.equal(empty.productionReady, false);
    assert.equal(empty.exactGeographyIndexEstablished, false);
    const sync = randomUUID();
    await client.query(`INSERT INTO gis.source_sync_runs(id,source_key,mode,status,completed_at)
      VALUES ($1,'dcad_parcels','full','complete',now())`, [sync]);
    await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,sync_run_id,geom)
      VALUES (1,'SYNTHETIC-DISCOVERY-1',$1,$2,ST_Multi(ST_MakeEnvelope(-96.8,32.8,-96.799,32.801,4326)))`,
    ['a'.repeat(64), sync]);
    const original = await audit();
    assert.equal(original.auditComplete, true);
    assert.equal(original.counts.total_rows, '1');
    assert.equal(original.blockers.length, 1);
    assert.equal(original.blockers[0], 'exact_geography_index_not_established');

    await probe(async () => {
      await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,geom) VALUES
        (2,NULL,'',ST_GeomFromText('MULTIPOLYGON EMPTY',4326)),
        (3,'bad-bowtie','x',ST_GeomFromText('MULTIPOLYGON(((0 0,1 1,1 0,0 1,0 0)))',4326)),
        (4,'outside','x',ST_Multi(ST_MakeEnvelope(180,90,181,91,4326))),
        (5,'nonfinite','x',ST_SetSRID(ST_Multi(ST_MakePolygon(ST_MakeLine(ARRAY[
          ST_MakePoint(0,0),ST_MakePoint(1,0),ST_MakePoint('Infinity'::float8,1),ST_MakePoint(0,0)
        ]))),4326))`);
      const result = await audit();
      assert.equal(result.counts.total_rows, '5');
      assert.equal(result.counts.empty_geometry, '1');
      assert.equal(result.counts.nonfinite_geometry, '1');
      assert.equal(result.counts.outside_wgs84_geometry, '1');
      assert.ok(BigInt(result.counts.invalid_geometry) >= 1n);
      assert.equal(result.counts.unlinked_or_blank_accounts, '1');
      assert.equal(result.counts.absent_source_hashes, '1');
      assert.equal(result.counts.absent_sync_run_linkage, '4');
      assert.equal(result.cachePrerequisitesSatisfied, false);
    });
    await probe(async () => {
      // Deliberate corruption probes inside a rollback savepoint: the real
      // declared schema normally prevents NULL, wrong-type and wrong-SRID rows.
      await client.query('ALTER TABLE gis.dcad_parcels ALTER COLUMN geom DROP NOT NULL');
      await client.query('ALTER TABLE gis.dcad_parcels ALTER COLUMN geom TYPE geometry USING geom::geometry');
      await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,sync_run_id,geom) VALUES
        (2,'null','x',$1,NULL),(3,'point','x',$1,ST_SetSRID(ST_MakePoint(0,0),4326)),
        (4,'wrong-srid','x',$1,ST_Multi(ST_MakeEnvelope(0,0,1,1,3857)))`, [sync]);
      const result = await audit();
      assert.equal(result.counts.null_geometry, '1');
      assert.equal(result.counts.wrong_type, '1');
      assert.equal(result.counts.wrong_srid, '1');
      assert.equal(result.cachePrerequisitesSatisfied, false);
    });
    await probe(async () => {
      await client.query('CREATE INDEX discovery_partial_geography ON gis.dcad_parcels USING gist((geom::geography)) WHERE account_id IS NOT NULL');
      await client.query('CREATE INDEX discovery_other_expression ON gis.dcad_parcels USING gist((ST_PointOnSurface(geom)::geography))');
      assert.equal((await audit()).exactGeographyIndexEstablished, false);
      await client.query('CREATE INDEX discovery_exact_geography ON gis.dcad_parcels USING gist((geom::geography))');
      const result = await audit();
      assert.equal(result.exactGeographyIndexEstablished, true);
      assert.equal(result.cachePrerequisitesSatisfied, true);
      assert.equal(result.productionReady, false);
      assert.equal(result.coverage.status, 'not_established');
      assert.deepEqual(result.indexes.filter(index => index.exactIndexEstablished).map(index => index.name),
        ['discovery_exact_geography']);
      const membership = (await client.query(`WITH origin AS (
        SELECT ST_SetSRID(ST_MakePoint(-96.8,32.8),4326)::geography AS point
      ), cases AS (
        SELECT point, ST_Buffer(ST_Project(point,4900,pi()/2),150)::geometry AS intersects,
          ST_Buffer(ST_Project(point,5200,pi()/2),10)::geometry AS outside FROM origin
      ) SELECT ST_DWithin(intersects::geography,point,4828.032,true) AS whole_parcel_included,
        ST_DWithin(ST_Centroid(intersects)::geography,point,4828.032,true) AS centroid_included,
        ST_DWithin(outside::geography,point,4828.032,true) AS outside_included FROM cases`)).rows[0];
      assert.deepEqual(membership, { whole_parcel_included: true, centroid_included: false, outside_included: false });
    });
    await probe(async () => {
      const role = `discovery_audit_${randomUUID().replaceAll('-', '')}`;
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`GRANT USAGE ON SCHEMA gis TO ${role}`);
      await client.query(`GRANT SELECT ON gis.dcad_parcels,gis.source_sync_runs TO ${role}`);
      await client.query('ALTER TABLE gis.dcad_parcels ENABLE ROW LEVEL SECURITY');
      await client.query(`SET LOCAL ROLE ${role}`);
      const result = await audit();
      assert.ok(result.blockers.includes('parcel_rls_active'));
      assert.equal(result.counts, null, 'Filtered rows must not appear as a complete zero-defect cache');
      assert.equal(result.auditComplete, false);
      await client.query('RESET ROLE');
    });
    return { status: 'passed', cases: 6 };
  } finally {
    try { await client.query('ROLLBACK'); }
    finally { client.release(); }
  }
}
