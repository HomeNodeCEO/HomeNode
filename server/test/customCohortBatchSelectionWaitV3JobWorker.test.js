import test from 'node:test';
import assert from 'node:assert/strict';
import { runCustomCohortBatchSelectionWaitV3JobOnce as run } from '../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3JobWorker.js';
import { createCustomCohortBatchSelectionWaitV3WorkerRepository as repository } from '../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3WorkerRepository.js';
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`,
  claim={operation_id:id('1'),claim_token:id('2'),attempts:5},
  scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'},
  row={claim,scope,actor_user_id:id('5'),phase:'frozen_recorded_catalog_refs_v2',progress_done:true,authority:'not_established'},
  request={operation_id:claim.operation_id,execution_mode:'frozen-originals-v2',discovery:{profile_id:'custom-suburban-radius-v2',radius_metres:'8046.72'},
    observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'}};
function fixture({issued=row,actorError,ownerError,cancel=false,badResult,unknownClaim=false,job=request}={}){
  const calls=[],failures=[];let commits=0;
  const args={pool:{async connect(){return {async query(c){if(c.text==='COMMIT'&&++commits===1&&unknownClaim)throw Error('lost claim COMMIT');
    return {rowCount:0,rows:[]};},release(){}};}},
    cohortService:{async awaitCoveredOriginalFrozenCaptureJobBatchSelectionReferencesV3(input,options){calls.push({input,options});if(ownerError)throw ownerError;
      return {receipt_format:'cohort_recorded_catalog_batch_receipt_v3',status:'awaiting_selection',operation_id:claim.operation_id,covered_neutral_originals:true,attempts:5,
        context_complete:false,pin_transfer:false,report_update:'none',genuine_selection_intent:false,lease_released:true,
        original_reconciliation:'fresh_terminal_original_cache_and_partition_empty_probe_after_issued_catalog_DONE',...badResult};}},
    claimRepositoryFactory:()=>({async claimDue(){return issued?[issued]:[];}}),
    repositoryFactory:()=>({async heartbeat(){return {cancellation_requested:cancel};},async readRequest(){return job;},
      async failClaim(actual,reason){assert.deepEqual(actual,claim);failures.push(reason);return {status:'retry'};}}),
    async loadActor(client,actor,organization){assert.equal(actor,row.actor_user_id);assert.equal(organization,scope.organization_id);
      if(actorError)throw actorError;return {userId:actor};}};
  return {args,calls,failures};
}
test('catalog DONE at five invokes only the covered original waiting owner, without workspace or group authority',async()=>{
  const f=fixture();assert.deepEqual(await run(f.args),{status:'awaiting_selection',operation_id:claim.operation_id,
    genuine_selection_intent:false,context_complete:false,pin_transfer:false,report_update:'none'});
  assert.deepEqual(f.calls[0].input,{auth:{userId:row.actor_user_id},accountId:scope.account_id,assignmentFileId:'7',operationId:claim.operation_id,
    observationPeriod:request.observation_period,discovery:request.discovery});
  assert.deepEqual(Object.keys(f.calls[0].options),['captureJobClaim','signal']);assert.deepEqual(f.failures,[]);
});
test('idle and unknown native claim COMMIT never call the source owner',async()=>{
  for(const [options,status] of [[{issued:null},'idle'],[{unknownClaim:true},'outcome_unknown']]){
    const f=fixture(options);assert.equal((await run(f.args)).status,status);assert.equal(f.calls.length,0);
  }
});
test('current DB revocation, cancellation, legacy and private-import requests refuse before originals',async()=>{
  for(const [options,reason] of [[{actorError:Error('custom_cohort_job_actor_access_revoked')},'access_revoked'],
    [{cancel:true},'cancelled'],[{job:{...request,execution_mode:undefined}},'capture_failed'],
    [{job:{...request,private_sales_import:{}}},'capture_failed']]){
    const f=fixture(options);assert.equal((await run(f.args)).reason,reason);assert.equal(f.calls.length,0);assert.deepEqual(f.failures,[reason]);
  }
});
test('only a complete covered waiting result can release this worker',async()=>{
  for(const badResult of [{receipt_format:'cohort_recorded_catalog_receipt_v2'},{covered_neutral_originals:false},{context_complete:true},{pin_transfer:true},{report_update:'saved'},
    {genuine_selection_intent:true},{lease_released:false},{attempts:4},{original_reconciliation:'counts_only'},
    {status:'original_recorded_catalog_progress_retained'}]){
    const f=fixture({badResult});assert.equal((await run(f.args)).status,'retry');assert.deepEqual(f.failures,['capture_failed']);
  }
});
test('lost actual wait COMMIT acknowledgement cannot overwrite the waiting state or a successor',async()=>{
  const f=fixture({ownerError:Object.assign(Error('lost actual owner ACK'),{outcome_unknown:true})});
  f.args.repositoryFactory=()=>({async heartbeat(){return {cancellation_requested:false};},async readRequest(){return request;},
    async failClaim(){throw Error('custom_cohort_capture_job_claim_lost');}});
  assert.equal((await run(f.args)).status,'outcome_unknown');
});
test('unfinished catalog and every foreign phase refuse before original transport',async()=>{
  for(const issued of [{...row,progress_done:false},{...row,phase:'frozen_recorded_partition_refs_v2'},
    {...row,phase:'frozen_selected_union_refs_v2'}]){
    const f=fixture({issued});assert.equal((await run(f.args)).status,'retry');assert.equal(f.calls.length,0);
  }
});
test('all native routing lanes require completed covered parents and exclude existing immutable human commands',async()=>{
  const calls=[],raw={...claim,...scope,actor_user_id:row.actor_user_id,phase:row.phase,progress_done:true};
  const r=repository({async query(sql,values){calls.push({sql,values});if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'1'}]};
    return sql.includes(':claim-success')?{rowCount:1,rows:[raw]}:{rowCount:0,rows:[]};}});
  assert.deepEqual(await r.claimDue({leaseSeconds:300}),[row]);
  for(const q of calls.filter(c=>!c.sql.includes(':transaction'))){
    assert.match(q.sql,/routing.receipt->'after'->>'done'='true'/);assert.doesNotMatch(q.sql,/done'='false'/);
    assert.match(q.sql,/catalog.partition_reference=partition.receipt_reference/);
    assert.match(q.sql,/NOT EXISTS\(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents/);
    assert.match(q.sql,/request_sha256=job.request_sha256/);assert.deepEqual(q.values.at(-1),['frozen_recorded_catalog_refs_v2']);
  }
  const success=calls.find(c=>c.sql.includes(':claim-success')).sql;assert.doesNotMatch(success,/attempts=attempts\+1|ST_DWithin|DELETE/);
});
test('success AND recovery require the actual matching pending study; neither creates a workspace or human choice',async()=>{
  const calls=[];await repository({async query(sql,values){calls.push({sql,values});return sql.includes(':transaction')
    ?{rowCount:1,rows:[{transaction_id:'7'}]}:{rowCount:0,rows:[]};}}).claimDue({leaseSeconds:300});
  for(const {sql} of calls.filter(c=>/:claim-(success|recovery)/.test(c.sql))){
    assert.match(sql,/workspace.assignment_file_id=job.assignment_file_id/);
    for(const key of ['operation_id','observation_period','discovery','private_sales_import'])assert.ok(sql.includes(`'${key}'`));
    assert.match(sql,/octet_length\(workspace.section_value::text\)<=524288/);
    assert.doesNotMatch(sql,/INSERT|included_recorded_group_ids/);
  }
  assert.match(calls.find(c=>c.sql.includes(':claim-recovery')).sql,/job.attempts<5/);
});
test('closed options and implicit autocommit refuse before native catalog adoption',async()=>{
  let calls=0;const r=repository({async query(){calls++;assert.fail('SQL');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:901},{leaseSeconds:300,done:true},new Proxy({leaseSeconds:300},{}),
    {get leaseSeconds(){assert.fail('getter');}}])await assert.rejects(r.claimDue(options),/invalid_/);
  assert.equal(calls,0);const auto=repository({async query(){return {rowCount:1,rows:[{transaction_id:String(++calls)}]};}});
  await assert.rejects(auto.claimDue({leaseSeconds:300}),/caller_transaction_required/);assert.equal(calls,2);
});
