import assert from 'node:assert/strict';
import { runNeighborhoodNativeClaimPair as pair } from './neighborhoodNativeClaimPair.js';
import { runNeighborhoodBatchSelectedEvidenceV3DatabaseChecks } from './neighborhoodBatchSelectedEvidenceV3DatabaseChecks.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortBatchSelectedEligibilityV3WorkerRepository as claims } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3WorkerRepository.js';
import { runCustomCohortBatchSelectedEligibilityV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedEligibilityV3JobWorker.js';
import { runCustomCohortBatchSelectedInitialV3JobOnce as initial } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedInitialV3JobWorker.js';
import { runCustomCohortBatchSelectedProgressV3JobOnce as unionProgress } from '../../src/services/neighborhoodAssessment/customCohortBatchSelectedProgressV3JobWorker.js';

/** Twenty-sixth independently captured graph, after actual worker-issued union
 * DONE. This is the recorded-comparison pass, not full semantic eligibility. */
export async function runNeighborhoodBatchRecordedEligibilityV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
  catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedEvidenceFixture=false,batchSelectedMetricsFixture=false,batchSelectedStatisticsFixture=false,batchSelectedNumericFixture=false,batchSelectedSemanticFixture=false}){
  const operation=input.operationId,method='progressCoveredOriginalFrozenCaptureJobBatchSelectedRecordedEligibilityReferencesV3',
    subjectMethod='readCoveredOriginalFrozenCaptureJobBatchSelectedUnionSubjectHousingReferencesV3',
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    union=async()=>({head:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows,
      rows:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
      groups:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=$1 ORDER BY group_id',[operation])).rows}),
    before={union:await union(),catalog:await catalogHead(),groups:await groups(),blobs:await blobs(),
      dispatch:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows},
    immutable=async()=>{assert.deepEqual(await union(),before.union);assert.deepEqual(await catalogHead(),before.catalog);assert.deepEqual(await groups(),before.groups);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows,[command]);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows,before.dispatch);await assertParents();},
    body=async()=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,(await head()).receipt_reference.content_sha256])).rows[0].canonical_utf8),
    args={pool,cohortService:service,leaseSeconds:900},metrics=['reported_year_built','reported_residential_area','reported_site_area'];
  assert.equal(await head(),undefined);assert.equal(before.union.head[0].sequence,3);
  let calls=0,ownerError,owned,ownedParent,firstClaim,subject;
  const unchanged=async()=>{
    const current=await job();assert.equal(current.claim_token,owned.claim_token);
    assert.ok(current.lease_expires_at.getTime()>=owned.lease_expires_at.getTime());assert.ok(current.lease_expires_at.getTime()<=Date.now()+901000);
    assert.deepEqual({...current,lease_expires_at:owned.lease_expires_at,updated_at:owned.updated_at},owned);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),before.blobs);assert.equal(await head(),undefined);await immutable();
  };
  const firstArgs={...args,cohortService:{async [method](value,options){
    try{
      calls++;firstClaim=options.captureJobClaim;assert.equal(firstClaim.attempts,5);owned=await job();ownedParent=await parent();
      await assert.rejects(service.progressCoveredOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2(value,options),/invalid_receipt/);await unchanged();
      await assert.rejects(service.readCoveredOriginalFrozenCaptureJobSelectedUnionSubjectHousingReferencesV2(value,options),/invalid_receipt/);await unchanged();
      if(batchSelectedEvidenceFixture){
        for(const name of ['readCoveredOriginalFrozenCaptureJobBatchFirstSelectedAmenitiesReferencesV3',
          'readCoveredOriginalFrozenCaptureJobBatchFirstSelectedTransactionsReferencesV3']){
          const reads=originalReads(),read=await service[name](value,options);assert.equal(originalReads(),reads+1);
          assert.equal(read.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(read.read_only,true);
          assert.equal(read.lease_extended,false);assert.equal(read.selected_entry.ordinal,1);assert.equal(read.context_complete,false);
          assert.equal(read.pin_transfer,false);assert.equal(read.report_update,'none');assert.ok(Buffer.byteLength(JSON.stringify(read))<=16000);
          if(name.includes('Amenities')){assert.equal(read.covered_CAD_originals,true);assert.equal(read.selected_CAD.account_id,read.selected_entry.account_id);}
          else{assert.equal(read.complete_selected_union_transactions,false);assert.equal(Object.hasOwn(read,'selected_CAD'),false);
            assert.deepEqual(read.selected_transactions.retained_observation_period,input.observationPeriod);}
          await unchanged();
        }
      }
      subject=await service[subjectMethod](value,options);assert.equal(subject.status,'current_authorized_selected_union_subject_housing_reopened');
      assert.equal(subject.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(subject.read_only,true);
      assert.equal(subject.lease_extended,false);assert.equal(subject.issued_eligibility_progress,false);
      assert.ok(['not_used_preferred_retained_subject_observation','whole_original_subject_account_reconciled'].includes(subject.fallback.status));await unchanged();
      for(const [fault,reason] of [['union_workspace',/custom_cohort_group_workspace_study_changed/],
        ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
        ['catalog_replay_counts',/catalog_original_mismatch/],['eligibility_cache',/original_mismatch/],
        ['eligibility_orphan',e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_selected_eligibility_v2_orphan_progress']]){
        const reads=originalReads();setFault(fault);await assert.rejects(service[method](value,options),reason);assert.equal(readFault(),null);
        assert.equal(originalReads(),reads+1,'one actual subject/next-selected packet per refusal, never a second child budget');
        if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);await unchanged();
      }
      setFault('eligibility_ack');return await service[method](value,options);
    }catch(error){ownerError=error;throw error;}
  }}};
  const first=await pair(run,firstArgs,method);if(ownerError&&!ownerError.outcome_unknown)throw ownerError;
  assert.deepEqual(first.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(calls,1);assert.equal(readFault(),null);
  assert.equal((await head()).sequence,1);let receipt=await body();assert.equal(receipt.format,'cohort_selected_recorded_eligibility_receipt_v2');
  assert.equal(receipt.selected_entry.account_id,'CLOSURE-A');assert.deepEqual(receipt.subject_housing,{state:subject.subject.state,category:subject.subject.category});await immutable();
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
    const steps=await pair(run,stepArgs,method);if(nextError)throw nextError;
    assert.deepEqual(steps.map(r=>r.status).sort(),['continuation_pending','idle']);assert.equal(count,1);firstClaim=nextClaim;
    assert.equal(result.catalog_receipt_format,'cohort_recorded_catalog_batch_receipt_v3');assert.equal(result.complete_selected_recorded_comparison_pass,sequence===3);
    assert.equal(result.complete_selected_union_eligibility,false);assert.equal(result.statistics,'not_established');assert.equal(result.context_complete,false);
    assert.equal((await head()).sequence,sequence);receipt=await body();assert.equal(receipt.after.done,sequence===3);assert.equal(receipt.after.selected_ordinal,2);
    assert.equal(receipt.selected_stock_count,2);assert.deepEqual(receipt.subject_housing,{state:subject.subject.state,category:subject.subject.category});
    if(sequence===2){assert.equal(receipt.selected_entry.account_id,'CLOSURE-B');assert.equal(receipt.selected_entry.ordinal,2);
      for(const metric of metrics){assert.equal(receipt.eligible[metric],result.decision.metrics[metric].recorded_comparison_eligible);
        assert.equal(receipt.after_counts[metric]-receipt.before_counts[metric],Number(receipt.eligible[metric]));}}
    else{assert.equal(receipt.selected_entry,null);assert.equal(receipt.eligible,null);assert.deepEqual(receipt.after_counts,receipt.before_counts);}
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');assert.equal((await job()).checkpoint.evidence_refs.length,11);await immutable();
  }
  const terminal={job:await job(),parent:await parent(),blobs:await blobs(),head:await head()};
  for(const worker of [run,initial,unionProgress])assert.deepEqual(await worker(args),{status:'idle'});
  const rollback=Error('rollback expired cancelled evidence-owner token');
  await assert.rejects(tx(pool,async client=>{
    const [next]=await continuations(client).claimDue({limit:1,leaseSeconds:900});assert.equal(next.claim.operation_id,operation);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const saved=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    assert.deepEqual(await claims(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,saved);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),terminal.job);assert.deepEqual(await parent(),terminal.parent);assert.deepEqual(await blobs(),terminal.blobs);assert.deepEqual(await head(),terminal.head);await immutable();
  if(batchSelectedEvidenceFixture){
    await runNeighborhoodBatchSelectedEvidenceV3DatabaseChecks({pool,input,scope,actor,service,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,command,batchSelectedMetricsFixture,batchSelectedStatisticsFixture,batchSelectedNumericFixture,batchSelectedSemanticFixture});return;
  }
  console.info('[native-batch-recorded-eligibility-v3]',{independent_actual_worker_issued_V3_catalog_command_union_DONE:true,
    read_only_subject_precedence_and_original_CAD_fallback_preserved:true,subject_fallback:subject.fallback.status,
    one_whole_subject_selected_packet_ENTIRE_cache_partition_and_current_ending_authority:true,
    legacy_V2_parent_reinterpretation_refused:true,actual_orphan_eligibility_COMMIT_and_lost_first_ACK:true,
    concurrent_A_B_and_separate_fresh_EMPTY_fresh_native_claims5:true,three_recorded_metric_bits_counts_and_selected_ordinals_exact:true,
    eligibility_DONE_all_claim_recovery_expiry_and_cancelled_next_owner_excluded:true,
    union_catalog_command_dispatch_parents_workspace_reports_history_and_pins_unchanged:true,
    complete_semantic_eligibility:false,economic_equivalence:false,statistics:false,publication:false,
    production_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
