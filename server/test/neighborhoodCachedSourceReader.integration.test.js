import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createNeighborhoodCachedSourceReader } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';

const records=(capture,role) => capture.source_capture.sources
  .filter(source => source.payload.projection.definition.role===role).flatMap(source => source.payload.records);
const raw=(capture,role) => records(capture,role).map(record => record.data.raw_projection ?? record.data);

// Projection-shape fixtures, not an ingestion/migration-coverage certification.
// Canonical app scope comes from ordinary migrations. Source tables below model
// the checked existing cache columns, in this suite's new private CI database.
// Never invoke ensurePropertyContextSchema or provider/replication setup.
const sourceSchema=`
  CREATE SCHEMA gis;
  CREATE TABLE gis.source_sync_runs(id uuid PRIMARY KEY,source_key text,mode text,status text,
    records_seen bigint,records_written bigint,records_deleted bigint,started_at timestamptz,completed_at timestamptz);
  CREATE TABLE gis.source_sync_state(source_key text PRIMARY KEY,status text,source_vintage text,row_count bigint,
    last_attempt_at timestamptz,last_success_at timestamptz,last_source_update_at timestamptz,last_run_id uuid,updated_at timestamptz);
  CREATE TABLE gis.dcad_parcels(object_id bigint PRIMARY KEY,account_id text,low_parcel_id text,
    residential_year_built integer,residential_area_sqft numeric,parcel_area_sqft numeric,current_market_value numeric,
    land_use_category text,classification_confidence text,classification_review_reason text,subdivision_name text,
    source_record_hash text,source_updated_at timestamptz,sync_run_id uuid,synced_at timestamptz,geom geometry(MultiPolygon,4326));
  CREATE INDEX cache_fixture_parcel_account_idx ON gis.dcad_parcels(account_id);
  CREATE TABLE core.sales_source_records(id bigint PRIMARY KEY,source_name text,source_filename text,
    source_sha256 text,source_record_hash text,transaction_fingerprint text,listing_key text,listing_id text,
    source_system_name text,source_modified_at timestamptz,loaded_at timestamptz,updated_at timestamptz,
    primary_account_id text,record_type text,close_date date,listing_contract_date date,current_price numeric,
    living_area numeric,parcel_number_raw text,parcel_number2_raw text,match_status text,has_multiple_parcel_numbers boolean,
    multi_parcel_status text,has_unresolved_parcel boolean,requires_additional_review boolean,data_quality_flags jsonb);
  CREATE INDEX cache_fixture_source_account_idx ON core.sales_source_records(primary_account_id);
  CREATE TABLE core.sales(id bigint PRIMARY KEY,source_record_id bigint UNIQUE,account_id text,closing_date date,
    sale_price numeric,source text,loaded_at timestamptz);
  CREATE INDEX cache_fixture_sale_account_idx ON core.sales(account_id);
  CREATE TABLE core.sale_parcels(id bigint PRIMARY KEY,source_record_id bigint,source_position smallint,
    parcel_sequence smallint,parcel_role text,parcel_number_raw text,parcel_number_normalized text,account_id text,
    match_method text,is_resolved boolean,loaded_at timestamptz,UNIQUE(source_record_id,source_position,parcel_sequence));
  CREATE INDEX cache_fixture_link_account_idx ON core.sale_parcels(account_id,source_record_id);
`;

test('cached source reader: actual PostgreSQL selected membership, snapshot consistency and fail-closed budgets', {
  skip: !process.env.DATABASE_URL, timeout:360_000,
},async t => {
  const target=await prepareNeighborhoodCiDatabase(); // CI-only guard precedes every database import/connection.
  const { default:pg }=await import('pg');
  const pool=new pg.Pool({ connectionString:target.connectionString,max:4,connectionTimeoutMillis:3000,
    statement_timeout:8000,application_name:'neighborhood_cache_reader_integration' });
  const scope={ organization_id:randomUUID(),appraisal_case_id:randomUUID(),subject_snapshot_id:randomUUID(),account_id:'CACHE-SUBJECT' };
  const request={ scope,account_ids:['CACHE-SUBJECT'],effective_date:'2024-06-30',observation_period:{start_date:'2023-07-01',end_date:'2024-06-30'} };
  const run=randomUUID();
  const reader=createNeighborhoodCachedSourceReader(pool,{limits:{page_size:1}});
  try {
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic cache reader','Synthetic cache reader')",[scope.organization_id]);
    await pool.query("INSERT INTO core.accounts(account_id,county) VALUES('CACHE-SUBJECT','Synthetic'),('CACHE-OUTSIDE','Synthetic')");
    await pool.query('INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,$4)',
      [scope.appraisal_case_id,scope.organization_id,scope.account_id,request.effective_date]);
    await pool.query("INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data) VALUES($1,$2,1,$3,'{}')",
      [scope.subject_snapshot_id,scope.appraisal_case_id,request.effective_date]);

    await t.test('absent optional sources stay absent, never create tables or usable zero-count captures',async () => {
      const result=await reader.capture(request);
      assert.equal(result.status,'incomplete'); assert.equal(result.source_capture,null);
      assert.ok(result.incomplete_reasons.includes('parcels:absent'));
      assert.equal((await pool.query("SELECT to_regclass('gis.dcad_parcels') AS rel")).rows[0].rel,null);
    });
    await pool.query(sourceSchema);
    await pool.query("INSERT INTO gis.source_sync_runs VALUES($1,'dcad_parcels','full','complete',1,1,0,now(),now())",[run]);
    await pool.query("INSERT INTO gis.source_sync_state VALUES('dcad_parcels','current','fixture',1,now(),now(),now(),$1,now())",[run]);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,residential_year_built,residential_area_sqft,
      parcel_area_sqft,current_market_value,land_use_category,classification_confidence,source_record_hash,sync_run_id,synced_at,geom)
      VALUES(9007199254740993,'CACHE-SUBJECT',1980,2000,7000,250000,'one_unit','high',repeat('a',64),$1,now(),
        ST_Multi(ST_GeomFromText('POLYGON((-97 32,-96.99 32,-96.99 32.01,-97 32.01,-97 32))',4326)))`,[run]);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,sync_run_id,synced_at,geom)
      SELECT id,'CACHE-SUBJECT',$1,now(),ST_Multi(ST_GeomFromText('POLYGON((-97 32,-96.99 32,-96.99 32.01,-97 32.01,-97 32))',4326))
      FROM (VALUES(1),(2),(10),(100)) ids(id)`,[run]);
    await t.test('empty sales are captured as SQL emptiness, not verified absence of real-world sales',async () => {
      const result=await reader.capture(request);
      assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
      assert.deepEqual(raw(result,'parcels').map(row => row.object_id).sort(),['1','2','10','100','9007199254740993'].sort(),
        'numeric keyset order cannot use the text output alias before LIMIT');
      assert.deepEqual(raw(result,'transactions'),[]);
      assert.ok(result.unsupported_capabilities.includes('provider_coverage'));
      assert.equal(records(result,'parcels')[0].data.data.housing_type,null);
    });
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,close_date,current_price,
      source_record_hash,parcel_number2_raw,multi_parcel_status,loaded_at,updated_at) VALUES
      (10,'CACHE-SUBJECT','closed_sale','2024-01-01',250000,'unchanged-identity-token','secondary text','possible',now(),now()),
      (20,'CACHE-OUTSIDE','closed_sale','2027-01-01',350000,'second','', 'single',now(),now()),
      (30,'CACHE-OUTSIDE','listing',NULL,400000,'third',NULL,'single',now(),now()),
      (40,'CACHE-SUBJECT','listing',NULL,500000,'source-only',NULL,'single',now(),now());
      INSERT INTO core.sales VALUES(100,10,'CACHE-SUBJECT','2024-01-02',260000,'fixture',now()),
        (200,20,'CACHE-OUTSIDE','2027-01-01',350000,'fixture',now()),
        (300,30,'CACHE-SUBJECT',NULL,NULL,'fixture',now()),
        (9007199254740995,NULL,'CACHE-SUBJECT','2024-01-01',250000,'legacy',now());
      INSERT INTO core.sale_parcels VALUES
        (11,10,1,1,'primary','P1','P1','CACHE-SUBJECT','exact',true,now()),
        (12,10,2,1,'additional','P2','P2','CACHE-OUTSIDE','exact',true,now()),
        (13,10,2,2,'additional','UNKNOWN',NULL,NULL,'unmatched',false,now()),
        (21,20,1,1,'primary','P2','P2','CACHE-OUTSIDE','exact',true,now()),
        (22,20,2,1,'additional','P1','P1','CACHE-SUBJECT','exact',true,now());`);
    await t.test('all three discovery arms, secondary/unselected/null links, source-only/legacy and date conflicts survive',async () => {
      const result=await reader.capture(request);
      assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
      const sales=raw(result,'transactions');
      assert.deepEqual(sales.map(row => row.source_record_id).sort(),['10','20','30','40',null].sort());
      assert.equal(sales.find(row => row.source_record_id==='10').sale_price,'260000');
      assert.equal(sales.find(row => row.source_record_id==='10').source_current_price,'250000');
      assert.equal(sales.find(row => row.source_record_id==='20').source_close_date,'2027-01-01','future retained only as evidence, not eligible outcome');
      assert.equal(sales.find(row => row.source_record_id===null).sale_id,'9007199254740995');
      assert.equal(raw(result,'sale_links').length,5);
      assert.equal(raw(result,'sale_links').find(row => row.parcel_link_id==='13').account_id,null);
      for (const row of records(result,'transactions')) assert.equal(row.data.data.market_eligible,null);
    });
    await t.test('mixed-width numeric link/source cursors do not skip low IDs inside a multi-source batch',async () => {
      await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type) VALUES(2,'CACHE-SUBJECT','closed_sale');
        INSERT INTO core.sale_parcels VALUES(2,2,1,1,'primary','P1','P1','CACHE-SUBJECT','exact',true,now())`);
      const result=await createNeighborhoodCachedSourceReader(pool,{limits:{page_size:2}}).capture(request);
      assert.equal(result.status,'captured',JSON.stringify(result.incomplete_reasons));
      assert.deepEqual(raw(result,'sale_links').map(row => row.parcel_link_id).sort(),['2','11','12','13','21','22'].sort());
    });
    await t.test('later source/link replacement does not mix into an already-started read snapshot',async () => {
      let replaced=false;
      const wrapped={ async connect() {
        const client=await pool.connect();
        return {release:error => client.release(error),async query(config) {
          const result=await client.query(config);
          if (!replaced && config.text.includes('neighborhood-cache:source-ids')) {
            replaced=true;
            await pool.query("UPDATE core.sales_source_records SET current_price=275000 WHERE id=10; UPDATE core.sale_parcels SET account_id='CACHE-SUBJECT' WHERE id=12");
          }
          return result;
        }};
      }};
      const before=await createNeighborhoodCachedSourceReader(wrapped,{limits:{page_size:1}}).capture(request);
      assert.equal(before.status,'captured',JSON.stringify(before.incomplete_reasons));
      assert.equal(raw(before,'transactions').find(row => row.source_record_id==='10').source_current_price,'250000');
      assert.equal(raw(before,'sale_links').find(row => row.parcel_link_id==='12').account_id,'CACHE-OUTSIDE');
      const after=await reader.capture(request);
      assert.equal(raw(after,'transactions').find(row => row.source_record_id==='10').source_current_price,'275000');
      assert.equal(raw(after,'sale_links').find(row => row.parcel_link_id==='12').account_id,'CACHE-SUBJECT');
      assert.notDeepEqual(before.source_capture.sources.map(row => row.id),after.source_capture.sources.map(row => row.id));
    });
    await t.test('running current/origin runs and unverifiable knowledge cutoff never emit a usable capture',async () => {
      await pool.query("UPDATE gis.source_sync_runs SET status='running' WHERE id=$1",[run]);
      const incomplete=await reader.capture(request);
      assert.equal(incomplete.source_capture,null);
      assert.ok(incomplete.incomplete_reasons.includes('parcels:origin_run_not_complete'));
      await pool.query("UPDATE gis.source_sync_runs SET status='complete' WHERE id=$1",[run]);
      const old=await reader.capture({...request,knowledge_cutoff:'2024-06-30T00:00:00.000Z'});
      assert.deepEqual(old.incomplete_reasons,['historical_knowledge_capture_required']);
    });
    await t.test('row/aggregate limits and scope denials leave no published evidence or pool leaks',async () => {
      const small=await createNeighborhoodCachedSourceReader(pool,{limits:{row_bytes:10}}).capture(request);
      assert.deepEqual(small.incomplete_reasons,['row_bytes_limit']); assert.equal(small.source_capture,null);
      const aggregate=await createNeighborhoodCachedSourceReader(pool,{limits:{records:2}}).capture(request);
      assert.deepEqual(aggregate.incomplete_reasons,['record_limit']);
      await assert.rejects(reader.capture({...request,scope:{...scope,organization_id:randomUUID()}}),/scope_mismatch/);
      assert.equal((await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_assessment_jobs')).rows[0].n,0);
      assert.equal(pool.waitingCount,0);
    });
  } finally { await pool.end(); } // No DROP: disposable CI service teardown owns this database.
});
