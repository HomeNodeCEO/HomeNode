import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortInitialV2JobRepository as initial } from '../../src/services/neighborhoodAssessment/customCohortInitialV2JobRepository.js';
import { runCustomCohortInitialV2JobOnce as runInitial } from '../../src/services/neighborhoodAssessment/customCohortInitialV2JobWorker.js';
import { runCustomCohortSourcePrefixV2JobOnce as runPrefix } from '../../src/services/neighborhoodAssessment/customCohortSourcePrefixV2JobWorker.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

/** Disposable native fixture only. Every owner/source read and COMMIT is real;
 * injected lost acknowledgments occur strictly after PostgreSQL COMMIT. */
export async function runNeighborhoodInitialV2DispatchDatabaseChecks({pool,input:sourceInput,scope,actor,authorizeMarketData}){
  const input={...sourceInput,operationId:randomUUID()},operation=input.operationId,calls=[];
  let fault=null;
  const observedPool={async connect(){const client=await pool.connect();return{release:client.release.bind(client),async query(config){
    const text=typeof config==='string'?config:config.text;calls.push(text);
    const result=await client.query(config);
    if(text.includes('custom-cohort-initial-v2:enrollment */')&&fault==='queue_role'){
      fault=null;await client.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
    }
    if(text==='COMMIT'&&fault==='commit'){fault=null;throw Error('lost actual initial owner COMMIT ACK');}
    return result;
  }};}};
  const service=createCustomCohortContextCapture({pool:observedPool,sourceMode:'combined-witness2-v1',authorizeMarketData});
  const run=()=>runInitial({pool,cohortService:service,leaseSeconds:900});
  const job=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1',[operation])).rows[0];
  const enrollment=async()=>(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_initial_v2_jobs WHERE operation_id=$1',[operation])).rows[0];
  const protectedRows=async()=>({report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    assignment:(await pool.query('SELECT to_jsonb(a) AS body FROM app.assignment_files a WHERE id=$1',[scope.assignment_file_id])).rows});
  const beforeProtected=await protectedRows(),request={operation_id:operation,observation_period:input.observationPeriod,
    discovery:input.discovery,execution_mode:'frozen-originals-v2'};
  await assert.rejects(tx(pool,client=>jobs(client).enqueue({scope,actorUserId:actor,request})),
    error=>error.code==='55000'&&/initial_v2_enrollment_required/.test(error.message));
  assert.equal(await job(),undefined,'a request marker alone cannot commit native queue authority');
  fault='queue_role';await assert.rejects(service.queueFrozenOriginalCaptureJobV2(input),/job_actor_access_revoked/);
  assert.equal(fault,null);assert.equal(await job(),undefined);assert.equal(await enrollment(),undefined);
  fault='commit';await assert.rejects(service.queueFrozenOriginalCaptureJobV2(input),error=>error.outcome_unknown===true);
  assert.equal((await job()).status,'queued');assert.equal((await job()).attempts,0);
  await service.queueFrozenOriginalCaptureJobV2(input);const queued=await job(),enrolled=await enrollment();
  assert.equal(queued.checkpoint,null);assert.equal(enrolled.claim_token,null);assert.equal(enrolled.attempts,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows[0].n,0);
  assert.deepEqual(await tx(pool,client=>jobs(client).claimDue({leaseSeconds:900})),[]);
  assert.deepEqual(await job(),queued);
  await assert.rejects(tx(pool,client=>client.query(`UPDATE app.neighborhood_custom_cohort_initial_v2_jobs
    SET claim_token=gen_random_uuid(),attempts=1 WHERE operation_id=$1`,[operation])),
  error=>error.code==='55000'&&/initial_v2_commit_conflict/.test(error.message));
  assert.deepEqual(await enrollment(),enrolled);
  await assert.rejects(tx(pool,client=>client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
    SET status='running',attempts=1,claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '900 seconds'
    WHERE operation_id=$1`,[operation])),error=>error.code==='55000'&&/initial_v2_claim_conflict/.test(error.message));
  const claimed=(await Promise.all([1,2].map(()=>tx(pool,client=>initial(client).claimDue({leaseSeconds:900}))))).flat();
  assert.equal(claimed.length,1);const firstClaim=claimed[0].claim;assert.equal(firstClaim.attempts,1);
  const beforeExpiredReplay=await job();
  await assert.rejects(tx(pool,async client=>{
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
    await client.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()+interval '900 seconds' WHERE operation_id=$1",[operation]);
  }),error=>error.code==='55000'&&/initial_v2_claim_conflict/.test(error.message));
  assert.deepEqual(await job(),beforeExpiredReplay,'an expired initial running token requires a native fresh claim');
  // Actual revoked DB identity refuses the original stock owner. Settling the
  // genuine failed claim preserves the ordinary history for later successes.
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  const deniedAt=calls.length;
  await assert.rejects(service.prepareFrozenCaptureJobStock(input,{captureJobClaim:firstClaim}),/job_actor_access_revoked/);
  assert.ok(!calls.slice(deniedAt).some(sql=>/job-stock:|neighborhood-frozen-job-closure:/.test(sql)));
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);
  await tx(pool,client=>jobs(client).failClaim(firstClaim,'access_revoked',{retrySeconds:1}));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  await assert.rejects(tx(pool,client=>client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
    SET status='running',claim_token=$2,lease_expires_at=clock_timestamp()+interval '900 seconds' WHERE operation_id=$1`,[operation,firstClaim.claim_token])),
  error=>error.code==='55000'&&/initial_v2_claim_conflict/.test(error.message));
  fault='commit';const stockLost=await run();assert.equal(stockLost.status,'retry');assert.equal(stockLost.reason,'capture_failed');
  const stock=await job();assert.equal(stock.attempts,2);assert.equal(stock.checkpoint.phase,'frozen_stock_v1');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=$1',[operation])).rows[0].n,0);
  const pin=(await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows;
  assert.equal(pin.length,1);
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  const reuseAt=calls.length;fault='commit';
  // The first owner COMMIT here is the reopened stock. Lose that ACK again,
  // proving a fresh failure cannot repeat preparation or consume prefix work.
  assert.equal((await run()).status,'retry');assert.equal((await job()).attempts,3);
  assert.ok(!calls.slice(reuseAt).some(sql=>/job-stock:begin|frozen-spatial:counts|ST_DWithin/.test(sql)));
  await pool.query('UPDATE app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp() WHERE operation_id=$1',[operation]);
  assert.equal((await run()).status,'continuation_pending');
  const prefix=await job();assert.equal(prefix.attempts,4);assert.equal(prefix.last_error_code,'capture_failed');
  assert.equal(prefix.status,'retry');assert.equal(prefix.checkpoint.phase,'frozen_source_refs_v2');
  assert.deepEqual(await run(),{status:'idle'});assert.deepEqual(await tx(pool,client=>jobs(client).claimDue({leaseSeconds:900})),[]);
  let successful=0;for(let step=0;step<12;step++){
    const result=await runPrefix({pool,cohortService:service,leaseSeconds:900});if(result.status==='idle')break;
    assert.equal(result.status,'continuation_pending');successful++;
  }
  assert.equal(successful,7,'six remaining original prefix pages then first original graph page');
  const graph=await job();assert.equal(graph.checkpoint.phase,'frozen_verify_refs_v2');assert.equal(graph.attempts,4);
  assert.equal(graph.last_error_code,'capture_failed');assert.equal(graph.context_sha256,null);
  const [next]=await tx(pool,client=>continuations(client).claimDue({limit:1,leaseSeconds:900}));assert.ok(next);
  await tx(pool,client=>jobs(client).cancel(scope,operation));
  await pool.query("UPDATE app.neighborhood_custom_cohort_capture_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation]);
  const nextOwner=await job();assert.deepEqual(await run(),{status:'idle'});
  assert.deepEqual(await tx(pool,client=>jobs(client).claimDue({leaseSeconds:900})),[]);
  assert.deepEqual(await job(),nextOwner,'initial and generic expiry cannot retire the next owner');
  assert.deepEqual((await pool.query('SELECT * FROM app.neighborhood_custom_cohort_prepared_generation_pins WHERE operation_id=$1',[operation])).rows,pin);
  assert.deepEqual(await protectedRows(),beforeProtected);
  console.info('[native-initial-original-dispatch-v2]',{pristine_queue_and_native_enrollment:true,orphan_enrollment_and_claim_COMMIT_refused:true,
    queue_ending_revocation_rollback:true,lost_real_queue_and_stock_COMMIT_ACKs:3,stock_reopened_without_repreparation:true,
    concurrent_single_fresh_claim:true,old_token_replay_refused:true,expired_running_token_revival_refused:true,generic_claim_and_expiry_excluded:true,
    actual_stock_prefix_graph_owners:true,prefix_pages:7,graph_steps:1,preserved_failure_attempt:4,
    next_owner_cancelled_expired_claim_untouched:true,reports_assignment_and_pin_unchanged:true,
    neutral_cache_handoff:false,licensed_large_area:false,production_speed:false,pin_transfer:false});
}
