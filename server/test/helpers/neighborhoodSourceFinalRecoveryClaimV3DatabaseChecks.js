import { runNeighborhoodRecoveredFirstSourceOriginalV3DatabaseChecks } from './neighborhoodRecoveredFirstSourceOriginalV3DatabaseChecks.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCustomCohortSourceFinalRecoveryClaimV3Repository as recoveries }
  from '../../src/services/neighborhoodAssessment/customCohortSourceFinalRecoveryClaimV3Repository.js';
import { createCustomCohortCaptureJobRepository as jobs }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortFirstSourceClaimV3Repository as initialClaims }
  from '../../src/services/neighborhoodAssessment/customCohortFirstSourceClaimV3Repository.js';
import { createCustomCohortV2ContinuationRepository as continuations }
  from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as transaction }
  from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

const jobTable='app.neighborhood_custom_cohort_capture_jobs',
  table='app.neighborhood_custom_cohort_source_resolution_v3_recoveries';
// Run LAST on each additional independently acquired A/B graph, AFTER all
// original18/real retry4 COMMIT/whole-row/old-queue refusal proofs. No free facts.
export async function runNeighborhoodSourceFinalRecoveryClaimV3DatabaseChecks({pool,input,scope,actor,service,
  claim:oldClaim,originalReads,laterFirstSource,setFault,readFault}){
  const op=input.operationId,read=async name=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${name} r
    WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[op])).rows,
    job=async()=>(await read('neighborhood_custom_cohort_capture_jobs'))[0].body,
    recoveryRows=()=>read('neighborhood_custom_cohort_source_resolution_v3_recoveries');
  await transaction(pool,async c=>{
    assert.match((await c.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await c.query(readFileSync(new URL('../../migrations/20261229_custom_cohort_source_final_recovery_claim_v3.sql',import.meta.url),'utf8'));
    const events=(await c.query(`SELECT tgname,tgdeferrable,tginitdeferred,tgenabled FROM pg_trigger
      WHERE tgname IN ('neighborhood_source_resolution_v3_parent_commit','neighborhood_source_resolution_v3_first_commit',
        'neighborhood_source_resolution_v3_row_commit','neighborhood_source_resolution_v3_head_commit',
        'neighborhood_source_resolution_v3_first_checkpoint_commit','neighborhood_source_resolution_v3_first_handoff_commit',
        'neighborhood_source_resolution_v3_first_claim_commit','neighborhood_source_resolution_v3_terminal_failure_commit',
        'neighborhood_source_resolution_v3_last_retry_commit','neighborhood_source_resolution_v3_recovery_commit')`)).rows;
    assert.equal(events.length,10);assert.ok(events.every(e=>e.tgdeferrable&&e.tginitdeferred&&e.tgenabled==='O'));
  });
  const parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
      AND c.table_name NOT IN ('neighborhood_custom_cohort_capture_jobs','neighborhood_custom_cohort_source_resolution_v3_recoveries')
    ORDER BY c.table_name`)).rows.map(r=>r.table_name);
  assert.ok(parentNames.length>10&&parentNames.every(n=>/^[a-z_][a-z0-9_]*$/.test(n)));
  const immutable=async()=>({parents:await Promise.all(parentNames.map(read)),
    blobs:(await pool.query(`SELECT to_jsonb(b) AS body FROM app.neighborhood_cohort_evidence_blobs b
      WHERE organization_id=$1 ORDER BY content_sha256`,[scope.organization_id])).rows,
    report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    assignment:(await pool.query('SELECT to_jsonb(r) AS body FROM app.assignment_files r WHERE id=$1',[scope.assignment_file_id])).rows,
    subject_snapshot:(await pool.query(`SELECT to_jsonb(s) AS body FROM app.appraisal_subject_snapshots s
      JOIN app.report_files r ON r.subject_snapshot_id=s.id WHERE r.id=$1 AND r.organization_id=$2`,[scope.report_file_id,scope.organization_id])).rows,
    subject_sections:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows,
    workspace:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows}),
    before={job:await job(),immutable:await immutable()},
    failure=(await read('neighborhood_custom_cohort_source_resolution_v3_last_retries'))[0].body,
    initial=(await read('neighborhood_custom_cohort_source_resolution_v3_claims'))[0].body,
    parent=await read('neighborhood_custom_cohort_source_resolution_v3_parents'),
    first=await read('neighborhood_custom_cohort_source_resolution_v3_first');
  assert.equal(before.job.status,'retry');assert.equal(before.job.attempts,4);assert.equal(before.job.last_error_code,'access_revoked');
  assert.equal(before.job.checkpoint.evidence_refs.length,18);assert.equal(before.job.claim_token,null);
  assert.equal(failure.claimed_job.claim_token,oldClaim.claim_token);assert.deepEqual(await recoveryRows(),[]);
  const unchanged=async()=>{assert.deepEqual(await job(),before.job);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await recoveryRows(),[]);};
  for(const [fn,expected]of [['retry_parent',parent],['retry_first',first]])assert.deepEqual((await transaction(pool,
    c=>c.query(`SELECT to_jsonb(p) AS body FROM app.neighborhood_source_resolution_v3_${fn}($1,$2) p`,[op,scope.organization_id]))).rows,expected);
  const columns=['operation_id','organization_id','preclaim_job','claim_token','attempts','issued_at','lease_seconds',
    'lease_expires_at','retry_transaction_id','issued_transaction_id'],
    values={operation_id:'job.operation_id',organization_id:'job.organization_id',preclaim_job:'to_jsonb(job)',
      claim_token:'gen_random_uuid()',attempts:'job.attempts+1',issued_at:'stamp.at',lease_seconds:'120',
      lease_expires_at:"stamp.at+interval '120 seconds'",retry_transaction_id:'failure.issued_transaction_id',issued_transaction_id:'txid_current()'},
    orphan=(change={})=>`INSERT INTO ${table} (${columns.join(',')})
      SELECT ${columns.map(k=>change[k]??values[k]).join(',')} FROM ${jobTable} job
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_last_retries failure USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_claims initial USING(operation_id,organization_id)
      CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE job.operation_id=$1::uuid) stamp
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid`;
  for(const change of [{preclaim_job:"jsonb_set(to_jsonb(job),'{attempts}','3')"},
    {preclaim_job:"jsonb_set(to_jsonb(job),'{last_error_code}','\"forged\"')"},
    {organization_id:'gen_random_uuid()'},{claim_token:'initial.claim_token'},{attempts:'4'},{attempts:'6'},
    {retry_transaction_id:'failure.issued_transaction_id+1'},{issued_transaction_id:'failure.issued_transaction_id'},
    {lease_seconds:'14'},{lease_seconds:'901'},{lease_expires_at:"stamp.at+interval '121 seconds'"}]){
    await assert.rejects(transaction(pool,c=>c.query(orphan(change),[op,scope.organization_id])),/actual_recovery_required/);
    await unchanged();
  }
  // Valid immutable record alone must fail at its actual PostgreSQL COMMIT.
  await assert.rejects(transaction(pool,c=>c.query(orphan(),[op,scope.organization_id])),
    e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_source_resolution_v3_recovery_conflict');
  await unchanged();
  // A complete tentative native claim is rolled back, preserving the entire
  // prior retry and all actual parents before testing competing real commits.
  await assert.rejects(transaction(pool,async c=>{
    const rows=await recoveries(c).claimDue({limit:1,leaseSeconds:120});assert.equal(rows.length,1);
    assert.equal(rows[0].claim.attempts,5);assert.equal(rows[0].authority,'not_established');
    assert.equal((await c.query(`SELECT * FROM app.neighborhood_source_resolution_v3_recovered_first($1,$2,$3,$4)`,
      [op,scope.organization_id,rows[0].claim.claim_token,5])).rowCount,1);
    throw Error('native_final_recovery5_explicit_ROLLBACK');
  }),/explicit_ROLLBACK/);await unchanged();
  let winner=null,actualLostCommit=false;
  const compete=async()=>{
    let won=false;
    const ownerPool=laterFirstSource?{async connect(){const raw=await pool.connect();
      return {on:(...a)=>raw.on(...a),off:(...a)=>raw.off(...a),release:e=>raw.release(e),
        async query(config,params){const r=await raw.query(config,params);
          if((typeof config==='string'?config:config.text)==='COMMIT'&&won){
            actualLostCommit=true;throw Error('native_final_recovery5_real_COMMIT_ack_lost');
          }return r;}};}}:pool;
    return transaction(ownerPool,async c=>{
      const rows=await recoveries(c).claimDue({limit:1,leaseSeconds:120});
      if(rows.length){assert.equal(winner,null);winner=rows[0];won=true;}return rows;
    });
  };
  const results=await Promise.allSettled([compete(),compete()]);
  const successful=results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value),failed=results.filter(r=>r.status==='rejected');
  if(laterFirstSource){assert.equal(successful.length,0);assert.equal(failed.length,1);assert.equal(actualLostCommit,true);
    assert.equal(failed[0].reason.outcome_unknown,true);assert.match(failed[0].reason.message,/real_COMMIT_ack_lost/);}
  else{assert.equal(failed.length,0);assert.deepEqual(successful,[winner]);}
  assert.equal(winner.claim.attempts,5);assert.equal(winner.authority,'not_established');
  assert.equal(winner.actor_user_id,actor);assert.deepEqual(winner.scope,scope);
  assert.notEqual(winner.claim.claim_token,oldClaim.claim_token);
  const durable=(await recoveryRows())[0].body,recovered=await job();
  assert.deepEqual(durable.preclaim_job,before.job);assert.equal(durable.retry_transaction_id,failure.issued_transaction_id);
  assert.notEqual(durable.issued_transaction_id,durable.retry_transaction_id);assert.equal(durable.attempts,5);
  assert.notEqual(durable.claim_token,initial.claim_token);assert.equal(durable.lease_seconds,120);
  assert.deepEqual(recovered,{...before.job,status:'running',claim_token:durable.claim_token,attempts:5,
    lease_expires_at:durable.lease_expires_at,updated_at:durable.issued_at});assert.deepEqual(await immutable(),before.immutable);
  const ownedRead=(fn,org=scope.organization_id,token=winner.claim.claim_token,attempt=5)=>transaction(pool,c=>c.query(
    `SELECT to_jsonb(p) AS body FROM app.neighborhood_source_resolution_v3_${fn}($1,$2,$3,$4) p`,[op,org,token,attempt]));
  for(const [fn,expected]of [['recovered_parent',parent],['recovered_first',first]]){
    assert.deepEqual((await ownedRead(fn)).rows,expected);
    for(const args of [[randomUUID()],[scope.organization_id,oldClaim.claim_token],
      [scope.organization_id,winner.claim.claim_token,4],[scope.organization_id,winner.claim.claim_token,6]])
      assert.deepEqual((await ownedRead(fn,...args)).rows,[]);
  }
  const preserved=async()=>{assert.deepEqual(await job(),recovered);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await recoveryRows(),[{body:durable}]);};
  for(const sql of [`UPDATE ${table} SET attempts=attempts WHERE operation_id=$1`,`DELETE FROM ${table} WHERE operation_id=$1`]){
    await assert.rejects(transaction(pool,c=>c.query(sql,[op])),/recovery_immutable/);await preserved();
  }
  await assert.rejects(transaction(pool,c=>c.query(`TRUNCATE ${table}`)),/immutable/);await preserved();
  for(const owner of [recoveries,jobs,initialClaims,continuations]){
    assert.deepEqual(await transaction(pool,c=>owner(c).claimDue({limit:1,leaseSeconds:120})),[]);await preserved();
  }
  const originalCount=originalReads();
  for(const claim of [oldClaim,winner.claim])await assert.rejects(
    service.readCoveredOriginalFrozenCaptureJobOwnedFirstSourceReferencesV3(input,{captureJobClaim:claim}),/claim_lost/);
  assert.equal(originalReads(),originalCount);await preserved();
  console.info('[native-owned18-final-recovery4-to5-claim-COMMIT-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_due_retry4_native_normal_failure_consumed_once_and_final_attempt5_spent:true,
    entire_actual_retry_tuple_and_initial4_claim_original17_birth_last_retry_full_FIRST_graph_retained:true,
    all_ten_deferred_events_enabled_and_genuine_orphan_COMMIT_rejected_full_rollback:true,
    two_native_recoverers_one_committed_fresh5_and_actual_explicit_complete_tentative_ROLLBACK:true,
    actual_lost_winning_recovery_COMMIT_ACK:!!laterFirstSource,
    only_status_token_attempt_lease_update_change_error_schedule_checkpoint_and_all_history_preserved:true,
    complete_recovered_parent_and_independent_native_FIRST_member_edge_reopened:true,
    no_sixth_duplicate_generic_oldqueue_adoption_or_stale_original_IO:true,
    every_prior_native_row_blob_report_assignment_subject_manual_workspace_choice_pin_unchanged:true,
    source_authority:'not_established',fresh5_original_replay:false,lower1_through3:false,
    expired_recovery:false,NEXT_or_EMPTY:false,publication:false,pin_transfer:false,
    activation:false,licensed_large_area:false,production_speed:false});
  const history=(await pool.query('SELECT birth_transaction_id::text FROM app.neighborhood_custom_cohort_source_resolution_v3_claims WHERE operation_id=$1 AND organization_id=$2',[op,scope.organization_id])).rows[0];
  await runNeighborhoodRecoveredFirstSourceOriginalV3DatabaseChecks({pool,input,scope,actor,service,claim:winner.claim,
    originalReads,laterFirstSource,setFault,readFault,unchanged:preserved,originalBirthTransaction:history.birth_transaction_id,
    retryTransaction:String(durable.retry_transaction_id),recoveryTransaction:String(durable.issued_transaction_id)});
}
