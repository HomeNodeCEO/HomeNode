import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessmentEvidenceDigest } from '../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodFrozenJobStock } from '../src/services/neighborhoodAssessment/neighborhoodFrozenJobStock.js';
import { neighborhoodFrozenSpatialDefinition } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';

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
