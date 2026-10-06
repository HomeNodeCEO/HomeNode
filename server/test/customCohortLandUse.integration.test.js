import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPLORATION_LAND_USE_SQL } from '../src/services/neighborhoodAssessment/customCohortLandUseAnalysis.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './helpers/neighborhoodCiDatabase.js';

test('native PostGIS one-ring land use includes edges but not corners, second-ring parcels or personal property', {
  skip: !process.env.DATABASE_URL, timeout: 30000,
}, async () => {
  const target = checkedNeighborhoodDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 3000, statement_timeout: 8000 });
  await client.connect();
  try {
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0], client.connection?.stream?.remoteAddress, target.databaseName);
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE land_use_parcels (object_id integer PRIMARY KEY, account_id text, use_code text,
      land_use_category text, classification_review_reason text, classification_confidence text, built_up boolean,
      source_updated_at timestamptz, geom geometry(Polygon,4326)) ON COMMIT DROP`);
    await client.query(`CREATE INDEX ON land_use_parcels USING gist(geom)`);
    // A tiny rectangular grid near Dallas; synthetic values only. Neighbor 2
    // shares the east edge, 3 only a corner, 4 is the second ring, 5 is personal
    // property, 6 shares the west edge with an unknown category.
    await client.query(`INSERT INTO land_use_parcels SELECT n, n::text, use_code, category, NULL, 'high', built,
      '2026-10-01'::timestamptz, ST_MakeEnvelope(-96.7+x*0.001,32.9+y*0.001,-96.7+(x+1)*0.001,32.9+(y+1)*0.001,4326)
      FROM (VALUES (1,0,0,'1','one_unit',true),(2,1,0,'2','commercial',true),(3,1,1,'1','multifamily',true),
        (4,2,0,'1','two_to_four_unit',true),(5,0,-1,'3','commercial',true),(6,-1,0,'1',NULL,false)) AS f(n,x,y,use_code,category,built)`);
    // Mirror the stored legacy fallback, whose category is NOT NULL even when
    // its source did not identify a use. It must remain unclassified here.
    await client.query("UPDATE land_use_parcels SET land_use_category='other_vacant', classification_confidence='low' WHERE object_id=6");
    const sql = EXPLORATION_LAND_USE_SQL.replaceAll('gis.dcad_parcels', 'pg_temp.land_use_parcels');
    const row = (await client.query(sql, [['1'], 100001])).rows[0];
    assert.equal(row.selected_parcel_count, 1); assert.equal(row.neighbor_parcel_count, 2); assert.equal(row.parcel_count, 3);
    assert.deepEqual(row.categories.map(item => item.category).sort(), ['commercial', 'one_unit', null].sort());
    assert.ok(row.area_sqm > row.built_up_sqm && row.built_up_sqm > 0);
    assert.ok(Math.abs(row.categories.reduce((sum, item) => sum + item.area_sqm, 0) - row.area_sqm) < 1);
    // The admission ceiling must avoid expensive dissolving and return no
    // misleading percentages from a silently truncated population.
    const capped = (await client.query(sql, [['1'], 2])).rows[0];
    assert.ok(capped.parcel_count >= 2); assert.equal(capped.area_sqm, null); assert.deepEqual(capped.categories, []);
  } finally { try { await client.query('ROLLBACK'); } finally { await client.end(); } }
});
