import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { createNeighborhoodFrozenSpatialPages, NEIGHBORHOOD_FROZEN_SPATIAL_LIMITS,
  NEIGHBORHOOD_FROZEN_SPATIAL_SQL } from '../src/services/neighborhoodAssessment/neighborhoodFrozenSpatialPages.js';

const id='70000000-0000-4000-8000-000000000001', date='2026-10-07T00:00:00.000000Z';
const claim={operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
const scope={organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'STOCK-A'};
const options={claim,scope,actorUserId:'70000000-0000-4000-8000-000000000005',
  geometryInput:{geometry_version:1,type:'Point',crs:'EPSG:4326',axis_order:'longitude_latitude',coordinate_encoding:'decimal_string_v1',
    coordinates:['-96.7','32.9'],source_sha256:'a'.repeat(64)},discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'}};
const result=row=>({rowCount:1,rows:[row]});
function fixture(hook=()=>{}) {
  const calls=[];let headers=0;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,completed_at:date,parcel_count:'60001',sale_count:'0',group_count:'1'};
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,completed_at:date,
    row_count:'60002',payload_utf8_bytes:'6000200',layer_counts:Object.fromEntries(
      ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'].map(kind=>[kind,
        {row_count:kind==='parcels'?'60002':'0',payload_utf8_bytes:kind==='parcels'?'6000200':'0'}]))};
  const population={parcel_count:'60001',account_count:'60000',unassociated_parcel_count:'1',subject_included:true};
  const parcel=(object_id,account_id='STOCK-A')=>({object_id,account_id,geometry_sha256:'b'.repeat(64),source_record_hash:null});
  const page=(rows,last)=>{const page_json=JSON.stringify(rows);return {page_json,page_count:rows.length,candidate_count:rows.length,
    next_cursor:last??rows.at(-1)?.object_id??rows.at(-1)?.account_id??'',page_utf8_bytes:Buffer.byteLength(page_json)};};
  const client={async query(config){const text=config.text;calls.push(config);
    const supplied=await hook({text,config,calls,headers,header,pin,population,page,parcel});if(supplied)return supplied;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence'))return result({operation_id:id});
    if(text.includes('generation-read'))return result(pin);
    if(text.includes('frozen-spatial:header')){headers++;return result(structuredClone(header));}
    if(text.includes('frozen-spatial:validity'))return result({unlocatable_global_parcels:'1',invalid_geometries:'0'});
    if(text.includes('frozen-spatial:counts'))return result(population);
    if(text.includes('frozen-spatial:parcels'))return result(page([parcel('2'),parcel('10',null)]));
    if(text.includes('frozen-spatial:accounts'))return result(page([{account_id:'STOCK-A',parcel_count:'2'}]));
    throw Error(`unexpected ${text.slice(0,60)}`);
  }};
  return {client,calls,pages:createNeighborhoodFrozenSpatialPages(client,options)};
}

test('reads >50k exact frozen stock counts with bounded native-key pages, not dense account arrays',async()=>{
  const f=fixture(),p=await f.pages.page({kind:'parcels',cursor:'1',rowLimit:2});
  assert.equal(p.population.parcel_count,'60001');assert.equal(p.next_cursor,'10');assert.equal(p.end_of_roster,false);
  assert.equal(p.population.unlocatable_global_parcels,'1');assert.equal(p.population.unassociated_parcel_count,'1');
  assert.equal(p.authority,'not_established');assert.equal(p.coverage,'page_only');assert.equal(p.rows[1].account_id,null);
  assert.equal(p.definition.discovery.radius_metres,'8046.72');assert.equal(p.definition.generation_id,id);
  assert.ok(Object.isFrozen(p.rows)&&Object.isFrozen(p.definition.geometry_input.coordinates)&&Object.isFrozen(p.population));
  assert.ok(f.calls.every(x=>x.query_timeout<=5000));
  assert.ok(f.calls.every(x=>!/generation-active|generation-pin|INSERT|UPDATE|COMMIT|gis\.|core\./.test(x.text)));
  const source=f.calls.find(x=>x.text.includes('frozen-spatial:parcels'));
  assert.deepEqual(source.values,[id,'-96.7','32.9','8046.72','1',2,128000]);
  const accountPage=await f.pages.page({kind:'accounts',cursor:'',rowLimit:3});
  assert.deepEqual(accountPage.rows,[{account_id:'STOCK-A',parcel_count:'2'}]);assert.equal(accountPage.end_of_roster,true);
  assert.equal(accountPage.definition_sha256,p.definition_sha256);
});

test('invalid/global unknown geometry is not silently classified as outside; corrupt populations/pages refuse',async()=>{
  for(const [kind,hook] of [
    ['parcels',({text})=>text.includes('frozen-spatial:validity')?result({unlocatable_global_parcels:'1',invalid_geometries:'1'}):null],
    ['parcels',({text,population})=>text.includes('frozen-spatial:counts')?result({...population,account_count:'60003'}):null],
    ['parcels',({text,page,parcel})=>text.includes('frozen-spatial:parcels')?result(page([parcel('10'),parcel('2')])):null],
    ['parcels',({text,page,parcel})=>text.includes('frozen-spatial:parcels')?result({...page([parcel('2')]),page_utf8_bytes:128001}):null],
    ['parcels',({text,page})=>text.includes('frozen-spatial:parcels')?result({...page([]),candidate_count:1}):null],
    ['parcels',({text,headers,header})=>text.includes('frozen-spatial:header')&&headers===1?result({...header,source_snapshot:'2:3:'}):null],
    ['accounts',({text,page})=>text.includes('frozen-spatial:accounts')?result(page([{account_id:'STOCK-A',parcel_count:'0'}])):null],
  ]) await assert.rejects(fixture(hook).pages.page({kind,cursor:''}),/neighborhood_frozen_spatial_/);
});

test('autocommit, absent/ending lost pins, cancellation and read ACK failure never return membership',async()=>{
  let tx=0;
  const f=fixture(({text})=>text.includes('generation-transaction')?result({transaction_id:String(++tx)}):null);
  await assert.rejects(f.pages.page({kind:'parcels',cursor:''}),/caller_transaction_required/);
  assert.equal(f.calls.some(x=>x.text.includes('frozen-spatial:')),false);
  const missing=fixture(({text})=>text.includes('generation-read')?{rowCount:0,rows:[]}:null);
  await assert.rejects(missing.pages.page({kind:'parcels',cursor:''}),/pin_unavailable/);
  const lost=fixture(({text,headers})=>text.includes('generation-fence')&&headers===2?{rowCount:0,rows:[]}:null);
  await assert.rejects(lost.pages.page({kind:'parcels',cursor:''}),/claim_lost/);
  const controller=new AbortController();controller.abort();const cancelled=fixture();
  await assert.rejects(createNeighborhoodFrozenSpatialPages(cancelled.client,{...options,signal:controller.signal})
    .page({kind:'parcels',cursor:''}),/cancelled/);assert.equal(cancelled.calls.length,0);
  const failed=fixture(({text})=>{if(text.includes('frozen-spatial:parcels'))throw Error('synthetic lost read ACK');});
  await assert.rejects(failed.pages.page({kind:'parcels',cursor:''}),/synthetic lost read ACK/);
});

test('closed input admission rejects coercion, accessors, proxies, changed geometry and arbitrary queries before SQL',async()=>{
  const f=fixture();
  for(const bad of [{...options,actorUserId:{toString(){throw Error('coercion');}}},
    {...options,geometryInput:{...options.geometryInput,coordinates:['NaN','32.9']}},
    {...options,discovery:{...options.discovery,radius_metres:'999999'}},
    {...options,scope:{...scope,get account_id(){throw Error('getter');}}},new Proxy(options,{})])
    assert.throws(()=>createNeighborhoodFrozenSpatialPages(f.client,bad),/invalid/);
  for(const bad of [{kind:'parcels',cursor:'',table:'core.accounts'},
    {kind:'sales',cursor:''},{kind:'parcels',cursor:'1;DROP'},
    {kind:'accounts',get cursor(){throw Error('getter');}},{kind:'parcels',cursor:'',rowLimit:251}])
    await assert.rejects(f.pages.page(bad),/neighborhood_frozen_spatial_/);
  assert.equal(f.calls.length,0);
});

test('one serial lane and finite operation budgets span calls and hold through pending I/O settlement',async()=>{
  let release,start;const waiting=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{start=resolve;});
  const f=fixture(async({text})=>{if(text.includes('frozen-spatial:header')){start();await waiting;}});
  const first=f.pages.page({kind:'parcels',cursor:''});await ready;
  await assert.rejects(f.pages.page({kind:'parcels',cursor:''}),/concurrent_read/);release();await first;
  const bounded=fixture();for(let i=0;i<NEIGHBORHOOD_FROZEN_SPATIAL_LIMITS.pages;i++)await bounded.pages.page({kind:'accounts',cursor:''});
  await assert.rejects(bounded.pages.page({kind:'accounts',cursor:''}),/operation_limit/);
  assert.equal(bounded.calls.filter(x=>x.text.includes('frozen-spatial:counts')).length,1);
  assert.equal(bounded.calls.filter(x=>x.text.includes('frozen-spatial:validity')).length,1);
  assert.equal(bounded.calls.filter(x=>x.text.includes('generation-fence')).length,64*4);
});

test('fixed indexed SQL preserves whole-parcel spheroid membership and unique C-ordered accounts',async()=>{
  for(const sql of Object.values(NEIGHBORHOOD_FROZEN_SPATIAL_SQL)) {
    assert.match(sql,/generation_id=\$1::uuid AND kind='parcels'/);
    assert.match(sql,/ST_DWithin\(geom::geography/);assert.match(sql,/\$4::double precision,true/);
    assert.match(sql,/prefix_bytes\+2<=\$7::bigint/);assert.match(sql,/LIMIT \$6::integer/);
    assert.doesNotMatch(sql,/ST_Centroid|ST_Simplify|ST_Expand|gis\.|core\./);
  }
  assert.match(NEIGHBORHOOD_FROZEN_SPATIAL_SQL.accounts,/GROUP BY account_id COLLATE "C"/);
  const migration=await fs.readFile(new URL('../migrations/20261106_neighborhood_frozen_spatial_index.sql',import.meta.url),'utf8');
  assert.match(migration,/USING gist\(\(geom::geography\)\)/);
  for(const match of migration.matchAll(/CREATE INDEX ([a-z_]+)/g))assert.ok(Buffer.byteLength(match[1])<=63);
  const registry=await fs.readFile(new URL('../src/database/mobileMigrations.js',import.meta.url),'utf8');
  assert.ok(registry.indexOf('20261106_neighborhood_frozen_spatial_index.sql')>registry.indexOf('20261105_neighborhood_frozen_original_sources.sql'));
});

test('cached population never caches the live claim or admits a changed original generation',async()=>{
  let fences=0;
  const f=fixture(({text})=>text.includes('generation-fence')&&++fences>4?{rowCount:0,rows:[]}:null);
  await f.pages.page({kind:'parcels',cursor:''});
  await assert.rejects(f.pages.page({kind:'parcels',cursor:'10'}),/claim_lost/);
  const changed=fixture(({text,headers,header})=>text.includes('frozen-spatial:header')&&headers>=2?
    result({...header,source_snapshot:'2:3:'}):null);
  await changed.pages.page({kind:'parcels',cursor:''});
  await assert.rejects(changed.pages.page({kind:'parcels',cursor:'10'}),/source_changed/);
  assert.equal(changed.calls.filter(x=>x.text.includes('frozen-spatial:counts')).length,1);
});
