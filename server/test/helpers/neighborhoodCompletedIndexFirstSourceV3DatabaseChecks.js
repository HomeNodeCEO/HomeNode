import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';

// Continue ONLY the already complete independent graph32. Claiming is a real
// native transition committed before opening the real read-only source owner;
// no uncommitted lease, fixture callback or substituted original packet.
export async function runNeighborhoodCompletedIndexFirstSourceV3DatabaseChecks({pool,input,scope,actor,service,
  job,parent,blobs,snapshot,immutable,setFault,readFault,originalReads}){
  const method='readCoveredOriginalFrozenCaptureJobCompletedIndexFirstSourceReferencesV3',before=await job();
  const [next]=await tx(pool,client=>continuations(client).claimDue({limit:1,leaseSeconds:900}));
  assert.equal(next.claim.operation_id,input.operationId);assert.equal(next.claim.attempts,before.attempts);
  const options={captureJobClaim:next.claim},owned={job:await job(),parent:await parent(),blobs:await blobs(),index:await snapshot()},
    unchanged=async()=>{assert.deepEqual(await job(),owned.job);assert.deepEqual(await parent(),owned.parent);
      assert.deepEqual(await blobs(),owned.blobs);assert.deepEqual(await snapshot(),owned.index);await immutable();},
    reopen=()=>service[method](input,options);
  // Current actual database actor loss refuses BEFORE original I/O. Only the
  // disposable graph's real membership role is restored, never attempt history.
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(reopen(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await unchanged();
  for(const [fault,reason] of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],
    ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);
    try{await assert.rejects(reopen(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await unchanged();
  }
  reads=originalReads();const result=await reopen();assert.equal(originalReads(),reads+1);await unchanged();
  assert.equal(result.status,'current_authorized_first_completed_index_source_originals_reconciled');
  assert.deepEqual(result.selected_source,{kind:'source_record',native_key:'501',first_selected_ordinal:1});
  assert.equal(result.selected_entry.account_id,'CLOSURE-A');assert.equal(result.selected_entry.ordinal,1);
  assert.equal(result.transaction_index_sequence,3);
  assert.deepEqual(result.transaction_index_reference,owned.index.selected_transaction_index_v2_heads[0].receipt_reference);
  assert.deepEqual(result.native_packages,[{kind:'source_record',native_key:'501'}]);
  assert.ok(result.transaction_original_count>0);assert.ok(result.distinct_original_count>result.transaction_original_count);
  assert.equal(result.native_key_set_reconciled,true);assert.equal(result.complete_original_reconciled_source,true);
  assert.ok(result.membership.associations.some(row=>row.account_id==='CLOSURE-A'&&row.selected_union_member===true));
  assert.ok(result.membership.associations.some(row=>row.account_id==='CLOSURE-B'&&row.selected_union_member===true),
    'the selected shared-source association is still reopened as part of the WHOLE package');
  assert.equal(result.read_only,true);assert.equal(result.lease_extended,false);assert.equal(result.context_complete,false);
  assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');assert.equal(result.economic_progress_retained,false);
  assert.equal(Object.hasOwn(result,'native_index_candidate'),false);
  for(const key of ['economic_transactions','calendar_quarters','publication','production_speed','source_acquisition'])assert.equal(result[key],'not_established');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);
  reads=originalReads();setFault('completed_source_ack');await assert.rejects(reopen(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);await unchanged();
  reads=originalReads();assert.deepEqual(await reopen(),result);assert.equal(originalReads(),reads+1);await unchanged();
  const resolutionMethod='readCoveredOriginalFrozenCaptureJobCompletedIndexFirstSourceResolutionReferencesV3',
    resolve=()=>service[resolutionMethod](input,options);
  for(const [fault,reason] of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/]]){
    reads=originalReads();setFault(fault);await assert.rejects(resolve(),reason);
    assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);await unchanged();
  }
  reads=originalReads();const resolved=await resolve();assert.equal(originalReads(),reads+1);await unchanged();
  assert.equal(resolved.status,'current_authorized_first_completed_index_source_observations_resolved');
  const observation=resolved.selected_source_resolution;
  assert.deepEqual(observation.membership,{native_account_count:3,selected_account_count:2,unselected_stock_account_count:0,
    outside_stock_account_count:1,unresolved_account_row_count:0,reported_resolved_link_count:2,unresolved_link_count:0,native_account_state:'multiple_native_accounts',
    provider_parcel_membership:'not_established',economic_property_membership:'not_established'});
  assert.equal(observation.unique_native_sale.account_id,'CLOSURE-OUTSIDE');assert.equal(observation.unique_native_sale.membership,'outside_stock');
  assert.equal(observation.unique_native_sale.recorded_price.state,'unsupported');
  assert.equal(observation.unique_native_sale.recorded_price.exact_value,'9007199254740993');
  assert.deepEqual(observation.native_closing_date,{state:'observed',exact_value:'2010-01-01',reason:null});
  assert.equal(observation.native_calendar_quarter,'2010-Q1');assert.equal(observation.native_period_disposition.state,'outside_period');
  assert.equal(observation.same_payload_reported.closing_date.state,'missing');assert.equal(observation.same_payload_reported.calendar_quarter,null);
  assert.equal(observation.same_payload_reported.record_type,'unknown');
  assert.equal(observation.same_payload_reported.observations.reported_close_price.state,'unsupported');
  assert.equal(observation.same_payload_reported.observations.reported_close_price.exact_value,'9007199254740993');
  assert.equal(observation.same_payload_reported.observations.reported_close_price.unit,null);
  assert.equal(observation.economic_transaction_eligibility,'not_established');assert.equal(observation.quarter_statistics,'not_established');
  assert.equal(resolved.read_only,true);assert.equal(resolved.lease_extended,false);assert.equal(resolved.pin_transfer,false);
  assert.ok(Buffer.byteLength(JSON.stringify(resolved))<=16000);
  reads=originalReads();setFault('completed_source_ack');await assert.rejects(resolve(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);await unchanged();
  reads=originalReads();assert.deepEqual(await resolve(),resolved);assert.equal(originalReads(),reads+1);await unchanged();
  console.info('[native-completed-index-first-source-resolution-v3]',{
    actual_whole_source501_and_selected_A_B_outside_canonical_sale_account_reopened:true,
    outside_sale_price_not_allocated_to_selected_source_or_link_accounts:true,
    exact_unsafe_integer_retained_without_currency_or_CurrentPrice_fallback:true,
    native_2010_Q1_outside_period_separate_from_missing_reported_date_and_unknown_status:true,
    actual_original_cache_ending_market_workspace_refusals_and_lost_readonly_ACK_fresh_reopen:true,
    all_job_lease_native_parent_blob_report_assignment_workspace_choices_and_pins_unchanged:true,
    economic_equivalence:false,eligible_transaction_population:false,quarter_statistics:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
  console.info('[native-completed-index-first-source-original-owner-v3]',{
    actual_complete_exact17_index_and_committed_consumed_native_continuation_claim:true,
    server_owned_first_registered_package_and_whole_first_seen_account:true,
    whole_stock_CAD_all_date_source_subject_ENTIRE_caches_every_prior_native_member_and_bidirectional_account_keys:true,
    current_actor_refusal_before_IO_ending_market_CAD_actor_workspace_header_coverage_and_actual_cache_refusals:true,
    lost_actual_readonly_COMMIT_ACK_identical_fresh_reopen_same_live_claim:true,
    job_lease_checkpoint_parent_all_native_heads_rows_blobs_intent_workspace_reports_and_pins_unchanged:true,
    empty_or_next_source_progress:false,economic_equivalence:false,calendar_quarters:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
