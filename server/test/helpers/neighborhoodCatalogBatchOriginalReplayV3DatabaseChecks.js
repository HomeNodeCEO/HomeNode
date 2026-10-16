import assert from 'node:assert/strict';

/** Only the twenty-first independently captured graph invokes this read owner.
 * Actual issued catalog DONE is a prerequisite, never semantic source proof. */
export async function runNeighborhoodCatalogBatchOriginalReplayV3DatabaseChecks({pool,input,scope,actor,service,claim,packet,
  catalogHead,groups,job,parent,blobs,assertParents,setFault,readFault,originalReads}){
  const method='readCoveredOriginalFrozenCaptureJobRecordedCatalogBatchAccountReferencesV3',
    before={catalog:await catalogHead(),groups:await groups(),job:await job(),parent:await parent(),blobs:await blobs()},
    read=cursor=>service[method](input,{captureJobClaim:claim,stockAccountPackagePage:{cursor}}),
    unchanged=async()=>{assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual(await job(),before.job);assert.deepEqual(await parent(),before.parent);assert.deepEqual(await blobs(),before.blobs);await assertParents();};
  for(const [index,cursor] of ['',packet.accounts[0].account_id,packet.accounts[1].account_id].entries()){
    const priorReads=originalReads(),actual=await read(cursor),expected=packet.accounts[index]??null;
    assert.equal(originalReads()-priorReads,1,'ONE fresh whole original packet per actual read, including EMPTY');
    assert.equal(actual.status,'original_reconciled_catalog_batch_account');assert.equal(actual.receipt_format,'cohort_recorded_catalog_batch_receipt_v3');
    assert.equal(actual.account_id,expected?.account_id??null);assert.deepEqual(actual.rows,expected?.rows??[]);
    assert.deepEqual(actual.original_counts,expected?.original_counts??{parcels:0,accounts:0});
    assert.deepEqual(actual.observations,expected?.observations??null);assert.deepEqual(actual.recorded_group,expected?.recorded_group??null);
    assert.deepEqual(actual.recorded_housing,expected?.recorded_housing??null);assert.equal(actual.partition_ordinal,expected?index+1:null);
    assert.equal(actual.end_of_accounts,expected===null);assert.equal(actual.complete_catalog_original_replay,false);
    assert.equal(actual.prior_active_choice,'not_carried_into_new_study');assert.equal(actual.genuine_new_group_choice,'not_established');
    assert.equal(actual.selection_intent,'not_established');assert.equal(actual.publication,'not_established');assert.equal(actual.report_update,'none');
    assert.deepEqual(actual.catalog_reference,before.catalog.receipt_reference);assert.ok(actual.selection_workspace_target);
    assert.deepEqual(actual.retained_observation_period,input.observationPeriod);await unchanged();
  }
  for(const [mode,reason] of [['wait_missing',/custom_cohort_group_workspace_unavailable/],
    ['batch_workspace',/custom_cohort_group_workspace_study_changed/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['batch_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_entry',/partition_original_mismatch/],
    ['catalog_replay_group',/catalog_original_mismatch/],['catalog_replay_counts',/catalog_original_mismatch/]]){
    setFault(mode);await assert.rejects(read(packet.accounts[0].account_id),reason);assert.equal(readFault(),null);
    if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await unchanged();
  }
  setFault('catalog_ack');await assert.rejects(read(''),e=>e.outcome_unknown===true);assert.equal(readFault(),null);await unchanged();
  const reopened=await read('');assert.equal(reopened.account_id,packet.accounts[0].account_id);await unchanged();
  await assert.rejects(service.readCoveredOriginalFrozenCaptureJobRecordedCatalogAccountReferencesV2(input,
    {captureJobClaim:claim,stockAccountPackagePage:{cursor:''}}),/invalid_receipt/);await unchanged();
  console.info('[native-catalog-batch-original-replay-v3]',{actual_independent_stock_partition_catalog_DONE:true,
    one_current_authorized_whole_original_packet_per_A_B_and_fresh_EMPTY:true,
    ENTIRE_cache_ENTIRE_partition_entry_original_date_housing_group_and_native_normalized_literals_reconciled:true,
    current_and_ending_pending_workspace_source_actor_entry_group_and_counts_refused:true,
    actual_read_only_COMMIT_ACK_lost_then_fresh_reopen:true,legacy_V2_format_reinterpretation_refused:true,
    jobs_heads_rows_blobs_continuations_native_parents_pins_workspace_and_reports_unchanged:true,
    complete_catalog_semantic_authority:false,genuine_selection_intent:false,selected_union:false,
    production_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
