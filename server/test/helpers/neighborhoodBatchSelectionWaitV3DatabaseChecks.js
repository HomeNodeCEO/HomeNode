import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { runCustomCohortBatchSelectionWaitV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3JobWorker.js';
import { runCustomCohortCoveredSelectionWaitV2JobOnce as legacyRun } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectionWaitV2JobWorker.js';
import { createCustomCohortBatchSelectionWaitV3WorkerRepository as waitClaims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3WorkerRepository.js';
import { createCustomCohortStockBatchV3WorkerRepository as stockClaims } from '../../src/services/neighborhoodAssessment/customCohortStockBatchV3WorkerRepository.js';
import { createCustomCohortPartitionBatchV3WorkerRepository as partitionClaims } from '../../src/services/neighborhoodAssessment/customCohortPartitionBatchV3WorkerRepository.js';
import { createCustomCohortCatalogBatchV3WorkerRepository as catalogClaims } from '../../src/services/neighborhoodAssessment/customCohortCatalogBatchV3WorkerRepository.js';
import { runNeighborhoodBatchSelectionIntentV3DatabaseChecks } from './neighborhoodBatchSelectionIntentV3DatabaseChecks.js';

/** Twenty-second independent real capture. Source/current/ending/COMMIT work
 * stays real; a missing appraiser command is never supplied by this worker. */
export async function runNeighborhoodBatchSelectionWaitV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,batchSelectionIntentFixture=false,batchSelectedUnionFixture=false,batchSelectedWorkersFixture=false,batchRecordedEligibilityFixture=false,batchSelectedEvidenceFixture=false,batchSelectedMetricsFixture=false,batchSelectedStatisticsFixture=false,batchSelectedNumericFixture=false,batchSelectedSemanticFixture=false,batchSelectedTransactionIndexFixture=false}){
  const operation=input.operationId,method='awaitCoveredOriginalFrozenCaptureJobBatchSelectionReferencesV3',
    before={catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    intents=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows;
  let ownerCalls=0,ownerError,owned,ownedParent,ownedClaim;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.status,'running');assert.equal(current.claim_token,owned.claim_token);
    // The real worker retains its normal heartbeat. Only that existing lease
    // extension and timestamp may move while these independent refusals run.
    assert.ok(new Date(current.lease_expires_at)>=new Date(owned.lease_expires_at));
    assert.ok(new Date(current.lease_expires_at).getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await catalogHead(),before.catalog);
    assert.deepEqual(await groups(),before.groups);assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await intents(),[]);await assertParents();
  };
  const workerArgs={...args,cohortService:{async [method](value,options){
    try{
      ownerCalls++;ownedClaim=options.captureJobClaim;assert.equal(ownedClaim.attempts,5);
      owned=await job();ownedParent=await parent();
      assert.deepEqual(await intents(),[]);
      const missingReads=originalReads();setFault('wait_missing');
      await assert.rejects(service[method](value,options),/custom_cohort_group_workspace_unavailable/);assert.equal(readFault(),null);
      assert.equal(originalReads(),missingReads);await unchanged();
      for(const [mode,reason] of [['batch_workspace',/custom_cohort_group_workspace_study_changed/],
        ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],['batch_role',/custom_cohort_job_actor_access_revoked/],
        ['catalog_replay_counts',/catalog_original_mismatch/],['batch_wait_orphan_release',/batch_selection_wait_v3_retention_conflict/],
        ['batch_wait_expiry',/claim_lost|claim_conflict/]]){
        const reads=originalReads();setFault(mode);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),reads+1,'server-owned DONE cursor still executes ONE fresh native original EMPTY query');
        if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
        await unchanged();
      }
      setFault('wait_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const results=await Promise.all([run(workerArgs),run(workerArgs)]);
  if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(results.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(ownerCalls,1);assert.equal(readFault(),null);
  const waiting=await job();assert.equal(waiting.status,'awaiting_selection');assert.equal(waiting.claim_token,null);assert.equal(waiting.lease_expires_at,null);
  assert.equal(waiting.attempts,5);assert.equal(waiting.last_error_code,'access_revoked');assert.equal(waiting.context_sha256,null);
  assert.deepEqual(waiting.checkpoint,owned.checkpoint);assert.equal(waiting.run_after.getTime(),owned.run_after.getTime());
  assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
  assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await intents(),[]);await assertParents();
  const reads=originalReads();await assert.rejects(service[method](input,{captureJobClaim:ownedClaim}),/claim_lost/);assert.equal(originalReads(),reads);
  for(const repository of [waitClaims,stockClaims,partitionClaims,catalogClaims])assert.deepEqual(await tx(pool,c=>repository(c).claimDue({leaseSeconds:900})),[]);
  for(const worker of [run,legacyRun])assert.deepEqual(await worker(args),{status:'idle'});assert.deepEqual(await job(),waiting);
  for(const patch of ["status='retry'","status='succeeded'","attempts=1","claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '120 seconds'","checkpoint=jsonb_set(checkpoint,'{phase}','\"frozen_source_refs_v2\"')"]){
    await assert.rejects(tx(pool,c=>c.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs SET ${patch} WHERE operation_id=$1`,[operation])),
      e=>e.code==='55000');assert.deepEqual(await job(),waiting);
  }
  if(batchSelectionIntentFixture){
    await runNeighborhoodBatchSelectionIntentV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,batchSelectedUnionFixture,batchSelectedWorkersFixture,batchRecordedEligibilityFixture,batchSelectedEvidenceFixture,batchSelectedMetricsFixture,batchSelectedStatisticsFixture,batchSelectedNumericFixture,batchSelectedSemanticFixture,batchSelectedTransactionIndexFixture});
    return;
  }
  await tx(pool,c=>jobs(c).cancel(scope,operation));const cancelled=await job();assert.equal(cancelled.status,'cancelled');
  await assert.rejects(tx(pool,c=>c.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET status='retry' WHERE operation_id=$1",[operation])),e=>e.code==='55000');
  assert.deepEqual(await run(args),{status:'idle'});assert.deepEqual(await job(),cancelled);
  assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
  assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await intents(),[]);await assertParents();
  console.info('[native-batch-selection-wait-v3]',{independent_current_authorized_initial_source_cache_stock_partition_catalog_DONE:true,
    server_chosen_cursor_fresh_original_cache_partition_EMPTY_and_all_ending_fences:true,
    missing_pending_workspace_refuses_before_originals:true,ending_source_actor_workspace_counts_and_expired_lease_refused:true,
    actual_release_savepoint_orphan_refused_by_same_transaction_native_readback:true,
    actual_wait_COMMIT_ACK_lost_then_fresh_native_awaiting_state:true,concurrent_workers_one_owner:true,
    failure5_errors_schedule_checkpoint_native_parents_groups_blobs_reports_workspace_and_pins_preserved:true,
    stale_claim_and_all_waiting_reclaim_recovery_expiry_lanes_excluded:true,waiting_and_cancelled_immutable:true,
    genuine_selection_intent:false,production_activation:false,complete_catalog_semantics:false,selected_union:false,
    licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
