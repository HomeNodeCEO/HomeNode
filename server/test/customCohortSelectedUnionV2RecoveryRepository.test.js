import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSelectedUnionV2RecoveryRepository as repository }
  from '../src/services/neighborhoodAssessment/customCohortSelectedUnionV2RecoveryRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row={operation_id:id(1),claim_token:id(2),attempts:3,organization_id:id(3),report_file_id:id(4),
  assignment_file_id:'7',account_id:'A',actor_user_id:id(5)};
// Detached boundary checks only; native eligibility, competing claims, natural
// lease expiry and the fifth-failure ceiling require the cloud PostgreSQL test.
function setup({auto=false,rows=[row],rowCount=rows.length}={}){let tx=40;const calls=[];
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx)}]};
    return sql.includes(':claim')||sql.includes(':initial-claim')?{rowCount,rows}:{rowCount:0,rows:[]};}})};}

test('union recovery returns only a fresh scheduling claim with authority still unestablished',async()=>{
  const {owner,calls}=setup(),[value]=await owner.claimDue({limit:1,leaseSeconds:15});
  assert.deepEqual(value.claim,{operation_id:row.operation_id,claim_token:row.claim_token,attempts:3});
  assert.deepEqual(value.scope,{organization_id:row.organization_id,report_file_id:row.report_file_id,
    assignment_file_id:'7',account_id:'A'});
  assert.equal(value.authority,'not_established');assert.ok(Object.isFrozen(value.claim)&&Object.isFrozen(value.scope));
  assert.deepEqual(calls.find(c=>c.sql.includes(':claim')).values,[1,15]);
  assert.deepEqual(await setup({rows:[]}).owner.claimDue(),[]);
});

test('union recovery refuses autocommit before any expiration or claim mutation',async()=>{
  const {owner,calls}=setup({auto:true});await assert.rejects(owner.claimDue(),/caller_transaction_required/);
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.sql.includes(':transaction')));
});

test('union recovery rejects free authority, attempts, references, hostile objects and unbounded scheduling before queries',async()=>{
  const {owner,calls}=setup();
  for(const options of [{limit:0,leaseSeconds:120},{limit:5,leaseSeconds:120},{limit:1,leaseSeconds:14},
    {limit:1,leaseSeconds:901},{limit:1,leaseSeconds:120,attempts:0},{limit:1,leaseSeconds:120,checkpoint:{}},
    {limit:1,leaseSeconds:120,source_authorized:true},new Proxy({limit:1,leaseSeconds:120},{}),
    {limit:1,get leaseSeconds(){assert.fail('getter must not run');}}])
    await assert.rejects(owner.claimDue(options),/invalid_options/);
  assert.equal(calls.length,0);
});

test('union recovery refuses corrupt returned scope, failure count and inconsistent row counts',async()=>{
  for(const bad of [{...row,attempts:6},{...row,account_id:'\ud800'},{...row,assignment_file_id:'9223372036854775808'},
    {...row,actor_user_id:'foreign'}, {...row,claim_token:null}])
    await assert.rejects(setup({rows:[bad]}).owner.claimDue(),/corrupt|invalid_claim|invalid_identifier/);
  await assert.rejects(setup({rowCount:0}).owner.claimDue(),/corrupt/);
});

test('headless9 recovery keeps closed scheduling inputs and refuses autocommit and corrupt claims',async()=>{
  const {owner,calls}=setup();const [value]=await owner.claimInitialDue({limit:1,leaseSeconds:15});
  assert.equal(value.authority,'not_established');assert.equal(value.claim.attempts,3);
  assert.deepEqual(calls.find(c=>c.sql.includes(':initial-claim')).values,[1,15]);
  assert.ok(calls.find(c=>c.sql.includes(':initial-claim')).sql.includes('app.neighborhood_v2_initial_union_claim_bound(job)'));
  const auto=setup({auto:true});await assert.rejects(auto.owner.claimInitialDue(),/caller_transaction_required/);
  assert.equal(auto.calls.length,2);
  for(const raw of [{limit:1,leaseSeconds:14},{limit:1,leaseSeconds:901},{limit:1,leaseSeconds:120,checkpoint:{}},
    {limit:1,get leaseSeconds(){assert.fail('no getter');}},new Proxy({limit:1,leaseSeconds:15},{})]){
    const s=setup();await assert.rejects(s.owner.claimInitialDue(raw),/invalid_options/);assert.equal(s.calls.length,0);
  }
  await assert.rejects(setup({rows:[{...row,attempts:6}]}).owner.claimInitialDue(),/corrupt|invalid_claim/);
});
