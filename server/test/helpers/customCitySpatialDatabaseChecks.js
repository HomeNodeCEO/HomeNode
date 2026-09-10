import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { validateRetainedCustomCityDiscovery } from '../../src/services/neighborhoodAssessment/customCityDiscovery.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const OUTER = [[-104, 30], [-103.98, 30], [-103.98, 30.02], [-104, 30.02], [-104, 30]];
const HOLE = [[-103.995, 30.005], [-103.995, 30.015], [-103.985, 30.015], [-103.985, 30.005], [-103.995, 30.005]];
const ISLAND = [[-103.95, 30.005], [-103.94, 30.005], [-103.94, 30.015], [-103.95, 30.015], [-103.95, 30.005]];
const ROWS = [
  ['inside', 'POLYGON((-103.999 30.001,-103.998 30.001,-103.998 30.002,-103.999 30.002,-103.999 30.001))'],
  ['hole', 'POLYGON((-103.993 30.007,-103.992 30.007,-103.992 30.008,-103.993 30.008,-103.993 30.007))'],
  ['gap', 'POLYGON((-103.970 30.007,-103.969 30.007,-103.969 30.008,-103.970 30.008,-103.970 30.007))'],
  ['island', 'POLYGON((-103.948 30.007,-103.947 30.007,-103.947 30.008,-103.948 30.008,-103.948 30.007))'],
  ['edge', 'POLYGON((-104.002 30.005,-104 30.005,-104 30.007,-104.002 30.007,-104.002 30.005))'],
  ['crossing', 'POLYGON((-103.981 30.001,-103.979 30.001,-103.979 30.002,-103.981 30.002,-103.981 30.001))'],
  ['outside', 'POLYGON((-104.10 30.001,-104.09 30.001,-104.09 30.002,-104.10 30.002,-104.10 30.001))'],
];
function cityFixture(geometry = { type: 'MultiPolygon', coordinates: [[OUTER, HOLE], [ISLAND]] }) {
  const geoid = '4899999', name = 'Synthetic Native Fixture', vintage = '2026-01-01';
  const asset_utf8 = `${JSON.stringify({ type: 'Feature', geometry, properties: { GEOID: geoid, STATE: '48', PLACE: '99999',
    NAME: `${name} city`, BASENAME: name, AREALAND: 0, AREAWATER: 0 } })}\n`;
  const asset_sha256 = hash(asset_utf8);
  const admitted = validateRetainedCustomCityDiscovery({ choice: { profile_id: 'custom-city-polygon-v1',
    city: { geoid, vintage, asset_sha256 } }, asset_utf8, asset_sha256, source: {
    schemaVersion: 1, vintage, retrievedAt: '2026-09-10T00:00:00.000Z',
    sourceName: 'Synthetic native membership fixture; not municipal source data',
    sourceUrl: 'https://example.test/synthetic-city-fixture', sourceQuery: 'https://example.test/synthetic-city-fixture?no_network=true',
    sourceSha256: asset_sha256,
    nativeValidationSha256: hash('synthetic descriptor only; native validity is tested separately, not attested by this digest'),
    purpose: 'Synthetic native test only; no external source authority, coverage, municipal or historical validity claim',
    city: { geoid, name, bytes: Buffer.byteLength(asset_utf8), sha256: asset_sha256 },
  } });
  const { geometry: _geometry, ...compact } = admitted;
  return { admitted, compact };
}

/** Appends synthetic rows only after URL/socket/database/coordinator guards.
 * Caller first creates the owned migrated coordinator fixture. No migrations,
 * DELETE, app writes, installed-loader injection or production fallback here.
 * Seed rows remain in that disposable child until its owner's teardown. */
export async function runCustomCitySpatialDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 2, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'custom_city_spatial_synthetic_test' });
  const checks = [], prefix = `CITY-SPATIAL-${randomUUID().slice(0, 8)}`;
  async function transaction(mode, work) {
    const client = await pool.connect(); let begun = false;
    try {
      verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
        client.connection?.stream?.remoteAddress, target.databaseName);
      assert.equal(client.getTransactionStatus(), 'I');
      begun = true; await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'");
      const result = await work(client);
      assert.equal(client.getTransactionStatus(), 'T');
      await client.query('COMMIT'); begun = false; return result;
    } catch (error) {
      if (begun) await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }
  try {
    const origin = await transaction('REPEATABLE READ READ ONLY', async client => {
      const found = await client.query(`SELECT a.organization_id,a.id::text AS assignment_file_id,r.id AS report_file_id,a.account_id
        FROM app.assignment_files a JOIN app.report_files r ON r.custom_assignment_file_id=a.id
          AND r.organization_id=a.organization_id AND r.account_id=a.account_id
        JOIN app_auth.organizations o ON o.id=a.organization_id
        WHERE a.account_id='CAPTURE-COORD-SUBJECT' AND a.file_number LIKE 'CAP-%'
          AND o.legal_name='Synthetic Custom capture' AND r.workflow_type='custom_appraisal'`);
      assert.equal(found.rowCount, 1, 'requires the exact owned synthetic coordinator target');
      const scope = found.rows[0], scopeJson = json(scope);
      const references = await client.query(`SELECT context_id::text,context_revision::text,context_sha256
        FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND report_file_id=$2
          AND assignment_file_id=$3::bigint AND account_id=$4 ORDER BY context_id LIMIT 1`,
      [scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id]);
      assert.equal(references.rowCount, 1, 'requires an originally retained coordinator context');
      const header = await createCustomCohortContextRepository(client, scopeJson).get(json(references.rows[0]));
      const reference = header.body.subject_dependencies;
      const blob = await createNeighborhoodCohortBlobRepository(client, scope.organization_id)
        .get(reference.content_sha256, reference.canonical_utf8_bytes);
      const subjectReference = JSON.parse(blob).subject_inputs;
      const point = await createCustomCohortSubjectRepository(client, scopeJson).loadRecordedPoint(subjectReference);
      assert.equal(point.status, 'represented');
      assert.deepEqual(point.geometry_input.coordinates, ['-96.6995', '32.8005']);
      return { scope, point, subjectReference };
    });
    const beforePoint = json(origin.point), city = cityFixture();
    const seeded = await transaction('READ COMMITTED', async client => {
      const states = await client.query("SELECT row_count::text,last_run_id FROM gis.source_sync_state WHERE source_key='dcad_parcels' FOR UPDATE");
      assert.equal(states.rowCount, 1); const state = states.rows[0]; assert.ok(state.last_run_id);
      const current = (await client.query('SELECT count(*)::text AS count,COALESCE(max(object_id),0)::text AS maximum FROM gis.dcad_parcels')).rows[0];
      assert.equal(state.row_count, current.count, 'existing synthetic sync roster must already be coherent');
      const base = BigInt(current.maximum) + 1n, records = [];
      for (const [index, [kind, wkt]] of ROWS.entries()) {
        const account_id = `${prefix}-${kind}`, object_id = String(base + BigInt(index));
        const source_record_hash = hash(json({ kind, wkt, account_id }));
        assert.equal((await client.query(`INSERT INTO core.accounts(account_id,county,address,city,subdivision)
          VALUES($1,'Dallas','Synthetic city membership only','Deliberately unrelated mailing city','Synthetic city spatial fixture')`, [account_id])).rowCount, 1);
        assert.equal((await client.query(`INSERT INTO gis.dcad_parcels
          (object_id,account_id,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
          VALUES($1::bigint,$2,8000,$3,$4,now(),ST_Multi(ST_GeomFromText($5::text,4326)))`,
        [object_id, account_id, source_record_hash, state.last_run_id, wkt])).rowCount, 1);
        records.push({ kind, account_id, object_id, source_record_hash });
      }
      assert.equal((await client.query(`UPDATE gis.source_sync_state SET row_count=row_count+$1
        WHERE source_key='dcad_parcels' AND last_run_id=$2 AND row_count=$3::bigint`,
      [records.length, state.last_run_id, current.count])).rowCount, 1);
      return records;
    });
    const byKind = Object.fromEntries(seeded.map(row => [row.kind, row]));
    const expectedKinds = ['inside', 'island', 'edge', 'crossing'];
    const result = await transaction('REPEATABLE READ READ ONLY', async client => {
      const calls = [];
      const wrapped = { query: async config => {
        calls.push(config); assert.ok(Number.isInteger(config.query_timeout) && config.query_timeout > 0 && config.query_timeout <= 5000);
        return client.query(config);
      } };
      const result = await captureNeighborhoodSpatialMembership(wrapped, origin.point.geometry_input, { page_size: 2 }, city.compact.choice, city.compact);
      assert.equal(result.status, 'captured'); assert.equal(result.query_complete, true);
      assert.deepEqual(result.account_ids, expectedKinds.map(kind => byKind[kind].account_id).sort());
      assert.deepEqual(result.parcels.map(row => row.object_id), expectedKinds.map(kind => byKind[kind].object_id));
      assert.equal(result.counts.parcels, 4); assert.equal(result.counts.accounts, 4);
      assert.deepEqual(result.geometry_input, origin.point.geometry_input);
      assert.deepEqual(result.city_scope, city.compact); assert.equal(Object.hasOwn(result, 'radius_metres'), false);
      assert.equal(result.account_ids.includes(origin.scope.account_id), false, 'primitive membership does not append the far-away subject');
      assert.equal(result.authority, 'not_established'); assert.equal(result.source_coverage, 'not_established');
      const pages = calls.filter(call => call.text.includes('neighborhood-membership:parcels'));
      assert.equal(pages.length, 2, 'real keyset pagination includes the last page without truncation');
      assert.equal(pages[0].values[1], null); assert.equal(pages[1].values[1], byKind.island.object_id);
      for (const call of pages) {
        assert.match(call.text, /ST_Intersects/); assert.match(call.text, /geom &&/);
        assert.doesNotMatch(call.text, /ST_DWithin|ST_Intersection|ST_Centroid|mailing/i);
        assert.ok(call.text.includes('$1::text') && !call.text.includes('"coordinates"'));
        assert.deepEqual(call.values, [JSON.stringify(city.admitted.geometry), call.values[1], 3]);
      }
      const observed = await client.query(`WITH city AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326) AS geom)
        SELECT p.object_id::text,encode(sha256(ST_AsEWKB(p.geom)),'hex') AS full_hash,
          p.geom && city.geom AS bbox,ST_Intersects(p.geom,city.geom) AS intersects,
          ST_Covers(city.geom,p.geom) AS covered,ST_Touches(p.geom,city.geom) AS touches,
          ST_Equals(p.geom,ST_Intersection(p.geom,city.geom)) AS same_as_clipped
        FROM gis.dcad_parcels p CROSS JOIN city WHERE p.object_id=ANY($2::bigint[]) ORDER BY p.object_id`,
      [JSON.stringify(city.admitted.geometry), seeded.map(row => row.object_id)]);
      assert.equal(observed.rowCount, seeded.length);
      const native = new Map(observed.rows.map(row => [row.object_id, row]));
      for (const row of result.parcels) {
        assert.equal(row.geometry_sha256, native.get(row.object_id).full_hash, 'membership binds full original EWKB, not a clipped polygon');
        assert.equal(row.source_record_hash, seeded.find(seed => seed.object_id === row.object_id).source_record_hash);
      }
      for (const kind of ['hole', 'gap']) {
        assert.equal(native.get(byKind[kind].object_id).bbox, true);
        assert.equal(native.get(byKind[kind].object_id).intersects, false);
      }
      assert.equal(native.get(byKind.edge.object_id).touches, true);
      assert.equal(native.get(byKind.crossing.object_id).covered, false);
      assert.equal(native.get(byKind.crossing.object_id).same_as_clipped, false);
      assert.equal(native.get(byKind.outside.object_id).bbox, false);
      return result;
    });
    checks.push('native city polygon preserves holes/island; excludes bbox-only gap and outside; includes edge touch and crossing parcels');
    checks.push('actual paged membership is parameterized and binds full original parcel EWKB hashes, not clipped or centroid geometry');
    for (const [limits, reason] of [[{ accounts: 3 }, 'account_limit'], [{ parcels: 3 }, 'parcel_limit'], [{ bytes: 1 }, 'byte_limit']]) {
      await transaction('REPEATABLE READ READ ONLY', async client => {
        const result = await captureNeighborhoodSpatialMembership(client, origin.point.geometry_input, { page_size: 2, ...limits }, city.compact.choice, city.compact);
        assert.equal(result.status, 'incomplete'); assert.equal(result.query_complete, false); assert.equal(result.reason, reason);
        assert.equal(Object.hasOwn(result, 'account_ids'), false); assert.equal(Object.hasOwn(result, 'parcels'), false);
      });
    }
    checks.push('account/parcel/byte capacity refusal returns no partial roster');
    await transaction('REPEATABLE READ READ ONLY', async client => {
      const invalid = cityFixture({ type: 'Polygon', coordinates: [[[-104, 30], [-103.98, 30.02], [-104, 30.02], [-103.98, 30], [-104, 30]]] });
      const calls = [], wrapper = { query: config => { calls.push(config.text); return client.query(config); } };
      const result = await captureNeighborhoodSpatialMembership(wrapper, origin.point.geometry_input, {}, invalid.compact.choice, invalid.compact);
      assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'city_geometry_ineligible');
      assert.equal(result.query_complete, false); assert.equal(Object.hasOwn(result, 'parcels'), false);
      assert.equal(calls.some(text => text.includes('neighborhood-membership:parcels')), false);
      assert.equal(calls.length, 2, 'native invalid-city refusal precedes source geometry or membership queries');
    });
    checks.push('self-crossing city is rejected by actual PostGIS validity before any membership query');
    await transaction('REPEATABLE READ READ ONLY', async client => {
      const again = await createCustomCohortSubjectRepository(client, json(origin.scope)).loadRecordedPoint(origin.subjectReference);
      assert.equal(json(again), beforePoint, 'original retained subject point/source evidence remain unchanged');
      const state = (await client.query(`SELECT s.row_count::text,(SELECT count(*)::text FROM gis.dcad_parcels) AS actual
        FROM gis.source_sync_state s WHERE s.source_key='dcad_parcels'`)).rows[0];
      assert.equal(state.row_count, state.actual);
    });
    checks.push('retained subject point stays separate/outside, with original source digest unchanged and synthetic cache count coherent');
    return { checks, fixture: { prefix, object_ids: Object.fromEntries(seeded.map(row => [row.kind, row.object_id])),
      account_ids: Object.fromEntries(seeded.map(row => [row.kind, row.account_id])), city_choice: city.compact.choice,
      subject_point: origin.point.geometry_input }, membership_sha256: result.membership_sha256 };
  } finally { await pool.end(); }
}
