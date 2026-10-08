import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodFrozenJobStock } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStock.js';
import { createNeighborhoodFrozenJobStockOriginals, NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,
  NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStockOriginals.js';
import { neighborhoodFrozenSpatialDefinition } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';
import { createNeighborhoodFrozenJobSourceIdentity } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobSourceIdentity.js';
import { NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL, NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';

const id='70000000-0000-4000-8000-000000000001',date='2026-10-07T00:00:00.000000Z';
const claim={operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
const scope={organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'STOCK-A'};
const options={claim,scope,actorUserId:'70000000-0000-4000-8000-000000000005',
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',coordinate_encoding:'decimal_string_v1',
    coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
  subjectIntent:{content_sha256:'b'.repeat(64),canonical_utf8_bytes:'100'},checkBudget(){}};
const result=row=>({rowCount:1,rows:[row]});
function fixture(hook=()=>{},initial=false) {
  const calls=[];let stored=initial;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,completed_at:date,parcel_count:'60002',sale_count:'0',group_count:'1'};
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,completed_at:date,
    row_count:'60002',payload_utf8_bytes:'6000200',layer_counts:Object.fromEntries(
      ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'].map(kind=>[kind,
        {row_count:kind==='parcels'?'60002':'0',payload_utf8_bytes:kind==='parcels'?'6000200':'0'}]))};
  const original={generation_id:id,source_format_version:1,source_snapshot:'1:2:',source_transaction_started_at:date,completed_at:date,
    row_count:header.row_count,payload_utf8_bytes:header.payload_utf8_bytes,layer_counts:header.layer_counts};
  const definition=neighborhoodFrozenSpatialDefinition(claim,id,options.geometryInput,options.discovery);
  const stock={status:'complete',definition,definition_sha256:assessmentEvidenceDigest(definition),source_original_sha256:assessmentEvidenceDigest(original),
    subject_intent_sha256:options.subjectIntent.content_sha256,subject_intent_utf8_bytes:'100',
    parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',unlocatable_global_parcels:'1'};
  const client={async query(config,values){const text=typeof config==='string'?config:config.text;
    const parameters=typeof config==='string'?values:config.values;calls.push({text,values:parameters});
    const supplied=await hook({text,values:parameters,calls,stock,header});if(supplied)return supplied;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence'))return result({operation_id:id});
    if(text.includes('generation-read'))return result(pin);
    if(text.includes('frozen-spatial:header'))return result(header);
    if(text.includes('job-stock:read'))return stored?result(stock):{rowCount:0,rows:[]};
    if(text.includes('frozen-spatial:validity'))return result({unlocatable_global_parcels:'1',invalid_geometries:'0'});
    if(text.includes('frozen-spatial:counts'))return result({parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',subject_included:true});
    if(text.includes('frozen-spatial:parcels')){const page_json=JSON.stringify([{object_id:'1',account_id:'STOCK-A',geometry_sha256:'c'.repeat(64),source_record_hash:null}]);
      return result({page_json,page_count:1,candidate_count:1,next_cursor:'1',page_utf8_bytes:Buffer.byteLength(page_json)});}
    if(text.includes('job-stock:complete')){stored=true;return result({operation_id:id});}
    if(text.includes('job-stock:begin')||text.includes('job-stock:parcels')||text.includes('job-stock:accounts'))return {rowCount:60001,rows:[]};
    throw Error(`unexpected ${text.slice(0,80)}`);
  }};
  return {calls,client,store:createNeighborhoodFrozenJobStock(client,options)};
}
test('exact >50k stock is materialized wholly in SQL, then freshly reopened without spatial recomputation',async()=>{
  const f=fixture(),first=await f.store.prepare();
  assert.equal(first.population.parcel_count,'60001');assert.equal(first.population.unassociated_parcel_count,'1');
  assert.equal(first.population.unlocatable_global_parcels,'1');assert.equal(first.authority,'not_established');
  assert.equal(first.coverage,'exact_original_stock_only');assert.ok(!Object.hasOwn(first,'account_ids'));
  assert.equal(f.calls.filter(call=>call.text.includes('job-stock:parcels')).length,1);
  const from=f.calls.length;
  assert.deepEqual(await createNeighborhoodFrozenJobStock(f.client,options).prepare(),first);
  assert.deepEqual(await createNeighborhoodFrozenJobStock(f.client,options).read(),first);
  assert.ok(!f.calls.slice(from).some(call=>/ST_DWithin|frozen-spatial:counts|job-stock:begin/.test(call.text)));
  assert.ok(f.calls.slice(from).some(call=>call.text.includes('generation-fence')));
  assert.ok(f.calls.every(call=>!['COMMIT','BEGIN','ROLLBACK'].includes(call.text)),'owner alone commits or rolls back');
});
test('missing retained stock never rebuilds on read; changed original/definition/intent/counts refuse',async()=>{
  const missing=fixture();await assert.rejects(missing.store.read(),/unavailable/);
  assert.ok(!missing.calls.some(call=>call.text.includes('ST_DWithin')||call.text.includes('job-stock:begin')));
  for(const change of [row=>row.definition_sha256='d'.repeat(64),row=>row.source_original_sha256='d'.repeat(64),
    row=>row.subject_intent_utf8_bytes='101',row=>row.subject_intent_sha256='d'.repeat(64),row=>row.parcel_count='10',
    row=>row.status='building']) {
    const f=fixture(({text,stock})=>{if(text.includes('job-stock:read')){const row=structuredClone(stock);change(row);return result(row);}},true);
    await assert.rejects(f.store.read(),/conflict/);
  }
});
test('lost/cancelled claim or failed complete ACK returns no stock for owner rollback',async()=>{
  for(const hook of [({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null,
    ({text})=>text.includes('job-stock:complete')?{rowCount:0,rows:[]}:null]) {
    const f=fixture(hook);await assert.rejects(f.store.prepare(),/claim_lost|unavailable/);
  }
  let fences=0;
  const ending=fixture(({text})=>text.includes('generation-fence')&&++fences===4?{rowCount:0,rows:[]}:null,true);
  await assert.rejects(ending.store.read(),/claim_lost/);
});
test('one serial stock lane holds until unsettled SQL resolves and cancelled owner budget refuses work',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const f=fixture(async({text})=>{if(text.includes('job-stock:read'))await pending;},true);
  const first=f.store.read();await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.store.read(),/concurrent_operation/);release();await first;
  const cancelled=fixture();const store=createNeighborhoodFrozenJobStock(cancelled.client,{...options,checkBudget(){throw Error('cancelled');}});
  await assert.rejects(store.prepare(),/cancelled/);assert.equal(cancelled.calls.length,0);
});
test('stock arguments detach before awaits; proxies/accessors/coercion and arbitrary rosters refuse',async()=>{
  const f=fixture(()=>{},true);
  for(const bad of [new Proxy(options,{}),{...options,account_ids:['untrusted']},
    {...options,subjectIntent:{...options.subjectIntent,get content_sha256(){throw Error('getter');}}},
    {...options,subjectIntent:{...options.subjectIntent,content_sha256:{toString(){throw Error('coercion');}}}}])
    assert.throws(()=>createNeighborhoodFrozenJobStock(f.client,bad),/invalid_input/);
  const mutable=structuredClone({...options,checkBudget:undefined});mutable.checkBudget=()=>{};
  const store=createNeighborhoodFrozenJobStock(f.client,mutable);mutable.geometryInput.coordinates[0]='-97';mutable.scope.report_file_id=id;
  assert.equal((await store.read()).definition_sha256,assessmentEvidenceDigest(neighborhoodFrozenSpatialDefinition(claim,id,options.geometryInput,options.discovery)));
});
test('additive stock migration has exact indexes, original FKs and immutable publication without changing limits/routes',()=>{
  const name='20261107_custom_cohort_frozen_job_stock.sql';
  const registry=readFileSync(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf(name)>registry.indexOf('20261106_neighborhood_frozen_spatial_index.sql'));
  const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
  assert.match(sql,/REFERENCES app.neighborhood_frozen_source_rows\(generation_id,kind,row_key\)/);
  assert.match(sql,/PRIMARY KEY\(operation_id,object_id\)/);assert.match(sql,/PRIMARY KEY\(operation_id,account_id\)/);
  assert.match(sql,/CREATE INDEX neighborhood_cohort_stock_parcels_original_idx\s+ON app.neighborhood_custom_cohort_stock_parcels\(generation_id,kind,row_key\)/);
  assert.match(sql,/REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT/);
  for(const match of sql.matchAll(/CREATE (?:INDEX|TRIGGER|FUNCTION) ([a-z_.]+)/g))assert.ok(Buffer.byteLength(match[1].replace(/^app\./,''))<=63);
  for(const relation of ['neighborhood_custom_cohort_stock_parcels','neighborhood_custom_cohort_stock_accounts'])
    for(const suffix of ['_insert_guard','_immutable'])assert.ok(Buffer.byteLength(relation+suffix)<=63);
  assert.doesNotMatch(sql,/DISABLE TRIGGER|DROP TABLE|DELETE FROM|UPDATE core\.|UPDATE gis\./);
});

function originalsFixture(hook=()=>{},population={parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1'}) {
  const f=fixture(async call=>{
    Object.assign(call.stock,population);
    const supplied=await hook(call);if(supplied)return supplied;
    if(call.text.includes('stock-originals:page')) {
      const after=call.values[2]===''?-1:Number(call.values[2]),size=Number(population.parcel_count);
      const count=Math.min(250,size-after-1),last=count===0?null:String(after+count);
      return result({page_count:count,candidate_count:count,unassociated_count:count&&after+count===size-1?Number(population.unassociated_parcel_count):0,
        invalid_count:0,last_object_id:last});
    }
    if(call.text.includes('stock-originals:totals'))return result({...population,invalid_accounts:'0'});
    return null;
  },true);
  return {...f,originals:()=>createNeighborhoodFrozenJobStockOriginals(f.client,options)};
}

test('all 60001 geographic originals use fresh bounded steps, include key zero and reconcile exact end counts',async()=>{
  const f=originalsFixture();let progress=null,done=false,steps=0;
  while(!done){const step=await f.originals().step(progress);progress=step.progress;done=step.all_parcels_verified;
    assert.equal(step.authority,'not_established');assert.equal(step.coverage,'geographic_originals_only');
    assert.ok(Buffer.byteLength(JSON.stringify(progress))<400);assert.equal(step.advanced,true);assert.ok(++steps<=242);}
  assert.equal(steps,241);assert.equal(progress.after_object_id,'60000');assert.equal(progress.verified_parcels,60001);
  assert.equal(progress.verified_unassociated,1);
  const pages=f.calls.filter(call=>call.text.includes('stock-originals:page'));
  assert.equal(pages[0].values[2],'','no synthetic cursor zero silently loses legitimate object_id zero');
  assert.equal(f.calls.filter(call=>call.text.includes('stock-originals:totals')).length,1);
  assert.ok(!f.calls.some(call=>/ST_DWithin|job-stock:begin|job-stock:parcels/.test(call.text)));
  const from=f.calls.length;assert.equal((await f.originals().step(progress)).advanced,false);
  assert.ok(!f.calls.slice(from).some(call=>call.text.includes('stock-originals:')));
});

test('a full 250-row original page requires the separate exact terminal query',async()=>{
  const f=originalsFixture(()=>{},{parcel_count:'250',account_count:'249',unassociated_parcel_count:'1'});
  const first=await f.originals().step(null);assert.equal(first.all_parcels_verified,false);
  const end=await f.originals().step(first.progress);assert.equal(end.all_parcels_verified,true);
  assert.equal(end.progress.verified_parcels,250);assert.equal(end.progress.after_object_id,'249');
});

test('a byte-limited geographic prefix cannot claim end just because it has fewer than 250 rows',async()=>{
  const f=originalsFixture(({text,values})=>text.includes('stock-originals:page')&&values[2]===''?
    result({page_count:125,candidate_count:250,unassociated_count:0,invalid_count:0,last_object_id:'124'}):null,
    {parcel_count:'250',account_count:'249',unassociated_parcel_count:'1'});
  const first=await f.originals().step(null);assert.equal(first.all_parcels_verified,false);
  const next=await f.originals().step(first.progress);assert.equal(next.all_parcels_verified,true);
  assert.equal(next.progress.verified_parcels,250);
});

test('missing/changed original representation and counts refuse rather than publish partial geographic proof',async()=>{
  const fields=[row=>row.invalid_count=1,row=>row.page_count=251,row=>row.last_object_id='-1',
    row=>row.last_object_id=null,row=>row.unassociated_count=251];
  for(const change of fields){const f=originalsFixture(({text})=>{
    if(text.includes('stock-originals:page')){const row={page_count:250,candidate_count:250,unassociated_count:0,invalid_count:0,last_object_id:'249'};change(row);return result(row);}});
    await assert.rejects(f.originals().step(null),/original_mismatch|invalid_progress/);}
  for(const change of [row=>row.parcel_count='4',row=>row.account_count='1',row=>row.unassociated_parcel_count='0',row=>row.invalid_accounts='1']){
    const f=originalsFixture(({text})=>{if(text.includes('stock-originals:totals')){
      const row={parcel_count:'3',account_count:'2',unassociated_parcel_count:'1',invalid_accounts:'0'};change(row);return result(row);}},
    {parcel_count:'3',account_count:'2',unassociated_parcel_count:'1'});
    await assert.rejects(f.originals().step(null),/stock_count_mismatch/);
  }
  const omitted=originalsFixture(({text})=>text.includes('stock-originals:page')?
    result({page_count:0,candidate_count:0,unassociated_count:0,invalid_count:0,last_object_id:null}):null);
  await assert.rejects(omitted.originals().step(null),/stock_count_mismatch/);
});

test('geographic checkpoint cannot change stock, counts, continuation or scalar identity',async()=>{
  const f=originalsFixture(),first=await f.originals().step(null),saved=first.progress;
  for(const change of [p=>p.stock_sha256='e'.repeat(64),p=>p.verified_parcels=60002,
    p=>p.verified_unassociated=2,p=>p.done=true]){
    const p={...saved};change(p);await assert.rejects(f.originals().step(p),/stock_changed/);
  }
  for(const bad of [new Proxy(saved,{}),{...saved,grant:true},{...saved,after_object_id:9223372036854775807},
    {...saved,get verified_parcels(){throw Error('getter');}}, {...saved,after_object_id:'9223372036854775808'}])
    await assert.rejects(f.originals().step(bad),/invalid_input|invalid_progress/);
  const repeated=originalsFixture(({text})=>text.includes('stock-originals:page')?
    result({page_count:1,candidate_count:1,unassociated_count:0,invalid_count:0,last_object_id:'249'}):null);
  await assert.rejects(repeated.originals().step(saved),/invalid_progress/);
});

test('geographic verification detaches continuation and refuses overlap, lost claim or cancelled budget',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let waiting=false;
  const f=originalsFixture(async({text})=>{if(waiting&&text.includes('job-stock:read'))await pending;});
  const first=await f.originals().step(null),mutable={...first.progress};waiting=true;
  const reader=f.originals(),running=reader.step(mutable);mutable.after_object_id='900';mutable.verified_parcels=1;
  await new Promise(resolve=>setImmediate(resolve));await assert.rejects(reader.step(null),/concurrent_operation/);
  release();const second=await running;assert.equal(second.progress.after_object_id,'499');assert.equal(second.progress.verified_parcels,500);
  const lost=originalsFixture(({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.originals().step(null),/claim_lost/);
  const cancelled=createNeighborhoodFrozenJobStockOriginals(f.client,{...options,checkBudget(){throw Error('cancelled');}});
  const from=f.calls.length;await assert.rejects(cancelled.step(null),/cancelled/);assert.equal(f.calls.length,from);
});

test('fixed geographic verification plans preserve NULL originals and normalize Polygon EWKB without spatial recomputation',()=>{
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/LEFT JOIN app\.neighborhood_frozen_source_rows/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/ORDER BY stock\.object_id LIMIT 250/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/ST_AsEWKB\(ST_Multi\(ST_GeomFromEWKB/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL,/payload \? 'account_id'/);
  assert.match(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL,/FULL JOIN recorded USING\(account_id\)/);
  assert.doesNotMatch(NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_PAGE_SQL+NEIGHBORHOOD_FROZEN_STOCK_ORIGINAL_TOTALS_SQL,
    /ST_DWithin|FROM gis\.|FROM core\.|jsonb_agg|INSERT|UPDATE|DELETE/);
});

const identityGraph={root:{content_sha256:'d'.repeat(64),canonical_utf8_bytes:'100'},
  layer_counts:{parcels:60001,accounts:60000,source_records:1,sales:2,sale_links:2,sync_state:1,sync_runs:1}};
function identityFixture(hook=()=>{},graph=identityGraph){
  const f=fixture(async call=>{
    const supplied=await hook(call);if(supplied)return supplied;
    if(call.text.includes('job-identity:coverage'))return result({missing_account_count:0});
    const kind=Object.keys(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL).find(k=>call.text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL[k]);
    if(kind){const total=graph.layer_counts[kind],previous=call.values[2];
      const seen=previous?(kind==='accounts'?Number(previous.slice(1)):Number(previous)):0;
      const count=Math.min(250,total-seen),last=seen+count;
      return result({page_count:count,candidate_count:count,invalid_count:0,
        unknown_origin_count:kind==='parcels'?count:0,
        last_row_key:count?kind==='accounts'?`A${String(last).padStart(6,'0')}`:kind==='sync_state'?'dcad_parcels'
          :kind==='sync_runs'?id:String(last):null});}
  },true);
  return {...f,identity:()=>createNeighborhoodFrozenJobSourceIdentity(f.client,options,graph)};
}

test('identity DATA validation traverses >50k exact rows using fresh bounded aggregate steps, never dense identifiers',async()=>{
  const f=identityFixture();let progress=null,done=false,steps=0;
  while(!done){const step=await f.identity().step(progress);progress=step.progress;done=step.all_layers_verified;
    assert.equal(step.authority,'not_established');assert.equal(step.coverage,'identity_and_one_hop_associations_only');
    assert.ok(Buffer.byteLength(JSON.stringify(progress))<450);assert.ok(++steps<500);}
  assert.equal(steps,487);assert.equal(progress.unknown_parcel_origins,60001);assert.equal(progress.missing_account_count,0);
  const from=f.calls.length;assert.equal((await f.identity().step(progress)).advanced,false);
  assert.ok(!f.calls.slice(from).some(c=>c.text.includes('job-identity:')));
  assert.ok(!f.calls.some(c=>/ST_DWithin|job-stock:begin|frozen-spatial:counts/.test(c.text)));
});

test('identity steps preserve byte-limited prefixes, explicit absent-account coverage, and strict independent layer counts',async()=>{
  const small={...identityGraph,layer_counts:{parcels:2,accounts:0,source_records:0,sales:0,sale_links:0,sync_state:0,sync_runs:0}};
  let first=true;const f=identityFixture(({text})=>{
    if(text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels&&first){first=false;return result({page_count:1,candidate_count:2,
      invalid_count:0,unknown_origin_count:1,last_row_key:'1'});}
    if(text.includes('job-identity:coverage'))return result({missing_account_count:7});
  },small);
  let p=(await f.identity().step(null)).progress;assert.equal(p.kind_index,0);assert.equal(p.layer_rows,1);
  p=(await f.identity().step(p)).progress;assert.equal(p.kind_index,1);assert.equal(p.layer_rows,0);
  for(let i=0;i<6;i++)p=(await f.identity().step(p)).progress;
  assert.equal(p.kind_index,7);assert.equal(p.missing_account_count,7);assert.equal(p.unknown_parcel_origins,2);
  const wrong=identityFixture(({text})=>text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels
    ?result({page_count:1,candidate_count:1,invalid_count:0,unknown_origin_count:0,last_row_key:'1'}):null,small);
  await assert.rejects(wrong.identity().step(null),/layer_count_mismatch/);
});

test('identity malformed/foreign continuations and aggregate mismatches refuse without pretending typed acquisition',async()=>{
  const f=identityFixture(),first=await f.identity().step(null);
  for(const patch of [{binding_sha256:'e'.repeat(64)},{layer_rows:60002},{after:'-1'},{kind_index:8},
    {missing_account_count:0},{unknown_parcel_origins:60002},{extra:true}])
    await assert.rejects(f.identity().step({...first.progress,...patch}),/invalid_input|invalid_progress|binding_changed/);
  for(const patch of [{invalid_count:1},{candidate_count:0},{page_count:251},{last_row_key:null},
    {unknown_origin_count:251},{page_count:0,last_row_key:null,candidate_count:1}]){
    const bad=identityFixture(({text})=>text===NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.parcels
      ?result({page_count:250,candidate_count:250,invalid_count:0,unknown_origin_count:0,last_row_key:'250',...patch}):null);
    await assert.rejects(bad.identity().step(null),/identity_mismatch/);
  }
  let invoked=false;const getter={...first.progress};Object.defineProperty(getter,'after',{enumerable:true,get(){invoked=true;return '250';}});
  await assert.rejects(f.identity().step(getter),/invalid_input/);assert.equal(invoked,false);
  await assert.rejects(f.identity().step(new Proxy(first.progress,{})),/invalid_input/);
  const cancelled=createNeighborhoodFrozenJobSourceIdentity(f.client,{...options,checkBudget(){throw Error('cancelled');}},identityGraph);
  const from=f.calls.length;await assert.rejects(cancelled.step(null),/cancelled/);assert.equal(f.calls.length,from);
  const lost=identityFixture(({text})=>text.includes('generation-fence')?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.identity().step(null),/claim_lost/);
});

test('fixed identity scope uses original stock and one-hop seeds, preserves NULL associations and refuses duplicate package positions',()=>{
  for(const sql of Object.values(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL)){
    assert.match(sql,/neighborhood_custom_cohort_stock_accounts WHERE operation_id=\$2::uuid/);
    assert.match(sql,/LIMIT 250/);assert.match(sql,/prefix_bytes<=8000000/);
    assert.doesNotMatch(sql,/FROM core\.|FROM gis\.|ST_DWithin|jsonb_agg|INSERT|UPDATE|DELETE|sale_price.*::(?:float|double)/);
  }
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.sale_links,/other\.source_record_id=original\.source_record_id/);
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_SQL.sales,/IS NOT DISTINCT FROM original\.source_record_id::text/);
  assert.match(NEIGHBORHOOD_FROZEN_JOB_IDENTITY_COVERAGE_SQL,/NOT EXISTS/);
});
