import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareCohortGeographicOriginalReceiptV2 as prepare } from '../src/services/neighborhoodAssessment/cohortGeographicOriginalReceiptV2.js';

const ref=c=>({content_sha256:c.repeat(64),canonical_utf8_bytes:'123'});
const binding={organization_id:'11111111-1111-4111-8111-111111111111',report_file_id:'22222222-2222-4222-8222-222222222222',
  assignment_file_id:'7',account_id:'S',operation_id:'33333333-3333-4333-8333-333333333333',
  generation_id:'44444444-4444-4444-8444-444444444444',spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)};
const expected={binding,source_reference:ref('a'),root:ref('b'),graph_verification_reference:ref('c'),stock_reference:ref('d')};
const start={format:'frozen_job_stock_original_progress_v1',stock_sha256:'e'.repeat(64),after_object_id:null,
  verified_parcels:0,verified_unassociated:0,done:false};
const receipt=(before,after,sequence=1)=>({format:'cohort_geographic_original_receipt_v2',...expected,
  sequence,previous:sequence===1?null:ref('f'),before,after});
test('bounded geographic DATA receipts preserve native zero keys, short pages and the separate full-tail terminal query',()=>{
  const zero={...start,after_object_id:'0',verified_parcels:1,verified_unassociated:1};
  assert.deepEqual(prepare(receipt(start,zero),expected).after,zero);
  const full={...start,after_object_id:'249',verified_parcels:250};
  assert.equal(prepare(receipt(start,full),expected).after.done,false);
  const terminal={...full,done:true};
  assert.deepEqual(prepare(receipt(full,terminal,2),expected).after,terminal);
  const short={...zero,after_object_id:'4',verified_parcels:5};
  assert.deepEqual(prepare(receipt(zero,short,2),expected).after,short,'8-MB-admitted prefix need not contain 250 rows');
  const raw=structuredClone(receipt(start,zero)),detached=prepare(raw,expected);
  raw.source_reference.content_sha256='f'.repeat(64);raw.binding.account_id='changed';raw.after.verified_parcels=250;
  assert.deepEqual(detached.source_reference,expected.source_reference);assert.equal(detached.binding.account_id,'S');
  assert.equal(detached.after.verified_parcels,1);
});
test('all binding refs, monotonic counts/cursor, initial zero state and exact closed progress are mandatory',()=>{
  const valid=receipt(start,{...start,after_object_id:'9',verified_parcels:10,done:true});
  for(const mutation of [r=>({...r,sequence:0}),r=>({...r,previous:ref('f')}),r=>({...r,extra:true}),
    r=>({...r,before:{...start,verified_parcels:1,after_object_id:'0'}}),
    r=>({...r,after:{...r.after,verified_parcels:251}}),r=>({...r,after:{...r.after,verified_unassociated:11}}),
    r=>({...r,after:{...r.after,after_object_id:null}}),r=>({...r,before:{...r.before,done:true}}),
    r=>({...r,after:{...r.after,stock_sha256:'f'.repeat(64)}}),r=>({...r,after:{...r.after,extra:true}})])
    assert.throws(()=>prepare(mutation(valid),expected),/invalid_/);
  for(const key of ['source_reference','root','graph_verification_reference','stock_reference'])
    assert.throws(()=>prepare({...valid,[key]:ref('f')},expected),/invalid_receipt/);
  assert.throws(()=>prepare({...valid,binding:{...binding,operation_id:binding.generation_id}},expected),/invalid_receipt/);
  assert.throws(()=>prepare(receipt({...start,after_object_id:'9',verified_parcels:10},
    {...start,after_object_id:'8',verified_parcels:11},2),expected),/invalid_receipt/);
});
test('receipt input hooks are not executed and 60001-row metadata progression remains bounded DATA, not issuance',()=>{
  const valid=receipt(start,{...start,after_object_id:'0',verified_parcels:1,done:true});
  for(const raw of [new Proxy(valid,{getPrototypeOf(){assert.fail('proxy executed');}}),
    {...valid,get before(){assert.fail('getter executed');}},
    {...valid,[Symbol('hidden')]:true},Object.defineProperty({...valid},'hidden',{value:true})])
    assert.throws(()=>prepare(raw,expected),/invalid_receipt/);
  let before=start,sequence=0;
  while(before.verified_parcels<60001){
    const count=Math.min(250,60001-before.verified_parcels),n=before.verified_parcels+count;
    const after={...before,verified_parcels:n,after_object_id:String(n-1),done:n===60001};
    const saved=prepare(receipt(before,after,++sequence),expected);
    assert.ok(Buffer.byteLength(JSON.stringify(saved))<2000);before=saved.after;
  }
  assert.equal(sequence,241);assert.equal(before.done,true);
});
