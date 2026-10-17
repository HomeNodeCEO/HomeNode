import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortSelectedEligibilityV2RecoveryRepository as repository }
  from '../src/services/neighborhoodAssessment/customCohortSelectedEligibilityV2RecoveryRepository.js';

const id=n=>`70000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row={operation_id:id(1),claim_token:id(2),attempts:4,organization_id:id(3),report_file_id:id(4),
  assignment_file_id:'7',account_id:'A',actor_user_id:id(5)};
// These detached checks cover only the public boundary. Native graph eligibility,
// actual rollback, single-winner COMMIT and fifth-failure exhaustion run in CI.
function setup({auto=false,rows=[row],rowCount=rows.length,changeAfterWrite=false}={}){let tx=40,written=false;const calls=[];
  return {calls,owner:repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:String(auto?++tx:tx+(written&&changeAfterWrite?1:0))}]};
    written=true;return {rowCount,rows};}})};}

test('eligibility recovery returns scheduling scope without original or source authority',async()=>{
  const {owner,calls}=setup(),rows=await owner.claimDue({limit:1,leaseSeconds:15}),[value]=rows;
  assert.deepEqual(value,{claim:{operation_id:row.operation_id,claim_token:row.claim_token,attempts:4},
    scope:{organization_id:row.organization_id,report_file_id:row.report_file_id,assignment_file_id:'7',account_id:'A'},
    actor_user_id:row.actor_user_id,authority:'not_established'});
  assert.ok(Object.isFrozen(rows)&&Object.isFrozen(value)&&Object.isFrozen(value.claim)&&Object.isFrozen(value.scope));
  assert.deepEqual(calls.find(c=>c.sql.includes(':claim')).values,[1,15]);
  assert.deepEqual(await setup({rows:[]}).owner.claimDue(),[]);
});

test('eligibility recovery refuses autocommit before mutation and refuses changed transactions after writing',async()=>{
  const {owner,calls}=setup({auto:true});await assert.rejects(owner.claimDue(),/caller_transaction_required/);
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.sql.includes(':transaction')));
  await assert.rejects(setup({changeAfterWrite:true}).owner.claimDue(),/caller_transaction_required/);
});

test('eligibility recovery accepts no caller roots, phase, cursor, attempts, authority, getters or proxies',async()=>{
  const {owner,calls}=setup();
  for(const options of [null,[],{limit:0,leaseSeconds:120},{limit:5,leaseSeconds:120},{limit:1,leaseSeconds:14},
    {limit:1,leaseSeconds:901},{limit:1,leaseSeconds:120,attempts:0},{limit:1,leaseSeconds:120,checkpoint:{}},
    {limit:1,leaseSeconds:120,phase:'frozen_selected_eligibility_refs_v2'},{limit:1,leaseSeconds:120,ordinal:2},
    {limit:1,leaseSeconds:120,source_authorized:true},new Proxy({limit:1,leaseSeconds:120},{}),
    {limit:1,get leaseSeconds(){assert.fail('getter must not run');}}])
    await assert.rejects(owner.claimDue(options),/invalid_options/);
  assert.equal(calls.length,0);
});

test('eligibility recovery refuses corrupt native scope, claim counts and row cardinality',async()=>{
  for(const bad of [{...row,attempts:6},{...row,account_id:'\ud800'},{...row,assignment_file_id:'9223372036854775808'},
    {...row,actor_user_id:'foreign'}, {...row,claim_token:null}])
    await assert.rejects(setup({rows:[bad]}).owner.claimDue(),/corrupt|invalid_claim|invalid_identifier/);
  await assert.rejects(setup({rowCount:0}).owner.claimDue(),/corrupt/);
  await assert.rejects(setup({rows:[row,row]}).owner.claimDue(),/corrupt/);
});
