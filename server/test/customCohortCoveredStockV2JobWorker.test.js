import test from 'node:test';
import assert from 'node:assert/strict';
import { runCustomCohortCoveredStockV2JobOnce as run } from '../src/services/neighborhoodAssessment/customCohortCoveredStockV2JobWorker.js';
import { createCustomCohortCoveredStockV2WorkerRepository as repository } from '../src/services/neighborhoodAssessment/customCohortCoveredStockV2WorkerRepository.js';
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
  claim={operation_id:id('1'),claim_token:id('2'),attempts:5},
  scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'},
  row={claim,scope,actor_user_id:id('5'),phase:'frozen_stock_traversal_refs_v2',progress_done:false,authority:'not_established'},
  request={operation_id:claim.operation_id,execution_mode:'frozen-originals-v2',discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
    observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}};
function fixture({issued=row,actorError,ownerError,cancel=false,badResult,unknownClaim=false,job=request}={}){
  const calls=[],failures=[];let commits=0;
  const args={pool:{async connect(){return {async query(c){if(c.text==='COMMIT'&&++commits===1&&unknownClaim)throw Error('lost claim COMMIT');
    return {rowCount:0,rows:[]};},release(){}};}},
    cohortService:{async continueCoveredOriginalFrozenCaptureJobStockTraversalReferencesV2(input,options){calls.push({input,options});if(ownerError)throw ownerError;
      return {status:'original_stock_traversal_progress_retained',operation_id:claim.operation_id,automatic_cache_stock_handoff:false,
        context_complete:false,pin_transfer:false,report_update:'none',continuation:{status:'continuation_pending',phase:'frozen_stock_traversal_refs_v2',
          attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false},...badResult};}},
    claimRepositoryFactory:()=>({async claimDue(){return issued?[issued]:[];}}),
    repositoryFactory:()=>({async heartbeat(){return {cancellation_requested:cancel};},async readRequest(){return job;},
      async failClaim(actual,reason){assert.deepEqual(actual,claim);failures.push(reason);return {status:'retry'};}}),
    async loadActor(client,actor,organization){assert.equal(actor,row.actor_user_id);assert.equal(organization,scope.organization_id);
      if(actorError)throw actorError;return {userId:actor};}};
  return {args,calls,failures};
}
test('covered stock success at the failure ceiling still invokes the real original owner with only the live claim and signal',async()=>{
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
  for(const badResult of [{automatic_cache_stock_handoff:true},{context_complete:true},{pin_transfer:true},{report_update:'saved'},
    {continuation:{status:'continuation_pending',phase:'frozen_identity_refs_v2',attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false}}]){
    const f=fixture({badResult});assert.equal((await run(f.args)).status,'retry');assert.deepEqual(f.failures,['capture_failed']);
  }
});
test('lost owner COMMIT acknowledgment cannot overwrite native successor ownership',async()=>{
  const f=fixture({ownerError:Object.assign(Error('lost actual owner ACK'),{outcome_unknown:true})});
  f.args.repositoryFactory=()=>({async heartbeat(){return {cancellation_requested:false};},async readRequest(){return request;},
    async failClaim(){throw Error('custom_cohort_capture_job_claim_lost');}});
  assert.equal((await run(f.args)).status,'outcome_unknown');
});
test('terminal or foreign phase hints refuse before originals',async()=>{
  for(const issued of [{...row,progress_done:true},{...row,phase:'frozen_recorded_partition_refs_v2'}]){
    const f=fixture({issued});assert.equal((await run(f.args)).status,'retry');assert.equal(f.calls.length,0);
  }
});
test('native stock routing consumes success at attempt five and keeps DONE outside every claim/expiry query',async()=>{
  const calls=[],raw={...claim,...scope,actor_user_id:row.actor_user_id,phase:row.phase,progress_done:false};
  const r=repository({async query(sql,values){calls.push({sql,values});if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'1'}]};
    return sql.includes(':claim-success')?{rowCount:1,rows:[raw]}:{rowCount:0,rows:[]};}});
  assert.deepEqual(await r.claimDue({leaseSeconds:300}),[row]);
  for(const q of calls.filter(c=>!c.sql.includes(':transaction'))){
    assert.match(q.sql,/done'='false'/);assert.match(q.sql,/completed_reference IS NOT NULL/);
    assert.match(q.sql,/request_sha256=job.request_sha256/);assert.deepEqual(q.values.at(-1),['frozen_stock_traversal_refs_v2']);
  }
  const success=calls.find(c=>c.sql.includes(':claim-success')).sql;assert.doesNotMatch(success,/attempts=attempts\+1|ST_DWithin|DELETE/);
});
test('closed options and implicit autocommit refuse before native stock adoption',async()=>{
  let calls=0;const r=repository({async query(){calls++;assert.fail('SQL');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:901},{leaseSeconds:300,done:true},new Proxy({leaseSeconds:300},{}),
    {get leaseSeconds(){assert.fail('getter');}}])await assert.rejects(r.claimDue(options),/invalid_/);
  assert.equal(calls,0);const auto=repository({async query(){return {rowCount:1,rows:[{transaction_id:String(++calls)}]};}});
  await assert.rejects(auto.claimDue({leaseSeconds:300}),/caller_transaction_required/);assert.equal(calls,2);
});
