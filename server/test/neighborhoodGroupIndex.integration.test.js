import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from './fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { runNeighborhoodGroupIndex,getPreparedNeighborhoodGroupSummary }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';
import { createCustomCohortCaptureJobRepository }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { withCustomCohortJobTransaction }
  from '../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createNeighborhoodFrozenSourcePages, NEIGHBORHOOD_FROZEN_PAGE_LIMITS }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourcePages.js';
import { createNeighborhoodFrozenSpatialPages }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';
import { createNeighborhoodFrozenSourceClosurePages }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';
import { createCohortOriginalTextChunksV1Store }
  from '../src/services/neighborhoodAssessment/cohortOriginalTextChunksV1.js';
import { createNeighborhoodCohortBlobRepository }
  from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { createCohortOriginalSourceChainV1Store }
  from '../src/services/neighborhoodAssessment/cohortOriginalSourceChainV1.js';
import { createCustomCohortContextCapture }
  from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createNeighborhoodFrozenJobStock }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStock.js';

const frozenSpatialOptions = options => ({...options,
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',
    coordinate_encoding:'decimal_string_v1',coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},
  discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}});

test('isolated PostgreSQL: publishes indexed city/subdivision facts and preserves exact sale dates',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try {
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    // The isolated UAD fixture has bedroom/bath and secondary rows but omits
    // the DCAD pool column. Add it only inside this throwaway child database.
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM pg_indexes
      WHERE schemaname='app' AND tablename='neighborhood_custom_cohort_prepared_generation_pins'
        AND indexname='neighborhood_cohort_prepared_pins_generation_idx'`)).rows[0].count,1,
      'the declared generation pin index exists with its exact non-truncated name');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES
      ('INDEX-A','Dallas','Garland','Monica Park 4'),
      ('INDEX-B','Dallas','Garland',' MONICA  PARK 4 '),
      ('INDEX-C','Dallas','Garland','Another Park'),
      ('INDEX-D','Dallas','Garland',NULL)`);
    // Two individually valid near-row-limit originals must split by transport
    // bytes, not be truncated, skipped, or returned as one oversized page.
    await pool.query(`UPDATE core.accounts SET legal_description=repeat('A',900000)
      WHERE account_id IN ('INDEX-A','INDEX-B')`);
    // This valid sub-1-MB JSON original grows beyond the former 1.5-MB limit
    // when payload::text is embedded as a string in the encoded transport row.
    await pool.query(`UPDATE core.accounts SET legal_description=repeat(chr(92),480000)
      WHERE account_id='INDEX-B'`);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,current_price,close_date,raw_payload)
      VALUES(501,'INDEX-A',9007199254740993,'2010-01-01','{"ClosePrice":9007199254740993}'::jsonb)`);
    await pool.query(`INSERT INTO gis.dcad_parcels
      (object_id,account_id,subdivision_name,residential_area_sqft,residential_year_built,
       parcel_area_sqft,current_market_value,source_record_hash,source_updated_at)
      VALUES (1,'INDEX-A','Monica Park 4',1000,1960,8000,100000,'a',now()),
             (2,'INDEX-B','Monica Park 4',2000,1970,9000,200000,'b',now()),
             (3,'INDEX-C','Wrong Park',3000,1980,10000,300000,'c',now()),
             (4,'INDEX-D','Park West',1200,1965,7000,150000,'d',now()),
             (5,'INDEX-D','Park East',1400,1965,7000,150000,'e',now())`);
    await pool.query(`INSERT INTO core.sales(id,account_id,closing_date,sale_price,days_on_market)
      VALUES (10,'INDEX-A','2024-01-01',100000,30),
             (11,'INDEX-B','2025-01-01',300000,45),
             (12,'INDEX-C','2025-01-01',500000,10),
             (13,'INDEX-D','2025-02-01',150000,20)`);
    await pool.query(`INSERT INTO core.primary_improvements(account_id,bedroom_count,bath_count,pool)
      VALUES ('INDEX-A',3,2,true),('INDEX-B',4,NULL,NULL),('INDEX-C',NULL,NULL,false)`);
    await pool.query(`INSERT INTO core.secondary_improvements(id,account_id,sec_imp_type,sec_imp_sqft)
      VALUES (1,'INDEX-A','ATTACHED GARAGE',400),(2,'INDEX-B','DETACHED GARAGE',500),
             (3,'INDEX-A','STORAGE BUILDING',100),(4,'INDEX-C','POOL',250)`);
    await pool.query(`UPDATE gis.dcad_parcels SET geom=ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326)) WHERE object_id=1`);
    const originalGeometry=(await pool.query("SELECT encode(ST_AsEWKB(geom),'hex') AS geometry FROM gis.dcad_parcels WHERE object_id=1")).rows[0].geometry;
    const first=await runNeighborhoodGroupIndex(pool,{batchSize:1,logger:{info(){}},retainOriginalSources:true});
    assert.equal(first.status,'complete');
    assert.equal(first.parcels,5);
    assert.equal(first.sales,4);
    const frozen=(await pool.query('SELECT * FROM app.neighborhood_frozen_source_generations WHERE generation_id=$1',[first.generationId])).rows[0];
    assert.equal(frozen.status,'complete');assert.equal(frozen.format_version,1);
    assert.equal(frozen.layer_counts.parcels.row_count,'5');assert.equal(frozen.layer_counts.sales.row_count,'4');
    const original=(await pool.query("SELECT payload FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='1'",[first.generationId])).rows[0].payload;
    assert.equal(original.stored_geometry_ewkb,originalGeometry,'nightly materialization preserves exact original EWKB');
    assert.equal(original.residential_area_sqft,'1000');
    await assert.rejects(pool.query("UPDATE app.neighborhood_frozen_source_rows SET payload='{}' WHERE generation_id=$1",[first.generationId]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_source_rows'),error=>error.code==='55000');
    const summary=await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'});
    assert.ok(summary.completed_at > summary.source_observed_at,
      'completion must record the end of the long source transaction');
    assert.ok(summary.published_at >= summary.completed_at);
    assert.equal(summary.parcel_count,'2');
    assert.equal(summary.account_count,'2');
    assert.equal(summary.median_living_area_sqft,1500);
    assert.equal(summary.bedroom_count,'2');
    assert.equal(summary.median_bedroom_count,3.5);
    assert.equal(summary.bath_count,'1');
    assert.equal(summary.median_bath_count,2);
    assert.equal(summary.median_garage_area_sqft,450);
    assert.equal(summary.outbuilding_area_count,'1');
    assert.equal(summary.median_outbuilding_area_sqft,100);
    assert.equal(summary.pool_observed_count,'1');
    assert.equal(summary.pool_present_count,'1');
    assert.equal(summary.sale_count,'2');
    assert.equal(summary.median_sale_price,200000);
    const dates=(await pool.query(`SELECT closing_date::text FROM app.neighborhood_group_sale_facts
      WHERE generation_id=$1 AND subdivision_key='monica park 4' ORDER BY closing_date`,[first.generationId])).rows;
    assert.deepEqual(dates.map(row=>row.closing_date),['2024-01-01','2025-01-01']);
    const conflictingSale=(await pool.query(`SELECT county_key,city_key,subdivision_key
      FROM app.neighborhood_group_sale_facts WHERE generation_id=$1 AND sale_id=12`,[first.generationId])).rows[0];
    assert.deepEqual(conflictingSale,{county_key:null,city_key:null,subdivision_key:null});
    const splitSale=(await pool.query(`SELECT county_key,city_key,subdivision_key
      FROM app.neighborhood_group_sale_facts WHERE generation_id=$1 AND sale_id=13`,[first.generationId])).rows[0];
    assert.deepEqual(splitSale,{county_key:null,city_key:null,subdivision_key:null});
    assert.equal((await pool.query(`SELECT label_conflict,subdivision_key FROM app.neighborhood_group_parcel_facts
      WHERE generation_id=$1 AND object_id=3`,[first.generationId])).rows[0].label_conflict,true);
    const physical=(await pool.query(`SELECT object_id,pool,garage_area_sqft,outbuilding_area_sqft
      FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1 ORDER BY object_id`,
      [first.generationId])).rows;
    assert.equal(physical[1].pool,null);
    assert.equal(physical[1].outbuilding_area_sqft,null);
    assert.equal(physical[2].pool,true);
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Prepared pin synthetic','Prepared pin synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Prepared pin actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files
      (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'INDEX-A',$2,$3,$3) RETURNING id::text`,[organization,`PIN-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files
      (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'INDEX-A','custom_appraisal',$3,$4)`,[report,organization,`PIN-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'INDEX-A'};
    const options={scope,actorUserId:actor};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .enqueue({scope,actorUserId:actor,request:{operation_id:operation,
        observation_period:{start_date:'2024-01-01',end_date:'2025-12-31'}}}));
    const claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      assert.equal(job.operation_id,operation);
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};
    });
    await assert.rejects(createCustomCohortCaptureJobRepository(pool).pinPreparedGeneration(claim,options),
      /caller_transaction_required/,'autocommit is refused before any pin write');
    assert.equal(await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(claim,options)),null,'a read miss does not pin the current generation');
    const rollback=new Error('synthetic pin rollback');
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      assert.equal((await createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,options)).generation_id,first.generationId);
      throw rollback;
    }),rollback);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_prepared_generation_pins')).rows[0].count,0);
    const lostAck=new Error('synthetic pin COMMIT acknowledgement lost');
    const losingPool={async connect(){
      const raw=await pool.connect();
      return {async query(config){const result=await raw.query(config);if(config.text==='COMMIT')throw lostAck;return result;},
        on:raw.on.bind(raw),off:raw.off.bind(raw),release:raw.release.bind(raw)};
    }};
    await assert.rejects(withCustomCohortJobTransaction(losingPool,client=>createCustomCohortCaptureJobRepository(client)
      .pinPreparedGeneration(claim,options)),error=>error===lostAck && error.outcome_unknown===true);
    const pinned=await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(claim,options));
    assert.equal(pinned.generation_id,first.generationId,'fresh connection recovers the actual committed pin');
    assert.equal(pinned.parcel_count,'5');
    const originalPage=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'parcels',cursor:'',rowLimit:2}));
    assert.deepEqual(originalPage.rows.map(row=>row.row_key),['1','2']);assert.equal(originalPage.end_of_layer,false);
    assert.equal(JSON.parse(originalPage.rows[0].payload_text).stored_geometry_ewkb,originalGeometry);
    assert.equal(originalPage.authority,'not_established');assert.equal(originalPage.coverage,'page_only');
    const accountPage=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'accounts',cursor:'',rowLimit:4}));
    assert.deepEqual(accountPage.rows.map(row=>row.row_key),['INDEX-A']);assert.equal(accountPage.end_of_layer,false);
    assert.ok(accountPage.page_utf8_bytes<=NEIGHBORHOOD_FROZEN_PAGE_LIMITS.page_utf8_bytes);
    const accountEnd=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'accounts',cursor:accountPage.next_cursor,rowLimit:4}));
    assert.deepEqual(accountEnd.rows.map(row=>row.row_key),['INDEX-B','INDEX-C','INDEX-D']);
    assert.equal(accountEnd.end_of_layer,true);
    assert.equal(JSON.parse(accountEnd.rows[0].payload_text).legal_description,'\\'.repeat(480000));
    assert.ok(accountEnd.page_utf8_bytes>1_500_000,
      'a valid heavily escaped original is admitted, and later keys remain reachable');
    assert.ok(accountEnd.page_utf8_bytes<=NEIGHBORHOOD_FROZEN_PAGE_LIMITS.page_utf8_bytes);
    const pricePage=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'source_records',cursor:'',rowLimit:2}));
    assert.equal(JSON.parse(pricePage.rows[0].payload_text).current_price,'9007199254740993',
      'bounded source pages preserve exact original decimal text before Number interpretation');
    const spatialPage=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSpatialPages(client,
      frozenSpatialOptions({...options,claim})).page({kind:'parcels',cursor:'',rowLimit:2}));
    assert.deepEqual(spatialPage.rows.map(row=>row.object_id),['1']);
    assert.deepEqual(spatialPage.population,{parcel_count:'1',account_count:'1',unassociated_parcel_count:'0',
      subject_included:true,unlocatable_global_parcels:'4',invalid_geometries:'0'});
    assert.equal(spatialPage.authority,'not_established');assert.equal(spatialPage.coverage,'page_only');
    for(const sql of [
      'UPDATE app.neighborhood_group_generations SET parcel_count=0 WHERE generation_id=$1',
      'UPDATE app.neighborhood_group_parcel_facts SET living_area_sqft=1 WHERE generation_id=$1',
      'DELETE FROM app.neighborhood_group_sale_facts WHERE generation_id=$1',
      'DELETE FROM app.neighborhood_group_summary WHERE generation_id=$1',
    ]) await assert.rejects(pool.query(sql,[first.generationId]),error=>error.code==='55000');
    await assert.rejects(pool.query(`INSERT INTO app.neighborhood_group_parcel_facts(generation_id,object_id,account_id)
      VALUES($1,9999,'INDEX-A')`,[first.generationId]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_group_sale_facts'),error=>error.code==='55000');
    await assert.rejects(pool.query('DELETE FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation]));
    for(const wrong of [{...options,actorUserId:randomUUID()},
      {...options,scope:{...scope,report_file_id:randomUUID()}},
      {...options,scope:{...scope,organization_id:randomUUID()}},
      {...options,scope:{...scope,assignment_file_id:String(BigInt(assignment)+1n)}},
      {...options,scope:{...scope,account_id:'INDEX-B'}}]) {
      await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
        .readPreparedGeneration(claim,wrong)),/claim_lost/);
    }
    await pool.query('UPDATE gis.dcad_parcels SET residential_area_sqft=4000 WHERE object_id=2');
    const second=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}},retainOriginalSources:true});
    assert.equal(second.status,'complete');
    assert.equal((await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'})).median_living_area_sqft,2500);
    assert.notEqual(first.generationId,second.generationId);
    const third=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    const fourth=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    assert.equal(third.status,'complete');assert.equal(fourth.status,'complete');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_generations WHERE generation_id=$1',[second.generationId])).rows[0].count,0,
      'an old unpinned generation is still pruned');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1',[second.generationId])).rows[0].count,0,
      'obsolete unpinned original pages retire with their generation');
    assert.equal((await pool.query("SELECT payload->>'residential_area_sqft' AS area FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='2'",[first.generationId])).rows[0].area,'2000',
      'a pinned original source snapshot survives later source edits and nightly sweeps');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1',[first.generationId])).rows[0].count,5,
      'later sweeps preserve every pinned parcel');
    assert.equal((await pool.query('SELECT living_area_sqft::text AS area FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1 AND object_id=2',[first.generationId])).rows[0].area,'2000');
    assert.deepEqual(await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .pinPreparedGeneration(claim,options)),pinned,'replay does not switch to the latest sweep');
    const resumed=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'parcels',cursor:originalPage.next_cursor,rowLimit:2}));
    assert.deepEqual(resumed.rows.map(row=>row.row_key),['3','4']);
    assert.equal(resumed.original.generation_id,first.generationId,'fresh page client never follows a later sweep');
    const spatialResumed=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSpatialPages(client,
      frozenSpatialOptions({...options,claim})).page({kind:'accounts',cursor:'',rowLimit:2}));
    assert.deepEqual(spatialResumed.rows,[{account_id:'INDEX-A',parcel_count:'1'}]);
    assert.equal(spatialResumed.definition_sha256,spatialPage.definition_sha256,
      'fixed point/radius/operation and original sweep give one stable resumable spatial definition');
    await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE operation_id=$1`,[operation]);
    const nextClaim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      assert.equal(job.operation_id,operation);assert.equal(job.attempts,2);
      return {operation_id:operation,claim_token:job.claim_token,attempts:2};
    });
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(claim,options)),/claim_lost/);
    assert.deepEqual(await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(nextClaim,options)),pinned,'a replacement worker resumes the same retained generation');
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim}).page({kind:'parcels',cursor:resumed.next_cursor,rowLimit:2})),/claim_lost/);
    const finalPage=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim:nextClaim}).page({kind:'parcels',cursor:resumed.next_cursor,rowLimit:2}));
    assert.deepEqual(finalPage.rows.map(row=>row.row_key),['5']);assert.equal(finalPage.end_of_layer,true);
    assert.equal(finalPage.original.generation_id,first.generationId);
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,operation));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(nextClaim,options)),/claim_lost/);
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourcePages(client,
      {...options,claim:nextClaim}).page({kind:'parcels',cursor:'',rowLimit:2})),/claim_lost/);
  } finally { await pool.end(); }
});

test('isolated PostgreSQL: freezes a complete 60001-account original source population without Node row transfer',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try {
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision)
      SELECT 'FROZEN-'||lpad(n::text,5,'0'),'Dallas','Garland','Synthetic Source Park'
      FROM generate_series(1,60001) n`);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,residential_area_sqft,
      residential_year_built,parcel_area_sqft,current_market_value,source_record_hash,source_updated_at,geom)
      SELECT n,'FROZEN-'||lpad(n::text,5,'0'),'Synthetic Source Park',1000+n%100,1960+n%40,6000,200000,
        'synthetic-'||n::text,now(),ST_Multi(ST_MakeEnvelope(-96.7+(n%250)*0.0001,32.9+(n/250)*0.0001,
          -96.7+(n%250)*0.0001+0.00008,32.9+(n/250)*0.0001+0.00008,4326))
      FROM generate_series(1,60001) n`);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,source_record_hash) VALUES(60002,NULL,'synthetic-unmatched')`);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,current_price,close_date,raw_payload)
      VALUES(501,'FROZEN-00001',9007199254740993,'2010-01-01',
        '{"ClosePrice":9007199254740993,"Currency":"USD","PrivateFixtureKey":"must-not-be-retained"}'::jsonb),
        (502,NULL,NULL,'2026-10-01',NULL)`);
    await pool.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price)
      VALUES(1,501,'FROZEN-00001','2010-01-01',9007199254740993),
        (2,502,NULL,'2026-10-01',NULL),(3,NULL,'FROZEN-00002','2024-01-01',250000)`);
    await pool.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved)
      VALUES(1,501,1,1,'FROZEN-00001',true),(2,501,1,2,'FROZEN-00002',true),(3,502,1,1,NULL,false)`);
    const runId=randomUUID();
    await pool.query(`INSERT INTO gis.source_sync_runs(id,source_key,status,records_seen)
      VALUES($1,'dcad_parcels','complete',60002)`,[runId]);
    await pool.query(`INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id)
      VALUES('dcad_parcels','complete',60002,$1)`,[runId]);
    let maxResultRows=0,sourcePageCount=0;
    const measuredPool={async connect(){const raw=await pool.connect();return {
      async query(sql,values){const result=await raw.query(sql,values);const text=typeof sql==='string'?sql:sql.text;
        if(text.includes('neighborhood-frozen-source:')) {sourcePageCount++;maxResultRows=Math.max(maxResultRows,result.rows.length);
          assert.ok(result.rows.every(row=>!Object.hasOwn(row,'payload')&&!Object.hasOwn(row,'geom')),
            'original record payloads and geometry do not enter the nightly Node process');}
        return result;},release:raw.release.bind(raw)};}};
    const frozen=await runNeighborhoodGroupIndex(measuredPool,{batchSize:250,logger:{info(){}},retainOriginalSources:true});
    assert.equal(frozen.status,'complete');assert.equal(frozen.parcels,60001);
    assert.equal(maxResultRows,1);assert.ok(sourcePageCount>480);
    const header=(await pool.query('SELECT * FROM app.neighborhood_frozen_source_generations WHERE generation_id=$1',[frozen.generationId])).rows[0];
    assert.equal(header.status,'complete');assert.equal(header.row_count,'120013');
    for(const [kind,count] of Object.entries({parcels:60002,accounts:60001,source_records:2,sales:3,sale_links:3,sync_state:1,sync_runs:1})) {
      assert.equal(header.layer_counts[kind].row_count,String(count));
      assert.equal((await pool.query('SELECT count(*)::text AS count FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind=$2',[frozen.generationId,kind])).rows[0].count,String(count));
    }
    const source=(await pool.query("SELECT payload FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='source_records' AND row_key='501'",[frozen.generationId])).rows[0].payload;
    assert.equal(source.current_price,'9007199254740993');
    assert.equal(source.source_raw_witness.fields.ClosePrice.value_text,'9007199254740993');
    assert.equal(JSON.stringify(source).includes('PrivateFixtureKey'),false);
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Spatial synthetic','Spatial synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Spatial actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'FROZEN-00001',$2,$3,$3) RETURNING id::text`,[organization,`SPATIAL-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'FROZEN-00001','custom_appraisal',$3,$4)`,[report,organization,`SPATIAL-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'FROZEN-00001'};
    const options={scope,actorUserId:actor};
    const appraisalCase=randomUUID(),snapshot=randomUUID();
    await pool.query('INSERT INTO app_auth.organization_memberships(organization_id,user_id) VALUES($1,$2)',[organization,actor]);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    await pool.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,'FROZEN-00001','2026-10-07')",[appraisalCase,organization]);
    const subjectData={custom_property_snapshot:{account:{account_id:scope.account_id},improvement:{living_area_sqft:1001},location:{
      account_id:scope.account_id,latitude:32.9,longitude:-96.7,source:'dcad_parcel_query',precision:'parcel_centroid',
      status:'matched',confidence:'high',review_required:false,review_reason:null,match_method:'parcel_id',source_parcel_id:scope.account_id,
      feature_count:1,metadata:{address_agreement:true},geocoded_at:'2020-01-01T00:00:00.000Z',source_updated_at:'2019-12-31T00:00:00.000Z'}}};
    await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES($1,$2,1,'2026-10-07',$3::jsonb)`,[snapshot,appraisalCase,JSON.stringify(subjectData)]);
    await pool.query('UPDATE app.report_files SET appraisal_case_id=$1,subject_snapshot_id=$2 WHERE id=$3',[appraisalCase,snapshot,report]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',[assignment,`stock-${randomUUID()}`]);
    const discovery={profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'},discovery}}));
    let claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};
    });
    const stockCalls=[];
    let revokeAtCompletion=false,loseStockCommit=false;
    const stockPool={async connect(){const client=await pool.connect();return {
      release:client.release.bind(client),async query(config){stockCalls.push(config.text);
        const result=await client.query(config);
        if(config.text.includes('neighborhood-frozen-job-stock:complete')&&revokeAtCompletion){revokeAtCompletion=false;
          await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
        if(config.text==='COMMIT'&&loseStockCommit){loseStockCommit=false;throw new Error('synthetic stock COMMIT acknowledgement lost');}
        if(config.text.includes('neighborhood-frozen-job-stock:'))assert.ok(result.rows.length<=1,'stock computation does not transfer a dense roster');
        return result;}};}};
    const owner=createCustomCohortContextCapture({pool:stockPool,authorizeMarketData:()=>assert.fail('public stock does not read licensed market rows')});
    const stockInput={auth:{userId:actor,organizations:[]},accountId:scope.account_id,assignmentFileId:assignment,operationId:operation,
      observationPeriod:{start_date:'2025-01-01',end_date:'2026-10-07'},discovery};
    await assert.rejects(owner.prepareFrozenCaptureJobStock({...stockInput,discovery:{...discovery,radius_metres:'16093.44'}},{captureJobClaim:claim}),/operation_conflict/,
      'current job payload, not a new worker radius, owns the definition');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_job_stocks')).rows[0].n,0);
    revokeAtCompletion=true;
    await assert.rejects(owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim}),/job_actor_access_revoked/,
      'role revocation after exact stock writes rolls back the entire unpublished stage');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_job_stocks')).rows[0].n,0);
    assert.equal((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0].checkpoint,null);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    loseStockCommit=true;
    await assert.rejects(owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim}),error=>error.outcome_unknown===true);
    const beforeReplay=stockCalls.length;
    const prepared=await owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim});
    assert.equal(prepared.reused,true);assert.equal(prepared.population.account_count,'60001');assert.equal(prepared.population.parcel_count,'60001');
    assert.equal(prepared.population.unlocatable_global_parcels,'1');assert.equal(prepared.source_acquisition,'not_established');
    assert.ok(!stockCalls.slice(beforeReplay).some(sql=>sql.includes('ST_DWithin')||sql.includes('neighborhood-frozen-spatial:counts')||sql.includes('neighborhood-frozen-job-stock:parcels')),
      'fresh-client replay uses the indexed materialized stock, never another spatial sweep');
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$1',[operation])).rows[0].n,'60001');
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_custom_cohort_stock_parcels WHERE operation_id=$1',[operation])).rows[0].n,'60001');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1',[operation])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_neighborhood_acceptances WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
    await pool.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    const previousClaim=claim;
    claim=await withCustomCohortJobTransaction(pool,async client=>{const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
    await assert.rejects(owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:previousClaim}),/claim_lost/);
    assert.equal((await owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim})).reused,true);
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='archived' WHERE assignment_file_id=$1",[assignment]);
    await assert.rejects(owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim}),/private_source_read_only/);
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='draft' WHERE assignment_file_id=$1",[assignment]);
    await pool.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[snapshot]);
    await assert.rejects(owner.prepareFrozenCaptureJobStock(stockInput,{captureJobClaim:claim}),/subject_changed/);
    await pool.query('UPDATE app.appraisal_subject_snapshots SET subject_data=$1::jsonb WHERE id=$2',[JSON.stringify(subjectData),snapshot]);
    for(const sql of [
      'UPDATE app.neighborhood_custom_cohort_job_stocks SET parcel_count=parcel_count WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$1',
      'INSERT INTO app.neighborhood_custom_cohort_stock_accounts(operation_id,account_id,parcel_count) VALUES($1,\'fabricated\',1)',
      'UPDATE app.neighborhood_custom_cohort_stock_parcels SET account_id=account_id WHERE operation_id=$1',
    ])await assert.rejects(pool.query(sql,[operation]),error=>error.code==='55000','published exact stock is immutable');
    assert.ok(!stockCalls.some(sql=>/FROM (?:core\.(?:sales|sales_source_records|sale_parcels)|gis\.dcad_parcels)/.test(sql)),
      'the current owner never falls back to mutable CAD or licensed sales for this public-stock stage');
    // Traverse all 60,001 unique identities using fixed-width pages and a
    // running count/cursor only. No array of the population is held by Node.
    let after='',seen=0,done=false,maximumPageRows=0;
    for(let batch=0;!done&&batch<5;batch++)await withCustomCohortJobTransaction(pool,async client=>{
      const reader=createNeighborhoodFrozenSpatialPages(client,frozenSpatialOptions({...options,claim}));
      for(let i=0;i<64&&!done;i++) {
        const page=await reader.page({kind:'accounts',cursor:after,rowLimit:250});
        assert.equal(page.original.generation_id,frozen.generationId);assert.equal(page.population.account_count,'60001');
        assert.equal(page.population.unlocatable_global_parcels,'1');assert.equal(page.population.subject_included,true);
        assert.ok(page.rows.every(row=>row.parcel_count==='1'));
        maximumPageRows=Math.max(maximumPageRows,page.rows.length);seen+=page.rows.length;after=page.next_cursor;done=page.end_of_roster;
      }
    });
    assert.equal(done,true);assert.equal(seen,60001);assert.equal(after,'FROZEN-60001');assert.equal(maximumPageRows,250);
    const tenMile=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSpatialPages(client,
      {...frozenSpatialOptions({...options,claim}),discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'16093.44'}})
      .page({kind:'parcels',cursor:'60000',rowLimit:250}));
    assert.equal(tenMile.population.parcel_count,'60001');assert.equal(tenMile.end_of_roster,true);
    assert.deepEqual(tenMile.rows.map(row=>row.object_id),['60001']);
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSpatialPages(client,
      frozenSpatialOptions({...options,claim,scope:{...scope,report_file_id:randomUUID()}})).page({kind:'accounts',cursor:''})),/claim_lost/);
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,operation));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSpatialPages(client,
      frozenSpatialOptions({...options,claim})).page({kind:'accounts',cursor:''})),/claim_lost/);
    assert.equal(source.close_date,'2010-01-01','old sales are preserved as observations, not represented as retrospective stock');
    assert.equal((await pool.query("SELECT payload->>'is_resolved' AS resolved FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='sale_links' AND row_key='3'",[frozen.generationId])).rows[0].resolved,'false');
    await pool.query("UPDATE gis.dcad_parcels SET residential_area_sqft=9999 WHERE object_id=1");
    assert.equal((await pool.query("SELECT payload->>'residential_area_sqft' AS area FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='1'",[frozen.generationId])).rows[0].area,'1001');
    await pool.query("INSERT INTO core.accounts(account_id) VALUES('')");
    await assert.rejects(runNeighborhoodGroupIndex(pool,{batchSize:250,logger:{info(){},warn(){}},retainOriginalSources:true}),/source_population_invalid/);
    assert.equal((await pool.query('SELECT generation_id::text FROM app.neighborhood_group_active WHERE id=true')).rows[0].generation_id,frozen.generationId,
      'a refused incomplete source sweep cannot replace the active complete generation');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_generations')).rows[0].count,1,
      'failed source snapshot and generation header roll back together');
  } finally {await pool.end();}
});

test('isolated PostgreSQL: frozen source pages retain all-date one-hop packages without linked-account or second-hop expansion',{
  skip:!process.env.DATABASE_URL,timeout:180_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try {
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES
      ('CLOSURE-A','Dallas','Garland','Original Stock'),('CLOSURE-B','Dallas','Garland','Original Stock'),
      ('CLOSURE-OUTSIDE','Dallas','Garland','Outside Stock')`);
    await pool.query(`UPDATE core.accounts SET legal_description=repeat(chr(92),480000)
      WHERE account_id='CLOSURE-A'`);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,source_record_hash,geom) VALUES
      (1,'CLOSURE-A','Original Stock','a',ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326))),
      (2,'CLOSURE-B','Original Stock','b',ST_Multi(ST_MakeEnvelope(-96.699,32.9,-96.698,32.901,4326))),
      (3,'CLOSURE-OUTSIDE','Outside Stock','c',ST_Multi(ST_MakeEnvelope(-97.7,32.9,-97.699,32.901,4326))),
      (4,'CLOSURE-A','Original Stock','d',ST_Multi(ST_MakeEnvelope(-97.71,32.9,-97.709,32.901,4326))),
      (5,NULL,NULL,'e',ST_Multi(ST_MakeEnvelope(-96.7,32.901,-96.699,32.902,4326)))`);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,current_price,close_date,raw_payload) VALUES
      (501,'CLOSURE-A',9007199254740993,'2010-01-01','{"ClosePrice":9007199254740993}'::jsonb),
      (502,'CLOSURE-OUTSIDE',777777,'2026-01-01',NULL),
      (503,NULL,NULL,NULL,NULL),(504,'CLOSURE-OUTSIDE',500000,'2025-01-01',NULL)`);
    await pool.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price) VALUES
      (1,501,'CLOSURE-OUTSIDE','2010-01-01',9007199254740993),
      (2,502,'CLOSURE-OUTSIDE','2026-01-01',777777),
      (3,NULL,'CLOSURE-B','2012-01-01',200000),(4,504,'CLOSURE-B','2025-01-01',500000)`);
    await pool.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved) VALUES
      (1,501,1,1,'CLOSURE-A',true),(2,501,1,2,'CLOSURE-OUTSIDE',true),
      (3,503,1,1,'CLOSURE-B',true),(4,503,1,2,NULL,false),(5,502,1,1,'CLOSURE-OUTSIDE',true)`);
    const run=randomUUID(),otherRun=randomUUID();
    await pool.query(`INSERT INTO gis.source_sync_runs(id,source_key,status,records_seen) VALUES
      ($1,'dcad_parcels','complete',5),($2,'other_source','complete',99)`,[run,otherRun]);
    await pool.query(`INSERT INTO gis.source_sync_state(source_key,status,last_run_id) VALUES
      ('dcad_parcels','complete',$1),('other_source','complete',$2)`,[run,otherRun]);
    const frozen=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}},retainOriginalSources:true});
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Closure synthetic','Closure synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Closure actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'CLOSURE-A',$2,$3,$3) RETURNING id::text`,[organization,`CLOSURE-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'CLOSURE-A','custom_appraisal',$3,$4)`,[report,organization,`CLOSURE-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'CLOSURE-A'},options={scope,actorUserId:actor};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
    const claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};
    });
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,options));
    const expected={parcels:['1','2','4'],accounts:['CLOSURE-A','CLOSURE-B'],source_records:['501','503','504'],
      sales:['1','3','4'],sale_links:['1','2','3','4'],sync_state:['dcad_parcels'],sync_runs:[run]};
    // This storage-only fixture supplies a synthetic intent reference. The
    // separate 60,001-property test above uses the actual current subject owner.
    // Exact stock includes null-account parcel5 but NOT outside account-part4;
    // source closure intentionally retains part4, never promoting it to stock.
    const exactStock=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,
      {...frozenSpatialOptions({...options,claim}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}}).prepare());
    assert.equal(exactStock.population.parcel_count,'3');assert.equal(exactStock.population.unassociated_parcel_count,'1');
    assert.deepEqual((await pool.query(`SELECT stock.object_id::text,stock.account_id,
      original.payload->>'stored_geometry_ewkb' AS geometry_ewkb FROM app.neighborhood_custom_cohort_stock_parcels stock
      JOIN app.neighborhood_frozen_source_rows original ON original.generation_id=stock.generation_id
        AND original.kind=stock.kind AND original.row_key=stock.row_key
      WHERE stock.operation_id=$1 ORDER BY stock.object_id`,[operation])).rows.map(row=>[row.object_id,row.account_id,typeof row.geometry_ewkb]),
    [['1','CLOSURE-A','string'],['2','CLOSURE-B','string'],['5',null,'string']],
    'every geographic stock original, including the unassociated geometry, remains retained behind the exact generation FK');
    let retainedPageManifest,retainedPageText,chainBinding,chainRoot;
    for(const [kind,keys] of Object.entries(expected))await withCustomCohortJobTransaction(pool,async client=>{
      const reader=createNeighborhoodFrozenSourceClosurePages(client,frozenSpatialOptions({...options,claim}));
      let after='',done=false;const rows=[];
      for(let i=0;i<12&&!done;i++){
        const page=await reader.page({kind,cursor:after,rowLimit:1});
        assert.equal(page.original.generation_id,frozen.generationId);assert.equal(page.stock_population.account_count,'2');
        assert.equal(page.stock_population.parcel_count,'3');assert.equal(page.stock_population.unassociated_parcel_count,'1');
        assert.equal(page.additional_cadastral_accounts,false);assert.equal(page.authority,'not_established');
        if(!chainBinding){
          chainBinding={...scope,operation_id:operation,generation_id:frozen.generationId,
            spatial_definition_sha256:page.spatial_definition_sha256,
            source_original_sha256:createHash('sha256').update(canonicalAssessmentJson(page.original)).digest('hex')};
          chainRoot=(await createCohortOriginalSourceChainV1Store(
            createNeighborhoodCohortBlobRepository(client,organization),chainBinding).create()).root;
        }
        const originalText=JSON.stringify({binding:chainBinding,page});
        const appended=await createCohortOriginalSourceChainV1Store(
          createNeighborhoodCohortBlobRepository(client,organization),chainBinding).append({root:chainRoot,original_text:originalText});
        assert.equal(appended.authority,'not_established');assert.equal(appended.coverage,'stored_pages_only');
        chainRoot=appended.root;
        assert.ok(Number(chainRoot.canonical_utf8_bytes)<16_000,'all source pages need only one small root checkpoint reference');
        await createCustomCohortCaptureJobRepository(client).saveCheckpoint(claim,options,{phase:'source',evidence_refs:[chainRoot]});
        assert.equal((await createCustomCohortCaptureJobRepository(client).readPreparedGeneration(claim,options))
          .generation_id,frozen.generationId,'the actual live claim/pin remains an independent owner fence');
        if(kind==='accounts'&&after==='')assert.ok(page.page_utf8_bytes>1_500_000,
          'scoped closure admits the heavily escaped original before continuing to the next stock account');
        if(kind==='accounts'&&after===''){
          // The opaque page exceeds the legacy whole-JSON envelope. Only its
          // individually bounded chunk wrappers enter that unchanged profile.
          retainedPageText=JSON.stringify({scope,operation_id:operation,page});
          assert.ok(Buffer.byteLength(retainedPageText)>1_500_000);
          const stored=await createCohortOriginalTextChunksV1Store(createNeighborhoodCohortBlobRepository(client,organization))
            .put(retainedPageText);
          assert.equal(stored.authority,'not_established');assert.ok(stored.chunk_count>1);
          retainedPageManifest=stored.manifest;
          assert.equal((await createCustomCohortCaptureJobRepository(client).readPreparedGeneration(claim,options))
            .generation_id,frozen.generationId,'storage does not substitute for the ending live pin fence');
        }
        rows.push(...page.rows);after=page.next_cursor;done=page.end_of_layer;
      }
      assert.equal(done,true);assert.deepEqual(rows.map(row=>row.row_key),keys,`${kind} is exact original-stock-seeded one-hop scope`);
      if(kind==='accounts')assert.equal(JSON.parse(rows[0].payload_text).legal_description,'\\'.repeat(480000));
      if(kind==='source_records'){
        const payload=JSON.parse(rows[0].payload_text);assert.equal(payload.current_price,'9007199254740993');
        assert.equal(payload.close_date,'2010-01-01');assert.equal(payload.source_raw_witness.fields.ClosePrice.value_text,'9007199254740993');
      }
      if(kind==='sales')assert.equal(JSON.parse(rows[1].payload_text).closing_date,'2012-01-01','legacy observations outside analytic period remain original');
      if(kind==='sale_links'){
        assert.equal(JSON.parse(rows[1].payload_text).account_id,'CLOSURE-OUTSIDE','package association is retained, not stock membership');
        assert.equal(JSON.parse(rows[3].payload_text).is_resolved,false,'unresolved seeded associations are never filtered away');
      }
    });
    for(const [kind,keys] of Object.entries(expected)){
      let position=null;const reopenedKeys=[];let pageCount=0,rawBytes=0;
      do{
        const step=await withCustomCohortJobTransaction(pool,async client=>{
          const jobs=createCustomCohortCaptureJobRepository(client);
          assert.deepEqual((await jobs.readCheckpoint(claim,options)).evidence_refs,[chainRoot]);
          assert.equal((await jobs.readPreparedGeneration(claim,options)).generation_id,frozen.generationId);
          const stored=await createCohortOriginalSourceChainV1Store(
            createNeighborhoodCohortBlobRepository(client,organization),chainBinding).read({root:chainRoot,kind,position});
          assert.equal((await jobs.readPreparedGeneration(claim,options)).generation_id,frozen.generationId);
          return stored;
        });
        const body=JSON.parse(step.original_text);
        assert.deepEqual(body.binding,chainBinding);assert.equal(body.page.kind,kind);
        assert.equal(step.authority,'not_established');assert.equal(step.coverage,'stored_pages_only');
        reopenedKeys.unshift(...body.page.rows.map(row=>row.row_key));pageCount++;rawBytes+=Buffer.byteLength(step.original_text);
        if(kind==='accounts'&&body.page.after==='')assert.ok(Buffer.byteLength(step.original_text)>1_500_000);
        if(kind==='source_records'&&body.page.after==='')assert.match(body.page.rows[0].payload_text,/9007199254740993/);
        position=step.next_position;
        if(position===null){assert.equal(step.layer.row_count,keys.length);assert.equal(step.layer.page_count,pageCount);
          assert.equal(step.layer.original_utf8_bytes,rawBytes);assert.equal(step.layer.ended,true);}
      }while(position!==null);
      assert.deepEqual(reopenedKeys,keys,`${kind} independently reopens every ordered original through fresh SQL clients`);
    }
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCohortOriginalSourceChainV1Store(
      createNeighborhoodCohortBlobRepository(client,randomUUID()),chainBinding).read({root:chainRoot,kind:'parcels',position:null})),/missing_original/,
    'the graph cannot expose retained source pages to another organization');
    await withCustomCohortJobTransaction(pool,async client=>{
      assert.equal((await createCustomCohortCaptureJobRepository(client).readPreparedGeneration(claim,options))
        .generation_id,frozen.generationId);
      const reopened=await createCohortOriginalTextChunksV1Store(createNeighborhoodCohortBlobRepository(client,organization))
        .get(retainedPageManifest);
      assert.equal(reopened.text,retainedPageText,'a fresh SQL client reopens every original chunk, byte for byte');
      assert.equal(reopened.coverage,'one_original_text');assert.equal(reopened.authority,'not_established');
      assert.equal((await client.query(`SELECT max(canonical_utf8_bytes)::integer AS maximum
        FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`,[organization])).rows[0].maximum<1_500_000,true,
        'no legacy blob limit is increased for the >1.5-MB original page');
      assert.equal((await createCustomCohortCaptureJobRepository(client).readPreparedGeneration(claim,options))
        .generation_id,frozen.generationId);
    });
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCohortOriginalTextChunksV1Store(
      createNeighborhoodCohortBlobRepository(client,randomUUID())).get(retainedPageManifest)),/missing_original/,
    'content addressing never makes retained originals cross organization boundaries');
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,operation));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourceClosurePages(client,
      frozenSpatialOptions({...options,claim})).page({kind:'source_records',cursor:''})),/claim_lost/);
  }finally{await pool.end();}
});
