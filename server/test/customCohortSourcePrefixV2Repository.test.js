import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSourcePrefixV2Repository } from '../src/services/neighborhoodAssessment/customCohortSourcePrefixV2Repository.js';

const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const claim={operation_id:id('1'),claim_token:id('2'),attempts:5};
const scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'};
const ref=n=>({content_sha256:n.repeat(64),canonical_utf8_bytes:'100'});
const next={source_reference:ref('a'),root_reference:ref('b')};
function fixture(){let stored=null,tx='100';const queries=[];
  const client={async query(sql,values){queries.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:tx}]};
    if(sql.includes(':read'))return {rowCount:1,rows:[stored??{source_reference:null,root_reference:null,sequence:null}]};
    if(sql.includes(':insert')||sql.includes(':advance')){
      stored={source_reference:JSON.parse(values[8]),root_reference:JSON.parse(values[9]),sequence:values[10]??1};
      return {rowCount:1,rows:[{sequence:stored.sequence}]};}
    assert.fail(sql);
  }};
  return {owner:createCustomCohortSourcePrefixV2Repository({client,claim,scope,actorUserId:id('5')}),queries,
    replace:value=>{stored=value;},changeTx:()=>{tx=String(Number(tx)+1);},client};
}

test('one independently issued head advances by CAS and refuses a stale prior source',async()=>{
  const {owner,queries}=fixture();assert.equal(await owner.read(),null);
  const first=await owner.advance(null,next);assert.deepEqual(first,{...next,sequence:1});
  const second=await owner.advance(first,{source_reference:ref('c'),root_reference:ref('d')});
  assert.equal(second.sequence,2);assert.equal((await owner.read()).source_reference.content_sha256,'c'.repeat(64));
  const before=queries.length;await assert.rejects(owner.advance(first,next),/conflict/);
  assert.ok(!queries.slice(before).some(q=>/:insert|:advance/.test(q.sql)));
  const update=queries.find(q=>q.sql.includes(':advance'));
  assert.deepEqual(update.values.slice(0,8),[claim.operation_id,claim.claim_token,5,scope.organization_id,scope.report_file_id,'7','FIXTURE',id('5')]);
  assert.deepEqual(update.values.slice(11).map((value,index)=>index<2?JSON.parse(value):value),[first.source_reference,first.root_reference,1]);
});

test('unsafe references, accessors, caller cursors and exhaustion refuse before SQL',async()=>{
  const {owner,queries}=fixture();
  for(const value of [{...next,cursor:''},new Proxy(next,{}),{get source_reference(){assert.fail('getter');},root_reference:next.root_reference},
    {...next,source_reference:{...ref('a'),canonical_utf8_bytes:'16001'}}])
    await assert.rejects(owner.advance(null,value),/invalid_/);
  await assert.rejects(owner.advance({...next,sequence:200000},next),/limit/);
  assert.equal(queries.length,0);
});

test('transaction drift and corrupt stored heads cannot mint an issuance',async()=>{
  const f=fixture(),original=f.client.query;let transactions=0;
  f.client.query=async(sql,values)=>{if(sql.includes(':transaction')&&++transactions===2)f.changeTx();return original(sql,values);};
  await assert.rejects(f.owner.advance(null,next),/caller_transaction_required/);
  assert.ok(!f.queries.some(q=>/:insert|:advance/.test(q.sql)));
  const corrupt=fixture();corrupt.replace({...next,sequence:0});await assert.rejects(corrupt.owner.read(),/corrupt/);
});
