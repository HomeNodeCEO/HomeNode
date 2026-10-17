import { runNeighborhoodThirdNextSourceV3DatabaseChecks } from './neighborhoodThirdNextSourceV3DatabaseChecks.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Each independent A/B graph committed actual owned1/failure1/second2/
// failure2/third3. Every original and native predecessor remains independent.
export async function runNeighborhoodThirdFirstSourceOriginalV3DatabaseChecks({sourceRecoveryFixture=false,pool,input,scope,actor,service,claim,
  originalReads,laterFirstSource,setFault,readFault,unchanged,originalBirthTransaction,retryTransaction,thirdClaimTransaction}){
  const run=()=>service.readCoveredOriginalFrozenCaptureJobThirdFirstSourceReferencesV3(input,{captureJobClaim:claim});
  const originalRoles=(await pool.query(`SELECT to_jsonb(r) AS body FROM app_auth.membership_roles r
    WHERE organization_id=$1 AND user_id=$2 ORDER BY role_code`,[scope.organization_id,actor])).rows.map(r=>r.body);
  assert.ok(originalRoles.length>0);
  const restoreOriginalRoles=async()=>{
    assert.equal((await pool.query('SELECT 1 FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',
      [scope.organization_id,actor])).rowCount,0);
    const restored=await pool.query(`INSERT INTO app_auth.membership_roles
      SELECT * FROM jsonb_populate_recordset(NULL::app_auth.membership_roles,$1::jsonb)`,[JSON.stringify(originalRoles)]);
    assert.equal(restored.rowCount,originalRoles.length);
  };
  let count=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),count);}
  finally{await restoreOriginalRoles();}
  await unchanged();
  for(const [fault,reason]of [['next_source_assignment_before_io',/assignment_access_denied/],
    ['next_source_draft_before_io',/private_source_read_only/]]){
    count=originalReads();setFault(fault);await assert.rejects(run(),reason);
    assert.equal(readFault(),null);assert.equal(originalReads(),count);await unchanged();
  }
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],
    ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/],
    ['owned_source_subject',/subject_changed/],
    ['next_source_assignment_ending',/assignment_access_denied/],['next_source_draft_ending',/private_source_read_only/]]){
    count=originalReads();setFault(fault);
    try{await assert.rejects(run(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),count+1);}
    finally{if(fault==='union_role')await restoreOriginalRoles();}
    await unchanged();
  }
  for(const invalid of [{...claim,claim_token:randomUUID()},{...claim,attempts:claim.attempts-1}]){
    count=originalReads();await assert.rejects(service.readCoveredOriginalFrozenCaptureJobThirdFirstSourceReferencesV3(input,
      {captureJobClaim:invalid}),/claim_lost/);assert.equal(originalReads(),count);await unchanged();
  }
  count=originalReads();setFault('completed_source_ack');await assert.rejects(run(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),count+1);await unchanged();
  count=originalReads();const result=await run();assert.equal(originalReads(),count+1);
  assert.equal(result.status,'current_authorized_third_first_source_originals_reconciled');
  assert.equal(result.retained_original_birth_transaction,originalBirthTransaction);
  assert.equal(result.retained_source_retry_transaction,retryTransaction);
  assert.equal(result.retained_source_third_claim_transaction,thirdClaimTransaction);
  assert.equal(result.third_source_failure_attempt,3);
  assert.equal(result.retained_birth_candidate_compared_to_whole_originals,true);assert.equal(result.original_birth_rebound,false);
  assert.equal(result.read_only,true);assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);
  assert.equal(result.source_cursor_advanced,false);assert.equal(result.economic_progress_retained,false);
  assert.equal(result.report_update,'none');assert.equal(result.lease_extended,false);
  assert.equal(result.selected_source_resolution_candidate.first_seen_selected_entry.ordinal,laterFirstSource?2:1);
  await unchanged();
  console.info('[native-third18-attempt3-actual-original-owner-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_distinct_third18_claim3_original17_birth_owned1_failure1_second2_failure2_never_rebound:true,
    actual_failure_attempt:claim.attempts,entire_original17_birth_never_rebound:true,
    every_real_original_required_subject_entire_stock_CAD_all_date_transaction_and_ENTIRE_neutral_caches_reopened:true,
    every_native_member_and_complete_first_seen_key_set_reconciled_independently:true,
    all_current_ending_source_purpose_actor_assignment_private_draft_subject_workspace_fences:true,
    stored_candidate_bytes_equal_private_whole_original_reproduction_after_all_ending_fences:true,
    real_current_actor_assignment_private_draft_and_ten_ending_faults_rollback_lost_actual_readonly_COMMIT_ACK:true,
    entire_job_claim_birth_parents_blobs_history_report_choices_workspace_and_pins_unchanged:true,
    existing_aggregate_256queries_32MB_60s_and_stricter_single_use_child_250_limits_unchanged:true,
    recovery:false,NEXT_or_EMPTY:false,publication:false,activation:false,licensed_large_area:false,production_speed:false});
  await runNeighborhoodThirdNextSourceV3DatabaseChecks({pool,input,scope,actor,service,claim,
    originalReads,laterFirstSource,setFault,readFault,unchanged});
}
