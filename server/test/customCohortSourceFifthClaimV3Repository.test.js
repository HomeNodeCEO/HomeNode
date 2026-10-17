import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSourceFifthClaimV3Repository as repository }
  from '../src/services/neighborhoodAssessment/customCohortSourceFifthClaimV3Repository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  row={operation_id:id(1),claim_token:id(2),attempts:5,organization_id:id(3),report_file_id:id(4),
    assignment_file_id:'7',account_id:'A',actor_user_id:id(5)};
// Detached boundary checks only. Native whole-birth/first-member issuance,
// single consumption and real COMMIT/rollback are separate cloud fixtures.
function setup({auto=false,empty=false,change={},rowCount=empty?0:1}={}){
  let tx=50;const calls=[];
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    if(sql.includes(':claim'))return {rowCount,rows:empty?[]:[{...row,...change}]};assert.fail(sql);
  }})};
}
test('fifth claim spends attempt5 once, supplies a closed scope and establishes no source authority',async()=>{
  const {owner,calls}=setup(),result=await owner.claimDue({limit:4,leaseSeconds:900});
  assert.deepEqual(result,[{claim:{operation_id:id(1),claim_token:id(2),attempts:5},
    scope:{organization_id:id(3),report_file_id:id(4),assignment_file_id:'7',account_id:'A'},
    actor_user_id:id(5),authority:'not_established'}]);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result[0])&&Object.isFrozen(result[0].claim)&&Object.isFrozen(result[0].scope));
  const claim=calls.find(c=>c.sql.includes(':claim'));assert.deepEqual(claim.values,[4,900]);
  assert.match(claim.sql,/FOR UPDATE OF job SKIP LOCKED/);assert.match(claim.sql,/to_jsonb\(job\)=issued.preclaim_job/);
  assert.match(claim.sql,/neighborhood_source_resolution_v3_fifth_due_first/);assert.match(claim.sql,/failure.issued_transaction_id<>txid_current\(\)/);
  assert.match(claim.sql,/job.attempts=4/);assert.match(claim.sql,/gen_random_uuid\(\),job.attempts\+1/);
  assert.match(claim.sql,/attempts=issued.attempts/);
  assert.doesNotMatch(claim.sql,/last_error_code\s*=|run_after\s*=|checkpoint\s*=issued|BEGIN|COMMIT|ST_DWithin/);
});
test('invalid options, getters, proxies and caller authority are rejected before any database access',async()=>{
  const {owner,calls}=setup();
  for(const value of [null,undefined,[],new Proxy({limit:1,leaseSeconds:120},{}),
    {get limit(){assert.fail('getter');},leaseSeconds:120},{limit:0,leaseSeconds:120},{limit:5,leaseSeconds:120},
    {limit:1.5,leaseSeconds:120},{limit:1,leaseSeconds:14},{limit:1,leaseSeconds:901},
    {limit:1,leaseSeconds:15.5},{limit:1,leaseSeconds:120,checkpoint:{}},
    {limit:1,leaseSeconds:120,readOriginal(){assert.fail('callback');}},{limit:1,leaseSeconds:120,attempts:0}])
    await assert.rejects(owner.claimDue(value),/invalid_options/);
  await assert.rejects(owner.claimDue({limit:1,leaseSeconds:120},{}),/invalid_options/);
  const revoked=Proxy.revocable({limit:1,leaseSeconds:120},{});revoked.revoke();
  await assert.rejects(owner.claimDue(revoked.proxy),/invalid_options/);
  assert.equal(calls.length,0);
});
test('an autocommit client fails before mutation; empty native queue is an immutable empty result',async()=>{
  const invalid=setup({auto:true});await assert.rejects(invalid.owner.claimDue(),/caller_transaction_required/);
  assert.ok(!invalid.calls.some(c=>c.sql.includes(':claim')));
  const empty=setup({empty:true}),result=await empty.owner.claimDue({limit:1,leaseSeconds:15});
  assert.deepEqual(result,[]);assert.ok(Object.isFrozen(result));
});
test('corrupt database claim/scope/row cardinality cannot become an owner invocation',async()=>{
  for(const change of [{attempts:0},{attempts:1},{attempts:2},{attempts:3},{attempts:4},{attempts:6},{claim_token:'wrong'},{organization_id:id(8).toUpperCase().replace('700','ABC')},
    {assignment_file_id:'9223372036854775808'},{assignment_file_id:'07'},{account_id:'\ud800'},{account_id:' A'},
    {account_id:'A\n'},{actor_user_id:null}])await assert.rejects(setup({change}).owner.claimDue(),/invalid_claim|invalid_identifier|corrupt/);
  await assert.rejects(setup({rowCount:0}).owner.claimDue(),/corrupt/);
});
test('a changed caller transaction after native mutation never returns tentative claims',async()=>{
  let reads=0;const owner=repository({async query(sql){
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:++reads===3?'52':'51'}]};
    return {rowCount:1,rows:[row]};
  }});await assert.rejects(owner.claimDue(),/caller_transaction_required/);
});
