import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortBatchSelectedEligibilityV3WorkerRepository as repository }
  from '../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3WorkerRepository.js';
import { runCustomCohortBatchSelectedEligibilityV3JobOnce as run }
  from '../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3JobWorker.js';

const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const claim={operation_id:id('1'),claim_token:id('2'),attempts:5};
const scope={organization_id:id('3'),report_file_id:id('4'),assignment_file_id:'7',account_id:'FIXTURE'};
const phases=['frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'];
const methods=['progressCoveredOriginalFrozenCaptureJobBatchSelectedRecordedEligibilityReferencesV3'];
const statuses=['original_selected_recorded_eligibility_progress_retained'];
const row={claim,scope,actor_user_id:id('5'),phase:phases[0],progress_done:true,authority:'not_established'};
const request={operation_id:claim.operation_id,execution_mode:'frozen-originals-v2',
  observation_period:{start_date:'2024-01-01',end_date:'2024-12-31'},discovery:{profile_id:'custom-suburban-radius-v2'}};
function fixture({due=row,job=request,actorError,cancel=false,ownerError,failureError,badResult}={}){
  const calls=[],failures=[];
  const args={pool:{async connect(){return {async query(){return {rowCount:0,rows:[]};},release(){}};}},
    claimRepositoryFactory:()=>({async claimDue(){return due?[due]:[];}}),
    repositoryFactory:()=>({async readRequest(){return job;},async heartbeat(){return {cancellation_requested:cancel};},
      async failClaim(actual,reason){assert.deepEqual(actual,claim);failures.push(reason);if(failureError)throw failureError;return {status:'retry'};}}),
    async loadActor(client,actor,organization){assert.equal(actor,row.actor_user_id);assert.equal(organization,scope.organization_id);
      if(actorError)throw actorError;return {userId:actor};},
    cohortService:Object.fromEntries(methods.map((method,i)=>[method,async(input,options)=>{
      calls.push({method,input,options});if(ownerError)throw ownerError;
      return {catalog_receipt_format:'cohort_recorded_catalog_batch_receipt_v3',status:statuses[i],operation_id:claim.operation_id,covered_neutral_originals:true,
        context_complete:false,pin_transfer:false,report_update:'none',continuation:{status:'continuation_pending',phase:phases[1],
          attempts:5,fresh_claim_required:true,context_complete:false,pin_transfer:false},...badResult};
    }]))};
  return {args,calls,failures};
}
test('only the union-DONE and incomplete recorded-eligibility routes invoke the saved actor and exact native claim',async()=>{
  for(const [phase,progress_done,target] of [[phases[0],true,0],[phases[1],false,0]]){
    const f=fixture({due:{...row,phase,progress_done}});
    assert.equal((await run(f.args)).status,'continuation_pending');assert.equal(f.calls[0].method,methods[target]);
    assert.equal(f.calls[0].input.auth.userId,row.actor_user_id);assert.deepEqual(f.calls[0].options.captureJobClaim,claim);
    assert.deepEqual(Object.keys(f.calls[0].options),['captureJobClaim','signal']);assert.deepEqual(f.failures,[]);
  }
});
test('incomplete union, eligibility DONE and unsupported stages cannot spend a claim at an uninstalled owner',async()=>{
  for(const due of [{...row,phase:phases[0],progress_done:false},{...row,phase:phases[1],progress_done:true},{...row,phase:'frozen_selected_evidence_refs_v2'}]){
    const f=fixture({due});assert.equal((await run(f.args)).reason,'capture_failed');assert.equal(f.calls.length,0);
  }
  const idle=fixture({due:null});assert.deepEqual(await run(idle.args),{status:'idle'});assert.equal(idle.calls.length,0);
});
test('current revocation, cancellation, legacy and private requests refuse before original reads',async()=>{
  for(const [options,reason] of [[{actorError:Error('custom_cohort_job_actor_access_revoked')},'access_revoked'],
    [{cancel:true},'cancelled'],[{job:{...request,execution_mode:undefined}},'capture_failed'],
    [{job:{...request,private_sales_import:{}}},'capture_failed']]){
    const f=fixture(options);assert.equal((await run(f.args)).reason,reason);assert.equal(f.calls.length,0);
  }
});
test('covered progress cannot claim completion, publication or a different continuation',async()=>{
  for(const badResult of [{catalog_receipt_format:'cohort_recorded_catalog_receipt_v2'},{covered_neutral_originals:false},{context_complete:true},{pin_transfer:true},{report_update:'saved'},
    {operation_id:id('6')},{continuation:{status:'continuation_pending',phase:phases[0],attempts:5}}]){
    const f=fixture({badResult});assert.equal((await run(f.args)).reason,'capture_failed');
  }
});
test('lost real owner acknowledgement cannot overwrite committed native progress',async()=>{
  const f=fixture({ownerError:Object.assign(Error('lost COMMIT'),{outcome_unknown:true}),failureError:Error('custom_cohort_capture_job_claim_lost')});
  assert.deepEqual(await run(f.args),{status:'outcome_unknown',operation_id:claim.operation_id});
});
test('all native claim and expiry lanes require covered lineage, immutable command and the same eligibility-DONE boundary',async()=>{
  const calls=[];const owner=repository({async query(sql,values){calls.push({sql,values});
    if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'10'}]};return {rowCount:0,rows:[]};}});
  assert.deepEqual(await owner.claimDue(),[]);
  for(const tag of [':expire',':claim-success',':claim-recovery']){
    const sql=calls.find(c=>c.sql.includes(tag)).sql;
    for(const guard of ['neighborhood_custom_cohort_cache_stock_v2_bridges','neighborhood_custom_cohort_neutral_success_v2_jobs',
      'neighborhood_custom_cohort_neutral_cache_v2_heads','neighborhood_custom_cohort_recorded_partition_v2_heads',
      'neighborhood_custom_cohort_recorded_catalog_v2_heads','first.actor_user_id=job.actor_user_id','first.request_sha256=job.request_sha256',
      'job.request_sha256=intent.request_sha256','app.neighborhood_selected_union_v2_checkpoint_matches',
      "completed_catalog.receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3'",
      "completed_stock.receipt->>'format'='cohort_stock_traversal_batch_receipt_v3'",
      "completed_partition.receipt->>'format'='cohort_recorded_group_partition_batch_receipt_v3'",
      "workspace.section_value->'pending_capture'->>'operation_id'=job.operation_id::text",
      "workspace.section_value->'pending_capture'->'observation_period'=job.request_payload->'observation_period'",
      "workspace.section_value->'pending_capture'->'discovery'=job.request_payload->'discovery'",
      "routing.receipt->'after'->>'done'='false'",
      "issued_source.receipt->'root'=cache.root_reference",
      "issued_source.receipt->'selection'->'subject_intent'=job.checkpoint->'evidence_refs'->0"])
      assert.ok(sql.includes(guard),tag+' '+guard);
    assert.doesNotMatch(sql,/cache.root_reference=job.checkpoint->'evidence_refs'->0/);
  }
  const success=calls.find(c=>c.sql.includes(':claim-success'));assert.deepEqual(success.values[1],phases);
  assert.doesNotMatch(success.sql,/attempts=attempts\+1|attempts=0|DELETE|ST_DWithin/);
  const recovery=calls.find(c=>c.sql.includes(':claim-recovery')).sql;
  assert.match(recovery,/job.attempts<5/);assert.match(recovery,/attempts=attempts\+1/);
});

test('incomplete union, terminal eligibility and unrelated native phases cannot leave the progress claim repository',async()=>{
  for(const changed of [{progress_done:false},{phase:phases[1],progress_done:true},{phase:'frozen_selected_evidence_refs_v2'},{progress_done:'false'}]){
    const owner=repository({async query(sql){
      if(sql.includes(':transaction'))return {rowCount:1,rows:[{transaction_id:'10'}]};
      if(sql.includes(':expire'))return {rowCount:0,rows:[]};
      return {rowCount:1,rows:[{...claim,...scope,actor_user_id:row.actor_user_id,phase:phases[0],progress_done:true,...changed}]};
    }});
    await assert.rejects(owner.claimDue(),/corrupt/);
  }
});
test('caller routes, tokens and callbacks cannot change native routing',async()=>{
  const owner=repository({async query(){assert.fail('no SQL for invalid options');}});
  for(const options of [{leaseSeconds:14},{leaseSeconds:120,phase:phases[0]},{leaseSeconds:120,claim},
    {leaseSeconds:120,source(){}},new Proxy({leaseSeconds:120},{}),{get leaseSeconds(){assert.fail('getter');}}])
    await assert.rejects(owner.claimDue(options),/invalid_input|invalid_options/);
});
