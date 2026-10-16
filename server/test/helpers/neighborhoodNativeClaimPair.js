import assert from 'node:assert/strict';

/** Separate two REAL concurrent native claim transactions from the positive
 * source-owner assertion. An idle contender may still briefly hold the job
 * row until its transaction finishes. That lock correctly refuses NOWAIT; it
 * is not source permission or a failed original replay. No claim, row, source,
 * fence, failure budget, heartbeat or original call is replaced or retried. */
export async function runNeighborhoodNativeClaimPair(worker,args,method){
  let release,ownerCalls=0,pairFailure;
  const idleSettled=new Promise(resolve=>{release=resolve;});
  const paired={...args,cohortService:{...args.cohortService,async [method](...parameters){
    if(++ownerCalls!==1){
      pairFailure=Error('native concurrent claim pair issued more than one owner');release();throw pairFailure;
    }
    await idleSettled;
    if(pairFailure)throw pairFailure;
    return args.cohortService[method](...parameters);
  }}};
  const invoke=async()=>{
    try{const result=await worker(paired);if(result.status==='idle')release();return result;}
    catch(error){pairFailure ||= error;release();throw error;}
  };
  const results=await Promise.all([invoke(),invoke()]);
  assert.equal(ownerCalls,1,'the real native pair must issue exactly one original owner');
  return results;
}
