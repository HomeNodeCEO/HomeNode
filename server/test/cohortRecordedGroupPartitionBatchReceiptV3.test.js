import { createCustomCohortRecordedPartitionBatchV3Repository as repository } from '../src/services/neighborhoodAssessment/customCohortRecordedPartitionBatchV3Repository.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCohortRecordedGroupPartitionBatchReceiptV3 as prepare } from '../src/services/neighborhoodAssessment/cohortRecordedGroupPartitionBatchReceiptV3.js';
import { prepareCohortRecordedGroupPartitionReceiptV2 as legacy } from '../src/services/neighborhoodAssessment/cohortRecordedGroupPartitionReceiptV2.js';

import { getNeighborhoodOriginalRecordedGroupV2Profile } from '../src/services/neighborhoodAssessment/neighborhoodOriginalRecordedGroupV2.js';
const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ref=n=>({content_sha256:String(n).repeat(64),canonical_utf8_bytes:'123'});
const expected={binding:{organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A',
  operation_id:id(3),generation_id:id(4),spatial_definition_sha256:'a'.repeat(64),source_original_sha256:'b'.repeat(64)},
  source_reference:ref(1),root:ref(2),graph_verification_reference:ref(3),stock_verification_reference:ref(4),
  identity_verification_reference:ref(5),stock_reference:ref(6),effective_date:'2026-10-07',stock_account_count:'9',traversal_reference:ref(8),profile_reference:getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref};
const initial={after_account:'',account_count:0,done:false},progress=(n,done=false)=>({after_account:'A'+n,account_count:n,done});
const account=n=>({account_id:'A'+n,geographic_parcel_count:'1',original_counts:{parcels:1,accounts:0}});
const raw=(before=initial,accounts=Array.from({length:8},(_,i)=>account(i+1)),sequence=1)=>({
  format:'cohort_recorded_group_partition_batch_receipt_v3',...structuredClone(expected),sequence,previous:sequence===1?null:ref(7),before,
  after:accounts.length?{after_account:accounts.at(-1).account_id,account_count:before.account_count+accounts.length,done:false}:{...before,done:true},
  accounts,entries:accounts.map((a,index)=>({account_id:a.account_id,ordinal:before.account_count+index+1,entry_reference:ref(9),
    state:'unassigned',assigned_group_id:null})),original_count:accounts.reduce((n,a)=>n+a.original_counts.parcels+a.original_counts.accounts,0)});

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

test('partition batch DATA refuses missing/reordered entry ordinals, source callbacks and profile or metadata substitution',()=>{
  for(const change of [r=>r.entries.pop(),r=>r.entries.reverse(),r=>r.entries[0].ordinal=2,r=>r.entries[0].account_id='OTHER',
    r=>r.entries[0].state='assigned',r=>r.entries[0].assigned_group_id='recorded-cad:'+'a'.repeat(64),r=>r.entries[0].rows=[],
    r=>r.profile_reference=ref(1),r=>r.traversal_reference=ref(2),r=>r.entries[0].entry_reference.canonical_utf8_bytes='1000001']){
    const r=raw();change(r);assert.throws(()=>prepare(r,expected),/invalid/);
  }
  const r=raw(),out=prepare(r,expected);r.entries[0].entry_reference.content_sha256='e'.repeat(64);
  assert.equal(out.entries[0].entry_reference.content_sha256,'9'.repeat(64));assert.ok(Object.isFrozen(out.entries[0]));
  const hostile=raw();Object.defineProperty(hostile.entries[0],'entry_reference',{enumerable:true,get(){assert.fail('getter');}});
  assert.throws(()=>prepare(hostile,expected),/invalid/);
});

const scope={organization_id:id(1),report_file_id:id(2),assignment_file_id:'7',account_id:'A'};
/** SQL doubles cover mechanics ONLY, never independent native/source authority. */
function setup({autocommit=false,conflict=false,storedEntry=null}={}){
  let current=null,tx=40;const calls=[];
  const frozen={source_reference:ref(1),root_reference:ref(2),graph_reference:ref(3),geographic_reference:ref(4),identity_reference:ref(5),
    stock_reference:ref(6),traversal_reference:ref(7),profile_reference:expected.profile_reference};
  const client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(autocommit?++tx:tx)}]};
    if(sql.includes(':anchor-read'))return {rowCount:1,rows:[current??Object.fromEntries([...Object.keys(frozen),'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(sql.includes(':entry-read'))return {rowCount:1,rows:[storedEntry??Object.fromEntries(['account_id','ordinal','entry_reference','state','assigned_group_id'].map(k=>[k,null]))]};
    if(sql.includes(':entry-insert'))return {rowCount:1,rows:[{ordinal:values[9]}]};
    if(sql.includes(':anchor-insert')){current={...frozen,receipt_reference:JSON.parse(values[16]),sequence:1};return {rowCount:1,rows:[{sequence:1}]};}
    if(sql.includes(':anchor-advance')){if(conflict)return {rowCount:0,rows:[]};current={...frozen,receipt_reference:JSON.parse(values[8]),sequence:values[9]};
      return {rowCount:1,rows:[{sequence:current.sequence}]};}assert.fail(sql);}};
  return {calls,owner:repository({client,claim:{operation_id:id(3),claim_token:id(5),attempts:1},scope,actorUserId:id(6),...frozen})};
}
const entry=(account='A',ordinal=1)=>({account_id:account,ordinal,entry_reference:ref(8),state:'unassigned',assigned_group_id:null});

test('batch store retains every derived row against the EXISTING native tables before one CAS head, with independent account ordinals',async()=>{
  const {owner,calls}=setup(),entries=Array.from({length:8},(_,i)=>entry('A'+(i+1),i+1));
  const first=await owner.advance(null,ref(8),entries),next=await owner.advance(first,ref(9),[entry('A9',9)]),
    done=await owner.advance(next,ref(7),[]);
  assert.equal(first.sequence,1);assert.equal(next.sequence,2);assert.equal(done.sequence,3);
  const rows=calls.filter(c=>c.sql.includes(':entry-insert'));assert.equal(rows.length,9);
  assert.deepEqual(rows.map(c=>c.values[9]),[1,2,3,4,5,6,7,8,9]);
  assert.ok(calls.findIndex(c=>c.sql.includes(':anchor-insert'))>calls.indexOf(rows[7]));
  for(const c of calls.filter(c=>/FROM app.neighborhood|INTO app.neighborhood|UPDATE app.neighborhood/.test(c.sql))){
    assert.doesNotMatch(c.sql,/recorded_partition_batch_v3_(heads|rows)/);
    assert.ok(c.sql.includes('job.claim_token=$2::uuid'));assert.ok(c.sql.includes('job.actor_user_id=$8::uuid'));
  }
  assert.equal(calls.filter(c=>c.sql.includes(':anchor-insert')||c.sql.includes(':anchor-advance')).length,3);
  await assert.rejects(owner.advance(first,ref(7),[entry('A9',9)]),/conflict/);
});

test('batch store refuses hostile, sparse, oversized, reordered or nonconsecutive metadata without executing SQL',async()=>{
  const sparse=[entry()];delete sparse[0];
  const getter=entry();Object.defineProperty(getter,'account_id',{enumerable:true,get(){assert.fail('getter');}});
  for(const entries of [null,new Proxy([entry()],{}),sparse,Array.from({length:9},(_,i)=>entry('A'+i,i+1)),
    [entry('B',1),entry('A',2)],[entry('A',1),entry('B',3)],[getter],
    [{...entry(),state:'assigned'}],Object.assign([entry()],{readOriginal(){assert.fail('callback');}})]){
    const f=setup();await assert.rejects(f.owner.advance(null,ref(8),entries),/invalid_entry|invalid_input/);assert.equal(f.calls.length,0);
  }
  const auto=setup({autocommit:true});await assert.rejects(auto.owner.advance(null,ref(8),[entry()]),/caller_transaction_required/);
  assert.equal(auto.calls.some(c=>c.sql.includes(':entry-insert')),false);
});
