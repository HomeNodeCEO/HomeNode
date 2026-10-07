import assert from 'node:assert/strict';
import test from 'node:test';
import { createNeighborhoodFrozenSourceClosurePages,NEIGHBORHOOD_FROZEN_CLOSURE_SQL,
  NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourceClosurePages.js';

const id='70000000-0000-4000-8000-000000000001',date='2026-10-07T00:00:00.000000Z';
const options={claim:{operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1},
  scope:{organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'STOCK-A'},
  actorUserId:'70000000-0000-4000-8000-000000000005',
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',coordinate_encoding:'decimal_string_v1',
    coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
const result=row=>({rowCount:1,rows:[row]});
function fixture(hook=()=>{}) {
  const calls=[];let headers=0,fences=0;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,completed_at:date,parcel_count:'1',sale_count:'1',group_count:'1'};
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,completed_at:date,
    row_count:'7',payload_utf8_bytes:'700',layer_counts:Object.fromEntries(Object.keys(NEIGHBORHOOD_FROZEN_CLOSURE_SQL)
      .map(kind=>[kind,{row_count:'1',payload_utf8_bytes:'100'}]))};
  const page=rows=>{const page_json=JSON.stringify(rows);return {page_json,page_count:rows.length,candidate_count:rows.length,
    next_cursor:rows.at(-1)?.row_key??rows.at(-1)?.object_id??'',page_utf8_bytes:Buffer.byteLength(page_json)};};
  const client={async query(config){const text=config.text;calls.push(config);
    const supplied=await hook({text,config,calls,headers,fences,header,page});if(supplied)return supplied;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence')){fences++;return result({operation_id:id});}
    if(text.includes('generation-read'))return result(pin);
    if(text.includes('frozen-spatial:header')){headers++;return result(structuredClone(header));}
    if(text.includes('frozen-spatial:validity'))return result({unlocatable_global_parcels:'0',invalid_geometries:'0'});
    if(text.includes('frozen-spatial:counts'))return result({parcel_count:'1',account_count:'1',unassociated_parcel_count:'0',subject_included:true});
    if(text.includes('frozen-spatial:parcels'))return result(page([{object_id:'1',account_id:'STOCK-A',geometry_sha256:'b'.repeat(64),source_record_hash:null}]));
    if(text.includes('frozen-closure:'))return result(page([{row_key:'1',payload_text:'{"price":"9007199254740993","date":"2010-01-01"}'}]));
    throw Error(`unexpected ${text.slice(0,60)}`);
  }};
  return {calls,client,reader:createNeighborhoodFrozenSourceClosurePages(client,options)};
}

test('actual pinned spatial reader surrounds each source page; raw original decimals/dates survive',async()=>{
  const f=fixture(),page=await f.reader.page({kind:'source_records',cursor:'',rowLimit:2});
  assert.equal(page.original.generation_id,id);assert.equal(page.end_of_layer,true);
  assert.equal(page.additional_cadastral_accounts,false);assert.equal(page.authority,'not_established');assert.equal(page.coverage,'page_only');
  assert.match(page.rows[0].payload_text,/9007199254740993/);assert.match(page.rows[0].payload_text,/2010-01-01/);
  assert.equal(f.calls.filter(x=>x.text.includes('generation-fence')).length,8);
  assert.equal(f.calls.filter(x=>x.text.includes('frozen-spatial:header')).length,4);
  assert.equal(f.calls.filter(x=>x.text.includes('frozen-closure:')).length,1);
  assert.deepEqual(f.calls.find(x=>x.text.includes('frozen-closure:')).values,
    [id,'-96.7','32.9','8046.72','',2,NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS.page_utf8_bytes]);
  assert.ok(Object.isFrozen(page.rows)&&Object.isFrozen(page.rows[0]));
});

test('missing pin, autocommit or outside subject refuses before source rows are queried',async()=>{
  let tx=0;
  for(const hook of [
    ({text})=>text.includes('generation-transaction')?result({transaction_id:String(++tx)}):null,
    ({text})=>text.includes('generation-read')?{rowCount:0,rows:[]}:null,
    ({text})=>text.includes('frozen-spatial:counts')?result({parcel_count:'1',account_count:'1',unassociated_parcel_count:'0',subject_included:false}):null,
  ]){const f=fixture(hook);await assert.rejects(f.reader.page({kind:'sales',cursor:''}),/required|unavailable|outside/);
    assert.equal(f.calls.some(x=>x.text.includes('frozen-closure:')),false);}
});

test('ending claim/header loss, corrupted payloads, byte overflow and read ACK loss never deliver a source page',async()=>{
  for(const hook of [
    ({text,fences})=>text.includes('generation-fence')&&fences>=4?{rowCount:0,rows:[]}:null,
    ({text,headers,header})=>text.includes('frozen-spatial:header')&&headers>=2?result({...header,source_snapshot:'2:3:'}):null,
    ({text,page})=>text.includes('frozen-closure:')?result({...page([]),candidate_count:1}):null,
    ({text,page})=>text.includes('frozen-closure:')?result(page([{row_key:'1',payload_text:'[1]'}])):null,
    ({text,page})=>text.includes('frozen-closure:')?result({...page([]),page_utf8_bytes:NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS.page_utf8_bytes+1}):null,
    ({text})=>{if(text.includes('frozen-closure:'))throw Error('synthetic source read ACK lost');},
  ])await assert.rejects(fixture(hook).reader.page({kind:'sales',cursor:''}),/claim_lost|source_changed|page_|ACK lost/);
});

test('scoped closure carries a valid escaped original above the former byte ceiling',async()=>{
  const payload_text=JSON.stringify({legal_description:'\\'.repeat(480_000)});
  const f=fixture(({text,page})=>text.includes('frozen-closure:')?result(page([{row_key:'1',payload_text}])):null);
  const page=await f.reader.page({kind:'accounts',cursor:'',rowLimit:2});
  assert.equal(page.rows[0].payload_text,payload_text);
  assert.ok(page.page_utf8_bytes>1_500_000);
  assert.ok(page.page_utf8_bytes<=NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS.page_utf8_bytes);
});

test('closed cursor/plan admission, cancellation and aggregate budgets hold before SQL and through settlement',async()=>{
  const f=fixture();
  for(const bad of [{kind:'sales',cursor:'',source:'core.sales'},{kind:'__proto__',cursor:''},{kind:'sales',cursor:'1;DROP'},
    {kind:'sales',get cursor(){throw Error('getter');}},{kind:'sales',cursor:'',rowLimit:251}])
    await assert.rejects(f.reader.page(bad),/neighborhood_frozen_closure_/);
  assert.equal(f.calls.length,0);
  const controller=new AbortController();controller.abort();
  await assert.rejects(createNeighborhoodFrozenSourceClosurePages(f.client,{...options,signal:controller.signal})
    .page({kind:'sales',cursor:''}),/cancelled/);assert.equal(f.calls.length,0);
  for(let i=0;i<NEIGHBORHOOD_FROZEN_CLOSURE_LIMITS.pages;i++)await f.reader.page({kind:'sales',cursor:''});
  await assert.rejects(f.reader.page({kind:'sales',cursor:''}),/operation_limit/);
  let release,start;const waiting=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{start=resolve;});
  const pending=fixture(async({text})=>{if(text.includes('frozen-closure:')){start();await waiting;}});
  const first=pending.reader.page({kind:'sales',cursor:''});await ready;
  await assert.rejects(pending.reader.page({kind:'sales',cursor:''}),/concurrent_read/);release();await first;
});

test('seven fixed plans seed only original stock, retain all seeded links/legacy dates and restrict sync originals',()=>{
  for(const sql of Object.values(NEIGHBORHOOD_FROZEN_CLOSURE_SQL)){
    assert.match(sql,/selected_accounts AS MATERIALIZED/);assert.match(sql,/ST_DWithin\(geom::geography/);
    assert.match(sql,/seeds AS MATERIALIZED/);assert.match(sql,/original.kind IN \('source_records','sales','sale_links'\)/);
    assert.match(sql,/prefix_bytes\+2<=\$7::bigint/);assert.doesNotMatch(sql,/core\.|gis\.|close_date|closing_date|is_resolved|RECURSIVE|raw_payload/);
  }
  assert.match(NEIGHBORHOOD_FROZEN_CLOSURE_SQL.sales,/original.source_record_id IS NULL AND EXISTS/);
  assert.match(NEIGHBORHOOD_FROZEN_CLOSURE_SQL.accounts,/selected.account_id=original.account_id/);
  assert.match(NEIGHBORHOOD_FROZEN_CLOSURE_SQL.sync_state,/original.row_key='dcad_parcels'/);
  assert.match(NEIGHBORHOOD_FROZEN_CLOSURE_SQL.sync_runs,/state.payload->>'last_run_id'=original.row_key/);
});
