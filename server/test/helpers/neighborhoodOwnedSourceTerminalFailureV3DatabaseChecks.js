import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCustomCohortOwnedSourceTerminalFailureV3Repository as failures }
  from '../../src/services/neighborhoodAssessment/customCohortOwnedSourceTerminalFailureV3Repository.js';
import { createCustomCohortCaptureJobRepository as jobs }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortFirstSourceClaimV3Repository as claims }
  from '../../src/services/neighborhoodAssessment/customCohortFirstSourceClaimV3Repository.js';
import { createCustomCohortV2ContinuationRepository as continuations }
  from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as transaction }
  from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

const jobTable='app.neighborhood_custom_cohort_capture_jobs',
  failureTable='app.neighborhood_custom_cohort_source_resolution_v3_final_failures';
// Run LAST, only after the actual independent A/B birth, claim and whole-original
// owned18 proofs. No copied native parents, lease/attempt rewrite or free facts.
export async function runNeighborhoodOwnedSourceTerminalFailureV3DatabaseChecks({pool,input,scope,actor,service,claim,
  originalReads,laterFirstSource,setFault,readFault}){
  const op=input.operationId,read=async table=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r
    WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[op])).rows,
    job=async()=>(await read('neighborhood_custom_cohort_capture_jobs'))[0].body,
    failureRows=()=>read('neighborhood_custom_cohort_source_resolution_v3_final_failures');
  await transaction(pool,async c=>{
    assert.match((await c.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await c.query(readFileSync(new URL('../../migrations/20261227_custom_cohort_source_owned_terminal_failure_v3.sql',import.meta.url),'utf8'));
    const events=(await c.query(`SELECT tgname,tgdeferrable,tginitdeferred,tgenabled FROM pg_trigger
      WHERE tgname IN ('neighborhood_source_resolution_v3_parent_commit','neighborhood_source_resolution_v3_first_commit',
        'neighborhood_source_resolution_v3_row_commit','neighborhood_source_resolution_v3_head_commit',
        'neighborhood_source_resolution_v3_first_checkpoint_commit','neighborhood_source_resolution_v3_first_handoff_commit',
        'neighborhood_source_resolution_v3_first_claim_commit','neighborhood_source_resolution_v3_terminal_failure_commit')`)).rows;
    assert.equal(events.length,8);assert.ok(events.every(e=>e.tgdeferrable&&e.tginitdeferred&&e.tgenabled==='O'));
  });
  const parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
      AND c.table_name NOT IN ('neighborhood_custom_cohort_capture_jobs','neighborhood_custom_cohort_source_resolution_v3_final_failures')
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
    issued=(await read('neighborhood_custom_cohort_source_resolution_v3_claims'))[0].body;
  assert.equal(before.job.status,'running');assert.equal(before.job.attempts,5);assert.equal(before.job.claim_token,claim.claim_token);
  assert.equal(before.job.checkpoint.evidence_refs.length,18);assert.deepEqual(await failureRows(),[]);
  const unchanged=async()=>{assert.deepEqual(await job(),before.job);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await failureRows(),[]);};
  const columns=['operation_id','organization_id','claimed_job','failure_code','issued_at','claim_transaction_id','issued_transaction_id'],
    values={operation_id:'job.operation_id',organization_id:'job.organization_id',claimed_job:'to_jsonb(job)',
      failure_code:"'access_revoked'",issued_at:'stamp.at',claim_transaction_id:'issued.issued_transaction_id',issued_transaction_id:'txid_current()'},
    orphan=(change={})=>`INSERT INTO ${failureTable} (${columns.join(',')})
      SELECT ${columns.map(k=>change[k]??values[k]).join(',')} FROM ${jobTable} job
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_claims issued
        ON issued.operation_id=job.operation_id AND issued.organization_id=job.organization_id
      CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE job.operation_id=$1::uuid) stamp
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid`;
  for(const change of [{claimed_job:"jsonb_set(to_jsonb(job),'{attempts}','4')"},
    {claimed_job:"jsonb_set(to_jsonb(job),'{claim_token}',to_jsonb(gen_random_uuid()))"},
    {claim_transaction_id:'issued.issued_transaction_id+1'},{issued_transaction_id:'issued.issued_transaction_id'},
    {organization_id:'gen_random_uuid()'}]){
    await assert.rejects(transaction(pool,c=>c.query(orphan(change),[op,scope.organization_id])),/actual_terminal_failure_required/);
    await unchanged();
  }
  // Valid INSERT, actual deferred event, no paired terminal job UPDATE. The
  // real PostgreSQL COMMIT must refuse, restoring the ENTIRE actual state.
  await assert.rejects(transaction(pool,c=>c.query(orphan(),[op,scope.organization_id])),
    e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_source_resolution_v3_terminal_failure_conflict');
  await unchanged();
  const failFinal=(client,ownedClaim=claim,ownedScope=scope)=>failures({client,claim:ownedClaim,scope:ownedScope,actorUserId:actor}).failFinal('access_revoked');
  for(const [badClaim,badScope] of [[{...claim,claim_token:randomUUID()},scope],[claim,{...scope,organization_id:randomUUID()}],
    [claim,{...scope,assignment_file_id:'8'}],[claim,{...scope,account_id:'OTHER'}]]){
    await assert.rejects(transaction(pool,c=>failFinal(c,badClaim,badScope)),/claim_lost/);await unchanged();
  }
  let originalCount=originalReads();setFault('union_role');
  try{
    await assert.rejects(service.readCoveredOriginalFrozenCaptureJobOwnedFirstSourceReferencesV3(input,{captureJobClaim:claim}),
      /custom_cohort_job_actor_access_revoked/);
    assert.equal(readFault(),null);assert.equal(originalReads(),originalCount+1);await unchanged();
    // The actual ending role is revoked. Structural terminal bookkeeping may
    // close its already-owned job; it cannot authorize another original read.
    assert.equal((await pool.query(`SELECT 1 FROM app_auth.membership_roles
      WHERE organization_id=$1 AND user_id=$2 AND role_code='appraiser'`,[scope.organization_id,actor])).rowCount,0);
    let actualCommit=false;
    const ownerPool=laterFirstSource?{async connect(){const raw=await pool.connect();
      return {on:(...a)=>raw.on(...a),off:(...a)=>raw.off(...a),release:e=>raw.release(e),
        async query(config,params){const r=await raw.query(config,params);
          if((typeof config==='string'?config:config.text)==='COMMIT'){
            actualCommit=true;throw Error('native_owned_source_failure5_real_COMMIT_ack_lost');
          }return r;}};}}:pool;
    originalCount=originalReads();
    if(laterFirstSource){await assert.rejects(transaction(ownerPool,c=>failFinal(c)),
      e=>e.outcome_unknown===true&&/real_COMMIT_ack_lost/.test(e.message));assert.equal(actualCommit,true);}
    else assert.deepEqual(await transaction(ownerPool,c=>failFinal(c)),{status:'failed',attempts:5,failure_code:'access_revoked'});
    assert.equal(originalReads(),originalCount);
  }finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  const durable=(await failureRows())[0].body,failed=await job();
  assert.deepEqual(durable.claimed_job,before.job);assert.equal(durable.claim_transaction_id,issued.issued_transaction_id);
  assert.notEqual(durable.issued_transaction_id,durable.claim_transaction_id);assert.equal(durable.failure_code,'access_revoked');
  assert.deepEqual(failed,{...before.job,status:'failed',claim_token:null,lease_expires_at:null,last_error_code:'access_revoked',updated_at:durable.issued_at});
  assert.deepEqual(await immutable(),before.immutable);
  const preserved=async()=>{assert.deepEqual(await job(),failed);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await failureRows(),[{body:durable}]);};
  for(const sql of [`UPDATE ${failureTable} SET failure_code=failure_code WHERE operation_id=$1`,
    `DELETE FROM ${failureTable} WHERE operation_id=$1`]){
    await assert.rejects(transaction(pool,c=>c.query(sql,[op])),/terminal_failure_immutable/);await preserved();
  }
  await assert.rejects(transaction(pool,c=>c.query(`TRUNCATE ${failureTable}`)),/immutable/);await preserved();
  await assert.rejects(transaction(pool,c=>failFinal(c)),/claim_lost/);await preserved();
  for(const owner of [jobs,claims,continuations]){
    assert.deepEqual(await transaction(pool,c=>owner(c).claimDue({limit:1,leaseSeconds:120})),[]);await preserved();
  }
  originalCount=originalReads();await assert.rejects(service.readCoveredOriginalFrozenCaptureJobOwnedFirstSourceReferencesV3(input,
    {captureJobClaim:claim}),/claim_lost/);assert.equal(originalReads(),originalCount);await preserved();
  console.info('[native-owned18-final-source-failure5-COMMIT-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_ending_role_refusal_after_real_original_IO_before_structural_failure_bookkeeping:true,
    entire_actual_running18_claim_native17_birth_preclaim_FIRST_parents_and_all_originals_preserved:true,
    genuine_orphan_COMMIT_rejected_full_rollback_and_closed_wrong_scope_token_attempt_metadata_refusals:true,
    all_eight_deferred_events_enabled_and_real_terminal_failure5_COMMIT:true,
    actual_lost_terminal_COMMIT_ACK:!!laterFirstSource,
    only_status_token_lease_error_updated_change_no_attempt_refund_schedule_or_root_change:true,
    no_sixth_claim_duplicate_failure_original_IO_or_generic_old_continuation_adoption:true,
    all_prior_native_rows_blobs_scope_subject_manual_sections_reports_workspace_choices_pins_unchanged:true,
    lower_attempt_recovery:false,expired_claim_recovery:false,NEXT_or_EMPTY:false,publication:false,pin_transfer:false,
    activation:false,licensed_large_area:false,production_speed:false});
}
