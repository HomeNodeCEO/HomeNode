import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { neighborhoodFrozenSpatialDefinition } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';
import { createNeighborhoodFrozenJobSourceSeeds,NEIGHBORHOOD_FROZEN_JOB_SEED_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceSeeds.js';
import { createNeighborhoodPreparedJobSourcePages,NEIGHBORHOOD_PREPARED_JOB_CLOSURE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';

const id='70000000-0000-4000-8000-000000000001',date='2026-10-07T00:00:00.000000Z';
const options={claim:{operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1},
  scope:{organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'STOCK-A'},
  actorUserId:'70000000-0000-4000-8000-000000000005',
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',coordinate_encoding:'decimal_string_v1',
    coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
  subjectIntent:{content_sha256:'b'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
const result=row=>({rowCount:1,rows:[row]});
function fixture(hook=()=>{}){
  const calls=[];let header=null;
  const counts={parcels:2,accounts:1,source_records:2,sales:1,sale_links:2,sync_state:0,sync_runs:0};
  const original={generation_id:id,source_format_version:1,source_snapshot:'1:2:',source_transaction_started_at:date,completed_at:date,
    row_count:'8',payload_utf8_bytes:'800',layer_counts:Object.fromEntries(Object.entries(counts).map(([k,n])=>[k,{row_count:String(n),payload_utf8_bytes:String(n*100)}]))};
  const definition=neighborhoodFrozenSpatialDefinition(options.claim,id,options.geometryInput,options.discovery);
  const stock={status:'complete',definition,definition_sha256:assessmentEvidenceDigest(definition),
    source_original_sha256:assessmentEvidenceDigest(original),subject_intent_sha256:options.subjectIntent.content_sha256,
    subject_intent_utf8_bytes:'100',parcel_count:'2',account_count:'1',unassociated_parcel_count:'0',unlocatable_global_parcels:'0'};
  const client={async query(raw,values){const call=typeof raw==='string'?{text:raw,values}:raw;calls.push(call);
    const supplied=await hook({call,calls,header,stock});if(supplied)return supplied;
    const text=call.text;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence'))return result({operation_id:id});
    if(text.includes('generation-read'))return result({generation_id:id,status:'complete',retirement_started_at:null,
      source_observed_at:date,completed_at:date,parcel_count:'2',sale_count:'1',group_count:'1'});
    if(text.includes('frozen-spatial:header'))return result({generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',
      started_at:date,completed_at:date,layer_counts:original.layer_counts,row_count:original.row_count,payload_utf8_bytes:original.payload_utf8_bytes});
    if(text.includes('job-stock:read'))return result(structuredClone(stock));
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read)return header?result(structuredClone(header)):{rowCount:0,rows:[]};
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.begin){header={generation_id:call.values[1],binding_sha256:call.values[2],
      definition_sha256:call.values[3],definition_json:call.values[4],status:'building',seed_count:'0',completed_at:null};return result({operation_id:id});}
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows)return result({inserted_count:'2'});
    if(text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.complete){header.status='complete';header.seed_count=call.values[2];header.completed_at=date;
      return result({seed_count:call.values[2]});}
    if(Object.values(NEIGHBORHOOD_PREPARED_JOB_CLOSURE_SQL).includes(text)){
      const page_json=JSON.stringify([{row_key:'1',payload_text:'{"price":9007199254740993,"close_date":"2010-01-01"}'}]);
      return result({page_json,page_count:1,candidate_count:1,next_cursor:'1',page_utf8_bytes:Buffer.byteLength(page_json)});
    }
    throw Error(`unexpected ${text.slice(0,80)}`);
  }};
  return {client,calls,stock,get header(){return header;},store:()=>createNeighborhoodFrozenJobSourceSeeds(client,options)};
}

test('prepares one fixed exact stock seed index and fresh reuse has no writes or source rediscovery',async()=>{
  const f=fixture(),prepared=await f.store().prepare(),from=f.calls.length,reopened=await f.store().prepare();
  assert.deepEqual(reopened,prepared);assert.equal(prepared.seed_count,'2');assert.equal(prepared.authority,'not_established');
  assert.equal(prepared.coverage,'seed_lookup_only');assert.equal(Object.isFrozen(prepared),true);
  assert.equal(f.calls.filter(c=>c.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows).length,1);
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|ST_DWithin|seeds:rows|seeds:complete/.test(c.text)));
  assert.ok(f.calls.filter(c=>c.text.includes('job-stock:read')).length>=4);
});

test('prepared page reader preserves exact originals and never builds a missing seed cache',async()=>{
  const absent=fixture();await assert.rejects(createNeighborhoodPreparedJobSourcePages(absent.client,options)
    .page({kind:'sales',cursor:''}),/invalid_result/);
  assert.ok(!absent.calls.some(c=>/INSERT|UPDATE|job-closure:/.test(c.text)));
  const f=fixture();await f.store().prepare();const from=f.calls.length;
  const page=await createNeighborhoodPreparedJobSourcePages(f.client,options).page({kind:'sales',cursor:'',rowLimit:2});
  assert.equal(page.rows[0].payload_text,'{"price":9007199254740993,"close_date":"2010-01-01"}');
  assert.equal(page.end_of_layer,true);assert.equal(page.additional_cadastral_accounts,false);
  assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE|ST_DWithin|seeds:rows/.test(c.text)));
  for(const sql of Object.values(NEIGHBORHOOD_PREPARED_JOB_CLOSURE_SQL)){
    assert.match(sql,/selected_accounts AS NOT MATERIALIZED/);assert.match(sql,/seeds AS NOT MATERIALIZED/);
    assert.match(sql,/source_seeds\s+WHERE operation_id=\$2::uuid AND generation_id=\$1::uuid/);
    assert.doesNotMatch(sql,/SELECT DISTINCT|original.kind IN \('source_records','sales','sale_links'\)|ST_DWithin|core\.|gis\.|raw_payload/);
  }
});

test('zero-row concurrent begin reopens only an exact completed index and still checks the ending claim',async()=>{
  for(const mode of ['valid','missing','unfinished','binding','claim']){
    let racing=false,conflicted=false;
    const f=fixture(({call,header})=>{
      if(!racing)return null;
      if(call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read&&!conflicted)return {rowCount:0,rows:[]};
      if(call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.begin){conflicted=true;return {rowCount:0,rows:[]};}
      if(!conflicted)return null;
      if(call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read){
        if(mode==='missing')return {rowCount:0,rows:[]};
        if(mode==='unfinished')return result({...header,status:'building'});
        if(mode==='binding')return result({...header,binding_sha256:'c'.repeat(64)});
      }
      if(mode==='claim'&&call.text.includes('generation-fence'))return {rowCount:0,rows:[]};
      return null;
    });
    const prepared=await f.store().prepare(),from=f.calls.length;racing=true;
    if(mode==='valid')assert.deepEqual(await f.store().prepare(),prepared);
    else await assert.rejects(f.store().prepare(),/invalid_result|unfinished_or_changed_index|claim_lost/);
    assert.ok(conflicted);assert.ok(!f.calls.slice(from).some(c=>/seeds:rows|seeds:complete/.test(c.text)),
      'a losing builder cannot append to or complete the other header, even on refusal');
  }
});

test('unfinished or changed cache definition, generation, stock binding and counts refuse without repair',async()=>{
  for(const [key,value] of Object.entries({status:'building',generation_id:'70000000-0000-4000-8000-000000000009',
    binding_sha256:'c'.repeat(64),definition_sha256:'d'.repeat(64),definition_json:'{}',seed_count:'6',completed_at:null})){
    const f=fixture();await f.store().prepare();f.header[key]=value;const from=f.calls.length;
    await assert.rejects(f.store().prepare(),/unfinished_or_changed_index/);
    assert.ok(!f.calls.slice(from).some(c=>/INSERT|UPDATE/.test(c.text)));
  }
});

test('ending claim/stock/cache loss and wrong write acknowledgements cannot deliver an index',async()=>{
  for(const mode of ['claim','stock','cache','begin','rows','complete']){
    let afterComplete=false;
    const f=fixture(({call,header})=>{
      if(call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.complete)afterComplete=true;
      if(mode==='begin'&&call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.begin)return {rowCount:0,rows:[]};
      if(mode==='rows'&&call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows)return result({inserted_count:'6000001'});
      if(mode==='complete'&&call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.complete)return result({seed_count:'3'});
      if(!afterComplete||header?.status!=='complete')return null;
      if(mode==='claim'&&call.text.includes('generation-fence'))return {rowCount:0,rows:[]};
      if(mode==='stock'&&call.text.includes('job-stock:read'))return {rowCount:0,rows:[]};
      if(mode==='cache'&&call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.read)return result({...header,binding_sha256:'e'.repeat(64)});
    });
    await assert.rejects(f.store().prepare(),/claim_lost|unavailable|invalid_result|population_limit|changed_index/);
  }
});

test('closed options, pre-cancellation, settlement and stock admission remain independent',async()=>{
  const f=fixture();for(const bad of [{...options,source_rows:[]},{...options,cache_generation:id},
    {...options,get subjectIntent(){throw Error('getter must not run');}}])
    assert.throws(()=>createNeighborhoodFrozenJobSourceSeeds(f.client,bad),/invalid_input/);
  assert.equal(f.calls.length,0);const controller=new AbortController();controller.abort();
  await assert.rejects(createNeighborhoodFrozenJobSourceSeeds(f.client,{...options,signal:controller.signal}).prepare(),/cancelled/);
  assert.equal(f.calls.length,0);
  let release,started;const pending=new Promise(r=>{release=r;}),ready=new Promise(r=>{started=r;});
  const slow=fixture(async({call})=>{if(call.text===NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows){started();await pending;}}),store=slow.store();
  const first=store.prepare();await ready;await assert.rejects(store.read(),/concurrent_operation/);release();await first;
  const missing=fixture(({call})=>call.text.includes('job-stock:read')?{rowCount:0,rows:[]}:null);
  await assert.rejects(missing.store().prepare(),/unavailable/);assert.ok(!missing.calls.some(c=>c.text.includes('job-seeds:')));
});

test('schema enforces exact set completeness, immutable publication, indexed job/generation lineage and no activation',()=>{
  const name='20261111_custom_cohort_prepared_source_seeds.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261110_neighborhood_shared_typed_generations.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.match(sql,/PRIMARY KEY\(operation_id,source_record_id\)/);
  assert.match(sql,/REFERENCES app.neighborhood_custom_cohort_job_stocks\(operation_id,generation_id\)/);
  assert.match(sql,/expected EXCEPT SELECT source_record_id FROM actual/);
  assert.match(sql,/actual EXCEPT SELECT source_record_id FROM expected/);
  assert.match(sql,/actual_count<>NEW.seed_count/);assert.match(sql,/OLD.status<>'building' OR NEW.status<>'complete'/);
  assert.match(sql,/REFERENCING NEW TABLE AS new_rows/);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DELETE FROM|UPDATE core\.|UPDATE gis\./);
  for(const m of sql.matchAll(/CREATE (?:TRIGGER|FUNCTION) ([a-z_.]+)/g))assert.ok(Buffer.byteLength(m[1].replace(/^app\./,''))<=63);
  assert.doesNotMatch(NEIGHBORHOOD_FROZEN_JOB_SEED_SQL.rows,/close_date|closing_date|is_resolved|RECURSIVE|raw_payload/);
});
