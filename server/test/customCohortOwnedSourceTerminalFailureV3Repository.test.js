import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortOwnedSourceTerminalFailureV3Repository as repository }
  from '../src/services/neighborhoodAssessment/customCohortOwnedSourceTerminalFailureV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  claim={operation_id:id(1),claim_token:id(2),attempts:5},
  scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'SUBJECT'};
// Detached boundary checks only; real birth/claim/FIRST/native COMMIT and
// immutable whole-row preservation are required in the independent A/B CI graphs.
function setup({auto=false,ending=false,rows=[{status:'failed',attempts:5,failure_code:'access_revoked'}],rowCount=rows.length}={}){
  let reads=0;const calls=[],client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction')){reads++;return {rowCount:1,rows:[{transaction_id:String(auto?reads:ending&&reads===3?52:51)}]};}
    return {rowCount,rows};
  }};
  return {calls,client,owner:repository({client,claim,scope,actorUserId:id(5)})};
}

test('final failure retains the whole actual owned claim and changes only terminal bookkeeping',async()=>{
  const {owner,calls}=setup(),result=await owner.failFinal('access_revoked');
  assert.deepEqual(result,{status:'failed',attempts:5,failure_code:'access_revoked'});assert.ok(Object.isFrozen(result));
  const write=calls.find(c=>c.sql.includes(':fail-final'));
  assert.deepEqual(write.values,[claim.operation_id,claim.claim_token,5,scope.organization_id,scope.report_file_id,'7','SUBJECT',id(5),'access_revoked']);
  assert.match(write.sql,/owned_first\(/);assert.match(write.sql,/to_jsonb\(job\)=recorded.claimed_job/);
  assert.match(write.sql,/recorded.issued_transaction_id=txid_current\(\)/);
  assert.doesNotMatch(write.sql,/SET attempts|,attempts=|run_after=|checkpoint=|BEGIN|COMMIT|DELETE|ST_DWithin/);
  assert.equal(calls.length,4);
});

test('only a closed final5 claim and exact scope enter the repository',()=>{
  const {client,calls}=setup(),base={client,claim,scope,actorUserId:id(5)},hostile=()=>assert.fail('DATA must not execute');
  for(const value of [null,{...base,claim:{...claim,attempts:4}},{...base,scope:{...scope,assignment_file_id:'9223372036854775808'}},
    {...base,scope:{...scope,account_id:'\ud800'}},{...base,sourceAuthority:true},
    {...base,claim:new Proxy(claim,{get:hostile})},{...base,scope:{...scope,get account_id(){hostile();}}},new Proxy(base,{get:hostile})])
    assert.throws(()=>repository(value),/invalid_input|invalid_scope_or_final_claim/);
  assert.throws(()=>repository(base,undefined),/invalid_input/);assert.equal(calls.length,0);
});

test('failure codes, callbacks and extra arguments refuse before database access',async()=>{
  const {owner,calls}=setup();
  for(const value of [undefined,null,{},()=>assert.fail('callback'),'retry','access_revoked ',new String('access_revoked')])
    await assert.rejects(owner.failFinal(value),/invalid_failure_code/);
  await assert.rejects(owner.failFinal('access_revoked',{}),/invalid_failure_code/);assert.equal(calls.length,0);
});

test('autocommit refuses before mutation and a switched ending transaction cannot return success',async()=>{
  const auto=setup({auto:true});await assert.rejects(auto.owner.failFinal('access_revoked'),/caller_transaction_required/);
  assert.equal(auto.calls.length,2);
  await assert.rejects(setup({ending:true}).owner.failFinal('access_revoked'),/caller_transaction_required/);
});

test('lost native ownership or corrupt terminal result cannot become success',async()=>{
  await assert.rejects(setup({rows:[]}).owner.failFinal('access_revoked'),/claim_lost/);
  for(const result of [{status:'retry',attempts:5,failure_code:'access_revoked'},
    {status:'failed',attempts:4,failure_code:'access_revoked'},{status:'failed',attempts:5,failure_code:'capture_failed'}])
    await assert.rejects(setup({rows:[result]}).owner.failFinal('access_revoked'),/corrupt/);
  await assert.rejects(setup({rowCount:0}).owner.failFinal('access_revoked'),/claim_lost/);
});
