import assert from 'node:assert/strict';
import test from 'node:test';
import { createNeighborhoodSharedTypedOriginalPageV2 as create,NEIGHBORHOOD_SHARED_TYPED_V2_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { createCustomCohortNeutralCacheOwnerBudget as budget }
  from '../src/services/neighborhoodAssessment/customCohortOriginalAccountOwnerBudget.js';

const generationId='12345678-1234-4234-8234-123456789012',stamp='2026-10-09T00:00:00.000000Z',
  kinds=['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
const row={row_key:'12',payload_text:JSON.stringify({object_id:'12',account_id:'A',residential_year_built:2030,residential_area_sqft:'1234.5'})};
const result=row=>({rowCount:1,rows:[structuredClone(row)]});
function fixture(hook=()=>null){
  const calls=[];let header=null,inputs=[];
  const source={generation_id:generationId,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:stamp,completed_at:stamp,
    layer_counts:Object.fromEntries(kinds.map(k=>[k,{row_count:k==='parcels'?'2':'0',payload_utf8_bytes:k==='parcels'?'400':'0'}])),
    row_count:'2',payload_utf8_bytes:'400'},
    tx={transaction_id:'1',source_snapshot:'1:2:',isolation:'read committed',read_only:'off',timezone:'UTC',backend_pid:1};
  const raw={async query(c){calls.push(c);const overridden=await hook(c,{header,source,tx});if(overridden)return overridden;
    if(c.text===SQL.snapshot)return result(tx);
    if(c.text===SQL.source)return result(source);
    if(c.text===SQL.read||c.text===SQL.lock)return header?result(header):{rowCount:0,rows:[]};
    if(c.text.includes('shared-typed-v2:begin')){const v=c.values;
      header={binding_sha256:v[2],source_metadata:JSON.parse(v[3]),definition_json:v[4],progress:JSON.parse(v[5]),status:'building',completed_at:null};
      return {rowCount:1,rows:[]};}
    if(c.text===SQL.insert){inputs=JSON.parse(c.values[3]);return result({inserted_count:inputs.length,reconciled_count:inputs.length,
      typed_utf8_bytes:String(inputs.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.typed)),0))});}
    assert.fail(c.text);
  }},client=budget(raw,{checkBudget(){}});
  return {raw,client,calls,source,tx,header:()=>header,inputs:()=>inputs,
    writer:opts=>create(client,{generationId,...opts}),page:()=>({kind:'parcels',rows:[structuredClone(row)]})};
}

test('scoped producer compiles every supplied original without scanning a generation or advancing global progress',async()=>{
  const f=fixture(),r=await f.writer().reconcile(f.page());
  assert.equal(r.reconciled_rows,1);assert.equal(r.inserted_rows,1);assert.equal(r.shared_cache_status,'building');
  assert.equal(r.global_progress_advanced,false);assert.equal(r.job_coverage,'not_established');assert.equal(r.authority,'not_established');
  assert.equal(f.header().progress.typed_rows,'0');assert.equal(f.header().progress.kind_index,0);
  assert.equal(f.inputs()[0].original_text,row.payload_text);assert.equal(f.inputs()[0].typed.typed_original_version,2);
  assert.equal(f.inputs()[0].typed.observations.reported_year_built.exact_value,'2030');
  assert.ok(!f.calls.some(c=>c.text===SQL.page||/shared-typed-v2:progress|COMMIT|FROM core\.|FROM gis\./.test(c.text)));
  assert.equal(Object.hasOwn(r,'effective_date'),false);assert.equal(r.source_acquisition,'not_established');
});

test('existing complete or building cache rows are freshly compiled and fully reconciled with no global progress writes',async()=>{
  let reuse=false;
  const f=fixture(c=>reuse&&c.text===SQL.insert?result({inserted_count:0,reconciled_count:1,typed_utf8_bytes:'2000'}):null);
  await f.writer().reconcile(f.page());reuse=true;
  const before=structuredClone(f.header()),r=await f.writer().reconcile(f.page());
  assert.equal(r.inserted_rows,0);assert.deepEqual(f.header(),before);
  Object.assign(f.header(),{status:'complete',completed_at:stamp});Object.assign(f.header().progress,{kind_index:7,typed_rows:'2',typed_utf8_bytes:'4000'});
  const completeBefore=structuredClone(f.header()),complete=await f.writer().reconcile(f.page());
  assert.equal(complete.shared_cache_status,'complete');assert.deepEqual(f.header(),completeBefore);
});

test('empty scoped original pages leave the whole-generation progress incomplete',async()=>{
  const f=fixture(),r=await f.writer().reconcile({kind:'accounts',rows:[]});
  assert.equal(r.reconciled_rows,0);assert.equal(r.typed_utf8_bytes,'0');assert.equal(r.shared_cache_status,'building');
  assert.ok(!f.calls.some(c=>c.text===SQL.insert||c.text===SQL.page));
});

test('full-original reconciliation acknowledgements refuse partial, forged and invalid byte results',async()=>{
  for(const ack of [{inserted_count:0,reconciled_count:0,typed_utf8_bytes:'2000'},
    {inserted_count:2,reconciled_count:1,typed_utf8_bytes:'2000'},{inserted_count:-1,reconciled_count:1,typed_utf8_bytes:'2000'},
    {inserted_count:0,reconciled_count:1,typed_utf8_bytes:'0'},{inserted_count:0,reconciled_count:1,typed_utf8_bytes:'32000001'}]){
    const f=fixture(c=>c.text===SQL.insert?result(ack):null);await assert.rejects(f.writer().reconcile(f.page()),/original_mismatch/);
  }
});

test('exact native transaction and ending source/header checks precede acknowledgement',async()=>{
  for(const patch of [{isolation:'read uncommitted'},{read_only:'on'},{timezone:'America/Chicago'}]){
    const f=fixture();Object.assign(f.tx,patch);await assert.rejects(f.writer().reconcile(f.page()),/caller_transaction_required/);
    assert.equal(f.header(),null);
  }
  let probes=0;const auto=fixture((c,s)=>c.text===SQL.snapshot&&++probes===2?result({...s.tx,transaction_id:'2'}):null);
  await assert.rejects(auto.writer().reconcile(auto.page()),/caller_transaction_changed/);assert.equal(auto.header(),null);
  let sources=0;const end=fixture((c,s)=>c.text===SQL.source&&++sources===2?result({...s.source,source_snapshot:'2:3:'}):null);
  await assert.rejects(end.writer().reconcile(end.page()),/source_changed/);
  let reads=0;const header=fixture((c,s)=>c.text===SQL.read&&++reads===2?result({...s.header,binding_sha256:'e'.repeat(64)}):null);
  await assert.rejects(header.writer().reconcile(header.page()),/source_changed/);
  let snapshots=0;const rc=fixture((c,s)=>c.text===SQL.snapshot?result({...s.tx,source_snapshot:`${++snapshots}:${snapshots+1}:`}):null);
  assert.equal((await rc.writer().reconcile(rc.page())).reconciled_rows,1,'RC snapshots may advance inside the same real transaction');
});

test('unbounded clients, caller profiles/dates and malformed original arrays cannot start a scoped write',async()=>{
  const f=fixture();assert.throws(()=>create(f.raw,{generationId}),/aggregate_owner_required/);
  for(const opts of [{effectiveDate:'2026-10-09'},{profile:{}},{table:'core.accounts'},{authorize:()=>true}])
    assert.throws(()=>f.writer(opts),/invalid_input/);
  const badRows=[Array(1),new Proxy([row],{}),[row,row],[{...row,payload_text:'x'.repeat(1_000_001)}],
    [{...row,row_key:'\ud800'}],Array.from({length:251},()=>row)];
  const getter=[row];Object.defineProperty(getter,'0',{enumerable:true,get(){assert.fail('getter');}});badRows.push(getter);
  for(const rows of badRows)await assert.rejects(f.writer().reconcile({kind:'parcels',rows}),/invalid_original|invalid_input/);
  assert.equal(f.calls.length,0);
});

test('a scoped page cannot reset its aggregate budget, survive cancellation or be used twice',async()=>{
  const f=fixture(),writer=f.writer();await writer.reconcile(f.page());const from=f.calls.length;
  await assert.rejects(writer.reconcile(f.page()),/builder_already_used/);assert.equal(f.calls.length,from);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.writer({signal:controller.signal}).reconcile(f.page()),/cancelled/);assert.equal(f.calls.length,from);
  const poisoned=fixture();
  // Real source reads and later compiled parameters share one owner lifetime.
  poisoned.raw.query=async()=>({rowCount:1,rows:[{padding:'x'.repeat(16_000_000)}]});
  await poisoned.client.query('earlier original read');
  await assert.rejects(poisoned.client.query({text:'compiled cache input',values:['x'.repeat(16_000_000)]}),/owner_byte_limit/);
  await assert.rejects(poisoned.writer().reconcile(poisoned.page()),/owner_byte_limit/);
});
