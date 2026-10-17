import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeNeighborhoodFirstSourceCheckpointBeforeSaveV3 } from './neighborhoodFirstSourceCheckpointV3DatabaseChecks.js';
import { createCustomCohortCaptureJobRepository } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';

const jobs='app.neighborhood_custom_cohort_capture_jobs',handoffs='app.neighborhood_custom_cohort_source_resolution_v3_handoffs';
async function refuse(raw,sql,values,reason){
  await raw.query('SAVEPOINT refused_source_handoff');
  try{await assert.rejects(raw.query(sql,values),reason);}
  finally{await raw.query('ROLLBACK TO SAVEPOINT refused_source_handoff');await raw.query('RELEASE SAVEPOINT refused_source_handoff');}
}
export async function observeNeighborhoodFirstSourceHandoffBeforeSaveV3({raw,result,scope}){
  // Preserve all earlier forged-root/full-job native probes on the ACTUAL17
  // birth. The new row must not manufacture17 from a projected18 checkpoint.
  const before=await observeNeighborhoodFirstSourceCheckpointBeforeSaveV3({raw,result,scope}),op=before.actual.operation_id;
  before.birthJob=(await raw.query(`SELECT to_jsonb(job) AS body FROM ${jobs} job WHERE operation_id=$1`,[op])).rows[0].body;
  const native=(await raw.query('SELECT * FROM app.neighborhood_source_resolution_v3_native_first_handoff($1,$2)',[op,scope.organization_id])).rows;
  assert.equal(native.length,1);assert.deepEqual(native[0].birth_job,before.birthJob);assert.deepEqual(native[0].checkpoint,before.expected);
  for(const [field,expression]of [
    ['birth_job',"jsonb_set(h.birth_job,'{last_error_code}','\"forged\"')"],
    ['birth_job',"jsonb_set(h.birth_job,'{lease_expires_at}','null')"],
    ['checkpoint',"jsonb_set(h.checkpoint,'{evidence_refs,0}',h.checkpoint->'evidence_refs'->17)"],
    ['sequence','2'],['issued_claim_token','gen_random_uuid()'],['issued_attempts','CASE WHEN h.issued_attempts=5 THEN 4 ELSE h.issued_attempts+1 END'],
    ['issued_transaction_id','h.issued_transaction_id+1']]){
    const columns=['operation_id','organization_id','sequence','birth_job','checkpoint','issued_claim_token','issued_attempts','issued_transaction_id'];
    await refuse(raw,`INSERT INTO ${handoffs} SELECT ${columns.map(c=>c===field?expression:`h.${c}`).join(',')}
      FROM app.neighborhood_source_resolution_v3_native_first_handoff($1,$2) h`,[op,scope.organization_id],/actual_handoff_required/);
  }
  assert.deepEqual((await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows,[before.actual]);
  assert.equal((await raw.query(`SELECT * FROM ${handoffs} WHERE operation_id=$1`,[op])).rowCount,0);
  return before;
}

export async function observeNeighborhoodFirstSourceHandoffAfterSaveV3({raw,result,scope,before}){
  const op=before.actual.operation_id,id=before.parent.issued_transaction_id;
  assert.equal(result.rowCount,1);assert.deepEqual(result.rows,[{checkpoint:before.expected,status:'retry',claim_token:null,lease_expires_at:null,
    attempts:before.actual.attempts,sequence:1,issued_claim_token:before.actual.claim_token,issued_attempts:before.actual.attempts,transaction_id:id}]);
  const current=(await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows[0],
    handoff=(await raw.query(`SELECT * FROM ${handoffs} WHERE operation_id=$1`,[op])).rows[0],
    continuation=(await raw.query('SELECT * FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=$1',[op])).rows;
  assert.deepEqual(handoff,{operation_id:op,organization_id:scope.organization_id,sequence:1,birth_job:before.birthJob,
    checkpoint:before.expected,issued_claim_token:before.actual.claim_token,issued_attempts:before.actual.attempts,issued_transaction_id:id});
  const retained=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'].includes(key)));
  assert.deepEqual(retained(current),retained(before.actual));assert.deepEqual(current.checkpoint,before.expected);
  assert.equal(current.status,'retry');assert.equal(current.claim_token,null);assert.equal(current.lease_expires_at,null);
  assert.deepEqual((await raw.query('SELECT * FROM app.neighborhood_custom_cohort_source_resolution_v3_parents WHERE operation_id=$1',[op])).rows,[before.parent]);
  assert.deepEqual((await raw.query('SELECT * FROM app.neighborhood_custom_cohort_source_resolution_v3_heads WHERE operation_id=$1',[op])).rows,[before.head]);
  // A provisional18 cannot be treated as a new17 birth, generically claimed,
  // renewed or refunded. The future fresh18 protocol is still unfinished.
  assert.equal((await raw.query('SELECT * FROM app.neighborhood_source_resolution_v3_native_first_handoff($1,$2)',[op,scope.organization_id])).rowCount,0);
  assert.equal((await raw.query('SELECT * FROM app.neighborhood_source_resolution_v3_native_parent($1,$2)',[op,scope.organization_id])).rowCount,0);
  assert.deepEqual(await createCustomCohortCaptureJobRepository(raw).claimDue({limit:1,leaseSeconds:120}),[]);
  assert.deepEqual(await createCustomCohortV2ContinuationRepository(raw).claimDue({limit:1,leaseSeconds:120}),[]);
  const checkpointRefusal=/actual_checkpoint_transition_required|provisional_checkpoint_immutable/;
  for(const [set,reason] of [
    ['checkpoint=checkpoint',checkpointRefusal],
    // The existing continuation trigger runs first for retry -> running at the
    // same attempt. Its exact consumed-token refusal is required too; do not
    // disable it or require a later source guard to be the first failure.
    ["status='running',claim_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '120 seconds'",
      /neighborhood_v2_continuation_job_conflict/],
    ['attempts=attempts+1',checkpointRefusal],["last_error_code='reset'",checkpointRefusal],
    ["run_after=clock_timestamp()+interval '1 hour'",checkpointRefusal],
    ["checkpoint=jsonb_set(checkpoint,'{phase}','\"frozen_selected_transaction_index_refs_v2\"')",checkpointRefusal]]){
    await refuse(raw,`UPDATE ${jobs} SET ${set} WHERE operation_id=$1`,[op],reason);
    assert.deepEqual((await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows,[current]);
    assert.deepEqual((await raw.query(`SELECT * FROM ${handoffs} WHERE operation_id=$1`,[op])).rows,[handoff]);
    assert.deepEqual((await raw.query('SELECT * FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=$1',[op])).rows,continuation);
  }
  for(const sql of [`UPDATE ${handoffs} SET issued_attempts=issued_attempts WHERE operation_id=$1`,
    `DELETE FROM ${handoffs} WHERE operation_id=$1`])await refuse(raw,sql,[op],/handoff_immutable/);
  await refuse(raw,`TRUNCATE ${handoffs}`,[],/immutable/);
  assert.deepEqual((await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows,[current]);
  assert.deepEqual((await raw.query(`SELECT * FROM ${handoffs} WHERE operation_id=$1`,[op])).rows,[handoff]);
}

export async function runNeighborhoodFirstSourceHandoffV3DatabaseChecks({pool,input,scope,actor,service,claim,empty,setFault,readFault,originalReads,laterFirstSource}){
  const ddl=readFileSync(new URL('../../migrations/20261223_custom_cohort_source_first_handoff_v3.sql',import.meta.url),'utf8'),setup=await pool.connect();
  let open=false,discard;
  try{
    assert.match((await setup.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await setup.query('BEGIN');open=true;await setup.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'");
    await setup.query({text:ddl,query_timeout:6000});await setup.query('COMMIT');open=false;
  }catch(error){discard=error;throw error;}
  finally{if(open)try{await setup.query({text:'ROLLBACK',query_timeout:1000});}catch(error){discard ||= error;}setup.release(discard||undefined);}
  const unchanged=async()=>{await empty();assert.equal((await pool.query(`SELECT * FROM ${handoffs} WHERE operation_id=$1 AND organization_id=$2`,
    [claim.operation_id,scope.organization_id])).rowCount,0);},
    method='retainCoveredOriginalFrozenCaptureJobFirstSourceHandoffReferencesV3',options={captureJobClaim:claim},run=()=>service[method](input,options);
  await unchanged();
  for(const key of ['checkpoint','source','candidate','binding','row','head','candidateReference','continuation','birth_job','leaseSeconds']){
    const reads=originalReads();await assert.rejects(service[method](input,{...options,[key]:{}}),/invalid_options/);
    assert.equal(originalReads(),reads);await unchanged();
  }
  let reads=originalReads();await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await unchanged();
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],['union_workspace',/custom_cohort_group_workspace_study_changed/],
    ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);try{await assert.rejects(run(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await unchanged();
  }
  for(let repeat=0;repeat<2;repeat++){
    reads=originalReads();setFault('source_handoff_observe');
    await assert.rejects(run(),e=>e.outcome_unknown===true&&e.code==='55000'&&/source_resolution_v3_(owner|checkpoint|handoff)_unintegrated/.test(e.message));
    assert.equal(readFault(),null,'the actual native atomic18/checkpoint/yield must execute before mandatory COMMIT refusal');
    assert.equal(originalReads(),reads+1);await unchanged();
  }
  console.info('[native-first-source-actual17-atomic18-handoff-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_original_owner_all_current_ending_rights_ENTIRE_caches_and_native_members:true,
    entire_actual17_birth_job_immutable_parent_FIRST_blob_row_head_and_handoff_same_transaction:true,
    single_statement_native_handoff_INSERT_and_actual_job18_retry_token_lease_clear:true,
    attempts_error_request_actor_assignment_subject_scope_context_preserved:true,
    forged_birth_tuple_roots_token_attempt_and_transaction_refuse:true,
    provisional18_birth_reconstruction_generic_claim_free_recovery_and_handoff_mutation_refuse:true,
    seven_ending_faults_real_COMMIT_rejection_fresh_same_claim_repeat_ALL_rows_blobs_job_workspace_reports_choices_pins_rollback:true,
    durable_issuance:false,fresh18_admission:false,recovery:false,NEXT_or_EMPTY:false,activation:false,licensed_large_area:false,production_speed:false});
}
