import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
import { createNeighborhoodFrozenJobSourcePages, createNeighborhoodPreparedJobSourcePages }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';
import { createNeighborhoodFrozenJobSourceSeeds }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceSeeds.js';
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
import { createNeighborhoodFrozenJobStockOriginals }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockOriginals.js';
import { createNeighborhoodFrozenJobSourceIdentity }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceIdentity.js';
import { createNeighborhoodFrozenJobTypedOriginals }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobTypedOriginals.js';
import { createNeighborhoodFrozenJobStockMetricPages }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockMetricPages.js';
import { createNeighborhoodSharedJobStockMetricPages }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockMetricPages.js';
import { createNeighborhoodSharedTypedGeneration }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';
import { createCustomNeighborhoodWitness2SourcePolicy, CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_PURPOSE } from '../src/security/customNeighborhoodWitness2SourcePolicy.js';
import { CUSTOM_NEIGHBORHOOD_SOURCE_DATASET } from '../src/security/customNeighborhoodSourcePolicy.js';

// Disposable native fixture only, never production rights provisioning. The
// real evaluator reads current organization metadata/time on every admission.
const fixtureProviders=[{provider_id:'synthetic-originals-only',revision:'fixture-1'}];
const fixtureGrant=organization=>({policy_version:1,organization_id:organization,grant_id:'synthetic-frozen-source',
  dataset:{id:CUSTOM_NEIGHBORHOOD_SOURCE_DATASET,revision:'synthetic-original-1',
    coverage:'entire_integrated_source_mix_including_prior_merged_values',provider_revisions:fixtureProviders},
  purpose_version:1,purpose_scope:CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_PURPOSE,
  rights_basis:{owner_id:'synthetic-fixture',basis_reference:'disposable-native-fixture-not-a-production-grant',
    approved_by:'native-fixture',approved_at:'2026-01-01T00:00:00.000000Z'},
  valid_from:'2026-01-01T00:00:00.000000Z',expires_at:'2027-01-01T00:00:00.000000Z',revoked_at:null,
  retention:'immutable_originals_without_automated_deletion',exposures:{none:true,report_observation_summary:false,
    report_observation_members:false,report_observation_catalog:false}});
const fixturePolicy=()=>createCustomNeighborhoodWitness2SourcePolicy({datasetRevision:'synthetic-original-1',providerRevisions:fixtureProviders});
const setFixtureGrant=(pool,organization,grant)=>pool.query('UPDATE app_auth.organizations SET metadata=jsonb_build_object($1::text,$2::jsonb) WHERE id=$3',
  [CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY,JSON.stringify(grant),organization]);

const frozenSpatialOptions = options => ({...options,
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',
    coordinate_encoding:'decimal_string_v1',coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},
  discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}});

// The cache builder requires an explicit stable caller transaction even though
// published originals are immutable. This fixture does not provide a source
// grant or mount it in a current-user/report worker.
const sharedTypedStep=(pool,generationId,progress=null,effectiveDate='2026-10-07',signal)=>
  withCustomCohortJobTransaction(pool,async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    return createNeighborhoodSharedTypedGeneration(client,{generationId,effectiveDate,signal}).step(progress);
  });
async function sharedTypedComplete(pool,generationId,effectiveDate='2026-10-07') {
  let p=null,r,steps=0;
  do {r=await sharedTypedStep(pool,generationId,p,effectiveDate);p=r.progress;assert.ok(++steps<60000);} while(!r.all_layers_typed);
  return {receipt:r,steps};
}

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
    assert.equal((await pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='app'
      AND tablename='neighborhood_custom_cohort_stock_parcels' AND indexname='neighborhood_cohort_stock_parcels_original_idx'`))
      .rows[0].indexdef,'CREATE INDEX neighborhood_cohort_stock_parcels_original_idx ON app.neighborhood_custom_cohort_stock_parcels USING btree (generation_id, kind, row_key)',
      'original-row FK checks have an exact generation-leading index for bounded obsolete-generation retirement');
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
    await assert.rejects(createNeighborhoodSharedTypedGeneration(pool,{generationId:first.generationId,effectiveDate:'2026-10-07'}).step(),
      /caller_transaction_required/,'autocommit must leave no shared cache header or rows');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_generations')).rows[0].n,0);
    // Even matching session defaults do not turn autocommit into a caller-owned
    // transaction. The two pre-write probes must catch its changing txid.
    const autocommitShared=await pool.connect();
    try {
      await autocommitShared.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await autocommitShared.query("SET TIME ZONE 'UTC'");
      await assert.rejects(createNeighborhoodSharedTypedGeneration(autocommitShared,{generationId:first.generationId,effectiveDate:'2026-10-07'}).step(),
        /caller_transaction_changed/);
    } finally {
      await autocommitShared.query('RESET default_transaction_isolation');
      await autocommitShared.query('RESET TIME ZONE');
      autocommitShared.release();
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_generations')).rows[0].n,0);
    let loseSharedCommit=true;
    const lostAckPool={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      const result=await raw.query(c);if(c.text==='COMMIT'&&loseSharedCommit){loseSharedCommit=false;throw Error('synthetic shared cache ACK loss');}
      return result;}};}};
    await assert.rejects(sharedTypedStep(lostAckPool,first.generationId),error=>error.outcome_unknown===true);
    const reopenedShared=await sharedTypedStep(pool,first.generationId);
    assert.equal(reopenedShared.advanced,false);assert.equal(reopenedShared.reused,true);
    assert.equal(reopenedShared.progress.typed_rows,'5');
    const ackTotals=(await pool.query('SELECT row_count::text AS n FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1 AND kind=\'parcels\'',[first.generationId])).rows[0];
    assert.equal(ackTotals.n,'5','lost acknowledgement/reopen cannot double transition totals');
    for(const sql of ['UPDATE app.neighborhood_frozen_typed_totals SET row_count=row_count+1 WHERE generation_id=$1',
      'INSERT INTO app.neighborhood_frozen_typed_totals SELECT * FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1',
      'DELETE FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1'])
      await assert.rejects(pool.query(sql,[first.generationId]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_typed_totals'),error=>error.code==='55000');
    // The database independently refuses a premature cache publication too.
    await assert.rejects(pool.query("UPDATE app.neighborhood_frozen_typed_generations SET status='complete',completed_at=now() WHERE generation_id=$1",[first.generationId]),
      error=>error.code==='55000'&&/population_incomplete/.test(error.message));
    let sharedProgress=reopenedShared.progress,sharedResult;
    while(sharedProgress.kind_index<6){sharedResult=await sharedTypedStep(pool,first.generationId,sharedProgress);sharedProgress=sharedResult.progress;}
    // The authoritative trigger, rather than a duplicate JS city recount,
    // independently catches a corrupt running-byte total on actual completion.
    const badSharedProgress={...sharedProgress,typed_utf8_bytes:String(BigInt(sharedProgress.typed_utf8_bytes)+1n)};
    const sharedCountBefore=(await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId])).rows[0].n;
    const sharedTotalsBefore=(await pool.query('SELECT * FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1 ORDER BY kind',[first.generationId])).rows;
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      await client.query('UPDATE app.neighborhood_frozen_typed_generations SET progress=$2::jsonb WHERE generation_id=$1',
        [first.generationId,JSON.stringify(badSharedProgress)]);
      return createNeighborhoodSharedTypedGeneration(client,{generationId:first.generationId,effectiveDate:'2026-10-07'}).step(badSharedProgress);
    }),/neighborhood_shared_typed_population_incomplete/);
    assert.deepEqual((await pool.query('SELECT progress FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1',[first.generationId])).rows[0].progress,sharedProgress);
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId])).rows[0].n,sharedCountBefore);
    assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1 ORDER BY kind',[first.generationId])).rows,sharedTotalsBefore);
    do{sharedResult=await sharedTypedStep(pool,first.generationId,sharedProgress);sharedProgress=sharedResult.progress;}while(!sharedResult.all_layers_typed);
    const retainedSharedCount=(await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId])).rows[0].n;
    assert.equal(retainedSharedCount,frozen.row_count);
    const originalCached=(await pool.query("SELECT typed->'observations'->'reported_residential_area'->>'exact_value' AS area FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='2'",[first.generationId])).rows[0].area;
    assert.equal(originalCached,'2000');
    const cancelledShared=new AbortController();cancelledShared.abort();
    await assert.rejects(sharedTypedStep(pool,first.generationId,null,'2025-10-07',cancelledShared.signal),/cancelled/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1',[first.generationId])).rows[0].n,1);
    await assert.rejects(sharedTypedStep(pool,first.generationId,sharedProgress,'2025-10-07'),/checkpoint_mismatch/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1',[first.generationId])).rows[0].n,1,
      'a mismatched date/progress cannot leave a partially committed extra profile');
    for(const sql of ['UPDATE app.neighborhood_frozen_typed_rows SET typed=typed WHERE generation_id=$1',
      'DELETE FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',
      'UPDATE app.neighborhood_frozen_typed_generations SET progress=progress WHERE generation_id=$1'])
      await assert.rejects(pool.query(sql,[first.generationId]),error=>error.code==='55000');
    await assert.rejects(pool.query("UPDATE app.neighborhood_frozen_source_rows SET payload='{}' WHERE generation_id=$1",[first.generationId]),error=>error.code==='55000');
    // The stock's new original-row FK refuses plain TRUNCATE before PostgreSQL
    // even runs our immutable trigger. CASCADE must still hit that guard.
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_source_rows'),
      error=>error.code==='0A000' && /foreign key constraint/.test(error.message));
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_source_rows CASCADE'),error=>error.code==='55000');
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
    const secondCache=await sharedTypedStep(pool,second.generationId);
    assert.equal(secondCache.all_layers_typed,false,'bounded partial shared generation is not complete');
    assert.equal((await getPreparedNeighborhoodGroupSummary(pool,{county:'Dallas',city:'Garland',subdivision:'Monica Park 4'})).median_living_area_sqft,2500);
    assert.notEqual(first.generationId,second.generationId);
    const third=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    const fourth=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}}});
    assert.equal(third.status,'complete');assert.equal(fourth.status,'complete');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_group_generations WHERE generation_id=$1',[second.generationId])).rows[0].count,0,
      'an old unpinned generation is still pruned');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1',[second.generationId])).rows[0].count,0,
      'obsolete unpinned original pages retire with their generation');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[second.generationId])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_totals WHERE generation_id=$1',[second.generationId])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1',[second.generationId])).rows[0].n,0,
      'partial shared cache rows/header retire before originals without disabling restrictive FKs');
    const reusedShared=await sharedTypedStep(pool,first.generationId);
    assert.equal(reusedShared.all_layers_typed,true);assert.equal(reusedShared.reused,true);
    assert.deepEqual(reusedShared.progress,sharedProgress,'later sweeps cannot replace the exact retained interpretation');
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId])).rows[0].n,retainedSharedCount);
    await assert.rejects(pool.query('DELETE FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId]),error=>error.code==='55000');
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

test('isolated PostgreSQL: refuses original geographic identity and EWKB discrepancies, without changing published rows',{
  skip:!process.env.DATABASE_URL,timeout:180_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try{
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query("INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES('ORIGINAL-A','Dallas','Garland','Synthetic Originals')");
    // Legitimate native object zero must not disappear behind a default cursor.
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,source_record_hash,geom)
      VALUES(0,'ORIGINAL-A','Synthetic Originals','a',ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326)))`);
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic originals','Synthetic originals')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic originals actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'ORIGINAL-A',$2,$3,$3) RETURNING id::text`,[organization,`ORIGINALS-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'ORIGINAL-A','custom_appraisal',$3,$4)`,[report,organization,`ORIGINALS-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'ORIGINAL-A'};
    const subjectIntent={content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'};
    for(const corruption of [null,'wrong_id','numeric_id','wrong_account','missing_ewkb','different_ewkb','invalid_ewkb']){
      // Inject only while this disposable original generation is BUILDING.
      // No trigger disabling, published-row update, production DB or fallback.
      const writerPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(sql,values){
        const result=await client.query(sql,values),text=typeof sql==='string'?sql:sql.text,parameters=typeof sql==='string'?values:sql.values;
        if(corruption&&text.includes('neighborhood-frozen-source:parcels')&&result.rows[0]?.copied===1){
          const change={wrong_id:"jsonb_set(payload,'{object_id}','\"1\"')",numeric_id:"jsonb_set(payload,'{object_id}','0')",
            wrong_account:"jsonb_set(payload,'{account_id}','\"ORIGINAL-B\"')",missing_ewkb:"payload-'stored_geometry_ewkb'",
            different_ewkb:"jsonb_set(payload,'{stored_geometry_ewkb}',to_jsonb(encode(ST_AsEWKB(ST_Multi(ST_MakeEnvelope(-97.7,32.9,-97.699,32.901,4326))),'hex')))",
            invalid_ewkb:"jsonb_set(payload,'{stored_geometry_ewkb}','\"00000000000000000000\"')"}[corruption];
          await client.query(`UPDATE app.neighborhood_frozen_source_rows SET payload=${change} WHERE generation_id=$1 AND kind='parcels' AND row_key='0'`,[parameters[0]]);
        }
        return result;}};}};
      await runNeighborhoodGroupIndex(writerPool,{batchSize:250,logger:{info(){}},retainOriginalSources:true});
      const operation=randomUUID();
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
        request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
      const claim=await withCustomCohortJobTransaction(pool,async client=>{const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
        assert.equal(job.operation_id,operation);return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
      const options={...frozenSpatialOptions({claim,scope,actorUserId:actor}),subjectIntent,checkBudget(){}};
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,{scope,actorUserId:actor}));
      await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,options).prepare());
      const verify=()=>withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStockOriginals(client,options).step(null));
      if(corruption===null){const verified=await verify();assert.equal(verified.all_parcels_verified,true);assert.equal(verified.progress.after_object_id,'0');assert.equal(verified.progress.verified_parcels,1);}
      else await assert.rejects(verify(),error=>corruption==='invalid_ewkb'?typeof error.code==='string':/original_mismatch/.test(error.message),
        `${corruption} cannot verify a matching stock FK or original page hash`);
      assert.equal((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0].checkpoint,null);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
    }
  }finally{await pool.end();}
});

test('isolated PostgreSQL: independent source identity SQL rejects malformed metadata, orphan sources, duplicate links and missing runs',{
  skip:!process.env.DATABASE_URL,timeout:180_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try{
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    const identityIndex=(await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname='app' AND indexname='neighborhood_frozen_link_identity_idx'")).rows;
    assert.equal(identityIndex.length,1);assert.match(identityIndex[0].indexdef,/source_record_id/);
    assert.match(identityIndex[0].indexdef,/source_position/);assert.match(identityIndex[0].indexdef,/parcel_sequence/);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query("INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES('IDENTITY-A','Dallas','Garland','Synthetic Identity')");
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,source_record_hash,geom) VALUES
      (0,'IDENTITY-A','Synthetic Identity','a',ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326))),
      (1,'IDENTITY-NO-CORE','Synthetic Identity','b',ST_Multi(ST_MakeEnvelope(-96.699,32.9,-96.698,32.901,4326)))`);
    await pool.query("INSERT INTO core.sales_source_records(id,primary_account_id,current_price) VALUES(501,'IDENTITY-A',9007199254740993)");
    await pool.query("INSERT INTO core.sales(id,source_record_id,account_id,sale_price) VALUES(1,501,'IDENTITY-A',9007199254740993)");
    await pool.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved)
      VALUES(1,501,1,1,'IDENTITY-A',true),(2,501,1,2,NULL,false)`);
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic identity','Synthetic identity')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic identity actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'IDENTITY-A',$2,$3,$3) RETURNING id::text`,[organization,`IDENTITY-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'IDENTITY-A','custom_appraisal',$3,$4)`,[report,organization,`IDENTITY-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'IDENTITY-A'};
    const cases=[{kind:null,change:null},{kind:'accounts',change:"payload-'account_id'"},
      {kind:'source_records',change:"jsonb_set(payload,'{id}','501')"},
      {kind:'source_records',change:"jsonb_set(payload,'{primary_account_id}','\"IDENTITY-B\"')"},
      {kind:'sales',change:"jsonb_set(payload,'{source_record_id}','\"999\"')",metadata:'source_record_id=999,'},
      {kind:'sale_links',change:"jsonb_set(payload,'{parcel_sequence}','1')",key:'2'},
      {kind:'sale_links',change:"jsonb_set(payload,'{source_position}','0')"},
      {kind:'sale_links',change:"jsonb_set(payload,'{is_resolved}','\"true\"')"},
      {kind:'parcels',change:"jsonb_set(payload,'{sync_run_id}','\"70000000-0000-4000-8000-000000000001\"')"}];
    for(const corruption of cases){
      // Corrupt only BUILDING disposable originals, preserving complete-row
      // immutability, normal writer publication, original counts and all guards.
      const writerPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(sql,values){
        const result=await client.query(sql,values),text=typeof sql==='string'?sql:sql.text,parameters=typeof sql==='string'?values:sql.values;
        if(corruption.kind&&text.includes(`neighborhood-frozen-source:${corruption.kind} */`)&&result.rows[0]?.copied>0){
          const key=corruption.key??({accounts:'IDENTITY-A',source_records:'501',sales:'1',sale_links:'1',parcels:'0'}[corruption.kind]);
          await client.query(`UPDATE app.neighborhood_frozen_source_rows SET ${corruption.metadata??''}payload=${corruption.change}
            WHERE generation_id=$1 AND kind=$2 AND row_key=$3`,[parameters[0],corruption.kind,key]);}
        return result;}};}};
      const frozen=await runNeighborhoodGroupIndex(writerPool,{batchSize:250,logger:{info(){}},retainOriginalSources:true});
      const operation=randomUUID();
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
        request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
      const claim=await withCustomCohortJobTransaction(pool,async client=>{const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
        assert.equal(job.operation_id,operation);return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
      const options={...frozenSpatialOptions({claim,scope,actorUserId:actor}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,{scope,actorUserId:actor}));
      await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,options).prepare());
      if(corruption.kind===null){
        for(const kind of Object.keys(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL)){
          const checked=(await pool.query(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL[kind],[frozen.generationId,operation,''])).rows[0];
          assert.equal(checked.invalid_count,0,`${kind} legitimate string IDs and nullable outside links validate`);}
        assert.equal((await pool.query(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL,[frozen.generationId,operation])).rows[0].missing_account_count,1,
          'missing core-account metadata is explicit, not silently removed from geographic stock');
      }else{
        const checked=(await pool.query(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL[corruption.kind],[frozen.generationId,operation,''])).rows[0];
        assert.ok(checked.invalid_count>0,`${corruption.kind}: ${corruption.change} must refuse independent identity verification`);
      }
      assert.equal((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0].checkpoint,null);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
  }finally{await pool.end();}
});

test('isolated PostgreSQL: prepares and reuses one indexed shared interpretation for 60001 accounts',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase(),{default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try{
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision)
      SELECT 'SHARED-'||lpad(n::text,5,'0'),'Dallas','Garland','Synthetic Shared Park' FROM generate_series(1,60001) n`);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,residential_area_sqft,
      residential_year_built,parcel_area_sqft,current_market_value)
      SELECT n,'SHARED-'||lpad(n::text,5,'0'),'Synthetic Shared Park',1000+n%100,1960+n%40,6000,200000
      FROM generate_series(1,60001) n`);
    await pool.query("INSERT INTO gis.dcad_parcels(object_id,account_id) VALUES(60002,NULL)");
    await pool.query(`UPDATE gis.dcad_parcels SET geom=ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326))
      WHERE account_id IS NOT NULL`);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,current_price,close_date,raw_payload)
      VALUES(501,'SHARED-00001',9007199254740993,'2010-01-01','{"ClosePrice":9007199254740993}'::jsonb)`);
    await pool.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price)
      VALUES(10,501,'SHARED-00001','2010-01-01',9007199254740993),(11,NULL,'SHARED-00002','2000-01-01',123456.78)`);
    await pool.query("INSERT INTO core.sale_parcels(id,source_record_id,account_id,is_resolved) VALUES(1,501,'SHARED-00001',true)");
    const frozen=await runNeighborhoodGroupIndex(pool,{batchSize:250,logger:{info(){}},retainOriginalSources:true});
    const source=(await pool.query('SELECT * FROM app.neighborhood_frozen_source_generations WHERE generation_id=$1',[frozen.generationId])).rows[0];
    let pageCount=0,maximumOriginals=0,originalQueries=0,writeQueries=0,completionMs=null;const calls=[];
    const measured={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){calls.push(c.text);
      const queryStarted=performance.now(),result=await raw.query(c);
      if(c.text.includes('shared-typed:progress')&&c.values?.[4]==='complete')completionMs=Math.round(performance.now()-queryStarted);
      if(c.text.includes('shared-typed:page')){pageCount++;originalQueries++;assert.equal(result.rows.length,1);
        maximumOriginals=Math.max(maximumOriginals,result.rows[0].page_count);assert.ok(Buffer.byteLength(result.rows[0].page_json)<=2_100_000);}
      if(c.text.includes('shared-typed:rows'))writeQueries++;
      return result;}};}};
    const started=performance.now(),prepared=await sharedTypedComplete(measured,frozen.generationId);
    assert.equal(prepared.receipt.progress.typed_rows,source.row_count);
    assert.equal(prepared.receipt.all_layers_typed,true);assert.equal(maximumOriginals,250);
    assert.ok(pageCount>480);assert.equal(pageCount,prepared.steps);
    // Independently reconcile all original keys, payload bytes and native source
    // identities in SQL. No city-sized list or original payload goes to Node.
    const verification=(await pool.query(`SELECT count(*)::text AS rows,
      count(*) FILTER(WHERE typed.original_payload_sha256<>encode(sha256(convert_to(original.payload::text,'UTF8')),'hex')
        OR typed.account_id IS DISTINCT FROM original.account_id
        OR typed.source_record_id IS DISTINCT FROM original.source_record_id
        OR typed.typed_utf8_bytes<>octet_length(typed.typed::text))::text AS invalid
      FROM app.neighborhood_frozen_typed_rows typed JOIN app.neighborhood_frozen_source_rows original
        USING(generation_id,kind,row_key) WHERE typed.generation_id=$1`,[frozen.generationId])).rows[0];
    assert.equal(verification.rows,source.row_count);assert.equal(verification.invalid,'0');
    for(const [kind,c] of Object.entries(source.layer_counts))
      assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1 AND kind=$2',[frozen.generationId,kind])).rows[0].n,c.row_count);
    const verifiedTotals=(await pool.query(`SELECT actual.kind,actual.n::text AS n,actual.bytes::text AS bytes,
      totals.row_count::text AS recorded_rows,totals.typed_utf8_bytes::text AS recorded_bytes
      FROM (SELECT kind,count(*) AS n,sum(typed_utf8_bytes) AS bytes FROM app.neighborhood_frozen_typed_rows
        WHERE generation_id=$1 GROUP BY kind) actual
      FULL JOIN app.neighborhood_frozen_typed_totals totals ON totals.generation_id=$1 AND totals.kind=actual.kind
      WHERE totals.generation_id=$1 OR actual.kind IS NOT NULL`,[frozen.generationId])).rows;
    assert.ok(verifiedTotals.length<=7);
    for(const totals of verifiedTotals){assert.equal(totals.recorded_rows,totals.n);assert.equal(totals.recorded_bytes,totals.bytes);}
    assert.ok(Number.isSafeInteger(completionMs)&&completionMs>=0,'actual bounded completion query was measured');
    assert.equal((await pool.query(`SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows
      WHERE generation_id=$1 AND kind='parcels' AND row_key<>'60002'
        AND typed->'observations'->'reported_residential_area'->>'exact_value'=(1000+row_key::bigint%100)::text
        AND typed->'observations'->'reported_year_built'->>'exact_value'=(1960+row_key::bigint%40)::text`,[frozen.generationId])).rows[0].n,'60001');
    assert.equal((await pool.query(`SELECT typed->'observations'->'normalized_current_price'->>'exact_value' AS price
      FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1 AND kind='source_records' AND row_key='501'`,[frozen.generationId])).rows[0].price,'9007199254740993');
    const typedBytes=(await pool.query("SELECT pg_total_relation_size('app.neighborhood_frozen_typed_rows')::text AS n")).rows[0].n;
    const beforeOriginals=originalQueries,beforeWrites=writeQueries,beforeCalls=calls.length,reusedAt=performance.now();
    const reused=await sharedTypedStep(measured,frozen.generationId),reuseMs=Math.round(performance.now()-reusedAt);
    assert.equal(reused.reused,true);assert.equal(reused.advanced,false);assert.deepEqual(reused.progress,prepared.receipt.progress);
    assert.equal(originalQueries,beforeOriginals);assert.equal(writeQueries,beforeWrites);
    assert.ok(!calls.slice(beforeCalls).some(sql=>/shared-typed:(?:page|rows|begin|progress|counts)/.test(sql)),
      'fresh-client exact cache reuse reads metadata only, without retyping, recopying or recounting the city');
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[frozen.generationId])).rows[0].n,source.row_count);
    const held=await pool.connect();
    try{
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM app.neighborhood_frozen_typed_generations WHERE generation_id=$1 FOR UPDATE',[frozen.generationId]);
      assert.equal((await sharedTypedStep(measured,frozen.generationId)).all_layers_typed,true,
        'a completed immutable cache can be reused while another client holds its header write lock');
    }finally{await held.query('ROLLBACK');held.release();}
    // Large DATA-level page acceptance, with synthetic graph/count binding.
    // The separate small owner fixture verifies current authorization. This
    // cannot be described as a whole authorized 60k acquisition/report result.
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Shared metric synthetic','Shared metric synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Shared metric actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'SHARED-00001',$2,$3,$3) RETURNING id::text`,[organization,`SHARED-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'SHARED-00001','custom_appraisal',$3,$4)`,[report,organization,`SHARED-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'SHARED-00001'},options={scope,actorUserId:actor};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
    const claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,options));
    const metricOptions={...frozenSpatialOptions({...options,claim}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
    await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,metricOptions).prepare());
    const graph={root:{content_sha256:'e'.repeat(64),canonical_utf8_bytes:'100'},
      layer_counts:Object.fromEntries(Object.entries(source.layer_counts).map(([kind,counts])=>[kind,Number(counts.row_count)]))};
    graph.layer_counts.parcels=60001;
    let cursor='',metricCount=0,metricPages=0,maxPageBytes=0;const metricCalls=[];
    const metricPool={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){metricCalls.push(c.text);return raw.query(c);}};}};
    const metricStarted=performance.now();
    for(;;){
      const page=await withCustomCohortJobTransaction(metricPool,client=>createNeighborhoodSharedJobStockMetricPages(client,metricOptions,graph,'2026-10-07')
        .page({cursor,rowLimit:250}));
      maxPageBytes=Math.max(maxPageBytes,Buffer.byteLength(JSON.stringify(page.rows)));metricPages++;
      assert.ok(page.rows.length<=250);assert.equal(page.shared_typed_generation_reference.generation_id,frozen.generationId);
      for(const row of page.rows){
        const n=++metricCount;assert.equal(row.account_id,`SHARED-${String(n).padStart(5,'0')}`);
        assert.equal(row.geographic_parcel_count,'1');assert.equal(row.source_part_count,'1');
        assert.equal(row.observations.reported_residential_area.exact_value,String(1000+n%100));
        assert.equal(row.observations.reported_year_built.exact_value,String(1960+n%40));
        assert.equal(row.observations.reported_site_area.exact_value,'6000');
        assert.equal(row.observations.reported_market_value.exact_value,'200000');
        assert.equal(row.observations.reported_market_value.state,'unsupported');
      }
      cursor=page.next_cursor;if(page.end_of_population)break;
    }
    assert.equal(metricCount,60001);assert.equal(metricPages,241);assert.ok(maxPageBytes<=2_100_000);
    assert.ok(!metricCalls.some(sql=>/INSERT|UPDATE|DELETE|ST_DWithin|shared-typed:page|job-closure:|job-typed:/.test(sql)));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1',[operation])).rows[0].n,0);
    console.info('[native-shared-stock-metric-pages]',{accounts:metricCount,pages:metricPages,maximum_page_bytes:maxPageBytes,
      duration_ms:Math.round(performance.now()-metricStarted),job_typed_copies:0,production_latency:false,source_acquisition:false});
    console.info('[native-shared-typed-generation]',{accounts:60001,original_rows:Number(source.row_count),steps:prepared.steps,
      maximum_page_originals:maximumOriginals,duration_ms:Math.round(performance.now()-started),reuse_ms:reuseMs,
      completion_ms:completionMs,completion_totals_rows:verifiedTotals.length,
      reuse_original_queries:originalQueries-beforeOriginals,reuse_write_queries:writeQueries-beforeWrites,relation_bytes:typedBytes,
      production_latency:false,source_acquisition:false,report_integration:false});
  }finally{await pool.end();}
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
    // The native PK/original-geometry lane independently verifies EVERY one of
    // the 60,001 stock originals across fresh SQL clients, not an array codec
    // or selected-account graph. This DATA test does not establish a completed
    // >50k current-authorized typed acquisition or a production latency claim.
    const retainedCheckpoint=(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0].checkpoint;
    const retainedDefinition=(await pool.query('SELECT definition FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=$1',[operation])).rows[0].definition;
    let originalProgress=null,originalDone=false,originalSteps=0;
    const originalsFrom=stockCalls.length;
    const originalStarted=performance.now();
    while(!originalDone){const step=await withCustomCohortJobTransaction(stockPool,client=>createNeighborhoodFrozenJobStockOriginals(client,
      {claim,scope,actorUserId:actor,geometryInput:retainedDefinition.geometry_input,discovery,
        subjectIntent:retainedCheckpoint.evidence_refs[0],checkBudget(){}}).step(originalProgress));
      originalProgress=step.progress;originalDone=step.all_parcels_verified;assert.ok(++originalSteps<=242);
      assert.equal(step.authority,'not_established');assert.equal(step.coverage,'geographic_originals_only');}
    assert.equal(originalSteps,241);assert.equal(originalProgress.verified_parcels,60001);
    assert.equal(originalProgress.verified_unassociated,0);assert.equal(originalProgress.after_object_id,'60001');
    assert.ok(!stockCalls.slice(originalsFrom).some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)));
    console.info('[native-geographic-originals]',{parcels:60001,steps:originalSteps,duration_ms:Math.round(performance.now()-originalStarted),
      maximum_transferred_rows:1,production_latency:false,typed_acquisition:false});
    // DATA-only SQL validation over the whole native stock. These independently
    // known fixture counts/root binding are NOT an actual completed authorized
    // source graph or acquisition; that actual-owner proof is the small fixture.
    const identityGraph={root:retainedCheckpoint.evidence_refs[0],layer_counts:{parcels:60001,accounts:60001,
      source_records:1,sales:2,sale_links:2,sync_state:1,sync_runs:1}};
    let identityProgress=null,identityDone=false,identitySteps=0;const identityStarted=performance.now();
    while(!identityDone){const step=await withCustomCohortJobTransaction(stockPool,client=>createNeighborhoodFrozenJobSourceIdentity(client,
      {claim,scope,actorUserId:actor,geometryInput:retainedDefinition.geometry_input,discovery,
        subjectIntent:retainedCheckpoint.evidence_refs[0],checkBudget(){}},identityGraph).step(identityProgress));
      identityProgress=step.progress;identityDone=step.all_layers_verified;assert.ok(++identitySteps<=488);
      assert.equal(step.authority,'not_established');assert.ok(Buffer.byteLength(JSON.stringify(identityProgress))<450);}
    assert.equal(identitySteps,487);assert.equal(identityProgress.unknown_parcel_origins,60001);assert.equal(identityProgress.missing_account_count,0);
    console.info('[native-source-identities]',{parcels:60001,accounts:60001,steps:identitySteps,
      duration_ms:Math.round(performance.now()-identityStarted),maximum_transferred_rows:1,production_latency:false,typed_acquisition:false});
    // DATA-only typed read-model over independently known native fixture counts.
    // This does NOT claim an authorized complete >50k original graph/acquisition.
    // The separate small actual-owner fixture below proves admission/checkpoints.
    let typedProgress=null,typedDone=false,typedSteps=0;const typedStarted=performance.now();
    while(!typedDone){const step=await withCustomCohortJobTransaction(stockPool,client=>createNeighborhoodFrozenJobTypedOriginals(client,
      {claim,scope,actorUserId:actor,geometryInput:retainedDefinition.geometry_input,discovery,
        subjectIntent:retainedCheckpoint.evidence_refs[0],checkBudget(){}},identityGraph,'2026-10-07').step(typedProgress));
      typedProgress=step.progress;typedDone=step.all_layers_typed;assert.ok(++typedSteps<=488);
      assert.equal(step.authority,'not_established');assert.ok(Buffer.byteLength(JSON.stringify(typedProgress))<400);}
    assert.equal(typedSteps,487);
    assert.deepEqual((await pool.query(`SELECT kind,count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_original_rows
      WHERE operation_id=$1 GROUP BY kind ORDER BY kind`,[operation])).rows,
    Object.entries(identityGraph.layer_counts).map(([kind,n])=>({kind,n})).sort((a,b)=>a.kind.localeCompare(b.kind)));
    assert.equal((await pool.query(`SELECT typed->'observations'->'normalized_current_price'->>'exact_value' AS value
      FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1 AND kind='source_records' AND row_key='501'`,[operation])).rows[0].value,
    '9007199254740993','large exact decimal text is not rounded in the indexed read-model');
    const typedSize=(await pool.query(`SELECT pg_total_relation_size('app.neighborhood_custom_cohort_typed_original_rows')::text AS bytes`)).rows[0].bytes;
    console.info('[native-typed-originals]',{parcels:60001,accounts:60001,rows:120009,steps:typedSteps,
      duration_ms:Math.round(performance.now()-typedStarted),maximum_page_originals:250,relation_bytes:typedSize,
      production_latency:false,typed_acquisition:false});
    let metricCursor='',metricDone=false,metricAccounts=0,metricParts=0,metricSteps=0,maximumMetricRows=0;
    const metricStarted=performance.now(),metricsFrom=stockCalls.length;
    while(!metricDone){const page=await withCustomCohortJobTransaction(stockPool,client=>createNeighborhoodFrozenJobStockMetricPages(client,
      {claim,scope,actorUserId:actor,geometryInput:retainedDefinition.geometry_input,discovery,
        subjectIntent:retainedCheckpoint.evidence_refs[0],checkBudget(){}},identityGraph,'2026-10-07')
      .page({cursor:metricCursor,rowLimit:250}));
      for(const row of page.rows){const n=Number(row.account_id.slice(7));
        assert.equal(row.source_part_count,'1');assert.equal(row.geographic_parcel_count,'1');
        assert.equal(row.observations.reported_residential_area.exact_value,String(1000+n%100));
        assert.equal(row.observations.reported_year_built.exact_value,String(1960+n%40));
        assert.equal(row.observations.reported_market_value.state,'unsupported');
        assert.equal(row.observations.reported_market_value.exact_value,'200000');
        metricAccounts++;metricParts+=Number(row.source_part_count);}
      maximumMetricRows=Math.max(maximumMetricRows,page.rows.length);metricCursor=page.next_cursor;metricDone=page.end_of_population;
      assert.ok(++metricSteps<=242);assert.equal(page.coverage,'one_account_page_only');assert.equal(page.source_acquisition,'not_established');}
    assert.equal(metricAccounts,60001);assert.equal(metricParts,60001);assert.equal(metricSteps,241);assert.equal(maximumMetricRows,250);
    assert.ok(!stockCalls.slice(metricsFrom).some(sql=>/ST_DWithin|job-closure:|job-typed:rows|job-stock:begin/.test(sql)));
    console.info('[native-stock-metric-pages]',{accounts:metricAccounts,parts:metricParts,pages:metricSteps,maximum_page_accounts:maximumMetricRows,
      duration_ms:Math.round(performance.now()-metricStarted),production_latency:false,typed_acquisition:false});
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
    // A separate actual combined owner starts an explicit durable indexed
    // source prefix on the >50k stock. Real current policy runs at both ends;
    // the old CAD-only intent/capability is never silently reinterpreted.
    const sourceOperation=randomUUID(),sourceInput={...stockInput,operationId:sourceOperation},sourceCalls=[];
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:sourceOperation,observation_period:sourceInput.observationPeriod,discovery}}));
    const sourceClaim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      assert.equal(job.operation_id,sourceOperation);return {operation_id:sourceOperation,claim_token:job.claim_token,attempts:job.attempts};});
    let revokeAfterSource=false,revokeRoleAfterSource=false,changeSubjectAfterSource=false,loseSourceCommit=false;
    const sourcePool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      sourceCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('neighborhood-frozen-job-seeds:rows')&&revokeAfterSource){revokeAfterSource=false;
        await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
      if(config.text.includes('neighborhood-frozen-job-seeds:rows')&&revokeRoleAfterSource){revokeRoleAfterSource=false;
        await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
      if(config.text.includes('neighborhood-frozen-job-seeds:rows')&&changeSubjectAfterSource){changeSubjectAfterSource=false;
        // Current snapshots are held FOR SHARE by this owner, so a real
        // external update is blocked. A same-transaction fixture hook proves
        // the ending material comparison independently, without weakening locks.
        await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[snapshot]);}
      if(config.text==='COMMIT'&&loseSourceCommit){loseSourceCommit=false;throw Error('synthetic source COMMIT acknowledgement lost');}
      return result;}};}};
    const sourceOwner=createCustomCohortContextCapture({pool:sourcePool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    await sourceOwner.prepareFrozenCaptureJobStock(sourceInput,{captureJobClaim:sourceClaim});
    const checkpointBefore=(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.ok(!sourceCalls.some(sql=>sql.includes('neighborhood-frozen-job-closure:')),'initial denied license reads no source page');
    assert.ok(!sourceCalls.some(sql=>sql.includes('neighborhood-frozen-job-seeds:')),'initial denied license does not inspect or prepare seeds');
    const seedCounts=async()=>(await pool.query(`SELECT
      (SELECT count(*)::int FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1) AS headers,
      (SELECT count(*)::int FROM app.neighborhood_custom_cohort_source_seeds WHERE operation_id=$1) AS seeds`,[sourceOperation])).rows[0];
    assert.deepEqual(await seedCounts(),{headers:0,seeds:0});
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeAfterSource=true;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,checkpointBefore,
      'ending current policy revocation rolls back the entire source prefix/checkpoint, not the already retained stock');
    assert.deepEqual(await seedCounts(),{headers:0,seeds:0},'first seed construction rolls back with the refused source page');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeRoleAfterSource=true;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/job_actor_access_revoked/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,checkpointBefore);
    assert.deepEqual(await seedCounts(),{headers:0,seeds:0});
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeSubjectAfterSource=true;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/subject_changed/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,checkpointBefore);
    assert.deepEqual(await seedCounts(),{headers:0,seeds:0});
    await pool.query('UPDATE app.appraisal_subject_snapshots SET subject_data=$1::jsonb WHERE id=$2',[JSON.stringify(subjectData),snapshot]);
    loseSourceCommit=true;
    const sourceFrom=sourceCalls.length;
    const seedStarted=performance.now();
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const seedPreparePageMs=Math.round(performance.now()-seedStarted),seedReuseFrom=sourceCalls.length,seedReuseStarted=performance.now();
    const prefix=await sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim});
    const seedReusePageMs=Math.round(performance.now()-seedReuseStarted);
    assert.deepEqual(await seedCounts(),{headers:1,seeds:1});
    assert.deepEqual((await pool.query('SELECT source_record_id::text AS id FROM app.neighborhood_custom_cohort_source_seeds WHERE operation_id=$1 ORDER BY source_record_id',[sourceOperation])).rows,
      [{id:'501'}],'all-date source 501 is the only stock seed; unrelated unresolved source 502 is not seeded');
    assert.equal(sourceCalls.slice(sourceFrom).filter(sql=>sql.includes('neighborhood-frozen-job-seeds:rows')).length,1);
    assert.ok(!sourceCalls.slice(seedReuseFrom).some(sql=>/neighborhood-frozen-job-seeds:(?:begin|rows|complete)|SELECT DISTINCT original.source_record_id/.test(sql)),
      'fresh source-page continuation neither rebuilds the completed seed index nor recomputes all account seeds');
    console.info('[native-prepared-source-seeds-large-stock]',{stock_accounts:60001,seed_count:1,
      initial_seed_and_page_ms:seedPreparePageMs,fresh_page_ms:seedReusePageMs,seed_builds_after_ack_loss:1,
      complete_source_graph:false,production_latency:false});
    assert.equal(prefix.layers.parcels.row_count,500);assert.equal(prefix.layers.parcels.page_count,2);
    assert.equal(prefix.layers.parcels.cursor,'500');assert.equal(prefix.all_layers_ended,false);
    assert.equal(prefix.source_acquisition,'not_established');assert.equal(prefix.original_graph_verification,'not_established');
    assert.equal(prefix.report_update,'none');
    assert.ok(!sourceCalls.slice(sourceFrom).some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)),
      'fresh actual source transactions use retained indexed membership without another spatial sweep');
    const sourceCheckpoint=(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint;
    assert.equal(sourceCheckpoint.phase,'frozen_source_v1');assert.equal(sourceCheckpoint.evidence_refs.length,3);
    const unfinishedFrom=sourceCalls.length;
    await assert.rejects(sourceOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/unfinished_original_graph/);
    assert.ok(!sourceCalls.slice(unfinishedFrom).some(sql=>sql.includes('neighborhood-frozen-job-closure:')),
      'the 500-row prefix is never accepted as a complete 60,001-property original graph');
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,sourceCheckpoint);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,sourceOperation));
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
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
    // Only this disposable fixture accepts a Polygon CAD geometry, proving
    // its exact EWKB survives while the frozen spatial column becomes Multi.
    await pool.query('ALTER TABLE gis.dcad_parcels ALTER COLUMN geom TYPE geometry(Geometry,4326)');
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
      (5,NULL,NULL,'e',ST_MakeEnvelope(-96.7,32.901,-96.699,32.902,4326))`);
    await pool.query(`UPDATE gis.dcad_parcels SET residential_year_built=1960,parcel_area_sqft=8000,
      current_market_value=9007199254740993,residential_area_sqft=CASE WHEN object_id=1 THEN 1000.01 ELSE 2000.02 END
      WHERE object_id IN (1,4)`);
    await pool.query('UPDATE gis.dcad_parcels SET residential_year_built=NULL WHERE object_id=4');
    await pool.query(`UPDATE gis.dcad_parcels SET residential_year_built=2050,parcel_area_sqft=0,residential_area_sqft=0 WHERE object_id=2`);
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
    // Full seven-layer actual owner prefix on the small but adversarial native
    // population. This is still not a completed typed identity/coverage receipt.
    await pool.query('INSERT INTO app_auth.organization_memberships(organization_id,user_id) VALUES($1,$2)',[organization,actor]);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    const sourceCase=randomUUID(),sourceSnapshot=randomUUID();
    await pool.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,'CLOSURE-A','2026-10-07')",[sourceCase,organization]);
    const subjectData={custom_property_snapshot:{account:{account_id:'CLOSURE-A'},improvement:{living_area_sqft:1001},location:{
      account_id:'CLOSURE-A',latitude:32.9,longitude:-96.7,source:'dcad_parcel_query',precision:'parcel_centroid',
      status:'matched',confidence:'high',review_required:false,review_reason:null,match_method:'parcel_id',source_parcel_id:'CLOSURE-A',
      feature_count:1,metadata:{address_agreement:true},geocoded_at:'2020-01-01T00:00:00.000Z',source_updated_at:'2019-12-31T00:00:00.000Z'}}};
    await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES($1,$2,1,'2026-10-07',$3::jsonb)`,[sourceSnapshot,sourceCase,JSON.stringify(subjectData)]);
    await pool.query('UPDATE app.report_files SET appraisal_case_id=$1,subject_snapshot_id=$2 WHERE id=$3',[sourceCase,sourceSnapshot,report]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',[assignment,`source-${randomUUID()}`]);
    const sourceOperation=randomUUID(),discovery={profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'};
    const sourceInput={auth:{userId:actor,organizations:[]},accountId:scope.account_id,assignmentFileId:assignment,operationId:sourceOperation,
      observationPeriod:{start_date:'2025-01-01',end_date:'2026-10-07'},discovery};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:sourceOperation,observation_period:sourceInput.observationPeriod,discovery}}));
    const sourceClaim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});assert.equal(job.operation_id,sourceOperation);
      return {operation_id:sourceOperation,claim_token:job.claim_token,attempts:job.attempts};});
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const seedCalls=[];let loseSeedClaim=false,loseSeedCommit=false;
    const seedPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      seedCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('neighborhood-frozen-job-seeds:rows')&&loseSeedClaim){loseSeedClaim=false;
        await client.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET claim_token=$1 WHERE operation_id=$2',[randomUUID(),sourceOperation]);}
      if(config.text==='COMMIT'&&loseSeedCommit){loseSeedCommit=false;throw Error('synthetic seed/page COMMIT acknowledgement lost');}
      return result;}};}};
    const sourceOwner=createCustomCohortContextCapture({pool:seedPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    await sourceOwner.prepareFrozenCaptureJobStock(sourceInput,{captureJobClaim:sourceClaim});
    const seedCheckpoint=(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint;
    loseSeedClaim=true;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,seedCheckpoint);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1',[sourceOperation])).rows[0].n,0,
      'an ending lost claim rolls back first seed publication and source/checkpoint in the same transaction');
    const seedCommitFrom=seedCalls.length;
    loseSeedCommit=true;
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const committedSeed=(await pool.query(`SELECT status,seed_count::text FROM app.neighborhood_custom_cohort_seed_indexes
      WHERE operation_id=$1 AND generation_id=$2`,[sourceOperation,frozen.generationId])).rows[0];
    assert.deepEqual(committedSeed,{status:'complete',seed_count:'3'});
    let prefix;
    for(let step=0;step<10;step++){
      prefix=await sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim});
      assert.equal(prefix.source_acquisition,'not_established');if(prefix.all_layers_ended)break;
    }
    assert.equal(prefix.all_layers_ended,true);assert.equal(prefix.original_graph_verification,'not_established');
    assert.equal(seedCalls.slice(seedCommitFrom).filter(sql=>sql.includes('neighborhood-frozen-job-seeds:rows')).length,1,
      'lost commit acknowledgment and fresh page continuation do not rebuild or duplicate the source seeds');
    assert.deepEqual((await pool.query(`SELECT source_record_id::text AS id FROM app.neighborhood_custom_cohort_source_seeds
      WHERE operation_id=$1 ORDER BY source_record_id`,[sourceOperation])).rows,[{id:'501'},{id:'503'},{id:'504'}],
      'outside/unresolved package members are retained but outside-only source 502 never seeds a second hop');
    const sourceStockBody=await withCustomCohortJobTransaction(pool,async client=>{
      const ref=seedCheckpoint.evidence_refs[1];return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization)
        .get(ref.content_sha256,ref.canonical_utf8_bytes));});
    const preparedOptions={...options,claim:sourceClaim,geometryInput:sourceStockBody.stock.definition.geometry_input,
      discovery,subjectIntent:seedCheckpoint.evidence_refs[0],checkBudget(){}};
    const parityCalls=[];const parityPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      parityCalls.push(config.text);return client.query(config);}};}};
    for(const kind of Object.keys(expected)){
      let cursor='',done=false;
      for(let i=0;i<12&&!done;i++){
        const pageInput={kind,cursor,rowLimit:1};
        const original=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobSourcePages(client,preparedOptions).page(pageInput));
        const prepared=await withCustomCohortJobTransaction(parityPool,client=>createNeighborhoodPreparedJobSourcePages(client,preparedOptions).page(pageInput));
        assert.deepEqual(prepared,original,`${kind} independently matches old recomputed closure byte-for-byte`);
        cursor=prepared.next_cursor;done=prepared.end_of_layer;
      }
      assert.equal(done,true);
    }
    assert.ok(!parityCalls.some(sql=>/neighborhood-frozen-job-seeds:(?:begin|rows|complete)|SELECT DISTINCT original.source_record_id|ST_DWithin/.test(sql)));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobSourceSeeds(client,
      {...preparedOptions,scope:{...scope,organization_id:randomUUID()}}).read()),/claim_lost/,
    'a completed source seed cache cannot authorize a foreign scope');
    for(const sql of [
      'UPDATE app.neighborhood_custom_cohort_source_seeds SET source_record_id=source_record_id WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_source_seeds WHERE operation_id=$1',
      'UPDATE app.neighborhood_custom_cohort_seed_indexes SET seed_count=seed_count WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1',
      `INSERT INTO app.neighborhood_custom_cohort_source_seeds(operation_id,generation_id,source_record_id)
        SELECT operation_id,generation_id,999 FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1`,
    ])await assert.rejects(pool.query(sql,[sourceOperation]),error=>error.code==='55000');
    for(const sql of ['TRUNCATE app.neighborhood_custom_cohort_source_seeds',
      'TRUNCATE app.neighborhood_custom_cohort_seed_indexes,app.neighborhood_custom_cohort_source_seeds'])await assert.rejects(pool.query(sql),
      error=>error.code==='55000','direct truncation is refused without changing any retained cache');
    // Disposable incomplete header on the separate storage-only stock above.
    // Same count, one wrong key: independent exact-set verification must refuse.
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      await client.query(`INSERT INTO app.neighborhood_custom_cohort_seed_indexes
        (operation_id,generation_id,binding_sha256,definition_sha256,definition_json) VALUES($1,$2,$3,$3,'{}')`,[operation,frozen.generationId,'d'.repeat(64)]);
      await client.query(`INSERT INTO app.neighborhood_custom_cohort_source_seeds(operation_id,generation_id,source_record_id)
        SELECT $1,$2,n FROM unnest(ARRAY[501,503,999]::bigint[]) n`,[operation,frozen.generationId]);
      await client.query(`UPDATE app.neighborhood_custom_cohort_seed_indexes SET status='complete',seed_count=3,completed_at=clock_timestamp()
        WHERE operation_id=$1`,[operation]);
    }),error=>error.code==='55000'&&/neighborhood_seed_index_incomplete/.test(error.message));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1',[operation])).rows[0].n,0);
    console.info('[native-prepared-source-seeds]',{stock_accounts:2,seed_count:3,seven_layer_exact_parity:true,
      lost_claim_rollback:true,lost_commit_reuse:true,same_count_wrong_set_refused:true,production_latency:false});
    assert.deepEqual(Object.fromEntries(Object.entries(prefix.layers).map(([kind,layer])=>[kind,layer.row_count])),
      Object.fromEntries(Object.entries(expected).map(([kind,keys])=>[kind,keys.length])));
    assert.equal((await sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim})).advanced,false,
      'a saved ended prefix reopens without re-reading or appending a source page');
    const ownedCheckpoint=(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint;
    const ownedHeader=await withCustomCohortJobTransaction(pool,async client=>{
      const ref=ownedCheckpoint.evidence_refs[2];return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization).get(ref.content_sha256,ref.canonical_utf8_bytes));});
    const ownedBinding={...scope,operation_id:sourceOperation,generation_id:frozen.generationId,
      spatial_definition_sha256:ownedHeader.selection.spatial_definition_sha256,source_original_sha256:ownedHeader.selection.source_original_sha256};
    for(const [kind,keys] of Object.entries(expected)){
      let position=null;const seen=[];
      do{
        const stored=await withCustomCohortJobTransaction(pool,client=>createCohortOriginalSourceChainV1Store(
          createNeighborhoodCohortBlobRepository(client,organization),ownedBinding).read({root:ownedHeader.root,kind,position}));
        const page=JSON.parse(stored.original_text).page;seen.unshift(...page.rows.map(row=>row.row_key));position=stored.next_position;
        if(kind==='accounts'&&page.after==='')assert.equal(JSON.parse(page.rows[0].payload_text).legal_description,'\\'.repeat(480000));
        if(kind==='source_records'&&page.after==='')assert.match(page.rows[0].payload_text,/9007199254740993/);
      }while(position!==null);
      assert.deepEqual(seen,keys,`${kind} actual authorized indexed prefix retains exact all-date one-hop originals`);
    }
    assert.equal(ownedHeader.selection.stock_population.unassociated_parcel_count,'1');
    // Independent actual-owner verification uses a new transaction/client for
    // each root edge, with current DB actor/source purpose at both ends. It is
    // representation verification only, never a typed acquisition/Apply receipt.
    const verificationCalls=[];let revokeVerification=false,revokeVerificationRole=false,
      changeVerificationSubject=false,loseVerificationCommit=false;
    const verificationPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      verificationCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('neighborhood-frozen-job-closure:')&&revokeVerification){revokeVerification=false;
        await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
      if(config.text.includes('neighborhood-frozen-job-closure:')&&revokeVerificationRole){revokeVerificationRole=false;
        await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
      if(config.text.includes('neighborhood-frozen-job-closure:')&&changeVerificationSubject){changeVerificationSubject=false;
        await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);}
      if(config.text==='COMMIT'&&loseVerificationCommit){loseVerificationCommit=false;throw Error('synthetic verification COMMIT acknowledgement lost');}
      return result;}};}};
    const verificationOwner=createCustomCohortContextCapture({pool:verificationPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const readCheckpoint=async()=>(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.ok(!verificationCalls.some(sql=>sql.includes('neighborhood-frozen-job-closure:')),'current denied license reads no graph originals');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeVerification=true;
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.deepEqual(await readCheckpoint(),ownedCheckpoint,'ending license revocation rolls back graph progress');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeVerificationRole=true;
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/job_actor_access_revoked/);
    assert.deepEqual(await readCheckpoint(),ownedCheckpoint,'ending current role revocation rolls back graph progress');
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeVerificationSubject=true;
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/subject_changed/);
    assert.deepEqual(await readCheckpoint(),ownedCheckpoint,'ending original subject comparison rolls back graph progress');
    loseVerificationCommit=true;
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const committedCheckpoint=await readCheckpoint();assert.equal(committedCheckpoint.phase,'frozen_verify_v1');
    assert.equal(committedCheckpoint.evidence_refs.length,4);
    const unfinishedGeoFrom=verificationCalls.length;
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/unfinished_graph_verification/);
    assert.deepEqual(await readCheckpoint(),committedCheckpoint);
    assert.ok(!verificationCalls.slice(unfinishedGeoFrom).some(sql=>sql.includes('stock-originals:')),
      'a partial graph cannot advance the separate geographic-original stage');
    const progressFrom=verificationCalls.length;
    let verified=await verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(verified.verified_layer_count,2,'fresh-client lost-ACK recovery resumes at the next actual root head');
    assert.ok(verificationCalls.slice(progressFrom).some(sql=>sql.includes('neighborhood-frozen-job-closure:accounts')));
    assert.ok(!verificationCalls.slice(progressFrom).some(sql=>sql.includes('neighborhood-frozen-job-closure:parcels')),
      'the already committed first graph edge is not silently duplicated');
    for(let i=0;i<10&&!verified.all_layers_verified;i++)verified=await verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(verified.all_layers_verified,true);assert.equal(verified.original_graph_verification,'representation_verified');
    assert.equal(verified.geographic_stock_verification,'not_established');assert.equal(verified.typed_identity_closure,'not_established');
    assert.equal(verified.source_acquisition,'not_established');assert.equal(verified.report_update,'none');
    const replayFrom=verificationCalls.length;
    assert.equal((await verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim})).advanced,false);
    assert.ok(!verificationCalls.slice(replayFrom).some(sql=>sql.includes('neighborhood-frozen-job-closure:')));
    assert.ok(!verificationCalls.some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)),
      'verification does not repeat spatial discovery or replace the indexed stock');
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/,
      'an immutable graph verification cannot be resumed as a mutable source prefix');
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/,
      'a completed representation checkpoint is never a retained permission grant');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const geographicCalls=[];let revokeGeographic=false,revokeGeographicRole=false,changeGeographicSubject=false,loseGeographicCommit=false;
    const geographicPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      geographicCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('stock-originals:page')){
        assert.equal(result.rows.length,1);assert.equal(result.rows[0].page_count,3);assert.equal(result.rows[0].unassociated_count,1);
        assert.equal(result.rows[0].invalid_count,0,'the retained Polygon EWKB is normalized before exact MultiPolygon equality');
        assert.ok(!Object.hasOwn(result.rows[0],'geom')&&!Object.hasOwn(result.rows[0],'payload'),'no geometry blob enters the owner');
        if(revokeGeographic){revokeGeographic=false;await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
        if(revokeGeographicRole){revokeGeographicRole=false;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
        if(changeGeographicSubject){changeGeographicSubject=false;await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);}
      }
      if(config.text==='COMMIT'&&loseGeographicCommit){loseGeographicCommit=false;throw Error('synthetic geographic COMMIT acknowledgement lost');}
      return result;}};}};
    const geographicOwner=createCustomCohortContextCapture({pool:geographicPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const beforeGeographic=await readCheckpoint();
    await assert.rejects(sourceOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/,
      'a graph-only checkpoint cannot begin source identity validation before geographic verification');
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.ok(!geographicCalls.some(sql=>sql.includes('stock-originals:')),'initial current denial reads no geographic original');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeGeographic=true;
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.deepEqual(await readCheckpoint(),beforeGeographic,'ending denial rolls back geographic proof');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeGeographicRole=true;
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/job_actor_access_revoked/);
    assert.deepEqual(await readCheckpoint(),beforeGeographic);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeGeographicSubject=true;
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/subject_changed/);
    assert.deepEqual(await readCheckpoint(),beforeGeographic);
    loseGeographicCommit=true;
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const committedGeo=await readCheckpoint();assert.equal(committedGeo.phase,'frozen_geo_verify_v1');assert.equal(committedGeo.evidence_refs.length,5);
    const geographicFrom=geographicCalls.length;
    const geo=await geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(geo.advanced,false);assert.equal(geo.all_parcels_verified,true);assert.equal(geo.verified_parcels,3);assert.equal(geo.verified_unassociated,1);
    assert.equal(geo.geographic_stock_verification,'originals_verified');assert.equal(geo.original_graph_verification,'representation_verified');
    assert.equal(geo.typed_identity_closure,'not_established');assert.equal(geo.source_acquisition,'not_established');assert.equal(geo.report_update,'none');
    assert.ok(!geographicCalls.slice(geographicFrom).some(sql=>sql.includes('stock-originals:')),'lost-ACK completed replay reads no second geographic page');
    assert.ok(!geographicCalls.some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)));
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/,
      'later geographic proof cannot be reinterpreted as a mutable graph checkpoint');
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/,
      'finished geographic proof is not retained source authority');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const identityCalls=[];let revokeIdentity=false,revokeIdentityRole=false,changeIdentitySubject=false,loseIdentityCommit=false;
    const identityPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      identityCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('neighborhood-frozen-job-identity:')){
        assert.equal(result.rows.length,1);assert.ok(!Object.hasOwn(result.rows[0],'payload')&&!Object.hasOwn(result.rows[0],'geom'));
        if(revokeIdentity){revokeIdentity=false;await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
        if(revokeIdentityRole){revokeIdentityRole=false;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
        if(changeIdentitySubject){changeIdentitySubject=false;await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);}
      }
      if(config.text==='COMMIT'&&loseIdentityCommit){loseIdentityCommit=false;throw Error('synthetic identity COMMIT acknowledgement lost');}
      return result;}};}};
    const identityOwner=createCustomCohortContextCapture({pool:identityPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const beforeIdentity=await readCheckpoint();
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/,
      'a geographic-only checkpoint cannot begin numerical typing');
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.ok(!identityCalls.some(sql=>sql.includes('neighborhood-frozen-job-identity:')),'initial current denial reads no identity payload');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeIdentity=true;
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.deepEqual(await readCheckpoint(),beforeIdentity,'ending denial rolls back every identity progress write');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeIdentityRole=true;
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/job_actor_access_revoked/);
    assert.deepEqual(await readCheckpoint(),beforeIdentity);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeIdentitySubject=true;
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/subject_changed/);
    assert.deepEqual(await readCheckpoint(),beforeIdentity);
    loseIdentityCommit=true;
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const committedIdentity=await readCheckpoint();assert.equal(committedIdentity.phase,'frozen_identity_v1');assert.equal(committedIdentity.evidence_refs.length,6);
    await assert.rejects(sourceOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/unfinished_identity_verification/,
      'a partial identity closure cannot materialize typed observations');
    await assert.rejects(sourceOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,
      {captureJobClaim:sourceClaim,stockMetricPage:{cursor:'',rowLimit:1}}),/unfinished_identity_verification/,
      'a shared DATA cache cannot substitute for unfinished scoped identity proof');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_originals WHERE operation_id=$1',[sourceOperation])).rows[0].n,0);
    const identityFrom=identityCalls.length;
    let identified=await identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(identified.verified_layer_count,2);
    assert.ok(identityCalls.slice(identityFrom).some(sql=>sql.includes('neighborhood-frozen-job-identity:accounts')));
    assert.ok(!identityCalls.slice(identityFrom).some(sql=>sql.includes('neighborhood-frozen-job-identity:parcels')));
    for(let i=0;i<10&&!identified.all_layers_verified;i++)identified=await identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(identified.all_layers_verified,true);assert.equal(identified.source_identity_closure,'identities_and_one_hop_verified');
    assert.equal(identified.unknown_parcel_origins,3);assert.equal(identified.missing_account_count,0);
    assert.equal(identified.origin_count_scope,'source_graph_account_parcel_parts_not_geographic_stock');
    assert.equal(identified.typed_numerical_observations,'not_established');assert.equal(identified.source_freshness,'not_established');
    assert.equal(identified.source_acquisition,'not_established');assert.equal(identified.report_update,'none');
    const identityReplayFrom=identityCalls.length;
    assert.equal((await identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim})).advanced,false);
    assert.ok(!identityCalls.slice(identityReplayFrom).some(sql=>sql.includes('neighborhood-frozen-job-identity:')));
    assert.ok(!identityCalls.some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)));
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/,
      'later identity evidence cannot be replaced by a geographic continuation');
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    // The prepared shared cache is isolated fixture DATA, not a grant or a
    // production builder activation. The real owner chooses its exact pinned
    // generation/date and never prepares a missing cache during a report read.
    const sharedCalls=[];let revokeShared=false,revokeSharedRole=false,changeSharedSubject=false,loseSharedClaim=false;
    const sharedPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      sharedCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('shared-stock-metrics:page')){
        if(revokeShared){revokeShared=false;await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
        if(revokeSharedRole){revokeSharedRole=false;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
        if(changeSharedSubject){changeSharedSubject=false;await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);}
        if(loseSharedClaim){loseSharedClaim=false;await client.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET claim_token=$1 WHERE operation_id=$2',[randomUUID(),sourceOperation]);}
      }
      return result;}};}};
    const sharedOwner=createCustomCohortContextCapture({pool:sharedPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const sharedOptions={captureJobClaim:sourceClaim,stockMetricPage:{cursor:'',rowLimit:1}},beforeShared=await readCheckpoint();
    const sharedRowCount=async()=>(await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1',[sourceOperation])).rows[0].n;
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/invalid_result/);
    assert.ok(!sharedCalls.some(sql=>/shared-typed:begin|shared-typed:rows|job-typed:|shared-stock-metrics:page/.test(sql)));
    let sharedPrepared=await sharedTypedStep(pool,frozen.generationId);
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/unfinished_or_changed_typing/);
    while(!sharedPrepared.all_layers_typed)sharedPrepared=await sharedTypedStep(pool,frozen.generationId,sharedPrepared.progress);
    const sharedStart=sharedCalls.length,sharedStarted=performance.now();
    const sharedA=await sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions);
    const sharedB=await sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,
      {...sharedOptions,stockMetricPage:{cursor:sharedA.next_cursor,rowLimit:250}});
    assert.equal(sharedA.rows[0].account_id,'CLOSURE-A');assert.equal(sharedB.rows[0].account_id,'CLOSURE-B');
    assert.deepEqual(sharedA.rows[0].observations.reported_residential_area.conflict_values,['1000.01','2000.02']);
    assert.equal(sharedA.rows[0].observations.reported_site_area.exact_value,'8000');
    assert.equal(sharedA.rows[0].observations.reported_market_value.exact_value,'9007199254740993');
    assert.equal(sharedA.shared_typed_generation_reference.generation_id,frozen.generationId);
    assert.equal(sharedA.shared_typed_generation_reference.effective_date,'2026-10-07');
    assert.equal(sharedA.source_acquisition,'not_established');assert.equal(sharedA.report_update,'none');
    assert.equal(sharedA.end_of_population,false);assert.equal(sharedB.end_of_population,true);
    assert.equal(await sharedRowCount(),0,'actual shared reads need no per-job typed-row copies');
    assert.deepEqual(await readCheckpoint(),beforeShared);
    assert.ok(!sharedCalls.slice(sharedStart).some(sql=>/ST_DWithin|job-closure:|job-typed:|shared-typed:page|shared-typed:begin|shared-typed:rows|cohort-job:checkpoint-save/.test(sql)));
    assert.ok(sharedCalls.includes('BEGIN ISOLATION LEVEL READ COMMITTED'),'current revocations are not hidden in an old repeatable-read snapshot');
    console.info('[native-shared-stock-metrics]',{accounts:2,rows:sharedA.rows.length+sharedB.rows.length,
      duration_ms:Math.round(performance.now()-sharedStarted),job_typed_copies:await sharedRowCount(),production_latency:false});
    // A real completed cache remains DATA. Neither a foreign actor's forged
    // organization claims nor its authorized workfile can borrow this job pin.
    const foreignOrganization=randomUUID(),foreignActor=randomUUID(),foreignReport=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Foreign shared fixture','Foreign shared fixture')",[foreignOrganization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Foreign shared actor')",[foreignActor,`${foreignActor}@example.test`]);
    await pool.query('INSERT INTO app_auth.organization_memberships(organization_id,user_id) VALUES($1,$2)',[foreignOrganization,foreignActor]);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[foreignOrganization,foreignActor]);
    const foreignAssignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'CLOSURE-A',$2,$3,$3) RETURNING id::text`,[foreignOrganization,`FOREIGN-${randomUUID()}`,foreignActor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'CLOSURE-A','custom_appraisal',$3,$4)`,[foreignReport,foreignOrganization,`FOREIGN-${randomUUID()}`,foreignAssignment]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',[foreignAssignment,`foreign-${randomUUID()}`]);
    const foreignSharedFrom=sharedCalls.length;
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics({...sourceInput,
      auth:{userId:foreignActor,organizations:[{organizationId:organization,roles:['appraiser']}]}},sharedOptions),/job_actor_access_revoked/);
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics({...sourceInput,assignmentFileId:foreignAssignment,
      auth:{userId:foreignActor,organizations:[]}},sharedOptions),/claim_lost/);
    assert.ok(!sharedCalls.slice(foreignSharedFrom).some(sql=>/shared-typed:read|shared-stock-metrics:page/.test(sql)),
      'completed shared cache access is denied before reading its header or rows across organizations');
    assert.deepEqual(await readCheckpoint(),beforeShared);assert.equal(await sharedRowCount(),0);
    const deniedSharedFrom=sharedCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/market_data_access_denied/);
    assert.ok(!sharedCalls.slice(deniedSharedFrom).some(sql=>/shared-typed:read|shared-stock-metrics:page/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeShared=true;
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/market_data_access_denied/);
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeSharedRole=true;
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/job_actor_access_revoked/);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeSharedSubject=true;await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/subject_changed/);
    loseSharedClaim=true;await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/claim_lost/);
    assert.deepEqual(await readCheckpoint(),beforeShared);assert.equal(await sharedRowCount(),0);
    const typedCalls=[];let revokeTyped=false,revokeTypedRole=false,changeTypedSubject=false,loseTypedCommit=false;
    const typedPool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      typedCalls.push(config.text);const result=await client.query(config);
      if(/job-typed:rows|stock-metrics:page/.test(config.text)){
        if(revokeTyped){revokeTyped=false;await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});}
        if(revokeTypedRole){revokeTypedRole=false;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);}
        if(changeTypedSubject){changeTypedSubject=false;await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);}
      }
      if(config.text==='COMMIT'&&loseTypedCommit){loseTypedCommit=false;throw Error('synthetic typed COMMIT acknowledgement lost');}
      return result;}};}};
    const typedOwner=createCustomCohortContextCapture({pool:typedPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const beforeTyped=await readCheckpoint(),typedRows=async()=>(await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1',[sourceOperation])).rows[0].n;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.ok(!typedCalls.some(sql=>sql.includes('job-typed:')||sql.includes('job-closure:')),'initial denial reads/materializes no typed original');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeTyped=true;
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/);
    assert.deepEqual(await readCheckpoint(),beforeTyped);assert.equal(await typedRows(),0,'ending license denial rolls back typed rows, header, blob and checkpoint');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeTypedRole=true;
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/job_actor_access_revoked/);
    assert.deepEqual(await readCheckpoint(),beforeTyped);assert.equal(await typedRows(),0);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeTypedSubject=true;
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/subject_changed/);
    assert.deepEqual(await readCheckpoint(),beforeTyped);assert.equal(await typedRows(),0);
    loseTypedCommit=true;
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),error=>error.outcome_unknown===true);
    const committedTyped=await readCheckpoint();assert.equal(committedTyped.phase,'frozen_typed_v1');assert.equal(committedTyped.evidence_refs.length,7);
    assert.equal(await typedRows(),3);
    await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,{captureJobClaim:sourceClaim,stockMetricPage:{cursor:'',rowLimit:1}}),
      /unfinished_typed_interpretation/,'reading metrics cannot advance or silently complete a partial typed layer');
    assert.deepEqual(await readCheckpoint(),committedTyped);
    const typedFrom=typedCalls.length;let typed=await typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(typed.typed_layer_count,2);assert.equal(await typedRows(),5);
    assert.ok(typedCalls.slice(typedFrom).some(sql=>sql.includes('job-closure:accounts')));
    assert.ok(!typedCalls.slice(typedFrom).some(sql=>sql.includes('job-closure:parcels')),'fresh-client lost ACK resumes after the committed original layer');
    for(let i=0;i<10&&!typed.all_layers_typed;i++)typed=await typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim});
    assert.equal(typed.all_layers_typed,true);assert.equal(typed.individual_original_interpretation,'complete');assert.equal(await typedRows(),17);
    assert.equal(typed.property_transaction_observations,'not_established');assert.equal(typed.source_freshness,'not_established');
    assert.equal(typed.source_acquisition,'not_established');assert.equal(typed.report_update,'none');
    const typedReplayFrom=typedCalls.length;assert.equal((await typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim})).advanced,false);
    assert.ok(!typedCalls.slice(typedReplayFrom).some(sql=>/job-closure:|job-typed:rows|job-typed:progress/.test(sql)));
    assert.ok(!typedCalls.some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)));
    const savedTyped=(await pool.query(`SELECT kind,row_key,account_id,source_record_id::text,typed
      FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1 ORDER BY kind,row_key`,[sourceOperation])).rows;
    for(const [kind,keys] of Object.entries(expected))assert.deepEqual(savedTyped.filter(row=>row.kind===kind).map(row=>row.row_key),keys);
    assert.ok(!savedTyped.some(row=>row.kind==='parcels'&&row.row_key==='5'),'NULL-account geographic stock is retained separately, never invented as an account source observation');
    assert.ok(savedTyped.some(row=>row.kind==='parcels'&&row.row_key==='4'),'outside account-associated CAD parts remain distinguishable originals, not geographic members');
    assert.ok(savedTyped.some(row=>row.kind==='sale_links'&&row.account_id===null));
    const typedBody=JSON.parse((await pool.query(`SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2`,
      [organization,committedTyped.evidence_refs[6].content_sha256])).rows[0].canonical_utf8);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2`,
      [organization,typedBody.profile_reference.content_sha256])).rows[0].n,1,'the exact interpretation definition is retained, not replaced by current defaults on reopen');
    const metricOptions={captureJobClaim:sourceClaim,stockMetricPage:{cursor:'',rowLimit:1}},beforeMetrics=await readCheckpoint(),metricFrom=typedCalls.length;
    const metricsA=await typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,metricOptions);
    assert.deepEqual(metricsA.rows,sharedA.rows,'shared cache reuse must preserve the exact per-job numerical meaning');
    assert.equal(metricsA.rows.length,1);assert.equal(metricsA.rows[0].account_id,'CLOSURE-A');assert.equal(metricsA.end_of_population,false);
    assert.equal(metricsA.rows[0].geographic_parcel_count,'1');assert.equal(metricsA.rows[0].source_part_count,'2');
    assert.equal(metricsA.rows[0].observations.reported_residential_area.state,'conflicting');
    assert.equal(metricsA.rows[0].observations.reported_residential_area.exact_value,null);
    assert.deepEqual(metricsA.rows[0].observations.reported_residential_area.conflict_values,['1000.01','2000.02']);
    assert.equal(metricsA.rows[0].observations.reported_year_built.exact_value,'1960');
    assert.equal(metricsA.rows[0].observations.reported_year_built.observed_part_count,'1');
    assert.equal(metricsA.rows[0].observations.reported_year_built.missing_part_count,'1');
    assert.equal(metricsA.rows[0].observations.reported_site_area.exact_value,'8000','equal repeated account values are not summed across CAD parcel parts');
    assert.equal(metricsA.rows[0].observations.reported_market_value.state,'unsupported');
    assert.equal(metricsA.rows[0].observations.reported_market_value.exact_value,'9007199254740993');
    assert.equal(metricsA.population.unassociated_parcel_count,'1');assert.equal(metricsA.source_acquisition,'not_established');
    const metricsB=await typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,{...metricOptions,stockMetricPage:{cursor:metricsA.next_cursor,rowLimit:250}});
    assert.deepEqual(metricsB.rows,sharedB.rows);
    assert.equal(metricsB.rows.length,1);assert.equal(metricsB.rows[0].account_id,'CLOSURE-B');assert.equal(metricsB.end_of_population,true);
    assert.equal(metricsB.rows[0].observations.reported_year_built.state,'invalid');
    assert.equal(metricsB.rows[0].observations.reported_residential_area.state,'invalid');
    assert.equal(metricsB.rows[0].observations.reported_site_area.exact_value,'0');
    assert.equal(metricsB.rows[0].observations.reported_market_value.state,'missing');
    assert.deepEqual(await readCheckpoint(),beforeMetrics);assert.equal(await typedRows(),17);
    assert.ok(!typedCalls.slice(metricFrom).some(sql=>/ST_DWithin|job-closure:|job-typed:rows|job-typed:progress|cohort-job:checkpoint-save/.test(sql)),
      'metric reads use the existing immutable read model, never recapture or checkpoint writes');
    const deniedFrom=typedCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,metricOptions),/market_data_access_denied/);
    assert.ok(!typedCalls.slice(deniedFrom).some(sql=>sql.includes('stock-metrics:')));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeTyped=true;
    await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,metricOptions),/market_data_access_denied/);
    await setFixtureGrant(pool,organization,fixtureGrant(organization));revokeTypedRole=true;
    await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,metricOptions),/job_actor_access_revoked/);
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    changeTypedSubject=true;await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,metricOptions),/subject_changed/);
    assert.deepEqual(await readCheckpoint(),beforeMetrics);assert.equal(await typedRows(),17);
    for(const sql of ["UPDATE app.neighborhood_custom_cohort_typed_original_rows SET typed=typed WHERE operation_id=$1",
      "DELETE FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1",
      "UPDATE app.neighborhood_custom_cohort_typed_originals SET progress=progress WHERE operation_id=$1"])
      await assert.rejects(pool.query(sql,[sourceOperation]),error=>error.code==='55000');
    await assert.rejects(pool.query(`INSERT INTO app.neighborhood_custom_cohort_typed_original_rows
      (operation_id,generation_id,kind,row_key,account_id,source_record_id,original_payload_sha256,typed)
      SELECT operation_id,generation_id,kind,'5',NULL,NULL,original_payload_sha256,
        jsonb_set(jsonb_set(typed,'{account_id}','null'::jsonb),'{original,row_key}','"5"'::jsonb)
      FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1 AND kind='parcels' AND row_key='1'`,[sourceOperation]),
    error=>error.code==='55000','even a new original FK key cannot be appended after typed publication');
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/market_data_access_denied/,
      'a complete typed header/progress/profile does not grant source authority');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1',[assignment])).rows[0].n,0);
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,sourceOperation));
    await assert.rejects(verificationOwner.verifyFrozenCaptureJobSourcePage(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
    await assert.rejects(geographicOwner.verifyFrozenCaptureJobStockOriginals(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
    await assert.rejects(identityOwner.verifyFrozenCaptureJobSourceIdentityClosure(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
    await assert.rejects(typedOwner.prepareFrozenCaptureJobTypedOriginals(sourceInput,{captureJobClaim:sourceClaim}),/claim_lost/);
    await assert.rejects(typedOwner.readFrozenCaptureJobStockMetrics(sourceInput,{captureJobClaim:sourceClaim,stockMetricPage:{cursor:'',rowLimit:1}}),/claim_lost/);
    await assert.rejects(sharedOwner.readSharedFrozenCaptureJobStockMetrics(sourceInput,sharedOptions),/claim_lost/);
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).cancel(scope,operation));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenSourceClosurePages(client,
      frozenSpatialOptions({...options,claim})).page({kind:'source_records',cursor:''})),/claim_lost/);
  }finally{await pool.end();}
});

test('isolated PostgreSQL: prepares 60001 distinct source seeds once and reuses indexed keys without original scans',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase(),{default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try{
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query("INSERT INTO core.accounts(account_id,county,subdivision) VALUES('DENSE-SEED-A','Dallas','Synthetic Dense Seeds')");
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,subdivision_name,geom)
      VALUES(1,'DENSE-SEED-A','Synthetic Dense Seeds',ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326)))`);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,current_price,close_date)
      SELECT n,'DENSE-SEED-A',100000+n,'2010-01-01'::date FROM generate_series(1,60001) n`);
    const frozen=await runNeighborhoodGroupIndex(pool,{batchSize:250,logger:{info(){}},retainOriginalSources:true});
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Dense seed synthetic','Dense seed synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Dense seed actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'DENSE-SEED-A',$2,$3,$3) RETURNING id::text`,[organization,`DENSE-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'DENSE-SEED-A','custom_appraisal',$3,$4)`,[report,organization,`DENSE-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'DENSE-SEED-A'},options={scope,actorUserId:actor};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:operation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
    const claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,options));
    // DATA-level builder/load acceptance only: a synthetic subject-intent
    // binding is not current licensed actual-owner acquisition or a report.
    const seedOptions={...frozenSpatialOptions({...options,claim}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
    await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,seedOptions).prepare());
    const seedCalls=[];const measured={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      seedCalls.push(config.text);const result=await client.query(config);
      if(config.text.includes('neighborhood-frozen-job-seeds:'))assert.ok(result.rows.length<=1,
        'dense seed preparation returns only metadata or a count, never an ID/payload array');return result;}};}};
    const started=performance.now();
    const seeded=await withCustomCohortJobTransaction(measured,client=>createNeighborhoodFrozenJobSourceSeeds(client,seedOptions).prepare());
    const prepareMs=Math.round(performance.now()-started),reuseFrom=seedCalls.length,reuseStarted=performance.now();
    const reused=await withCustomCohortJobTransaction(measured,client=>createNeighborhoodFrozenJobSourceSeeds(client,seedOptions).prepare());
    const reuseMs=Math.round(performance.now()-reuseStarted);
    assert.deepEqual(reused,seeded);assert.equal(seeded.seed_count,'60001');assert.equal(seeded.generation_id,frozen.generationId);
    assert.equal(seeded.authority,'not_established');assert.equal(seeded.coverage,'seed_lookup_only');
    assert.ok(Buffer.byteLength(JSON.stringify(seeded))<16_000);
    assert.equal(seedCalls.filter(sql=>sql.includes('neighborhood-frozen-job-seeds:rows')).length,1);
    assert.ok(!seedCalls.slice(reuseFrom).some(sql=>/INSERT|UPDATE|DELETE|ST_DWithin|SELECT DISTINCT original.source_record_id/.test(sql)));
    const totals=(await pool.query(`SELECT count(*)::text AS n,min(source_record_id)::text AS first,max(source_record_id)::text AS last,
      sum(source_record_id)::text AS total FROM app.neighborhood_custom_cohort_source_seeds WHERE operation_id=$1`,[operation])).rows[0];
    assert.deepEqual(totals,{n:'60001',first:'1',last:'60001',total:'1800090001'});
    const plans=(await pool.query(`EXPLAIN (FORMAT JSON) SELECT source_record_id FROM app.neighborhood_custom_cohort_source_seeds
      WHERE operation_id=$1 AND generation_id=$2 AND source_record_id=$3`,[operation,frozen.generationId,'60000'])).rows;
    assert.match(JSON.stringify(plans),/Index(?: Only)? Scan/,'exact seed-key lookups use the operation/source primary index');
    const parityCalls=[];const pagePool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      parityCalls.push(config.text);return client.query(config);}};}};
    const pageStarted=performance.now(),pageInput={kind:'source_records',cursor:'59999',rowLimit:2};
    const page=await withCustomCohortJobTransaction(pagePool,client=>createNeighborhoodPreparedJobSourcePages(client,seedOptions).page(pageInput));
    const pageMs=Math.round(performance.now()-pageStarted);
    const old=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobSourcePages(client,seedOptions).page(pageInput));
    assert.deepEqual(page,old);assert.deepEqual(page.rows.map(row=>row.row_key),['60000','60001']);
    assert.equal(JSON.parse(page.rows[1].payload_text).close_date,'2010-01-01');
    assert.ok(!parityCalls.some(sql=>/INSERT|UPDATE|DELETE|SELECT DISTINCT original.source_record_id|ST_DWithin/.test(sql)));
    console.info('[native-prepared-source-seeds-dense]',{stock_accounts:1,seed_count:60001,prepare_ms:prepareMs,
      fresh_reuse_ms:reuseMs,late_page_ms:pageMs,descriptor_bytes:Buffer.byteLength(JSON.stringify(seeded)),
      old_late_page_exact_parity:true,primary_index_used:true,source_acquisition:false,production_latency:false});
  }finally{await pool.end();}
});
