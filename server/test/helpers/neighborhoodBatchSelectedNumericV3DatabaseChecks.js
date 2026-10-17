import assert from 'node:assert/strict';
import { runNeighborhoodBatchSelectedSemanticV3DatabaseChecks } from './neighborhoodBatchSelectedSemanticV3DatabaseChecks.js';
import { runNeighborhoodNativeClaimPair as pair } from './neighborhoodNativeClaimPair.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedNumericV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedNumericV3WorkerRepository.js';
import { runCustomCohortBatchSelectedNumericV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedNumericV3JobWorker.js';
import { runCustomCohortBatchSelectedStatisticsV3JobOnce as statistics } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedStatisticsV3JobWorker.js';

/** Thirtieth independently captured graph. Reference-only numeric population
 * follows actual contribution DONE; numeric index rows grant no authority. */
export async function runNeighborhoodBatchSelectedNumericV3DatabaseChecks({sourceRecoveryFixture=false,pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedSemanticFixture=false,batchSelectedTransactionIndexFixture=false}){
  const sourceFailureAttempt=sourceRecoveryFixture?4:5,sourceFailureCode=sourceRecoveryFixture?'capture_failed':'access_revoked';
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedNumericReferencesV3',
    readMethod='readCoveredOriginalFrozenCaptureJobBatchFirstSelectedNumericReferencesV3',
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    rows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
    parents=async()=>({statistics:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=$1',[operation])).rows,
      contributions:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      index:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_numeric_index_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      metrics:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=$1',[operation])).rows,
      metricRows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_metrics_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      union:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      eligibility:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1',[operation])).rows,
      evidence:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=$1',[operation])).rows,
      dispatch:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows}),
    before={parents:await parents(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    immutable=async()=>{assert.deepEqual(await parents(),before.parents);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    body=async reference=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3',
      [scope.organization_id,reference.content_sha256,reference.canonical_utf8_bytes])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900};
  assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);assert.equal(before.parents.statistics[0].sequence,3);
  assert.equal((await body(before.parents.statistics[0].receipt_reference)).after.done,true);
  assert.deepEqual(before.parents.index.map(r=>r.ordinal),[1,2]);
  let calls=0,ownerError,owned,ownedParent,firstClaim,firstRead;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.equal(await head(),undefined);assert.deepEqual(await rows(),[]);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,sourceFailureAttempt);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedNumericReferencesV2(value,options),/invalid_receipt/);await unchanged();
      const reads=originalReads();firstRead=await service[readMethod](value,options);assert.equal(originalReads(),reads+1);
      assert.equal(firstRead.status,'current_authorized_first_selected_numeric_originals_reconciled');
      assert.equal(firstRead.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');
      assert.equal(firstRead.covered_neutral_originals,true);assert.equal(firstRead.covered_CAD_originals,true);
      assert.equal(firstRead.read_only,true);assert.equal(firstRead.lease_extended,false);
      assert.equal(firstRead.retained_contribution_reconciled,true);assert.equal(firstRead.retained_numeric_index_reconciled,true);
      assert.equal(firstRead.selected_entry.ordinal,1);assert.equal(firstRead.selected_entry.account_id,'CLOSURE-A');
      assert.deepEqual(firstRead.selected_entry.row_reference,before.parents.metricRows[0].row_reference);
      assert.deepEqual(firstRead.selected_entry.contribution_row_reference,before.parents.contributions[0].row_reference);
      assert.equal(firstRead.context_complete,false);assert.equal(firstRead.pin_transfer,false);await unchanged();
      for(const [fault,reason] of [['numeric_cache',/original_mismatch/],
        ['numeric_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_numeric_v2_orphan_progress']]){
        const count=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),count+1);await unchanged();
      }
      setFault('numeric_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await pair(run,firstArgs,method);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  assert.equal((await head()).sequence,1);let receipt=await body((await head()).receipt_reference),nativeRows=await rows();
  assert.equal(receipt.format,'cohort_selected_numeric_receipt_v2');assert.equal(Object.keys(receipt).length,14);
  assert.equal(nativeRows.length,1);assert.deepEqual(nativeRows[0].metric_row_reference,firstRead.selected_entry.row_reference);
  assert.deepEqual(nativeRows[0].contribution_row_reference,firstRead.selected_entry.contribution_row_reference);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs(),firstHead=await head();
  await assert.rejects(service[method](input,{captureJobClaim:firstClaim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);assert.deepEqual(await head(),firstHead);assert.deepEqual(await rows(),nativeRows);
  for(const sequence of [2,3]){
    let count=0,result,nextError,nextClaim;
    const stepArgs={...args,cohortService:{async [method](value,options){
      try{count++;nextClaim=options.captureJobClaim;assert.equal(nextClaim.attempts,sourceFailureAttempt);assert.notEqual(nextClaim.claim_token,firstClaim.claim_token);
        const reads=originalReads();result=await service[method](value,options);assert.equal(originalReads(),reads+1);return result;
      }catch(error){nextError=error;throw error;}
    }}};
    const steps=await pair(run,stepArgs,method);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(count,1);firstClaim=nextClaim;
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(result.covered_neutral_originals,true);assert.equal(result.covered_CAD_originals,true);
    assert.equal(result.complete_original_reconciled_index_pass,sequence===3);assert.equal(result.complete_indexed_metric_population,sequence===3);
    assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');assert.equal(result.statistics,'not_established');
    assert.equal(result.frequency_ledger,false);assert.equal(result.exact_distributions,false);assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);
    assert.equal((await head()).sequence,sequence);receipt=await body((await head()).receipt_reference);
    assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.selected_ordinal,2);assert.equal(receipt.selected_stock_count,2);
    nativeRows=await rows();assert.equal(nativeRows.length,2);
    for(let i=0;i<2;i++){
      const metric=before.parents.metricRows[i],contribution=before.parents.contributions[i];
      assert.equal(nativeRows[i].ordinal,i+1);assert.equal(nativeRows[i].account_id,metric.account_id);
      assert.deepEqual(nativeRows[i].entry_reference,metric.entry_reference);
      assert.deepEqual(nativeRows[i].metric_row_reference,metric.row_reference);assert.deepEqual(nativeRows[i].contribution_row_reference,contribution.row_reference);
    }
    if(sequence===3){assert.equal(receipt.selected_entry,null);assert.equal(receipt.contribution_row_reference,null);}
    assert.equal((await job()).attempts,sourceFailureAttempt);assert.equal((await job()).last_error_code,sourceFailureCode);assert.equal((await job()).checkpoint.evidence_refs.length,15);await immutable();
  }
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),head:await head(),rows:await rows()};
  for(const worker of [run,statistics])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled semantic-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await head(),terminal.head);assert.deepEqual(await rows(),terminal.rows);await immutable();
  if(batchSelectedSemanticFixture){
    await runNeighborhoodBatchSelectedSemanticV3DatabaseChecks({sourceRecoveryFixture,pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedTransactionIndexFixture});return;
  }
  console.info('[native-batch-selected-numeric-v3]',{independent_actual_V3_contribution_worker_fresh_EMPTY:true,
    read_only_first_whole_original_metric_contribution_and_each_numeric_index_field_reconciled:true,
    ENTIRE_cache_refusal_and_actual_deferred_orphan_COMMIT_rollback:true,
    concurrent_actual_claim_transactions_settled_before_positive_original_owner:true,
    lost_actual_first_COMMIT_ACK_concurrent_A_B_fresh_EMPTY_native_claims5:true,
    exact_reference_only_population_and_unchanged_index_parents_command_history_workspace_reports_pins:true,
    DONE_all_claim_recovery_expiry_cancelled_next_owner_excluded:true,
    ordinary_worker_recovery_below5:'not_exercised_requires_new_reserved_failure_graph',
    new_stage_all_ending_authority_faults:'not_separately_injected_prior_independent_stages_cover_shared_fences',
    economic_equivalence:false,medians:false,COD:false,calendar_quarters:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
