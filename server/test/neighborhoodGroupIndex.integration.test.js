import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from './fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { runNeighborhoodGroupIndex,getPreparedNeighborhoodGroupSummary }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';
import { createCustomCohortCaptureJobRepository }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { withCustomCohortJobTransaction }
  from '../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

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
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES
      ('INDEX-A','Dallas','Garland','Monica Park 4'),
      ('INDEX-B','Dallas','Garland',' MONICA  PARK 4 '),
      ('INDEX-C','Dallas','Garland','Another Park'),
      ('INDEX-D','Dallas','Garland',NULL)`);
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
    const first=await runNeighborhoodGroupIndex(pool,{batchSize:1,logger:{info(){}}});
    assert.equal(first.status,'complete');
    assert.equal(first.parcels,5);
    assert.equal(first.sales,4);
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
    const second=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    assert.equal(second.status,'complete');
    assert.equal((await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'})).median_living_area_sqft,2500);
    assert.notEqual(first.generationId,second.generationId);
    const third=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    const fourth=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    assert.equal(third.status,'complete');assert.equal(fourth.status,'complete');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_generations WHERE generation_id=$1',[second.generationId])).rows[0].count,0,
      'an old unpinned generation is still pruned');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1',[first.generationId])).rows[0].count,5,
      'later sweeps preserve every pinned parcel');
    assert.equal((await pool.query('SELECT living_area_sqft::text AS area FROM app.neighborhood_group_parcel_facts WHERE generation_id=$1 AND object_id=2',[first.generationId])).rows[0].area,'2000');
    assert.deepEqual(await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .pinPreparedGeneration(claim,options)),pinned,'replay does not switch to the latest sweep');
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
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,operation));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(nextClaim,options)),/claim_lost/);
  } finally { await pool.end(); }
});
