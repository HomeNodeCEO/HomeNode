import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortOwnedSourceThirdRetryV3Repository as repository }
  from '../src/services/neighborhoodAssessment/customCohortOwnedSourceThirdRetryV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  claim={operation_id:id(1),claim_token:id(2),attempts:3},
  scope={organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'SUBJECT'};
function setup({auto=false,ending=false,rows=[{status:'retry',attempts:3,failure_code:'access_revoked'}],rowCount=rows.length}={}){
  let reads=0;const calls=[],client={async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction')){reads++;return {rowCount:1,rows:[{transaction_id:String(auto?reads:ending&&reads===3?52:51)}]};}
    return {rowCount,rows};
  }};
  return {calls,client,owner:repository({client,claim,scope,actorUserId:id(5)})};
}

test('third retry preserves attempt3 and the entire actual claim with a bounded native schedule',async()=>{
  const {owner,calls}=setup(),result=await owner.failForRetry('access_revoked',{retrySeconds:1});
  assert.deepEqual(result,{status:'retry',attempts:3,failure_code:'access_revoked'});assert.ok(Object.isFrozen(result));
  const write=calls.find(c=>c.sql.includes(':fail-third'));
  assert.deepEqual(write.values,[claim.operation_id,claim.claim_token,3,scope.organization_id,scope.report_file_id,'7','SUBJECT',id(5),'access_revoked',1]);
  assert.match(write.sql,/third_first\(/);assert.match(write.sql,/job.attempts=3/);assert.match(write.sql,/to_jsonb\(job\)=recorded.claimed_job/);
  assert.match(write.sql,/recorded.issued_transaction_id=txid_current\(\)/);
  assert.doesNotMatch(write.sql,/SET attempts|,attempts=|checkpoint=|BEGIN|COMMIT|DELETE|ST_DWithin/);assert.equal(calls.length,4);
});

test('exact scoped attempt3 only, with no executable claim, scope or caller authority',()=>{
  const {client,calls}=setup(),base={client,claim,scope,actorUserId:id(5)},hostile=()=>assert.fail('DATA must not execute');
  const revoked=Proxy.revocable(base,{});revoked.revoke();
  for(const value of [null,{...base,claim:{...claim,attempts:1}},{...base,claim:{...claim,attempts:2}},
    {...base,claim:{...claim,attempts:4}},{...base,claim:{...claim,attempts:5}},
    {...base,scope:{...scope,assignment_file_id:'9223372036854775808'}},{...base,scope:{...scope,account_id:'\ud800'}},
    {...base,sourceAuthority:true},{...base,claim:new Proxy(claim,{get:hostile})},
    {...base,scope:{...scope,get account_id(){hostile();}}},new Proxy(base,{get:hostile}),revoked.proxy])
    assert.throws(()=>repository(value),/invalid_input|invalid_scope_or_third_claim/);
  assert.throws(()=>repository({...base,claim:{...claim,attempts:6}}),/invalid_claim/);
  assert.throws(()=>repository(base,undefined),/invalid_input/);assert.equal(calls.length,0);
});

test('failure code and bounded schedule are closed before any database access',async()=>{
  const {owner,calls}=setup();
  const revoked=Proxy.revocable({retrySeconds:1},{});revoked.revoke();
  for(const code of [undefined,null,{},()=>assert.fail('callback'),'attempts_exhausted','access_revoked ',new String('access_revoked')])
    await assert.rejects(owner.failForRetry(code,{retrySeconds:1}),/invalid_failure_code/);
  for(const value of [null,{},new Proxy({retrySeconds:1},{}),revoked.proxy,{get retrySeconds(){assert.fail('getter');}},
    {retrySeconds:0},{retrySeconds:901},{retrySeconds:1.5},{retrySeconds:1,readOriginal(){assert.fail('callback');}}])
    await assert.rejects(owner.failForRetry('access_revoked',value),/invalid_input|invalid_retry_seconds/);
  await assert.rejects(owner.failForRetry('access_revoked',{retrySeconds:1},{}),/invalid_failure_code/);assert.equal(calls.length,0);
});

test('autocommit refuses before mutation and switched ending transaction refuses tentative output',async()=>{
  const auto=setup({auto:true});await assert.rejects(auto.owner.failForRetry('access_revoked',{retrySeconds:1}),/caller_transaction_required/);
  assert.equal(auto.calls.length,2);
  await assert.rejects(setup({ending:true}).owner.failForRetry('access_revoked',{retrySeconds:1}),/caller_transaction_required/);
});

test('native ownership loss, counter changes or corrupt output cannot become retry success',async()=>{
  await assert.rejects(setup({rows:[]}).owner.failForRetry('access_revoked',{retrySeconds:1}),/claim_lost/);
  for(const result of [{status:'failed',attempts:3,failure_code:'access_revoked'},
    {status:'retry',attempts:5,failure_code:'access_revoked'},{status:'retry',attempts:3,failure_code:'capture_failed'}])
    await assert.rejects(setup({rows:[result]}).owner.failForRetry('access_revoked',{retrySeconds:1}),/corrupt/);
  await assert.rejects(setup({rowCount:0}).owner.failForRetry('access_revoked',{retrySeconds:1}),/claim_lost/);
});
