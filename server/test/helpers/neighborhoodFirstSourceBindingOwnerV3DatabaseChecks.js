import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const parentTable='app.neighborhood_custom_cohort_source_resolution_v3_parents',
  firstTable='app.neighborhood_custom_cohort_source_resolution_v3_first',
  ddls=['20261219_custom_cohort_source_resolution_parent_v3.sql','20261220_custom_cohort_source_native_first_v3.sql']
    .map(name=>readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));

// Install ONLY the exact unregistered definitions in this independently created
// disposable native CI database. No copied parent or callback supplies source
// authority. The real service owns its own BEGIN/original I/O/DML/COMMIT; its
// unconditional deferred guard must reject COMMIT and roll every row back.
export async function runNeighborhoodFirstSourceBindingOwnerV3DatabaseChecks({pool,input,scope,actor,service,
  claim,unchanged,setFault,readFault,originalReads,laterFirstSource}){
  const setup=await pool.connect();let open=false,discard;
  try{
    assert.match((await setup.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    for(const table of [parentTable,firstTable])assert.equal(
      (await setup.query('SELECT to_regclass($1) AS relation',[table])).rows[0].relation,null);
    await setup.query('BEGIN');open=true;
    await setup.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'");
    for(const ddl of ddls)await setup.query({text:ddl,query_timeout:6000});
    await setup.query('COMMIT');open=false;
  }catch(error){discard=error;throw error;}
  finally{
    if(open)try{await setup.query({text:'ROLLBACK',query_timeout:1000});}catch(error){discard ||= error;}
    setup.release(discard||undefined);
  }
  const method='retainCoveredOriginalFrozenCaptureJobFirstSourceBindingReferencesV3',
    options={captureJobClaim:claim},bind=()=>service[method](input,options),
    empty=async()=>{
      for(const table of [parentTable,firstTable])assert.equal(
        (await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n,0,
        'actual failed COMMIT must roll back every provisional parent and FIRST row');
      await unchanged();
    };
  await empty();
  for(const key of ['source','candidate','binding','checkpoint','resolution']){
    const reads=originalReads();
    await assert.rejects(service[method](input,{...options,[key]:{}}),/invalid_options/);
    assert.equal(originalReads(),reads);await empty();
  }
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(bind(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await empty();
  for(const [fault,reason] of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],
    ['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);
    try{await assert.rejects(bind(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await empty();
  }
  // Both closed inserts must have passed before the REAL deferred COMMIT can
  // fail with this exact native error. No successful value can be delivered.
  // A fresh second invocation reopens all originals under the SAME live claim;
  // neither rejection renews the lease or spends/refunds the failure history.
  for(let attempt=0;attempt<2;attempt++){
    reads=originalReads();
    await assert.rejects(bind(),error=>error.outcome_unknown===true&&error.code==='55000'
      &&error.message.includes('neighborhood_source_resolution_v3_owner_unintegrated'));
    assert.equal(originalReads(),reads+1);await empty();
  }
  console.info('[native-first-source-binding-actual-original-owner-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_service_owns_transaction_full_original_and_ENTIRE_cache_reconciliation:true,
    current_actor_refuses_before_original_IO_and_all_seven_ending_faults_refuse_without_retained_rows:true,
    closed_native_actual17_and_FIRST_writes_follow_all_current_ending_authority_and_native_member_checks:true,
    real_deferred_COMMIT_refuses_no_success_delivery_and_every_provisional_row_rolls_back:true,
    fresh_same_claim_repeat_reopens_originals_with_unchanged_job_lease_attempts_history_parents_blobs_reports_choices_pins:true,
    caller_source_candidate_binding_resolution_checkpoint_refused_before_original_IO:true,
    exact18_admission:false,source_resolution_issued:false,source_NEXT_or_EMPTY:false,
    economics:false,publication:false,activation:false,licensed_large_area:false,production_speed:false});
}
