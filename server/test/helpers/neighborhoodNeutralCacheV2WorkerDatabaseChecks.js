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

/** Independent disposable job; all acquisition owners, authorization, original
 * queries, native issuance, savepoint rollback and COMMITs are real. */
export async function runNeighborhoodNeutralCacheV2WorkerDatabaseChecks({pool,input:sourceInput,scope,actor,authorizeMarketData}){
  const input={...sourceInput,operationId:randomUUID()},operation=input.operationId;let fault=null;
  const observed={async connect(){const raw=await pool.connect();return {release:raw.release.bind(raw),async query(c){
    const text=typeof c==='string'?c:c.text,orphan=fault==='orphan'&&text.includes('custom-cohort-neutral-success-v2:yield');
    if(orphan)await raw.query('SAVEPOINT synthetic_neutral_yield');
    const result=await raw.query(c);
    if(orphan){fault=null;await raw.query('ROLLBACK TO SAVEPOINT synthetic_neutral_yield');await raw.query('RELEASE SAVEPOINT synthetic_neutral_yield');}
    if(fault==='role'&&text===SQL.insert){fault=null;await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);}
    if(fault==='ack'&&text==='COMMIT'){fault=null;throw Error('lost actual neutral original owner COMMIT ACK');}
    return result;
  }};}},service=createCustomCohortContextCapture({pool:observed,sourceMode:'combined-witness2-v1',authorizeMarketData}),
    args={pool,cohortService:service,leaseSeconds:900},job=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0],
    cacheState=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs WHERE operation_id=$1',[operation])).rows[0],
    head=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=$1',[operation])).rows[0],
    parent=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=$1',[operation])).rows[0],
    protectedRows=async()=>({report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
      assignment:(await pool.query('SELECT to_jsonb(a) AS body FROM app.assignment_files a WHERE id=$1',[scope.assignment_file_id])).rows});
  const protectedBefore=await protectedRows();
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
  await tx(pool,client=>jobs(client).cancel(scope,operation));const cancelled=await job();
  assert.deepEqual(await runCache(args),{status:'idle'});assert.deepEqual(await job(),cancelled);
  assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
  assert.deepEqual(await protectedRows(),protectedBefore);
  console.info('[native-neutral-cache-success-worker-v2]',{prefix_steps:prefixSteps,early_steps:earlySteps,cache_pages:complete.sequence,
    actual_original_and_complete_cache_owners:true,orphan_real_claim_and_owner_yield_COMMIT_refused:true,
    concurrent_single_fresh_initial_claim:true,lost_real_cache_owner_COMMIT_ACK:true,ending_role_cache_head_rollback:true,
    preserved_failure_history_attempt:3,expired_same_token_revival_refused:true,old_consumed_token_refused:true,
    generic_main_cannot_steal_identity_DONE:true,main_continuation_sequence_unchanged:true,cache_DONE_recovery_and_next_owner_claim_excluded:true,
    reports_assignment_and_pin_unchanged:true,reader_handoff:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
