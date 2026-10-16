import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomCohortCadCacheV2HeadRepository as repository } from '../src/services/neighborhoodAssessment/customCohortCadCacheV2HeadRepository.js';
import { CAD_CACHE_COVERAGE_V2_BINDINGS as BINDINGS } from '../src/services/neighborhoodAssessment/cohortCadCacheCoverageReceiptV2.js';
const id=n=>`71000000-0000-4000-8000-${String(n).padStart(12,'0')}`,ref={content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'},
  claim={operation_id:id(1),claim_token:id(2),attempts:5},scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'A'},
  base={claim,scope,actorUserId:id(5),...Object.fromEntries(BINDINGS.map(k=>[k,ref]))};
function fixture({auto=false,hook=()=>null}={}){let h=null,tx=1;const calls=[];
  const client={async query(text,values){calls.push({text,values});const supplied=hook({text,values,h});if(supplied)return supplied;
    if(text.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(text.includes(':anchor-read'))return {rowCount:1,rows:[h??Object.fromEntries([...BINDINGS,'receipt_reference','sequence'].map(k=>[k,null]))]};
    if(text.includes(':anchor-insert')){h={...Object.fromEntries(BINDINGS.map((k,i)=>[k,JSON.parse(values[i+8])])),receipt_reference:JSON.parse(values[15]),sequence:1};
      return {rowCount:1,rows:[{sequence:1}]};}
    if(text.includes(':anchor-advance')){h={...h,receipt_reference:JSON.parse(values[8]),sequence:values[9]};return {rowCount:1,rows:[{sequence:values[9]}]};}
    assert.fail(text);
  }},owner=repository({client,...base});return {calls,client,owner,head:()=>h};}

test('CAD head retains exact parent bindings and CAS progress without changing claim history',async()=>{
  const f=fixture();assert.equal(await f.owner.read(),null);const first=await f.owner.advance(null,ref);
  assert.equal(first.sequence,1);assert.equal(first.neutral_reference.content_sha256,ref.content_sha256);
  const nextRef={...ref,content_sha256:'b'.repeat(64)},next=await f.owner.advance(first,nextRef);
  assert.equal(next.sequence,2);assert.deepEqual(next.receipt_reference,nextRef);
  const insert=f.calls.find(c=>c.text.includes(':anchor-insert'));
  assert.deepEqual(insert.values.slice(0,8),[claim.operation_id,claim.claim_token,5,...Object.values(scope),base.actorUserId]);
  assert.equal(insert.values.length,16);assert.equal(f.calls.find(c=>c.text.includes(':anchor-advance')).values.length,19);
  assert.ok(!f.calls.some(c=>/SET attempts|last_error_code=|COMMIT|BEGIN/.test(c.text)));
});

test('CAD head refuses autocommit, stale expected heads and missing current claims before DML',async()=>{
  const auto=fixture({auto:true});await assert.rejects(auto.owner.advance(null,ref),/caller_transaction_required/);
  assert.ok(!auto.calls.some(c=>c.text.includes(':anchor-insert')));
  const f=fixture();await f.owner.advance(null,ref);const before=f.calls.length;
  await assert.rejects(f.owner.advance(null,ref),/conflict/);assert.ok(!f.calls.slice(before).some(c=>c.text.includes(':anchor-insert')));
  const lost=fixture({hook:c=>c.text.includes(':anchor-read')?{rowCount:0,rows:[]}:null});await assert.rejects(lost.owner.read(),/claim_lost/);
});

test('CAD head rejects caller progress/grants, hostile scope and changed neutral parent',async()=>{
  const f=fixture();for(const change of [{progress:{}},{scope:{...scope,account_id:' A'}},{neutral_reference:{...ref,canonical_utf8_bytes:'16001'}}])
    assert.throws(()=>repository({...base,client:f.client,...change}),/invalid_|reference/);
  assert.throws(()=>repository({...base,client:f.client,get actorUserId(){assert.fail('getter');}}),/invalid_input/);
  assert.throws(()=>repository(new Proxy({},{getPrototypeOf(){assert.fail('proxy');}})),/invalid_input/);
  const first=await f.owner.advance(null,ref);
  await assert.rejects(f.owner.advance({...first,neutral_reference:{...ref,content_sha256:'b'.repeat(64)}},ref),/binding_changed/);
});
