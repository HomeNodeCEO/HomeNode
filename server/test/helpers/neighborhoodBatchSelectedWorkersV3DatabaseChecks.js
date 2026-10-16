import assert from 'node:assert/strict';
import { runNeighborhoodBatchRecordedEligibilityV3DatabaseChecks } from './neighborhoodBatchRecordedEligibilityV3DatabaseChecks.js';
import { runNeighborhoodNativeClaimPair as pair } from './neighborhoodNativeClaimPair.js';
import { randomUUID } from 'node:crypto';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedInitialV3WorkerRepository as initialClaims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedInitialV3WorkerRepository.js';
import { createCustomCohortBatchSelectedProgressV3WorkerRepository as progressClaims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedProgressV3WorkerRepository.js';
import { runCustomCohortBatchSelectedInitialV3JobOnce as initial } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedInitialV3JobWorker.js';
import { runCustomCohortBatchSelectedProgressV3JobOnce as progress } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedProgressV3JobWorker.js';
import { runCustomCohortCoveredSelectedInitialV2JobOnce as legacyInitial } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2JobWorker.js';
import { runCustomCohortCoveredSelectedProgressV2JobOnce as legacyProgress } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedProgressV2JobWorker.js';

/** Twenty-fifth independent real capture. Workers supply no group IDs, source
 * adapter, progress, counts or membership. The real original owner does all IO. */
export async function runNeighborhoodBatchSelectedWorkersV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,claim,command,batchRecordedEligibilityFixture=false,batchSelectedEvidenceFixture=false,batchSelectedMetricsFixture=false,batchSelectedStatisticsFixture=false,batchSelectedNumericFixture=false,batchSelectedSemanticFixture=false}){
  const operation=input.operationId,method='continueCoveredOriginalFrozenCaptureJobBatchSelectedStockUnionReferencesV3',
    before={job:await job(),parent:await parent(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    dispatches=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows,
    union=async()=>({head:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      groups:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=$1 ORDER BY group_id COLLATE "C"',[operation])).rows,
      rows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows}),
    immutable=async()=>{assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    args={pool,cohortService:service,leaseSeconds:900};
  assert.deepEqual(await dispatches(),[]);assert.deepEqual(await union(),{head:[],groups:[],rows:[]});
  const targetRollback=Error('rollback changed pending target');
  await assert.rejects(tx(pool,async client=>{
    await client.query(`UPDATE app.custom_appraisal_workfile_sections SET section_value=jsonb_set(section_value,
      '{pending_capture,operation_id}',to_jsonb($2::text)) WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`,[scope.assignment_file_id,randomUUID()]);
    for(const repository of [initialClaims,progressClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows,[]);throw targetRollback;
  }),e=>e===targetRollback);assert.deepEqual(await job(),before.job);await immutable();
  // The existing native initial-dispatch guard is generic to the actual command
  // and must still refuse an adoption whose real saved lease expires at COMMIT.
  await assert.rejects(tx(pool,async client=>{
    const [adopted]=await initialClaims(client).claimDue({leaseSeconds:900});assert.deepEqual(adopted.claim,claim);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
  }),e=>e.code==='55000');assert.deepEqual(await dispatches(),[]);assert.deepEqual(await job(),before.job);await immutable();
  let initialCalls=0,ownerError,ownedDispatch;
  const unchanged=async()=>{
    assert.deepEqual(await job(),before.job);assert.deepEqual(await dispatches(),[]);assert.deepEqual(await parent(),before.parent);
    assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await union(),{head:[],groups:[],rows:[]});await immutable();
  };
  // Exercise the actual heartbeat UPDATE on a separate native transaction.
  // NOWAIT must refuse before original IO while that row lock is held. Do not
  // retry the refusal, weaken the owner fence or alter the normal worker timer.
  const heartbeatRollback=Error('rollback held native heartbeat'),beforeHeartbeatReads=originalReads();
  await assert.rejects(tx(pool,async client=>{
    assert.deepEqual(await jobs(client).heartbeat(claim,{leaseSeconds:900}),{cancellation_requested:false});
    await assert.rejects(service[method](input,{captureJobClaim:claim}),error=>error.code==='55P03'
      &&error.message==='could not obtain lock on row in relation "neighborhood_custom_cohort_capture_jobs"');
    assert.equal(originalReads(),beforeHeartbeatReads);assert.equal(readFault(),null);
    throw heartbeatRollback;
  }),error=>error===heartbeatRollback);await unchanged();
  console.info('[native-batch-selected-worker-step-v3]',{step:'actual-held-heartbeat-refusal-and-rollback-passed'});
  // These are separate, deliberately rolled-back owner operations under the
  // genuine resumed claim. Run them before the worker starts: placing seven
  // owner transactions inside one callback artificially raced its 15s timer.
  for(const [fault,reason] of [['union_workspace',/custom_cohort_group_workspace_study_changed/],
    ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['catalog_replay_counts',/catalog_original_mismatch/],['union_cache',/original_mismatch/],
    ['union_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_union_v2_orphan_progress']]){
    setFault(fault);const reads=originalReads();await assert.rejects(service[method](input,{captureJobClaim:claim}),reason);assert.equal(readFault(),null);
    assert.equal(originalReads(),reads+1);
    if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await unchanged();
  }
  console.info('[native-batch-selected-worker-step-v3]',{step:'all-ending-original-and-COMMIT-refusals-passed'});
  const claimRollback=Error('rollback held native initial claim'),beforeClaimReads=originalReads();
  await assert.rejects(tx(pool,async client=>{
    const [adopted]=await initialClaims(client).claimDue({leaseSeconds:900});assert.deepEqual(adopted.claim,claim);
    await assert.rejects(service[method](input,{captureJobClaim:claim}),error=>error.code==='55P03'
      &&error.message==='could not obtain lock on row in relation "neighborhood_custom_cohort_capture_jobs"');
    assert.equal(originalReads(),beforeClaimReads);throw claimRollback;
  }),error=>error===claimRollback);await unchanged();
  console.info('[native-batch-selected-worker-step-v3]',{step:'actual-held-native-claim-refusal-and-rollback-passed'});
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      initialCalls++;assert.deepEqual(options.captureJobClaim,claim);ownedDispatch=await dispatches();
      assert.equal(ownedDispatch.length,1);assert.equal(ownedDispatch[0].claim_token,claim.claim_token);
      assert.equal(ownedDispatch[0].attempts,5);assert.equal(ownedDispatch[0].command_id,command.command_id);
      const reads=originalReads();setFault('union_ack');
      try{return await service[method](value,options);}finally{assert.equal(originalReads(),reads+1);}
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await pair(initial,firstArgs,method);
  if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(initialCalls,1);assert.equal(readFault(),null);
  console.info('[native-batch-selected-worker-step-v3]',{step:'actual-concurrent-initial-claims-and-first-original-lost-ACK-passed'});
  let state=await union();assert.equal(state.head[0].sequence,1);assert.deepEqual(state.rows.map(r=>r.account_id),['CLOSURE-A']);
  assert.deepEqual(await dispatches(),ownedDispatch);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs();
  for(const worker of [initial,legacyInitial,legacyProgress])assert.deepEqual(await worker(args),{status:'idle'});
  await assert.rejects(service[method](input,{captureJobClaim:claim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);
  for(const sequence of [2,3]){
    let calls=0,result,nextError,nextClaim;
    const stepArgs={...args,cohortService:{async [method](value,options){
      try{calls++;nextClaim=options.captureJobClaim;assert.equal(nextClaim.attempts,5);assert.notEqual(nextClaim.claim_token,claim.claim_token);
        const reads=originalReads();result=await service[method](value,options);assert.equal(originalReads(),reads+1);return result;
      }catch(error){nextError=error;throw error;}
    }}};
    const steps=await pair(progress,stepArgs,method);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(calls,1);claim=nextClaim;
    assert.equal(result.complete_distinct_selected_stock_union,sequence===3);assert.equal(result.selected_stock_accounts,2);
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');state=await union();
    assert.equal(state.head[0].sequence,sequence);
    const receipt=JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,state.head[0].receipt_reference.content_sha256])).rows[0].canonical_utf8);
    assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.account_count,2);assert.equal(receipt.after_selected_count,2);
    if(sequence===3){assert.equal(receipt.entry_reference,null);assert.deepEqual(receipt.after_counts,receipt.before_counts);}
    assert.deepEqual(state.rows.map(r=>[r.account_id,r.ordinal,r.partition_ordinal]),[['CLOSURE-A',1,1],['CLOSURE-B',2,2]]);
    assert.deepEqual(await dispatches(),ownedDispatch);assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');await immutable();
  }
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),union:await union()};
  for(const worker of [initial,progress,legacyInitial,legacyProgress])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled next-owner terminal token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    for(const repository of [initialClaims,progressClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);
  assert.deepEqual(await union(),terminal.union);assert.deepEqual(await dispatches(),ownedDispatch);await immutable();
  if(batchRecordedEligibilityFixture){
    await runNeighborhoodBatchRecordedEligibilityV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedEvidenceFixture,batchSelectedMetricsFixture,batchSelectedStatisticsFixture,batchSelectedNumericFixture,batchSelectedSemanticFixture});return;
  }
  console.info('[native-batch-selected-workers-v3]',{independent_actual_initial_source_cache_stock_partition_catalog_wait_and_explicit_command:true,
    changed_pending_target_not_claimed_and_real_orphan_initial_adoption_COMMIT_refused:true,
    actual_heartbeat_row_lock_refused_before_original_IO_and_complete_rollback:true,
    separate_ending_refusals_before_worker_timer_and_normal_15s_heartbeat_retained:true,
    concurrent_native_claim_transactions_settled_before_positive_original_owner:true,
    actual_held_initial_claim_also_refuses_before_original_IO_and_rolls_back:true,
    concurrent_initial_adoption_once_preserves_actual_human_resume_token_and_failure5:true,
    every_original_ENTIRE_cache_partition_and_current_ending_workspace_source_actor_count_fence:true,
    actual_orphan_yield_rollback_and_lost_first_COMMIT_ACK:true,concurrent_B_and_separate_fresh_EMPTY_fresh_native_tokens:true,
    DONE_all_claim_recovery_expiry_and_expired_cancelled_next_owner_excluded:true,
    immutable_command_catalog_native_parents_dispatch_history_workspace_reports_and_pins_retained:true,
    ordinary_recovery_below_five_exercised:false,automatic_schedule:false,complete_metric_population:false,
    production_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
