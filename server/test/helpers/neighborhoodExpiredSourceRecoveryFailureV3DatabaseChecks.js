import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCustomCohortExpiredSourceRecoveryFailureV3Repository as failures }
  from '../../src/services/neighborhoodAssessment/customCohortExpiredSourceRecoveryFailureV3Repository.js';
import { createCustomCohortRecoveredSourceTerminalFailureV3Repository as liveFailures }
  from '../../src/services/neighborhoodAssessment/customCohortRecoveredSourceTerminalFailureV3Repository.js';
import { createCustomCohortCaptureJobRepository as jobs }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortFirstSourceClaimV3Repository as claims }
  from '../../src/services/neighborhoodAssessment/customCohortFirstSourceClaimV3Repository.js';
import { createCustomCohortSourceFinalRecoveryClaimV3Repository as recoveries }
  from '../../src/services/neighborhoodAssessment/customCohortSourceFinalRecoveryClaimV3Repository.js';
import { createCustomCohortV2ContinuationRepository as continuations }
  from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as transaction }
  from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

const jobTable='app.neighborhood_custom_cohort_capture_jobs',
  failureTable='app.neighborhood_custom_cohort_source_resolution_v3_expired_ends';
// Additional independent A/B captures only. Every actual original/whole cache,
// birth17/initial4/retry4/recovered5 and ending fence already ran on THIS graph.
// Existing normal120s recovery and live terminal cases retain their own graphs.
export async function runNeighborhoodExpiredSourceRecoveryFailureV3DatabaseChecks({pool,input,scope,actor,service,claim,
  originalReads,laterFirstSource}){
  const op=input.operationId,read=async table=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r
    WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[op])).rows,
    job=async()=>(await read('neighborhood_custom_cohort_capture_jobs'))[0].body,
    failureRows=()=>read('neighborhood_custom_cohort_source_resolution_v3_expired_ends');
  await transaction(pool,async c=>{
    assert.match((await c.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    for(const file of ['20261231_custom_cohort_source_recovered_terminal_failure_v3.sql',
      '20270101_custom_cohort_source_expired_recovery_failure_v3.sql'])
      await c.query(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
    const events=(await c.query(`SELECT tgname,tgdeferrable,tginitdeferred,tgenabled FROM pg_trigger
      WHERE tgname IN ('neighborhood_source_resolution_v3_parent_commit','neighborhood_source_resolution_v3_first_commit',
        'neighborhood_source_resolution_v3_row_commit','neighborhood_source_resolution_v3_head_commit',
        'neighborhood_source_resolution_v3_first_checkpoint_commit','neighborhood_source_resolution_v3_first_handoff_commit',
        'neighborhood_source_resolution_v3_first_claim_commit','neighborhood_source_resolution_v3_terminal_failure_commit',
        'neighborhood_source_resolution_v3_last_retry_commit','neighborhood_source_resolution_v3_recovery_commit',
        'neighborhood_source_resolution_v3_recovered_final_commit','neighborhood_source_resolution_v3_expired_final_commit')`)).rows;
    assert.equal(events.length,12);assert.ok(events.every(e=>e.tgdeferrable&&e.tginitdeferred&&e.tgenabled==='O'));
  });
  const parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
      AND c.table_name NOT IN ('neighborhood_custom_cohort_capture_jobs','neighborhood_custom_cohort_source_resolution_v3_expired_ends')
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
    issued=(await read('neighborhood_custom_cohort_source_resolution_v3_recoveries'))[0].body,
    parent=await read('neighborhood_custom_cohort_source_resolution_v3_parents'),
    first=await read('neighborhood_custom_cohort_source_resolution_v3_first');
  assert.equal(before.job.status,'running');assert.equal(before.job.attempts,5);
  assert.equal(before.job.claim_token,claim.claim_token);assert.equal(before.job.lease_expires_at,issued.lease_expires_at);
  assert.equal(issued.lease_seconds,15);assert.equal(before.job.checkpoint.evidence_refs.length,18);
  assert.deepEqual(await failureRows(),[]);
  const unchanged=async()=>{assert.deepEqual(await job(),before.job);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await failureRows(),[]);},
    failExpired=(client,ownedClaim=claim,ownedScope=scope)=>failures({client,claim:ownedClaim,scope:ownedScope,actorUserId:actor}).failExpired(),
    expiredRead=(fn,org=scope.organization_id,token=claim.claim_token,attempt=5)=>transaction(pool,c=>c.query(
      `SELECT to_jsonb(p) AS body FROM app.neighborhood_source_resolution_v3_${fn}($1,$2,$3,$4) p`,[op,org,token,attempt]));
  assert.deepEqual((await expiredRead('expired_first')).rows,[]);
  await assert.rejects(transaction(pool,c=>failExpired(c)),/claim_lost/);await unchanged();
  // Wait for the native minimum lease actually issued to this new recovery.
  // Never alter the clock, lease, attempts, schedule, roots or prior facts.
  const wait=(await pool.query(`SELECT ceil(extract(epoch FROM (lease_expires_at-clock_timestamp()))*1000)::integer AS ms
    FROM ${jobTable} WHERE operation_id=$1`,[op])).rows[0].ms;
  assert.ok(wait>0&&wait<=15000,'all complete current/ending original probes must finish before natural expiry');
  await new Promise(resolve=>setTimeout(resolve,wait+50));
  assert.equal((await pool.query(`SELECT lease_expires_at<=clock_timestamp() AS expired
    FROM ${jobTable} WHERE operation_id=$1`,[op])).rows[0].expired,true);await unchanged();
  let originalCount=originalReads();
  await assert.rejects(service.readCoveredOriginalFrozenCaptureJobRecoveredFirstSourceReferencesV3(input,{captureJobClaim:claim}),/claim_lost/);
  assert.equal(originalReads(),originalCount);await unchanged();
  await assert.rejects(service.readCoveredOriginalFrozenCaptureJobRecoveredNextSourceReferencesV3(input,{captureJobClaim:claim}),/claim_lost/);
  assert.equal(originalReads(),originalCount);await unchanged();
  await assert.rejects(transaction(pool,c=>liveFailures({client:c,claim,scope,actorUserId:actor}).failFinal('attempts_exhausted')),/claim_lost/);
  await unchanged();
  for(const [fn,expected]of [['expired_parent',parent],['expired_first',first]]){
    assert.deepEqual((await expiredRead(fn)).rows,expected);
    for(const args of [[randomUUID()],[scope.organization_id,randomUUID()],
      [scope.organization_id,claim.claim_token,4],[scope.organization_id,claim.claim_token,6]])
      assert.deepEqual((await expiredRead(fn,...args)).rows,[]);
  }
  const columns=['operation_id','organization_id','claimed_job','failure_code','issued_at','claim_transaction_id','issued_transaction_id'],
    values={operation_id:'job.operation_id',organization_id:'job.organization_id',claimed_job:'to_jsonb(job)',
      failure_code:"'attempts_exhausted'",issued_at:'stamp.at',claim_transaction_id:'issued.issued_transaction_id',issued_transaction_id:'txid_current()'},
    orphan=(change={})=>`INSERT INTO ${failureTable} (${columns.join(',')})
      SELECT ${columns.map(k=>change[k]??values[k]).join(',')} FROM ${jobTable} job
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_recoveries issued USING(operation_id,organization_id)
      CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE job.operation_id=$1::uuid) stamp
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid`;
  for(const change of [{claimed_job:"jsonb_set(to_jsonb(job),'{attempts}','4')"},
    {claimed_job:"jsonb_set(to_jsonb(job),'{claim_token}',to_jsonb(gen_random_uuid()))"},
    {claimed_job:"jsonb_set(to_jsonb(job),'{lease_expires_at}',to_jsonb(clock_timestamp()+interval '120 seconds'))"},
    {claimed_job:"jsonb_set(to_jsonb(job),'{run_after}',to_jsonb(clock_timestamp()))"},
    {claim_transaction_id:'issued.issued_transaction_id+1'},{issued_transaction_id:'issued.issued_transaction_id'},
    {organization_id:'gen_random_uuid()'},{failure_code:"'capture_failed'"},
    {issued_at:"job.lease_expires_at-interval '1 second'"},{issued_at:"clock_timestamp()+interval '1 second'"}]){
    await assert.rejects(transaction(pool,c=>c.query(orphan(change),[op,scope.organization_id])),/actual_expired_final_required/);
    await unchanged();
  }
  // The valid immutable row alone reaches actual PostgreSQL COMMIT and fails
  // its twelfth deferred event, rolling back every provisional change.
  await assert.rejects(transaction(pool,c=>c.query(orphan(),[op,scope.organization_id])),
    e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_source_resolution_v3_expired_final_conflict');
  await unchanged();
  for(const [badClaim,badScope] of [[{...claim,claim_token:randomUUID()},scope],[claim,{...scope,organization_id:randomUUID()}],
    [claim,{...scope,report_file_id:randomUUID()}],[claim,{...scope,assignment_file_id:'8'}],[claim,{...scope,account_id:'OTHER'}]]){
    await assert.rejects(transaction(pool,c=>failExpired(c,badClaim,badScope)),/claim_lost/);await unchanged();
  }
  await assert.rejects(transaction(pool,async c=>{await failExpired(c);throw Error('native_expired5_complete_terminal_ROLLBACK');}),
    /complete_terminal_ROLLBACK/);await unchanged();
  let actualCommit=false;
  const ownerPool=laterFirstSource?{async connect(){const raw=await pool.connect();
    return {on:(...a)=>raw.on(...a),off:(...a)=>raw.off(...a),release:e=>raw.release(e),
      async query(config,params){const result=await raw.query(config,params);
        if((typeof config==='string'?config:config.text)==='COMMIT'){
          actualCommit=true;throw Error('native_expired5_real_COMMIT_ack_lost');
        }return result;}};}}:pool;
  originalCount=originalReads();
  if(laterFirstSource){await assert.rejects(transaction(ownerPool,c=>failExpired(c)),
    e=>e.outcome_unknown===true&&/real_COMMIT_ack_lost/.test(e.message));assert.equal(actualCommit,true);}
  else assert.deepEqual(await transaction(ownerPool,c=>failExpired(c)),{status:'failed',attempts:5,failure_code:'attempts_exhausted'});
  assert.equal(originalReads(),originalCount);
  const durable=(await failureRows())[0].body,failed=await job();
  assert.deepEqual(durable.claimed_job,before.job);assert.equal(durable.claim_transaction_id,issued.issued_transaction_id);
  assert.notEqual(durable.issued_transaction_id,durable.claim_transaction_id);
  assert.equal(durable.failure_code,'attempts_exhausted');
  assert.deepEqual(failed,{...before.job,status:'failed',claim_token:null,lease_expires_at:null,
    last_error_code:'attempts_exhausted',updated_at:durable.issued_at});assert.deepEqual(await immutable(),before.immutable);
  const preserved=async()=>{assert.deepEqual(await job(),failed);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await failureRows(),[{body:durable}]);};
  for(const sql of [`UPDATE ${failureTable} SET failure_code=failure_code WHERE operation_id=$1`,
    `DELETE FROM ${failureTable} WHERE operation_id=$1`]){
    await assert.rejects(transaction(pool,c=>c.query(sql,[op])),/expired_final_immutable/);await preserved();
  }
  await assert.rejects(transaction(pool,c=>c.query(`TRUNCATE ${failureTable}`)),/immutable/);await preserved();
  await assert.rejects(transaction(pool,c=>failExpired(c)),/claim_lost/);await preserved();
  for(const owner of [jobs,claims,continuations,recoveries]){
    assert.deepEqual(await transaction(pool,c=>owner(c).claimDue({limit:1,leaseSeconds:120})),[]);await preserved();
  }
  originalCount=originalReads();await assert.rejects(service.readCoveredOriginalFrozenCaptureJobRecoveredFirstSourceReferencesV3(input,
    {captureJobClaim:claim}),/claim_lost/);assert.equal(originalReads(),originalCount);await preserved();
  await assert.rejects(service.readCoveredOriginalFrozenCaptureJobRecoveredNextSourceReferencesV3(input,
    {captureJobClaim:claim}),/claim_lost/);assert.equal(originalReads(),originalCount);await preserved();
  console.info('[native-recovered18-naturally-expired5-terminal-COMMIT-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_new_native_minimum15_recovery_and_natural_expiry_no_clock_lease_attempt_schedule_rewrite:true,
    all_whole_original_entire_cache_current_ending_probes_completed_before_expiry:true,
    entire_expired_running5_recovery_TX_original17_initial4_retry4_FIRST_all_native_parents_reopened:true,
    live_source_owner_and_live_terminal_refused_after_expiry_without_original_IO:true,
    expired_NEXT_and_closed_terminal_NEXT_refused_before_original_IO:true,
    all_twelve_deferred_events_enabled_genuine_orphan_COMMIT_refused_and_complete_terminal_ROLLBACK:true,
    real_terminal_COMMIT_and_actual_lost_COMMIT_ACK:!!laterFirstSource,
    only_status_token_lease_error_updated_change_no_refund_new_claim_schedule_root_or_pin_change:true,
    all_prior_native_rows_blobs_assignment_subject_manual_reports_workspace_choices_pins_unchanged:true,
    no_sixth_duplicate_generic_oldqueue_adoption_or_post_expiry_original_IO:true,
    source_authority:'not_established',lower_attempt_recovery:false,NEXT_or_EMPTY:false,
    publication:false,pin_transfer:false,activation:false,licensed_large_area:false,production_speed:false});
}
