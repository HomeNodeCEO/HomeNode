import assert from 'node:assert/strict';
import test from 'node:test';
import { generateNeighborhoodBoundary } from '../src/services/neighborhoodBoundaryEngine.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL,
  verifyNeighborhoodCiConnection } from './helpers/neighborhoodCiDatabase.js';

async function broadBoundaryQuery(profile) {
  let captured;
  const reached = new Error('synthetic_broad_query_captured');
  const pool = { async query(text, values) {
    if (String(text).includes('WITH subject AS MATERIALIZED')) {
      captured = { text, values }; throw reached;
    }
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(generateNeighborhoodBoundary(pool, {
    accountId: '00000000000000001', searchProfileKey: profile, discoveryRadiusMiles: 3,
  }), error => error === reached);
  assert.ok(captured);
  return captured;
}

test('native broad boundary query resolves the subject in radial, concave and sparse branches', {
  skip: !process.env.DATABASE_URL, timeout: 30000,
}, async t => {
  // Only loopback *_test databases. All data below is connection-local synthetic
  // temporary data; never create, read or modify a production parcel table.
  const target = checkedNeighborhoodDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'neighborhood_broad_boundary_native_test' });
  await client.connect();
  try {
    const identity = (await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
    verifyNeighborhoodCiConnection(identity, client.connection?.stream?.remoteAddress, target.databaseName);
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE boundary_parcels (
      object_id integer, account_id text, low_parcel_id text, land_use_category text,
      residential_year_built integer, parcel_area_sqft double precision,
      current_market_value double precision, geom geometry(Polygon,4326)
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO pg_temp.boundary_parcels
      SELECT n, lpad(n::text,17,'0'), lpad(n::text,17,'0'), 'one_unit', 1959, 8000, 250000,
        ST_MakeEnvelope(-96.65 + dx,32.90 + dy,-96.6499 + dx,32.9001 + dy,4326)
      FROM (VALUES (1,0.0,0.0),(2,-0.001,0.001),(3,0.001,0.001),
                   (4,0.001,-0.001),(5,-0.001,-0.001)) AS parcels(n,dx,dy)`);
    const queries = await Promise.all(['suburban_simple', 'suburban_moderate'].map(broadBoundaryQuery));
    const execute = query => client.query(query.text.replaceAll('gis.dcad_parcels', 'pg_temp.boundary_parcels'), query.values);
    const verify = async (row, count) => {
      assert.equal(row.subject_parcel_account_id, '00000000000000001');
      assert.equal(row.candidate_count, count);
      assert.equal(row.spatial_count, count);
      const { rows: [shape] } = await client.query(`WITH actual AS (
        SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS geom,
          ST_SetSRID(ST_GeomFromGeoJSON($2),4326) AS center
      ) SELECT ST_IsValid(geom) AS valid, ST_GeometryType(geom) AS type,
        ST_Covers(geom,center) AS contains_subject, ST_Area(geom::geography) AS area_m2,
        (SELECT MAX(ST_Distance(point.geom::geography,actual.center::geography))
         FROM ST_DumpPoints(geom) point) AS farthest_meters FROM actual`,
      [JSON.stringify(row.boundary), JSON.stringify(row.subject_point)]);
      assert.equal(shape.valid, true); assert.equal(shape.type, 'ST_Polygon');
      assert.equal(shape.contains_subject, true); assert.ok(shape.area_m2 > 0);
      assert.ok(shape.farthest_meters <= 3 * 1609.344 + 10);
      return shape;
    };
    for (const [index, query] of queries.entries()) await t.test(index === 0 ? 'three-mile radial discovery' : 'nearby concave discovery', async () => {
      const { rows } = await execute(query); assert.equal(rows.length, 1);
      const shape = await verify(rows[0], 5);
      if (index === 0) assert.ok(Math.abs(shape.farthest_meters - 3 * 1609.344) < 10);
      else assert.ok(shape.farthest_meters < 1000, 'nonradial branch stays local to the nearby fixture');
    });
    await client.query('DELETE FROM pg_temp.boundary_parcels WHERE object_id <> 1');
    await t.test('one-parcel fallback', async () => verify((await execute(queries[1])).rows[0], 1));
    await client.query('DELETE FROM pg_temp.boundary_parcels');
    await t.test('missing subject produces no fabricated boundary', async () => {
      assert.equal((await execute(queries[0])).rows.length, 0);
      assert.equal((await execute(queries[1])).rows.length, 0);
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { await client.end(); }
  }
});
