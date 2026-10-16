import assert from 'node:assert/strict';
import test from 'node:test';
import { CAD_CACHE_COVERAGE_V2_BINDINGS as BINDINGS,prepareCohortCadCacheCoverageReceiptV2 as prepare,
  initialCohortCadCacheCoverageV2State as initial } from '../src/services/neighborhoodAssessment/cohortCadCacheCoverageReceiptV2.js';

const ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},expected={binding:{operation_id:'manual-DATA-only'},
  ...Object.fromEntries(BINDINGS.map(k=>[k,ref])),typed_profile_reference:ref,cad_source_metadata:{source_snapshot:'1:2:'},
  cad_purpose:{kind:'fixed-DATA-only'},cad_decision:{decision_id:'not-authority'},stock_account_count:'2'};
const raw=()=>({format:'cohort_CAD_cache_coverage_receipt_v2',...structuredClone(expected),sequence:1,previous:null,before:initial(),
  entry:{account_id:'A',geographic_parcel_count:'2',primary_count:1,secondary_count:2},
  after:{after_account:'A',account_count:1,original_count:3,typed_utf8_bytes:'1234',done:false}});

test('CAD coverage DATA keeps all native rows and requires a distinct terminal EMPTY after both accounts',()=>{
  const a=prepare(raw(),expected);assert.equal(a.after.original_count,3);assert.ok(Object.isFrozen(a.after));
  const b=prepare({...raw(),sequence:2,previous:ref,before:a.after,
    entry:{account_id:'B',geographic_parcel_count:'1',primary_count:0,secondary_count:0},
    after:{...a.after,after_account:'B',account_count:2}},expected);
  assert.equal(b.after.done,false);assert.equal(b.after.original_count,3);
  const end=prepare({...raw(),sequence:3,previous:ref,before:b.after,entry:null,after:{...b.after,done:true}},expected);
  assert.equal(end.after.done,true);assert.equal(end.after.typed_utf8_bytes,'1234');
  assert.throws(()=>prepare({...raw(),sequence:2,previous:ref,before:a.after,entry:null,after:{...a.after,done:true}},expected),/invalid_receipt/);
  assert.throws(()=>prepare({...raw(),sequence:4,previous:ref,before:end.after,entry:null,after:end.after},expected),/invalid_receipt/);
});

test('CAD coverage refuses skipped counts, native-key aliases, over-limit accounts and a free DONE',()=>{
  for(const patch of [{sequence:2},{previous:ref},{after:{...raw().after,done:true}},
    {after:{...raw().after,account_count:2}},{after:{...raw().after,original_count:2}},
    {after:{...raw().after,typed_utf8_bytes:'2'}},{after:{...raw().after,typed_utf8_bytes:'32000001'}},
    {entry:{...raw().entry,primary_count:2}},{entry:{...raw().entry,secondary_count:250}},
    {entry:{...raw().entry,account_id:' A'}},{entry:{...raw().entry,geographic_parcel_count:'0'}},
    {entry:null},{before:{...initial(),account_count:1}}])assert.throws(()=>prepare({...raw(),...patch},expected),/invalid_receipt/);
});

test('every original parent, neutral coverage, CAD source, fixed profile and source decision stays bound',()=>{
  for(const key of [...BINDINGS,'typed_profile_reference'])assert.throws(()=>prepare({...raw(),[key]:{...ref,content_sha256:'b'.repeat(64)}},expected),/invalid_receipt/);
  for(const key of ['binding','cad_source_metadata','cad_purpose','cad_decision','stock_account_count'])
    assert.throws(()=>prepare({...raw(),[key]:key==='stock_account_count'?'1':{}},expected),/invalid_receipt/);
  const r=raw();r.cad_purpose={get kind(){assert.fail('nested getter');}};assert.throws(()=>prepare(r,expected),/invalid_receipt/);
  const proxy=raw();proxy.cad_source_metadata=new Proxy({},{getPrototypeOf(){assert.fail('nested proxy');}});
  assert.throws(()=>prepare(proxy,expected),/invalid_receipt/);
  const sparse=raw();sparse.cad_source_metadata={fields:Array(1)};assert.throws(()=>prepare(sparse,expected),/invalid_receipt/);
});

test('CAD coverage account order uses UTF8 C bytes and zero-original accounts remain in the denominator',()=>{
  const before={after_account:'\uE000',account_count:1,original_count:3,typed_utf8_bytes:'1234',done:false};
  const r=prepare({...raw(),sequence:2,previous:ref,before,entry:{account_id:'\u{10000}',geographic_parcel_count:'1',primary_count:0,secondary_count:0},
    after:{...before,after_account:'\u{10000}',account_count:2}},expected);
  assert.equal(r.after.account_count,2);assert.equal(r.after.original_count,3);
  assert.throws(()=>prepare({...raw(),sequence:2,previous:ref,before,entry:{account_id:'A',geographic_parcel_count:'1',primary_count:0,secondary_count:0},
    after:{...before,after_account:'A',account_count:2}},expected),/invalid_receipt/);
});
