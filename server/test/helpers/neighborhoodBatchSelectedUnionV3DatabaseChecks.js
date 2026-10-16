import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';

/** Twenty-fourth independently captured graph. Explicit fixture intent alone
 * chooses groups. Every account and subject still come from actual originals. */
export async function runNeighborhoodBatchSelectedUnionV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,claim,command}){
  const operation=input.operationId,method='continueCoveredOriginalFrozenCaptureJobBatchSelectedStockUnionReferencesV3',
    before={job:await job(),parent:await parent(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs()},
    union=async()=>({head:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      groups:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=$1 ORDER BY group_id COLLATE "C"',[operation])).rows,
      rows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows}),
    readBody=async ref=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,ref.content_sha256])).rows[0].canonical_utf8),
    immutable=async()=>{assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    unchanged=async()=>{assert.deepEqual(await job(),before.job);assert.deepEqual(await parent(),before.parent);
      assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await union(),{head:[],groups:[],rows:[]});await immutable();},
    invoke=()=>service[method](input,{captureJobClaim:claim});
  assert.deepEqual(await union(),{head:[],groups:[],rows:[]});
  await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobSelectedStockUnionReferencesV2(input,{captureJobClaim:claim}),/invalid_receipt/);await unchanged();
  for(const [fault,reason] of [['union_workspace',/custom_cohort_group_workspace_study_changed/],
    ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['catalog_replay_counts',/catalog_original_mismatch/],['union_cache',/original_mismatch/],
    ['union_orphan',error=>error.outcome_unknown===true&&error.code==='55000'
      &&error.message==='neighborhood_selected_union_v2_orphan_progress']]){
    setFault(fault);const reads=originalReads();await assert.rejects(invoke(),reason);assert.equal(readFault(),null);
    assert.equal(originalReads(),reads+1,'subject and next whole account share ONE real original packet, including ending refusals');
    if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await unchanged();
  }
  const firstReads=originalReads();setFault('union_ack');await assert.rejects(invoke(),e=>e.outcome_unknown===true);
  assert.equal(readFault(),null);assert.equal(originalReads(),firstReads+1);
  let saved=await union();assert.equal(saved.head.length,1);assert.equal(saved.head[0].sequence,1);
  assert.deepEqual(saved.rows.map(r=>[r.account_id,r.ordinal,r.partition_ordinal]),[['CLOSURE-A',1,1]]);
  assert.equal((await job()).status,'retry');assert.equal((await job()).claim_token,null);
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs();
  await assert.rejects(invoke(),/claim_lost/);assert.deepEqual(await union(),saved);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);await immutable();
  // Native continuation storage mints a fresh token; no manually patched claim,
  // retry count, checkpoint, receipt or membership is admitted by this fixture.
  for(const sequence of [2,3]){
    const issued=await tx(pool,c=>continuations(c).claimDue({limit:1,leaseSeconds:900}));
    assert.equal(issued.length,1);assert.equal(issued[0].claim.operation_id,operation);
    assert.equal(issued[0].claim.attempts,5);assert.notEqual(issued[0].claim.claim_token,claim.claim_token);claim=issued[0].claim;
    const reads=originalReads(),result=await invoke();assert.equal(originalReads(),reads+1);
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');
    assert.equal(result.complete_distinct_selected_stock_union,sequence===3);assert.equal(result.selected_stock_accounts,2);
    assert.equal(result.continuation.fresh_claim_required,true);assert.equal(result.continuation.attempts,5);
    const receipt=await readBody(result.union_reference);assert.equal(receipt.format,'cohort_selected_union_receipt_v2');
    assert.equal(receipt.sequence,sequence);assert.equal(receipt.after.done,sequence===3);
    assert.equal(receipt.after.account_count,2);assert.equal(receipt.after_selected_count,2);
    saved=await union();assert.equal(saved.head[0].sequence,sequence);
    assert.deepEqual(saved.rows.map(r=>[r.account_id,r.ordinal,r.partition_ordinal]),[['CLOSURE-A',1,1],['CLOSURE-B',2,2]]);
    for(const row of saved.rows){const actual=(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows WHERE operation_id=$1 AND ordinal=$2',[operation,row.partition_ordinal])).rows[0];
      assert.equal(row.account_id,actual.account_id);assert.deepEqual(row.entry_reference,actual.entry_reference);}
    if(sequence===3){assert.equal(receipt.entry_reference,null);assert.deepEqual(receipt.after_counts,receipt.before_counts);}
    const current=await job();assert.equal(current.attempts,5);assert.equal(current.last_error_code,'access_revoked');
    assert.equal(current.context_sha256,null);assert.equal(current.checkpoint.evidence_refs.length,10);await immutable();
  }
  assert.deepEqual(saved.groups.map(g=>g.member_count),[1,1]);
  console.info('[native-batch-selected-union-v3]',{independent_actual_initial_source_cache_stock_partition_catalog_waiting_and_explicit_command:true,
    server_owned_A_B_and_separate_fresh_EMPTY:true,whole_subject_and_account_originals_ENTIRE_cache_and_partition_entries_reconciled:true,
    ending_workspace_source_actor_counts_cache_and_orphan_yield_rollback:true,lost_actual_first_COMMIT_ACK_and_stale_claim_refusal:true,
    fresh_native_continuation_tokens_no_failure_refund:true,all_catalog_groups_and_actual_selected_rows_exact:true,
    immutable_command_catalog_native_parents_workspace_reports_and_pins_preserved:true,
    single_account_union_transition_only:true,automatic_worker:false,complete_metric_population:false,
    production_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
}
