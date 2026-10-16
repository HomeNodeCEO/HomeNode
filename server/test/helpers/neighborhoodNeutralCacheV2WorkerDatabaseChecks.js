import assert from 'node:assert/strict';
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
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL as SQL } from '../../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { createCustomCohortCacheStockV2BridgeRepository as bridgeClaims } from '../../src/services/neighborhoodAssessment/customCohortCacheStockV2BridgeRepository.js';
import { runCustomCohortCacheStockV2JobOnce as runBridge } from '../../src/services/neighborhoodAssessment/customCohortCacheStockV2JobWorker.js';
import { runCustomCohortCoveredStockV2JobOnce as runStock } from '../../src/services/neighborhoodAssessment/customCohortCoveredStockV2JobWorker.js';
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
  NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL as PAIRED_STOCK_PACKET } from '../../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';
import { NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL as TRANSACTION_PACKET }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';

/** Independent disposable job; all acquisition owners, authorization, original
 * queries, native issuance, savepoint rollback and COMMITs are real. */
export async function runNeighborhoodNeutralCacheV2WorkerDatabaseChecks({pool,input:sourceInput,scope,actor,authorizeMarketData}){
  const input={...sourceInput,operationId:randomUUID()},operation=input.operationId;let fault=null,stockReads=0;
  const observed={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
    const text=typeof c==='string'?c:c.text,originalPacket=text===STOCK_PACKET||text===PAIRED_STOCK_PACKET||text===TRANSACTION_PACKET,
      orphan=fault==='orphan'&&text.includes('custom-cohort-neutral-success-v2:yield')
      ||fault==='bridge_orphan'&&text.includes('custom-cohort-cache-stock-v2:complete')
      ||['partition_orphan','catalog_orphan','union_orphan','eligibility_orphan'].includes(fault)&&text.includes('custom-cohort-v2-continuation:yield');
    if(orphan)await raw.query('SAVEPOINT synthetic_neutral_yield');
    if(fault==='wait_missing'&&text.includes('custom-cohort-group-workspace:read')){fault=null;
      await raw.query("DELETE FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'",[scope.assignment_file_id]);}
    const result=await raw.query(c);
    if(originalPacket)stockReads++;
    if(orphan){fault=null;await raw.query('ROLLBACK TO SAVEPOINT synthetic_neutral_yield');await raw.query('RELEASE SAVEPOINT synthetic_neutral_yield');}
    if(['wait_workspace','intent_workspace','union_workspace','transaction_workspace'].includes(fault)&&originalPacket){fault=null;await raw.query(`UPDATE app.custom_appraisal_workfile_sections
      SET section_value=jsonb_set(section_value,'{pending_capture,operation_id}',to_jsonb($2::text))
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`,[scope.assignment_file_id,randomUUID()]);}
    if(fault==='role'&&text===SQL.insert||['bridge_role','partition_role','catalog_role','wait_role','intent_role','union_role','transaction_role'].includes(fault)&&originalPacket){fault=null;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);}
    if(['ack','bridge_ack','partition_ack','catalog_ack','wait_ack','intent_ack','union_ack','eligibility_ack','transaction_ack'].includes(fault)&&text==='COMMIT'){fault=null;throw Error('lost actual original owner COMMIT ACK');}
    return result;
  }};}},service=createCustomCohortContextCapture({pool:observed,sourceMode:'combined-witness2-v1',authorizeMarketData}),
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
  const adopted=(await Promise.all([1,2].map(()=>tx(pool,client=>bridgeClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(adopted.length,1);const adoptedClaim=adopted[0].claim;
  assert.equal(adoptedClaim.attempts,3);assert.notEqual(adoptedClaim.claim_token,complete.issued_claim_token);
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
  fault='bridge_orphan';await assert.rejects(service.continueCoveredOriginalFrozenCaptureJobStockTraversalReferencesV2(input,{captureJobClaim:adoptedClaim}),
    error=>error.outcome_unknown===true&&error.code==='55000');
  assert.equal(fault,null);assert.equal(await stockHead(),undefined);assert.deepEqual(await parent(),adoptedParent);
  assert.equal((await parent()).sequence,parentBefore.sequence);assert.deepEqual(await bridgeState(),adoptedState);
  await tx(pool,client=>jobs(client).failClaim(adoptedClaim,'capture_failed',{retrySeconds:1}));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  fault='bridge_role';assert.equal((await runBridge(args)).reason,'access_revoked');assert.equal(fault,null);
  assert.equal(await stockHead(),undefined);assert.equal((await job()).attempts,4);
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  fault='bridge_ack';assert.equal((await runBridge(args)).status,'outcome_unknown');assert.equal(fault,null);
  const firstStock=await stockHead(),issuedBridge=await bridgeState();
  assert.equal(firstStock.sequence,1);assert.deepEqual(issuedBridge.completed_reference,firstStock.receipt_reference);
  assert.equal((await parent()).sequence,parentBefore.sequence+1);assert.equal((await parent()).phase,'frozen_stock_traversal_refs_v2');
  assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
  assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  assert.deepEqual(await runBridge(args),{status:'idle'});assert.deepEqual(await runCache(args),{status:'idle'});
  for(let i=0;i<2;i++){
    const result=await runStock(args);assert.equal(result.status,'continuation_pending');assert.equal(result.operation_id,operation);
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
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
  assert.equal(partitionClaim.attempts,5);assert.equal(partitionAdoption[0].progress_done,true);
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
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
  }
  assert.equal((await partitionHead()).sequence,3);assert.equal((await partitionRows()).length,2);
  assert.equal((await parent()).sequence,parentBefore.sequence+6);
  const terminalPartition=await job();assert.deepEqual(await runPartition(args),{status:'idle'});
  assert.deepEqual(await job(),terminalPartition);assert.deepEqual(await bridgeState(),issuedBridge);
  assert.deepEqual(await cacheState(),complete);assert.deepEqual(await head(),nativeHead);
  const catalogAdoption=(await Promise.all([1,2].map(()=>tx(pool,client=>catalogClaims(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(catalogAdoption.length,1);const nextOwner=catalogAdoption[0];assert.equal(nextOwner.claim.operation_id,operation);
  assert.equal(nextOwner.claim.attempts,5);assert.equal(nextOwner.progress_done,true);
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
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
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
    ownerCalls++;selectionWaitOwner={claim:options.captureJobClaim};waitOptions={captureJobClaim:selectionWaitOwner.claim};
    assert.equal(selectionWaitOwner.claim.operation_id,operation);assert.equal(selectionWaitOwner.claim.attempts,5);
    const expectedGroups=new Map();let catalogCursor='';
    for(let i=0;i<3;i++){
    const packet=await service.readCoveredOriginalFrozenCaptureJobRecordedCatalogAccountReferencesV2(input,
      {captureJobClaim:selectionWaitOwner.claim,stockAccountPackagePage:{cursor:catalogCursor}});
    assert.equal(packet.end_of_accounts,i===2);assert.equal(packet.status,'original_reconciled_recorded_catalog_account');
    assert.equal(packet.complete_catalog_original_replay,false);
    if(packet.account_id!==null){
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

    fault='wait_ack';return service[waitMethod](value,options);
  }}};
  const waitResults=await Promise.all([runWait(waitArgs),runWait(waitArgs)]);
  assert.deepEqual(waitResults.map(r=>r.status).sort(),['idle','outcome_unknown']);
  assert.equal(ownerCalls,1);assert.equal(fault,null);
  const waiting=await job();assert.equal(waiting.status,'awaiting_selection');assert.equal(waiting.claim_token,null);assert.equal(waiting.lease_expires_at,null);
  assert.equal(waiting.attempts,5);assert.equal(waiting.last_error_code,'access_revoked');assert.deepEqual(waiting.checkpoint,beforeWait.checkpoint);
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
  assert.equal(resumed.claim.claim_token,command.resume_claim_token);assert.equal(resumed.claim.attempts,5);
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
  assert.equal(dispatches[0].claim_token,resumed.claim.claim_token);assert.equal(dispatches[0].attempts,5);
  assert.equal(dispatches[0].command_id,selectionIntent.command_id);assert.equal(dispatches[0].actor_user_id,actor);
  assert.equal(fault,null);assert.equal((await unionHead()).sequence,1);
  assert.deepEqual(await runSelectedInitial(args),{status:'idle'});
  for(let i=0;i<2;i++){
    let enter,release;
    const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
    const progressArgs={...args,cohortService:{...service,async [unionMethod](value,options){
    assert.equal(options.captureJobClaim.attempts,5);assert.notEqual(options.captureJobClaim.claim_token,resumed.claim.claim_token);
    enter();await held;
    const progress=await service[unionMethod](value,options);
    assert.equal(progress.covered_neutral_originals,true);assert.equal(progress.complete_catalog_original_replay,i===1);
    assert.equal(progress.complete_distinct_selected_stock_union,i===1);assert.equal(progress.selected_stock_accounts,2);
    assert.equal(progress.context_complete,false);assert.equal(progress.pin_transfer,false);
    assert.equal((await job()).last_error_code,'access_revoked');
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
  eligibilityCalls++;assert.equal(options.captureJobClaim.attempts,5);
  const eligibilityBefore=await job(),unionBefore=await unionHead(),nativeGroupsBefore=await unionGroups(),
    eligibilityOwner={claim:options.captureJobClaim};
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
  assert.equal(fault,null);assert.equal((await eligibilityHead()).sequence,1);assert.equal((await job()).attempts,5);
  assert.equal((await job()).last_error_code,'access_revoked');assert.deepEqual(await intents(),humanOwnedIntents);
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
    assert.equal((await job()).attempts,5);assert.equal((await job()).last_error_code,'access_revoked');
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
  assert.equal(laterOwner.claim.operation_id,operation);assert.equal(laterOwner.claim.attempts,5);
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
    global_header_still_building:true,nonempty_selected_metric_population:false,CAD_companion:false,
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
    nonempty_selected_metric_population:false,CAD_companion:false,complete_semantics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-nonempty-selection-v2]',{explicit_fixture_assigned_and_unassigned_groups:2,
    actual_distinct_selected_stock_accounts:2,complete_native_union_rows_match_entire_fixture_stock:true,
    native_union_entry_and_partition_ordinals_one_and_two:true,complete_catalog_group_counts_replayed_from_every_original:true,
    actual_worker_eligibility_originals_at_selected_ordinals_one_and_two_plus_fresh_EMPTY:true,
    native_eligibility_sequence_three_and_terminal_selected_ordinal_two:true,immutable_human_command_and_failure_history_preserved:true,
    original_native_parents_workspace_reports_and_pins_preserved:true,global_header_still_building:true,
    nonempty_selected_metric_population:false,CAD_companion:false,complete_semantics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-first-selected-transactions-v2]',{server_owned_first_native_selected_ordinal_one:true,
    actual_whole_stock_subject_all_date_transaction_originals_and_entire_cache_reopened:true,
    entire_partition_catalog_and_immutable_human_command_reconciled:true,native_packages_and_original_counts_retained_without_truncation:true,
    real_ending_workspace_and_role_refusal:true,lost_actual_readonly_COMMIT_ACK_fresh_reopen_identical:true,
    no_job_head_union_groups_intent_workspace_or_lease_mutation:true,one_existing_original_query_transport_and_runtime_budget:true,
    global_header_still_building:true,separate_CAD_companion:false,economic_equivalence:false,
    complete_selected_union_transactions:false,calendar_quarters:false,statistics:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selected-initial-worker-v2]',{missing_human_command_idle_without_claim:true,
    actual_expired_adoption_real_COMMIT_refused_and_rolled_back:true,concurrent_single_real_human_resume_adoption:true,
    original_human_token_attempt_command_and_actor_preserved:true,actual_DB_actor_saved_request_and_covered_original_owner:true,
    every_original_entire_cache_partition_catalog_replayed:true,ending_workspace_and_role_atomic_rollback:true,
    orphan_union_yield_real_COMMIT_refused:true,lost_actual_union_COMMIT_ACK_not_downgraded:true,
    successful_first_union_at_failure_ceiling:5,error_history_native_parents_and_human_choice_preserved:true,
    adoption_exactly_once_and_later_selected_owner_including_expired_cancelled_untouched:true,
    global_header_still_building:true,nonempty_selected_metric_population:false,CAD_companion:false,
    default_worker_activation:false,licensed_large_area:false,production_speed:false,publication:false,pin_transfer:false});
  console.info('[native-covered-selected-progress-worker-v2]',{actual_native_fresh_union_claim_for_each_original_and_EMPTY:true,
    concurrent_worker_idle_at_real_owner_live_lease:true,success_at_failure_ceiling:5,error_history_and_immutable_command_preserved:true,
    complete_original_cache_partition_catalog_reconciliation:true,union_DONE_routes_actual_recorded_eligibility_owner:true,
    subject_and_first_eligibility_readonly_under_actual_worker_claim:true,orphan_eligibility_yield_actual_COMMIT_refused:true,
    lost_real_eligibility_COMMIT_ACK_not_downgraded:true,eligibility_DONE_repeated_idle:true,
    later_owner_including_expired_cancelled_claim_and_expiry_untouched:true,original_native_parents_and_pins_preserved:true,
    global_header_still_building:true,nonempty_selected_metric_population:false,CAD_companion:false,
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
}
