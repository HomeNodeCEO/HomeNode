import test from 'node:test';
import assert from 'node:assert/strict';
import { runCustomCohortSourcePrefixV2JobOnce } from '../src/services/neighborhoodAssessment/customCohortSourcePrefixV2JobWorker.js';
import { createCustomCohortSourcePrefixV2ContinuationRepository } from '../src/services/neighborhoodAssessment/customCohortSourcePrefixV2ContinuationRepository.js';

const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const claim={operation_id:id('1'),claim_token:id('2'),attempts:5};
const scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'};
const row={claim,scope,actor_user_id:id('5'),phase:'frozen_source_refs_v2',progress_done:false,authority:'not_established'};
const request={operation_id:claim.operation_id,discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
  observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}};
const methods=['continueFrozenCaptureJobSourcePrefixReferencesV2Page','continueFrozenCaptureJobSourceReferencesV2Page'];
const phase=index=>index?'frozen_verify_refs_v2':'frozen_source_refs_v2';
function workerFixture({issued=row,actorError,ownerError,cancel=false,badResult,unknownClaim=false}={}){
  const calls=[],failures=[];
  const cohortService=Object.fromEntries(methods.map((method,index)=>[method,async(input,options)=>{
    calls.push({method,input,options});if(ownerError)throw ownerError;
    return {status:index?'original_graph_progress_retained':'source_reference_prefix_retained',operation_id:claim.operation_id,
      context_complete:false,pin_transfer:false,report_update:'none',continuation:{status:'continuation_pending',phase:phase(index),
        attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false},...badResult};
  }]));
  let commits=0;
  const args={pool:{async connect(){return {async query(config){if(config.text==='COMMIT'&&++commits===1&&unknownClaim)throw Error('lost claim COMMIT');return {rowCount:0,rows:[]};},release(){}};}},cohortService,
    claimRepositoryFactory:()=>({async claimDue(){return issued?[issued]:[];}}),
    repositoryFactory:()=>({async heartbeat(){return {cancellation_requested:cancel};},async readRequest(){return request;},
      async failClaim(actual,reason){assert.deepEqual(actual,claim);failures.push(reason);return {status:'retry'};}}),
    async loadActor(client,actor,organization){assert.equal(actor,row.actor_user_id);assert.equal(organization,scope.organization_id);
      if(actorError)throw actorError;return {userId:actor};}};
  return {args,calls,failures};
}

test('native unfinished prefix and completed prefix route only to the two actual original owners',async()=>{
  for(const done of [false,true]){const f=workerFixture({issued:{...row,progress_done:done}});
    assert.deepEqual(await runCustomCohortSourcePrefixV2JobOnce(f.args),{status:'continuation_pending',operation_id:claim.operation_id,
      context_complete:false,pin_transfer:false,report_update:'none'});
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,methods[Number(done)]);
    assert.deepEqual(f.calls[0].input,{auth:{userId:row.actor_user_id},accountId:'FIXTURE',assignmentFileId:'7',
      operationId:claim.operation_id,observationPeriod:request.observation_period,discovery:request.discovery});
    assert.deepEqual(Object.keys(f.calls[0].options),['captureJobClaim','signal']);assert.deepEqual(f.failures,[]);
  }
});

test('idle, uncertain claim commit and foreign phases do not query originals',async()=>{
  for(const [options,status] of [[{issued:null},'idle'],[{unknownClaim:true},'outcome_unknown'],
    [{issued:{...row,phase:'frozen_verify_refs_v2'}},'retry'],[{issued:{...row,progress_done:'true'}},'retry']]){
    const f=workerFixture(options);assert.equal((await runCustomCohortSourcePrefixV2JobOnce(f.args)).status,status);assert.equal(f.calls.length,0);
  }
});

test('current revoked actor and cancellation refuse before originals and settle the exact failure claim',async()=>{
  for(const [options,reason] of [[{actorError:Error('custom_cohort_job_actor_access_revoked')},'access_revoked'],[{cancel:true},'cancelled']]){
    const f=workerFixture(options);const result=await runCustomCohortSourcePrefixV2JobOnce(f.args);
    assert.equal(result.reason,reason);assert.equal(f.calls.length,0);assert.deepEqual(f.failures,[reason]);
  }
});

test('wrong completion, output phase or failure attempts cannot publish progress',async()=>{
  for(const badResult of [{context_complete:true},{pin_transfer:true},{report_update:'saved'},
    {continuation:{status:'continuation_pending',phase:'frozen_verify_refs_v2',attempts:4,fresh_claim_required:true,context_complete:false,pin_transfer:false}}]){
    const f=workerFixture({badResult});assert.equal((await runCustomCohortSourcePrefixV2JobOnce(f.args)).status,'retry');
    assert.deepEqual(f.failures,['capture_failed']);
  }
});

test('uncertain owner commit preserves native successor ownership when failure settlement loses the old claim',async()=>{
  const f=workerFixture({ownerError:Object.assign(Error('lost owner COMMIT'),{outcome_unknown:true})});
  f.args.repositoryFactory=()=>({async heartbeat(){return {cancellation_requested:false};},async readRequest(){return request;},
    async failClaim(){throw Error('custom_cohort_capture_job_claim_lost');}});
  assert.deepEqual(await runCustomCohortSourcePrefixV2JobOnce(f.args),{status:'outcome_unknown',operation_id:claim.operation_id});
});

test('native claim routing keeps success attempts and spends exactly one only for recovery',async()=>{
  const queries=[];const raw={...claim,...scope,actor_user_id:row.actor_user_id,progress_done:true};
  const repository=createCustomCohortSourcePrefixV2ContinuationRepository({async query(sql,values){queries.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'100'}]};
    if(sql.includes(':claim-recovery'))return {rowCount:1,rows:[raw]};return {rowCount:0,rows:[]};}});
  assert.deepEqual(await repository.claimDue({leaseSeconds:300}),[{...row,progress_done:true}]);
  const success=queries.find(q=>q.sql.includes(':claim-success')).sql,recovery=queries.find(q=>q.sql.includes(':claim-recovery')).sql;
  assert.match(success,/consumed_attempts=job\.attempts\+0/);assert.match(recovery,/consumed_attempts=job\.attempts\+1/);
  assert.match(recovery,/job\.attempts<5/);assert.match(success,/FOR UPDATE OF job SKIP LOCKED/);
  for(const q of [success,recovery]){assert.match(q,/c\.sequence=h\.sequence/);assert.match(q,/job\.checkpoint->>'phase'='frozen_source_refs_v2'/);
    assert.doesNotMatch(q,/source_records.*payload|ST_DWithin|attempts=0|checkpoint=/);}
});

test('closed native claims reject caller routing, callbacks, hostile descriptors and unsafe leases before SQL',async()=>{
  let queries=0;const repository=createCustomCohortSourcePrefixV2ContinuationRepository({async query(){queries++;assert.fail('SQL');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:901},{leaseSeconds:300,done:true},{leaseSeconds:300,source:()=>{}},
    new Proxy({leaseSeconds:300},{}),{get leaseSeconds(){assert.fail('getter');}}])await assert.rejects(repository.claimDue(options),/invalid_/);
  assert.equal(queries,0);
});
