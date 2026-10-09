import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCohortSourceIdentityReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortSourceIdentityReceiptV2.js';
const ref=c=>({content_sha256:c.repeat(64),canonical_utf8_bytes:'123'});
const binding={organization_id:'11111111-1111-4111-8111-111111111111',report_file_id:'22222222-2222-4222-8222-222222222222',
  assignment_file_id:'7',account_id:'S',operation_id:'33333333-3333-4333-8333-333333333333',
  generation_id:'44444444-4444-4444-8444-444444444444',spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)};
const expected={binding,source_reference:ref('a'),root:ref('b'),graph_verification_reference:ref('c'),
  stock_verification_reference:ref('d'),stock_reference:ref('e'),
  layer_counts:{parcels:250,accounts:1,source_records:0,sales:0,sale_links:0,sync_state:1,sync_runs:0},stock_account_count:'2'};
const start={format:'frozen_job_source_identity_progress_v1',binding_sha256:'e'.repeat(64),kind_index:0,after:'',
  layer_rows:0,unknown_parcel_origins:0,missing_account_count:null};
const receipt=(before,after,sequence=1,e=expected)=>({format:'cohort_source_identity_receipt_v2',...e,
  sequence,previous:sequence===1?null:ref('f'),before,after});
test('identity transition DATA preserves full-tail/empty terminal, short prefixes, zero parcel IDs and exact seven layer counts',()=>{
  const zero={...start,after:'0',layer_rows:1,unknown_parcel_origins:1};
  assert.deepEqual(prepare(receipt(start,zero),expected).after,zero);
  const full={...start,after:'249',layer_rows:250,unknown_parcel_origins:10};
  assert.deepEqual(prepare(receipt(start,full),expected).after,full);
  const ended={...full,kind_index:1,after:'',layer_rows:0};
  assert.deepEqual(prepare(receipt(full,ended,2),expected).after,ended);
  const accountDone={...ended,kind_index:2};
  assert.deepEqual(prepare(receipt(ended,accountDone,3),expected).after,accountDone);
  let before=accountDone,sequence=3;
  for(let index=3;index<=7;index++){
    const after={...before,kind_index:index,missing_account_count:index===7?1:null};
    before=prepare(receipt(before,after,++sequence),expected).after;
  }
  assert.equal(before.kind_index,7);assert.equal(before.missing_account_count,1);
  assert.throws(()=>prepare(receipt(before,before,8),expected),/invalid_receipt/,'DONE cannot be issued again');
  const raw=structuredClone(receipt(start,zero)),detached=prepare(raw,expected);
  raw.binding.account_id='changed';raw.layer_counts.parcels=0;raw.after.unknown_parcel_origins=250;
  assert.equal(detached.binding.account_id,'S');assert.equal(detached.layer_counts.parcels,250);
  assert.equal(detached.after.unknown_parcel_origins,1);
});
test('closed receipts reject layer skipping, wrong refs/counts, decreasing counters, invalid IDs and premature completion',()=>{
  const valid=receipt(start,{...start,after:'9',layer_rows:10,unknown_parcel_origins:1});
  for(const mutation of [r=>({...r,sequence:0}),r=>({...r,previous:ref('f')}),r=>({...r,extra:true}),
    r=>({...r,after:{...r.after,kind_index:2}}),r=>({...r,after:{...r.after,layer_rows:251}}),
    r=>({...r,after:{...r.after,unknown_parcel_origins:11}}),r=>({...r,after:{...r.after,after:''}}),
    r=>({...r,after:{...r.after,missing_account_count:1}}),r=>({...r,after:{...r.after,extra:true}}),
    r=>({...r,after:{...r.after,binding_sha256:'a'.repeat(64)}}),r=>({...r,after:{...r.after,after:'-1'}}),
    r=>({...r,before:{...r.before,unknown_parcel_origins:1}}),
    r=>({...r,layer_counts:{...r.layer_counts,parcels:251}}),r=>({...r,stock_account_count:'3'})])
    assert.throws(()=>prepare(mutation(valid),expected),/invalid_/);
  for(const key of ['source_reference','root','graph_verification_reference','stock_verification_reference','stock_reference'])
    assert.throws(()=>prepare({...valid,[key]:ref('f')},expected),/invalid_receipt/);
  const full={...start,after:'249',layer_rows:250};
  assert.throws(()=>prepare(receipt(start,{...full,kind_index:1,after:'',layer_rows:0}),expected),/invalid_receipt/);
  assert.throws(()=>prepare(receipt(full,{...full,after:'248',layer_rows:251},2),expected),/invalid_receipt/);
  const accounts={...start,kind_index:1};
  assert.throws(()=>prepare(receipt(accounts,{...accounts,after:'S',layer_rows:1,unknown_parcel_origins:1},2),expected),/invalid_receipt/);
});
test('receipt hooks never run and 60001 synthetic identities remain bounded metadata DATA, not issuance or acquisition',()=>{
  const valid=receipt(start,{...start,after:'0',layer_rows:1});
  for(const raw of [new Proxy(valid,{getPrototypeOf(){assert.fail('proxy executed');}}),
    {...valid,get before(){assert.fail('getter executed');}}, {...valid,[Symbol('hidden')]:true},
    Object.defineProperty({...valid},'hidden',{value:true})])assert.throws(()=>prepare(raw,expected),/invalid_receipt/);
  const e={...expected,layer_counts:{...expected.layer_counts,parcels:60001}};
  let before=start,sequence=0;
  while(before.layer_rows<60000){
    const after={...before,after:String(before.layer_rows+249),layer_rows:before.layer_rows+250,
      unknown_parcel_origins:before.unknown_parcel_origins+1};
    const saved=prepare(receipt(before,after,++sequence,e),e);
    assert.ok(Buffer.byteLength(JSON.stringify(saved))<2400);before=saved.after;
  }
  before=prepare(receipt(before,{...before,kind_index:1,after:'',layer_rows:0},++sequence,e),e).after;
  assert.equal(sequence,241);assert.equal(before.kind_index,1);assert.equal(before.unknown_parcel_origins,240);
});
