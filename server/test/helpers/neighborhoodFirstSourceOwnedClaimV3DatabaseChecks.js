import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCustomCohortFirstSourceClaimV3Repository as claims }
  from '../../src/services/neighborhoodAssessment/customCohortFirstSourceClaimV3Repository.js';
import { createCustomCohortCaptureJobRepository as jobs }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations }
  from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as transaction }
  from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { runNeighborhoodOwnedFirstSourceOriginalV3DatabaseChecks } from './neighborhoodOwnedFirstSourceOriginalV3DatabaseChecks.js';

const jobTable='app.neighborhood_custom_cohort_capture_jobs',claimTable='app.neighborhood_custom_cohort_source_resolution_v3_claims';
// Only the independently acquired disposable native graphs reach this helper,
// AFTER every previous refusal and real birth COMMIT/lost-ACK assertion. No
// original, attempt, clock, claim lease, parent, grant or pin is rewritten.
export async function runNeighborhoodFirstSourceOwnedClaimV3DatabaseChecks({pool,input,scope,actor,service,
  claim:oldClaim,originalReads,laterFirstSource,setFault,readFault}){
  const op=input.operationId,read=async table=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r
    WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[op])).rows,
    job=async()=>(await read('neighborhood_custom_cohort_capture_jobs'))[0].body;
  await transaction(pool,async c=>{
    assert.match((await c.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await c.query(readFileSync(new URL('../../migrations/20261226_custom_cohort_source_first_owned_claim_v3.sql',import.meta.url),'utf8'));
    const guards=(await c.query(`SELECT tgname,tgdeferrable,tginitdeferred,tgenabled FROM pg_trigger
      WHERE tgname IN ('neighborhood_source_resolution_v3_parent_commit','neighborhood_source_resolution_v3_first_commit',
        'neighborhood_source_resolution_v3_row_commit','neighborhood_source_resolution_v3_head_commit',
        'neighborhood_source_resolution_v3_first_checkpoint_commit','neighborhood_source_resolution_v3_first_handoff_commit',
        'neighborhood_source_resolution_v3_first_claim_commit')`)).rows;
    assert.equal(guards.length,7);assert.ok(guards.every(g=>g.tgdeferrable&&g.tginitdeferred&&g.tgenabled==='O'));
  });
  const parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
      AND c.table_name NOT IN ('neighborhood_custom_cohort_capture_jobs','neighborhood_custom_cohort_source_resolution_v3_claims')
    ORDER BY c.table_name`)).rows.map(r=>r.table_name);
  assert.ok(parentNames.length>10);assert.ok(parentNames.every(n=>/^[a-z_][a-z0-9_]*$/.test(n)));
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
    parent=await read('neighborhood_custom_cohort_source_resolution_v3_parents'),
    first=await read('neighborhood_custom_cohort_source_resolution_v3_first'),
    handoff=(await read('neighborhood_custom_cohort_source_resolution_v3_handoffs'))[0].body;
  assert.equal(before.job.status,'retry');assert.equal(before.job.attempts,5);
  assert.equal(before.job.last_error_code,'access_revoked');assert.equal(before.job.checkpoint.evidence_refs.length,18);
  assert.deepEqual(await read('neighborhood_custom_cohort_source_resolution_v3_claims'),[]);
  const unchanged=async()=>{assert.deepEqual(await job(),before.job);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await read('neighborhood_custom_cohort_source_resolution_v3_claims'),[]);};
  const columns=['operation_id','organization_id','preclaim_job','claim_token','attempts','issued_at','lease_seconds',
    'lease_expires_at','birth_transaction_id','issued_transaction_id'],
    values={operation_id:'job.operation_id',organization_id:'job.organization_id',preclaim_job:'to_jsonb(job)',
      claim_token:'gen_random_uuid()',attempts:'job.attempts',issued_at:'stamp.at',lease_seconds:'120',
      lease_expires_at:"stamp.at+interval '120 seconds'",birth_transaction_id:'h.issued_transaction_id',issued_transaction_id:'txid_current()'},
    orphan=(change={})=>`INSERT INTO ${claimTable} (${columns.join(',')})
      SELECT ${columns.map(k=>change[k]??values[k]).join(',')} FROM ${jobTable} job
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_handoffs h USING(operation_id,organization_id)
      CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE job.operation_id=$1::uuid) stamp
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid`;
  // Native insert guards derive the actual entire preclaim and FIRST again.
  for(const change of [{preclaim_job:"jsonb_set(to_jsonb(job),'{last_error_code}','\"forged\"')"},
    {attempts:'4'},{claim_token:'h.issued_claim_token'},{birth_transaction_id:'h.issued_transaction_id+1'},
    {issued_transaction_id:'h.issued_transaction_id'},{organization_id:'gen_random_uuid()'}]){
    await assert.rejects(transaction(pool,c=>c.query(orphan(change),[op,scope.organization_id])),
      /actual_first_claim_required/);await unchanged();
  }
  // This is a real valid INSERT with queued deferred event, without its paired
  // UPDATE. Only genuine COMMIT can reject it and roll back the entire row.
  await assert.rejects(transaction(pool,c=>c.query(orphan(),[op,scope.organization_id])),
    e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_source_resolution_v3_first_claim_conflict');
  await unchanged();
  let winner,actualCommit=false;
  const ownerPool=laterFirstSource?{async connect(){const raw=await pool.connect();
    return {on:(...a)=>raw.on(...a),off:(...a)=>raw.off(...a),release:e=>raw.release(e),
      async query(config,params){const result=await raw.query(config,params);
        if((typeof config==='string'?config:config.text)==='COMMIT'){
          actualCommit=true;throw new Error('native_first18_claim_real_COMMIT_ack_lost');
        }return result;}};}}:pool;
  const consume=()=>transaction(ownerPool,async c=>{
    const rows=await claims(c).claimDue({limit:1,leaseSeconds:120});assert.equal(rows.length,1);winner=rows[0];
    // A second real transaction overlaps the held row lock and must SKIP it.
    assert.deepEqual(await transaction(pool,other=>claims(other).claimDue({limit:1,leaseSeconds:120})),[]);
    return rows;
  });
  if(laterFirstSource){await assert.rejects(consume(),e=>e.outcome_unknown===true&&/real_COMMIT_ack_lost/.test(e.message));assert.equal(actualCommit,true);}
  else assert.deepEqual(await consume(),[winner]);
  assert.equal(winner.authority,'not_established');assert.equal(winner.claim.attempts,5);
  assert.equal(winner.actor_user_id,actor);assert.deepEqual(winner.scope,scope);
  assert.notEqual(winner.claim.claim_token,oldClaim.claim_token);assert.notEqual(winner.claim.claim_token,handoff.issued_claim_token);
  const owned=await job(),issued=(await read('neighborhood_custom_cohort_source_resolution_v3_claims'))[0].body;
  assert.deepEqual(issued.preclaim_job,before.job);assert.equal(issued.birth_transaction_id,handoff.issued_transaction_id);
  assert.notEqual(issued.issued_transaction_id,issued.birth_transaction_id);assert.equal(issued.attempts,5);
  assert.equal(owned.status,'running');assert.equal(owned.claim_token,issued.claim_token);
  assert.equal(owned.lease_expires_at,issued.lease_expires_at);assert.equal(owned.updated_at,issued.issued_at);
  const nonClaim=j=>Object.fromEntries(Object.entries(j).filter(([k])=>!['status','claim_token','lease_expires_at','updated_at'].includes(k)));
  assert.deepEqual(nonClaim(owned),nonClaim(before.job));assert.deepEqual(await immutable(),before.immutable);
  const ownedRead=(fn,org=scope.organization_id,token=winner.claim.claim_token,attempt=5)=>transaction(pool,c=>c.query(
    `SELECT to_jsonb(p) AS body FROM app.neighborhood_source_resolution_v3_${fn}($1,$2,$3,$4) p`,[op,org,token,attempt]));
  for(const [fn,expected]of [['owned_first_parent',parent],['owned_first',first]]){
    assert.deepEqual((await ownedRead(fn)).rows,expected);
    for(const args of [[randomUUID()],[scope.organization_id,oldClaim.claim_token],[scope.organization_id,randomUUID()],
      [scope.organization_id,winner.claim.claim_token,4]])assert.deepEqual((await ownedRead(fn,...args)).rows,[]);
  }
  for(const fn of ['retained_parent_after_handoff','retained_first_after_handoff'])assert.equal(
    (await transaction(pool,c=>c.query(`SELECT * FROM app.neighborhood_source_resolution_v3_${fn}($1,$2)`,[op,scope.organization_id]))).rowCount,0);
  const preserved=async()=>{assert.deepEqual(await job(),owned);assert.deepEqual(await immutable(),before.immutable);
    assert.deepEqual(await read('neighborhood_custom_cohort_source_resolution_v3_claims'),[{body:issued}]);};
  for(const set of ['checkpoint=checkpoint','attempts=4',"last_error_code='reset'","run_after=clock_timestamp()+interval '1 hour'",
    "lease_expires_at=clock_timestamp()+interval '120 seconds'","status='retry',claim_token=NULL,lease_expires_at=NULL",
    "checkpoint=jsonb_set(checkpoint,'{phase}','\"frozen_selected_transaction_index_refs_v2\"')"]){
    // The independent earlier CAD success guard rejects an attempt refund
    // before a source trigger can run. Require that EXACT native refusal for
    // this one mutation; preserve every guard and all whole-row assertions.
    const reason=set==='attempts=4'?e=>e.code==='55000'&&e.message==='neighborhood_cad_success_v2_binding_conflict'
      :/actual_checkpoint_transition_required|provisional_checkpoint_immutable|continuation_attempt_history_conflict/;
    await assert.rejects(transaction(pool,c=>c.query(`UPDATE ${jobTable} SET ${set} WHERE operation_id=$1`,[op])),reason);await preserved();
  }
  for(const sql of [`UPDATE ${claimTable} SET attempts=attempts WHERE operation_id=$1`,
    `DELETE FROM ${claimTable} WHERE operation_id=$1`]){
    await assert.rejects(transaction(pool,c=>c.query(sql,[op])),/claim_immutable/);await preserved();
  }
  await assert.rejects(transaction(pool,c=>c.query(`TRUNCATE ${claimTable}`)),/immutable/);await preserved();
  assert.deepEqual(await transaction(pool,c=>claims(c).claimDue({limit:1,leaseSeconds:120})),[]);
  assert.deepEqual(await transaction(pool,c=>jobs(c).claimDue({limit:1,leaseSeconds:120})),[]);
  assert.deepEqual(await transaction(pool,c=>continuations(c).claimDue({limit:1,leaseSeconds:120})),[]);
  const reads=originalReads();await assert.rejects(service.retainCoveredOriginalFrozenCaptureJobFirstSourceHandoffReferencesV3(input,
    {captureJobClaim:oldClaim}),/claim_lost|checkpoint_conflict/);assert.equal(originalReads(),reads);await preserved();
  console.info('[native-first-source-single-consume-owned18-claim-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_committed_birth17_and_ENTIRE_preclaim18_never_rebound_to_new_token_or_transaction:true,
    same_fifth_attempt_error_schedule_roots_scope_actor_assignment_context_and_all_native_parents_preserved:true,
    actual_overlapping_claimers_one_winner_and_single_consume_after_COMMIT:true,
    genuine_orphan_COMMIT_refusal_full_rollback_and_forged_native_metadata_refusal:true,
    actual_lost_winning_COMMIT_ACK:!!laterFirstSource,
    owned_native_parent_and_independently_reselected_FIRST_member_edge_equal_actual_original_birth:true,
    stale_foreign_scope_token_attempt_and_generic_queues_refuse:true,
    immutable_claim_and_owned_job_renewal_failure_refund_checkpoint_reset_refuse:true,
    original_owner_reopened_under_new18:false,source_authority:'not_established',recovery:false,
    NEXT_or_EMPTY:false,activation:false,licensed_large_area:false,production_speed:false});
  await runNeighborhoodOwnedFirstSourceOriginalV3DatabaseChecks({pool,input,scope,actor,service,claim:winner.claim,
    originalReads,laterFirstSource,setFault,readFault,unchanged:preserved,originalBirthTransaction:String(handoff.issued_transaction_id)});
}
