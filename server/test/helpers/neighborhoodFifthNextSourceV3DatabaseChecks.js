import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run after actual normal-fifth FIRST and original1/failure1/second2/failure2/
// third3/failure3/fourth4/failure4/fifth5. No initial4 or recovered5 borrowing.
export async function runNeighborhoodFifthNextSourceV3DatabaseChecks({pool,input,scope,actor,service,claim,
  originalReads,laterFirstSource,setFault,readFault,unchanged}){
  const names=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
    ORDER BY c.table_name`)).rows.map(r=>r.table_name);
  assert.ok(names.length>10&&names.every(n=>/^[a-z_][a-z0-9_]*$/.test(n)));
  const all=async()=>({parents:await Promise.all(names.map(name=>pool.query(`SELECT to_jsonb(r) AS body FROM app.${name} r
      WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[input.operationId]).then(r=>r.rows))),
    blobs:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.neighborhood_cohort_evidence_blobs r
      WHERE organization_id=$1 ORDER BY content_sha256`,[scope.organization_id])).rows,
    report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    assignment:(await pool.query('SELECT to_jsonb(r) AS body FROM app.assignment_files r WHERE id=$1',[scope.assignment_file_id])).rows,
    private_workfile:(await pool.query('SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfiles r WHERE assignment_file_id=$1',[scope.assignment_file_id])).rows,
    subject:(await pool.query(`SELECT to_jsonb(s) AS body FROM app.appraisal_subject_snapshots s
      JOIN app.report_files r ON r.subject_snapshot_id=s.id WHERE r.id=$1`,[scope.report_file_id])).rows,
    manual:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows,
    workspace:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows,
    source_grants:(await pool.query('SELECT to_jsonb(r) AS body FROM app_auth.organizations r WHERE id=$1',[scope.organization_id])).rows}),
    before=await all(),preserved=async()=>{await unchanged();assert.deepEqual(await all(),before);},
    method='readCoveredOriginalFrozenCaptureJobFifthNextSourceReferencesV3',
    run=(owned=claim)=>service[method](input,{captureJobClaim:owned});
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
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await restoreOriginalRoles();}
  await preserved();
  for(const [fault,reason]of [['next_source_assignment_before_io',/assignment_access_denied/],
    ['next_source_draft_before_io',/private_source_read_only/]]){
    reads=originalReads();setFault(fault);await assert.rejects(run(),reason);
    assert.equal(readFault(),null);assert.equal(originalReads(),reads);await preserved();
  }
  for(const owned of [{...claim,claim_token:randomUUID()},{...claim,attempts:claim.attempts===1?2:claim.attempts-1}]){
    reads=originalReads();await assert.rejects(run(owned),/claim_lost/);assert.equal(originalReads(),reads);await preserved();
  }
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],
    ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/],
    ['owned_source_subject',/subject_changed/],['next_source_native_ending',/native_plan_changed/],
    ['next_source_assignment_ending',/assignment_access_denied/],['next_source_draft_ending',/private_source_read_only/]]){
    reads=originalReads();setFault(fault);
    try{await assert.rejects(run(),reason,fault);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await restoreOriginalRoles();}
    await preserved();
  }
  reads=originalReads();const result=await run();assert.equal(originalReads(),reads+1);await preserved();
  assert.equal(result.status,'current_authorized_fifth_next_source_originals_reconciled');
  assert.equal(claim.attempts,5);assert.equal(result.fifth_source_failure_attempt,5);
  assert.equal(result.original_birth_rebound,false);
  assert.equal(Object.hasOwn(result,'retained_source_fifth_claim_transaction'),false);
  {
    // The retained FIRST candidate is a native parent binding, never semantic
    // authority for NEXT. This owner does not claim to reproduce FIRST from B.
    assert.equal(Object.hasOwn(result,'retained_birth_candidate_compared_to_whole_originals'),false);
    assert.equal(Object.hasOwn(result,'retained_original_birth_transaction'),false);
  }
  assert.deepEqual(result.selected_source,{kind:'source_record',native_key:'503',first_selected_ordinal:2});
  assert.equal(result.selected_entry.account_id,'CLOSURE-B');assert.equal(result.selected_entry.ordinal,2);
  assert.equal(result.transaction_index_sequence,3);assert.equal(result.native_key_set_reconciled,true);
  assert.deepEqual(result.native_packages,[{kind:'legacy_sale',native_key:'10'},{kind:'legacy_sale',native_key:'3'},
    {kind:'source_record',native_key:'501'},{kind:'source_record',native_key:'503'},{kind:'source_record',native_key:'504'}]);
  assert.ok(result.transaction_original_count>0&&result.distinct_original_count>result.transaction_original_count);
  assert.equal(result.membership.coverage,'whole_native_packages_for_next_registered_source_first_seen_account_only');
  assert.ok(result.membership.associations.some(r=>r.account_id===null));
  assert.ok(result.membership.associations.some(r=>r.account_id==='CLOSURE-B'&&r.selected_union_member===true));
  const resolution=result.selected_source_resolution;
  assert.equal(resolution.native_key,'503');assert.equal(resolution.native_sale_state,'absent');assert.equal(resolution.unique_native_sale,null);
  assert.equal(resolution.membership.native_account_state,'unresolved_associations');
  assert.equal(resolution.membership.selected_account_count,1);assert.equal(resolution.membership.unresolved_account_row_count,2);
  assert.equal(resolution.membership.reported_resolved_link_count,1);assert.equal(resolution.membership.unresolved_link_count,1);
  assert.equal(resolution.native_closing_date.state,'unresolved');assert.equal(resolution.native_calendar_quarter,null);
  // Source503 has an actual SQL-NULL raw payload. Its unavailable witness is
  // unsupported, distinct from an absent CloseDate field in an object payload.
  assert.deepEqual(resolution.same_payload_reported.closing_date,
    {state:'unsupported',exact_value:null,reason:'unsupported_close_date'});
  assert.equal(resolution.same_payload_reported.calendar_quarter,null);
  assert.equal(resolution.economic_transaction_eligibility,'not_established');assert.equal(resolution.quarter_statistics,'not_established');
  assert.equal(result.complete_original_reconciled_source,true);assert.equal(result.read_only,true);
  for(const key of ['lease_extended','source_cursor_advanced','economic_progress_retained','pin_transfer','context_complete'])assert.equal(result[key],false);
  assert.equal(result.report_update,'none');assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);
  reads=originalReads();setFault('completed_source_ack');await assert.rejects(run(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);await preserved();
  reads=originalReads();assert.deepEqual(await run(),result);assert.equal(originalReads(),reads+1);await preserved();
  console.info('[native-fifth18-NEXT-source-whole-original-owner-v3]',{
    independent_capture:laterFirstSource?'B_FIRST_ordinal2_after_empty_A':'A_FIRST_ordinal1',
    actual_native_NEXT503_after_FIRST501_and_real_first_seen_B_ordinal2:true,
    actual_initial_owned18_and_second18_claims_entire_immutable17_birth_preclaim_FIRST_member_edge:true,
    actual_failure_attempt:claim.attempts,
    entire_native_original17_birth18_owned1_failure1_second2_failure2_third3_failure3_fourth4_failure4_fifth5_FIRST_member_edge:true,
    every_whole_B_source_CAD_stock_all_date_original_required_subject_ENTIRE_caches_and_all_native_members_reconciled:true,
    entire_native_B_keyset_bidirectional_equal_and_unresolved503_without_borrowed_sale_date_quarter_or_price:true,
    current_actor_assignment_private_draft_refused_before_IO_with_real_target_DML_rolled_back:true,
    eleven_real_ending_fences_including_assignment_draft_and_same_count_changed_ending_NATIVE_NEXT_refused:true,
    actual_lost_readonly_COMMIT_ACK_and_identical_fresh_reopen_with_full_native_job_history_preserved:true,
    every_parent_blob_source_grant_report_assignment_private_workfile_subject_manual_workspace_choice_pin_unchanged:true,
    same_aggregate256_SQL_32MB_60s_single_use_child250_and_original180s_deadline:true,
    source_cursor_advanced:false,fresh_EMPTY:false,economic_progress_retained:false,complete_selected_union:false,
    publication:false,pin_transfer:false,activation:false,licensed_large_area:false,production_speed:false});
}
