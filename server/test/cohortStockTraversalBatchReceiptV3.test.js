import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCohortStockTraversalBatchReceiptV3 as prepare } from '../src/services/neighborhoodAssessment/cohortStockTraversalBatchReceiptV3.js';
import { prepareCohortStockTraversalReceiptV2 as legacy } from '../src/services/neighborhoodAssessment/cohortStockTraversalReceiptV2.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'});
const expected={binding:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A',
  operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)},
  source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
  identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'9'};
const initial={after_account:'',account_count:0,done:false},progress=(n,done=false)=>({after_account:'A'+n,account_count:n,done});
const account=n=>({account_id:'A'+n,geographic_parcel_count:'1',original_counts:{parcels:1,accounts:0}});
const raw=(before=initial,accounts=Array.from({length:8},(_,i)=>account(i+1)),sequence=1)=>({
  format:'cohort_stock_traversal_batch_receipt_v3',...structuredClone(expected),sequence,previous:sequence===1?null:ref(7),before,
  after:accounts.length?{after_account:accounts.at(-1).account_id,account_count:before.account_count+accounts.length,done:false}:{...before,done:true},
  accounts,original_count:accounts.reduce((n,a)=>n+a.original_counts.parcels+a.original_counts.accounts,0)});

test('batch transition DATA separates eight account ordinals from one receipt, then NEXT and fresh EMPTY',()=>{
  const first=prepare(raw(),expected),next=prepare(raw(first.after,[account(9)],2),expected),empty=prepare(raw(next.after,[],3),expected);
  assert.equal(first.sequence,1);assert.equal(first.after.account_count,8);assert.equal(first.after.done,false);
  assert.equal(next.sequence,2);assert.equal(next.after.account_count,9);assert.equal(next.after.done,false);
  assert.equal(empty.sequence,3);assert.equal(empty.after.done,true);assert.equal(empty.original_count,0);
  assert.ok(Object.isFrozen(first.accounts[0].original_counts));assert.ok(!Object.hasOwn(first,'rows'));
  const source=raw(),detached=prepare(source,expected);source.accounts[0].original_counts.parcels=250;assert.equal(detached.accounts[0].original_counts.parcels,1);
  assert.throws(()=>legacy(first,expected),/invalid/,'legacy immutable receipt grammar never accepts a batch');
});

test('batch transition DATA refuses free DONE, hidden members, source/sequence changes and row-bound violations',()=>{
  for(const change of [r=>r.after.done=true,r=>r.accounts.push(account(9)),r=>r.original_count++,r=>r.after.account_count--,
    r=>r.after.after_account='A7',r=>r.accounts[1].account_id='A1',r=>r.accounts[0].account_id=' A',
    r=>r.accounts[0].original_counts.accounts=2,r=>r.accounts[0].geographic_parcel_count='2',r=>r.previous=ref(7),
    r=>r.sequence=2,r=>r.root=ref(9),r=>r.effective_date='2026-10-08',r=>r.rows=[],
    r=>r.accounts[0].original_counts.parcels=251,r=>r.accounts[0].account_id='\ud800']){
    const r=raw();change(r);assert.throws(()=>prepare(r,expected),/invalid/);
  }
  assert.throws(()=>prepare(raw(initial,[],1),expected),/invalid/);
  assert.throws(()=>prepare(raw({...progress(8),done:true},[account(9)],2),expected),/invalid/);
  const exact=raw(initial,[{...account(1),original_counts:{parcels:249,accounts:1}}]);
  assert.equal(prepare(exact,expected).original_count,250);
  const aggregate=raw(initial,[{...account(1),original_counts:{parcels:250,accounts:0}},account(2)]);
  assert.throws(()=>prepare(aggregate,expected),/invalid/);
});

test('batch transition DATA never invokes hostile getters/proxies, sparse arrays or extra capabilities',()=>{
  const getter=raw();Object.defineProperty(getter.accounts[0],'account_id',{enumerable:true,get(){assert.fail('getter');}});
  const sparse=raw();delete sparse.accounts[2];
  for(const r of [new Proxy(raw(),{}),getter,sparse,{...raw(),accounts:new Proxy(raw().accounts,{})},
    {...raw(),accounts:Object.assign(raw().accounts,{readOriginal(){assert.fail('callback');}})}])assert.throws(()=>prepare(r,expected),/invalid/);
});
