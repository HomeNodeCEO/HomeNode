import assert from 'node:assert/strict';
import test from 'node:test';
import { createNeighborhoodSharedTypedCadOriginalPageV1 as create, NEIGHBORHOOD_SHARED_TYPED_CAD_SQL as SQL }
  from '../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { createCustomCohortNeutralCacheOwnerBudget as budget }
  from '../src/services/neighborhoodAssessment/customCohortOriginalAccountOwnerBudget.js';
import { getNeighborhoodFrozenCadImprovementProfile }
  from '../src/services/neighborhoodAssessment/neighborhoodFrozenCadImprovements.js';

const generationId='12345678-1234-4234-8234-123456789012',stamp='2026-10-09T00:00:00.000000Z';
const primary={row_key:'A',payload_text:JSON.stringify({account_id:'A',year_built:'2030',living_area_sqft:'1234.50',
  bedroom_count:'3',bath_count:'2.1',number_units:'1',pool:false})};
const secondary=id=>({row_key:id,payload_text:JSON.stringify({id,account_id:'A',sec_imp_number:'1',sec_imp_type:'UNRESOLVED',sec_imp_sqft:'400'})});
const result=row=>({rowCount:1,rows:[structuredClone(row)]});
// These doubles test closed mechanics only. The native test replays actual
// immutable CAD originals and checks database INSERT totals/entire cache rows.
function fixture(hook=()=>null){
  const calls=[];let header=null,inputs=[];
  const original=getNeighborhoodFrozenCadImprovementProfile(),
    source={generation_id:generationId,format_version:1,status:'complete',source_snapshot:'1:2:',started_at:stamp,completed_at:stamp,
      source_profile_sha256:original.profile_ref.content_sha256,source_definition_json:original.definition_blob.canonical_json,
      layer_counts:{primary:{row_count:'1',payload_utf8_bytes:'300'},secondary:{row_count:'2',payload_utf8_bytes:'700'}},
      row_count:'3',payload_utf8_bytes:'1000'},
    tx={transaction_id:'1',source_snapshot:'1:2:',isolation:'read committed',read_only:'off',timezone:'UTC',backend_pid:1};
  const raw={async query(c){calls.push(c);const overridden=await hook(c,{header,source,tx});if(overridden)return overridden;
    if(c.text===SQL.snapshot)return result(tx);
    if(c.text===SQL.source)return result(source);
    if(c.text===SQL.read||c.text===SQL.lock)return header?result(header):{rowCount:0,rows:[]};
    if(c.text.includes('shared-typed-CAD:begin')){
      const v=c.values;header={binding_sha256:v[2],source_metadata:JSON.parse(v[3]),definition_json:v[4],progress:JSON.parse(v[5]),status:'building',completed_at:null};
      return {rowCount:1,rows:[]};
    }
    if(c.text===SQL.insert){inputs=JSON.parse(c.values[3]);return result({inserted_count:inputs.length,reconciled_count:inputs.length,
      typed_utf8_bytes:String(inputs.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.typed)),0))});}
    assert.fail(c.text);
  }},client=budget(raw,{checkBudget(){}});
  return {raw,client,calls,source,tx,header:()=>header,inputs:()=>inputs,writer:opts=>create(client,{generationId,...opts})};
}

test('scoped CAD producer recompiles retained extra fields without global scans, dates, job coverage or completion',async()=>{
  const f=fixture(),r=await f.writer().reconcile({kind:'primary',rows:[primary]});
  assert.equal(r.status,'shared_neutral_CAD_original_page_reconciled_v1');assert.equal(r.reconciled_rows,1);
  assert.equal(r.shared_cache_status,'building');assert.equal(r.global_progress_advanced,false);
  assert.equal(r.job_coverage,'not_established');assert.equal(r.source_acquisition,'not_established');
  const typed=f.inputs()[0].typed;
  assert.equal(typed.typed_CAD_improvement_version,1);assert.equal(typed.observations.reported_year_built.exact_value,'2030');
  assert.equal(typed.observations.reported_living_area.exact_value,'1234.5');
  assert.equal(typed.observations.reported_pool_flag.exact_value,false);
  assert.equal(typed.observations.reported_baths.unit,'CAD_reported_baths');
  assert.equal(Object.hasOwn(typed,'effective_date'),false);assert.equal(f.header().progress.kind_index,0);
  assert.ok(!f.calls.some(c=>c.text===SQL.page||/shared-typed-CAD:progress|FROM core\.|FROM gis\.|COMMIT/.test(c.text)));
});

test('every secondary native key survives repeated improvement numbers without deduplication or amenity interpretation',async()=>{
  const f=fixture(),r=await f.writer().reconcile({kind:'secondary',rows:[secondary('1'),secondary('3')]});
  assert.equal(r.reconciled_rows,2);assert.deepEqual(f.inputs().map(row=>row.row_key),['1','3']);
  assert.deepEqual(f.inputs().map(row=>row.typed.observations.reported_improvement_number.exact_value),['1','1']);
  assert.equal(f.header().progress.typed_rows,'0');
});

test('existing complete CAD cache is fully recompiled/reconciled without changing its global header',async()=>{
  let reuse=false;
  const f=fixture(c=>reuse&&c.text===SQL.insert?result({inserted_count:0,reconciled_count:1,typed_utf8_bytes:'2000'}):null);
  await f.writer().reconcile({kind:'primary',rows:[primary]});reuse=true;
  Object.assign(f.header(),{status:'complete',completed_at:stamp});
  Object.assign(f.header().progress,{kind_index:2,typed_rows:'3',typed_utf8_bytes:'4000'});
  const before=structuredClone(f.header()),r=await f.writer().reconcile({kind:'primary',rows:[primary]});
  assert.equal(r.inserted_rows,0);assert.equal(r.shared_cache_status,'complete');assert.deepEqual(f.header(),before);
});

test('CAD source profile, transaction and ending snapshot fences cannot borrow a seven-layer cache or autocommit',async()=>{
  const source=fixture();source.source.source_profile_sha256='a'.repeat(64);
  await assert.rejects(source.writer().reconcile({kind:'primary',rows:[primary]}),/source_unavailable/);
  assert.equal(source.header(),null);
  let probes=0;const auto=fixture((c,s)=>c.text===SQL.snapshot&&++probes===2?result({...s.tx,transaction_id:'2'}):null);
  await assert.rejects(auto.writer().reconcile({kind:'primary',rows:[primary]}),/caller_transaction_changed/);
  assert.equal(auto.header(),null);
  let reads=0;const ending=fixture((c,s)=>c.text===SQL.source&&++reads===2?result({...s.source,source_snapshot:'2:3:'}):null);
  await assert.rejects(ending.writer().reconcile({kind:'primary',rows:[primary]}),/source_changed/);
});

test('CAD scoped producer refuses malformed/partial packets, caller grants/dates and unbounded executors',async()=>{
  const f=fixture();assert.throws(()=>create(f.raw,{generationId}),/aggregate_owner_required/);
  for(const opts of [{effectiveDate:'2026-10-09'},{profile:{}},{authorize:()=>true}])assert.throws(()=>f.writer(opts),/invalid_input/);
  for(const page of [{kind:'accounts',rows:[]},{kind:'primary',rows:[primary,primary]},
    {kind:'secondary',rows:Array(1)},{kind:'primary',rows:[{...primary,payload_text:'x'.repeat(1_000_001)}]}])
    await assert.rejects(f.writer().reconcile(page),/invalid_original/);
  assert.equal(f.calls.length,0);
  const partial=fixture(c=>c.text===SQL.insert?result({inserted_count:0,reconciled_count:0,typed_utf8_bytes:'0'}):null);
  await assert.rejects(partial.writer().reconcile({kind:'primary',rows:[primary]}),/original_mismatch/);
});

test('CAD pages share the actual owner lifetime, remain single use and cannot survive cancellation',async()=>{
  const f=fixture(),writer=f.writer();await writer.reconcile({kind:'primary',rows:[primary]});
  const from=f.calls.length;await assert.rejects(writer.reconcile({kind:'primary',rows:[primary]}),/builder_already_used/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(f.writer({signal:controller.signal}).reconcile({kind:'primary',rows:[primary]}),/cancelled/);
  assert.equal(f.calls.length,from);
  f.raw.query=async()=>({rowCount:1,rows:[{padding:'x'.repeat(16_000_000)}]});
  await f.client.query('earlier original read');
  await assert.rejects(f.client.query({text:'later compiled CAD input',values:['x'.repeat(16_000_000)]}),/owner_byte_limit/);
  await assert.rejects(f.writer().reconcile({kind:'secondary',rows:[secondary('1')]}),/owner_byte_limit/);
});
