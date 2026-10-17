import assert from 'node:assert/strict';
import { runNeighborhoodNativeClaimPair as pair } from './neighborhoodNativeClaimPair.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedTransactionIndexV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedTransactionIndexV3WorkerRepository.js';
import { runCustomCohortBatchSelectedTransactionIndexV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedTransactionIndexV3JobWorker.js';
import { runCustomCohortBatchSelectedSemanticV3JobOnce as semantic } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedSemanticV3JobWorker.js';
import { createCustomCohortCompletedIndexFirstSourceV3Repository as completedSource } from '../../src/services/neighborhoodAssessment/customCohortCompletedIndexFirstSourceV3Repository.js';
import { runNeighborhoodCompletedIndexFirstSourceV3DatabaseChecks } from './neighborhoodCompletedIndexFirstSourceV3DatabaseChecks.js';

/** Independent capture. The actual shared native package is
 * frozen before capture, then reopened for EACH selected account and EMPTY.
 * Registry keys and edges never establish economic identity or source rights. */
export async function runNeighborhoodBatchSelectedTransactionIndexV3DatabaseChecks({sourceRecoveryFixture=false,pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command,laterFirstSource=false}){
  const sourceFailureAttempt=sourceRecoveryFixture?4:5,sourceFailureCode=sourceRecoveryFixture?'capture_failed':'access_revoked';
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedTransactionIndexReferencesV3',
    tables=['selected_transaction_index_v2_heads','selected_transaction_index_v2_rows',
      'selected_transaction_source_v2_keys','selected_transaction_legacy_v2_keys','selected_transaction_index_v2_edges'],
    readTables=async names=>{
      const result={};
      for(const table of names)result[table]=(await pool.query(`SELECT * FROM app.neighborhood_custom_cohort_${table}
        WHERE operation_id=$1 ORDER BY to_jsonb(neighborhood_custom_cohort_${table})::text COLLATE "C"`,[operation])).rows;
      return result;
    },snapshot=()=>readTables(tables),parents=()=>readTables(['selected_semantic_v2_heads','selected_semantic_v2_rows',
      'selected_numeric_v2_heads','selected_numeric_v2_rows','selected_numeric_index_v2_rows',
      'selected_statistics_v2_heads','selected_statistics_v2_rows','selected_metrics_v2_heads','selected_metrics_v2_rows',
      'selected_union_v2_heads','selected_eligibility_v2_heads','selected_evidence_v2_heads','selected_initial_dispatch_v2']),
    before={parents:await parents(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs(),index:await snapshot()},
    immutable=async()=>{assert.deepEqual(await parents(),before.parents);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);await assertParents();},
    body=async reference=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3',
      [scope.organization_id,reference.content_sha256,reference.canonical_utf8_bytes])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900};
  assert.ok(Object.values(before.index).every(rows=>rows.length===0));
  assert.equal((await body(before.parents.selected_semantic_v2_heads[0].receipt_reference)).after.done,true);
  const beforeAdmission={job:await job(),parent:await parent()},admissionRollback=Error('rollback genuine incomplete-index native source admission');
  const admissionReads=originalReads();
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await assert.rejects(completedSource({client,claim:next.claim,scope,actorUserId:actor}).readFirst(),/claim_or_completed_index_lost/);
    throw admissionRollback;
  }),e=>e===admissionRollback);
  assert.equal(originalReads(),admissionReads);assert.deepEqual(await job(),beforeAdmission.job);assert.deepEqual(await parent(),beforeAdmission.parent);
  assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await snapshot(),before.index);await immutable();
  let calls=0,ownerError,owned,ownedParent,firstClaim;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await snapshot(),before.index);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,sourceFailureAttempt);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedTransactionIndexReferencesV2(value,options),/invalid_receipt/);await unchanged();
      const admissionReads=originalReads();
      await assert.rejects(service.readCoveredOriginalFrozenCaptureJobCompletedIndexFirstSourceReferencesV3(value,options),/checkpoint_conflict/);
      assert.equal(originalReads(),admissionReads);await unchanged();
      for(const [fault,reason] of [['transaction_index_cache',/original_mismatch/],
        ['transaction_index_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_transaction_index_v2_orphan_child']]){
        const count=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),count+1);await unchanged();
      }
      setFault('transaction_index_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await pair(run,firstArgs,method);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  let current=await snapshot(),head=current.selected_transaction_index_v2_heads[0],receipt=await body(head.receipt_reference);
  assert.equal(head.sequence,1);assert.equal(receipt.format,'cohort_selected_transaction_index_receipt_v2');
  assert.equal(current.selected_transaction_index_v2_rows.length,1);assert.equal(current.selected_transaction_index_v2_rows[0].account_id,'CLOSURE-A');
  assert.equal(receipt.after.done,false);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs(),firstIndex=current;
  await assert.rejects(service[method](input,{captureJobClaim:firstClaim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);assert.deepEqual(await snapshot(),firstIndex);
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
    assert.equal(result.complete_original_reconciled_selected_index,sequence===3);assert.equal(result.global_economic_transaction_deduplication,false);
    assert.equal(result.read_only,false);assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');
    for(const key of ['calendar_quarters','economic_transactions','at_sale_facts','publication','source_acquisition','production_speed'])assert.equal(result[key],'not_established');
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);current=await snapshot();head=current.selected_transaction_index_v2_heads[0];assert.equal(head.sequence,sequence);
    receipt=await body(head.receipt_reference);assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.selected_ordinal,2);
    assert.deepEqual(current.selected_transaction_index_v2_rows.map(r=>r.ordinal).sort(),[1,2]);
    if(sequence===3){assert.equal(receipt.selected_entry,null);assert.equal(result.source_package_count,0);assert.equal(result.legacy_package_count,0);}
    assert.equal((await job()).attempts,sourceFailureAttempt);assert.equal((await job()).last_error_code,sourceFailureCode);assert.equal((await job()).checkpoint.evidence_refs.length,17);await immutable();
  }
  const sources=current.selected_transaction_source_v2_keys,legacies=current.selected_transaction_legacy_v2_keys,edges=current.selected_transaction_index_v2_edges;
  assert.deepEqual(sources.map(r=>r.source_record_id).sort(),['501','503','504']);assert.deepEqual(legacies.map(r=>r.legacy_sale_key).sort(),['10','3']);assert.equal(edges.length,laterFirstSource?5:6);
  assert.equal(sources.find(r=>r.source_record_id==='501').first_selected_ordinal,laterFirstSource?2:1);
  assert.ok(sources.filter(r=>r.source_record_id!=='501').every(r=>r.first_selected_ordinal===2));assert.ok(legacies.every(r=>r.first_selected_ordinal===2));
  for(const ordinal of (laterFirstSource?[2]:[1,2]))assert.ok(edges.some(r=>r.ordinal===ordinal&&r.source_record_id==='501'));
  if(laterFirstSource)assert.equal(edges.filter(r=>r.ordinal===1).length,0,'selected A was indexed after its actual EMPTY transaction package');
  assert.ok(!sources.some(r=>r.source_record_id==='502'),'outside second-hop package is never expanded');
  assert.equal(receipt.after.source_record_keys,3);assert.equal(receipt.after.legacy_sale_keys,2);
  for(const row of current.selected_transaction_index_v2_rows){const member=before.parents.selected_semantic_v2_rows.find(r=>r.ordinal===row.ordinal);
    assert.ok(member);assert.equal(row.account_id,member.account_id);assert.deepEqual(row.entry_reference,member.entry_reference);
    assert.deepEqual(row.metric_row_reference,member.metric_row_reference);assert.deepEqual(row.contribution_row_reference,member.contribution_row_reference);}
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),index:await snapshot()};
  for(const worker of [run,semantic])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled economic-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    const source=completedSource({client,claim:next.claim,scope,actorUserId:actor}),reads=originalReads(),plan=await source.readFirst();
    assert.deepEqual(plan.source,{kind:'source_record',native_key:'501',first_selected_ordinal:laterFirstSource?2:1});
    const indexed=terminal.index.selected_transaction_index_v2_rows.find(r=>r.ordinal===(laterFirstSource?2:1));
    assert.deepEqual(plan.selected_entry,Object.fromEntries(['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'].map(k=>[k,indexed[k]])));
    assert.equal(plan.index_sequence,3);assert.equal(plan.registered_source_keys,3);assert.equal(plan.registered_legacy_keys,2);
    assert.deepEqual(plan.index_reference,terminal.index.selected_transaction_index_v2_heads[0].receipt_reference);
    for(const key of ['originals_reconciled','source_authority','economic_transaction'])assert.equal(plan[key],false);
    assert.deepEqual(await source.readFirst(),plan);assert.equal(originalReads(),reads);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads WHERE operation_id=$1',[operation])).rows,terminal.index.selected_transaction_index_v2_heads);
    console.info('[native-completed-index-first-source-v3]',{actual_complete_index_and_consumed_native_continuation:true,
      first_registered_shared_source_and_original_first_seen_account:true,readonly_repeat_same_transaction:true,
      later_first_seen_selected_ordinal_two:laterFirstSource,
      source_authority:false,originals_reconciled:false,economic_transaction:false,production_activation:false});
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await assert.rejects(source.readFirst(),/claim_or_completed_index_lost/);assert.equal(originalReads(),reads);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await snapshot(),terminal.index);await immutable();
  await runNeighborhoodCompletedIndexFirstSourceV3DatabaseChecks({sourceRecoveryFixture,pool,input,scope,actor,service,job,parent,blobs,
    snapshot,immutable,setFault,readFault,originalReads,laterFirstSource});
  console.info('[native-batch-selected-transaction-index-v3]',{independent_actual_V3_semantic_worker_fresh_EMPTY:true,
    every_selected_complete_original_ENTIRE_cache_and_every_prior_native_member_reconciled_again:true,
    real_shared_source_replayed_per_selected_account_exact_namespaced_keys_edges_and_first_seen:!laterFirstSource,
    first_registered_source_belongs_to_selected_ordinal_two_after_empty_A:laterFirstSource,
    cache_refusal_real_orphan_COMMIT_rollback_lost_first_ACK_concurrent_A_B_fresh_EMPTY_native_claims5:!sourceRecoveryFixture,
    actual_preserved_native_claim_failure_attempt:sourceFailureAttempt,
    DONE_all_claim_recovery_expiry_cancelled_next_owner_excluded_native_parents_history_pins_preserved:true,
    ordinary_worker_recovery_below5:'not_exercised_requires_new_reserved_failure_graph',
    new_stage_all_ending_authority_faults:'not_separately_injected_prior_independent_stages_cover_shared_fences',
    economic_equivalence:false,calendar_quarters:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
