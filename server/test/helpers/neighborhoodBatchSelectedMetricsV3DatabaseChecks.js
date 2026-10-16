import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedMetricsV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedMetricsV3WorkerRepository.js';
import { runCustomCohortBatchSelectedMetricsV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedMetricsV3JobWorker.js';
import { runCustomCohortBatchSelectedEvidenceV3JobOnce as evidence } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEvidenceV3JobWorker.js';
import { runCustomCohortBatchSelectedEligibilityV3JobOnce as eligibility } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3JobWorker.js';

/** Twenty-eighth independent graph. The real V3 evidence worker has issued its
 * own fresh terminal EMPTY; this call never copies or rebinds a native parent. */
export async function runNeighborhoodBatchSelectedMetricsV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command}){
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedMetricReferencesV3',
    readMethod='readCoveredOriginalFrozenCaptureJobBatchFirstSelectedMetricReferencesV3',
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    rows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
    parents=async()=>({union:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      rows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      eligibility:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1',[operation])).rows,
      evidence:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=$1',[operation])).rows,
      dispatch:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows}),
    before={parents:await parents(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    immutable=async()=>{assert.deepEqual(await parents(),before.parents);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    body=async reference=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3',
      [scope.organization_id,reference.content_sha256,reference.canonical_utf8_bytes])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900};
  assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);assert.equal(before.parents.evidence[0].sequence,3);
  const completedEligibility=await body(before.parents.eligibility[0].receipt_reference);
  let calls=0,ownerError,owned,ownedParent,firstClaim,firstRead;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,5);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedMetricReferencesV2(value,options),/invalid_receipt/);await unchanged();
      let reads=originalReads();firstRead=await service[readMethod](value,options);assert.equal(originalReads(),reads+1);
      assert.equal(firstRead.status,'current_authorized_first_selected_metric_originals_reopened');
      assert.equal(firstRead.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');
      assert.equal(firstRead.covered_neutral_originals,true);assert.equal(firstRead.covered_CAD_originals,true);
      assert.equal(firstRead.read_only,true);assert.equal(firstRead.lease_extended,false);assert.equal(firstRead.metric_row_retained,false);
      assert.equal(firstRead.metric_row_candidate.selected_entry.ordinal,1);assert.equal(firstRead.metric_row_candidate.selected_entry.account_id,'CLOSURE-A');
      assert.deepEqual(firstRead.metric_row_candidate.observation_period,input.observationPeriod);
      for(const [metric,cell] of Object.entries(firstRead.metric_row_candidate.metrics))
        for(const key of ['recorded_comparison_eligible','complete_observed_parts','exact_value','unit'])
          assert.deepEqual(cell[key],firstRead.reported_comparison.metrics[metric][key]);
      assert.equal(firstRead.metric_row_candidate.metrics.reported_market_value.exact_value,null);
      assert.equal(firstRead.context_complete,false);assert.equal(firstRead.pin_transfer,false);await unchanged();
      setFault('selected_CAD_ack');reads=originalReads();await assert.rejects(service[readMethod](value,options),e=>e.outcome_unknown===true);
      assert.equal(originalReads(),reads+1);assert.equal(readFault(),null);assert.deepEqual(await service[readMethod](value,options),firstRead);await unchanged();
      for(const [fault,reason] of [['selected_CAD_workspace',/custom_cohort_group_workspace_study_changed/],
        ['selected_CAD_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
        ['selected_CAD_deny',/market_data_access_denied/],['selected_CAD_header',/cache_unavailable/],
        ['selected_CAD_coverage',/coverage_unavailable/],['catalog_replay_counts',/catalog_original_mismatch/],
        ['metrics_cache',/original_mismatch/],
        ['metrics_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_metrics_v2_orphan_progress']]){
        reads=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),reads+1,'ONE actual whole subject/next metric account packet per ending refusal');
        if(fault==='selected_CAD_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);await unchanged();
      }
      setFault('metrics_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await Promise.all([run(firstArgs),run(firstArgs)]);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  assert.equal((await head()).sequence,1);let receipt=await body((await head()).receipt_reference),nativeRows=await rows();
  assert.equal(receipt.format,'cohort_selected_metrics_receipt_v2');assert.equal(Object.keys(receipt).length,14);
  assert.equal(nativeRows.length,1);assert.deepEqual(await body(nativeRows[0].row_reference),firstRead.metric_row_candidate);
  assert.deepEqual(receipt.row_reference,nativeRows[0].row_reference);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs(),firstHead=await head();
  await assert.rejects(service[method](input,{captureJobClaim:firstClaim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);assert.deepEqual(await head(),firstHead);assert.deepEqual(await rows(),nativeRows);
  for(const sequence of [2,3]){
    let count=0,result,nextError,nextClaim;
    const stepArgs={...args,cohortService:{async [method](value,options){
      try{count++;nextClaim=options.captureJobClaim;assert.equal(nextClaim.attempts,5);assert.notEqual(nextClaim.claim_token,firstClaim.claim_token);
        const reads=originalReads();result=await service[method](value,options);assert.equal(originalReads(),reads+1);return result;
      }catch(error){nextError=error;throw error;}
    }}};
    const steps=await Promise.all([run(stepArgs),run(stepArgs)]);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(count,1);firstClaim=nextClaim;
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(result.covered_neutral_originals,true);assert.equal(result.covered_CAD_originals,true);
    assert.equal(result.original_reconciled_reported_metric_rows_complete,sequence===3);assert.equal(result.metric_row_retained,sequence===2);
    assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');assert.equal(result.statistics,'not_established');
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);assert.equal((await head()).sequence,sequence);
    receipt=await body((await head()).receipt_reference);assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.selected_ordinal,2);assert.equal(receipt.selected_stock_count,2);
    nativeRows=await rows();assert.equal(nativeRows.length,2);
    if(sequence===2){assert.equal(receipt.selected_entry.account_id,'CLOSURE-B');assert.equal(receipt.selected_entry.ordinal,2);
      assert.deepEqual(await body(nativeRows[1].row_reference),result.metric_row_candidate);assert.deepEqual(receipt.row_reference,nativeRows[1].row_reference);
      assert.deepEqual(nativeRows[1].entry_reference,before.parents.rows[1].entry_reference);}
    else{assert.equal(receipt.selected_entry,null);assert.equal(receipt.row_reference,null);assert.equal(result.metric_row_candidate,null);
      assert.deepEqual(receipt.after_counts,completedEligibility.after_counts);assert.deepEqual(receipt.after_counts,receipt.before_counts);}
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');assert.equal((await job()).checkpoint.evidence_refs.length,13);await immutable();
  }
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),head:await head(),rows:await rows()};
  for(const worker of [run,evidence,eligibility])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled statistics-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await head(),terminal.head);assert.deepEqual(await rows(),terminal.rows);await immutable();
  console.info('[native-batch-selected-metrics-v3]',{independent_actual_V3_evidence_worker_fresh_EMPTY:true,
    read_only_first_original_candidate_and_lost_read_ACK_no_progress_or_lease_extension:true,
    every_metric_row_built_from_fresh_whole_original_ENTIRE_neutral_CAD_cache_and_partition_replay:true,
    both_source_purposes_current_ending_role_workspace_header_coverage_count_cache_refusals:true,
    actual_deferred_orphan_metric_rows_head_checkpoint_yield_COMMIT_rollback_and_lost_first_ACK:true,
    concurrent_A_B_fresh_EMPTY_native_claims5_exact_rows_dates_counts_and_source_null_states:true,
    metric_DONE_all_claim_recovery_expiry_and_cancelled_next_owner_excluded:true,
    native_parents_command_dispatch_workspace_reports_history_and_pins_unchanged:true,
    ordinary_worker_recovery_below5:'not_exercised_requires_new_reserved_failure_graph',
    economic_equivalence:false,statistics:false,calendar_quarters:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
