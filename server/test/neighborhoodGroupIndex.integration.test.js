import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { prepareNeighborhoodCiDatabase } from './helpers/neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from './fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { runNeighborhoodGroupIndex,getPreparedNeighborhoodGroupSummary }
  from '../src/services/neighborhoodAssessment/neighborhoodGroupIndex.js';
import { materializeNeighborhoodFrozenSourceGeneration }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceGeneration.js';
import { materializeNeighborhoodFrozenCadImprovements,getNeighborhoodFrozenCadImprovementProfile,
  NEIGHBORHOOD_FROZEN_CAD_IMPROVEMENT_SQL as CAD_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';
import { compileNeighborhoodFrozenTypedCadImprovementV1,getNeighborhoodFrozenTypedCadImprovementV1Profile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
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
import { createCohortOriginalSourceReferencesV2Store }
  from '../src/services/neighborhoodAssessment/cohortOriginalSourceReferencesV2.js';
import { createCustomCohortGraphV2AnchorRepository }
  from '../src/services/neighborhoodAssessment/customCohortGraphV2AnchorRepository.js';
import { createCustomCohortGeographicV2AnchorRepository }
  from '../src/services/neighborhoodAssessment/customCohortGeographicV2AnchorRepository.js';
import { createCustomCohortIdentityV2AnchorRepository }
  from '../src/services/neighborhoodAssessment/customCohortIdentityV2AnchorRepository.js';
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
import { createNeighborhoodSharedJobStockMetricPages, createNeighborhoodSharedJobStockMetricPagesV2,
  NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockMetricPages.js';
import { createNeighborhoodSharedTypedGeneration, createNeighborhoodSharedTypedGenerationV2, NEIGHBORHOOD_SHARED_TYPED_V2_SQL,
  createNeighborhoodSharedTypedCadGenerationV1,NEIGHBORHOOD_SHARED_TYPED_CAD_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';
import { createCustomNeighborhoodWitness2SourcePolicy, CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_PURPOSE } from '../src/security/customNeighborhoodWitness2SourcePolicy.js';
import { CUSTOM_NEIGHBORHOOD_SOURCE_DATASET } from '../src/security/customNeighborhoodSourcePolicy.js';
import { runCustomNeighborhoodCadImprovementPolicyDatabaseChecks }
  from './helpers/customNeighborhoodCadImprovementPolicyDatabaseChecks.js';
import { createCustomNeighborhoodCadImprovementSourcePolicy,CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as CAD_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_PURPOSE as CAD_PURPOSE,CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_DATASET as CAD_DATASET }
  from '../src/security/customNeighborhoodCadImprovementSourcePolicy.js';
import { createNeighborhoodSharedJobCadImprovementPages,NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL,
  createNeighborhoodSharedJobCadAccountPages,NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedJobCadImprovementPages.js';
import { NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedJobTransactionPagesV2.js';

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
const setFixtureGrant=(pool,organization,grant)=>pool.query('UPDATE app_auth.organizations SET metadata=jsonb_set(coalesce(metadata,\'{}\'::jsonb),ARRAY[$1::text],$2::jsonb) WHERE id=$3',
  [CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY,JSON.stringify(grant),organization]);
const setCadFixtureGrant=(pool,organization,grant)=>pool.query('UPDATE app_auth.organizations SET metadata=jsonb_set(coalesce(metadata,\'{}\'::jsonb),ARRAY[$1::text],$2::jsonb) WHERE id=$3',
  [CAD_RIGHTS_KEY,JSON.stringify(grant),organization]);
const fixtureCadPolicy=()=>createCustomNeighborhoodCadImprovementSourcePolicy({datasetRevision:'synthetic-original-1',providerRevisions:fixtureProviders});

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

// V2 offline syntax storage only: no report date or current-user acquisition
// authority is supplied by this isolated fixture.
const sharedTypedV2Step=(pool,generationId,progress=null)=>withCustomCohortJobTransaction(pool,async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  return createNeighborhoodSharedTypedGenerationV2(client,{generationId}).step(progress);
});
async function sharedTypedV2Complete(pool,generationId,progress=null) {
  let r; for(let i=0;i<100;i++) {r=await sharedTypedV2Step(pool,generationId,progress);progress=r.progress;
    if(r.all_layers_typed)return r;}
  assert.fail('small V2 fixture exceeded bounded steps');
}
const sharedTypedCadStep=(pool,generationId,progress=null)=>withCustomCohortJobTransaction(pool,async client=>{
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL TIME ZONE 'UTC'");
  return createNeighborhoodSharedTypedCadGenerationV1(client,{generationId}).step(progress);
});

test('isolated PostgreSQL: publishes indexed city/subdivision facts and preserves exact sale dates',{
  skip:!process.env.DATABASE_URL,timeout:360_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:120_000});
  try {
    const policyClient=await pool.connect();
    try {await runCustomNeighborhoodCadImprovementPolicyDatabaseChecks(policyClient);}finally {policyClient.release();}
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    // The isolated UAD fixture has bedroom/bath and secondary rows but omits
    // the DCAD pool column. Add it only inside this throwaway child database.
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='core'
      AND tablename='primary_improvements' AND indexname='neighborhood_cad_primary_original_key_idx'`)).rows[0].n,1);
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
      VALUES ('INDEX-A',3,2.00,true),('INDEX-B',4,NULL,NULL),('INDEX-C',NULL,NULL,false)`);
    await pool.query(`INSERT INTO core.secondary_improvements(id,account_id,sec_imp_type,sec_imp_sqft)
      VALUES (1,'INDEX-A','ATTACHED GARAGE',400),(2,'INDEX-B','DETACHED GARAGE',500),
             (3,'INDEX-A','STORAGE BUILDING',100),(4,'INDEX-C','POOL',250)`);
    await pool.query('UPDATE core.secondary_improvements SET sec_imp_number=1 WHERE id IN (1,3)');
    await pool.query(`UPDATE gis.dcad_parcels SET geom=ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326)) WHERE object_id=1`);
    const originalGeometry=(await pool.query("SELECT encode(ST_AsEWKB(geom),'hex') AS geometry FROM gis.dcad_parcels WHERE object_id=1")).rows[0].geometry;
    const first=await runNeighborhoodGroupIndex(pool,{batchSize:1,logger:{info(){}},retainOriginalSources:true,
      retainCadImprovementOriginals:true});
    assert.equal(first.status,'complete');
    assert.equal(first.parcels,5);
    assert.equal(first.sales,4);
    const frozen=(await pool.query('SELECT * FROM app.neighborhood_frozen_source_generations WHERE generation_id=$1',[first.generationId])).rows[0];
    assert.equal(frozen.status,'complete');assert.equal(frozen.format_version,1);
    assert.equal(frozen.layer_counts.parcels.row_count,'5');assert.equal(frozen.layer_counts.sales.row_count,'4');
    const original=(await pool.query("SELECT payload FROM app.neighborhood_frozen_source_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='1'",[first.generationId])).rows[0].payload;
    assert.equal(original.stored_geometry_ewkb,originalGeometry,'nightly materialization preserves exact original EWKB');
    assert.equal(original.residential_area_sqft,'1000');
    const cadHeader=(await pool.query('SELECT * FROM app.neighborhood_frozen_cad_improvement_generations WHERE generation_id=$1',[first.generationId])).rows[0];
    assert.equal(cadHeader.status,'complete');assert.equal(cadHeader.source_snapshot,frozen.source_snapshot);
    assert.equal((await pool.query(`SELECT cad.source_transaction_started_at=source.source_transaction_started_at AS exact
      FROM app.neighborhood_frozen_cad_improvement_generations cad JOIN app.neighborhood_frozen_source_generations source USING(generation_id)
      WHERE generation_id=$1`,[first.generationId])).rows[0].exact,true,'native timestamp equality retains microseconds');
    assert.equal(cadHeader.row_count,'7');assert.deepEqual(cadHeader.expected_counts,{primary:'3',secondary:'4'});
    assert.equal(cadHeader.profile_sha256,getNeighborhoodFrozenCadImprovementProfile().profile_ref.content_sha256);
    const cadRows=(await pool.query(`SELECT kind,row_key,payload FROM app.neighborhood_frozen_cad_improvement_rows
      WHERE generation_id=$1 ORDER BY kind,row_key`,[first.generationId])).rows;
    const primaryA=cadRows.find(r=>r.kind==='primary'&&r.row_key==='INDEX-A').payload;
    assert.deepEqual(primaryA,{account_id:'INDEX-A',year_built:null,living_area_sqft:null,bedroom_count:'3',
      bath_count:'2.00',number_units:null,pool:true});
    assert.equal(cadRows.find(r=>r.row_key==='INDEX-B').payload.pool,null);
    assert.equal(cadRows.find(r=>r.row_key==='INDEX-C').payload.pool,false);
    assert.deepEqual(cadRows.filter(r=>r.kind==='secondary'&&r.payload.account_id==='INDEX-A').map(r=>
      [r.row_key,r.payload.sec_imp_number,r.payload.sec_imp_type,r.payload.sec_imp_sqft]),
      [['1','1','ATTACHED GARAGE','400'],['3','1','STORAGE BUILDING','100']],
      'duplicate improvement numbers retain both native row identities, not one inferred garage');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_frozen_cad_improvement_rows
      WHERE generation_id=$1 AND (payload_sha256<>encode(sha256(convert_to(payload::text,'UTF8')),'hex')
        OR payload_utf8_bytes<>octet_length(payload::text))`,[first.generationId])).rows[0].n,0);
    // Small native original-text bridge only, not a job-authorized reader or
    // a complete shared cache. Actual JSONB text/hash is retained unchanged.
    const cadTexts=(await pool.query(`SELECT kind,row_key,payload::text AS payload_text,payload_sha256
      FROM app.neighborhood_frozen_cad_improvement_rows WHERE generation_id=$1 ORDER BY kind,row_key`,[first.generationId])).rows;
    const typedCad=cadTexts.map(row=>{
      const r=compileNeighborhoodFrozenTypedCadImprovementV1({kind:row.kind,row_key:row.row_key,payload_text:row.payload_text});
      assert.equal(r.original.payload_sha256,row.payload_sha256);assert.equal(r.authority,'not_established');
      assert.equal(Object.hasOwn(r,'effective_date'),false);return r;
    });
    assert.equal(typedCad.find(r=>r.original.row_key==='INDEX-A').observations.reported_baths.exact_value,'2');
    assert.equal(typedCad.find(r=>r.original.row_key==='INDEX-B').observations.reported_pool_flag.state,'missing');
    assert.equal(typedCad.find(r=>r.original.row_key==='INDEX-C').observations.reported_pool_flag.exact_value,false);
    assert.equal(typedCad.find(r=>r.original.row_key==='1').markers.sec_imp_type.value_text,'ATTACHED GARAGE');
    assert.equal(typedCad.find(r=>r.original.row_key==='3').markers.sec_imp_type.value_text,'STORAGE BUILDING');
    assert.ok(typedCad.every(r=>!Object.hasOwn(r,'garage_area')));
    console.info('[native-typed-CAD-improvement-syntax]',{original_rows:7,original_hash_mismatches:0,
      exact_profile:getNeighborhoodFrozenTypedCadImprovementV1Profile().profile_ref.content_sha256,
      missing_boolean_not_false:true,duplicate_numbers_not_deduped:true,job_cache_writes:0,
      amenity_resolution:false,source_acquisition:false,report_update:false,production_latency:false});
    await assert.rejects(createNeighborhoodSharedTypedCadGenerationV1(pool,{generationId:first.generationId}).step(),/caller_transaction_required/);
    let cadSourceProbes=0;
    const cadEndingFault={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      if(c.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source&&++cadSourceProbes===2)throw Error('synthetic CAD cache ending failure');
      return raw.query(c);
    }};}};
    await assert.rejects(sharedTypedCadStep(cadEndingFault,first.generationId),/synthetic CAD cache ending failure/);
    for(const table of ['neighborhood_frozen_typed_cad_generations','neighborhood_frozen_typed_cad_rows','neighborhood_frozen_typed_cad_totals'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE generation_id=$1`,[first.generationId])).rows[0].n,0);
    let cadLoseAck=true;
    const cadLostAck={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      const r=await raw.query(c);if(c.text==='COMMIT'&&cadLoseAck){cadLoseAck=false;throw Error('synthetic CAD committed ACK loss');}return r;
    }};}};
    await assert.rejects(sharedTypedCadStep(cadLostAck,first.generationId),e=>e.outcome_unknown===true);
    const cadOpened=await sharedTypedCadStep(pool,first.generationId);assert.equal(cadOpened.advanced,false);
    assert.equal(cadOpened.progress.kind_index,1);assert.equal(cadOpened.progress.typed_rows,'3');
    const cadChangedText={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      const r=await raw.query(c);if(c.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.page&&r.rows[0].page_count){
        const page=JSON.parse(r.rows[0].page_json),value=JSON.parse(page[0].payload_text);value.sec_imp_type='FORGED';
        page[0].payload_text=JSON.stringify(value);r.rows[0].page_json=JSON.stringify(page);
      }return r;
    }};}};
    await assert.rejects(sharedTypedCadStep(cadChangedText,first.generationId,cadOpened.progress),/original_mismatch/);
    assert.deepEqual((await sharedTypedCadStep(pool,first.generationId)).progress,cadOpened.progress);
    await assert.rejects(pool.query("UPDATE app.neighborhood_frozen_typed_cad_generations SET status='complete',completed_at=now() WHERE generation_id=$1",[first.generationId]),
      e=>e.code==='55000'&&/population_incomplete/.test(e.message));
    const cadComplete=await sharedTypedCadStep(pool,first.generationId,cadOpened.progress);
    assert.equal(cadComplete.all_layers_typed,true);assert.equal(cadComplete.progress.kind_index,2);assert.equal(cadComplete.progress.typed_rows,'7');
    assert.deepEqual((await pool.query(`SELECT count(*)::int AS n,count(*) FILTER(WHERE typed.original_payload_sha256<>original.payload_sha256)::int AS bad
      FROM app.neighborhood_frozen_typed_cad_rows typed JOIN app.neighborhood_frozen_cad_improvement_rows original USING(generation_id,kind,row_key)
      WHERE generation_id=$1`,[first.generationId])).rows[0],{n:7,bad:0});
    const cadReuseCalls=[],cadReuse={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){cadReuseCalls.push(c.text);return raw.query(c);}};}};
    assert.deepEqual((await sharedTypedCadStep(cadReuse,first.generationId)).progress,cadComplete.progress);
    assert.ok(!cadReuseCalls.some(sql=>/shared-typed-CAD:(?:page|rows|begin|progress)|FOR UPDATE/.test(sql)));
    for(const table of ['neighborhood_frozen_typed_cad_rows','neighborhood_frozen_typed_cad_totals'])
      await assert.rejects(pool.query(`UPDATE app.${table} SET ${table.endsWith('_rows')?'typed=typed':'row_count=row_count+1'} WHERE generation_id=$1`,[first.generationId]),e=>e.code==='55000');
    console.info('[native-shared-typed-CAD-generation]',{original_rows:7,typed_rows:7,original_hash_mismatches:0,
      ending_rollback:true,lost_commit_reopen:true,exact_payload_refusal:true,incomplete_prefix_refusal:true,
      reuse_original_queries:0,reuse_writes:0,immutable_complete:true,source_acquisition:false,amenity_resolution:false,
      report_update:false,production_latency:false});
    for(const sql of ['UPDATE app.neighborhood_frozen_cad_improvement_rows SET payload=payload WHERE generation_id=$1',
      'UPDATE app.neighborhood_frozen_cad_improvement_generations SET row_count=0 WHERE generation_id=$1'])
      await assert.rejects(pool.query(sql,[first.generationId]),error=>error.code==='55000');
    // Resolve the actual native FK, rather than guessing PostgreSQL's truncated
    // generated name or the relation named in its diagnostic table field.
    const originalFk=await pool.query(`SELECT conname,convalidated,confdeltype,confupdtype,
      pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='app.neighborhood_frozen_typed_cad_rows'::regclass
        AND confrelid='app.neighborhood_frozen_cad_improvement_rows'::regclass AND contype='f'`);
    assert.equal(originalFk.rowCount,1);const fk=originalFk.rows[0];
    assert.equal(fk.convalidated,true);assert.equal(fk.confdeltype,'r');assert.equal(fk.confupdtype,'r');
    assert.match(fk.definition,/FOREIGN KEY \(generation_id, kind, row_key\) REFERENCES app\.neighborhood_frozen_cad_improvement_rows\(generation_id, kind, row_key\)/);
    await assert.rejects(pool.query('DELETE FROM app.neighborhood_frozen_cad_improvement_rows WHERE generation_id=$1',[first.generationId]),
      error=>error.code==='55000'||error.code==='23503'&&error.constraint===fk.conname,
      'only the original guard or the verified exact restrictive original FK may refuse this DELETE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_cad_improvement_rows WHERE generation_id=$1',
      [first.generationId])).rows[0].n,7,'all companion originals survive each refused deletion');
    // PostgreSQL checks restrictive FKs before statement TRUNCATE triggers.
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_cad_improvement_rows'),error=>error.code==='0A000'
      &&error.detail?.includes('"neighborhood_frozen_typed_cad_rows"'));
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_frozen_cad_improvement_rows CASCADE'),error=>error.code==='55000',
      'even an attempted CASCADE must hit the unchanged no-truncate guard');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_cad_improvement_rows WHERE generation_id=$1',
      [first.generationId])).rows[0].n,7);
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL TIME ZONE 'UTC'");
      await materializeNeighborhoodFrozenCadImprovements(client,{generationId:first.generationId});
    }),/same_building_source_snapshot_required/,'completed old capture is never silently backfilled');
    // Actual fixed source-payload and independent-population guards, including
    // letter account keys beside bigint secondary keys, in a disposable RR tx.
    const cadCandidate=randomUUID(),cadClient=await pool.connect();
    try {
      await cadClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await cadClient.query("SET LOCAL TIME ZONE 'UTC'");
      await cadClient.query("INSERT INTO app.neighborhood_group_generations(generation_id,status) VALUES($1,'building')",[cadCandidate]);
      const source=await materializeNeighborhoodFrozenSourceGeneration(cadClient,{generationId:cadCandidate,batchSize:1});
      const profile=getNeighborhoodFrozenCadImprovementProfile(),args=[cadCandidate,source.source_snapshot,
        source.source_transaction_started_at,profile.profile_ref.content_sha256,profile.definition_blob.canonical_json];
      const refuses=async(sql,values,code='55000')=>{
        await cadClient.query('SAVEPOINT cad_guard');await assert.rejects(cadClient.query(sql,values),e=>e.code===code);
        await cadClient.query('ROLLBACK TO SAVEPOINT cad_guard');await cadClient.query('RELEASE SAVEPOINT cad_guard');
      };
      await refuses(CAD_SQL.begin,[...args,'{"primary":"0","secondary":"0"}']);
      await cadClient.query(CAD_SQL.begin,[...args,'{"primary":"3","secondary":"4"}']);
      await refuses(`INSERT INTO app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key,account_id,payload,payload_utf8_bytes,payload_sha256)
        SELECT $1,'primary','INDEX-A','INDEX-A',$2::jsonb,octet_length(($2::jsonb)::text),encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex')`,
      [cadCandidate,JSON.stringify({...primaryA,pool:false})]);
      await refuses(`INSERT INTO app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key,account_id,payload,payload_utf8_bytes,payload_sha256)
        SELECT $1,'secondary','1','INDEX-A',$2::jsonb,octet_length(($2::jsonb)::text),encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex')`,
      [cadCandidate,JSON.stringify({id:'1',account_id:'INDEX-A',sec_imp_number:'1',sec_imp_type:'ATTACHED GARAGE',sec_imp_sqft:'401'})]);
      await refuses(`INSERT INTO app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key,account_id,payload,payload_utf8_bytes,payload_sha256)
        SELECT $1,'primary','INDEX-A','INDEX-A',$2::jsonb,1,repeat('a',64)`,[cadCandidate,JSON.stringify(primaryA)],'23514');
      await refuses(`INSERT INTO app.neighborhood_frozen_cad_improvement_totals(generation_id,kind,row_count,payload_utf8_bytes)
        VALUES($1,'primary',3,300)`,[cadCandidate]);
      await refuses(CAD_SQL.complete,[cadCandidate,JSON.stringify({primary:{row_count:'0',payload_utf8_bytes:'0'},secondary:{row_count:'0',payload_utf8_bytes:'0'}}),'0','0']);
      await refuses(`INSERT INTO app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key,account_id,payload,payload_utf8_bytes,payload_sha256)
        SELECT $1,'secondary','9223372036854775808','INDEX-A',$2::jsonb,octet_length(($2::jsonb)::text),encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex')`,
      [cadCandidate,JSON.stringify({id:'9223372036854775808',account_id:'INDEX-A',sec_imp_number:null,sec_imp_type:null,sec_imp_sqft:null})],'23514');
    } finally {await cadClient.query('ROLLBACK');cadClient.release();}
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_group_generations WHERE generation_id=$1',[cadCandidate])).rows[0].n,0);
    // Throw after the actual companion is complete but before index publication.
    // The offline owner must roll back originals, companion and candidate alike.
    await assert.rejects(runNeighborhoodGroupIndex(pool,{batchSize:1,retainOriginalSources:true,retainCadImprovementOriginals:true,
      logger:{info(line){if(line.includes('phase=frozen_CAD_improvement_originals_complete'))throw new Error('synthetic CAD post-copy rollback');},warn(){}}}),/synthetic CAD post-copy rollback/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_cad_improvement_generations')).rows[0].n,1);
    assert.equal((await pool.query('SELECT generation_id::text AS id FROM app.neighborhood_group_active')).rows[0].id,first.generationId);
    console.info('[native-frozen-CAD-improvement-originals]',{primary_rows:3,secondary_rows:4,duplicate_numbers_retained:true,
      exact_decimal_null_boolean_literals:true,original_hash_mismatches:0,same_snapshot:true,forged_payload_counts_refused:true,
      owner_rollback_before_publication:true,legacy_seven_layer_format_unchanged:true,
      source_acquisition:false,amenity_resolution:false,report_update:false,production_latency:false});
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
    // Real separate generation/profile-only V2 storage. A failed ending probe
    // rolls back the header, row inserts and independently derived totals.
    await assert.rejects(createNeighborhoodSharedTypedGenerationV2(pool,{generationId:first.generationId}).step(),
      /caller_transaction_required/);
    let neutralSources=0;
    const endingTypedFault={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      if(c.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source&&++neutralSources===2)throw Error('synthetic V2 ending refusal');
      return raw.query(c);}};}};
    await assert.rejects(sharedTypedV2Step(endingTypedFault,first.generationId),/synthetic V2 ending refusal/);
    for(const table of ['neighborhood_frozen_typed_v2_generations','neighborhood_frozen_typed_v2_rows','neighborhood_frozen_typed_v2_totals'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE generation_id=$1`,[first.generationId])).rows[0].n,0);
    let neutralLoseAck=true;
    const neutralLostAck={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      const r=await raw.query(c);if(c.text==='COMMIT'&&neutralLoseAck){neutralLoseAck=false;throw Error('synthetic V2 committed ACK loss');}return r;
    }};}};
    await assert.rejects(sharedTypedV2Step(neutralLostAck,first.generationId),error=>error.outcome_unknown===true);
    const neutralOpened=await sharedTypedV2Step(pool,first.generationId);
    assert.equal(neutralOpened.advanced,false);assert.equal(neutralOpened.progress.typed_rows,'5');
    assert.equal(Object.hasOwn(neutralOpened,'effective_date'),false);
    assert.equal((await pool.query("SELECT row_count::text AS n FROM app.neighborhood_frozen_typed_v2_totals WHERE generation_id=$1 AND kind='parcels'",[first.generationId])).rows[0].n,'5');
    // Independently rendered originals must match exact text/hash/identity;
    // changing a page's payload cannot leave rows or advance the cache header.
    const changedNeutralOriginal={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      const r=await raw.query(c);if(c.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.page&&r.rows[0].page_count){
        const rows=JSON.parse(r.rows[0].page_json),payload=JSON.parse(rows[0].payload_text);payload.county='Changed';
        rows[0].payload_text=JSON.stringify(payload);r.rows[0].page_json=JSON.stringify(rows);
      }return r;
    }};}};
    await assert.rejects(sharedTypedV2Step(changedNeutralOriginal,first.generationId,neutralOpened.progress),/original_mismatch/);
    assert.deepEqual((await sharedTypedV2Step(pool,first.generationId)).progress,neutralOpened.progress);
    await assert.rejects(pool.query("UPDATE app.neighborhood_frozen_typed_v2_generations SET status='complete',completed_at=now() WHERE generation_id=$1",[first.generationId]),
      error=>error.code==='55000'&&/population_incomplete/.test(error.message));
    const neutralComplete=await sharedTypedV2Complete(pool,first.generationId,neutralOpened.progress);
    assert.equal(neutralComplete.progress.typed_rows,frozen.row_count);
    const actualNeutral=(await pool.query(`SELECT count(*)::text AS n,
      count(*) FILTER(WHERE typed.typed ? 'effective_date' OR typed.typed->>'typed_original_version'<>'2'
        OR typed.original_payload_sha256<>encode(sha256(convert_to(original.payload::text,'UTF8')),'hex'))::text AS invalid
      FROM app.neighborhood_frozen_typed_v2_rows typed JOIN app.neighborhood_frozen_source_rows original
        USING(generation_id,kind,row_key) WHERE typed.generation_id=$1`,[first.generationId])).rows[0];
    assert.deepEqual(actualNeutral,{n:frozen.row_count,invalid:'0'});
    const neutralCalls=[];
    const neutralReplay={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
      neutralCalls.push(c.text);return raw.query(c);}};}};
    const neutralReused=await sharedTypedV2Step(neutralReplay,first.generationId);
    assert.deepEqual(neutralReused.progress,neutralComplete.progress);
    assert.equal(neutralReused.reused,true);assert.equal(neutralReused.advanced,false);
    assert.ok(!neutralCalls.some(text=>/shared-typed-v2:(?:page|rows|begin|progress)|FOR UPDATE/.test(text)));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_v2_generations WHERE generation_id=$1',[first.generationId])).rows[0].n,1);
    // V1's retained date cache and definition have not been replaced or reused.
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_frozen_typed_rows WHERE generation_id=$1',[first.generationId])).rows[0].n,retainedSharedCount);
    for(const sql of ['UPDATE app.neighborhood_frozen_typed_v2_totals SET row_count=row_count+1 WHERE generation_id=$1',
      'UPDATE app.neighborhood_frozen_typed_v2_rows SET typed=typed WHERE generation_id=$1',
      'UPDATE app.neighborhood_frozen_typed_v2_generations SET progress=progress WHERE generation_id=$1',
      'DELETE FROM app.neighborhood_frozen_typed_v2_rows WHERE generation_id=$1'])
      await assert.rejects(pool.query(sql,[first.generationId]),error=>error.code==='55000');
    for(const table of ['neighborhood_frozen_typed_v2_generations','neighborhood_frozen_typed_v2_rows','neighborhood_frozen_typed_v2_totals'])
      await assert.rejects(pool.query(`TRUNCATE app.${table} CASCADE`),error=>error.code==='55000');
    console.info('[native-shared-typed-generation-v2]',{original_rows:Number(actualNeutral.n),cache_headers:1,
      generation_profile_only:true,original_hash_mismatches:0,ending_rollback:true,lost_commit_reopen:true,
      immutable_complete:true,reuse_original_queries:0,reuse_writes:0,legacy_cache_preserved:true,
      report_integration:false,source_acquisition:false,production_latency:false});
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
    // Bounded SQL DATA protocol only: this artificial graph reference is NOT
    // an issued current-authorized owner head or licensed acquisition proof.
    const cadPageOptions={...frozenSpatialOptions({...options,claim}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
    const cadStock=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,cadPageOptions).prepare());
    const cadGraphData={root:{content_sha256:'d'.repeat(64),canonical_utf8_bytes:'100'},
      layer_counts:Object.fromEntries(Object.entries(cadStock.original.layer_counts).map(([kind,count])=>[kind,Number(count.row_count)]))};
    const cadQueries=[];
    const cadPage=(kind,cursor={account_id:'',row_key:''},rowLimit=1,endingFault=false)=>withCustomCohortJobTransaction(pool,client=>{
      let reads=0;const port={async query(config){cadQueries.push(config.text);const r=await client.query(config);
        if(endingFault&&config.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++reads===2)return {...r,rows:[{...r.rows[0],status:'building'}]};return r;}};
      return createNeighborhoodSharedJobCadImprovementPages(port,cadPageOptions,cadGraphData).page({kind,cursor,rowLimit});});
    const primaryCad=await cadPage('primary');assert.deepEqual(primaryCad.rows.map(r=>r.account_id),['INDEX-A']);
    assert.equal(primaryCad.end_of_kind,false);assert.equal(primaryCad.rows[0].typed.observations.reported_pool_flag.state,'observed');
    assert.equal(primaryCad.rows[0].typed.observations.reported_pool_flag.exact_value,true);
    const primaryEnd=await cadPage('primary',primaryCad.next_cursor);assert.equal(primaryEnd.rows.length,0);assert.equal(primaryEnd.end_of_kind,true);
    const secondaryCad=await cadPage('secondary',undefined,250);assert.deepEqual(secondaryCad.rows.map(r=>r.row_key),['1','3']);
    assert.equal(secondaryCad.end_of_kind,true);assert.ok(secondaryCad.rows.every(r=>r.account_id==='INDEX-A'));
    await assert.rejects(cadPage('primary',undefined,250,true),/cache_unavailable/);
    assert.ok(cadQueries.includes(NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL));
    assert.ok(!cadQueries.some(sql=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|FROM gis\.|shared-typed-CAD:page|payload::text/.test(sql)));
    console.log('[native-shared-CAD-stock-pages]',{stock_accounts:cadStock.population.account_count,primary_rows:1,secondary_rows:2,
      outside_accounts:0,duplicate_numbers_retained:true,full_tail_empty_probe:true,ending_metadata_refusal:true,
      original_payload_queries:0,writes:0,graph_issuance:false,current_actor_owner:false,source_acquisition:false,production_latency:false});
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
    const second=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}},retainOriginalSources:true,
      retainCadImprovementOriginals:true});
    assert.equal(second.status,'complete');
    const secondCache=await sharedTypedStep(pool,second.generationId);
    assert.equal(secondCache.all_layers_typed,false,'bounded partial shared generation is not complete');
    const secondNeutralCache=await sharedTypedV2Step(pool,second.generationId);
    assert.equal(secondNeutralCache.all_layers_typed,false);
    assert.equal((await sharedTypedCadStep(pool,second.generationId)).all_layers_typed,false);
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
    for(const table of ['neighborhood_frozen_typed_v2_rows','neighborhood_frozen_typed_v2_totals','neighborhood_frozen_typed_v2_generations'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE generation_id=$1`,[second.generationId])).rows[0].n,0,
        'V2 partial cache retires before restrictive original FKs without disabling guards');
    for(const table of ['neighborhood_frozen_cad_improvement_rows','neighborhood_frozen_cad_improvement_totals','neighborhood_frozen_cad_improvement_generations'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE generation_id=$1`,[second.generationId])).rows[0].n,0,
        'unpinned CAD companion retires in bounded FK order before its original account rows');
    for(const table of ['neighborhood_frozen_typed_cad_rows','neighborhood_frozen_typed_cad_totals','neighborhood_frozen_typed_cad_generations'])
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.${table} WHERE generation_id=$1`,[second.generationId])).rows[0].n,0,
        'partial CAD cache retires before its companion originals without disabling FKs');
    assert.deepEqual((await sharedTypedCadStep(pool,first.generationId)).progress,cadComplete.progress);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_cad_improvement_rows WHERE generation_id=$1',[first.generationId])).rows[0].n,7);
    console.info('[native-frozen-CAD-retirement]',{unpinned_companion_retired:true,pinned_originals_preserved:true,
      source_acquisition:false,production_latency:false});
    assert.deepEqual((await sharedTypedV2Step(pool,first.generationId)).progress,neutralComplete.progress,
      'new sweeps cannot retire or retype the exact pinned V2 cache');
    console.info('[native-shared-typed-v2-retirement]',{unpinned_partial_retired:true,pinned_complete_preserved:true,
      source_acquisition:false,production_latency:false});
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
    await pool.query(`INSERT INTO core.primary_improvements(account_id,bedroom_count,bath_count,pool)
      VALUES ('CLOSURE-A',3,2.00,true),('CLOSURE-B',4,NULL,NULL),('CLOSURE-OUTSIDE',NULL,NULL,false)`);
    await pool.query(`INSERT INTO core.secondary_improvements(id,account_id,sec_imp_number,sec_imp_type,sec_imp_sqft)
      VALUES (1,'CLOSURE-A',1,'ATTACHED GARAGE',400),(2,'CLOSURE-B',1,'DETACHED GARAGE',500),
        (3,'CLOSURE-A',1,'STORAGE BUILDING',100),(4,'CLOSURE-OUTSIDE',1,'POOL',250)`);
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
    const frozen=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}},retainOriginalSources:true,retainCadImprovementOriginals:true});
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
    // V2 is a separate DATA representation, not an upgrade of the owner's V1
    // checkpoint/grant. Retain only small fixed-plan descriptors, reproduce
    // every page from the exact job-stock originals on fresh SQL clients, and
    // leave the genuine V1 owner/checkpoint and independent verifier unchanged.
    const referenceStock=await withCustomCohortJobTransaction(pool,async client=>{
      const r=ownedCheckpoint.evidence_refs[1];return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization)
        .get(r.content_sha256,r.canonical_utf8_bytes));});
    const referenceOptions={...options,claim:sourceClaim,geometryInput:referenceStock.stock.definition.geometry_input,
      discovery,subjectIntent:referenceStock.subject_intent,checkBudget(){}};
    const referenceCalls=[];
    const referenceStore=(client,blobOrganization=organization)=>{
      const blobs=createNeighborhoodCohortBlobRepository(client,blobOrganization);
      return createCohortOriginalSourceReferencesV2Store({put:text=>blobs.put(text),get:(hash,size)=>blobs.get(hash,size)},ownedBinding,{
        async readOriginal(request){
          assert.equal(request.plan,'neighborhood_frozen_job_closure_v1');
          const jobs=createCustomCohortCaptureJobRepository(client);
          assert.equal((await jobs.readPreparedGeneration(sourceClaim,options)).generation_id,frozen.generationId);
          const page=await createNeighborhoodFrozenJobSourcePages(client,referenceOptions)
            .page({kind:request.kind,cursor:request.after,rowLimit:request.row_limit});
          assert.equal((await jobs.readPreparedGeneration(sourceClaim,options)).generation_id,frozen.generationId);
          referenceCalls.push(request);return JSON.stringify({binding:ownedBinding,page});
        },
      });
    };
    let referenceRoot=(await withCustomCohortJobTransaction(pool,client=>referenceStore(client).create())).root;
    let lostReferenceCommit=true;
    const referencePool={async connect(){const client=await pool.connect();return {release:client.release.bind(client),async query(config){
      const result=await client.query(config);
      if(config.text==='COMMIT'&&lostReferenceCommit){lostReferenceCommit=false;throw Error('synthetic reference COMMIT acknowledgment lost');}
      return result;}};}};
    const countReferenceBlobs=async()=>(await pool.query(`SELECT count(*)::integer AS count FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=$1 AND canonical_utf8::jsonb->>'format'='cohort_original_source_references_v2'`,[organization])).rows[0].count;
    for(const kind of Object.keys(expected)){
      let cursor='',ended=false;
      while(!ended){
        const page=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobSourcePages(client,referenceOptions)
          .page({kind,cursor,rowLimit:250}));
        const input={root:referenceRoot,original_text:JSON.stringify({binding:ownedBinding,page}),row_limit:250};
        if(kind==='parcels'&&cursor===''){
          await assert.rejects(withCustomCohortJobTransaction(referencePool,client=>referenceStore(client).append(input)),
            error=>error.outcome_unknown===true);
          const afterCommit=await countReferenceBlobs();
          referenceRoot=(await withCustomCohortJobTransaction(pool,client=>referenceStore(client).append(input))).root;
          assert.equal(await countReferenceBlobs(),afterCommit,'lost real COMMIT ACK reuses the exact metadata blobs');
        }else referenceRoot=(await withCustomCohortJobTransaction(pool,client=>referenceStore(client).append(input))).root;
        cursor=page.next_cursor;ended=page.end_of_layer;
      }
    }
    assert.equal(referenceCalls.length,0,'append/describe metadata does not claim to verify a fixed original query');
    const metadataRows=(await pool.query(`SELECT count(*)::integer AS count,max(canonical_utf8_bytes)::integer AS maximum,
      bool_and(canonical_utf8 NOT LIKE '%payload_text%') AS no_payloads FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=$1 AND canonical_utf8::jsonb->>'format'='cohort_original_source_references_v2'`,[organization])).rows[0];
    assert.ok(metadataRows.count>=15);assert.ok(metadataRows.maximum<16_000);assert.equal(metadataRows.no_payloads,true);
    const referenceStarted=performance.now();let referencePages=0;
    for(const [kind,keys] of Object.entries(expected)){
      let position=null,legacyPosition=null;const seen=[];let count=0,bytes=0;
      do{
        const step=await withCustomCohortJobTransaction(pool,async client=>{
          const jobs=createCustomCohortCaptureJobRepository(client);
          assert.deepEqual(await jobs.readCheckpoint(sourceClaim,options),ownedCheckpoint);
          const result=await referenceStore(client).read({root:referenceRoot,kind,position});
          const legacy=await createCohortOriginalSourceChainV1Store(createNeighborhoodCohortBlobRepository(client,organization),ownedBinding)
            .read({root:ownedHeader.root,kind,position:legacyPosition});
          assert.equal(result.original_text,legacy.original_text,'V2 fixed query reproduces the exact existing V1 original bytes');
          legacyPosition=legacy.next_position;
          assert.deepEqual(await jobs.readCheckpoint(sourceClaim,options),ownedCheckpoint);return result;});
        const p=JSON.parse(step.original_text).page;seen.unshift(...p.rows.map(r=>r.row_key));count++;bytes+=Buffer.byteLength(step.original_text);
        assert.equal(step.authority,'not_established');assert.equal(step.coverage,'referenced_pages_only');
        if(kind==='accounts'&&p.after==='')assert.ok(Buffer.byteLength(step.original_text)>1_500_000);
        if(kind==='source_records'&&p.after==='')assert.match(p.rows[0].payload_text,/9007199254740993/);
        position=step.next_position;referencePages++;
        if(position===null){assert.equal(step.layer.page_count,count);assert.equal(step.layer.row_count,keys.length);
          assert.equal(step.layer.original_utf8_bytes,bytes);assert.equal(step.layer.ended,true);assert.equal(legacyPosition,null);}
      }while(position!==null);
      assert.deepEqual(seen,keys,`${kind} V2 references reproduce every original one-hop page, not copied payloads`);
    }
    const foreignReadCount=referenceCalls.length;
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>referenceStore(client,randomUUID())
      .read({root:referenceRoot,kind:'parcels',position:null})),/missing_original/);
    assert.equal(referenceCalls.length,foreignReadCount,'foreign organization metadata refuses before any source callback');
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>referenceStore(client).describe(ownedHeader.root)),/binding_changed/,
      'no legacy V1 source root is cast into a reference-only root');
    console.log('[native-original-source-references-v2]',{layers:7,pages:referencePages,
      metadata_maximum_bytes:metadataRows.maximum,original_payload_copies:0,lost_commit_reuse:true,
      reopen_ms:Math.ceil(performance.now()-referenceStarted),source_acquisition:false,production_latency:false});
    // Separate actual V2 prefix owner: the V1 job/root/progress is never cast or
    // changed. This is a small adversarial native capture, not >50k completion,
    // independent V2 graph verification, source acquisition or production QA.
    const refsOperation=randomUUID(),refsInput={...sourceInput,operationId:refsOperation};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:refsOperation,observation_period:refsInput.observationPeriod,discovery}}));
    const refsClaim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});assert.equal(job.operation_id,refsOperation);
      return {operation_id:refsOperation,claim_token:job.claim_token,attempts:job.attempts};});
    const refsCalls=[],refsBlobPuts=[];let refsFault=null,refsAbort=null;
    const refsPool={async connect(){const client=await pool.connect();let cadHeaderReads=0,transactionHeaderReads=0;return {release:client.release.bind(client),async query(config){
      refsCalls.push(config.text);
      if(config.text.includes('neighborhood-cohort-blob:insert */'))refsBlobPuts.push(config.values[3]);
      const result=await client.query(config);
      if(['missing_receipt','corrupt_receipt'].includes(refsFault)&&config.text.includes('neighborhood-cohort-blob:read */')
        &&config.values[1]===(await client.query('SELECT receipt_reference->>\'content_sha256\' AS hash FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=$1',[refsOperation])).rows[0]?.hash){
        const fault=refsFault;refsFault=null;
        return fault==='missing_receipt'?{rowCount:0,rows:[]}:{...result,rows:result.rows.map(row=>({...row,canonical_utf8:'{}'}))};
      }
      if(['missing_geo_receipt','corrupt_geo_receipt'].includes(refsFault)&&config.text.includes('neighborhood-cohort-blob:read */')
        &&config.values[1]===(await client.query('SELECT receipt_reference->>\'content_sha256\' AS hash FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=$1',[refsOperation])).rows[0]?.hash){
        const fault=refsFault;refsFault=null;
        return fault==='missing_geo_receipt'?{rowCount:0,rows:[]}:{...result,rows:result.rows.map(row=>({...row,canonical_utf8:'{}'}))};
      }
      if(['missing_identity_receipt','corrupt_identity_receipt'].includes(refsFault)&&config.text.includes('neighborhood-cohort-blob:read */')
        &&config.values[1]===(await client.query('SELECT receipt_reference->>\'content_sha256\' AS hash FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=$1',[refsOperation])).rows[0]?.hash){
        const fault=refsFault;refsFault=null;
        return fault==='missing_identity_receipt'?{rowCount:0,rows:[]}:{...result,rows:result.rows.map(row=>({...row,canonical_utf8:'{}'}))};
      }
      if(config.text.includes('neighborhood-frozen-job-closure:parcels')||config.text.includes('neighborhood-frozen-stock-originals:page')
        ||config.text.includes('neighborhood-frozen-job-identity:parcels')||config.text.includes('shared-v2-stock-metrics:page')
        ||config.text===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL||config.text===NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL
        ||config.text===NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL){
        // The ending-header fault is consumed by the later second metadata
        // read, not by the page query. Keep it armed like the COMMIT fault.
        const fault=refsFault;if(!['commit','cad_header','transaction_header'].includes(fault))refsFault=null;
        if(fault==='license')await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
        if(fault==='role')await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);
        if(fault==='subject')await client.query("UPDATE app.appraisal_subject_snapshots SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1",[sourceSnapshot]);
        if(fault==='claim')await client.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET claim_token=$1 WHERE operation_id=$2',[randomUUID(),refsOperation]);
        if(fault==='cancel')refsAbort.abort();
        if(fault==='cad_license')await setCadFixtureGrant(pool,organization,{...cadGrant,revoked_at:cadGrant.valid_from});
        if(fault==='cad_expiry')await setCadFixtureGrant(pool,organization,{...cadGrant,expires_at:cadGrant.valid_from});
        if(fault==='cad_revision')await setCadFixtureGrant(pool,organization,{...cadGrant,rights_basis:{...cadGrant.rights_basis,basis_reference:'changed-synthetic-only-basis'}});
      }
      if(config.text===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read&&++cadHeaderReads===2&&refsFault==='cad_header'){
        refsFault=null;return {...result,rows:result.rows.map(row=>({...row,status:'building'}))};
      }
      if(config.text===NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read&&++transactionHeaderReads===2&&refsFault==='transaction_header'){
        refsFault=null;return {...result,rows:result.rows.map(row=>({...row,status:'building'}))};
      }
      if(config.text==='COMMIT'&&refsFault==='commit'){refsFault=null;throw Error('synthetic V2 owner COMMIT acknowledgment lost');}
      return result;}};}};
    const refsOwner=createCustomCohortContextCapture({pool:refsPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    const refsOptions={captureJobClaim:refsClaim};
    const cadClock=(await pool.query(`WITH t AS (SELECT clock_timestamp() AS now) SELECT
      to_char((now-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
      to_char((now+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS future FROM t`)).rows[0];
    const cadGrant={...fixtureGrant(organization),grant_id:'synthetic-CAD-companion-only',purpose_scope:CAD_PURPOSE,
      dataset:{...fixtureGrant(organization).dataset,id:CAD_DATASET},valid_from:cadClock.past,expires_at:cadClock.future,
      rights_basis:{...fixtureGrant(organization).rights_basis,approved_at:cadClock.past}};
    await setCadFixtureGrant(pool,organization,cadGrant);
    const cadOwner=()=>createCustomCohortContextCapture({pool:refsPool,sourceMode:'combined-witness2-v1',
      authorizeMarketData:fixturePolicy(),authorizeCadImprovementData:fixtureCadPolicy()});
    const cadOwnerMethod='readSharedFrozenCaptureJobCadImprovementsReferencesV2',cadOwnerOptions={...refsOptions,
      cadImprovementPage:{kind:'primary',cursor:{account_id:'',row_key:''},rowLimit:1}};
    const cadAccountMethod='readSharedFrozenCaptureJobCadAccountsReferencesV2',cadAccountOptions={...refsOptions,
      cadAccountPage:{cursor:'',rowLimit:250}};
    const transactionMethod='readSharedFrozenCaptureJobTransactionsReferencesV2',transactionOptions={...refsOptions,
      transactionPage:{kind:'source_records',cursor:'',rowLimit:1}};
    await refsOwner.prepareFrozenCaptureJobStock(refsInput,refsOptions);
    const readRefsCheckpoint=async()=>(await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[refsOperation])).rows[0].checkpoint;
    const refsStockCheckpoint=await readRefsCheckpoint();
    assert.equal(refsStockCheckpoint.phase,'frozen_stock_v1');
    const refsBlobCount=async()=>(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[organization])).rows[0].n;
    const refsSeedsCount=async()=>(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_custom_cohort_seed_indexes WHERE operation_id=$1',[refsOperation])).rows[0].n;
    const beforeRefsBlobs=await refsBlobCount();
    const refsDeniedFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions),/market_data_access_denied/);
    assert.ok(!refsCalls.slice(refsDeniedFrom).some(sql=>/neighborhood-frozen-job-closure:|neighborhood-frozen-job-seeds:/.test(sql)),
      'initial denied rights do not query licensed originals or prepare seeds');
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const roleDeniedFrom=refsCalls.length;
    await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);
    await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions),/job_actor_access_revoked/);
    assert.ok(!refsCalls.slice(roleDeniedFrom).some(sql=>/neighborhood-cohort-blob:|neighborhood-frozen-job-closure:|neighborhood-frozen-job-seeds:/.test(sql)));
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/]]){
      refsFault=fault;refsAbort=new AbortController();
      await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,
        {...refsOptions,signal:refsAbort.signal}),reason);
      assert.equal(refsFault,null,'the actual original page was reached before the ending refusal');
      assert.deepEqual(await readRefsCheckpoint(),refsStockCheckpoint,`${fault} rolls back the root/checkpoint`);
      assert.equal(await refsSeedsCount(),0,`${fault} rolls back first seed preparation`);
      assert.equal(await refsBlobCount(),beforeRefsBlobs,`${fault} retains no new prefix metadata blobs`);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsBlobPuts.length=0;const refsCommitFrom=refsCalls.length;
    refsFault='commit';
    await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions),error=>error.outcome_unknown===true);
    const refsCommitted=await readRefsCheckpoint();
    assert.equal(refsCommitted.phase,'frozen_source_refs_v2');assert.equal(refsCommitted.evidence_refs.length,3);
    const freshRefsOwner=()=>createCustomCohortContextCapture({pool:refsPool,sourceMode:'combined-witness2-v1',authorizeMarketData:fixturePolicy()});
    let refsPrefix=await freshRefsOwner().prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions);
    assert.equal(refsPrefix.layers.parcels.page_count,1,'lost real COMMIT ACK resumes at the next unfinished layer');
    assert.equal(refsPrefix.layers.accounts.page_count,1);
    for(let i=0;i<10&&!refsPrefix.all_layers_ended;i++)refsPrefix=await freshRefsOwner().prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions);
    assert.equal(refsPrefix.all_layers_ended,true);assert.equal(refsPrefix.status,'source_reference_prefix_retained');
    assert.equal(refsPrefix.original_graph_verification,'not_established');assert.equal(refsPrefix.source_acquisition,'not_established');
    assert.equal(refsPrefix.report_update,'none');
    assert.deepEqual(Object.fromEntries(Object.entries(refsPrefix.layers).map(([kind,l])=>[kind,l.row_count])),
      Object.fromEntries(Object.entries(expected).map(([kind,keys])=>[kind,keys.length])));
    const refsCommittedCalls=refsCalls.slice(refsCommitFrom);
    assert.equal(refsCommittedCalls.filter(sql=>sql.includes('neighborhood-frozen-job-seeds:rows')).length,1,
      'fresh owner/lost-ACK continuation reuses exactly one committed seed cache');
    assert.equal(refsCommittedCalls.filter(sql=>sql.includes('neighborhood-frozen-job-closure:parcels')).length,1);
    assert.ok(!refsCommittedCalls.some(sql=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(sql)));
    assert.equal(refsBlobPuts.length,22,'empty root plus seven node/root/checkpoint triples; no payload/chunk puts');
    assert.ok(refsBlobPuts.every(text=>Buffer.byteLength(text)<16_000&&!text.includes('payload_text')&&!text.includes('cohort_original_text_chunks')));
    const refsEndedCheckpoint=await readRefsCheckpoint();
    const endedFrom=refsCalls.length,endedBlobs=await refsBlobCount();
    assert.equal((await freshRefsOwner().prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions)).advanced,false);
    assert.deepEqual(await readRefsCheckpoint(),refsEndedCheckpoint);assert.equal(await refsBlobCount(),endedBlobs);
    assert.ok(!refsCalls.slice(endedFrom).some(sql=>/neighborhood-frozen-job-closure:|neighborhood-frozen-job-seeds:/.test(sql)),
      'ended prefix replay reads no source page and prepares no seed set');
    for(const method of ['prepareFrozenCaptureJobSourcePage','verifyFrozenCaptureJobSourcePage',
      'verifyFrozenCaptureJobStockOriginals','verifyFrozenCaptureJobSourceIdentityClosure','prepareFrozenCaptureJobTypedOriginals']){
      const from=refsCalls.length;
      await assert.rejects(refsOwner[method](refsInput,refsOptions),/checkpoint_conflict/);
      assert.ok(!refsCalls.slice(from).some(sql=>/neighborhood-cohort-blob:|neighborhood-frozen-job-closure:/.test(sql)),
        `${method} refuses a V2 phase before reading originals`);
    }
    await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,ownedCheckpoint);
    // A changed source version or same-binding V1 root is not a V2 checkpoint.
    const refsHeader=await withCustomCohortJobTransaction(pool,async client=>{
      const r=refsEndedCheckpoint.evidence_refs[2];return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization).get(r.content_sha256,r.canonical_utf8_bytes));});
    // The stock definition hash includes the operation ID. Rebinding a V1
    // job's dictionary by changing only operation_id is intentionally invalid;
    // use THIS V2 owner's exact frozen source header for every native replay.
    const refsBinding={...scope,operation_id:refsOperation,generation_id:refsHeader.selection.generation_id,
      spatial_definition_sha256:refsHeader.selection.spatial_definition_sha256,
      source_original_sha256:refsHeader.selection.source_original_sha256};
    for(const corrupt of ['version','root']){
      const wrong=await withCustomCohortJobTransaction(pool,async client=>{
        const blobs=createNeighborhoodCohortBlobRepository(client,organization),header={...refsHeader};
        if(corrupt==='version')header.source_stage_version=1;
        else header.root=(await createCohortOriginalSourceChainV1Store(blobs,refsBinding).create()).root;
        const r=await blobs.put(canonicalAssessmentJson(header));
        return createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,
          {phase:'frozen_source_refs_v2',evidence_refs:[...refsEndedCheckpoint.evidence_refs.slice(0,2),r]});});
      const from=refsCalls.length;
      await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions),
        corrupt==='version'?/market_policy_changed/:/binding_changed/);
      assert.deepEqual(await readRefsCheckpoint(),wrong);
      assert.ok(!refsCalls.slice(from).some(sql=>/neighborhood-frozen-job-closure:|neighborhood-frozen-job-seeds:/.test(sql)));
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,refsEndedCheckpoint));
    }
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    const endedDeniedFrom=refsCalls.length;
    await assert.rejects(refsOwner.prepareFrozenCaptureJobSourceReferencesV2Page(refsInput,refsOptions),/market_data_access_denied/);
    assert.deepEqual(await readRefsCheckpoint(),refsEndedCheckpoint);
    assert.ok(!refsCalls.slice(endedDeniedFrom).some(sql=>/neighborhood-frozen-job-closure:|neighborhood-frozen-job-seeds:/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    await withCustomCohortJobTransaction(pool,async client=>{
      assert.equal((await createCustomCohortCaptureJobRepository(client).readPreparedGeneration(refsClaim,options)).generation_id,frozen.generationId);
    });
    console.log('[native-reference-prefix-owner-v2]',{layers:7,metadata_puts:refsBlobPuts.length,
      original_payload_copies:0,initial_rights_refused:true,ending_rights_claim_subject_cancel_rollback:true,
      lost_commit_next_layer:true,legacy_cast_refused:true,generation_pin_retained:true,
      graph_verification:false,source_acquisition:false,production_latency:false});
    // A separate complete V2 root with one-row pages gives this small native
    // fixture real NON-head edges. Every descriptor comes from the fixed exact
    // original SQL; no payload is copied and no real report is modified.
    const refsGraphStock=await withCustomCohortJobTransaction(pool,async client=>{
      const r=refsEndedCheckpoint.evidence_refs[1];return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization)
        .get(r.content_sha256,r.canonical_utf8_bytes));});
    const refsGraphOptions={...options,claim:refsClaim,geometryInput:refsGraphStock.stock.definition.geometry_input,
      discovery,subjectIntent:refsGraphStock.subject_intent,checkBudget(){}};
    const refsGraphStore=client=>{
      const blobs=createNeighborhoodCohortBlobRepository(client,organization);
      return createCohortOriginalSourceReferencesV2Store({put:text=>blobs.put(text),get:(hash,size)=>blobs.get(hash,size)},refsBinding,{
        async readOriginal(request){const page=await createNeighborhoodFrozenJobSourcePages(client,refsGraphOptions)
          .page({kind:request.kind,cursor:request.after,rowLimit:request.row_limit});return JSON.stringify({binding:refsBinding,page});}});
    };
    let refsGraphRoot=(await withCustomCohortJobTransaction(pool,client=>refsGraphStore(client).create())).root;
    for(const kind of Object.keys(expected)){
      let cursor='',done=false;
      while(!done){
        const page=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobSourcePages(client,refsGraphOptions)
          .page({kind,cursor,rowLimit:1}));
        assert.equal(page.spatial_definition_sha256,refsBinding.spatial_definition_sha256);
        assert.equal(createHash('sha256').update(canonicalAssessmentJson(page.original)).digest('hex'),refsBinding.source_original_sha256);
        refsGraphRoot=(await withCustomCohortJobTransaction(pool,client=>refsGraphStore(client).append({root:refsGraphRoot,
          original_text:JSON.stringify({binding:refsBinding,page}),row_limit:1}))).root;
        cursor=page.next_cursor;done=page.end_of_layer;
      }
    }
    const refsGraphCheckpoint=await withCustomCohortJobTransaction(pool,async client=>{
      const r=await createNeighborhoodCohortBlobRepository(client,organization).put(canonicalAssessmentJson({...refsHeader,root:refsGraphRoot}));
      return createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,
        {phase:'frozen_source_refs_v2',evidence_refs:[...refsEndedCheckpoint.evidence_refs.slice(0,2),r]});});
    const readRefsAnchor=async()=>{
      const rows=(await pool.query('SELECT source_reference,root_reference,receipt_reference,sequence FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=$1',[refsOperation])).rows;
      return rows[0]??null;};
    const graphMethod='verifyFrozenCaptureJobSourceReferencesV2Page';
    const graphDeniedFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(refsOwner[graphMethod](refsInput,refsOptions),/market_data_access_denied/);
    assert.equal(await readRefsAnchor(),null);
    assert.ok(!refsCalls.slice(graphDeniedFrom).some(sql=>/neighborhood-frozen-job-closure:|custom-cohort-graph-v2:anchor-/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const graphRoleFrom=refsCalls.length;
    await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);
    await assert.rejects(refsOwner[graphMethod](refsInput,refsOptions),/job_actor_access_revoked/);
    assert.ok(!refsCalls.slice(graphRoleFrom).some(sql=>/neighborhood-cohort-blob:|neighborhood-frozen-job-closure:|custom-cohort-graph-v2:/.test(sql)));
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    const graphBeforeBlobs=await refsBlobCount();
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/]]){
      refsFault=fault;refsAbort=new AbortController();
      await assert.rejects(refsOwner[graphMethod](refsInput,{...refsOptions,signal:refsAbort.signal}),reason);
      assert.equal(refsFault,null,'independent original SQL read was actually reached');
      assert.deepEqual(await readRefsCheckpoint(),refsGraphCheckpoint);assert.equal(await readRefsAnchor(),null);
      assert.equal(await refsBlobCount(),graphBeforeBlobs,`${fault} rolls back receipt, independent anchor and checkpoint`);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    const graphFrom=refsCalls.length;refsBlobPuts.length=0;refsFault='commit';
    await assert.rejects(refsOwner[graphMethod](refsInput,refsOptions),error=>error.outcome_unknown===true);
    const graphFirstCheckpoint=await readRefsCheckpoint(),graphFirstAnchor=await readRefsAnchor();
    assert.equal(graphFirstCheckpoint.phase,'frozen_verify_refs_v2');assert.equal(graphFirstAnchor.sequence,1);
    assert.deepEqual(graphFirstCheckpoint.evidence_refs[3],graphFirstAnchor.receipt_reference);
    const unfinishedV2GeoFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner().verifyFrozenCaptureJobStockOriginalReferencesV2(refsInput,refsOptions),/unfinished_graph_verification/);
    assert.deepEqual(await readRefsCheckpoint(),graphFirstCheckpoint);
    assert.ok(!refsCalls.slice(unfinishedV2GeoFrom).some(sql=>/stock-originals:|custom-cohort-geographic-v2:/.test(sql)));
    const graphFirstReceipt=await withCustomCohortJobTransaction(pool,async client=>{
      const r=graphFirstAnchor.receipt_reference;return JSON.parse(await createNeighborhoodCohortBlobRepository(client,organization)
        .get(r.content_sha256,r.canonical_utf8_bytes));});
    assert.equal(graphFirstReceipt.before.position,null);assert.equal(graphFirstReceipt.after.position.index,2);
    // Same binding, real original query, legal index/cursor/count shape, but a
    // detached index-zero branch with TWO rows rather than the root's ONE.
    // The bare codec can read DATA from it; it is not an owner-issued path.
    const detached=await withCustomCohortJobTransaction(pool,async client=>{
      const store=refsGraphStore(client),page=await createNeighborhoodFrozenJobSourcePages(client,refsGraphOptions)
        .page({kind:'parcels',cursor:'',rowLimit:2});
      assert.equal(page.end_of_layer,false);
      const branch=(await store.append({root:(await store.create()).root,original_text:JSON.stringify({binding:refsBinding,page}),row_limit:2})).root;
      const layer=(await store.describe(branch)).layers.parcels;
      const position={node:layer.head,index:0,next_cursor:layer.cursor};
      assert.equal(JSON.parse((await store.read({root:refsGraphRoot,kind:'parcels',position})).original_text).page.rows.length,2);
      return position;
    });
    const unissuedReceipt={...graphFirstReceipt,sequence:2,previous:graphFirstAnchor.receipt_reference,
      before:graphFirstReceipt.after,consumed_node:detached.node,next_position:null,
      after:{kind_index:1,position:null,page_count:0,row_count:0,original_utf8_bytes:0}};
    const unissuedReference=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodCohortBlobRepository(client,organization)
      .put(canonicalAssessmentJson(unissuedReceipt)));
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortGraphV2AnchorRepository({client,claim:refsClaim,
      scope,actorUserId:actor,source_reference:refsGraphCheckpoint.evidence_refs[2],root_reference:refsGraphRoot})
      .advance(graphFirstAnchor,unissuedReference)),error=>error.code==='55000'&&/anchor_detached_node/.test(error.message));
    assert.deepEqual(await readRefsAnchor(),graphFirstAnchor,'SQL guard refuses a detached owner-head replacement');
    // Harder same-index/same-cursor case from cybersecurity review. Copy the
    // EXACT expected non-head descriptor and change ONLY its previous ref to a
    // distinct same-binding branch. Its current original/digest/bounds/counts
    // and returned next index/cursor are otherwise correct. Simpler index or
    // count checks alone cannot reject this first detached step.
    const samePositionForgery=await withCustomCohortJobTransaction(pool,async client=>{
      const blobs=createNeighborhoodCohortBlobRepository(client,organization),store=refsGraphStore(client);
      const expectedPosition=graphFirstReceipt.after.position;
      const expectedStep=await store.read({root:refsGraphRoot,kind:'parcels',position:expectedPosition});
      const readNode=async r=>JSON.parse(await blobs.get(r.content_sha256,r.canonical_utf8_bytes));
      const expectedNode=await readNode(expectedPosition.node),previousNode=await readNode(expectedNode.previous);
      const forkPrevious=await blobs.put(canonicalAssessmentJson({...previousNode,previous:detached.node}));
      const forkNode=await blobs.put(canonicalAssessmentJson({...expectedNode,previous:forkPrevious}));
      const forgedPosition={...expectedPosition,node:forkNode};
      const bare=await store.read({root:refsGraphRoot,kind:'parcels',position:forgedPosition});
      assert.equal(bare.index,expectedStep.index);assert.equal(bare.original_text,expectedStep.original_text);
      assert.equal(bare.next_position.index,expectedStep.next_position.index);
      assert.equal(bare.next_position.next_cursor,expectedStep.next_position.next_cursor);
      assert.notDeepEqual(bare.next_position.node,expectedStep.next_position.node);
      const before=graphFirstReceipt.after,after={...before,position:bare.next_position,
        page_count:before.page_count+1,row_count:before.row_count+JSON.parse(bare.original_text).page.rows.length,
        original_utf8_bytes:before.original_utf8_bytes+Buffer.byteLength(bare.original_text)};
      const receipt={...unissuedReceipt,before,consumed_node:forkNode,next_position:bare.next_position,after};
      return blobs.put(canonicalAssessmentJson(receipt));
    });
    await assert.rejects(withCustomCohortJobTransaction(pool,client=>createCustomCohortGraphV2AnchorRepository({client,claim:refsClaim,
      scope,actorUserId:actor,source_reference:refsGraphCheckpoint.evidence_refs[2],root_reference:refsGraphRoot})
      .advance(graphFirstAnchor,samePositionForgery)),error=>error.code==='55000'&&/anchor_detached_node/.test(error.message),
      'same index/cursor/digest/count transition is refused because its node is NOT the issued next node');
    assert.deepEqual(await readRefsAnchor(),graphFirstAnchor);
    for(const wrong of [unissuedReference,samePositionForgery,{content_sha256:'0'.repeat(64),canonical_utf8_bytes:'123'}]){
      const swapped={...graphFirstCheckpoint,evidence_refs:[...graphFirstCheckpoint.evidence_refs.slice(0,3),wrong]};
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,swapped));
      const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[graphMethod](refsInput,refsOptions),/checkpoint_conflict/);
      assert.ok(!refsCalls.slice(from).some(sql=>sql.includes('neighborhood-frozen-job-closure:')),
        'unissued/missing checkpoint receipt is refused before any licensed original query');
      assert.deepEqual(await readRefsAnchor(),graphFirstAnchor);
    }
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,graphFirstCheckpoint));
    for(const fault of ['missing_receipt','corrupt_receipt']){
      refsFault=fault;const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[graphMethod](refsInput,refsOptions),/checkpoint_conflict|storage_conflict/);
      assert.equal(refsFault,null);assert.deepEqual(await readRefsAnchor(),graphFirstAnchor);
      assert.deepEqual(await readRefsCheckpoint(),graphFirstCheckpoint);
      assert.ok(!refsCalls.slice(from).some(sql=>sql.includes('neighborhood-frozen-job-closure:')));
    }
    // Another valid same-binding completed source/root cannot replace the
    // frozen source after issuance, even when checkpoint JSON is rewritten.
    const graphSwappedSource={...graphFirstCheckpoint,evidence_refs:[...graphFirstCheckpoint.evidence_refs]};
    graphSwappedSource.evidence_refs[2]=refsEndedCheckpoint.evidence_refs[2];
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,graphSwappedSource));
    const graphSourceSwapFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[graphMethod](refsInput,refsOptions),/anchor_binding_changed/);
    assert.ok(!refsCalls.slice(graphSourceSwapFrom).some(sql=>sql.includes('neighborhood-frozen-job-closure:')));
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,graphFirstCheckpoint));
    let graphV2=await freshRefsOwner()[graphMethod](refsInput,refsOptions);
    assert.equal((await readRefsAnchor()).sequence,2,'lost real COMMIT ACK resumes the issued next edge');
    for(let i=0;i<30&&!graphV2.all_layers_verified;i++)graphV2=await freshRefsOwner()[graphMethod](refsInput,refsOptions);
    assert.equal(graphV2.all_layers_verified,true);assert.equal(graphV2.original_graph_verification,'representation_verified');
    assert.equal(graphV2.source_acquisition,'not_established');assert.equal(graphV2.geographic_stock_verification,'not_established');
    assert.equal(graphV2.report_update,'none');
    const finalAnchor=await readRefsAnchor(),finalCheckpoint=await readRefsCheckpoint();
    const refsGraphLayers=(await withCustomCohortJobTransaction(pool,client=>refsGraphStore(client).describe(refsGraphRoot))).layers;
    const graphPages=Object.values(refsGraphLayers).reduce((n,l)=>n+l.page_count,0);
    assert.equal(finalAnchor.sequence,graphPages);
    assert.equal(refsCalls.slice(graphFrom).filter(sql=>sql.includes('neighborhood-frozen-job-closure:')).length,graphPages,
      'one independently reproduced original query per issued step, not quadratic head replay');
    assert.equal(refsBlobPuts.length,graphPages,'only one small transition receipt is retained per graph step');
    assert.ok(refsBlobPuts.every(text=>Buffer.byteLength(text)<4000&&!text.includes('payload_text')));
    const graphEndedFrom=refsCalls.length;
    assert.equal((await freshRefsOwner()[graphMethod](refsInput,refsOptions)).advanced,false);
    assert.deepEqual(await readRefsAnchor(),finalAnchor);assert.deepEqual(await readRefsCheckpoint(),finalCheckpoint);
    assert.ok(!refsCalls.slice(graphEndedFrom).some(sql=>/neighborhood-frozen-job-closure:|anchor-insert|anchor-advance|checkpoint-save/.test(sql)));
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[graphMethod](refsInput,refsOptions),/market_data_access_denied/);
    assert.deepEqual(await readRefsAnchor(),finalAnchor);assert.deepEqual(await readRefsCheckpoint(),finalCheckpoint);
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    for(const sql of ['UPDATE app.neighborhood_custom_cohort_graph_v2_anchors SET sequence=sequence-1 WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=$1'])
      await assert.rejects(pool.query(sql,[refsOperation]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_custom_cohort_graph_v2_anchors'),error=>error.code==='55000');
    for(const method of ['prepareFrozenCaptureJobSourceReferencesV2Page','verifyFrozenCaptureJobSourcePage',
      'verifyFrozenCaptureJobStockOriginals','verifyFrozenCaptureJobSourceIdentityClosure'])
      await assert.rejects(freshRefsOwner()[method](refsInput,refsOptions),/checkpoint_conflict/);
    await assert.rejects(freshRefsOwner()[graphMethod](sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,ownedCheckpoint);
    await withCustomCohortJobTransaction(pool,async client=>assert.equal((await createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(refsClaim,options)).generation_id,frozen.generationId));
    console.log('[native-reference-graph-owner-v2]',{layers:7,pages:graphPages,metadata_puts:refsBlobPuts.length,
      original_payload_copies:0,independent_issued_head:true,detached_bare_data_read:true,detached_head_refused:true,
      same_index_cursor_digest_counts_detached_refused:true,
      unissued_checkpoint_refused_before_original:true,both_end_rights_rollback:true,lost_commit_next_edge:true,
      exact_layer_counts:true,ended_replay_no_original:true,legacy_cast_refused:true,generation_pin_retained:true,
      source_acquisition:false,production_latency:false});
    // Actual V2 geographic owner starts only from the independently issued
    // complete graph, retains NULL-account stock, excludes outside account
    // parts, and does not treat an inserted done blob as an issued receipt.
    const geoV2Method='verifyFrozenCaptureJobStockOriginalReferencesV2';
    const readGeoAnchor=async()=>((await pool.query('SELECT source_reference,root_reference,graph_reference,stock_reference,receipt_reference,sequence FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=$1',[refsOperation])).rows[0]??null);
    const geoRepository=client=>createCustomCohortGeographicV2AnchorRepository({client,claim:refsClaim,scope,actorUserId:actor,
      source_reference:finalCheckpoint.evidence_refs[2],root_reference:refsGraphRoot,
      graph_reference:finalCheckpoint.evidence_refs[3],stock_reference:finalCheckpoint.evidence_refs[1]});
    const geoZero={format:'frozen_job_stock_original_progress_v1',
      stock_sha256:createHash('sha256').update(canonicalAssessmentJson(refsGraphStock.stock)).digest('hex'),
      after_object_id:null,verified_parcels:0,verified_unassociated:0,done:false};
    const geoTemplate={format:'cohort_geographic_original_receipt_v2',binding:refsBinding,
      source_reference:finalCheckpoint.evidence_refs[2],root:refsGraphRoot,
      graph_verification_reference:finalCheckpoint.evidence_refs[3],stock_reference:finalCheckpoint.evidence_refs[1],
      sequence:1,previous:null,before:geoZero,after:{...geoZero,after_object_id:'5',verified_parcels:3,verified_unassociated:1,done:true}};
    const retainGeo=body=>withCustomCohortJobTransaction(pool,client=>createNeighborhoodCohortBlobRepository(client,organization).put(canonicalAssessmentJson(body)));
    for(const after of [{...geoTemplate.after,verified_parcels:1},
      {...geoTemplate.after,verified_unassociated:0},{...geoTemplate.after,done:false}]){
      const wrong=await retainGeo({...geoTemplate,after});
      await assert.rejects(withCustomCohortJobTransaction(pool,client=>geoRepository(client).advance(null,wrong)),
        error=>error.code==='55000'&&/geo_v2_anchor_prefix_conflict|geo_v2_anchor_count_conflict/.test(error.message));
      assert.equal(await readGeoAnchor(),null);
    }
    // Guard-only metadata experiment in a rolled-back disposable transaction:
    // exact short next-prefix succeeds without requiring 250 rows. This is NOT
    // an original-geometry/source-rights verification claim.
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      const body={...geoTemplate,after:{...geoZero,after_object_id:'1',verified_parcels:1}};
      const r=await createNeighborhoodCohortBlobRepository(client,organization).put(canonicalAssessmentJson(body));
      assert.equal((await geoRepository(client).advance(null,r)).sequence,1);
      throw Error('synthetic short-prefix guard rollback');
    }),/synthetic short-prefix guard rollback/);
    assert.equal(await readGeoAnchor(),null);assert.deepEqual(await readRefsCheckpoint(),finalCheckpoint);
    const forgedGeo=await retainGeo({...geoTemplate,after:{...geoTemplate.after,verified_unassociated:0}});
    const unissuedGeoCheckpoint={phase:'frozen_geo_verify_refs_v2',evidence_refs:[...finalCheckpoint.evidence_refs,forgedGeo]};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,unissuedGeoCheckpoint));
    const unissuedGeoFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/checkpoint_conflict/);
    await assert.rejects(freshRefsOwner().verifyFrozenCaptureJobSourceIdentityReferencesV2(refsInput,refsOptions),/checkpoint_conflict/);
    assert.ok(!refsCalls.slice(unissuedGeoFrom).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,finalCheckpoint));
    const initialGeoDenied=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/market_data_access_denied/);
    assert.ok(!refsCalls.slice(initialGeoDenied).some(sql=>/stock-originals:|custom-cohort-geographic-v2:/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    const initialGeoRoleDenied=refsCalls.length;
    await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);
    await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/job_actor_access_revoked/);
    assert.ok(!refsCalls.slice(initialGeoRoleDenied).some(sql=>/stock-originals:|neighborhood-cohort-blob:|custom-cohort-geographic-v2:/.test(sql)));
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    const geoBeforeBlobs=await refsBlobCount();
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/]]){
      refsFault=fault;refsAbort=new AbortController();
      await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,{...refsOptions,signal:refsAbort.signal}),reason);
      assert.equal(refsFault,null,'actual geographic-original SQL ran before ending refusal');
      assert.equal(await readGeoAnchor(),null);assert.deepEqual(await readRefsCheckpoint(),finalCheckpoint);
      assert.deepEqual(await readRefsAnchor(),finalAnchor);assert.equal(await refsBlobCount(),geoBeforeBlobs);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsBlobPuts.length=0;const geoCommitFrom=refsCalls.length;refsFault='commit';
    await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),error=>error.outcome_unknown===true);
    const geoCommitted=await readRefsCheckpoint(),geoIssued=await readGeoAnchor();
    assert.equal(geoCommitted.phase,'frozen_geo_verify_refs_v2');assert.equal(geoIssued.sequence,1);
    assert.deepEqual(geoCommitted.evidence_refs[4],geoIssued.receipt_reference);
    assert.equal(refsBlobPuts.length,1);assert.ok(Buffer.byteLength(refsBlobPuts[0])<4000&&!refsBlobPuts[0].includes('stored_geometry_ewkb'));
    const geoEndedFrom=refsCalls.length,geoReplay=await freshRefsOwner()[geoV2Method](refsInput,refsOptions);
    assert.equal(geoReplay.advanced,false);assert.equal(geoReplay.all_parcels_verified,true);
    assert.equal(geoReplay.verified_parcels,3);assert.equal(geoReplay.verified_unassociated,1);
    assert.equal(geoReplay.source_acquisition,'not_established');assert.equal(geoReplay.typed_identity_closure,'not_established');
    assert.equal(geoReplay.report_update,'none');assert.deepEqual(await readGeoAnchor(),geoIssued);
    assert.ok(!refsCalls.slice(geoEndedFrom).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:|anchor-insert|anchor-advance|checkpoint-save/.test(sql)));
    assert.equal(refsCalls.slice(geoCommitFrom).filter(sql=>sql.includes('neighborhood-frozen-stock-originals:page')).length,1);
    for(const fault of ['missing_geo_receipt','corrupt_geo_receipt']){
      refsFault=fault;const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/checkpoint_conflict|storage_conflict|invalid_receipt/);
      assert.equal(refsFault,null);assert.deepEqual(await readRefsCheckpoint(),geoCommitted);assert.deepEqual(await readGeoAnchor(),geoIssued);
      assert.ok(!refsCalls.slice(from).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    }
    for(const wrong of [forgedGeo,{content_sha256:'0'.repeat(64),canonical_utf8_bytes:'123'}]){
      const swapped={...geoCommitted,evidence_refs:[...geoCommitted.evidence_refs.slice(0,4),wrong]};
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,swapped));
      const from=refsCalls.length;await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/checkpoint_conflict/);
      assert.ok(!refsCalls.slice(from).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    }
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,geoCommitted));
    for(const [index,replacement] of [[1,ownedCheckpoint.evidence_refs[1]],
      [2,refsEndedCheckpoint.evidence_refs[2]],[3,graphFirstCheckpoint.evidence_refs[3]]]){
      const swapped={...geoCommitted,evidence_refs:[...geoCommitted.evidence_refs]};swapped.evidence_refs[index]=replacement;
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,swapped));
      const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/checkpoint_conflict|anchor_binding_changed/);
      assert.ok(!refsCalls.slice(from).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
      assert.deepEqual(await readGeoAnchor(),geoIssued);
    }
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,geoCommitted));
    const geoEndedDeniedFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[geoV2Method](refsInput,refsOptions),/market_data_access_denied/);
    assert.deepEqual(await readRefsCheckpoint(),geoCommitted);assert.deepEqual(await readGeoAnchor(),geoIssued);
    assert.ok(!refsCalls.slice(geoEndedDeniedFrom).some(sql=>/stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    for(const sql of ['UPDATE app.neighborhood_custom_cohort_geo_v2_anchors SET sequence=sequence-1 WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=$1'])
      await assert.rejects(pool.query(sql,[refsOperation]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_custom_cohort_geo_v2_anchors'),error=>error.code==='55000');
    for(const method of ['verifyFrozenCaptureJobSourceReferencesV2Page','verifyFrozenCaptureJobStockOriginals','verifyFrozenCaptureJobSourceIdentityClosure'])
      await assert.rejects(freshRefsOwner()[method](refsInput,refsOptions),/checkpoint_conflict/);
    await assert.rejects(freshRefsOwner()[geoV2Method](sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,ownedCheckpoint);
    await withCustomCohortJobTransaction(pool,async client=>assert.equal((await createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(refsClaim,options)).generation_id,frozen.generationId));
    console.log('[native-reference-geographic-owner-v2]',{parcels:3,unassociated:1,metadata_puts:1,original_payload_copies:0,
      completed_issued_graph_required:true,independent_geographic_head:true,unissued_done_refused_before_original:true,
      next_prefix_and_null_counts_guarded:true,short_prefix_guard_only_rollback:true,both_end_rights_rollback:true,
      lost_commit_resumes_issued_done:true,ended_replay_no_original:true,legacy_cast_refused:true,generation_pin_retained:true,
      source_acquisition:false,production_latency:false});
    // Distinct actual identity owner, with independent graph AND geographic
    // prerequisites. Small real-native protocol fixture, not licensed scale QA.
    {
    const identityV2Method='verifyFrozenCaptureJobSourceIdentityReferencesV2';
    const metricV2Method='readSharedFrozenCaptureJobStockMetricsReferencesV2';
    const metricV2Options={...refsOptions,stockMetricPage:{cursor:'',rowLimit:1}};
    const readIdentityAnchor=async()=>((await pool.query('SELECT source_reference,root_reference,graph_reference,geographic_reference,stock_reference,receipt_reference,sequence FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=$1',[refsOperation])).rows[0]??null);
    const identityRepository=client=>createCustomCohortIdentityV2AnchorRepository({client,claim:refsClaim,scope,actorUserId:actor,
      source_reference:geoCommitted.evidence_refs[2],root_reference:refsGraphRoot,
      graph_reference:geoCommitted.evidence_refs[3],geographic_reference:geoCommitted.evidence_refs[4],stock_reference:geoCommitted.evidence_refs[1]});
    const identityCounts=Object.fromEntries(Object.entries(expected).map(([kind,keys])=>[kind,keys.length]));
    const identityGraphDigest=createHash('sha256').update(canonicalAssessmentJson({root:refsGraphRoot,layer_counts:identityCounts})).digest('hex');
    const identityZero={format:'frozen_job_source_identity_progress_v1',
      binding_sha256:createHash('sha256').update(canonicalAssessmentJson({stock:refsGraphStock.stock,graph_sha256:identityGraphDigest})).digest('hex'),
      kind_index:0,after:'',layer_rows:0,unknown_parcel_origins:0,missing_account_count:null};
    const identityTemplate={format:'cohort_source_identity_receipt_v2',binding:refsBinding,
      source_reference:geoCommitted.evidence_refs[2],root:refsGraphRoot,graph_verification_reference:geoCommitted.evidence_refs[3],
      stock_verification_reference:geoCommitted.evidence_refs[4],stock_reference:geoCommitted.evidence_refs[1],
      layer_counts:identityCounts,stock_account_count:'2',sequence:1,previous:null,before:identityZero,
      after:{...identityZero,kind_index:1,unknown_parcel_origins:3}};
    for(const after of [{...identityZero,after:'2',layer_rows:1,unknown_parcel_origins:1},
      {...identityTemplate.after,unknown_parcel_origins:2},{...identityTemplate.after,kind_index:7,missing_account_count:0}]){
      const wrong=await retainGeo({...identityTemplate,after});
      await assert.rejects(withCustomCohortJobTransaction(pool,client=>identityRepository(client).advance(null,wrong)),
        error=>error.code==='55000'&&/identity_v2_anchor_(prefix|count|transition)_conflict/.test(error.message));
      assert.equal(await readIdentityAnchor(),null);
    }
    // A short next native-key prefix is valid DATA under byte admission, but
    // this rolled-back guard-only experiment makes no original-read claim.
    await assert.rejects(withCustomCohortJobTransaction(pool,async client=>{
      const r=await createNeighborhoodCohortBlobRepository(client,organization).put(canonicalAssessmentJson({...identityTemplate,
        after:{...identityZero,after:'1',layer_rows:1,unknown_parcel_origins:1}}));
      assert.equal((await identityRepository(client).advance(null,r)).sequence,1);
      throw Error('synthetic identity short-prefix guard rollback');
    }),/synthetic identity short-prefix guard rollback/);
    assert.equal(await readIdentityAnchor(),null);assert.deepEqual(await readRefsCheckpoint(),geoCommitted);
    const forgedIdentity=await retainGeo({...identityTemplate,after:{...identityZero,kind_index:7,unknown_parcel_origins:3,missing_account_count:0}});
    const unissuedIdentity={phase:'frozen_identity_refs_v2',evidence_refs:[...geoCommitted.evidence_refs,forgedIdentity]};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,unissuedIdentity));
    let identityFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/checkpoint_conflict/);
    await assert.rejects(freshRefsOwner()[metricV2Method](refsInput,metricV2Options),/checkpoint_conflict/);
    await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/checkpoint_conflict/);
    await assert.rejects(cadOwner()[cadAccountMethod](refsInput,cadAccountOptions),/checkpoint_conflict/);
    await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,transactionOptions),/checkpoint_conflict/);
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/shared-typed-v2:|shared-v2-stock-metrics:page|shared-job-transactions-v2:page/.test(sql)),
      'an unissued DONE receipt refuses before any shared cache header or metric SQL');
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>sql===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL||sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read
      ||sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source),'unissued identity cannot authorize additional CAD cache metadata or rows');
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,geoCommitted));
    identityFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/market_data_access_denied/);
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|custom-cohort-identity-v2:/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    identityFrom=refsCalls.length;
    await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[organization,actor]);
    await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/job_actor_access_revoked/);
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|neighborhood-cohort-blob:|custom-cohort-identity-v2:/.test(sql)));
    await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    const identityBeforeBlobs=await refsBlobCount();
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/]]){
      refsFault=fault;refsAbort=new AbortController();
      await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,{...refsOptions,signal:refsAbort.signal}),reason);
      assert.equal(refsFault,null,'actual identity SQL ran before ending refusal');
      assert.equal(await readIdentityAnchor(),null);assert.deepEqual(await readRefsCheckpoint(),geoCommitted);
      assert.deepEqual(await readRefsAnchor(),finalAnchor);assert.deepEqual(await readGeoAnchor(),geoIssued);
      assert.equal(await refsBlobCount(),identityBeforeBlobs);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsBlobPuts.length=0;identityFrom=refsCalls.length;refsFault='commit';
    await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),error=>error.outcome_unknown===true);
    const identityFirst=await readRefsCheckpoint(),identityFirstAnchor=await readIdentityAnchor();
    assert.equal(identityFirst.phase,'frozen_identity_refs_v2');assert.equal(identityFirstAnchor.sequence,1);
    assert.deepEqual(identityFirst.evidence_refs[5],identityFirstAnchor.receipt_reference);
    const identityFirstBody=JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [organization,identityFirstAnchor.receipt_reference.content_sha256])).rows[0].canonical_utf8);
    assert.deepEqual(identityFirstBody,identityTemplate,'first actual page checks source parts 1,2,4, not NULL geometric parcel 5');
    const partialIdentityFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[metricV2Method](refsInput,metricV2Options),/unfinished_identity_verification/);
    await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/unfinished_identity_verification/);
    await assert.rejects(cadOwner()[cadAccountMethod](refsInput,cadAccountOptions),/unfinished_identity_verification/);
    await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,transactionOptions),/unfinished_identity_verification/);
    assert.deepEqual(await readRefsCheckpoint(),identityFirst);assert.deepEqual(await readIdentityAnchor(),identityFirstAnchor);
    assert.ok(!refsCalls.slice(partialIdentityFrom).some(sql=>/neighborhood-frozen-job-identity:|shared-typed-v2:|shared-v2-stock-metrics:page|shared-job-transactions-v2:page|checkpoint-save|anchor-advance/.test(sql)),
      'metric reads cannot advance a real partial identity head or silently finish its verification');
    assert.ok(!refsCalls.slice(partialIdentityFrom).some(sql=>sql===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL||sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read
      ||sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source),'CAD reader cannot silently finish a partial issued identity head');
    const identityNext=await freshRefsOwner()[identityV2Method](refsInput,refsOptions);
    assert.equal(identityNext.advanced,true);assert.equal(identityNext.verified_layer_count,2);
    assert.equal((await readIdentityAnchor()).sequence,2);
    assert.equal(refsCalls.slice(identityFrom).filter(sql=>sql.includes('neighborhood-frozen-job-identity:parcels')).length,1);
    assert.equal(refsCalls.slice(identityFrom).filter(sql=>sql.includes('neighborhood-frozen-job-identity:accounts')).length,1);
    let identityDone=identityNext,identitySteps=2;
    while(!identityDone.all_layers_verified){
      if(identitySteps===6){
        const head=await readIdentityAnchor();
        const body=JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
          [organization,head.receipt_reference.content_sha256])).rows[0].canonical_utf8);
        const wrongCoverage=await retainGeo({...identityTemplate,sequence:7,previous:head.receipt_reference,before:body.after,
          after:{...body.after,kind_index:7,missing_account_count:1}});
        await assert.rejects(withCustomCohortJobTransaction(pool,client=>identityRepository(client).advance(head,wrongCoverage)),
          error=>error.code==='55000'&&/identity_v2_anchor_count_conflict/.test(error.message));
        assert.deepEqual(await readIdentityAnchor(),head);
      }
      identityDone=await freshRefsOwner()[identityV2Method](refsInput,refsOptions);
      assert.equal(identityDone.advanced,true);assert.ok(++identitySteps<=7);}
    assert.equal(identitySteps,7);assert.equal(identityDone.verified_layer_count,7);
    assert.equal(identityDone.unknown_parcel_origins,3);assert.equal(identityDone.missing_account_count,0);
    assert.equal(identityDone.origin_count_scope,'source_graph_account_parcel_parts_not_geographic_stock');
    assert.equal(identityDone.source_acquisition,'not_established');assert.equal(identityDone.typed_numerical_observations,'not_established');
    assert.equal(identityDone.report_update,'none');assert.equal(refsBlobPuts.length,7);
    for(const text of refsBlobPuts)assert.ok(Buffer.byteLength(text)<4000&&!/payload_text|stored_geometry_ewkb|legal_description/.test(text));
    const identityCommitted=await readRefsCheckpoint(),identityIssued=await readIdentityAnchor();
    assert.equal(identityIssued.sequence,7);assert.deepEqual(identityCommitted.evidence_refs[5],identityIssued.receipt_reference);
    identityFrom=refsCalls.length;const identityReplay=await freshRefsOwner()[identityV2Method](refsInput,refsOptions);
    assert.equal(identityReplay.advanced,false);assert.equal(identityReplay.all_layers_verified,true);
    assert.deepEqual(await readIdentityAnchor(),identityIssued);assert.deepEqual(await readRefsCheckpoint(),identityCommitted);
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|stock-originals:|neighborhood-frozen-job-closure:|anchor-insert|anchor-advance|checkpoint-save/.test(sql)));
    for(const fault of ['missing_identity_receipt','corrupt_identity_receipt']){
      refsFault=fault;identityFrom=refsCalls.length;
      await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/checkpoint_conflict|storage_conflict|invalid_receipt/);
      assert.equal(refsFault,null);assert.deepEqual(await readRefsCheckpoint(),identityCommitted);assert.deepEqual(await readIdentityAnchor(),identityIssued);
      assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    }
    for(const [index,replacement] of [[1,ownedCheckpoint.evidence_refs[1]],[2,refsEndedCheckpoint.evidence_refs[2]],
      [3,graphFirstCheckpoint.evidence_refs[3]],[4,forgedGeo],[5,forgedIdentity],[5,{content_sha256:'0'.repeat(64),canonical_utf8_bytes:'123'}]]){
      const swapped={...identityCommitted,evidence_refs:[...identityCommitted.evidence_refs]};swapped.evidence_refs[index]=replacement;
      await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,swapped));
      identityFrom=refsCalls.length;
      await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/checkpoint_conflict|anchor_binding_changed/);
      assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
      assert.deepEqual(await readIdentityAnchor(),identityIssued);
    }
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).saveCheckpoint(refsClaim,options,identityCommitted));
    identityFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[identityV2Method](refsInput,refsOptions),/market_data_access_denied/);
    assert.deepEqual(await readRefsCheckpoint(),identityCommitted);assert.deepEqual(await readIdentityAnchor(),identityIssued);
    assert.ok(!refsCalls.slice(identityFrom).some(sql=>/neighborhood-frozen-job-identity:|stock-originals:|neighborhood-frozen-job-closure:/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    for(const sql of ['UPDATE app.neighborhood_custom_cohort_identity_v2_anchors SET sequence=sequence-1 WHERE operation_id=$1',
      'DELETE FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=$1'])
      await assert.rejects(pool.query(sql,[refsOperation]),error=>error.code==='55000');
    await assert.rejects(pool.query('TRUNCATE app.neighborhood_custom_cohort_identity_v2_anchors'),error=>error.code==='55000');
    for(const method of ['verifyFrozenCaptureJobSourceReferencesV2Page',geoV2Method,'verifyFrozenCaptureJobSourceIdentityClosure',
      'prepareFrozenCaptureJobTypedOriginals','readSharedFrozenCaptureJobStockMetrics'])
      await assert.rejects(freshRefsOwner()[method](refsInput,refsOptions),/checkpoint_conflict|invalid_input/);
    await assert.rejects(freshRefsOwner()[identityV2Method](sourceInput,{captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    assert.deepEqual((await pool.query('SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[sourceOperation])).rows[0].checkpoint,ownedCheckpoint);
    await withCustomCohortJobTransaction(pool,async client=>assert.equal((await createCustomCohortCaptureJobRepository(client)
      .readPreparedGeneration(refsClaim,options)).generation_id,frozen.generationId));
    console.log('[native-reference-identity-owner-v2]',{layers:7,source_account_parcel_parts:3,unknown_parcel_origins:3,
      missing_account_count:0,metadata_puts:7,original_payload_copies:0,completed_issued_graph_and_geography_required:true,
      independent_identity_head:true,unissued_done_refused_before_original:true,next_prefix_and_origin_counts_guarded:true,
      short_prefix_guard_only_rollback:true,both_end_rights_rollback:true,lost_commit_resumes_next_layer:true,
      ended_replay_no_original:true,legacy_cast_refused:true,generation_pin_retained:true,source_acquisition:false,production_latency:false});
    // Shared neutral syntax is read only after actual V2 issued graph,
    // geography and identity completion. The retained appraisal date remains
    // a consumer policy, never a cache key or caller-provided owner option.
    const noCacheFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[metricV2Method](refsInput,metricV2Options),/invalid_result/);
    await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,transactionOptions),/invalid_result/);
    assert.ok(!refsCalls.slice(noCacheFrom).some(sql=>/shared-typed-v2:begin|shared-typed-v2:rows|shared-v2-stock-metrics:page|checkpoint-save/.test(sql)));
    const neutralPrepared=await sharedTypedV2Complete(pool,frozen.generationId);
    assert.equal(neutralPrepared.all_layers_typed,true);
    const metricBeforeBlobs=await refsBlobCount(),metricFrom=refsCalls.length;
    const metricA=await freshRefsOwner()[metricV2Method](refsInput,metricV2Options);
    const metricB=await freshRefsOwner()[metricV2Method](refsInput,{...metricV2Options,
      stockMetricPage:{cursor:metricA.next_cursor,rowLimit:250}});
    assert.equal(metricA.rows[0].account_id,'CLOSURE-A');assert.equal(metricB.rows[0].account_id,'CLOSURE-B');
    assert.equal(metricA.effective_date,'2026-10-07');
    assert.equal(metricA.rows[0].observations.reported_year_built.exact_value,'1960');
    assert.equal(metricB.rows[0].observations.reported_year_built.state,'invalid','neutral 2050 syntax must be projected before account resolution');
    assert.equal(metricB.rows[0].observations.reported_year_built.invalid_part_count,'1');
    assert.deepEqual(metricA.rows[0].observations.reported_residential_area.conflict_values,['1000.01','2000.02']);
    assert.equal(metricA.rows[0].observations.reported_market_value.exact_value,'9007199254740993');
    assert.equal(metricA.shared_typed_generation_reference.shared_typed_reference_version,2);
    assert.equal(Object.hasOwn(metricA.shared_typed_generation_reference,'effective_date'),false);
    assert.equal(metricA.end_of_population,false);assert.equal(metricB.end_of_population,true);
    assert.deepEqual(await readRefsCheckpoint(),identityCommitted);assert.deepEqual(await readIdentityAnchor(),identityIssued);
    assert.equal(await refsBlobCount(),metricBeforeBlobs);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_typed_original_rows WHERE operation_id=$1',[refsOperation])).rows[0].n,0);
    assert.ok(!refsCalls.slice(metricFrom).some(sql=>/ST_DWithin|neighborhood-frozen-job-closure:|neighborhood-frozen-job-identity:|stock-originals:|job-typed:|shared-typed-v2:page|shared-typed-v2:begin|shared-typed-v2:rows|checkpoint-save|anchor-advance|anchor-insert/.test(sql)));
    assert.ok(refsCalls.slice(metricFrom).includes('BEGIN ISOLATION LEVEL READ COMMITTED'));
    // Isolated DATA-only date variants prove projection reuse, not historical
    // source authorization, a changed report date or licensed acquisition.
    const oldDate=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodSharedJobStockMetricPagesV2(
      client,refsGraphOptions,{root:refsGraphRoot,layer_counts:identityCounts},'1900-01-01').page({cursor:'',rowLimit:250}));
    const laterDate=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodSharedJobStockMetricPagesV2(
      client,refsGraphOptions,{root:refsGraphRoot,layer_counts:identityCounts},'2050-01-01').page({cursor:'',rowLimit:250}));
    assert.equal(oldDate.rows[0].observations.reported_year_built.state,'invalid');
    assert.equal(laterDate.rows[1].observations.reported_year_built.exact_value,'2050');
    assert.deepEqual(oldDate.shared_typed_generation_reference,laterDate.shared_typed_generation_reference);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_v2_generations WHERE generation_id=$1',[frozen.generationId])).rows[0].n,1);
    // Exercise the exact SQL algebra with two isolated syntactic DATA parts.
    // This fixture replacement is test-only, never an owner-selected relation
    // or a mutation of a published cache. A future part is invalid, not a
    // conflicting witness against the older admissible part for that account.
    const cells=(await pool.query("SELECT typed->'observations' AS cells FROM app.neighborhood_frozen_typed_v2_rows WHERE generation_id=$1 AND kind='parcels' AND row_key='1'",[frozen.generationId])).rows[0].cells;
    const futureCells=structuredClone(cells);futureCells.reported_year_built.exact_value='2050';
    const fixedRelation="SELECT typed->'observations' AS observations FROM app.neighborhood_frozen_typed_v2_rows\n      WHERE generation_id=$2::uuid AND profile_sha256=$8 AND kind='parcels' AND account_id=a.account_id";
    assert.ok(NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL.includes(fixedRelation));
    const algebraSql=NEIGHBORHOOD_SHARED_STOCK_METRIC_V2_PAGE_SQL.replace(fixedRelation,
      `SELECT observations FROM (VALUES ('CLOSURE-A',$9::jsonb),('CLOSURE-A',$10::jsonb)) AS p(account_id,observations)
        WHERE $2::uuid IS NOT NULL AND $8::text IS NOT NULL AND p.account_id=a.account_id`);
    const algebraValues=[refsOperation,frozen.generationId,'',1,'2026-10-07',2100000,16000,
      metricA.typed_original_profile_ref.content_sha256,JSON.stringify(cells),JSON.stringify(futureCells)];
    const algebra=(await pool.query(algebraSql,algebraValues)).rows[0],algebraYear=JSON.parse(algebra.page_json)[0].observations.reported_year_built;
    assert.equal(algebra.invalid_count,0);assert.equal(algebraYear.state,'observed');assert.equal(algebraYear.exact_value,'1960');
    assert.equal(algebraYear.observed_part_count,'1');assert.equal(algebraYear.invalid_part_count,'1');assert.deepEqual(algebraYear.conflict_values,[]);
    futureCells.reported_year_built.unit='reported_sqft';algebraValues[9]=JSON.stringify(futureCells);
    assert.equal((await pool.query(algebraSql,algebraValues)).rows[0].invalid_count,1,
      'a malformed future cell is refused, not laundered into an eligible invalid part by projection');
    const initiallyDeniedFrom=refsCalls.length;
    await setFixtureGrant(pool,organization,{...fixtureGrant(organization),revoked_at:'2026-01-01T00:00:00.000000Z'});
    await assert.rejects(freshRefsOwner()[metricV2Method](refsInput,metricV2Options),/market_data_access_denied/);
    assert.ok(!refsCalls.slice(initiallyDeniedFrom).some(sql=>/shared-typed-v2:|shared-v2-stock-metrics:page/.test(sql)));
    await setFixtureGrant(pool,organization,fixtureGrant(organization));
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/]]){
      refsFault=fault;refsAbort=new AbortController();const faultFrom=refsCalls.length;
      await assert.rejects(freshRefsOwner()[metricV2Method](refsInput,{...metricV2Options,signal:refsAbort.signal}),reason);
      assert.equal(refsFault,null,'actual neutral metric SQL ran before ending refusal');
      assert.ok(refsCalls.slice(faultFrom).some(sql=>sql.includes('shared-v2-stock-metrics:page')));
      assert.deepEqual(await readRefsCheckpoint(),identityCommitted);assert.deepEqual(await readIdentityAnchor(),identityIssued);
      assert.equal(await refsBlobCount(),metricBeforeBlobs);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    await assert.rejects(freshRefsOwner()[metricV2Method](sourceInput,{...metricV2Options,captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    console.info('[native-shared-stock-owner-v2]',{accounts:2,actual_issued_graph_geography_identity_required:true,
      neutral_cache_headers:1,retained_effective_year_before_resolution:true,date_variant_reuse_data_only:true,
      caller_date_refused:true,partial_identity_refused_without_advance:true,unissued_done_refused_before_cache:true,
      both_end_current_rights_subject_claim_cancel:true,original_payload_reads:0,job_typed_copies:0,checkpoint_writes:0,
      source_acquisition:false,report_update:false,production_latency:false});
    // All-date typed transaction pages use actual issued owner prerequisites,
    // not fabricated done blobs or the old dense arrays. Outside package links
    // stay visible, but outside source502 never becomes a second-hop seed.
    const transactionFrom=refsCalls.length,transactionBlobs=await refsBlobCount(),transactionRows={};
    for(const kind of ['source_records','sales','sale_links']){
      let after='',done=false,steps=0;const rows=[];
      while(!done){
        const page=await freshRefsOwner()[transactionMethod](refsInput,{...transactionOptions,transactionPage:{kind,cursor:after,rowLimit:1}});
        rows.push(...page.rows);after=page.next_cursor;done=page.end_of_kind;assert.ok(++steps<=5);
        assert.equal(page.coverage,'one_kind_page_only');assert.equal(page.source_acquisition,'not_established');
        assert.equal(page.transaction_eligibility,'not_established');assert.equal(page.retained_effective_date,'2026-10-07');
        assert.deepEqual(page.retained_observation_period,refsInput.observationPeriod);
        assert.deepEqual(page.identity_verification_reference,identityIssued.receipt_reference);
      }
      assert.deepEqual(rows.map(r=>r.row_key),expected[kind]);transactionRows[kind]=rows;
      assert.equal(steps,rows.length+1,'full one-row tail requires a fresh empty probe');
    }
    assert.equal(transactionRows.source_records.find(r=>r.row_key==='501').typed.dates.close_date.exact_value,'2010-01-01',
      'capture pages do not drop older records before retained period resolution');
    assert.equal(transactionRows.source_records.find(r=>r.row_key==='501').typed.same_payload_reported_sale.observations.reported_close_price.exact_value,'9007199254740993');
    assert.equal(transactionRows.source_records.find(r=>r.row_key==='501').typed.same_payload_reported_sale.observations.reported_close_price.state,'unsupported',
      'missing same-payload currency is not inferred from normalized price');
    assert.equal(transactionRows.source_records.find(r=>r.row_key==='504').account_id,'CLOSURE-OUTSIDE');
    assert.equal(transactionRows.sales.find(r=>r.row_key==='3').source_record_id,null);
    assert.equal(transactionRows.sale_links.find(r=>r.row_key==='2').account_id,'CLOSURE-OUTSIDE');
    assert.equal(transactionRows.sale_links.find(r=>r.row_key==='4').account_id,null);
    const assertTransactionUnchanged=async()=>{
      assert.deepEqual(await readRefsCheckpoint(),identityCommitted);assert.deepEqual(await readRefsAnchor(),finalAnchor);
      assert.deepEqual(await readGeoAnchor(),geoIssued);assert.deepEqual(await readIdentityAnchor(),identityIssued);
      assert.equal(await refsBlobCount(),transactionBlobs);
    };
    for(const [fault,reason] of [['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/],['transaction_header',/cache_unavailable/]]){
      refsFault=fault;refsAbort=new AbortController();const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,{...transactionOptions,signal:refsAbort.signal}),reason,`transaction ending ${fault}`);
      assert.equal(refsFault,null);assert.ok(refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL));await assertTransactionUnchanged();
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsFault='commit';await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,transactionOptions),e=>e.outcome_unknown===true);
    await assertTransactionUnchanged();
    assert.deepEqual((await freshRefsOwner()[transactionMethod](refsInput,transactionOptions)).rows,[transactionRows.source_records[0]]);
    for(const fault of ['missing_receipt','corrupt_receipt','missing_geo_receipt','corrupt_geo_receipt','missing_identity_receipt','corrupt_identity_receipt']){
      refsFault=fault;const from=refsCalls.length;
      await assert.rejects(freshRefsOwner()[transactionMethod](refsInput,transactionOptions),/checkpoint_conflict|storage_conflict|invalid_receipt/);
      assert.equal(refsFault,null);assert.ok(!refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL));await assertTransactionUnchanged();
    }
    await assert.rejects(freshRefsOwner()[transactionMethod](sourceInput,{...transactionOptions,captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    assert.ok(!refsCalls.slice(transactionFrom).some(sql=>/ST_DWithin|neighborhood-frozen-job-closure:|payload::text|shared-typed-v2:(?:page|begin|rows|progress)|checkpoint-save|anchor-(?:advance|insert)/.test(sql)));
    console.info('[native-shared-transaction-page-owner-v2]',{source_records:3,sales:3,sale_links:4,
      outside_and_unresolved_links_retained:true,legacy_stock_sale_retained:true,second_hop_source_502_excluded:true,
      all_dates_before_period_resolution:true,no_currency_or_normalized_fallback:true,actual_issued_prerequisites:true,
      current_authorization_and_ending_cache_refusal:true,partial_unissued_corrupt_heads_refused:true,lost_commit_reopen:true,
      original_payload_reads:0,job_typed_copies:0,checkpoint_or_head_writes:0,
      source_acquisition:false,transaction_eligibility:false,report_update:false,production_latency:false});
    // Actual current-authorized companion consumer, not a DATA-only raw reader.
    // The additional synthetic CAD grant never provisions production rights.
    const cadBeforeBlobs=await refsBlobCount(),cadInitialFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/CAD_source_policy_required/);
    await pool.query('UPDATE app_auth.organizations SET metadata=metadata-$2::text WHERE id=$1',[organization,CAD_RIGHTS_KEY]);
    await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/market_data_access_denied/);
    const legacyCadOwner=createCustomCohortContextCapture({pool:refsPool,sourceMode:'combined-witness2-v1',
      authorizeMarketData:fixturePolicy(),authorizeCadImprovementData:fixturePolicy()});
    await assert.rejects(legacyCadOwner[cadOwnerMethod](refsInput,cadOwnerOptions),/market_data_access_denied/,
      'the actual old seven-layer source policy must cross-deny the CAD companion purpose');
    await setCadFixtureGrant(pool,organization,cadGrant);
    const wrongRevisionOwner=createCustomCohortContextCapture({pool:refsPool,sourceMode:'combined-witness2-v1',
      authorizeMarketData:fixturePolicy(),authorizeCadImprovementData:async()=>({allowed:true,decision_id:'synthetic',policy_revision:'old-seven-layer'})});
    await assert.rejects(wrongRevisionOwner[cadOwnerMethod](refsInput,cadOwnerOptions),/CAD_source_policy_required/);
    assert.ok(!refsCalls.slice(cadInitialFrom).some(sql=>sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source||sql===NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read
      ||sql===NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL),'ungranted/legacy/misconfigured CAD policy refuses before any companion source/cache query');
    await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/invalid_result/,'no cache-miss preparation by current user');
    let cadProgress=null,cadComplete;
    for(let i=0;i<5;i++){
      cadComplete=await withCustomCohortJobTransaction(pool,async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL TIME ZONE 'UTC'");
        return createNeighborhoodSharedTypedCadGenerationV1(client,{generationId:frozen.generationId}).step(cadProgress);});
      cadProgress=cadComplete.progress;if(cadComplete.all_layers_typed)break;
    }
    assert.equal(cadComplete.all_layers_typed,true);
    const cadFrom=refsCalls.length,cadA=await cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions);
    const cadB=await cadOwner()[cadOwnerMethod](refsInput,{...cadOwnerOptions,
      cadImprovementPage:{kind:'primary',cursor:cadA.next_cursor,rowLimit:250}});
    const cadSecondary=await cadOwner()[cadOwnerMethod](refsInput,{...cadOwnerOptions,
      cadImprovementPage:{kind:'secondary',cursor:{account_id:'',row_key:''},rowLimit:250}});
    assert.equal(cadA.rows[0].account_id,'CLOSURE-A');assert.equal(cadA.end_of_kind,false);
    assert.deepEqual(cadB.rows.map(r=>r.account_id),['CLOSURE-B']);assert.equal(cadB.end_of_kind,true);
    assert.equal(cadB.rows[0].typed.observations.reported_pool_flag.state,'missing');
    assert.equal(cadB.absent_rows,'not_zero_or_no_amenity');
    assert.deepEqual(cadSecondary.rows.map(r=>r.row_key),['1','3','2']);assert.equal(cadSecondary.end_of_kind,true);
    assert.equal(cadA.CAD_source_authorization.purpose.generation_id,frozen.generationId);
    assert.equal(cadA.CAD_source_authorization.purpose.temporal_basis,'current_CAD_observations_not_retrospective_or_at_sale');
    assert.match(cadA.CAD_source_authorization.decision.policy_revision,/^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$/);
    for(const result of [cadA,cadB,cadSecondary]){
      assert.equal(result.current_authorized_owner,'V2_issued_graph_geography_identity_and_separate_CAD_rights');
      assert.deepEqual(result.source_reference,identityCommitted.evidence_refs[2]);
      assert.deepEqual(result.verification_reference,identityCommitted.evidence_refs[3]);
      assert.deepEqual(result.stock_verification_reference,identityCommitted.evidence_refs[4]);
      assert.deepEqual(result.identity_verification_reference,identityCommitted.evidence_refs[5]);
      assert.equal(result.source_acquisition,'not_established');assert.equal(result.report_update,'none');
    }
    const assertCadUnchanged=async()=>{assert.deepEqual(await readRefsCheckpoint(),identityCommitted);
      assert.deepEqual(await readRefsAnchor(),finalAnchor);assert.deepEqual(await readGeoAnchor(),geoIssued);
      assert.deepEqual(await readIdentityAnchor(),identityIssued);assert.equal(await refsBlobCount(),cadBeforeBlobs);};
    await assertCadUnchanged();
    assert.ok(!refsCalls.slice(cadFrom).some(sql=>/ST_DWithin|neighborhood-frozen-job-closure:|neighborhood-frozen-job-identity:|stock-originals:|job-typed:|shared-typed-CAD:(?:page|begin|rows|progress)|checkpoint-save|anchor-(?:advance|insert)|payload::text/.test(sql)),
      'current owner reuses metadata/typed pages without original queries or issued-head/report writes');
    assert.ok(refsCalls.slice(cadFrom).filter(sql=>sql.includes('cad-improvement-source-policy:organization')).length===6);
    for(const [fault,reason] of [['cad_license',/market_data_access_denied/],['cad_expiry',/market_data_access_denied/],
      ['cad_revision',/CAD_source_policy_changed/],['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/],['cad_header',/cache_unavailable/]]){
      refsFault=fault;refsAbort=new AbortController();const from=refsCalls.length;
      await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,{...cadOwnerOptions,signal:refsAbort.signal}),reason,`ending ${fault} must refuse delivery`);
      assert.equal(refsFault,null,'actual additional CAD page ran before ending refusal');
      assert.ok(refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL));await assertCadUnchanged();
      if(fault.startsWith('cad_'))await setCadFixtureGrant(pool,organization,cadGrant);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsFault='commit';await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),e=>e.outcome_unknown===true);
    assert.equal(refsFault,null);await assertCadUnchanged();
    assert.deepEqual((await cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions)).rows,cadA.rows);
    for(const fault of ['missing_receipt','corrupt_receipt','missing_geo_receipt','corrupt_geo_receipt','missing_identity_receipt','corrupt_identity_receipt']){
      refsFault=fault;const from=refsCalls.length;
      await assert.rejects(cadOwner()[cadOwnerMethod](refsInput,cadOwnerOptions),/checkpoint_conflict|storage_conflict|invalid_receipt/);
      assert.equal(refsFault,null);assert.ok(!refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL));await assertCadUnchanged();
    }
    await assert.rejects(cadOwner()[cadOwnerMethod](sourceInput,{...cadOwnerOptions,captureJobClaim:sourceClaim}),/checkpoint_conflict/);
    console.info('[native-shared-CAD-page-owner-v1]',{stock_accounts:2,primary_rows:2,secondary_rows:3,outside_accounts:0,
      duplicate_secondary_numbers_retained:true,actual_issued_graph_geography_identity_required:true,
      separate_current_CAD_purpose_required:true,legacy_grant_cross_denied:true,both_end_CAD_revocation_expiry_revision:true,
      both_end_legacy_rights_role_subject_claim_cancel:true,ending_cache_guard:true,unissued_partial_or_corrupt_heads_refused:true,
      lost_commit_reopen:true,original_payload_reads:0,job_typed_copies:0,checkpoint_or_head_writes:0,
      source_acquisition:false,amenity_resolution:false,report_update:false,production_latency:false});
    const accountFrom=refsCalls.length;
    await assert.rejects(freshRefsOwner()[cadAccountMethod](refsInput,cadAccountOptions),/CAD_source_policy_required/);
    const accountPage=await cadOwner()[cadAccountMethod](refsInput,cadAccountOptions);
    assert.deepEqual(accountPage.rows.map(r=>r.account_id),['CLOSURE-A','CLOSURE-B']);assert.equal(accountPage.end_of_accounts,true);
    assert.equal(accountPage.rows[0].observations.reported_pool_flag.exact_value,true);
    assert.equal(accountPage.rows[1].observations.reported_pool_flag.state,'missing');
    assert.deepEqual(accountPage.rows.map(r=>r.secondary_original_count),['2','1']);
    assert.ok(accountPage.rows.every(r=>r.secondary_type_resolution==='not_established'&&r.housing_eligibility==='not_established'));
    assert.equal(accountPage.rows[0].observations.reported_baths.exact_value,'2');
    assert.equal(accountPage.rows[0].observations.reported_baths.unit,'CAD_reported_baths');
    assert.equal(accountPage.effective_date,metricA.effective_date,'date comes from the actual retained subject context');
    assert.deepEqual(accountPage.identity_verification_reference,identityCommitted.evidence_refs[5]);
    await assertCadUnchanged();
    for(const [fault,reason] of [['cad_license',/market_data_access_denied/],['cad_expiry',/market_data_access_denied/],
      ['cad_revision',/CAD_source_policy_changed/],['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],
      ['subject',/subject_changed/],['claim',/claim_lost/],['cancel',/cancelled/],['cad_header',/cache_unavailable/]]){
      refsFault=fault;refsAbort=new AbortController();const from=refsCalls.length;
      await assert.rejects(cadOwner()[cadAccountMethod](refsInput,{...cadAccountOptions,signal:refsAbort.signal}),reason,`account ending ${fault}`);
      assert.equal(refsFault,null);assert.ok(refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL));await assertCadUnchanged();
      if(fault.startsWith('cad_'))await setCadFixtureGrant(pool,organization,cadGrant);
      if(fault==='license')await setFixtureGrant(pool,organization,fixtureGrant(organization));
      if(fault==='role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[organization,actor]);
    }
    refsFault='commit';await assert.rejects(cadOwner()[cadAccountMethod](refsInput,cadAccountOptions),e=>e.outcome_unknown===true);
    assert.deepEqual((await cadOwner()[cadAccountMethod](refsInput,cadAccountOptions)).rows,accountPage.rows);await assertCadUnchanged();
    for(const fault of ['missing_receipt','corrupt_receipt','missing_geo_receipt','corrupt_geo_receipt','missing_identity_receipt','corrupt_identity_receipt']){
      refsFault=fault;const from=refsCalls.length;
      await assert.rejects(cadOwner()[cadAccountMethod](refsInput,cadAccountOptions),/checkpoint_conflict|storage_conflict|invalid_receipt/);
      assert.equal(refsFault,null);assert.ok(!refsCalls.slice(from).includes(NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL));await assertCadUnchanged();
    }
    assert.ok(!refsCalls.slice(accountFrom).some(sql=>/ST_DWithin|neighborhood-frozen-job-closure:|shared-typed-CAD:(?:page|begin|rows|progress)|checkpoint-save|anchor-(?:advance|insert)|payload::text/.test(sql)));
    console.info('[native-current-CAD-account-owner-v1]',{stock_accounts:2,secondary_native_rows:3,outside_accounts:0,
      actual_retained_date_and_issued_prerequisites:true,partial_unissued_and_corrupt_heads_refused:true,separate_current_rights_both_ends:true,missing_pool_not_false:true,
      no_secondary_type_or_housing_inference:true,lost_commit_reopen:true,original_payload_reads:0,job_typed_copies:0,
      checkpoint_or_head_writes:0,source_acquisition:false,report_update:false,production_latency:false});
    }
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

test('isolated PostgreSQL: current CAD account pages preserve missing primary members and native false without inferred amenities',{
  skip:!process.env.DATABASE_URL,timeout:90_000,
},async()=>{
  const target=await prepareNeighborhoodCiDatabase();const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString:target.connectionString,max:2,statement_timeout:30_000});
  try{
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    await pool.query('ALTER TABLE core.primary_improvements ADD COLUMN IF NOT EXISTS pool boolean');
    await pool.query(`INSERT INTO core.accounts(account_id,county,city,subdivision) VALUES
      ('CAD-A','Dallas','Garland','Synthetic CAD'),('CAD-MISSING','Dallas','Garland','Synthetic CAD')`);
    await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,geom) VALUES
      (1,'CAD-A',ST_Multi(ST_MakeEnvelope(-96.7,32.9,-96.699,32.901,4326))),
      (2,'CAD-MISSING',ST_Multi(ST_MakeEnvelope(-96.699,32.9,-96.698,32.901,4326)))`);
    await pool.query(`INSERT INTO core.primary_improvements(account_id,year_built,living_area_sqft,bedroom_count,bath_count,number_units,pool)
      VALUES('CAD-A',2050,1000.001,3,2.50,1,false)`);
    await pool.query(`INSERT INTO core.secondary_improvements(id,account_id,sec_imp_number,sec_imp_type,sec_imp_sqft) VALUES
      (1,'CAD-A',1,'UNKNOWN PROVIDER TYPE',400),(3,'CAD-A',1,'UNKNOWN PROVIDER TYPE',100)`);
    const frozen=await runNeighborhoodGroupIndex(pool,{batchSize:2,logger:{info(){}},retainOriginalSources:true,retainCadImprovementOriginals:true});
    let p=null,prepared;
    for(let i=0;i<5;i++){
      prepared=await withCustomCohortJobTransaction(pool,async client=>{
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL TIME ZONE 'UTC'");
        return createNeighborhoodSharedTypedCadGenerationV1(client,{generationId:frozen.generationId}).step(p);});
      p=prepared.progress;if(prepared.all_layers_typed)break;
    }
    assert.equal(prepared.all_layers_typed,true);
    const organization=randomUUID(),actor=randomUUID(),report=randomUUID(),operation=randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'CAD synthetic','CAD synthetic')",[organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'CAD actor')",[actor,`${actor}@example.test`]);
    const assignment=(await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,'CAD-A',$2,$3,$3) RETURNING id::text`,[organization,`CAD-${randomUUID()}`,actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,'CAD-A','custom_appraisal',$3,$4)`,[report,organization,`CAD-${randomUUID()}`,assignment]);
    const scope={organization_id:organization,report_file_id:report,assignment_file_id:assignment,account_id:'CAD-A'},options={scope,actorUserId:actor};
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:operation,observation_period:{start_date:'2024-01-01',end_date:'2026-10-07'}}}));
    const claim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});assert.equal(job.operation_id,operation);
      return {operation_id:operation,claim_token:job.claim_token,attempts:job.attempts};});
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(claim,options));
    const pageOptions={...frozenSpatialOptions({...options,claim}),subjectIntent:{content_sha256:'f'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
    const stock=await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,pageOptions).prepare());
    assert.equal(stock.population.account_count,'2');
    const graph={root:{content_sha256:'d'.repeat(64),canonical_utf8_bytes:'100'},
      layer_counts:Object.fromEntries(Object.entries(stock.original.layer_counts).map(([k,v])=>[k,Number(v.row_count)]))};
    const queries=[],read=(cursor='',rowLimit=250,date='2026-10-07')=>withCustomCohortJobTransaction(pool,client=>
      createNeighborhoodSharedJobCadAccountPages({async query(config){queries.push(config.text);return client.query(config);}},pageOptions,graph,date).page({cursor,rowLimit}));
    const first=await read('',1);assert.equal(first.end_of_accounts,false);assert.equal(first.rows[0].account_id,'CAD-A');
    assert.equal(first.rows[0].observations.reported_year_built.state,'invalid');
    assert.equal(first.rows[0].observations.reported_pool_flag.exact_value,false);
    assert.equal(first.rows[0].observations.reported_baths.exact_value,'2.5');assert.equal(first.rows[0].secondary_original_count,'2');
    const missing=await read(first.next_cursor,1);assert.equal(missing.end_of_accounts,false);
    assert.equal(missing.rows[0].account_id,'CAD-MISSING');assert.equal(missing.rows[0].primary_original_count,'0');
    assert.ok(Object.values(missing.rows[0].observations).every(c=>c.state==='missing'&&c.exact_value===null&&c.reason==='primary_original_absent'));
    assert.equal(missing.rows[0].secondary_type_resolution,'not_established');
    const end=await read(missing.next_cursor,1);assert.equal(end.end_of_accounts,true);assert.equal(end.rows.length,0);
    assert.equal((await read('',250,'2050-01-01')).rows[0].observations.reported_year_built.exact_value,'2050');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_frozen_typed_cad_generations WHERE generation_id=$1',[frozen.generationId])).rows[0].n,1);
    assert.ok(!queries.some(sql=>/INSERT|UPDATE|DELETE|ST_DWithin|FROM core\.|FROM gis\.|shared-typed-CAD:(?:page|begin|rows|progress)|payload::text/.test(sql)));
    console.info('[native-current-CAD-missing-primary-pages]',{stock_accounts:2,missing_primary_accounts:1,native_false_preserved:true,
      duplicate_secondary_rows:2,future_year_invalid_before_projection:true,neutral_cache_headers:1,full_tail_empty_probe:true,
      original_payload_reads:0,writes:0,graph_issuance:false,current_actor_owner:false,source_acquisition:false,report_update:false,production_latency:false});
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
    // Two genuine stable SQL clients with the same scoped live claim. The
    // actual capture owner's parent locks normally serialize this work; this
    // DATA race still proves the zero-row INSERT conflict/reopen path itself.
    const raceOperation=randomUUID();
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).enqueue({scope,actorUserId:actor,
      request:{operation_id:raceOperation,observation_period:{start_date:'2025-01-01',end_date:'2026-10-07'}}}));
    const raceClaim=await withCustomCohortJobTransaction(pool,async client=>{
      const [job]=await createCustomCohortCaptureJobRepository(client).claimDue({leaseSeconds:900});assert.equal(job.operation_id,raceOperation);
      return {operation_id:raceOperation,claim_token:job.claim_token,attempts:job.attempts};});
    await withCustomCohortJobTransaction(pool,client=>createCustomCohortCaptureJobRepository(client).pinPreparedGeneration(raceClaim,options));
    const raceOptions={...seedOptions,claim:raceClaim};
    await withCustomCohortJobTransaction(pool,client=>createNeighborhoodFrozenJobStock(client,raceOptions).prepare());
    let secondReadReached,firstBegan;
    const secondReadReady=new Promise(resolve=>{secondReadReached=resolve;}),firstBeginReady=new Promise(resolve=>{firstBegan=resolve;});
    const waitFor=promise=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('synthetic seed race did not rendezvous')),3000);
      promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
    });
    const raceCalls=[];let conflicts=0;
    const racingPool=label=>({async connect(){const client=await pool.connect();let firstMissingRead=true;
      return {release:client.release.bind(client),async query(config){
        raceCalls.push({label,text:config.text});const result=await client.query(config);
        if(config.text.includes('neighborhood-frozen-job-seeds:read')&&result.rowCount===0&&firstMissingRead){firstMissingRead=false;
          if(label==='first')await waitFor(secondReadReady);
          else{secondReadReached();await waitFor(firstBeginReady);}}
        if(config.text.includes('neighborhood-frozen-job-seeds:begin')){
          if(label==='first'){assert.equal(result.rowCount,1);firstBegan();}
          else{assert.equal(result.rowCount,0);conflicts++;}}
        return result;
      }};
    }});
    const raced=await Promise.all(['first','second'].map(label=>withCustomCohortJobTransaction(racingPool(label),
      client=>createNeighborhoodFrozenJobSourceSeeds(client,raceOptions).prepare())));
    assert.deepEqual(raced[1],raced[0]);assert.equal(raced[0].seed_count,'60001');assert.equal(conflicts,1);
    assert.equal(raceCalls.filter(call=>call.text.includes('neighborhood-frozen-job-seeds:rows')).length,1);
    assert.equal(raceCalls.filter(call=>call.text.includes('neighborhood-frozen-job-seeds:complete')).length,1);
    assert.ok(!raceCalls.some(call=>call.label==='second'&&/seeds:rows|seeds:complete/.test(call.text)));
    assert.equal((await pool.query('SELECT count(*)::text AS n FROM app.neighborhood_custom_cohort_source_seeds WHERE operation_id=$1',[raceOperation])).rows[0].n,'60001');
    console.info('[native-prepared-source-seeds-concurrent]',{seed_count:60001,clients:2,zero_row_conflicts:conflicts,
      seed_builds:1,exact_completed_reuse:true,source_acquisition:false,production_latency:false});
  }finally{await pool.end();}
});
