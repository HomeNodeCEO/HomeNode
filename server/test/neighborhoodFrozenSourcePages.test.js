import assert from 'node:assert/strict';
import test from 'node:test';
import { createNeighborhoodFrozenSourcePages, NEIGHBORHOOD_FROZEN_PAGE_SQL, NEIGHBORHOOD_FROZEN_PAGE_LIMITS }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenSourcePages.js';

const id='70000000-0000-4000-8000-000000000001', date='2026-10-07T00:00:00.000000Z';
const claim={operation_id:id,claim_token:'70000000-0000-4000-8000-000000000002',attempts:1};
const scope={organization_id:'70000000-0000-4000-8000-000000000003',report_file_id:'70000000-0000-4000-8000-000000000004',assignment_file_id:'1',account_id:'PAGE-A'};
const options={claim,scope,actorUserId:'70000000-0000-4000-8000-000000000005'};
const result=row=>({rowCount:1,rows:[row]});
function fixture({empty=false,hook=()=>{}}={}) {
  const calls=[];let headers=0,fences=0;
  const pin={generation_id:id,status:'complete',retirement_started_at:null,source_observed_at:date,
    completed_at:date,parcel_count:'3',sale_count:'0',group_count:'1'};
  const counts=Object.fromEntries(Object.keys(NEIGHBORHOOD_FROZEN_PAGE_SQL).map(kind=>[kind,
    {row_count:kind==='parcels'&&!empty?'3':'0',payload_utf8_bytes:kind==='parcels'&&!empty?'300':'0'}]));
  const header={generation_id:id,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:date,
    completed_at:date,layer_counts:counts,row_count:empty?'0':'3',payload_utf8_bytes:empty?'0':'300'};
  const payload='{"sale_price":"9007199254740993","stored_geometry_ewkb":"0103000020E6100000"}';
  const page=rows=>{const page_json=JSON.stringify(rows.map(row_key=>({row_key,payload_text:payload})));
    return {page_json,page_count:rows.length,candidate_count:rows.length,next_cursor:rows.at(-1)??'',page_utf8_bytes:Buffer.byteLength(page_json)};};
  const client={async query(config){
    const text=config.text;calls.push(config);
    const supplied=await hook({text,config,calls,headers,fences,header,pin,page});
    if(supplied)return supplied;
    if(text.includes('generation-transaction'))return result({transaction_id:'123'});
    if(text.includes('generation-fence')){fences++;return result({operation_id:claim.operation_id});}
    if(text.includes('generation-read'))return result(pin);
    if(text.includes('frozen-pages:header')){headers++;return result(structuredClone(header));}
    if(text.includes('frozen-pages:parcels'))return result(empty?page([]):page(['1','2']));
    throw Error(`unexpected fixed query ${text.slice(0,60)}`);
  }};
  return {client,calls,header,pin,page,pages:createNeighborhoodFrozenSourcePages(client,options)};
}

test('pages reopen only an existing exact pin and preserve original JSON/decimal/geometry text',async()=>{
  const f=fixture();const p=await f.pages.page({kind:'parcels',cursor:'',rowLimit:2});
  assert.equal(p.original.generation_id,id);assert.equal(p.original.row_count,'3');assert.equal(p.next_cursor,'2');
  assert.equal(p.coverage,'page_only');assert.equal(p.authority,'not_established');assert.equal(p.end_of_layer,false);
  assert.match(p.rows[0].payload_text,/9007199254740993/);assert.match(p.rows[0].payload_text,/0103000020E6100000/);
  assert.equal(f.calls.filter(x=>x.text.includes('generation-fence')).length,4);
  assert.equal(f.calls.filter(x=>x.text.includes('frozen-pages:header')).length,2);
  assert.ok(f.calls.every(x=>Number.isInteger(x.query_timeout)&&x.query_timeout<=3000));
  assert.ok(Object.isFrozen(p.rows)&&Object.isFrozen(p.rows[0])&&Object.isFrozen(p.original.layer_counts));
  assert.ok(f.calls.every(x=>!/generation-active|generation-pin|INSERT|UPDATE|COMMIT/.test(x.text)));
});

test('autocommit, missing pins and ending lost claims refuse before delivery',async()=>{
  let probes=0;
  const f=fixture({hook:({text})=>text.includes('generation-transaction')?result({transaction_id:String(++probes)}):null});
  await assert.rejects(f.pages.page({kind:'parcels',cursor:''}),/caller_transaction_required/);
  assert.equal(f.calls.some(x=>x.text.includes('frozen-pages:')),false);
  const missing=fixture({hook:({text})=>text.includes('generation-read')?{rowCount:0,rows:[]}:null});
  await assert.rejects(missing.pages.page({kind:'parcels',cursor:''}),/pin_unavailable/);
  assert.equal(missing.calls.some(x=>x.text.includes('frozen-pages:')),false);
  const lost=fixture({hook:({text,headers})=>text.includes('generation-fence')&&headers===2?{rowCount:0,rows:[]}:null});
  await assert.rejects(lost.pages.page({kind:'parcels',cursor:''}),/claim_lost/);
});

test('header drift, missing pages, byte overflow and nonmonotone originals never claim completion',async()=>{
  for(const hook of [
    ({text,headers,header})=>text.includes('frozen-pages:header')&&headers===1?result({...header,source_snapshot:'2:3:'}):null,
    ({text,page})=>text.includes('frozen-pages:parcels')?result({...page([]),candidate_count:1}):null,
    ({text,page})=>text.includes('frozen-pages:parcels')?result(page(['2','1'])):null,
    ({text,page})=>text.includes('frozen-pages:parcels')?result({...page(['1']),next_cursor:'9'}):null,
    ({text,page})=>text.includes('frozen-pages:parcels')?result({...page(['1']),page_utf8_bytes:NEIGHBORHOOD_FROZEN_PAGE_LIMITS.page_utf8_bytes+1}):null,
    ({text,header})=>text.includes('frozen-pages:header')?result({...header,row_count:'4'}):null,
  ]) await assert.rejects(fixture({hook}).pages.page({kind:'parcels',cursor:''}),/neighborhood_frozen_pages_/);
});

test('native numeric order is not text order and a page is not complete-study coverage',async()=>{
  const f=fixture({hook:({text,page})=>text.includes('frozen-pages:parcels')?result(page(['2','10'])):null});
  const p=await f.pages.page({kind:'parcels',cursor:'1',rowLimit:3});
  assert.equal(p.next_cursor,'10');assert.equal(p.end_of_layer,true);assert.equal(p.coverage,'page_only');
});

test('a valid near-limit heavily escaped original fits alone without blocking the next key',async()=>{
  const payload=JSON.stringify({legal_description:'\\'.repeat(480_000)});
  assert.ok(Buffer.byteLength(payload)<1_000_000);
  const page_json=JSON.stringify([{row_key:'1',payload_text:payload}]);
  assert.ok(Buffer.byteLength(page_json)>1_500_000);
  assert.ok(Buffer.byteLength(page_json)<NEIGHBORHOOD_FROZEN_PAGE_LIMITS.page_utf8_bytes);
  const f=fixture({hook:({text})=>text.includes('frozen-pages:parcels')?result({page_json,
    page_count:1,candidate_count:2,next_cursor:'1',page_utf8_bytes:Buffer.byteLength(page_json)}):null});
  const page=await f.pages.page({kind:'parcels',cursor:'',rowLimit:2});
  assert.equal(page.next_cursor,'1');assert.equal(page.end_of_layer,false);
  assert.equal(page.rows[0].payload_text,payload);
});

test('closed inputs reject source/generation injection, unknown kinds and getters before SQL',async()=>{
  const f=fixture();
  for(const input of [{kind:'parcels',cursor:'',generationId:id},{kind:'__proto__',cursor:''},
    {kind:'parcels',cursor:'1;DELETE'},{kind:'parcels',cursor:'',rowLimit:251},
    {kind:'parcels',get cursor(){throw Error('getter must not execute');}}]) {
    await assert.rejects(f.pages.page(input),/neighborhood_frozen_pages_/);
  }
  assert.equal(f.calls.length,0);
  assert.throws(()=>createNeighborhoodFrozenSourcePages(f.client,{...options,scope:{...scope,get account_id(){throw Error('getter');}}}),/invalid_input/);
  assert.throws(()=>createNeighborhoodFrozenSourcePages(f.client,new Proxy(options,{})),/invalid_input/);
});

test('cancellation and failed original reads settle without returning a page',async()=>{
  const controller=new AbortController(), f=fixture();
  const pages=createNeighborhoodFrozenSourcePages(f.client,{...options,signal:controller.signal});
  controller.abort();await assert.rejects(pages.page({kind:'parcels',cursor:''}),/cancelled/);assert.equal(f.calls.length,0);
  const failed=fixture({hook:({text})=>{if(text.includes('frozen-pages:parcels'))throw Error('synthetic read ACK lost');}});
  await assert.rejects(failed.pages.page({kind:'parcels',cursor:''}),/synthetic read ACK lost/);
  assert.equal(failed.calls.filter(x=>x.text.includes('frozen-pages:header')).length,1);
});

test('one settlement lane and finite whole-operation budgets span repeated pages',async()=>{
  let release,started;const pending=new Promise(resolve=>{release=resolve;});
  const ready=new Promise(resolve=>{started=resolve;});
  const f=fixture({hook:async({text})=>{if(text.includes('frozen-pages:header')){started();await pending;}}});
  const first=f.pages.page({kind:'parcels',cursor:''});await ready;
  await assert.rejects(f.pages.page({kind:'parcels',cursor:''}),/concurrent_read/);release();await first;
  const empty=fixture({empty:true});
  for(let i=0;i<NEIGHBORHOOD_FROZEN_PAGE_LIMITS.pages;i++) {
    const page=await empty.pages.page({kind:'parcels',cursor:''});assert.equal(page.end_of_layer,true);
  }
  const before=empty.calls.length;
  await assert.rejects(empty.pages.page({kind:'parcels',cursor:''}),/operation_limit/);assert.equal(empty.calls.length,before);
});

test('fixed indexed plans bound actual encoded bytes inside PostgreSQL and never read live mirrors',()=>{
  assert.equal(Object.keys(NEIGHBORHOOD_FROZEN_PAGE_SQL).length,7);
  for(const [kind,sql] of Object.entries(NEIGHBORHOOD_FROZEN_PAGE_SQL)) {
    assert.match(sql,/FROM app.neighborhood_frozen_source_rows/);assert.ok(sql.includes(`kind='${kind}'`));
    assert.match(sql,/LIMIT \$3::integer/);assert.match(sql,/prefix_bytes\+2 <= \$4::bigint/);
    assert.match(sql,/octet_length\(encoded::text\)\+2/);
    assert.doesNotMatch(sql,/FROM (?:core|gis)\.|raw_payload|INSERT|UPDATE|DELETE|OFFSET|account_id IS NOT NULL/);
  }
  assert.match(NEIGHBORHOOD_FROZEN_PAGE_SQL.parcels,/row_key::bigint/);
  assert.match(NEIGHBORHOOD_FROZEN_PAGE_SQL.accounts,/COLLATE "C"/);
  assert.match(NEIGHBORHOOD_FROZEN_PAGE_SQL.sync_runs,/row_key::uuid/);
});
