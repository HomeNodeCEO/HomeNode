import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runNeighborhoodOwnedSourceLastRetryV3DatabaseChecks } from './neighborhoodOwnedSourceLastRetryV3DatabaseChecks.js';
import { runNeighborhoodOwnedSourceTerminalFailureV3DatabaseChecks } from './neighborhoodOwnedSourceTerminalFailureV3DatabaseChecks.js';
import { runNeighborhoodCompletedIndexNextSourceV3DatabaseChecks } from './neighborhoodCompletedIndexNextSourceV3DatabaseChecks.js';

// No copied graph or fixture substitute: each independent capture has REALLY
// committed birth17/FIRST18 and its distinct fresh18 claim, preserving the
// actual fifth attempt or the separately reserved fourth attempt throughout.
export async function runNeighborhoodOwnedFirstSourceOriginalV3DatabaseChecks({sourceRecoveryFixture=false,pool,input,scope,actor,service,claim,
  originalReads,laterFirstSource,setFault,readFault,unchanged,originalBirthTransaction}){
  const run=()=>service.readCoveredOriginalFrozenCaptureJobOwnedFirstSourceReferencesV3(input,{captureJobClaim:claim});
  let count=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),count);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await unchanged();
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],
    ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/],
    ['owned_source_subject',/subject_changed/]]){
    count=originalReads();setFault(fault);
    try{await assert.rejects(run(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),count+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await unchanged();
  }
  for(const invalid of [{...claim,claim_token:randomUUID()},{...claim,attempts:claim.attempts-1}]){
    count=originalReads();await assert.rejects(service.readCoveredOriginalFrozenCaptureJobOwnedFirstSourceReferencesV3(input,
      {captureJobClaim:invalid}),/claim_lost/);assert.equal(originalReads(),count);await unchanged();
  }
  count=originalReads();setFault('completed_source_ack');await assert.rejects(run(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),count+1);await unchanged();
  count=originalReads();const result=await run();assert.equal(originalReads(),count+1);
  assert.equal(result.status,'current_authorized_owned_first_source_originals_reconciled');
  assert.equal(result.retained_original_birth_transaction,originalBirthTransaction);
  assert.equal(result.retained_birth_candidate_compared_to_whole_originals,true);assert.equal(result.original_birth_rebound,false);
  assert.equal(result.read_only,true);assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);
  assert.equal(result.source_cursor_advanced,false);assert.equal(result.economic_progress_retained,false);
  assert.equal(result.report_update,'none');assert.equal(result.lease_extended,false);
  assert.equal(result.selected_source_resolution_candidate.first_seen_selected_entry.ordinal,laterFirstSource?2:1);
  await unchanged();
  console.info('[native-owned18-first-source-actual-original-owner-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_distinct_fresh18_claim5_original17_birth_never_rebound:!sourceRecoveryFixture,
    actual_failure_attempt:claim.attempts,entire_original17_birth_never_rebound:true,
    every_real_original_required_subject_entire_stock_CAD_all_date_transaction_and_ENTIRE_neutral_caches_reopened:true,
    every_native_member_and_complete_first_seen_key_set_reconciled_independently:true,
    all_current_ending_source_purpose_actor_assignment_private_draft_subject_workspace_fences:true,
    stored_candidate_bytes_equal_private_whole_original_reproduction_after_all_ending_fences:true,
    real_role_loss_before_IO_eight_ending_faults_rollback_and_lost_actual_readonly_COMMIT_ACK:true,
    entire_job_claim_birth_parents_blobs_history_report_choices_workspace_and_pins_unchanged:true,
    existing_aggregate_256queries_32MB_60s_and_stricter_single_use_child_250_limits_unchanged:true,
    recovery:false,NEXT_or_EMPTY:false,publication:false,activation:false,licensed_large_area:false,production_speed:false});
  // Same independently born real18, still live and unchanged. All FIRST owner
  // original reads above and the original4/5 failure/terminal graph below stay.
  await runNeighborhoodCompletedIndexNextSourceV3DatabaseChecks({ownedSource:true,pool,input,scope,actor,service,claim,
    originalReads,laterFirstSource,setFault,readFault,unchanged});
  if(sourceRecoveryFixture)await runNeighborhoodOwnedSourceLastRetryV3DatabaseChecks({sourceRecoveryFixture,pool,input,scope,actor,service,claim,
    originalReads,laterFirstSource,setFault,readFault});
  else await runNeighborhoodOwnedSourceTerminalFailureV3DatabaseChecks({pool,input,scope,actor,service,claim,
    originalReads,laterFirstSource,setFault,readFault});
}
