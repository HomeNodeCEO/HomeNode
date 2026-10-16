import assert from 'node:assert/strict';
import { runNeighborhoodBatchSelectedWorkersV3DatabaseChecks } from './neighborhoodBatchSelectedWorkersV3DatabaseChecks.js';
import { runNeighborhoodBatchSelectedUnionV3DatabaseChecks } from './neighborhoodBatchSelectedUnionV3DatabaseChecks.js';
import { randomUUID } from 'node:crypto';
import { CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY as RIGHTS } from '../../src/security/customNeighborhoodWitness2SourcePolicy.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortBatchSelectionWaitV3WorkerRepository as waitClaims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectionWaitV3WorkerRepository.js';
import { createCustomCohortStockBatchV3WorkerRepository as stockClaims } from '../../src/services/neighborhoodAssessment/customCohortStockBatchV3WorkerRepository.js';
import { createCustomCohortPartitionBatchV3WorkerRepository as partitionClaims } from '../../src/services/neighborhoodAssessment/customCohortPartitionBatchV3WorkerRepository.js';
import { createCustomCohortCatalogBatchV3WorkerRepository as catalogClaims } from '../../src/services/neighborhoodAssessment/customCohortCatalogBatchV3WorkerRepository.js';

/** Explicit disposable-fixture choice ONLY, after an independently captured
 * actual batch waiting boundary. No production/appraiser choice is inferred. */
export async function runNeighborhoodBatchSelectionIntentV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,batchSelectedUnionFixture=false,batchSelectedWorkersFixture=false,batchRecordedEligibilityFixture=false,batchSelectedEvidenceFixture=false,batchSelectedMetricsFixture=false,batchSelectedStatisticsFixture=false,batchSelectedNumericFixture=false,batchSelectedSemanticFixture=false}){
  const operation=input.operationId,method='resumeCoveredOriginalFrozenCaptureJobBatchSelectionIntentReferencesV3',
    readMethod='readCoveredOriginalFrozenCaptureJobRetainedBatchSelectionIntentReferencesV3',
    intents=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,
    before={job:await job(),parent:await parent(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    intent={command_id:randomUUID(),catalog_reference:(await catalogHead()).receipt_reference,workspace_revision:1,
      included_recorded_group_ids:(await groups()).map(g=>g.group_id)},resume=(value=intent)=>service[method](input,{selectionIntent:value}),
    assertEvidence=async()=>{assert.deepEqual(await parent(),before.parent);assert.deepEqual(await catalogHead(),before.catalog);
      assert.deepEqual(await groups(),before.groups);assert.deepEqual(await blobs(),before.blobs);await assertParents();},
    assertWaiting=async()=>{assert.deepEqual(await intents(),[]);assert.deepEqual(await job(),before.job);await assertEvidence();};
  assert.equal(intent.included_recorded_group_ids.length,2);assert.ok(intent.included_recorded_group_ids.includes('discovery:unassigned'));
  assert.equal(before.job.status,'awaiting_selection');
  // Prove a revoked current source refuses an unknown well-shaped ID BEFORE
  // group lookup/original IO; restore this disposable organization's exact grant.
  const metadata=(await pool.query('SELECT metadata FROM app_auth.organizations WHERE id=$1',[scope.organization_id])).rows[0].metadata;
  await pool.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text,'revoked_at'],
    to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=$1`,[scope.organization_id,RIGHTS]);
  try{const reads=originalReads();await assert.rejects(resume({...intent,included_recorded_group_ids:['recorded-cad:'+'f'.repeat(64)]}),
    /market_data_access_denied|market_policy_changed/);assert.equal(originalReads(),reads);await assertWaiting();}
  finally{await pool.query('UPDATE app_auth.organizations SET metadata=$2::jsonb WHERE id=$1',[scope.organization_id,JSON.stringify(metadata)]);}
  for(const [mode,reason] of [['intent_workspace',/custom_cohort_group_workspace_study_changed/],
    ['intent_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['catalog_replay_counts',/catalog_original_mismatch/],['batch_intent_orphan_resume',/claim_lost/]]){
    setFault(mode);await assert.rejects(resume(),reason);assert.equal(readFault(),null);
    if(mode==='intent_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await assertWaiting();
  }
  await assert.rejects(resume({...intent,included_recorded_group_ids:['recorded-cad:'+'f'.repeat(64)]}),/selection_group_unavailable/);await assertWaiting();
  await assert.rejects(resume({...intent,workspace_revision:2}),/workspace_changed/);await assertWaiting();
  setFault('intent_ack');await assert.rejects(resume(),e=>e.outcome_unknown===true);assert.equal(readFault(),null);
  const command=(await intents())[0],resumedJob=await job();assert.equal((await intents()).length,1);
  assert.equal(resumedJob.status,'running');assert.equal(resumedJob.claim_token,command.resume_claim_token);
  assert.equal(resumedJob.attempts,5);assert.equal(resumedJob.last_error_code,'access_revoked');assert.equal(resumedJob.context_sha256,null);
  assert.deepEqual(resumedJob.checkpoint,before.job.checkpoint);assert.equal(resumedJob.run_after.getTime(),before.job.run_after.getTime());
  const resumed=await resume();assert.equal(resumed.status,'new_study_selection_intent_retained');
  assert.equal(resumed.receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(resumed.replayed,true);
  assert.equal(resumed.claim.claim_token,command.resume_claim_token);assert.equal(resumed.claim.attempts,5);
  assert.deepEqual(resumed.included_recorded_group_ids,intent.included_recorded_group_ids);
  assert.equal(resumed.complete_catalog_semantic_replay,'not_established');assert.equal(resumed.selected_union,'not_established');
  assert.equal(resumed.context_complete,false);assert.equal(resumed.pin_transfer,false);assert.equal(resumed.report_update,'none');
  assert.deepEqual(await job(),resumedJob,'idempotent command replay must not extend the actual native lease');await assertEvidence();
  const read=()=>service[readMethod](input,{captureJobClaim:resumed.claim}),assertResumed=async()=>{
    assert.deepEqual(await job(),resumedJob);assert.deepEqual(await intents(),[command]);await assertEvidence();};
  const readStart=originalReads(),retained=await read();assert.equal(originalReads(),readStart+1);
  assert.equal(retained.status,'retained_new_study_selection_intent_reopened');assert.equal(retained.read_only,true);assert.equal(retained.lease_extended,false);
  assert.equal(retained.receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.deepEqual(retained.claim,resumed.claim);
  assert.deepEqual(retained.included_recorded_group_ids,intent.included_recorded_group_ids);await assertResumed();
  for(const [mode,reason] of [['intent_workspace',/custom_cohort_group_workspace_study_changed/],
    ['intent_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['catalog_replay_counts',/catalog_original_mismatch/]]){
    setFault(mode);await assert.rejects(read(),reason);assert.equal(readFault(),null);
    if(mode==='intent_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await assertResumed();
  }
  await assert.rejects(resume({...intent,command_id:randomUUID()}),/command_conflict/);await assertResumed();
  await assert.rejects(service.resumeCoveredOriginalFrozenCaptureJobSelectionIntentReferencesV2(input,{selectionIntent:intent}),/invalid_receipt/);await assertResumed();
  const rollback=Error('rollback expired/cancelled immutable batch selection command');
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const snapshot=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    for(const repository of [waitClaims,stockClaims,partitionClaims,catalogClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,snapshot);throw rollback;
  }),e=>e===rollback);await assertResumed();
  if(batchSelectedUnionFixture){
    await (batchSelectedWorkersFixture?runNeighborhoodBatchSelectedWorkersV3DatabaseChecks:runNeighborhoodBatchSelectedUnionV3DatabaseChecks)({pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,claim:resumed.claim,command,batchRecordedEligibilityFixture,batchSelectedEvidenceFixture,batchSelectedMetricsFixture,batchSelectedStatisticsFixture,batchSelectedNumericFixture,batchSelectedSemanticFixture});return;
  }
  console.info('[native-batch-selection-intent-v3]',{independent_actual_initial_source_cache_stock_partition_catalog_and_waiting:true,
    explicit_fixture_new_study_command_only_no_worker_choice_or_prior_carryover:true,
    revoked_source_unknown_ID_refused_before_known_group_lookup_and_original_IO:true,
    actual_ending_workspace_source_actor_counts_and_orphan_resume_rollback_command_AND_lease:true,
    unknown_ID_stale_workspace_conflicting_command_and_V2_reinterpretation_refused:true,
    lost_actual_command_COMMIT_ACK_then_same_immutable_native_token_replay_without_lease_extension:true,
    retained_command_read_only_current_and_ending_original_source_workspace_refenced:true,
    expired_cancelled_resume_excluded_from_all_prior_worker_claim_recovery_expiry_lanes:true,
    failure5_errors_schedule_checkpoint_catalog_parents_blobs_reports_workspace_and_pins_preserved:true,
    complete_catalog_semantics:false,selected_union:false,statistics:false,production_activation:false,
    licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
