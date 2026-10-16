import test from 'node:test';
import assert from 'node:assert/strict';
import { runCustomCohortCadCacheV2JobOnce as run } from '../src/services/neighborhoodAssessment/customCohortCadCacheV2JobWorker.js';
import { createCustomCohortCadCacheV2ContinuationRepository as repository } from '../src/services/neighborhoodAssessment/customCohortCadCacheV2ContinuationRepository.js';
import { createCustomCohortNeutralCacheV2CadParentHeadRepository as cadParent } from '../src/services/neighborhoodAssessment/customCohortNeutralCacheV2HeadRepository.js';
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
  claim={operation_id:id('1'),claim_token:id('2'),attempts:5},
  scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'},
  row={claim,scope,actor_user_id:id('5'),authority:'not_established'},
  request={operation_id:claim.operation_id,execution_mode:'frozen-originals-v2',discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
    observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}};
function fixture({issued=row,actorError,ownerError,cancel=false,badResult,unknownClaim=false,job=request}={}){
  const calls=[],failures=[];let commits=0;
  const args={pool:{async connect(){return {async query(c){if(c.text==='COMMIT'&&++commits===1&&unknownClaim)throw Error('lost claim COMMIT');
    return {rowCount:0,rows:[]};},release(){}};}},
    cohortService:{async continueFrozenCaptureJobCadOriginalsReferencesV2(input,options){calls.push({input,options});if(ownerError)throw ownerError;
      return {status:'current_authorized_CAD_cache_coverage_progress_v2',operation_id:claim.operation_id,automatic_CAD_cache_success:true,
        context_complete:false,pin_transfer:false,report_update:'none',continuation:{status:'continuation_pending',lane:'CAD_cache_v2',
          attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false},...badResult};}},
    claimRepositoryFactory:()=>({async claimDue(){return issued?[issued]:[];}}),
    repositoryFactory:()=>({async heartbeat(){return {cancellation_requested:cancel};},async readRequest(){return job;},
      async failClaim(actual,reason){assert.deepEqual(actual,claim);failures.push(reason);return {status:'retry'};}}),
    async loadActor(client,actor,organization){assert.equal(actor,row.actor_user_id);assert.equal(organization,scope.organization_id);
      if(actorError)throw actorError;return {userId:actor};}};
  return {args,calls,failures};
}
test('cache success at the failure ceiling still invokes the real original owner with only the live claim and signal',async()=>{
  const f=fixture();assert.equal((await run(f.args)).status,'continuation_pending');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].input,{auth:{userId:row.actor_user_id},accountId:scope.account_id,assignmentFileId:'7',operationId:claim.operation_id,
    observationPeriod:request.observation_period,discovery:request.discovery});
  assert.deepEqual(Object.keys(f.calls[0].options),['captureJobClaim','signal']);assert.deepEqual(f.failures,[]);
});
test('idle and unknown claim COMMIT never call the source owner',async()=>{
  for(const [options,status] of [[{issued:null},'idle'],[{unknownClaim:true},'outcome_unknown']]){
    const f=fixture(options);assert.equal((await run(f.args)).status,status);assert.equal(f.calls.length,0);
  }
});
test('revoked actor, cancellation and a legacy request refuse before originals',async()=>{
  for(const [options,reason] of [[{actorError:Error('custom_cohort_job_actor_access_revoked')},'access_revoked'],
    [{cancel:true},'cancelled'],[{job:{...request,execution_mode:undefined}},'capture_failed']]){
    const f=fixture(options);assert.equal((await run(f.args)).reason,reason);assert.equal(f.calls.length,0);assert.deepEqual(f.failures,[reason]);
  }
});
test('invalid success lane or publication claims settle the exact failed claim',async()=>{
  for(const badResult of [{automatic_CAD_cache_success:false},{context_complete:true},{pin_transfer:true},{report_update:'saved'},
    {continuation:{status:'continuation_pending',lane:'stock',attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false}}]){
    const f=fixture({badResult});assert.equal((await run(f.args)).status,'retry');assert.deepEqual(f.failures,['capture_failed']);
  }
});
test('lost owner COMMIT acknowledgment cannot overwrite native successor ownership',async()=>{
  const f=fixture({ownerError:Object.assign(Error('lost actual owner ACK'),{outcome_unknown:true})});
  f.args.repositoryFactory=()=>({async heartbeat(){return {cancellation_requested:false};},async readRequest(){return request;},
    async failClaim(){throw Error('custom_cohort_capture_job_claim_lost');}});
  assert.equal((await run(f.args)).status,'outcome_unknown');
});
test('cache native routing remains bounded and excludes the native completed cache',async()=>{
  const calls=[],raw={...claim,...scope,actor_user_id:row.actor_user_id};
  const r=repository({async query(sql,values){calls.push({sql,values});if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'1'}]};
    return sql.includes(':claim-initial')?{rowCount:1,rows:[raw]}:{rowCount:0,rows:[]};}});
  assert.deepEqual(await r.claimDue({leaseSeconds:300}),[row]);
  const existing=calls.find(c=>c.sql.includes(':claim-existing')).sql,initial=calls.find(c=>c.sql.includes(':claim-initial')).sql;
  assert.match(existing,/done'='false'/);assert.match(existing,/job\.attempts<5/);assert.match(initial,/neighborhood_cad_success_v2_parent_matches/);
  for(const sql of [existing,initial]){assert.match(sql,/LIMIT 1 FOR UPDATE OF job SKIP LOCKED/);assert.doesNotMatch(sql,/ST_DWithin|checkpoint=|attempts=0/);}
});
test('closed claim options and implicit autocommit cannot create native cache ownership',async()=>{
  let calls=0;const r=repository({async query(){calls++;assert.fail('SQL');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:901},{leaseSeconds:300,done:true},new Proxy({leaseSeconds:300},{}),
    {get leaseSeconds(){assert.fail('getter');}}])await assert.rejects(r.claimDue(options),/invalid_/);
  assert.equal(calls,0);
  const auto=repository({async query(){return {rowCount:1,rows:[{transaction_id:String(++calls)}]};}});
  await assert.rejects(auto.claimDue({leaseSeconds:300}),/caller_transaction_required/);assert.equal(calls,2);
});

test('CAD success at the account ceiling yields only native progress and cannot accept a caller lease or DONE',async()=>{
  const calls=[],r=repository({async query(sql,values){calls.push({sql,values});return sql.includes(':transaction')
    ?{rowCount:1,rows:[{transaction_id:'1'}]}:{rowCount:1,rows:[{sequence:2000001,attempts:5}]};}});
  const result=await r.yieldIssued(claim,{scope,actorUserId:row.actor_user_id});
  assert.deepEqual(result,{status:'continuation_pending',lane:'CAD_cache_v2',sequence:2000001,attempts:5,
    fresh_claim_required:true,context_complete:false,pin_transfer:false});
  const yieldCall=calls.find(c=>c.sql.includes(':yield'));
  assert.deepEqual(yieldCall.values,[claim.operation_id,claim.claim_token,5,...Object.values(scope),row.actor_user_id]);
  assert.match(yieldCall.sql,/h.sequence=e.sequence\+1/);assert.match(yieldCall.sql,/h.issued_transaction_id=txid_current\(\)/);
  assert.doesNotMatch(yieldCall.sql,/attempts=0|checkpoint=/);
  await assert.rejects(r.yieldIssued(claim,{scope,actorUserId:row.actor_user_id,lease_expires_at:'2099-01-01'}),/invalid_input/);
});

test('CAD neutral-parent capability exposes only a scoped read and never E issuance',async()=>{
  const bindings=Object.fromEntries(['source_reference','root_reference','graph_reference','geographic_reference','identity_reference','stock_reference']
    .map(k=>[k,{content_sha256:'a'.repeat(64),canonical_utf8_bytes:'123'}])),calls=[];
  const p=cadParent({client:{async query(sql,values){calls.push({sql,values});return {rowCount:1,rows:[
    Object.fromEntries([...Object.keys(bindings),'receipt_reference','sequence'].map(k=>[k,null]))]};}},claim,scope,actorUserId:row.actor_user_id,...bindings});
  assert.deepEqual(Object.keys(p),['read']);assert.equal(await p.read(),null);
  assert.match(calls[0].sql,/neighborhood_cad_success_v2_matches/);assert.doesNotMatch(calls[0].sql,/INSERT|UPDATE|DELETE/);
});
