import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCustomCohortRecordedCatalogBatchV3Repository } from '../../src/services/neighborhoodAssessment/customCohortRecordedCatalogBatchV3Repository.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as mainClaims } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { createCustomCohortCatalogBatchV3WorkerRepository as catalogClaims } from '../../src/services/neighborhoodAssessment/customCohortCatalogBatchV3WorkerRepository.js';
import { createCustomCohortStockBatchV3WorkerRepository as stockClaims } from '../../src/services/neighborhoodAssessment/customCohortStockBatchV3WorkerRepository.js';
import { createCustomCohortPartitionBatchV3WorkerRepository as partitionClaims } from '../../src/services/neighborhoodAssessment/customCohortPartitionBatchV3WorkerRepository.js';
import { createCustomCohortCoveredCatalogV2WorkerRepository as legacyCatalogClaims } from '../../src/services/neighborhoodAssessment/customCohortCoveredCatalogV2WorkerRepository.js';
import { runCustomCohortCatalogBatchV3JobOnce as run } from '../../src/services/neighborhoodAssessment/customCohortCatalogBatchV3JobWorker.js';
import { runCustomCohortCoveredCatalogV2JobOnce as legacyRun } from '../../src/services/neighborhoodAssessment/customCohortCoveredCatalogV2JobWorker.js';
import { runCustomCohortCoveredSelectionWaitV2JobOnce as legacyWait } from '../../src/services/neighborhoodAssessment/customCohortCoveredSelectionWaitV2JobWorker.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { runNeighborhoodCatalogBatchOriginalReplayV3DatabaseChecks } from './neighborhoodCatalogBatchOriginalReplayV3DatabaseChecks.js';
import { runNeighborhoodBatchSelectionWaitV3DatabaseChecks } from './neighborhoodBatchSelectionWaitV3DatabaseChecks.js';

/** Runs only in the NEW independently captured graph. Every source/native
 * parent, original/cache/entry read, current authority fence and COMMIT is real.
 * Forged receipt probes below establish native consistency only, never source
 * authority, capacity, activation or complete selected-union semantics. */
export async function runNeighborhoodCatalogBatchV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,
  setFault,readFault,packet,readBody,stockHead,partitionHead,partitionRows,bridgeState,cacheState,head,cadState,cadHead,
  protectedRows,protectedBefore,pin,batchPendingWorkspace,catalogBatchReplayFixture=false,batchSelectionWaitFixture=false,batchSelectionIntentFixture=false,batchSelectedUnionFixture=false,originalReads}){
  const operation=input.operationId,method='continueCoveredOriginalFrozenCaptureJobRecordedCatalogBatchReferencesV3',
    catalogHead=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    groups=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=$1 ORDER BY group_id',[operation])).rows,
    workspace=async()=>(await pool.query("SELECT revision,section_value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id])).rows,
    pins=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,
    blobs=async()=>(await pool.query('SELECT count(*)::integer AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',[scope.organization_id])).rows;
  const independent={stock:await stockHead(),partition:await partitionHead(),rows:await partitionRows(),bridge:await bridgeState(),
    cache:await cacheState(),head:await head(),cad:await cadState(),cadHead:await cadHead()};
  const assertParents=async()=>{
    assert.deepEqual(await stockHead(),independent.stock);assert.deepEqual(await partitionHead(),independent.partition);
    assert.deepEqual(await partitionRows(),independent.rows);assert.deepEqual(await bridgeState(),independent.bridge);
    assert.deepEqual(await cacheState(),independent.cache);assert.deepEqual(await head(),independent.head);
    assert.deepEqual(await cadState(),independent.cad);assert.deepEqual(await cadHead(),independent.cadHead);
    assert.deepEqual(await protectedRows(),protectedBefore);assert.deepEqual(await pins(),pin);assert.deepEqual(await workspace(),batchPendingWorkspace);
  };
  const adoption=(await Promise.all([1,2].map(()=>tx(pool,client=>catalogClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(adoption.length,1);const owned=adoption[0];assert.equal(owned.claim.attempts,5);assert.equal(owned.progress_done,true);
  const ownedJob=await job(),ownedParent=await parent(),ownedBlobs=await blobs();
  const assertNoProgress=async()=>{
    assert.equal(await catalogHead(),undefined);assert.deepEqual(await groups(),[]);assert.deepEqual(await job(),ownedJob);
    assert.deepEqual(await parent(),ownedParent);assert.deepEqual(await blobs(),ownedBlobs);await assertParents();
  };
  assert.equal(packet.account_count,2);assert.equal(packet.original_count,5);
  for(const [index,row] of independent.rows.entries())assert.deepEqual(await readBody(row.entry_reference),{
    format:'cohort_recorded_group_partition_entry_v2',account_id:packet.accounts[index].account_id,ordinal:index+1,
    recorded_group:packet.accounts[index].recorded_group});
  const expectedCounts={assigned_accounts:packet.accounts.filter(a=>a.recorded_group.state==='assigned').length,
    unassigned_accounts:packet.accounts.filter(a=>a.recorded_group.state!=='assigned').length,
    assigned_groups:new Set(packet.accounts.filter(a=>a.recorded_group.state==='assigned').map(a=>a.recorded_group.assigned_group_id)).size};
  assert.deepEqual(expectedCounts,{assigned_accounts:1,unassigned_accounts:1,assigned_groups:1});
  const bound=Object.fromEntries(['source_reference','root_reference','graph_reference','geographic_reference','identity_reference',
    'stock_reference','traversal_reference','profile_reference'].map(k=>[k,independent.partition[k]]));
  bound.partition_reference=independent.partition.receipt_reference;
  const entries=independent.rows.map(r=>({account_id:r.account_id,ordinal:r.ordinal,entry_reference:r.entry_reference,state:r.state,assigned_group_id:r.assigned_group_id})),
    zero={assigned_accounts:0,unassigned_accounts:0,assigned_groups:0},partitionBody=await readBody(bound.partition_reference),
    forged={...partitionBody,format:'cohort_recorded_catalog_batch_receipt_v3',partition_reference:bound.partition_reference,
      sequence:1,previous:null,before:{after_account:'',account_count:0,done:false},after:{after_account:'CLOSURE-B',account_count:2,done:false},
      accounts:packet.accounts.map(a=>({account_id:a.account_id,geographic_parcel_count:a.geographic_parcel_count,original_counts:a.original_counts})),
      original_count:5,entries,before_counts:zero,after_counts:expectedCounts};
  for(const body of [forged,{...forged,accounts:[forged.accounts[1]],entries:[entries[1]],original_count:2,
    after:{after_account:'CLOSURE-B',account_count:1,done:false},after_counts:{assigned_accounts:1,unassigned_accounts:0,assigned_groups:1}}]){
    await assert.rejects(tx(pool,async client=>{
      const ref=await createNeighborhoodCohortBlobRepository(client,scope.organization_id).put(json(body));
      await createCustomCohortRecordedCatalogBatchV3Repository({client,claim:owned.claim,scope,actorUserId:actor,...bound}).advance(null,ref);
    }),error=>error.code==='55000'&&/catalog_batch_v3_prefix_conflict/.test(error.message));
    await assertNoProgress();
  }
  // DML that omits the head/checkpoint must fail at actual deferred COMMIT.
  await assert.rejects(tx(pool,async client=>{
    await createCustomCohortRecordedCatalogBatchV3Repository({client,claim:owned.claim,scope,actorUserId:actor,...bound})
      .contributeBatch(null,packet.accounts.map((a,index)=>({account_id:a.account_id,ordinal:index+1,
        group_id:a.recorded_group.assigned_group_id??'discovery:unassigned',
        normalized_county:a.recorded_group.state==='assigned'?a.recorded_group.candidate_groups[0].normalized_county:null,
        normalized_label:a.recorded_group.state==='assigned'?a.recorded_group.candidate_groups[0].normalized_label:null})));
  }),error=>error.outcome_unknown===true&&['55000','P0002'].includes(error.code));
  await assertNoProgress();
  for(const [mode,reason] of [['batch_workspace',/custom_cohort_group_workspace_study_changed/],
    ['batch_rights',/market_data_access_denied|market_policy_changed/],['batch_role',/custom_cohort_job_actor_access_revoked/],
    ['batch_cache',/original_mismatch/],['catalog_batch_skip',/prefix_conflict/],
    ['catalog_batch_entry',/partition_original_mismatch/],['catalog_batch_counts',/catalog_original_mismatch/],
    ['catalog_batch_orphan_group',/invalid_receipt|prefix_conflict/],
    ['catalog_orphan',error=>error.outcome_unknown===true&&error.code==='55000']]){
    setFault(mode);await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),reason);assert.equal(readFault(),null);
    if(mode==='batch_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
    await assertNoProgress();
  }
  setFault('catalog_ack');await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),e=>e.outcome_unknown===true);assert.equal(readFault(),null);
  const first=await catalogHead(),firstBody=await readBody(first.receipt_reference),firstGroups=await groups(),firstJob=await job(),firstParent=await parent();
  assert.equal(first.sequence,1);assert.equal(firstBody.format,'cohort_recorded_catalog_batch_receipt_v3');
  assert.deepEqual(firstBody.entries,entries);assert.deepEqual(firstBody.after,forged.after);assert.deepEqual(firstBody.before_counts,zero);
  assert.deepEqual(firstBody.after_counts,expectedCounts);assert.equal(firstBody.original_count,5);assert.equal(firstJob.checkpoint.evidence_refs.length,9);
  assert.deepEqual(firstJob.checkpoint.evidence_refs[8],first.receipt_reference);assert.equal(firstParent.sequence,ownedParent.sequence+1);
  for(const g of firstGroups){const members=packet.accounts.filter(a=>(a.recorded_group.assigned_group_id??'discovery:unassigned')===g.group_id);
    assert.equal(g.member_count,members.length);assert.equal(g.last_ordinal,packet.accounts.findLastIndex(a=>(a.recorded_group.assigned_group_id??'discovery:unassigned')===g.group_id)+1);
    assert.equal(g.normalized_county,members[0].recorded_group.state==='assigned'?members[0].recorded_group.candidate_groups[0].normalized_county:null);
    assert.equal(g.normalized_label,members[0].recorded_group.state==='assigned'?members[0].recorded_group.candidate_groups[0].normalized_label:null);}
  await assert.rejects(service[method](input,{captureJobClaim:owned.claim}),/claim_lost/);
  assert.deepEqual(await legacyRun(args),{status:'idle'});assert.deepEqual(await legacyWait(args),{status:'idle'});assert.deepEqual(await job(),firstJob);
  setFault('catalog_ack');const terminalResult=await run(args);assert.equal(terminalResult.status,'outcome_unknown');assert.equal(readFault(),null);
  const terminal=await catalogHead(),terminalBody=await readBody(terminal.receipt_reference),terminalJob=await job();
  assert.equal(terminal.sequence,2);assert.deepEqual(terminalBody.before,firstBody.after);
  assert.deepEqual(terminalBody.after,{...firstBody.after,done:true});assert.deepEqual(terminalBody.accounts,[]);assert.deepEqual(terminalBody.entries,[]);
  assert.equal(terminalBody.original_count,0);assert.deepEqual(terminalBody.before_counts,expectedCounts);assert.deepEqual(terminalBody.after_counts,expectedCounts);
  assert.deepEqual(terminalBody.previous,first.receipt_reference);assert.deepEqual(await groups(),firstGroups);
  assert.equal(terminalJob.attempts,5);assert.equal(terminalJob.last_error_code,'access_revoked');assert.equal(terminalJob.context_sha256,null);
  assert.equal((await parent()).sequence,ownedParent.sequence+2);for(const worker of [run,legacyRun,legacyWait])assert.deepEqual(await worker(args),{status:'idle'});
  assert.deepEqual(await job(),terminalJob);await assertParents();
  if(batchSelectionWaitFixture){
    await runNeighborhoodBatchSelectionWaitV3DatabaseChecks({pool,input,scope,actor,service,args,job,parent,blobs,
      catalogHead,groups,assertParents,setFault,readFault,originalReads,batchSelectionIntentFixture,batchSelectedUnionFixture});
    return;
  }
  const [next]=await tx(pool,client=>mainClaims(client).claimDue({limit:1,leaseSeconds:900}));assert.equal(next.claim.attempts,5);
  if(catalogBatchReplayFixture)await runNeighborhoodCatalogBatchOriginalReplayV3DatabaseChecks({pool,input,scope,actor,service,
    claim:next.claim,packet,catalogHead,groups,job,parent,blobs,assertParents,setFault,readFault,originalReads});
  const nextJob=await job(),nextParent=await parent(),rollback=Error('rollback catalog batch next-owner probe');
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await jobs(client).cancel(scope,operation);const snapshot=(await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows;
    for(const repository of [stockClaims,partitionClaims,catalogClaims,legacyCatalogClaims])assert.deepEqual(await repository(client).claimDue({leaseSeconds:900}),[]);
    assert.deepEqual((await client.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows,snapshot);throw rollback;
  }),e=>e===rollback);
  assert.deepEqual(await job(),nextJob);assert.deepEqual(await parent(),nextParent);
  await tx(pool,client=>jobs(client).cancel(scope,operation));const cancelled=await job();assert.deepEqual(await run(args),{status:'idle'});
  assert.deepEqual(await job(),cancelled);assert.deepEqual(await catalogHead(),terminal);assert.deepEqual(await groups(),firstGroups);await assertParents();
  console.info('[native-whole-account-batch-catalog-v3]',{independent_initial_source_stock_partition_and_cache_native_parents:true,
    every_whole_original_ENTIRE_cache_and_ENTIRE_partition_entry_reconciled:true,
    two_contributions_one_native_head_receipt_checkpoint_and_continuation:true,assigned_accounts:1,unassigned_accounts:1,
    exact_original_group_normalized_literals:true,first_sequence:1,separate_fresh_EMPTY_sequence:2,
    native_skipped_prefix_and_counts_without_DML_refused:true,actual_orphan_group_COMMIT_and_orphan_yield_rollback:true,
    ending_source_actor_workspace_cache_entry_and_counts_fences:true,lost_nonempty_and_EMPTY_real_COMMIT_ACK:true,
    stale_claim_and_legacy_workers_refused:true,failure5_error_history_and_all_native_parents_pins_reports_preserved:true,
    DONE_all_success_recovery_expiry_and_cancelled_next_owner_excluded:true,
    native_eight_accounts_exercised:false,native_same_group_multiple_accounts_exercised:false,
    production_activation:false,licensed_large_area:false,production_speed:false,selected_union:false,publication:false,pin_transfer:false});
}
