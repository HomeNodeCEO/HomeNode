import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNeighborhoodCachedSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { checkedNeighborhoodDatabaseUrl, verifyNeighborhoodCiConnection, NEIGHBORHOOD_CI_IDENTITY_SQL } from './helpers/neighborhoodCiDatabase.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';

// Deliberately opt-in, fresh loopback database only. This verifies real snapshot
// semantics against minimal projection fixtures, not canonical migrations,
// ingestion, spatial source admission, licensing or an installed feature route.
const fixtureSchema=`
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA app; CREATE SCHEMA core; CREATE SCHEMA gis;
CREATE TABLE app.appraisal_cases(id uuid PRIMARY KEY,organization_id uuid,account_id text,effective_date date);
CREATE TABLE app.appraisal_subject_snapshots(id uuid PRIMARY KEY,appraisal_case_id uuid,effective_date date);
CREATE TABLE core.accounts(account_id text PRIMARY KEY,county text,subdivision text,neighborhood_code text,legal_description text);
CREATE TABLE gis.source_sync_runs(id uuid PRIMARY KEY,source_key text,mode text,status text,
  records_seen bigint,records_written bigint,records_deleted bigint,started_at timestamptz,completed_at timestamptz);
CREATE TABLE gis.source_sync_state(source_key text PRIMARY KEY,status text,source_vintage text,row_count bigint,
  last_attempt_at timestamptz,last_success_at timestamptz,last_source_update_at timestamptz,last_run_id uuid,updated_at timestamptz);
CREATE TABLE gis.dcad_parcels(object_id bigint PRIMARY KEY,account_id text,low_parcel_id text,
  residential_year_built integer,residential_area_sqft numeric,parcel_area_sqft numeric,current_market_value numeric,
  land_use_category text,classification_confidence text,classification_review_reason text,subdivision_name text,
  source_record_hash text,source_updated_at timestamptz,sync_run_id uuid,synced_at timestamptz,geom geometry(MultiPolygon,4326));
CREATE TABLE core.sales_source_records(id bigint PRIMARY KEY,source_name text,source_filename text,
  source_sha256 text,source_record_hash text,transaction_fingerprint text,listing_key text,listing_id text,
  source_system_name text,source_modified_at timestamptz,loaded_at timestamptz,updated_at timestamptz,
  primary_account_id text,record_type text,close_date date,listing_contract_date date,current_price numeric,
  living_area numeric,lot_size_area numeric,year_built integer,bedrooms_total integer,
  bathrooms_total_integer integer,bathrooms_full integer,bathrooms_half integer,
  structural_style text,housing_type text,attachment_type text,architectural_style text,
  garage_spaces numeric,garage_yn boolean,pool_yn boolean,days_on_market integer,
  parcel_number_raw text,parcel_number2_raw text,match_status text,has_multiple_parcel_numbers boolean,
  multi_parcel_status text,has_unresolved_parcel boolean,requires_additional_review boolean,data_quality_flags jsonb);
CREATE TABLE core.sales(id bigint PRIMARY KEY,source_record_id bigint UNIQUE,account_id text,closing_date date,
  sale_price numeric,source text,loaded_at timestamptz);
CREATE TABLE core.sale_parcels(id bigint PRIMARY KEY,source_record_id bigint,source_position smallint,parcel_sequence smallint,
  parcel_role text,parcel_number_raw text,parcel_number_normalized text,account_id text,match_method text,is_resolved boolean,loaded_at timestamptz);
`;
const settings="SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'";
const snapshotSql=`SELECT pg_backend_pid() AS backend_pid,pg_current_snapshot()::text AS snapshot,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transaction_started_at`;
// The actual metric predicate is exercised here without importing/transplanting
// the retained spatial branch. This fixture query is not a production producer.
const membershipSql=`SELECT object_id::text,account_id FROM gis.dcad_parcels
  WHERE ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(-96.8,32.8),4326)::geography,4828.032,true)
  ORDER BY object_id`;
const raw=(capture,role)=>capture.source_capture.sources.filter(source=>source.payload.projection.definition.role===role)
  .flatMap(source=>source.payload.records.map(record=>record.data.raw_projection ?? record.data));

test('caller snapshot capture: native autocommit refusal, shared discovery/source snapshot, owner cleanup',{
  skip:!process.env.NEIGHBORHOOD_SNAPSHOT_DATABASE_URL,timeout:60000,
},async t=>{
  const target=checkedNeighborhoodDatabaseUrl(process.env.NEIGHBORHOOD_SNAPSHOT_DATABASE_URL,process.env.NODE_ENV);
  assert.match(target.databaseName,/^neighborhood_snapshot_[a-f0-9]{32}_test$/,'Requires an explicitly created fresh snapshot test database');
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:3,connectionTimeoutMillis:3000,
    statement_timeout:5000,application_name:'neighborhood_snapshot_seam_native'});
  const client=await pool.connect();
  let releaseCalls=0,connectCalls=0;
  const calls=[];
  const owner={release(){releaseCalls++;throw new Error('Reader must not release owner client');},async query(config){
    calls.push(config.text);
    return client.query(config);
  }};
  const unusedPool={async connect(){connectCalls++;throw new Error('Caller path must not connect');}};
  const scope={organization_id:randomUUID(),appraisal_case_id:randomUUID(),subject_snapshot_id:randomUUID(),account_id:'SNAP-SUBJECT'};
  const run=randomUUID();
  const prepare=async(accountIds=['SNAP-SUBJECT'],limits={})=>{
    const request={scope,account_ids:accountIds,effective_date:'2024-06-30',
      observation_period:{start_date:'2023-07-01',end_date:'2024-06-30'}};
    const grant=createTestCachedReadAccess(request,{transactionClosure:{source_revision:'native-snapshot-fixture-v1',
      transactions:[{source_record_id:'10',sale_id:'20',primary_account_id:scope.account_id,
        sale_account_id:scope.account_id,source_record_hash:'b'.repeat(64)}],links:[],legacy:[]}});
    const issued=await grant.prepare();
    return {reader:createNeighborhoodCachedSourceReader(unusedPool,{access:grant.access,limits}),
      input:{...issued.request,auth:grant.auth,selection_grant:issued.selection_grant,market_grant:issued.market_grant}};
  };
  const capture=async(accountIds,limits)=>{
    const {reader,input}=await prepare(accountIds,limits);
    return reader.captureInSnapshot(owner,input);
  };
  const begin=async(statement='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')=>{
    await client.query(statement); await client.query(settings);
  };
  try {
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection.stream.remoteAddress,target.databaseName);
    const namespaces=(await client.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('app','core','gis')")).rows;
    assert.equal(namespaces.length,0,'Refusing to modify an existing fixture/application schema');
    await client.query(fixtureSchema);
    await client.query('INSERT INTO app.appraisal_cases VALUES($1,$2,$3,$4)',[scope.appraisal_case_id,scope.organization_id,scope.account_id,'2024-06-30']);
    await client.query('INSERT INTO app.appraisal_subject_snapshots VALUES($1,$2,$3)',[scope.subject_snapshot_id,scope.appraisal_case_id,'2024-06-30']);
    await client.query("INSERT INTO core.accounts(account_id) VALUES('SNAP-SUBJECT'),('SNAP-NEIGHBOR'),('SNAP-OUTSIDE'),('SNAP-NEW')");
    await client.query("INSERT INTO gis.source_sync_runs VALUES($1,'dcad_parcels','full','complete',3,3,0,now(),now())",[run]);
    await client.query("INSERT INTO gis.source_sync_state VALUES('dcad_parcels','current','fixture',3,now(),now(),now(),$1,now())",[run]);
    await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,sync_run_id,synced_at,geom)
      SELECT id,account,repeat('a',64),$1,now(),ST_Multi(ST_MakeEnvelope(lon,32.8000,lon+0.001,32.8010,4326))
      FROM (VALUES(1,'SNAP-SUBJECT',-96.8000),(2,'SNAP-NEIGHBOR',-96.7900),(3,'SNAP-OUTSIDE',-96.0000)) v(id,account,lon)`,[run]);
    await client.query(`INSERT INTO core.sales_source_records(id,primary_account_id,source_record_hash,record_type,close_date,current_price)
      VALUES(10,'SNAP-SUBJECT',repeat('b',64),'closed_sale','2024-03-01',100000);
      INSERT INTO core.sales VALUES(20,10,'SNAP-SUBJECT','2024-03-01',100000,'synthetic',now())`);

    await t.test('autocommit is rejected even with repeatable-read/read-only session defaults',async()=>{
      const count=calls.length;
      assert.deepEqual((await capture()).incomplete_reasons,['caller_snapshot_transaction_required']);
      assert.equal(calls.length-count,1);
      await client.query("SET default_transaction_isolation='repeatable read'; SET default_transaction_read_only=on; SET lock_timeout='1000ms'; SET idle_in_transaction_session_timeout='10000ms'; SET timezone='UTC'");
      assert.deepEqual((await capture()).incomplete_reasons,['caller_snapshot_transaction_required']);
      await client.query('RESET default_transaction_isolation; RESET default_transaction_read_only; RESET lock_timeout; RESET idle_in_transaction_session_timeout');
    });
    await t.test('read-committed and read-write explicit transactions are rejected without ending them',async()=>{
      for (const statement of ['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY','BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE']) {
        await begin(statement);
        const before=(await client.query(snapshotSql)).rows[0];
        assert.deepEqual((await capture()).incomplete_reasons,['caller_snapshot_transaction_required']);
        assert.equal((await client.query(snapshotSql)).rows[0].transaction_started_at,before.transaction_started_at);
        await client.query('ROLLBACK');
      }
    });
    let priorCapture;
    await t.test('discovery and source rows retain the same old snapshot after a second client commits',async()=>{
      await begin();
      const snapshot=(await client.query(snapshotSql)).rows[0];
      const roster=(await client.query(membershipSql)).rows.map(row=>row.account_id).sort();
      assert.deepEqual(roster,['SNAP-NEIGHBOR','SNAP-SUBJECT']);
      const writer=await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query("UPDATE gis.dcad_parcels SET geom=ST_Multi(ST_MakeEnvelope(-96,32.8,-95.999,32.801,4326)) WHERE object_id=2");
        await writer.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash,sync_run_id,synced_at,geom)
          VALUES(4,'SNAP-NEW',repeat('a',64),$1,now(),ST_Multi(ST_MakeEnvelope(-96.795,32.8,-96.794,32.801,4326)))`,[run]);
        await writer.query("UPDATE gis.source_sync_state SET row_count=4; UPDATE core.sales SET sale_price=200000; UPDATE core.sales_source_records SET current_price=200000");
        await writer.query('COMMIT');
      } catch(error) {await writer.query('ROLLBACK');throw error;}
      finally {writer.release();}
      priorCapture=await capture(roster);
      assert.equal(priorCapture.status,'captured',JSON.stringify(priorCapture.incomplete_reasons));
      assert.deepEqual(priorCapture.snapshot,snapshot);
      assert.deepEqual(raw(priorCapture,'parcels').map(row=>row.account_id).sort(),roster);
      assert.equal(raw(priorCapture,'transactions')[0].sale_price,'100000');
      assert.deepEqual((await client.query(membershipSql)).rows.map(row=>row.account_id).sort(),roster);
      assert.deepEqual((await client.query(snapshotSql)).rows[0],snapshot);
      await client.query('COMMIT');
    });
    await t.test('a new owned snapshot observes the committed roster and changed sale price',async()=>{
      await begin();
      const roster=(await client.query(membershipSql)).rows.map(row=>row.account_id).sort();
      assert.deepEqual(roster,['SNAP-NEW','SNAP-SUBJECT']);
      const next=await capture(roster);
      assert.equal(next.status,'captured',JSON.stringify(next.incomplete_reasons));
      assert.equal(raw(next,'transactions')[0].sale_price,'200000');
      assert.notEqual(next.selection_sha256,priorCapture.selection_sha256);
      await client.query('ROLLBACK');
    });
    await t.test('a bounded capture failure leaves prior temporary owner work untouched until owner rollback',async()=>{
      await client.query('CREATE TEMP TABLE snapshot_owner_work(value integer)');
      await begin();
      await client.query('INSERT INTO snapshot_owner_work VALUES(7)');
      const before=(await client.query(snapshotSql)).rows[0];
      assert.deepEqual((await capture(undefined,{records:1})).incomplete_reasons,['record_limit']);
      assert.deepEqual((await client.query('SELECT value FROM snapshot_owner_work')).rows,[{value:7}]);
      assert.deepEqual((await client.query(snapshotSql)).rows[0],before);
      await client.query('ROLLBACK');
      assert.deepEqual((await client.query('SELECT value FROM snapshot_owner_work')).rows,[]);
    });
    await t.test('real server statement timeout leaves rollback to the owner, never hiding the failed transaction',async()=>{
      await begin(); await client.query("SET LOCAL statement_timeout='10ms'");
      const {reader,input}=await prepare();
      const timed={release:owner.release,async query(config){
        if(config.text.includes('neighborhood-cache:parcels')) await client.query('SELECT pg_sleep(0.1)');
        return owner.query(config);
      }};
      const result=await reader.captureInSnapshot(timed,input);
      assert.deepEqual(result.incomplete_reasons,['source_query_unavailable']); assert.equal(result.source_capture,null);
      await assert.rejects(client.query('SELECT 1'),error=>error.code==='25P02');
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT 1 AS value')).rows[0].value,1);
    });
    assert.equal(connectCalls,0); assert.equal(releaseCalls,0);
    assert.ok(calls.every(text=>!/^\s*(?:\/\*[^]*?\*\/\s*)?(?:BEGIN|COMMIT|ROLLBACK|SET|RELEASE)\b/i.test(text)));
  } finally {
    await client.query('ROLLBACK').catch(()=>{}); client.release(); await pool.end();
  }
});
