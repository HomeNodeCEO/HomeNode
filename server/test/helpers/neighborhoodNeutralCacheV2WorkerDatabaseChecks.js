import { NEIGHBORHOOD_STOCK_WHOLE_ACCOUNT_BATCH_V2_SQL as BATCH_PACKET } from '../../src/services/neighborhoodAssessment/neighborhoodStockWholeAccountBatchV2.js';
import { CUSTOM_NEIGHBORHOOD_WITNESS2_SOURCE_RIGHTS_KEY as SOURCE_RIGHTS } from '../../src/security/customNeighborhoodWitness2SourcePolicy.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { runNeighborhoodCoveredSelectedEvidenceV2DatabaseChecks } from './neighborhoodCoveredSelectedEvidenceV2DatabaseChecks.js';
import { observeNeighborhoodFirstSourceResolutionRowV3 } from './neighborhoodFirstSourceResolutionRowV3DatabaseChecks.js';
import { observeNeighborhoodFirstSourceCheckpointBeforeSaveV3,observeNeighborhoodFirstSourceCheckpointAfterSaveV3 }
  from './neighborhoodFirstSourceCheckpointV3DatabaseChecks.js';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortNeutralCacheV2ContinuationRepository as cacheClaims } from '../../src/services/neighborhoodAssessment/customCohortNeutralCacheV2ContinuationRepository.js';
import { createCustomCohortV2ContinuationRepository as mainClaims } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { runCustomCohortInitialV2JobOnce as runInitial } from '../../src/services/neighborhoodAssessment/customCohortInitialV2JobWorker.js';
import { runCustomCohortSourcePrefixV2JobOnce as runPrefix } from '../../src/services/neighborhoodAssessment/customCohortSourcePrefixV2JobWorker.js';
import { runCustomCohortV2EarlyJobOnce as runEarly } from '../../src/services/neighborhoodAssessment/customCohortV2EarlyJobWorker.js';
import { runCustomCohortNeutralCacheV2JobOnce as runCache } from '../../src/services/neighborhoodAssessment/customCohortNeutralCacheV2JobWorker.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL as SQL, NEIGHBORHOOD_SHARED_TYPED_CAD_SQL as CAD_SQL } from '../../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { NEIGHBORHOOD_FIRST_SELECTED_AMENITY_ORIGINAL_PACKAGE_V2_SQL as AMENITY_PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedAmenityOriginalPackageV2.js';
import { NEIGHBORHOOD_NATIVE_CAD_CACHE_COVERAGE_V2_SQL as CAD_COVERAGE }
  from '../../src/services/neighborhoodAssessment/neighborhoodCoveredCadCacheCoverageV2.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile }
  from '../../src/services/neighborhoodAssessment/neighborhoodFrozenTypedCadImprovementV1.js';
import { createCustomCohortCacheStockV2BridgeRepository as bridgeClaims } from '../../src/services/neighborhoodAssessment/customCohortCacheStockV2BridgeRepository.js';
import { createCustomCohortCadCacheV2ContinuationRepository as cadClaims } from '../../src/services/neighborhoodAssessment/customCohortCadCacheV2ContinuationRepository.js';
import { runCustomCohortCadCacheV2JobOnce as runCad } from '../../src/services/neighborhoodAssessment/customCohortCadCacheV2JobWorker.js';
import { NEIGHBORHOOD_SCOPED_CAD_ORIGINAL_ACCOUNT_V2_SQL as CAD_PACKET } from '../../src/services/neighborhoodAssessment/neighborhoodScopedCadOriginalAccountV2.js';
import { CUSTOM_NEIGHBORHOOD_CAD_IMPROVEMENT_SOURCE_RIGHTS_KEY as CAD_RIGHTS } from '../../src/security/customNeighborhoodCadImprovementSourcePolicy.js';
import { runCustomCohortCacheStockV2JobOnce as runBridge } from '../../src/services/neighborhoodAssessment/customCohortCacheStockV2JobWorker.js';
import { runCustomCohortCoveredStockV2JobOnce as runStock } from '../../src/services/neighborhoodAssessment/customCohortCoveredStockV2JobWorker.js';
import { runCustomCohortCacheStockBatchV3JobOnce as runBatchBridge } from '../../src/services/neighborhoodAssessment/customCohortCacheStockBatchV3JobWorker.js';
import { runCustomCohortStockBatchV3JobOnce as runBatchStock } from '../../src/services/neighborhoodAssessment/customCohortStockBatchV3JobWorker.js';
import { createCustomCohortStockBatchV3WorkerRepository as batchStockClaims } from '../../src/services/neighborhoodAssessment/customCohortStockBatchV3WorkerRepository.js';
import { runCustomCohortPartitionBatchV3JobOnce as runBatchPartition } from '../../src/services/neighborhoodAssessment/customCohortPartitionBatchV3JobWorker.js';
import { createCustomCohortPartitionBatchV3WorkerRepository as batchPartitionClaims } from '../../src/services/neighborhoodAssessment/customCohortPartitionBatchV3WorkerRepository.js';
import { runNeighborhoodCatalogBatchV3DatabaseChecks } from './neighborhoodCatalogBatchV3DatabaseChecks.js';
import { createCustomCohortCoveredStockV2WorkerRepository as stockClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredStockV2WorkerRepository.js';
import { runCustomCohortCoveredPartitionV2JobOnce as runPartition } from '../../src/services/neighborhoodAssessment/customCohortCoveredPartitionV2JobWorker.js';
import { createCustomCohortCoveredPartitionV2WorkerRepository as partitionClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredPartitionV2WorkerRepository.js';
import { runCustomCohortCoveredCatalogV2JobOnce as runCatalog } from '../../src/services/neighborhoodAssessment/customCohortCoveredCatalogV2JobWorker.js';
import { createCustomCohortCoveredCatalogV2WorkerRepository as catalogClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredCatalogV2WorkerRepository.js';
import { runCustomCohortCoveredSelectionWaitV2JobOnce as runWait } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectionWaitV2JobWorker.js';
import { createCustomCohortCoveredSelectionWaitV2WorkerRepository as waitClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectionWaitV2WorkerRepository.js';
import { runCustomCohortCoveredSelectedInitialV2JobOnce as runSelectedInitial } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2JobWorker.js';
import { createCustomCohortCoveredSelectedInitialV2WorkerRepository as selectedInitialClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedInitialV2WorkerRepository.js';
import { runCustomCohortCoveredSelectedProgressV2JobOnce as runSelectedProgress } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectedProgressV2JobWorker.js';
import { NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL as STOCK_PACKET,
  NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL as PAIRED_STOCK_PACKET,
  NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_ELIGIBILITY_PACKAGE_V2_SQL as ELIGIBILITY_PACKET } from '../../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';
import { NEIGHBORHOOD_FIRST_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL as COMPLETED_SOURCE_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_TRANSACTION_INDEX_ORIGINAL_PACKAGE_V2_SQL as TRANSACTION_INDEX_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL as SEMANTIC_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL as NUMERIC_PACKET,
  NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL as FIRST_NUMERIC_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as STATISTICS_PACKET,
  NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL as FIRST_STATISTICS_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as METRIC_PACKET,
  NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL as FIRST_METRIC_PACKET,
  NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as EVIDENCE_PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import { NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL as TRANSACTION_PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

/** Independent disposable job; all acquisition owners, authorization, original
 * queries, native issuance, savepoint rollback and COMMITs are real. */
export async function runNeighborhoodNeutralCacheV2WorkerDatabaseChecks({pool,input:sourceInput,scope,actor,authorizeMarketData,authorizeCadImprovementData,coveredTransactionIndexFixture=false,stockBatchFixture=false,partitionBatchFixture=false,catalogBatchFixture=false,catalogBatchReplayFixture=false,batchSelectionWaitFixture=false,batchSelectionIntentFixture=false,batchSelectedUnionFixture=false,batchSelectedWorkersFixture=false,batchRecordedEligibilityFixture=false,batchSelectedEvidenceFixture=false,batchSelectedMetricsFixture=false,batchSelectedStatisticsFixture=false,batchSelectedNumericFixture=false,batchSelectedSemanticFixture=false,batchSelectedTransactionIndexFixture=false,batchSelectedRecoveryFixture=false,batchSelectedProgressRecoveryFixture=false}){
  const batchFailureAttempt=(batchSelectedRecoveryFixture||batchSelectedProgressRecoveryFixture)?4:5,batchFailureCode=(batchSelectedRecoveryFixture||batchSelectedProgressRecoveryFixture)?'capture_failed':'access_revoked';
  const input={...sourceInput,operationId:randomUUID()},operation=input.operationId;let fault=null,stockReads=0,sourceCheckpointBefore=null;
  const observed={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
    const text=typeof c==='string'?c:c.text,originalPacket=text===COMPLETED_SOURCE_PACKET||text===BATCH_PACKET||text===STOCK_PACKET||text===PAIRED_STOCK_PACKET||text===TRANSACTION_PACKET||text===AMENITY_PACKET||(batchRecordedEligibilityFixture&&text===ELIGIBILITY_PACKET)||(batchSelectedEvidenceFixture&&text===EVIDENCE_PACKET)||(batchSelectedMetricsFixture&&[METRIC_PACKET,FIRST_METRIC_PACKET].includes(text))||(batchSelectedStatisticsFixture&&[STATISTICS_PACKET,FIRST_STATISTICS_PACKET].includes(text))||(batchSelectedNumericFixture&&[NUMERIC_PACKET,FIRST_NUMERIC_PACKET].includes(text))||(batchSelectedSemanticFixture&&text===SEMANTIC_PACKET)||(batchSelectedTransactionIndexFixture&&text===TRANSACTION_INDEX_PACKET),
      orphan=fault==='orphan'&&text.includes('custom-cohort-neutral-success-v2:yield')
      ||fault==='cad_orphan'&&text.includes('custom-cohort-CAD-success-v2:yield')
      ||fault==='bridge_orphan'&&text.includes('custom-cohort-cache-stock-v2:complete')
      ||fault==='partition_batch_orphan_row'&&text.includes('custom-cohort-recorded-partition-batch-v3:entry-insert')
      ||fault==='catalog_batch_orphan_group'&&text.includes('custom-cohort-recorded-catalog-batch-v3:contribute')
      ||fault==='batch_wait_orphan_release'&&text.includes('custom-cohort-batch-selection-wait-v3:release')
      ||fault==='batch_intent_orphan_resume'&&text.includes('custom-cohort-v2-selection-intent:resume')
      ||['partition_orphan','catalog_orphan','union_orphan','eligibility_orphan','evidence_orphan','metrics_orphan','statistics_orphan','numeric_orphan','semantic_orphan','transaction_index_orphan'].includes(fault)&&text.includes('custom-cohort-v2-continuation:yield');
    if(orphan)await raw.query('SAVEPOINT synthetic_neutral_yield');
    if(fault==='batch_wait_expiry'&&text.includes('custom-cohort-batch-selection-wait-v3:release')){
      fault=null;await raw.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    }
    if(fault==='cad_commit_expiry'&&text.includes('custom-cohort-CAD-success-v2:yield')){
      await raw.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()+interval '2 seconds' WHERE operation_id=$1",[operation]);
      fault='cad_commit_expiry_after_yield';
    }
    if(fault==='cad_commit_expiry_after_yield'&&text==='COMMIT'){fault=null;await raw.query('SELECT pg_sleep(2.1)');}
    if(fault==='wait_missing'&&text.includes('custom-cohort-group-workspace:read')){fault=null;
      await raw.query("DELETE FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id]);}
    if(fault==='partition_batch_skip'&&text.includes('custom-cohort-recorded-partition-batch-v3:entry-insert')){
      fault=null;return raw.query({...c,values:c.values.map((value,index)=>index===9?value+1:value)});
    }
    if(fault==='catalog_batch_skip'&&text.includes('custom-cohort-recorded-catalog-batch-v3:contribute')){
      fault=null;const selected='job.organization_id,$9,$10,$11,1,$12::integer';
      assert.equal(text.split(selected).length,2);
      return raw.query({...c,text:text.replace(selected,'job.organization_id,$9,$10,$11,1,($12::integer+1)')});
    }
    const result=await raw.query(c);
    if(fault==='source_checkpoint_observe'&&text.includes('custom-cohort-source-resolution-parent-v3:head-insert */')){
      sourceCheckpointBefore=await observeNeighborhoodFirstSourceCheckpointBeforeSaveV3({raw,result,scope});
    }
    if(fault==='source_checkpoint_observe'&&text.includes('custom-cohort-source-resolution-parent-v3:checkpoint-save */')){
      assert.ok(sourceCheckpointBefore);await observeNeighborhoodFirstSourceCheckpointAfterSaveV3({raw,result,scope,before:sourceCheckpointBefore});
      sourceCheckpointBefore=null;fault=null;
    }
    if(fault==='source_resolution_observe'&&text.includes('custom-cohort-source-resolution-parent-v3:head-insert */')){
      await observeNeighborhoodFirstSourceResolutionRowV3({raw,result,scope,
        expectedOrdinal:batchSelectedTransactionIndexFixture==='later-first-source'?2:1});
      fault=null;
    }
    if(fault==='catalog_replay_entry'&&text.includes('custom-cohort-recorded-partition-batch-v3:entry-read'))fault+='_ending';
    else if(fault==='catalog_replay_entry_ending'&&text.includes('custom-cohort-recorded-partition-batch-v3:entry-read')){
      fault=null;return {...result,rows:[{...result.rows[0],ordinal:result.rows[0].ordinal+1}]};
    }
    if(fault==='catalog_replay_group'&&text.includes('custom-cohort-recorded-catalog-batch-v3:group-read'))fault+='_ending';
    else if(fault==='catalog_replay_group_ending'&&text.includes('custom-cohort-recorded-catalog-batch-v3:group-read')){
      fault=null;return {...result,rows:[{...result.rows[0],normalized_label:'changed '+result.rows[0].normalized_label.slice(8)}]};
    }
    if(fault==='catalog_replay_counts'&&text.includes('custom-cohort-recorded-catalog-batch-v3:counts'))fault+='_ending';
    else if(fault==='catalog_replay_counts_ending'&&text.includes('custom-cohort-recorded-catalog-batch-v3:counts')){
      fault=null;return {...result,rows:[{...result.rows[0],assigned_accounts:result.rows[0].assigned_accounts+1}]};
    }
    if(['catalog_batch_entry','catalog_batch_counts'].includes(fault)&&text.includes('custom-cohort-recorded-catalog-batch-v3:anchor-insert'))fault+='_ending';
    if(fault==='catalog_batch_entry_ending'&&text.includes('custom-cohort-recorded-partition-batch-v3:entry-read')){
      fault=null;return {...result,rows:[{...result.rows[0],ordinal:result.rows[0].ordinal+1}]};
    }
    if(fault==='catalog_batch_counts_ending'&&text.includes('custom-cohort-recorded-catalog-batch-v3:counts')){
      fault=null;return {...result,rows:[{...result.rows[0],assigned_accounts:result.rows[0].assigned_accounts+1}]};
    }
    if((text===COMPLETED_SOURCE_PACKET||text===AMENITY_PACKET||batchSelectedEvidenceFixture&&text===EVIDENCE_PACKET||batchSelectedMetricsFixture&&[METRIC_PACKET,FIRST_METRIC_PACKET].includes(text)||batchSelectedStatisticsFixture&&[STATISTICS_PACKET,FIRST_STATISTICS_PACKET].includes(text)||batchSelectedNumericFixture&&[NUMERIC_PACKET,FIRST_NUMERIC_PACKET].includes(text))&&['selected_CAD_header','selected_CAD_coverage'].includes(fault))fault+='_ending';
    if(text===CAD_SQL.read&&fault==='selected_CAD_header_ending'){fault=null;
      return {...result,rows:[{...result.rows[0],binding_sha256:'0'.repeat(64)}]};}
    if(text===CAD_COVERAGE&&fault==='selected_CAD_coverage_ending'){fault=null;
      return {...result,rows:[{...result.rows[0],sequence:result.rows[0].sequence+1}]};}
    if(fault==='cad_role'&&text===CAD_PACKET){fault=null;
      await raw.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);}
    if((fault==='cad_deny'&&text===CAD_PACKET)||(fault==='selected_CAD_deny'&&(text===COMPLETED_SOURCE_PACKET||text===AMENITY_PACKET||batchSelectedEvidenceFixture&&text===EVIDENCE_PACKET||batchSelectedMetricsFixture&&[METRIC_PACKET,FIRST_METRIC_PACKET].includes(text)||batchSelectedStatisticsFixture&&[STATISTICS_PACKET,FIRST_STATISTICS_PACKET].includes(text)||batchSelectedNumericFixture&&[NUMERIC_PACKET,FIRST_NUMERIC_PACKET].includes(text)))){fault=null;
      await raw.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text,'revoked_at'],
        to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=$1`,[scope.organization_id,CAD_RIGHTS]);}
    if(text===BATCH_PACKET&&fault==='batch_rights'||originalPacket&&fault==='catalog_replay_rights'){fault=null;
      await raw.query(`UPDATE app_auth.organizations SET metadata=jsonb_set(metadata,ARRAY[$2::text,'revoked_at'],
        to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))) WHERE id=$1`,[scope.organization_id,SOURCE_RIGHTS]);}
    if(text===COMPLETED_SOURCE_PACKET&&fault==='completed_source_cache'||text===BATCH_PACKET&&fault==='batch_cache'||text===PAIRED_STOCK_PACKET&&fault==='union_cache'||batchRecordedEligibilityFixture&&text===ELIGIBILITY_PACKET&&fault==='eligibility_cache'||batchSelectedEvidenceFixture&&text===EVIDENCE_PACKET&&fault==='evidence_cache'||batchSelectedMetricsFixture&&text===METRIC_PACKET&&fault==='metrics_cache'||batchSelectedStatisticsFixture&&text===STATISTICS_PACKET&&fault==='statistics_cache'||batchSelectedNumericFixture&&text===NUMERIC_PACKET&&fault==='numeric_cache'||batchSelectedSemanticFixture&&text===SEMANTIC_PACKET&&fault==='semantic_cache'||batchSelectedTransactionIndexFixture&&text===TRANSACTION_INDEX_PACKET&&fault==='transaction_index_cache'){
      if(fault==='completed_source_cache'||fault==='union_cache'||fault==='eligibility_cache'||fault==='evidence_cache'||fault==='metrics_cache'||fault==='statistics_cache'||fault==='numeric_cache'||fault==='semantic_cache'||fault==='transaction_index_cache')stockReads++;fault=null;
      const envelope=JSON.parse(result.rows[0].page_json);envelope[0].typed.original.payload_utf8_bytes++;
      return {...result,rows:[{...result.rows[0],page_json:JSON.stringify(envelope)}]};}
    if(originalPacket)stockReads++;
    if(orphan){fault=null;await raw.query('ROLLBACK TO SAVEPOINT synthetic_neutral_yield');await raw.query('RELEASE SAVEPOINT synthetic_neutral_yield');}
    if(['batch_workspace','wait_workspace','intent_workspace','union_workspace','transaction_workspace','selected_CAD_workspace'].includes(fault)&&originalPacket){fault=null;await raw.query(`UPDATE app.custom_appraisal_workfile_sections
      SET section_value=jsonb_set(section_value,'{pending_capture,operation_id}',to_jsonb($2::text))
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`,[scope.assignment_file_id,randomUUID()]);}
    if(fault==='role'&&text===SQL.insert||['batch_role','bridge_role','partition_role','catalog_role','wait_role','intent_role','union_role','transaction_role','selected_CAD_role'].includes(fault)&&originalPacket){fault=null;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);}
    if(['completed_source_ack','batch_ack','ack','cad_ack','bridge_ack','partition_ack','catalog_ack','wait_ack','intent_ack','union_ack','eligibility_ack','evidence_ack','metrics_ack','statistics_ack','numeric_ack','semantic_ack','transaction_index_ack','transaction_ack','selected_CAD_ack'].includes(fault)&&text==='COMMIT'){fault=null;throw Error('lost actual original owner COMMIT ACK');}
    return result;
  }};}},service=createCustomCohortContextCapture({pool:observed,sourceMode:'combined-witness2-v1',authorizeMarketData,authorizeCadImprovementData}),
    args={pool,cohortService:service,leaseSeconds:900},job=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0],
    cacheState=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs WHERE operation_id=$1',[operation])).rows[0],
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    parent=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=$1',[operation])).rows[0],
    protectedRows=async()=>({report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
      assignment:(await pool.query('SELECT to_jsonb(a) AS body FROM app.assignment_files a WHERE id=$1',[scope.assignment_file_id])).rows});
  let protectedBefore=await protectedRows();
  await service.queueFrozenOriginalCaptureJobV2(input);
  assert.equal((await runInitial(args)).status,'continuation_pending');
  let prefixSteps=0;for(let i=0;i<12;i++){const r=await runPrefix(args);if(r.status==='idle')break;assert.equal(r.status,'continuation_pending');prefixSteps++;}
  let earlySteps=0;for(let i=0;i<100;i++){const r=await runEarly(args);if(r.status==='idle')break;assert.equal(r.status,'continuation_pending');earlySteps++;}
  const identity=await job();assert.equal(identity.checkpoint.phase,'frozen_identity_refs_v2');assert.equal(identity.attempts,1);
  const parentBefore=await parent();assert.equal(parentBefore.consumed_claim_token,null);
  await assert.rejects(tx(pool,client=>mainClaims(client).claimDue({limit:1,leaseSeconds:900})),
    error=>error.code==='55000'&&/neutral_success_v2_claim_conflict/.test(error.message));
  assert.deepEqual(await parent(),parentBefore,'generic main continuation cannot steal native identity DONE');
  const pin=(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows;
  assert.equal(pin.length,1);assert.equal(await cacheState(),undefined);
  const claimed=(await Promise.all([1,2].map(()=>tx(pool,client=>cacheClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(claimed.length,1);const first=claimed[0].claim;
  assert.equal(first.attempts,1);assert.equal((await parent()).sequence,parentBefore.sequence);
  const initialState=await cacheState(),initialJob=await job();assert.equal(initialState.sequence,0);
  const manualCad=createCustomCohortContextCapture({pool:observed,sourceMode:'combined-witness2-v1',authorizeMarketData,
    authorizeCadImprovementData:async()=>assert.fail('an automatic job must refuse before any separate CAD policy/original read')});
  await assert.rejects(manualCad.cacheOriginalFrozenCaptureJobCadAccountReferencesV2(input,
    {captureJobClaim:first,cadAccountPackagePage:{cursor:''}}),/CAD_automatic_handoff_unavailable/);
  await assert.rejects(manualCad.continueOriginalFrozenCaptureJobCadCacheCoverageReferencesV2(input,
    {captureJobClaim:first}),/CAD_automatic_handoff_unavailable/);
  await assert.rejects(manualCad.readCoveredOriginalFrozenCaptureJobFirstCadAmenityEvidenceReferencesV2(input,
    {captureJobClaim:first}),/CAD_automatic_handoff_unavailable/);
  assert.deepEqual(await cacheState(),initialState);assert.deepEqual(await job(),initialJob);
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query(`UPDATE app.neighborhood_custom_cohort_neutral_success_v2_jobs
      SET consumed_claim_token=gen_random_uuid(),consumed_attempts=2 WHERE operation_id=$1`,[operation]);
  }),error=>error.code==='55000'&&/neutral_success_v2_commit_conflict/.test(error.message));
  assert.deepEqual(await cacheState(),initialState);assert.deepEqual(await job(),initialJob,'orphan real native claim cannot COMMIT');
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()+interval '900 seconds' WHERE operation_id=$1",[operation]);
  }),error=>error.code==='55000'&&/neutral_success_v2_claim_conflict/.test(error.message));
  assert.deepEqual(await job(),initialJob);
  fault='orphan';await assert.rejects(service.continueFrozenCaptureJobNeutralOriginalsReferencesV2(input,{captureJobClaim:first}),
    error=>error.outcome_unknown===true&&error.code==='55000');
  assert.equal(fault,null);assert.equal(await head(),undefined);assert.deepEqual(await cacheState(),initialState);
  await tx(pool,client=>jobs(client).failClaim(first,'capture_failed',{retrySeconds:1}));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  fault='ack';assert.equal((await runCache(args)).status,'outcome_unknown');
  assert.equal(fault,null);assert.equal((await cacheState()).sequence,1);assert.equal((await job()).attempts,2);
  const firstHead=await head();
  assert.deepEqual(await tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900})),[],
    'an actual unfinished native cache cannot enroll the first stock owner');
  fault='role';const denied=await runCache(args);assert.equal(denied.reason,'access_revoked');assert.equal(fault,null);
  assert.deepEqual(await head(),firstHead,'ending role refusal rolls actual cache/head progress back');
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  let successes=0;for(let i=0;i<50;i++){const r=await runCache(args);if(r.status==='idle')break;assert.equal(r.status,'continuation_pending');successes++;}
  const done=await job(),complete=await cacheState(),nativeHead=await head();
  assert.equal(done.attempts,3);assert.equal(done.last_error_code,'access_revoked');assert.equal(done.context_sha256,null);
  assert.equal(done.status,'retry');assert.equal(done.claim_token,null);assert.equal(complete.sequence,7);
  assert.equal(successes,6);assert.equal(nativeHead.sequence,7);assert.equal((await parent()).sequence,parentBefore.sequence);
  assert.equal((await parent()).consumed_claim_token,initialState.initial_claim_token);
  const completedJob=await job();assert.deepEqual(await runCache(args),{status:'idle'});assert.deepEqual(await job(),completedJob);
  await assert.rejects(tx(pool,client=>client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs SET status='running',claim_token=$2,
    lease_expires_at=clock_timestamp()+interval '900 seconds' WHERE operation_id=$1`,[operation,first.claim_token])),
  error=>error.code==='55000'&&/neutral_success_v2_claim_conflict/.test(error.message));
  const stockHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=$1',[operation])).rows[0],
    bridgeState=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges WHERE operation_id=$1',[operation])).rows[0];
  assert.equal(await stockHead(),undefined);assert.equal(await bridgeState(),undefined);
  assert.deepEqual(await tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900})),[],
    'neutral DONE alone cannot adopt stock before independent CAD DONE');
  const cadState=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_success_v2_jobs WHERE operation_id=$1',[operation])).rows[0],
    cadHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1',[operation])).rows[0];
  const firstCadRows=(await Promise.all([1,2].map(()=>tx(pool,client=>cadClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(firstCadRows.length,1);const firstCad=firstCadRows[0].claim;
  assert.equal(firstCad.attempts,3);assert.notEqual(firstCad.claim_token,complete.issued_claim_token);
  const initialCad=await cadState(),cadJob=await job();assert.equal(initialCad.sequence,0);assert.equal(await cadHead(),undefined);
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query('UPDATE app.neighborhood_custom_cohort_cad_success_v2_jobs SET consumed_claim_token=gen_random_uuid(),consumed_attempts=4 WHERE operation_id=$1',[operation]);
  }),e=>e.code==='55000'&&/cad_success_v2_commit_conflict/.test(e.message));
  assert.deepEqual(await cadState(),initialCad);assert.deepEqual(await job(),cadJob);
  for(const [mode,reason] of [['cad_orphan',e=>e.outcome_unknown===true&&e.code==='55000'],
    ['cad_role',/job_actor_access_revoked/],['cad_deny',/market_data_access_denied/],
    ['cad_commit_expiry',e=>e.outcome_unknown===true&&e.code==='55000']]){
    fault=mode;await assert.rejects(service.continueFrozenCaptureJobCadOriginalsReferencesV2(input,{captureJobClaim:firstCad}),reason);
    assert.equal(fault,null);assert.equal(await cadHead(),undefined);assert.deepEqual(await cadState(),initialCad);
    assert.deepEqual(await job(),cadJob);assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  }
  fault='cad_ack';await assert.rejects(service.continueFrozenCaptureJobCadOriginalsReferencesV2(input,{captureJobClaim:firstCad}),e=>e.outcome_unknown===true);
  assert.equal(fault,null);assert.equal((await cadState()).sequence,1);assert.equal((await job()).attempts,3);
  assert.deepEqual(await tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900})),[],'partial CAD cannot adopt stock');
  await assert.rejects(service.continueFrozenCaptureJobCadOriginalsReferencesV2(input,{captureJobClaim:firstCad}),/claim_lost/);
  for(let i=0;i<2;i++)assert.equal((await runCad(args)).status,'continuation_pending');
  const completedCad=await cadState(),completedCadHead=await cadHead(),completedCadJob=await job();
  assert.equal(completedCad.sequence,3);assert.equal(completedCadHead.sequence,3);assert.equal(completedCad.consumed_claim_token,null);
  const cadBody=JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
    [scope.organization_id,completedCad.receipt_reference.content_sha256])).rows[0].canonical_utf8);
  assert.equal(cadBody.after.done,true);assert.equal(cadBody.after.account_count,2);assert.equal(cadBody.after.original_count,5);
  assert.equal(completedCadJob.attempts,3);assert.equal(completedCadJob.last_error_code,'access_revoked');
  assert.deepEqual(completedCadJob.checkpoint,completedJob.checkpoint);assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  assert.deepEqual(await runCad(args),{status:'idle'});assert.deepEqual(await job(),completedCadJob);
  console.info('[native-automatic-CAD-cache-success-handoff-v2]',{actual_accounts:2,actual_originals:5,
    neutral_DONE_missing_or_partial_CAD_cannot_adopt_stock:true,concurrent_single_fresh_claim:true,
    every_original_and_entire_cache_current_and_ending_CAD_actor_fences:true,orphan_claim_and_yield_refused:true,
    actual_COMMIT_after_saved_lease_deadline_refused:true,lost_real_COMMIT_ACK_fresh_next_account:true,
    separate_terminal_EMPTY_and_DONE_idle:true,success_preserves_failure_attempt:3,neutral_and_main_parent_unchanged:true,
    automatic_schedule:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  let batchPendingWorkspace=null;
  if(stockBatchFixture){
    // This NEW disposable graph installs its candidate guard only here. The
    // production registry and all seventeen historical scenarios stay intact.
    await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodStockBatchV3Guard.sql',import.meta.url),'utf8')));
    if(partitionBatchFixture)await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodPartitionBatchV3Guard.sql',import.meta.url),'utf8')));
    if(catalogBatchFixture)await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodCatalogBatchV3Guard.sql',import.meta.url),'utf8')));
    if(batchSelectionWaitFixture)await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodBatchSelectionWaitV3Guard.sql',import.meta.url),'utf8')));
    if(batchSelectionIntentFixture)await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodBatchSelectionIntentV3Guard.sql',import.meta.url),'utf8')));
    if(batchSelectedUnionFixture)await tx(pool,client=>client.query(readFileSync(new URL('../fixtures/neighborhoodBatchSelectedUnionV3Guard.sql',import.meta.url),'utf8')));
    assert.deepEqual((await pool.query("SELECT revision FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,[]);
    const started=await service.startRecordedGroupCapture({auth:input.auth,accountId:input.accountId,assignmentFileId:input.assignmentFileId,
      expectedWorkspaceRevision:0,expectedWorkspaceCheckpoint:{workspace_version:7,active:null,pending_capture:null},
      pendingCapture:{operation_id:operation,observation_period:input.observationPeriod,discovery:input.discovery}});
    assert.equal(started.status,'stored');
    batchPendingWorkspace=(await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows;
    assert.equal(batchPendingWorkspace[0].revision,1);
    const afterExplicitPending=await protectedRows(),assignmentBeforeStamp=structuredClone(afterExplicitPending.assignment);
    assert.deepEqual(afterExplicitPending.report,protectedBefore.report);
    assignmentBeforeStamp[0].body.updated_at=protectedBefore.assignment[0].body.updated_at;
    assert.deepEqual(assignmentBeforeStamp,protectedBefore.assignment,'only the explicit pending command timestamp may change');
    protectedBefore=afterExplicitPending;
  }
  const stockContinuation=stockBatchFixture?'continueCoveredOriginalFrozenCaptureJobStockBatchReferencesV3':'continueCoveredOriginalFrozenCaptureJobStockTraversalReferencesV2',
    bridgeWorker=stockBatchFixture?runBatchBridge:runBridge;
  const adopted=(await Promise.all([1,2].map(()=>tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(adopted.length,1);const adoptedClaim=adopted[0].claim;
  assert.equal(adoptedClaim.attempts,3);assert.notEqual(adoptedClaim.claim_token,complete.issued_claim_token);
  assert.deepEqual((await bridgeState()).cad_reference,completedCad.receipt_reference);assert.notEqual(adoptedClaim.claim_token,completedCad.issued_claim_token);
  assert.notEqual(adoptedClaim.claim_token,complete.initial_claim_token);assert.equal((await parent()).sequence,parentBefore.sequence);
  const adoptedState=await bridgeState(),adoptedJob=await job(),adoptedParent=await parent();
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query('UPDATE app.neighborhood_custom_cohort_cache_stock_v2_bridges SET claim_token=gen_random_uuid(),attempts=4 WHERE operation_id=$1',[operation]);
  }),error=>error.code==='55000'&&/cache_stock_v2_commit_conflict/.test(error.message));
  assert.deepEqual(await job(),adoptedJob);assert.deepEqual(await bridgeState(),adoptedState);
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()+interval '900 seconds' WHERE operation_id=$1",[operation]);
  }),error=>error.code==='55000'&&/neutral_success_v2_claim_conflict/.test(error.message));
  assert.deepEqual(await job(),adoptedJob);
  if(stockBatchFixture){
    const beforeBlobs=(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows;
    for(const [mode,reason] of [['wait_missing',/custom_cohort_group_workspace_unavailable/],
      ['batch_workspace',/custom_cohort_group_workspace_study_changed/],['batch_rights',/market_data_access_denied|market_policy_changed/],
      ['batch_role',/custom_cohort_job_actor_access_revoked/],['batch_cache',/original_mismatch/]]){
      fault=mode;await assert.rejects(service[stockContinuation](input,{captureJobClaim:adoptedClaim}),reason);assert.equal(fault,null);
      if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
      assert.equal(await stockHead(),undefined);assert.deepEqual(await job(),adoptedJob);assert.deepEqual(await parent(),adoptedParent);
      assert.deepEqual(await bridgeState(),adoptedState);assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
      assert.deepEqual(await cadState(),completedCad);assert.deepEqual(await cadHead(),completedCadHead);
      assert.deepEqual((await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,batchPendingWorkspace);
      assert.deepEqual((await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows,beforeBlobs);
    }
  }
  fault='bridge_orphan';await assert.rejects(service[stockContinuation](input,{captureJobClaim:adoptedClaim}),
    error=>error.outcome_unknown===true&&error.code==='55000');
  assert.equal(fault,null);assert.equal(await stockHead(),undefined);assert.deepEqual(await parent(),adoptedParent);
  assert.equal((await parent()).sequence,parentBefore.sequence);assert.deepEqual(await bridgeState(),adoptedState);
  await tx(pool,client=>jobs(client).failClaim(adoptedClaim,'capture_failed',{retrySeconds:1}));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  // Only the independent recovery graphs reserve this failure for a selected
  // initial or progress worker. Older graphs keep the bridge role failure.
  if(!batchSelectedRecoveryFixture&&!batchSelectedProgressRecoveryFixture){
  fault='bridge_role';assert.equal((await bridgeWorker(args)).reason,'access_revoked');assert.equal(fault,null);
  assert.equal(await stockHead(),undefined);assert.equal((await job()).attempts,4);
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  }
  fault='bridge_ack';assert.equal((await bridgeWorker(args)).status,'outcome_unknown');assert.equal(fault,null);
  const firstStock=await stockHead(),issuedBridge=await bridgeState();
  assert.equal(firstStock.sequence,1);assert.deepEqual(issuedBridge.completed_reference,firstStock.receipt_reference);
  assert.equal((await parent()).sequence,parentBefore.sequence+1);assert.equal((await parent()).phase,'frozen_stock_traversal_refs_v2');
  assert.equal((await job()).attempts,batchFailureAttempt);assert.equal((await job()).last_error_code,batchFailureCode);
  assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  assert.deepEqual(await runBridge(args),{status:'idle'});assert.deepEqual(await runCache(args),{status:'idle'});
  if(stockBatchFixture){
    const readBody=async reference=>JSON.parse((await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,reference.content_sha256])).rows[0].canonical_utf8),firstBody=await readBody(firstStock.receipt_reference),firstBatchJob=await job();
    assert.equal(firstBody.format,'cohort_stock_traversal_batch_receipt_v3');assert.equal(firstBody.sequence,1);
    assert.deepEqual(firstBody.accounts.map(a=>a.account_id),['CLOSURE-A','CLOSURE-B']);
    assert.equal(firstBody.accounts[0].original_counts.parcels,2,'whole outside part is included');
    assert.equal(firstBody.original_count,5);assert.deepEqual(firstBody.after,{after_account:'CLOSURE-B',account_count:2,done:false});
    assert.deepEqual(firstStock.issued_transaction_id,issuedBridge.completed_transaction_id);
    assert.equal(firstBatchJob.checkpoint.evidence_refs.length,7);assert.deepEqual(firstBatchJob.checkpoint.evidence_refs[6],firstStock.receipt_reference);
    assert.deepEqual(await runStock(args),{status:'idle'},'legacy V2 worker must not reinterpret V3 or convert a full count to DONE');
    assert.deepEqual(await job(),firstBatchJob);
    let batchOwnerCalls=0,batchOwnerError;
    const emptyArgs={...args,cohortService:{async [stockContinuation](value,options){
      try{
      batchOwnerCalls++;assert.equal(options.captureJobClaim.attempts,batchFailureAttempt);
      const beforeEmpty=await job(),beforeContinuation=await parent();
      // Deliberately forged metadata probes use this real live native claim.
      // Every rejected transaction rolls back its forged blob and head DML.
      const empty={...firstBody,sequence:2,previous:firstStock.receipt_reference,before:firstBody.after,
        after:{...firstBody.after,done:true},accounts:[],original_count:0};
      const wrongKey={...empty,accounts:[firstBody.accounts[1]],original_count:2,
        after:{after_account:'CLOSURE-B',account_count:3,done:false}},
        falseEmpty={...empty,after:{...empty.after,done:false}},
        wrongBefore={...empty,before:{...empty.before,account_count:1}},
        legacy={...empty,format:'cohort_stock_traversal_receipt_v2'};
      delete legacy.accounts;delete legacy.original_count;
      for(const [body,reason] of [[wrongKey,/stock_batch_v3_prefix_conflict/],[falseEmpty,/stock_batch_v3_prefix_conflict/],
        [wrongBefore,/stock_traversal_v2_anchor_transition_conflict/],[legacy,/stock_batch_v3_format_conflict/]]){
        await assert.rejects(tx(pool,async client=>{
          const reference=await createNeighborhoodCohortBlobRepository(client,scope.organization_id).put(canonicalAssessmentJson(body));
          await client.query(`UPDATE app.neighborhood_custom_cohort_stock_traversal_v2_anchors SET receipt_reference=$2::jsonb,sequence=2
            WHERE operation_id=$1 AND receipt_reference=$3::jsonb`,[operation,canonicalAssessmentJson(reference),canonicalAssessmentJson(firstStock.receipt_reference)]);
        }),error=>error.code==='55000'&&reason.test(error.message));
        assert.deepEqual(await stockHead(),firstStock);assert.deepEqual(await job(),beforeEmpty);assert.deepEqual(await parent(),beforeContinuation);
      }
      return await service[stockContinuation](value,options);
      }catch(error){batchOwnerError=error;throw error;}
    }}};
    const emptyResult=await runBatchStock(emptyArgs);if(batchOwnerError)throw batchOwnerError;
    assert.equal(emptyResult.status,'continuation_pending');assert.equal(batchOwnerCalls,1);
    const finalHead=await stockHead(),finalBody=await readBody(finalHead.receipt_reference),finalJob=await job(),finalParent=await parent();
    assert.equal(finalHead.sequence,2);assert.equal(finalBody.sequence,2);assert.deepEqual(finalBody.before,firstBody.after);
    assert.deepEqual(finalBody.accounts,[]);assert.equal(finalBody.original_count,0);assert.equal(finalBody.after.done,true);assert.equal(finalBody.after.account_count,2);
    assert.deepEqual(finalBody.previous,firstStock.receipt_reference);assert.equal(finalParent.sequence,parentBefore.sequence+2);
    assert.equal(finalJob.attempts,batchFailureAttempt);assert.equal(finalJob.last_error_code,batchFailureCode);assert.equal(finalJob.context_sha256,null);
    for(const worker of [runBatchStock,runStock,runBatchBridge,runBridge,runCache,runCad])assert.deepEqual(await worker(args),{status:'idle'});
    assert.deepEqual(await job(),finalJob);
    if(partitionBatchFixture){
      const partitionHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=$1',[operation])).rows[0],
        partitionRows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows;
      const adoption=(await Promise.all([1,2].map(()=>tx(pool,client=>batchPartitionClaims(client).claimDue({leaseSeconds:900}))))).flat();
      assert.equal(adoption.length,1);const owned=adoption[0],method='continueCoveredOriginalFrozenCaptureJobRecordedPartitionBatchReferencesV3';
      assert.equal(owned.claim.attempts,batchFailureAttempt);assert.equal(owned.progress_done,true);
      const ownedJob=await job(),ownedParent=await parent(),ownedBlobs=(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows,
        packet=await service.readCoveredFrozenCaptureJobWholeAccountBatchReferencesV2(input,
        {captureJobClaim:owned.claim,stockAccountPackagePage:{cursor:''}});
      assert.equal(packet.account_count,2);assert.deepEqual(await job(),ownedJob);assert.deepEqual(await parent(),ownedParent);
      for(const [mode,reason] of [['batch_workspace',/custom_cohort_group_workspace_study_changed/],
        ['batch_rights',/market_data_access_denied|market_policy_changed/],['batch_role',/custom_cohort_job_actor_access_revoked/],
        ['batch_cache',/original_mismatch/],['partition_batch_skip',/recorded_partition_v2_prefix_conflict/],
        ['partition_batch_orphan_row',/partition_batch_v3_entry_conflict/],
        ['partition_orphan',error=>error.outcome_unknown===true&&error.code==='55000']]){
        fault=mode;await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),reason);assert.equal(fault,null);
        if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
        assert.equal(await partitionHead(),undefined);assert.deepEqual(await partitionRows(),[]);
        assert.deepEqual(await job(),ownedJob);assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await stockHead(),finalHead);
        assert.deepEqual((await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows,ownedBlobs);
        assert.deepEqual(await bridgeState(),issuedBridge);assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
        assert.deepEqual(await cadState(),completedCad);assert.deepEqual(await cadHead(),completedCadHead);assert.deepEqual(await protectedRows(),protectedBefore);
        assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
        assert.deepEqual((await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,batchPendingWorkspace);
      }
      fault='partition_ack';await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),error=>error.outcome_unknown===true);assert.equal(fault,null);
      const firstPartition=await partitionHead(),firstPartitionRows=await partitionRows(),firstPartitionBody=await readBody(firstPartition.receipt_reference);
      assert.equal(firstPartition.sequence,1);assert.equal(firstPartitionBody.after.account_count,2);assert.equal(firstPartitionBody.after.done,false);
      assert.equal(firstPartitionBody.original_count,5);assert.equal(firstPartitionRows.length,2);
      for(const [index,row] of firstPartitionRows.entries()){
        assert.equal(row.ordinal,index+1);assert.equal(row.account_id,packet.accounts[index].account_id);
        assert.deepEqual(await readBody(row.entry_reference),{format:'cohort_recorded_group_partition_entry_v2',account_id:row.account_id,
          ordinal:row.ordinal,recorded_group:packet.accounts[index].recorded_group});
        assert.deepEqual(firstPartitionBody.entries[index],{account_id:row.account_id,ordinal:row.ordinal,entry_reference:row.entry_reference,
          state:row.state,assigned_group_id:row.assigned_group_id});
      }
      assert.equal((await parent()).sequence,parentBefore.sequence+3);assert.equal((await job()).checkpoint.evidence_refs.length,8);
      assert.deepEqual((await job()).checkpoint.evidence_refs[7],firstPartition.receipt_reference);
      await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),/claim_lost/);
      const afterFirst=await job();assert.deepEqual(await runPartition(args),{status:'idle'});assert.deepEqual(await job(),afterFirst);
      fault='partition_ack';assert.equal((await runBatchPartition(args)).status,'outcome_unknown');assert.equal(fault,null);
      const terminalPartition=await partitionHead(),terminalBody=await readBody(terminalPartition.receipt_reference),terminalJob=await job();
      assert.equal(terminalPartition.sequence,2);assert.equal(terminalBody.after.done,true);assert.equal(terminalBody.after.account_count,2);
      assert.deepEqual(terminalBody.entries,[]);assert.deepEqual(terminalBody.accounts,[]);assert.equal(terminalBody.original_count,0);
      assert.deepEqual(terminalBody.previous,firstPartition.receipt_reference);assert.deepEqual(await partitionRows(),firstPartitionRows);
      assert.equal((await parent()).sequence,parentBefore.sequence+4);assert.equal(terminalJob.attempts,batchFailureAttempt);assert.equal(terminalJob.last_error_code,batchFailureCode);
      for(const worker of [runBatchStock,runStock,runBatchPartition,runPartition,runCatalog])assert.deepEqual(await worker(args),{status:'idle'});
      assert.deepEqual(await job(),terminalJob);
      if(catalogBatchFixture){
        await runNeighborhoodCatalogBatchV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,
          setFault:value=>{fault=value;},readFault:()=>fault,packet,readBody,stockHead,partitionHead,partitionRows,
          bridgeState,cacheState,head,cadState,cadHead,protectedRows,protectedBefore,pin,batchPendingWorkspace,
          catalogBatchReplayFixture,batchSelectionWaitFixture,batchSelectionIntentFixture,batchSelectedUnionFixture,batchSelectedWorkersFixture,batchRecordedEligibilityFixture,batchSelectedEvidenceFixture,batchSelectedMetricsFixture,batchSelectedStatisticsFixture,batchSelectedNumericFixture,batchSelectedSemanticFixture,batchSelectedTransactionIndexFixture,batchSelectedRecoveryFixture,batchSelectedProgressRecoveryFixture,originalReads:()=>stockReads});
        return;
      }
      const [next]=await tx(pool,client=>mainClaims(client).claimDue({limit:1,leaseSeconds:900}));assert.equal(next.claim.attempts,batchFailureAttempt);
      const nextJob=await job(),nextParent=await parent(),rollback=Error('rollback partition batch next-owner probe');
      await assert.rejects(tx(pool,async client=>{
        await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
        await jobs(client).cancel(scope,operation);
        const snapshot=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
        for(const repository of [batchStockClaims,stockClaims,batchPartitionClaims,partitionClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
        assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,snapshot);
        throw rollback;
      }),error=>error===rollback);
      assert.deepEqual(await job(),nextJob);assert.deepEqual(await parent(),nextParent);
      await tx(pool,client=>jobs(client).cancel(scope,operation));const cancelled=await job();
      assert.deepEqual(await runBatchPartition(args),{status:'idle'});assert.deepEqual(await job(),cancelled);
      assert.deepEqual(await stockHead(),finalHead);assert.deepEqual(await partitionHead(),terminalPartition);assert.deepEqual(await partitionRows(),firstPartitionRows);
      assert.deepEqual(await bridgeState(),issuedBridge);assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
      assert.deepEqual(await cadState(),completedCad);assert.deepEqual(await cadHead(),completedCadHead);assert.deepEqual(await protectedRows(),protectedBefore);
      assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
      assert.deepEqual((await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,batchPendingWorkspace);
      console.info('[native-whole-account-batch-partition-v3]',{independent_initial_source_native_parents_and_batch_stock_DONE:true,
        actual_whole_originals_ENTIRE_cache_and_ENTIRE_derived_entries_reconciled:true,one_shared_original_budget:true,
        two_rows_one_receipt_head_checkpoint_and_continuation_per_batch:true,first_receipt_sequence:1,separate_fresh_EMPTY_sequence:2,
        ending_workspace_source_actor_cache_and_native_skipped_ordinal_refused:true,orphan_row_and_orphan_yield_atomic_rollback:true,
        lost_real_nonempty_and_EMPTY_COMMIT_ACK:true,stale_claim_refused:true,legacy_workers_idle:true,
        actual_failure5_and_error_history_preserved:true,DONE_all_claim_recovery_expiry_lanes_excluded:true,
        original_parents_pins_workspace_reports_and_choices_unchanged:true,
        coherent_batch_catalog:false,production_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
      return;
    }
    // Generic explicit next-owner adoption is a disposable probe only. Both
    // stock formats must leave DONE untouched in success/recovery/expiry lanes.
    const [nextOwner]=await tx(pool,client=>mainClaims(client).claimDue({limit:1,leaseSeconds:900}));
    assert.equal(nextOwner.claim.attempts,batchFailureAttempt);const nextOwnedJob=await job(),nextOwnedParent=await parent();
    const rollback=Error('rollback batch native next-owner probe');
    await assert.rejects(tx(pool,async client=>{
      await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
      await jobs(client).cancel(scope,operation);
      const snapshot=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
      for(const repository of [batchStockClaims,stockClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
      assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,snapshot);
      throw rollback;
    }),error=>error===rollback);
    assert.deepEqual(await job(),nextOwnedJob);assert.deepEqual(await parent(),nextOwnedParent);
    await tx(pool,client=>jobs(client).cancel(scope,operation));const cancelled=await job();
    assert.deepEqual(await runBatchStock(args),{status:'idle'});assert.deepEqual(await job(),cancelled);
    assert.deepEqual(await stockHead(),finalHead);assert.deepEqual(await bridgeState(),issuedBridge);
    assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);assert.deepEqual(await cadState(),completedCad);assert.deepEqual(await cadHead(),completedCadHead);
    assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
    assert.deepEqual((await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,batchPendingWorkspace);
    assert.deepEqual(await protectedRows(),protectedBefore);
    console.info('[native-whole-account-batch-stock-v3]',{independent_initial_prefix_graph_geo_identity_neutral_and_CAD_parents:true,
      actual_whole_outside_originals_and_ENTIRE_cache_replayed:true,one_shared_original_budget:true,
      current_and_ending_actor_source_workspace_cache_refusal:true,orphan_real_COMMIT_refused:true,lost_real_first_batch_COMMIT_ACK:true,
      actual_batch_accounts:2,actual_batch_originals:5,first_receipt_sequence:1,terminal_EMPTY_receipt_sequence:2,
      native_wrong_prefix_before_false_EMPTY_and_format_switch_refused:true,legacy_worker_cannot_steal_or_complete_V3:true,
      separate_fresh_EMPTY_at_failure_ceiling5:true,unchanged_error_history_native_parents_workspace_reports_and_pins:true,
      DONE_success_recovery_expiry_and_cancelled_next_owner_excluded:true,
      batched_partition_catalog:false,production_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
    return;
  }
  for(let i=0;i<2;i++){
    const result=await runStock(args);assert.equal(result.status,'continuation_pending');assert.equal(result.operation_id,operation);
    assert.equal((await job()).attempts,batchFailureAttempt);assert.equal((await job()).last_error_code,batchFailureCode);
    const currentHead=await stockHead(),body=JSON.parse((await pool.query(
      'SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
      [scope.organization_id,currentHead.receipt_reference.content_sha256])).rows[0].canonical_utf8);
    assert.equal(body.after.done,i===1);
  }
  assert.equal((await stockHead()).sequence,3);assert.equal((await parent()).sequence,parentBefore.sequence+3);
  const terminalStock=await job();assert.deepEqual(await runStock(args),{status:'idle'});assert.deepEqual(await job(),terminalStock);
  const partitionHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    partitionRows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows;
  const partitionAdoption=(await Promise.all([1,2].map(()=>tx(pool,client=>partitionClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(partitionAdoption.length,1);const partitionClaim=partitionAdoption[0].claim;
  assert.equal(partitionClaim.attempts,batchFailureAttempt);assert.equal(partitionAdoption[0].progress_done,true);
  const partitionJob=await job(),partitionParent=await parent();
  fault='partition_role';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedPartitionReferencesV2(input,{captureJobClaim:partitionClaim}),
    /custom_cohort_job_actor_access_revoked/);assert.equal(fault,null);
  assert.equal(await partitionHead(),undefined);assert.deepEqual(await partitionRows(),[]);
  assert.deepEqual(await job(),partitionJob);assert.deepEqual(await parent(),partitionParent);
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  fault='partition_orphan';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedPartitionReferencesV2(input,{captureJobClaim:partitionClaim}),
    error=>error.outcome_unknown===true&&error.code==='55000');assert.equal(fault,null);
  assert.equal(await partitionHead(),undefined);assert.deepEqual(await partitionRows(),[]);
  assert.deepEqual(await job(),partitionJob);assert.deepEqual(await parent(),partitionParent);
  fault='partition_ack';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedPartitionReferencesV2(input,{captureJobClaim:partitionClaim}),
    error=>error.outcome_unknown===true);assert.equal(fault,null);
  assert.equal((await partitionHead()).sequence,1);assert.equal((await partitionRows()).length,1);
  assert.deepEqual(await tx(pool,client=>catalogClaims(client).claimDue({leaseSeconds:900})),[],
    'unfinished partition cannot enroll a covered catalog claim');
  for(let i=0;i<2;i++){
    assert.equal((await runPartition(args)).status,'continuation_pending');
    assert.equal((await job()).attempts,batchFailureAttempt);assert.equal((await job()).last_error_code,batchFailureCode);
  }
  assert.equal((await partitionHead()).sequence,3);assert.equal((await partitionRows()).length,2);
  assert.equal((await parent()).sequence,parentBefore.sequence+6);
  const terminalPartition=await job();assert.deepEqual(await runPartition(args),{status:'idle'});
  assert.deepEqual(await job(),terminalPartition);assert.deepEqual(await bridgeState(),issuedBridge);
  assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  const catalogAdoption=(await Promise.all([1,2].map(()=>tx(pool,client=>catalogClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(catalogAdoption.length,1);const nextOwner=catalogAdoption[0];assert.equal(nextOwner.claim.operation_id,operation);
  assert.equal(nextOwner.claim.attempts,batchFailureAttempt);assert.equal(nextOwner.progress_done,true);
  let partitionCursor='';const originals=[];
  for(let i=0;i<3;i++){
    const packet=await service.readCoveredOriginalFrozenCaptureJobRecordedPartitionAccountReferencesV2(input,
      {captureJobClaim:nextOwner.claim,stockAccountPackagePage:{cursor:partitionCursor}});
    assert.equal(packet.end_of_accounts,i===2);assert.equal(packet.original_reconciliation,'every_package_original_recompiled');
    if(packet.account_id!==null){
      const entry=(await partitionRows())[i],text=(await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
        [scope.organization_id,entry.entry_reference.content_sha256])).rows[0].canonical_utf8;
      assert.deepEqual(JSON.parse(text),{format:'cohort_recorded_group_partition_entry_v2',account_id:packet.account_id,ordinal:i+1,recorded_group:packet.recorded_group});
      originals.push(packet.account_id);
    }
    partitionCursor=packet.next_cursor;
  }
  assert.equal(new Set(originals).size,2);
  const catalogHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    catalogGroups=async()=>(await pool.query('SELECT group_id,normalized_county,normalized_label,member_count,last_ordinal FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=$1 ORDER BY group_id',[operation])).rows;
  const catalogJob=await job(),catalogParent=await parent(),completedPartitionHead=await partitionHead(),completedPartitionRows=await partitionRows();
  fault='catalog_role';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2(input,{captureJobClaim:nextOwner.claim}),
    /custom_cohort_job_actor_access_revoked/);assert.equal(fault,null);
  assert.equal(await catalogHead(),undefined);assert.deepEqual(await catalogGroups(),[]);
  assert.deepEqual(await job(),catalogJob);assert.deepEqual(await parent(),catalogParent);
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  fault='catalog_orphan';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2(input,{captureJobClaim:nextOwner.claim}),
    error=>error.outcome_unknown===true&&error.code==='55000');assert.equal(fault,null);
  assert.equal(await catalogHead(),undefined);assert.deepEqual(await catalogGroups(),[]);
  assert.deepEqual(await job(),catalogJob);assert.deepEqual(await parent(),catalogParent);
  fault='catalog_ack';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2(input,{captureJobClaim:nextOwner.claim}),
    error=>error.outcome_unknown===true);assert.equal(fault,null);assert.equal((await catalogHead()).sequence,1);
  const unfinishedCatalogJob=await job();
  assert.deepEqual(await tx(pool,client=>waitClaims(client).claimDue({leaseSeconds:900})),[]);
  assert.deepEqual(await job(),unfinishedCatalogJob,'an unfinished native catalog cannot enter selection-wait');
  for(let i=0;i<2;i++){
    assert.equal((await runCatalog(args)).status,'continuation_pending');
    assert.equal((await job()).attempts,batchFailureAttempt);assert.equal((await job()).last_error_code,batchFailureCode);
  }
  assert.equal((await catalogHead()).sequence,3);assert.equal((await parent()).sequence,parentBefore.sequence+9);
  const terminalCatalog=await job();assert.deepEqual(await runCatalog(args),{status:'idle'});assert.deepEqual(await job(),terminalCatalog);
  assert.deepEqual(await partitionHead(),completedPartitionHead);assert.deepEqual(await partitionRows(),completedPartitionRows);
  const workspace=async()=>(await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows;
  const waitMethod='awaitCoveredOriginalFrozenCaptureJobSelectionReferencesV2';
  const beforePendingJob=await job(),beforePendingParent=await parent(),beforePendingReads=stockReads;
  assert.deepEqual(await workspace(),[]);
  assert.deepEqual(await tx(pool,client=>waitClaims(client).claimDue({leaseSeconds:900})),[]);
  assert.deepEqual(await runWait(args),{status:'idle'});
  assert.equal(stockReads,beforePendingReads);assert.deepEqual(await job(),beforePendingJob);assert.deepEqual(await parent(),beforePendingParent);
  // A separate explicit pending-study command through the actual current-DB
  // workspace owner. Queueing and coverage never fabricate this intent.
  const started=await service.startRecordedGroupCapture({auth:input.auth,accountId:input.accountId,assignmentFileId:input.assignmentFileId,
    expectedWorkspaceRevision:0,expectedWorkspaceCheckpoint:{workspace_version:7,active:null,pending_capture:null},
    pendingCapture:{operation_id:operation,observation_period:input.observationPeriod,discovery:input.discovery}});
  assert.equal(started.status,'stored');const pendingWorkspace=await workspace();assert.equal(pendingWorkspace[0].revision,1);
  const afterExplicitPending=await protectedRows(),assignmentBeforeStamp=structuredClone(afterExplicitPending.assignment);
  assert.deepEqual(afterExplicitPending.report,protectedBefore.report);
  assert.equal(assignmentBeforeStamp.length,1);assignmentBeforeStamp[0].body.updated_at=protectedBefore.assignment[0].body.updated_at;
  assert.deepEqual(assignmentBeforeStamp,protectedBefore.assignment,
    'the explicit pending-study save may update only the assignment timestamp, never its facts or accepted report');
  protectedBefore=afterExplicitPending;

  let selectionWaitOwner,waitOptions,beforeWait,beforeWaitParent,ownerCalls=0;
  const waitArgs={...args,cohortService:{async [waitMethod](value,options){
    try{
    ownerCalls++;selectionWaitOwner={claim:options.captureJobClaim};waitOptions={captureJobClaim:selectionWaitOwner.claim};
    assert.equal(selectionWaitOwner.claim.operation_id,operation);assert.equal(selectionWaitOwner.claim.attempts,batchFailureAttempt);

    let batchReconciledAccounts=null;
    if(coveredTransactionIndexFixture){
      const batchOptions={captureJobClaim:selectionWaitOwner.claim,stockAccountPackagePage:{cursor:''}},
        batchRead=()=>service.readCoveredFrozenCaptureJobWholeAccountBatchReferencesV2(input,batchOptions),
        beforeBatch={job:await job(),parent:await parent(),workspace:await workspace(),cache:await cacheState(),head:await head(),protected:await protectedRows(),
          pins:(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,
          cad:await cadState(),cadHead:await cadHead(),stock:await stockHead(),partition:await partitionHead(),rows:await partitionRows(),catalog:await catalogHead(),
          blobs:(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows};
      const assertUnchanged=async()=>{
        assert.deepEqual(await protectedRows(),beforeBatch.protected);
        assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,beforeBatch.pins);
        assert.deepEqual(await job(),beforeBatch.job);assert.deepEqual(await parent(),beforeBatch.parent);assert.deepEqual(await workspace(),beforeBatch.workspace);
        assert.deepEqual(await cacheState(),beforeBatch.cache);assert.deepEqual(await head(),beforeBatch.head);assert.deepEqual(await cadState(),beforeBatch.cad);
        assert.deepEqual(await cadHead(),beforeBatch.cadHead);assert.deepEqual(await stockHead(),beforeBatch.stock);assert.deepEqual(await partitionHead(),beforeBatch.partition);
        assert.deepEqual(await partitionRows(),beforeBatch.rows);assert.deepEqual(await catalogHead(),beforeBatch.catalog);
        assert.deepEqual((await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows,beforeBatch.blobs);
      };
      for(const [mode,reason] of [['batch_workspace',/custom_cohort_group_workspace_study_changed/],
        ['batch_rights',/market_data_access_denied|market_policy_changed/],['batch_role',/custom_cohort_job_actor_access_revoked/],['batch_cache',/original_mismatch/]]){
        fault=mode;await assert.rejects(batchRead(),reason);assert.equal(fault,null);
        if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
        await assertUnchanged();
      }
      fault='batch_ack';await assert.rejects(batchRead(),e=>e.outcome_unknown===true);assert.equal(fault,null);await assertUnchanged();
      const packet=await batchRead();assert.equal(packet.account_count,2);assert.equal(packet.end_of_accounts,false);assert.equal(packet.native_progress,'not_issued');
      assert.deepEqual(packet.accounts.map(p=>p.account_id),[input.accountId,'CLOSURE-B']);
      assert.equal(packet.original_count,packet.accounts.reduce((n,a)=>n+a.rows.length,0));
      assert.ok(packet.accounts.every(a=>a.rows.length>=1&&a.original_counts.parcels>=1));
      assert.equal(packet.accounts[0].original_counts.parcels,2,'the complete outside part is reread in the batch');
      batchReconciledAccounts=new Map(packet.accounts.map(account=>[account.account_id,account]));
      const empty=await service.readCoveredFrozenCaptureJobWholeAccountBatchReferencesV2(input,
        {captureJobClaim:selectionWaitOwner.claim,stockAccountPackagePage:{cursor:packet.next_cursor}});
      assert.equal(empty.end_of_accounts,true);assert.equal(empty.account_count,0);assert.equal(empty.original_count,0);await assertUnchanged();
      console.info('[native-issued-whole-account-batch-original-replay-v2]',{actual_independent_source_neutral_CAD_and_native_parents:true,
        whole_accounts:2,every_outside_original_and_ENTIRE_cache_replayed:true,one_shared_original_query_budget:true,
        ending_actual_source_rights_actor_workspace_and_cache_refusal:true,lost_real_readonly_COMMIT_ACK_replay:true,
        fresh_EMPTY:true,attempt5_history_preserved:true,all_native_parent_rows_blobs_workspace_reports_assignments_and_pins_unchanged:true,
        native_batch_progress:false,complete_batched_traversal_partition_catalog:false,licensed_large_or_speed_acceptance:false});
    }
    const expectedGroups=new Map();let catalogCursor='';
    for(let i=0;i<3;i++){
    const packet=await service.readCoveredOriginalFrozenCaptureJobRecordedCatalogAccountReferencesV2(input,
      {captureJobClaim:selectionWaitOwner.claim,stockAccountPackagePage:{cursor:catalogCursor}});
    assert.equal(packet.end_of_accounts,i===2);assert.equal(packet.status,'original_reconciled_recorded_catalog_account');
    assert.equal(packet.complete_catalog_original_replay,false);
    if(packet.account_id!==null){
      if(batchReconciledAccounts){
        const batchAccount=batchReconciledAccounts.get(packet.account_id);assert.ok(batchAccount);
        for(const field of ['rows','original_counts','geographic_parcel_count','observations','recorded_group','account_original_state'])
          assert.deepEqual(batchAccount[field],packet[field],`batch ${field} equals the separately reopened whole original account`);
      }
      const group=packet.recorded_group,id=group.assigned_group_id??'discovery:unassigned',candidate=group.state==='assigned'?group.candidate_groups[0]:null;
      const prior=expectedGroups.get(id)??{group_id:id,normalized_county:candidate?.normalized_county??null,
        normalized_label:candidate?.normalized_label??null,member_count:0,last_ordinal:0};
      prior.member_count++;prior.last_ordinal=i+1;expectedGroups.set(id,prior);
    }
    catalogCursor=packet.next_cursor;
    }
    assert.deepEqual(await catalogGroups(),[...expectedGroups.values()].sort((a,b)=>a.group_id<b.group_id?-1:a.group_id>b.group_id?1:0));
    assert.equal([...expectedGroups.values()].reduce((n,g)=>n+g.member_count,0),2);

    const beforeMissingTarget=await job(),beforeMissingReads=stockReads;
    fault='wait_missing';await assert.rejects(service[waitMethod](input,waitOptions),/custom_cohort_group_workspace_unavailable/);
    assert.equal(fault,null);assert.equal(stockReads,beforeMissingReads,'a real missing pending workspace refuses before terminal originals');
    assert.deepEqual(await job(),beforeMissingTarget);assert.deepEqual(await workspace(),pendingWorkspace);
    beforeWait=await job();beforeWaitParent=await parent();
  for(const [probe,reason] of [['wait_workspace',/custom_cohort_group_workspace_study_changed/],['wait_role',/custom_cohort_job_actor_access_revoked/]]){
    fault=probe;const beforeReads=stockReads;await assert.rejects(service[waitMethod](input,waitOptions),reason);
    assert.equal(fault,null);assert.equal(stockReads,beforeReads+1);
    assert.deepEqual(await job(),beforeWait);assert.deepEqual(await parent(),beforeWaitParent);assert.deepEqual(await workspace(),pendingWorkspace);
    if(probe==='wait_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  }

    fault='wait_ack';return await service[waitMethod](value,options);
    }catch(error){
      // The real worker intentionally maps assertion/owner failures to a finite
      // failure code. Keep the original cause visible in this disposable native
      // fixture without dumping original observations, SQL values or payloads.
      console.info('[native-selection-wait-probe-failure]',{fixture:coveredTransactionIndexFixture?'transaction-index':'initial-dispatch',
        fault,code:error?.code??null,type:error?.name??null,
        message:String(error?.message??'').split('\n')[0].slice(0,240),
        at:String(error?.stack??'').split('\n').filter(line=>line.includes('neighborhoodNeutralCacheV2WorkerDatabaseChecks.js')).slice(0,2)});
      throw error;
    }
  }}};
  const waitResults=await Promise.all([runWait(waitArgs),runWait(waitArgs)]);
  assert.deepEqual(waitResults.map(r=>r.status).sort(),['idle','outcome_unknown']);
  assert.equal(ownerCalls,1);assert.equal(fault,null);
  const waiting=await job();assert.equal(waiting.status,'awaiting_selection');assert.equal(waiting.claim_token,null);assert.equal(waiting.lease_expires_at,null);
  assert.equal(waiting.attempts,batchFailureAttempt);assert.equal(waiting.last_error_code,batchFailureCode);assert.deepEqual(waiting.checkpoint,beforeWait.checkpoint);
  assert.deepEqual(await workspace(),pendingWorkspace);assert.deepEqual(await parent(),beforeWaitParent);
  const staleReads=stockReads;await assert.rejects(service[waitMethod](input,waitOptions),/claim_lost/);assert.equal(stockReads,staleReads);
  for(const worker of [runStock,runPartition,runCatalog,runWait])assert.deepEqual(await worker(args),{status:'idle'});
  assert.deepEqual(await job(),waiting);
  assert.deepEqual(await runSelectedInitial(args),{status:'idle'},'only a genuine immutable human command can be adopted');
  assert.deepEqual(await job(),waiting);
  // Explicit inclusion of both groups is a deliberate disposable-fixture
  // NEW-study command, never a default inferred by a worker or production UI.
  // The independent legacy union-empty scenario retains empty-command proof.
  const selectedGroupIds=(await catalogGroups()).map(row=>row.group_id);
  assert.equal(selectedGroupIds.length,2);assert.ok(selectedGroupIds.includes('discovery:unassigned'));
  const intentMethod='resumeCoveredOriginalFrozenCaptureJobSelectionIntentReferencesV2',
    selectionIntent={command_id:randomUUID(),catalog_reference:(await catalogHead()).receipt_reference,
      workspace_revision:1,included_recorded_group_ids:selectedGroupIds},
    intents=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1',[operation])).rows;
  for(const [probe,reason] of [['intent_workspace',/custom_cohort_group_workspace_study_changed/],['intent_role',/custom_cohort_job_actor_access_revoked/]]){
    fault=probe;await assert.rejects(service[intentMethod](input,{selectionIntent}),reason);assert.equal(fault,null);
    assert.deepEqual(await intents(),[]);assert.deepEqual(await job(),waiting);assert.deepEqual(await workspace(),pendingWorkspace);
    if(probe==='intent_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  }
  fault='intent_ack';await assert.rejects(service[intentMethod](input,{selectionIntent}),error=>error.outcome_unknown===true);assert.equal(fault,null);
  assert.equal((await intents()).length,1);const command=(await intents())[0],resumed=await service[intentMethod](input,{selectionIntent});
  assert.deepEqual(resumed.included_recorded_group_ids,selectedGroupIds);assert.equal(resumed.command_id,selectionIntent.command_id);
  assert.equal(resumed.claim.claim_token,command.resume_claim_token);assert.equal(resumed.claim.attempts,batchFailureAttempt);
  const humanOwnedJob=await job(),humanOwnedIntents=await intents();assert.equal(humanOwnedJob.status,'running');
  const reopened=await service.readCoveredOriginalFrozenCaptureJobRetainedSelectionIntentReferencesV2(input,{captureJobClaim:resumed.claim});
  assert.deepEqual(reopened.included_recorded_group_ids,selectedGroupIds);assert.equal(reopened.command_id,selectionIntent.command_id);
  assert.equal(reopened.read_only,true);assert.equal(reopened.lease_extended,false);
  assert.deepEqual(await job(),humanOwnedJob);assert.deepEqual(await intents(),humanOwnedIntents);assert.deepEqual(await workspace(),pendingWorkspace);
  for(const worker of [runStock,runPartition,runCatalog,runWait])assert.deepEqual(await worker(args),{status:'idle'});
  assert.deepEqual(await job(),humanOwnedJob,'completed acquisition workers cannot steal the genuine command resume lease');
  // Exercise every real native claim/expiry lane against the expired and
  // cancellation-requested human lease in ONE real transaction. Roll back
  // that deliberate probe so the genuine live claim can progress afterward;
  // no expired token is revived or failure count reset.
  const rollbackNextOwnerProbe=Error('rollback native human next-owner probe');
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);
    const snapshot=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0];
    assert.ok(snapshot.cancellation_requested_at);assert.ok(snapshot.lease_expires_at<new Date());
    for(const repository of [stockClaims,partitionClaims,catalogClaims,waitClaims])
      assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0],snapshot);
    throw rollbackNextOwnerProbe;
  }),error=>error===rollbackNextOwnerProbe);
  assert.deepEqual(await job(),humanOwnedJob);assert.deepEqual(await intents(),humanOwnedIntents);
  const unionMethod='continueCoveredOriginalFrozenCaptureJobSelectedStockUnionReferencesV2',
    unionHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    unionRows=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=$1 ORDER BY ordinal',[operation])).rows,
    unionGroups=async()=>(await pool.query('SELECT group_id,member_count,last_ordinal FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=$1 ORDER BY group_id',[operation])).rows;
  const initialDispatches=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_initial_dispatch_v2 WHERE operation_id=$1',[operation])).rows;
  assert.deepEqual(await initialDispatches(),[]);
  await assert.rejects(tx(pool,async client=>{
    const [adopted]=await selectedInitialClaims(client).claimDue({leaseSeconds:900});
    assert.deepEqual(adopted.claim,resumed.claim);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
  }),error=>error.code==='55000');
  assert.deepEqual(await initialDispatches(),[]);assert.deepEqual(await job(),humanOwnedJob);
  let initialOwnerCalls=0;
  const initialArgs={...args,cohortService:{async [unionMethod](value,options){
    initialOwnerCalls++;assert.deepEqual(options.captureJobClaim,resumed.claim);
    const ownerBefore=await job();
  for(const [probe,reason] of [['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/]]){
    fault=probe;const reads=stockReads;await assert.rejects(service[unionMethod](value,options),reason);
    assert.equal(fault,null);assert.ok(stockReads>reads);assert.equal(await unionHead(),undefined);
    assert.deepEqual(await unionRows(),[]);assert.deepEqual(await unionGroups(),[]);assert.deepEqual(await job(),ownerBefore);
    assert.deepEqual(await workspace(),pendingWorkspace);assert.deepEqual(await intents(),humanOwnedIntents);
    if(probe==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  }
  fault='union_orphan';await assert.rejects(service[unionMethod](value,options),
    error=>error.outcome_unknown===true&&error.code==='55000');assert.equal(fault,null);
  assert.equal(await unionHead(),undefined);assert.deepEqual(await unionRows(),[]);assert.deepEqual(await unionGroups(),[]);
  assert.deepEqual(await job(),ownerBefore);assert.deepEqual(await workspace(),pendingWorkspace);
  fault='union_ack';return service[unionMethod](value,options);
  }}};
  const initialResults=await Promise.all([runSelectedInitial(initialArgs),runSelectedInitial(initialArgs)]);
  assert.deepEqual(initialResults.map(r=>r.status).sort(),['idle','outcome_unknown']);assert.equal(initialOwnerCalls,1);
  const dispatches=await initialDispatches();assert.equal(dispatches.length,1);
  assert.equal(dispatches[0].claim_token,resumed.claim.claim_token);assert.equal(dispatches[0].attempts,batchFailureAttempt);
  assert.equal(dispatches[0].command_id,selectionIntent.command_id);assert.equal(dispatches[0].actor_user_id,actor);
  assert.equal(fault,null);assert.equal((await unionHead()).sequence,1);
  assert.deepEqual(await runSelectedInitial(args),{status:'idle'});
  for(let i=0;i<2;i++){
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
    const progressArgs={...args,cohortService:{...service,async [unionMethod](value,options){
    assert.equal(options.captureJobClaim.attempts,batchFailureAttempt);assert.notEqual(options.captureJobClaim.claim_token,resumed.claim.claim_token);
    enter();await held;
    const progress=await service[unionMethod](value,options);
    assert.equal(progress.covered_neutral_originals,true);assert.equal(progress.complete_catalog_original_replay,i===1);
    assert.equal(progress.complete_distinct_selected_stock_union,i===1);assert.equal(progress.selected_stock_accounts,2);
    assert.equal(progress.context_complete,false);assert.equal(progress.pin_transfer,false);
    assert.equal((await job()).last_error_code,batchFailureCode);
    return progress;
    }}};
    const running=runSelectedProgress(progressArgs);
    // The real worker has committed its fresh native claim and reached the
    // original owner. A concurrent real worker must be idle at that live lease.
    try{
      await Promise.race([entered,running.then(()=>{throw Error('covered selected owner was not entered');})]);
      const active=await job();assert.deepEqual(await runSelectedProgress(args),{status:'idle'});
      assert.deepEqual(await job(),active);
    }finally{release();}
    assert.equal((await running).status,'continuation_pending');
  }
  assert.equal((await unionHead()).sequence,3);
  const selectedRows=await unionRows(),stockMembers=(await pool.query(
    'SELECT account_id FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$1 ORDER BY account_id',[operation])).rows;
  assert.equal(selectedRows.length,2);assert.deepEqual(selectedRows.map(row=>row.account_id),stockMembers.map(row=>row.account_id));
  assert.deepEqual(selectedRows.map(row=>row.ordinal),[1,2]);assert.deepEqual(selectedRows.map(row=>row.partition_ordinal),[1,2]);
  assert.deepEqual(await unionGroups(),(await catalogGroups()).map(({group_id,member_count,last_ordinal})=>({group_id,member_count,last_ordinal})));
  const eligibilityMethod='progressCoveredOriginalFrozenCaptureJobSelectedRecordedEligibilityReferencesV2',
    eligibilityHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=$1',[operation])).rows[0];
  let eligibilityCalls=0;
  const eligibilityArgs={...args,cohortService:{...service,async [eligibilityMethod](value,options){
  eligibilityCalls++;assert.equal(options.captureJobClaim.attempts,batchFailureAttempt);
  const eligibilityBefore=await job(),unionBefore=await unionHead(),nativeGroupsBefore=await unionGroups(),
    eligibilityOwner={claim:options.captureJobClaim};
  if(eligibilityCalls===1){
    const amenityMethod='readCoveredOriginalFrozenCaptureJobFirstSelectedAmenitiesReferencesV2',
      generation=(await pool.query('SELECT generation_id FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=$1',[operation])).rows[0].generation_id,
      cadHeader=async()=>(await pool.query(CAD_SQL.read,[generation,getNeighborhoodFrozenTypedCadImprovementV1Profile().profile_ref.content_sha256])).rows[0],
      cadBefore=await cadHead(),cadLedgerBefore=await cadState(),neutralBefore=await head(),cadHeaderBefore=await cadHeader();
    assert.equal(cadHeaderBefore.status,'building');assert.equal(cadHeaderBefore.completed_at,null);
    for(const [probe,reason] of [['selected_CAD_workspace',/custom_cohort_group_workspace_study_changed/],
      ['selected_CAD_role',/custom_cohort_job_actor_access_revoked/],['selected_CAD_deny',/market_data_access_denied/],
      ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
      fault=probe;const reads=stockReads;await assert.rejects(service[amenityMethod](value,options),reason);
      assert.equal(fault,null);assert.equal(stockReads,reads+1,'ending refusal follows the actual selected whole-original packet');
      if(probe==='selected_CAD_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
      assert.deepEqual(await job(),eligibilityBefore);assert.deepEqual(await unionHead(),unionBefore);
      assert.deepEqual(await cadHead(),cadBefore);assert.deepEqual(await cadState(),cadLedgerBefore);assert.deepEqual(await head(),neutralBefore);
      assert.deepEqual(await cadHeader(),cadHeaderBefore);assert.deepEqual(await intents(),humanOwnedIntents);assert.deepEqual(await workspace(),pendingWorkspace);
    }
    await assert.rejects(service.readOriginalFrozenCaptureJobFirstSelectedAmenitiesReferencesV2(value,options),/cache_unavailable/,
      'legacy global-complete CAD/neutral gates remain unchanged');
    const amenities=await service[amenityMethod](value,options);
    assert.equal(amenities.covered_neutral_originals,true);assert.equal(amenities.covered_CAD_originals,true);
    assert.equal(amenities.selected_entry.ordinal,1);assert.equal(amenities.selected_entry.account_id,selectedRows[0].account_id);
    assert.equal(amenities.selected_CAD.account_id,selectedRows[0].account_id);
    assert.deepEqual(amenities.selected_CAD.cache_coverage_reference,cadBefore.receipt_reference);
    assert.equal(amenities.read_only,true);assert.equal(amenities.lease_extended,false);
    assert.equal(amenities.complete_selected_union_amenities,false);assert.equal(amenities.context_complete,false);
    assert.equal(amenities.pin_transfer,false);assert.equal(amenities.report_update,'none');assert.ok(Buffer.byteLength(JSON.stringify(amenities))<=16000);
    fault='selected_CAD_ack';await assert.rejects(service[amenityMethod](value,options),e=>e.outcome_unknown===true);assert.equal(fault,null);
    assert.deepEqual(await service[amenityMethod](value,options),amenities);
    assert.deepEqual(await job(),eligibilityBefore);assert.deepEqual(await unionHead(),unionBefore);assert.deepEqual(await unionGroups(),nativeGroupsBefore);
    assert.deepEqual(await cadHead(),cadBefore);assert.deepEqual(await cadState(),cadLedgerBefore);assert.deepEqual(await head(),neutralBefore);
    assert.deepEqual(await cadHeader(),cadHeaderBefore);assert.deepEqual(await intents(),humanOwnedIntents);assert.deepEqual(await workspace(),pendingWorkspace);
    console.info('[native-covered-first-selected-CAD-amenities-v2]',{server_owned_selected_ordinal_one:true,
      actual_adopted_independent_CAD_and_neutral_DONE:true,global_CAD_still_building:true,
      every_selected_and_required_subject_original_entire_cache_replayed:true,current_ending_CAD_role_workspace_header_native_head_refusal:true,
      lost_readonly_COMMIT_ACK_fresh_identical_reopen:true,job_lease_heads_intent_choices_cache_unchanged:true,
      aggregate_original_byte_query_deadline_output_caps_unchanged:true,complete_selected_union_amenities:false,
      context_complete:false,publication:false,pin_transfer:false,licensed_large_area:false,production_speed:false});
  }
  const transactionMethod='readCoveredOriginalFrozenCaptureJobFirstSelectedTransactionsReferencesV2';
  for(const [probe,reason] of [['transaction_workspace',/custom_cohort_group_workspace_study_changed/],
    ['transaction_role',/custom_cohort_job_actor_access_revoked/]]){
    fault=probe;const reads=stockReads;await assert.rejects(service[transactionMethod](value,options),reason);
    assert.equal(fault,null);assert.equal(stockReads,reads+1);
    assert.deepEqual(await job(),eligibilityBefore);assert.deepEqual(await unionHead(),unionBefore);
    assert.deepEqual(await unionGroups(),nativeGroupsBefore);assert.deepEqual(await intents(),humanOwnedIntents);
    assert.deepEqual(await workspace(),pendingWorkspace);
    if(probe==='transaction_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  }
  const transactions=await service[transactionMethod](value,options);
  assert.equal(transactions.status,'current_authorized_first_selected_original_transactions_reopened');
  assert.equal(transactions.covered_neutral_originals,true);assert.equal(transactions.selected_entry.ordinal,1);
  assert.equal(transactions.selected_entry.account_id,selectedRows[0].account_id);
  assert.equal(transactions.read_only,true);assert.equal(transactions.lease_extended,false);
  assert.equal(transactions.complete_selected_union_transactions,false);assert.equal(transactions.context_complete,false);
  assert.equal(transactions.pin_transfer,false);assert.equal(transactions.report_update,'none');
  assert.equal(Object.hasOwn(transactions,'selected_CAD'),false);
  const nativeTransactions=transactions.selected_transactions;
  assert.equal(nativeTransactions.account_id,selectedRows[0].account_id);
  assert.equal(nativeTransactions.package_count,nativeTransactions.packages.length);
  assert.equal(nativeTransactions.original_count,nativeTransactions.packages.reduce((n,p)=>n+p.rows.length,0));
  assert.equal(nativeTransactions.complete_selected_union_transactions,false);
  assert.deepEqual(nativeTransactions.retained_observation_period,input.observationPeriod);
  assert.ok(Buffer.byteLength(JSON.stringify(transactions))<=16000);
  fault='transaction_ack';await assert.rejects(service[transactionMethod](value,options),error=>error.outcome_unknown===true);
  assert.equal(fault,null);assert.deepEqual(await service[transactionMethod](value,options),transactions);
  assert.deepEqual(await job(),eligibilityBefore);assert.deepEqual(await unionHead(),unionBefore);
  assert.deepEqual(await unionGroups(),nativeGroupsBefore);assert.deepEqual(await intents(),humanOwnedIntents);
  assert.deepEqual(await workspace(),pendingWorkspace);
  for(const method of ['readCoveredOriginalFrozenCaptureJobSelectedUnionSubjectHousingReferencesV2','readCoveredOriginalFrozenCaptureJobFirstSelectedEligibilityReferencesV2']){
    const read=await service[method](input,{captureJobClaim:eligibilityOwner.claim});
    assert.equal(read.covered_neutral_originals,true);assert.equal(read.read_only,true);assert.equal(read.lease_extended,false);
    assert.equal(read.context_complete,false);assert.equal(read.pin_transfer,false);
    if(method==='readCoveredOriginalFrozenCaptureJobFirstSelectedEligibilityReferencesV2'){
      assert.equal(read.subject_original_fallback,false);assert.equal(read.selected_entry.account_id,'CLOSURE-A');
      assert.equal(read.decision.housing.state,'matching');
      for(const [key,expected] of Object.entries({reported_year_built:'1960',reported_residential_area:'1000.01',reported_site_area:'8000'})){
        assert.equal(read.decision.metrics[key].recorded_comparison_eligible,true);
        assert.equal(read.decision.metrics[key].exact_value,expected);
        assert.equal(read.decision.metrics[key].complete_observed_parts,true);
        assert.equal(read.decision.metrics[key].source_part_count,2,'outside-geometry A part must be reconciled too');
      }
      assert.equal(read.decision.metrics.reported_market_value.recorded_comparison_eligible,false);
      assert.ok(read.decision.metrics.reported_market_value.reasons.includes('currency_not_established'));
      assert.equal(read.decision.economic_unit,'not_established');assert.equal(read.decision.statistics,'not_established');
    }
    assert.deepEqual(await job(),eligibilityBefore);assert.deepEqual(await unionHead(),unionBefore);
    assert.deepEqual(await unionGroups(),nativeGroupsBefore);assert.deepEqual(await intents(),humanOwnedIntents);
  }
  fault='eligibility_orphan';await assert.rejects(service[eligibilityMethod](input,{captureJobClaim:eligibilityOwner.claim}),
    error=>error.outcome_unknown===true&&error.code==='55000');assert.equal(fault,null);
  assert.equal(await eligibilityHead(),undefined);assert.deepEqual(await job(),eligibilityBefore);
  fault='eligibility_ack';return service[eligibilityMethod](value,options);
  }}};
  assert.equal((await runSelectedProgress(eligibilityArgs)).status,'outcome_unknown');assert.equal(eligibilityCalls,1);
  assert.equal(fault,null);assert.equal((await eligibilityHead()).sequence,1);assert.equal((await job()).attempts,batchFailureAttempt);
  assert.equal((await job()).last_error_code,batchFailureCode);assert.deepEqual(await intents(),humanOwnedIntents);
  const readEligibilityReceipt=async()=>JSON.parse((await pool.query(`SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes<=16000`,
    [scope.organization_id,(await eligibilityHead()).receipt_reference.content_sha256])).rows[0].canonical_utf8);
  const firstRecordedReceipt=await readEligibilityReceipt();
  assert.deepEqual(firstRecordedReceipt.eligible,{reported_year_built:true,reported_residential_area:true,reported_site_area:true});
  assert.deepEqual(firstRecordedReceipt.before_counts,{reported_year_built:0,reported_residential_area:0,reported_site_area:0});
  assert.deepEqual(firstRecordedReceipt.after_counts,{reported_year_built:1,reported_residential_area:1,reported_site_area:1});
  // The first real eligibility owner handled selected ordinal one. Fresh
  // worker claims must read ordinal two and then prove terminal EMPTY. An
  // account count, cached bit or initial-page callback cannot finish this pass.
  for(let step=0;step<2;step++){
    let actualOwnerResult=null;
    const positiveArgs={...args,cohortService:{...service,async [eligibilityMethod](value,options){
      actualOwnerResult=await service[eligibilityMethod](value,options);return actualOwnerResult;
    }}};
    assert.equal((await runSelectedProgress(positiveArgs)).status,'continuation_pending');
    assert.ok(actualOwnerResult,'the real worker must invoke the actual original-reconciling owner');
    assert.deepEqual(actualOwnerResult.recorded_comparison_counts,{reported_year_built:1,reported_residential_area:1,reported_site_area:2});
    if(step===0){
      assert.equal(actualOwnerResult.selected_entry.account_id,'CLOSURE-B');assert.equal(actualOwnerResult.selected_entry.ordinal,2);
      assert.equal(actualOwnerResult.decision.housing.state,'matching');
      assert.equal(actualOwnerResult.decision.metrics.reported_site_area.recorded_comparison_eligible,true);
      assert.equal(actualOwnerResult.decision.metrics.reported_site_area.exact_value,'0');
      for(const key of ['reported_year_built','reported_residential_area','reported_market_value'])
        assert.equal(actualOwnerResult.decision.metrics[key].recorded_comparison_eligible,false);
      assert.equal(actualOwnerResult.complete_selected_recorded_comparison_pass,false);
    }else{
      assert.equal(actualOwnerResult.selected_entry,null);assert.equal(actualOwnerResult.decision,null);
      assert.equal(actualOwnerResult.complete_selected_recorded_comparison_pass,true);
    }
    assert.equal((await job()).attempts,batchFailureAttempt);assert.equal((await job()).last_error_code,batchFailureCode);
    assert.deepEqual(await intents(),humanOwnedIntents);
  }
  const completedEligibility=await eligibilityHead();assert.equal(completedEligibility.sequence,3);
  const eligibilityReceipt=JSON.parse((await pool.query(`SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes<=16000`,
    [scope.organization_id,completedEligibility.receipt_reference.content_sha256])).rows[0].canonical_utf8);
  assert.deepEqual(eligibilityReceipt.after,{selected_ordinal:2,done:true});
  assert.deepEqual(eligibilityReceipt.eligible,null);
  assert.deepEqual(eligibilityReceipt.before_counts,{reported_year_built:1,reported_residential_area:1,reported_site_area:2});
  assert.deepEqual(eligibilityReceipt.after_counts,eligibilityReceipt.before_counts,'fresh EMPTY cannot refund or add eligible comparisons');
  const eligibilityDone=await job();assert.deepEqual(await runSelectedProgress(args),{status:'idle'});
  assert.deepEqual(await runSelectedProgress(args),{status:'idle'});assert.deepEqual(await job(),eligibilityDone);
  const [laterOwner]=await tx(pool,client=>mainClaims(client).claimDue({limit:1,leaseSeconds:900}));
  assert.equal(laterOwner.claim.operation_id,operation);assert.equal(laterOwner.claim.attempts,batchFailureAttempt);
  const laterOwnedJob=await job();for(const worker of [runStock,runPartition,runCatalog,runWait,runSelectedInitial,runSelectedProgress])assert.deepEqual(await worker(args),{status:'idle'});
  assert.deepEqual(await job(),laterOwnedJob);
  await pool.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
  await tx(pool,client=>jobs(client).cancel(scope,operation));const nextOwnerPending=await job();
  assert.deepEqual(await runStock(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'stock DONE next-owner expired/cancelled claim is untouched by incomplete-stock claim AND expiry');
  assert.deepEqual(await runPartition(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'partition DONE next-owner expired/cancelled claim is untouched by covered-partition claim AND expiry');
  assert.deepEqual(await runCatalog(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'catalog DONE next-owner expired/cancelled claim is untouched by covered-catalog claim AND expiry');
  assert.deepEqual(await runWait(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'covered waiting claim AND expiry cannot steal an expired/cancelled immutable human command');
  assert.deepEqual(await runSelectedInitial(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'covered initial adoption AND expiry leave every later selected continuation untouched');
  assert.deepEqual(await initialDispatches(),dispatches,'the real human token was adopted exactly once');
  assert.deepEqual(await runSelectedProgress(args),{status:'idle'});assert.deepEqual(await job(),nextOwnerPending,
    'completed eligibility excludes every claim and expiry lane even after next-owner expiry/cancellation');
  assert.deepEqual(await workspace(),pendingWorkspace);assert.deepEqual(await intents(),humanOwnedIntents);
  const sourceGeneration=(await pool.query('SELECT generation_id FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=$1',[operation])).rows[0].generation_id;
  const cacheHeader=(await pool.query(SQL.read,[sourceGeneration,JSON.parse((await pool.query(
    'SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2',
    [scope.organization_id,complete.receipt_reference.content_sha256])).rows[0].canonical_utf8).profile_reference.content_sha256])).rows[0];
  assert.equal(cacheHeader.status,'building');assert.equal(cacheHeader.progress.typed_rows,'0');
  console.info('[native-cache-stock-first-bridge-v2]',{partial_cache_refused:true,concurrent_single_fresh_claim:true,
    orphan_real_claim_and_bridge_completion_COMMIT_refused:true,expired_token_cannot_revive:true,
    every_original_and_entire_cache_replayed:true,current_and_ending_role_refusal:true,lost_actual_first_stock_COMMIT_ACK:true,
    failure_history_preserved_at_attempt:5,main_sequence_exact_parent_plus_three:true,cache_success_parent_unchanged:true,
    native_first_then_second_and_EMPTY:true,global_header_still_building:true,later_worker_activation:false,pin_transfer:false,production_speed:false});
  console.info('[native-covered-stock-success-worker-v2]',{actual_second_and_EMPTY_original_owners:true,
    successful_pages_at_failure_ceiling:5,error_history_preserved:true,fresh_main_claim_each_step:true,
    completed_stock_repeated_idle:true,expired_cancelled_next_owner_claim_untouched:true,
    same_global_building_cache_and_native_parents:true,default_worker_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
  console.info('[native-covered-partition-success-worker-v2]',{concurrent_single_fresh_stock_DONE_adoption:true,
    actual_two_accounts_and_fresh_EMPTY:true,whole_original_cache_and_entire_partition_entries_reconciled:true,
    ending_role_rolls_back_rows_head_checkpoint_and_continuation:true,orphan_success_real_COMMIT_refused:true,
    lost_actual_first_partition_COMMIT_ACK:true,successful_pages_at_failure_ceiling:5,error_history_preserved:true,
    fresh_main_claim_each_step:true,partition_DONE_idle_and_expired_cancelled_catalog_claim_untouched:true,
    native_cache_bridge_and_original_parents_unchanged:true,global_header_still_building:true,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
  console.info('[native-covered-catalog-success-worker-v2]',{unfinished_partition_refused:true,concurrent_single_fresh_partition_DONE_adoption:true,
    actual_two_accounts_and_fresh_EMPTY:true,every_original_entire_cache_and_partition_entry_replayed:true,
    catalog_groups_and_unassigned_denominators_equal_newly_replayed_originals:true,
    ending_role_rolls_back_groups_head_checkpoint_and_continuation:true,orphan_success_real_COMMIT_refused:true,
    lost_actual_first_catalog_COMMIT_ACK:true,successful_pages_at_failure_ceiling:5,error_history_preserved:true,
    fresh_main_claim_each_step:true,catalog_DONE_idle_and_expired_cancelled_selection_wait_claim_untouched:true,
    native_cache_bridge_stock_and_partition_parents_unchanged:true,global_header_still_building:true,
    genuine_selection_intent:false,default_worker_activation:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
  console.info('[native-covered-selection-wait-worker-v2]',{missing_pending_study_idle_without_claim_or_original_read:true,
    concurrent_single_native_catalog_DONE_adoption:true,actual_current_DB_actor_request_and_original_wait_owner:true,
    every_catalog_group_compared_with_newly_replayed_whole_originals:true,missing_and_ending_workspace_and_role_rollback:true,
    lost_real_wait_COMMIT_ACK_not_downgraded:true,success_at_failure_ceiling:5,error_history_and_native_parents_preserved:true,
    waiting_repeated_idle_and_immutable_human_resume_lease_including_expired_cancelled_untouched:true,
    global_header_still_building:true,default_worker_activation:false,genuine_group_choice:false,
    licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selection-boundary-v2]',{missing_real_pending_workspace_refused_before_originals:true,
    separate_current_DB_pending_study_command_required:true,fresh_terminal_original_cache_partition_probe:true,
    ending_workspace_and_role_roll_back_wait_and_provisional_command:true,lost_actual_wait_and_command_COMMIT_ACKs:true,
    actual_wait_releases_only_lease_at_attempt:5,explicit_fixture_nonempty_command_never_auto_selected:true,
    immutable_command_exact_replay_and_readonly_reopen:true,all_completed_workers_leave_human_resume_lease_and_expired_cancelled_job_untouched:true,
    pending_workspace_and_native_parents_preserved:true,global_header_still_building:true,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selected-union-v2]',{actual_immutable_explicit_nonempty_command_replayed_exactly:true,
    every_two_whole_originals_entire_cache_partition_and_catalog_replayed_plus_fresh_EMPTY:true,
    complete_assigned_unassigned_group_counts_equal_native_catalog:true,ending_workspace_and_role_atomic_rollback:true,
    orphan_union_and_eligibility_yield_actual_COMMIT_refused:true,lost_actual_first_union_and_eligibility_COMMIT_ACKs:true,
    success_at_failure_ceiling:5,error_history_and_parent_roots_preserved:true,fresh_native_claim_each_step:true,
    subject_housing_and_nonempty_first_eligibility_readonly_no_lease_extension:true,
    real_expired_cancelled_human_lease_native_claim_expiry_probe_rolled_back_without_revival:true,
    completed_workers_leave_later_owner_including_expired_cancelled_untouched:true,
    global_header_still_building:true,nonempty_selected_metric_population:false,selected_CAD_amenity_consumption:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-nonempty-recorded-comparisons-v2]',{
    actual_original_source_fixture_captured_before_roots_caches_and_heads:true,
    retained_preferred_subject_and_both_native_accounts_recorded_detached:true,
    both_A_parcel_originals_including_outside_part_complete_equal_positive_values:true,
    first_actual_owner_lost_COMMIT_ACK_preserves_three_eligible_native_bits:true,
    next_fresh_worker_native_B_ordinal_preserves_eligible_site_zero_and_invalid_year_area:true,
    native_complete_counts:{reported_year_built:1,reported_residential_area:1,reported_site_area:2},
    separate_fresh_EMPTY_preserves_counts_without_addition_or_refund:true,
    currency_and_economic_unit_not_established:true,native_parents_pins_history_and_human_command_preserved:true,
    nonempty_selected_metric_population:false,selected_CAD_amenity_consumption:false,complete_semantics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-nonempty-selection-v2]',{explicit_fixture_assigned_and_unassigned_groups:2,
    actual_distinct_selected_stock_accounts:2,complete_native_union_rows_match_entire_fixture_stock:true,
    native_union_entry_and_partition_ordinals_one_and_two:true,complete_catalog_group_counts_replayed_from_every_original:true,
    actual_worker_eligibility_originals_at_selected_ordinals_one_and_two_plus_fresh_EMPTY:true,
    native_eligibility_sequence_three_and_terminal_selected_ordinal_two:true,immutable_human_command_and_failure_history_preserved:true,
    original_native_parents_workspace_reports_and_pins_preserved:true,global_header_still_building:true,
    nonempty_selected_metric_population:false,selected_CAD_amenity_consumption:false,complete_semantics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-first-selected-transactions-v2]',{server_owned_first_native_selected_ordinal_one:true,
    actual_whole_stock_subject_all_date_transaction_originals_and_entire_cache_reopened:true,
    entire_partition_catalog_and_immutable_human_command_reconciled:true,native_packages_and_original_counts_retained_without_truncation:true,
    real_ending_workspace_and_role_refusal:true,lost_actual_readonly_COMMIT_ACK_fresh_reopen_identical:true,
    no_job_head_union_groups_intent_workspace_or_lease_mutation:true,one_existing_original_query_transport_and_runtime_budget:true,
    global_header_still_building:true,separate_selected_CAD_amenity_consumption:false,economic_equivalence:false,
    complete_selected_union_transactions:false,calendar_quarters:false,statistics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selected-initial-worker-v2]',{missing_human_command_idle_without_claim:true,
    actual_expired_adoption_real_COMMIT_refused_and_rolled_back:true,concurrent_single_real_human_resume_adoption:true,
    original_human_token_attempt_command_and_actor_preserved:true,actual_DB_actor_saved_request_and_covered_original_owner:true,
    every_original_entire_cache_partition_catalog_replayed:true,ending_workspace_and_role_atomic_rollback:true,
    orphan_union_yield_real_COMMIT_refused:true,lost_actual_union_COMMIT_ACK_not_downgraded:true,
    successful_first_union_at_failure_ceiling:5,error_history_native_parents_and_human_choice_preserved:true,
    adoption_exactly_once_and_later_selected_owner_including_expired_cancelled_untouched:true,
    global_header_still_building:true,nonempty_selected_metric_population:false,selected_CAD_amenity_consumption:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selected-progress-worker-v2]',{actual_native_fresh_union_claim_for_each_original_and_EMPTY:true,
    concurrent_worker_idle_at_real_owner_live_lease:true,success_at_failure_ceiling:5,error_history_and_immutable_command_preserved:true,
    complete_original_cache_partition_catalog_reconciliation:true,union_DONE_routes_actual_recorded_eligibility_owner:true,
    subject_and_first_eligibility_readonly_under_actual_worker_claim:true,orphan_eligibility_yield_actual_COMMIT_refused:true,
    lost_real_eligibility_COMMIT_ACK_not_downgraded:true,eligibility_DONE_repeated_idle:true,
    later_owner_including_expired_cancelled_claim_and_expiry_untouched:true,original_native_parents_and_pins_preserved:true,
    global_header_still_building:true,nonempty_selected_metric_population:false,selected_CAD_amenity_consumption:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  await tx(pool,client=>jobs(client).cancel(scope,operation));const cancelled=await job();
  assert.deepEqual(await runCache(args),{status:'idle'});assert.deepEqual(await job(),cancelled);
  assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
  assert.deepEqual(await protectedRows(),protectedBefore);
  console.info('[native-neutral-cache-success-worker-v2]',{prefix_steps:prefixSteps,early_steps:earlySteps,cache_pages:complete.sequence,
    actual_original_and_complete_cache_owners:true,orphan_real_claim_and_owner_yield_COMMIT_refused:true,
    concurrent_single_fresh_initial_claim:true,lost_real_cache_owner_COMMIT_ACK:true,ending_role_cache_head_rollback:true,
    preserved_failure_history_attempt:3,expired_same_token_revival_refused:true,old_consumed_token_refused:true,
    generic_main_cannot_steal_identity_DONE:true,main_continuation_sequence_unchanged:true,cache_DONE_recovery_and_next_owner_claim_excluded:true,
    reports_and_pin_unchanged:true,assignment_unchanged_except_explicit_pending_command_timestamp:true,
    reader_handoff:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
  // A second independent actual job, never a cloned/rebound receipt or head.
  // Its own original parents prove genuine CAD recovery and the terminal cap
  // without removing any pre-existing downstream failure-history assertions.
  const recoveryInput={...sourceInput,operationId:randomUUID()},recoveryOperation=recoveryInput.operationId,
    recoveryJob=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[recoveryOperation])).rows[0],
    recoveryHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=$1',[recoveryOperation])).rows[0];
  await service.queueFrozenOriginalCaptureJobV2(recoveryInput);assert.equal((await runInitial(args)).status,'continuation_pending');
  for(const [worker,limit] of [[runPrefix,12],[runEarly,100],[runCache,50]]){
    let idle=false;for(let i=0;i<limit;i++){const r=await worker(args);if(r.status==='idle'){idle=true;break;}assert.equal(r.status,'continuation_pending');}
    assert.equal(idle,true,'the independent recovery fixture must finish its actual parent lane');
  }
  const recoveryParent=(await recoveryJob()).checkpoint;
  fault='cad_deny';assert.equal((await runCad(args)).reason,'capture_failed');assert.equal(fault,null);
  assert.equal((await recoveryJob()).attempts,1);assert.equal(await recoveryHead(),undefined);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[recoveryOperation]);
  assert.equal((await runCad(args)).status,'continuation_pending');const retainedRecoveryHead=await recoveryHead();
  assert.equal(retainedRecoveryHead.sequence,1);assert.equal((await recoveryJob()).attempts,2);
  assert.equal((await recoveryJob()).last_error_code,'capture_failed');
  for(const attempt of [2,3,4,5]){
    fault='cad_deny';const r=await runCad(args);assert.equal(r.reason,'capture_failed');assert.equal(fault,null);
    assert.equal(r.status,attempt===5?'failed':'retry');assert.equal((await recoveryJob()).attempts,attempt);
    assert.deepEqual(await recoveryHead(),retainedRecoveryHead,'failed B never refunds or overwrites committed A');
    if(attempt<5)await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[recoveryOperation]);
  }
  const terminalRecovery=await recoveryJob();assert.equal(terminalRecovery.status,'failed');assert.equal(terminalRecovery.context_sha256,null);
  assert.deepEqual(terminalRecovery.checkpoint,recoveryParent);assert.equal(terminalRecovery.last_error_code,'capture_failed');
  assert.deepEqual(await runCad(args),{status:'idle'});assert.deepEqual(await tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900})),[]);
  assert.deepEqual(await recoveryJob(),terminalRecovery);assert.deepEqual(await protectedRows(),protectedBefore);
  console.info('[native-automatic-CAD-genuine-recovery-five-failure-v2]',{independent_original_job_and_native_parents:true,
    first_failure_fresh_attempt2_and_real_A_success:true,committed_A_preserved_across_four_failed_B_claims:true,
    unchanged_five_failure_terminal_and_error_history:true,no_CAD_DONE_stock_adoption_context_or_pin_transfer:true,
    original_checkpoint_unchanged:true,licensed_large_area:false,production_speed:false});
  await runNeighborhoodCoveredSelectedEvidenceV2DatabaseChecks({pool,input:sourceInput,scope,actor,authorizeMarketData,authorizeCadImprovementData,coveredTransactionIndexFixture});
}
