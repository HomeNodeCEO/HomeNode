import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';

const phase='frozen_selected_source_resolution_refs_v3',
  jobs='app.neighborhood_custom_cohort_capture_jobs',
  parents='app.neighborhood_custom_cohort_source_resolution_v3_parents',
  heads='app.neighborhood_custom_cohort_source_resolution_v3_heads';
async function refuse(raw,sql,values,reason){
  await raw.query('SAVEPOINT refused_source_checkpoint');
  try{await assert.rejects(raw.query(sql,values),reason);}
  finally{await raw.query('ROLLBACK TO SAVEPOINT refused_source_checkpoint');await raw.query('RELEASE SAVEPOINT refused_source_checkpoint');}
}

// Test-only observation around REAL service DML. Neither observer changes a
// production query/result, supplies original authority, nor provides a plan.
export async function observeNeighborhoodFirstSourceCheckpointBeforeSaveV3({raw,result,scope}){
  assert.equal(result.rowCount,1);const head=result.rows[0],op=head.operation_id,
    actual=(await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows[0],
    parent=(await raw.query(`SELECT * FROM ${parents} WHERE operation_id=$1`,[op])).rows[0],
    expected={phase,evidence_refs:[...parent.parent_checkpoint.evidence_refs,head.candidate_reference]};
  assert.deepEqual(parent.parent_checkpoint,actual.checkpoint);
  assert.equal(parent.issued_transaction_id,(await raw.query('SELECT txid_current()::text AS id')).rows[0].id);
  assert.deepEqual((await raw.query('SELECT app.neighborhood_source_resolution_v3_first_checkpoint($1,$2) AS cp',
    [op,scope.organization_id])).rows[0].cp,expected);
  for(const change of [p=>p.evidence_refs[0]=p.evidence_refs[17],p=>p.evidence_refs[16]=p.evidence_refs[0],
    p=>p.evidence_refs[17]=p.evidence_refs[16],p=>p.evidence_refs.push(p.evidence_refs[17]),
    p=>p.evidence_refs.pop(),p=>p.extra=true]){
    const forged=structuredClone(expected);change(forged);
    await refuse(raw,`UPDATE ${jobs} SET checkpoint=$2::jsonb WHERE operation_id=$1`,[op,json(forged)],/actual_checkpoint_transition_required/);
  }
  // A structurally correct18 is insufficient if ANY other original job field
  // changes. In particular this cannot renew/rewrite/refund the real claim.
  for(const set of ["status='retry'","claim_token=gen_random_uuid()",'attempts=4',
    "lease_expires_at=clock_timestamp()+interval '1 hour'","lease_expires_at=NULL",
    "run_after=clock_timestamp()+interval '1 hour'","last_error_code='invented_error'",
    "context_sha256=repeat('a',64)","account_id='FORGED-SUBJECT'","cancellation_requested_at=clock_timestamp()"]){
    await refuse(raw,`UPDATE ${jobs} SET checkpoint=$2::jsonb,${set} WHERE operation_id=$1`,
      [op,json(expected)],/actual_checkpoint_transition_required|binding_conflict|claim_conflict|job_conflict|attempt_history_conflict|not_null|foreign key|check constraint/);
  }
  assert.deepEqual((await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows,[actual]);
  return {actual,parent,head,expected};
}

export async function observeNeighborhoodFirstSourceCheckpointAfterSaveV3({raw,result,scope,before}){
  assert.equal(result.rowCount,1);assert.deepEqual(result.rows[0],{checkpoint:before.expected});
  const op=before.actual.operation_id,current=(await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows[0];
  assert.deepEqual({...current,checkpoint:before.actual.checkpoint,updated_at:before.actual.updated_at},before.actual);
  assert.deepEqual((await raw.query(`SELECT * FROM ${parents} WHERE operation_id=$1`,[op])).rows,[before.parent]);
  assert.deepEqual((await raw.query(`SELECT * FROM ${heads} WHERE operation_id=$1`,[op])).rows,[before.head]);
  // The actual job now has18. The birth reader MUST fail, while its immutable
  // actual17 snapshot (including issuance TX/token/attempt) stays intact. A
  // future fresh18 reader may never pretend this is a newly born17 graph.
  assert.equal((await raw.query('SELECT * FROM app.neighborhood_source_resolution_v3_native_parent($1,$2)',
    [op,scope.organization_id])).rowCount,0);
  assert.equal((await raw.query('SELECT app.neighborhood_source_resolution_v3_first_checkpoint($1,$2) AS cp',
    [op,scope.organization_id])).rows[0].cp,null);
  for(const set of ["checkpoint=checkpoint","checkpoint=jsonb_set(checkpoint,'{phase}','\"frozen_selected_transaction_index_refs_v2\"')",
    "status='retry',claim_token=NULL,lease_expires_at=NULL","claim_token=gen_random_uuid()",
    "lease_expires_at=clock_timestamp()+interval '1 hour'","last_error_code='invented_error'"])
    await refuse(raw,`UPDATE ${jobs} SET ${set} WHERE operation_id=$1`,[op],/actual_checkpoint_transition_required|provisional_checkpoint_immutable/);
  await refuse(raw,`DELETE FROM ${jobs} WHERE operation_id=$1`,[op],/provisional_checkpoint_immutable/);
  assert.deepEqual((await raw.query(`SELECT * FROM ${jobs} WHERE operation_id=$1`,[op])).rows,[current]);
}

export async function runNeighborhoodFirstSourceCheckpointV3DatabaseChecks({pool,input,scope,actor,service,
  claim,empty,setFault,readFault,originalReads,laterFirstSource}){
  // Attach ONLY exact unregistered DDL to this independently built disposable
  // database. Earlier owner/row/head assertions execute unchanged before this.
  const ddl=readFileSync(new URL('../../migrations/20261222_custom_cohort_source_first_checkpoint_v3.sql',import.meta.url),'utf8'),
    setup=await pool.connect();let open=false,discard;
  try{
    assert.match((await setup.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await setup.query('BEGIN');open=true;
    await setup.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'");
    await setup.query({text:ddl,query_timeout:6000});await setup.query('COMMIT');open=false;
  }catch(error){discard=error;throw error;}
  finally{if(open)try{await setup.query({text:'ROLLBACK',query_timeout:1000});}catch(error){discard ||= error;}setup.release(discard||undefined);}
  await empty();
  const method='retainCoveredOriginalFrozenCaptureJobFirstSourceCheckpointReferencesV3',options={captureJobClaim:claim},
    run=()=>service[method](input,options);
  for(const key of ['checkpoint','source','candidate','binding','row','head','candidateReference']){
    const reads=originalReads();await assert.rejects(service[method](input,{...options,[key]:{}}),/invalid_options/);
    assert.equal(originalReads(),reads);await empty();
  }
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await empty();
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],['union_workspace',/custom_cohort_group_workspace_study_changed/],
    ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);try{await assert.rejects(run(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await empty();
  }
  for(let repeat=0;repeat<2;repeat++){
    reads=originalReads();setFault('source_checkpoint_observe');
    await assert.rejects(run(),e=>e.outcome_unknown===true&&e.code==='55000'&&/source_resolution_v3_(owner|checkpoint)_unintegrated/.test(e.message));
    assert.equal(readFault(),null,'the actual native18 UPDATE must be observed before mandatory rejected COMMIT');
    assert.equal(originalReads(),reads+1);await empty();
  }
  console.info('[native-first-source-actual17-to18-provisional-checkpoint-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_original_owner_all_current_ending_rights_ENTIRE_caches_and_native_members:true,
    actual_native_parent_FIRST_blob_row_head_then_real_job18_UPDATE_same_transaction:true,
    forged18_roots_shape_and_any_other_job_tuple_lease_token_attempt_schedule_change_refuse:true,
    actual_retained17_birth_snapshot_unchanged_and_birth_reader_refuses_after_real18:true,
    provisional18_rewrite_free_yield_delete_and_lease_revival_refuse:true,
    seven_ending_faults_real_COMMIT_rejection_fresh_same_claim_repeat_ALL_state_rollback:true,
    durable_issuance:false,continuation:false,fresh18_recovery:false,NEXT_or_EMPTY:false,
    activation:false,licensed_large_area:false,production_speed:false});
}
