import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createNeighborhoodCachedSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { createTestCachedReadAccess } from '../fixtures/neighborhoodCachedReadAccessFixture.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from '../fixtures/neighborhoodCachedSourceSchemaFixture.js';

/** Caller supplies a NEW migrated disposable database. Before any fixture write,
 * require test mode, a loopback *_test URL and matching native socket/database
 * identity. This helper never creates/drops databases or changes production GIS.
 * Source tables and license grants are explicit synthetic projection fixtures.
 */
export async function runNeighborhoodOriginalCaptureDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const require = createRequire(import.meta.url);
  const pg = require('pg');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'neighborhood_original_capture_test' });
  try {
    const client = await pool.connect();
    try {
      const identity = (await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0];
      verifyNeighborhoodCiConnection(identity, client.connection?.stream?.remoteAddress, target.databaseName);
    } finally { client.release(); }
    // CREATE SCHEMA intentionally refuses a database already containing GIS.
    // No IF NOT EXISTS, broad cleanup, table replacement or shared fallback.
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    const scope = { organization_id: randomUUID(), appraisal_case_id: randomUUID(),
      subject_snapshot_id: randomUUID(), account_id: 'CAPTURE-SUBJECT' };
    const run = randomUUID(), sourceHash = 'a'.repeat(64);
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic capture','Synthetic capture')", [scope.organization_id]);
    await pool.query("INSERT INTO core.accounts(account_id,county) VALUES($1,'Synthetic')", [scope.account_id]);
    await pool.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,'2024-06-30')",
      [scope.appraisal_case_id, scope.organization_id, scope.account_id]);
    await pool.query("INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data) VALUES($1,$2,1,'2024-06-30','{}')",
      [scope.subject_snapshot_id, scope.appraisal_case_id]);
    await pool.query("INSERT INTO gis.source_sync_runs(id,source_key,mode,status,started_at,completed_at) VALUES($1,'dcad_parcels','full','complete',now()-interval '1 second',now())", [run]);
    await pool.query("INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id,last_success_at) VALUES('dcad_parcels','current',1,$1,now())", [run]);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
      VALUES(1,$1,8000,$2,$3,now(),ST_GeomFromText('MULTIPOLYGON(((-96.7 32.8,-96.699 32.8,-96.699 32.801,-96.7 32.801,-96.7 32.8)))',4326))`,
    [scope.account_id, sourceHash, run]);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,loaded_at)
      VALUES(10,$1,'closed_sale',$2,'2024-03-01',now())`, [scope.account_id, sourceHash]);
    await pool.query("INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at) VALUES(100,10,$1,'2024-03-01',300000,'Synthetic',now())", [scope.account_id]);
    await pool.query("INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,loaded_at) VALUES(11,10,1,1,$1,true,now())", [scope.account_id]);
    const request = { scope, account_ids: [scope.account_id], effective_date: '2024-06-30',
      observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } };
    const fixture = createTestCachedReadAccess(request, { transactionClosure: {
      source_revision: 'native-original-capture-fixture-v1',
      transactions: [{ source_record_id: '10', sale_id: '100', primary_account_id: scope.account_id,
        sale_account_id: scope.account_id, source_record_hash: sourceHash }],
      links: [{ parcel_link_id: '11', source_record_id: '10', source_position: 1,
        parcel_sequence: 1, account_id: scope.account_id, is_resolved: true }], legacy: [],
    } });
    const prepared = await fixture.prepare();
    const reader = createNeighborhoodCachedSourceReader(pool, { access: fixture.access });
    const capture = await reader.capture({ ...prepared.request, auth: fixture.auth,
      selection_grant: prepared.selection_grant, market_grant: prepared.market_grant });
    assert.equal(capture.status, 'captured', JSON.stringify(capture.incomplete_reasons));
    assert.equal(capture.query_complete, true);
    const publicJson = JSON.stringify(capture);
    const required = { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' };
    assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, JSON.parse(publicJson)), required);
    const otherReader = createNeighborhoodCachedSourceReader(pool, { access: fixture.access });
    assert.throws(() => consumeNeighborhoodCachedAcquisition(otherReader, capture), required);
    await pool.query('UPDATE gis.dcad_parcels SET parcel_area_sqft=9000 WHERE object_id=1');
    const original = consumeNeighborhoodCachedAcquisition(reader, capture);
    assert.equal(original.authority, 'not_established');
    assert.equal(original.capture_result, capture);
    assert.deepEqual(original.captured_query_request, prepared.request);
    assert.equal(original.captured_query_request.transaction_closure.links.length, 1);
    const compact = JSON.parse(original.compact_metadata_json);
    assert.equal(Object.hasOwn(compact, 'selection_sha256'), false);
    const hash = createHash('sha256').update(original.compact_metadata_json);
    for (const id of original.captured_query_request.account_ids) hash.update(canonicalAssessmentJson(id)).update('\n');
    assert.equal(hash.digest('hex'), capture.selection_sha256);
    const parcels = capture.source_capture.sources.filter(source => source.payload.projection.definition.role === 'parcels')
      .flatMap(source => source.payload.records);
    assert.equal(parcels[0].data.raw_projection.parcel_area_sqft, '8000');
    assert.equal((await pool.query('SELECT parcel_area_sqft::text AS area FROM gis.dcad_parcels WHERE object_id=1')).rows[0].area, '9000');
    assert.equal(JSON.stringify(capture), publicJson);
    assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, capture), required);
    // Fresh grants do not turn an incomplete source query into an original
    // completed capture, even when an earlier request did succeed.
    await pool.query("DELETE FROM gis.source_sync_state WHERE source_key='dcad_parcels'");
    const retry = await fixture.prepare();
    const incomplete = await reader.capture({ ...retry.request, auth: fixture.auth,
      selection_grant: retry.selection_grant, market_grant: retry.market_grant });
    assert.equal(incomplete.status, 'incomplete');
    assert.equal(incomplete.source_capture, null);
    assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, incomplete), required);
    assert.equal(pool.waitingCount, 0);
  } finally { await pool.end(); }
}
