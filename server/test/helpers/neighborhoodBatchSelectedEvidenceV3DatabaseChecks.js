import assert from 'node:assert/strict';
import { runNeighborhoodBatchSelectedMetricsV3DatabaseChecks } from './neighborhoodBatchSelectedMetricsV3DatabaseChecks.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedEvidenceV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEvidenceV3WorkerRepository.js';
import { runCustomCohortBatchSelectedEvidenceV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEvidenceV3JobWorker.js';
import { runCustomCohortBatchSelectedEligibilityV3JobOnce as eligibility } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3JobWorker.js';
import { runCustomCohortBatchSelectedInitialV3JobOnce as initial } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedInitialV3JobWorker.js';
import { runCustomCohortBatchSelectedProgressV3JobOnce as unionProgress } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedProgressV3JobWorker.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from '../../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { NEIGHBORHOOD_SHARED_TYPED_CAD_SQL as CAD_SQL } from '../../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';

/** Twenty-seventh independent acquisition, after actual V3 worker union and
 * recorded-comparison DONE. Real independent neutral/CAD owners precede both.
 * Complete original replay is evidence admission, not economic equivalence. */
export async function runNeighborhoodBatchSelectedEvidenceV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedMetricsFixture=false}){
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedEvidenceReferencesV3',
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    parents=async()=>({union:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      rows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      eligibility:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1',[operation])).rows,
      dispatch:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows}),
    generation=(await pool.query('SELECT generation_id FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=$1',[operation])).rows[0].generation_id,
    cadHeader=async()=>(await pool.query(CAD_SQL.read,[generation,getNeighborhoodFrozenTypedCadImprovementV1Profile().profile_ref.content_sha256])).rows[0],
    cad=(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    before={parents:await parents(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs(),cadHeader:await cadHeader()},
    immutable=async()=>{assert.deepEqual(await parents(),before.parents);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);
      assert.deepEqual(await cadHeader(),before.cadHeader);await assertParents();},
    body=async()=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,(await head()).receipt_reference.content_sha256])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900};
  assert.equal(await head(),undefined);assert.equal(before.parents.eligibility[0].sequence,3);
  assert.equal(before.cadHeader.status,'building');assert.equal(before.cadHeader.completed_at,null);
  assert.ok(cad,'actual independently issued CAD DONE parent is retained');
  let calls=0,ownerError,owned,ownedParent,firstClaim;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.equal(await head(),undefined);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,5);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedEvidenceReferencesV2(value,options),/invalid_receipt/);await unchanged();
      for(const [fault,reason] of [['selected_CAD_workspace',/custom_cohort_group_workspace_study_changed/],
        ['selected_CAD_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
        ['selected_CAD_deny',/market_data_access_denied/],['selected_CAD_header',/cache_unavailable/],
        ['selected_CAD_coverage',/coverage_unavailable/],['catalog_replay_counts',/catalog_original_mismatch/],
        ['evidence_cache',/original_mismatch/],
        ['evidence_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_evidence_v2_orphan_progress']]){
        const reads=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),reads+1,'ONE actual combined subject/next account packet before each ending refusal');
        if(fault==='selected_CAD_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);await unchanged();
      }
      setFault('evidence_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await Promise.all([run(firstArgs),run(firstArgs)]);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  assert.equal((await head()).sequence,1);let receipt=await body();assert.equal(receipt.format,'cohort_selected_evidence_receipt_v2');
  assert.equal(Object.keys(receipt).length,10);assert.equal(receipt.selected_entry.account_id,'CLOSURE-A');
  assert.deepEqual(receipt.eligibility_reference,before.parents.eligibility[0].receipt_reference);
  assert.deepEqual(receipt.union_reference,before.parents.union[0].receipt_reference);await immutable();
  const firstJob=await job(),firstParent=await parent(),firstBlobs=await blobs(),firstHead=await head();
  await assert.rejects(service[method](input,{captureJobClaim:firstClaim}),/claim_lost/);
  assert.deepEqual(await job(),firstJob);assert.deepEqual(await parent(),firstParent);assert.deepEqual(await blobs(),firstBlobs);assert.deepEqual(await head(),firstHead);
  for(const sequence of [2,3]){
    let count=0,result,nextError,nextClaim;
    const stepArgs={...args,cohortService:{async [method](value,options){
      try{count++;nextClaim=options.captureJobClaim;assert.equal(nextClaim.attempts,5);assert.notEqual(nextClaim.claim_token,firstClaim.claim_token);
        const reads=originalReads();result=await service[method](value,options);assert.equal(originalReads(),reads+1);return result;
      }catch(error){nextError=error;throw error;}
    }}};
    const steps=await Promise.all([run(stepArgs),run(stepArgs)]);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(count,1);firstClaim=nextClaim;
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(result.covered_neutral_originals,true);
    assert.equal(result.covered_CAD_originals,true);assert.equal(result.complete_selected_original_evidence_traversal,sequence===3);
    assert.equal(result.context_complete,false);assert.equal(result.pin_transfer,false);assert.equal(result.report_update,'none');
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=16000);
    assert.equal((await head()).sequence,sequence);receipt=await body();assert.equal(receipt.after.done,sequence===3);
    assert.equal(receipt.after.selected_ordinal,2);assert.equal(receipt.selected_stock_count,2);
    if(sequence===2){assert.equal(receipt.selected_entry.account_id,'CLOSURE-B');assert.equal(receipt.selected_entry.ordinal,2);
      assert.deepEqual(receipt.selected_entry.entry_reference,before.parents.rows[1].entry_reference);}
    else assert.equal(receipt.selected_entry,null);
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
    assert.equal((await job()).checkpoint.evidence_refs.length,12);await immutable();
  }
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),head:await head()};
  for(const worker of [run,eligibility,initial,unionProgress])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled metric-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await head(),terminal.head);await immutable();
  if(batchSelectedMetricsFixture){
    await runNeighborhoodBatchSelectedMetricsV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,command});return;
  }
  console.info('[native-batch-selected-evidence-v3]',{independent_actual_V3_workers_union_and_recorded_eligibility_DONE:true,
    actual_independent_CAD_DONE_global_header_still_building:true,first_CAD_amenities_and_all_date_transactions_read_only:true,
    ONE_whole_combined_subject_selected_packet_ENTIRE_neutral_CAD_cache_partition_reconciled:true,
    both_source_purposes_current_and_ending_role_workspace_header_coverage_count_cache_refusals:true,
    actual_deferred_orphan_evidence_COMMIT_and_lost_first_ACK:true,concurrent_A_B_and_fresh_EMPTY_native_claims5:true,
    evidence_DONE_all_claim_recovery_expiry_and_cancelled_next_owner_excluded:true,
    native_parents_command_dispatch_workspace_reports_history_and_pins_unchanged:true,
    ordinary_worker_recovery_below5:'not_exercised_requires_new_reserved_failure_graph',
    economic_equivalence:false,statistics:false,publication:false,production_activation:false,
    licensed_large_area:false,production_speed:false,pin_transfer:false});
}
