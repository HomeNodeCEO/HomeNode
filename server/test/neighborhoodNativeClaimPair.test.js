import test from 'node:test';
import assert from 'node:assert/strict';
import { runNeighborhoodNativeClaimPair as pair } from './helpers/neighborhoodNativeClaimPair.js';

test('positive owner waits until the idle contender has completed its claim transaction',async()=>{
  let calls=0,contenderOpen=false,originalReads=0;
  const claim={operation_id:'actual-test-claim'},input={retained:true},options={captureJobClaim:claim};
  const args={cohortService:{async original(value,received){
    assert.equal(contenderOpen,false);assert.equal(value,input);assert.equal(received,options);
    originalReads++;return {status:'continuation_pending'};
  }}};
  const worker=async value=>{
    if(++calls===1)return value.cohortService.original(input,options);
    contenderOpen=true;await new Promise(resolve=>setImmediate(resolve));contenderOpen=false;
    return {status:'idle'};
  };
  assert.deepEqual((await pair(worker,args,'original')).map(r=>r.status),['continuation_pending','idle']);
  assert.equal(originalReads,1);
});

test('claim failure releases the barrier and preserves the actual failure',async()=>{
  let calls=0,originals=0;const error=Error('actual claim transaction failed');
  const args={cohortService:{async original(){originals++;return {status:'continuation_pending'};}}};
  await assert.rejects(pair(async value=>{
    if(++calls===1)return value.cohortService.original();throw error;
  },args,'original'),e=>e===error);
  assert.equal(originals,0);
});

test('two owners are rejected before a second original call, and zero owners are not positive proof',async()=>{
  let originals=0;const args={cohortService:{async original(){originals++;return {status:'continuation_pending'};}}};
  await assert.rejects(pair(value=>value.cohortService.original(),args,'original'),/more than one owner/);
  assert.equal(originals,0);
  await assert.rejects(pair(async()=>({status:'idle'}),args,'original'),/exactly one original owner/);
});
