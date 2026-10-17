import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2ContinuationRepository as continuations } from '../../src/services/neighborhoodAssessment/customCohortV2ContinuationRepository.js';
import { withCustomCohortJobTransaction as transaction } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { runNeighborhoodFirstSourceOwnedClaimV3DatabaseChecks } from './neighborhoodFirstSourceOwnedClaimV3DatabaseChecks.js';

// Run only after the unchanged earlier six-refusal probes in this independently
// captured disposable database. The real service owns originals/BEGIN/COMMIT.
export async function runNeighborhoodFirstSourceBirthCommitV3DatabaseChecks({pool,input,scope,actor,service,
  claim,empty,setFault,readFault,originalReads,laterFirstSource}){
  const names=['parents','first','rows','heads','handoffs'].map(s=>`neighborhood_custom_cohort_source_resolution_v3_${s}`),
    read=async table=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r
      WHERE operation_id=$1 ORDER BY to_jsonb(r)::text COLLATE "C"`,[input.operationId])).rows,
    job=async()=>(await read('neighborhood_custom_cohort_capture_jobs'))[0].body,
    blobRows=async()=>(await pool.query(`SELECT to_jsonb(b) AS body FROM app.neighborhood_cohort_evidence_blobs b
      WHERE organization_id=$1 ORDER BY content_sha256`,[scope.organization_id])).rows,
    method='retainCoveredOriginalFrozenCaptureJobFirstSourceHandoffReferencesV3',options={captureJobClaim:claim},
    run=()=>service[method](input,options),setup=await pool.connect();
  let open=false,discard;
  try{
    assert.match((await setup.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
    await setup.query('BEGIN');open=true;
    await setup.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'");
    await setup.query({text:readFileSync(new URL('../../migrations/20261225_custom_cohort_source_first_birth_commit_v3.sql',import.meta.url),'utf8'),query_timeout:6000});
    const guards=(await setup.query(`SELECT tgname,tgdeferrable,tginitdeferred,tgenabled FROM pg_trigger
      WHERE tgname IN ('neighborhood_source_resolution_v3_parent_commit','neighborhood_source_resolution_v3_first_commit',
        'neighborhood_source_resolution_v3_row_commit','neighborhood_source_resolution_v3_head_commit',
        'neighborhood_source_resolution_v3_first_checkpoint_commit','neighborhood_source_resolution_v3_first_handoff_commit')`)).rows;
    assert.equal(guards.length,6);assert.ok(guards.every(g=>g.tgdeferrable&&g.tginitdeferred&&g.tgenabled==='O'));
    await setup.query('COMMIT');open=false;
  }catch(error){discard=error;throw error;}
  finally{if(open)try{await setup.query({text:'ROLLBACK',query_timeout:1000});}catch(error){discard ||= error;}setup.release(discard||undefined);}
  await empty();
  // Installing conditional guards must not make any of the earlier partial
  // owners committable. Each actual attempt reopens originals and rolls back.
  for(const partial of ['retainCoveredOriginalFrozenCaptureJobFirstSourceBindingReferencesV3',
    'retainCoveredOriginalFrozenCaptureJobFirstSourceResolutionReferencesV3',
    'retainCoveredOriginalFrozenCaptureJobFirstSourceCheckpointReferencesV3']){
    const count=originalReads();
    await assert.rejects(service[partial](input,options),e=>e.outcome_unknown===true&&e.code==='55000'
      &&e.message==='neighborhood_source_resolution_v3_first_birth_conflict');
    assert.equal(originalReads(),count+1);await empty();
  }
  // These whole rows establish preservation of EVERY prior native operation
  // parent, not just its counts/hashes. This is a small CI fixture, never a
  // dense-population acquisition path or licensed capacity acceptance.
  const parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='app' AND c.column_name='operation_id' AND t.table_type='BASE TABLE'
      AND c.table_name<>'neighborhood_custom_cohort_capture_jobs'
      AND c.table_name<>ALL($1::text[]) ORDER BY c.table_name`,[names])).rows.map(r=>r.table_name);
  assert.ok(parentNames.length>10);assert.ok(parentNames.every(n=>/^[a-z_][a-z0-9_]*$/.test(n)));
  const protectedRows=async()=>({parents:await Promise.all(parentNames.map(read)),
    report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    assignment:(await pool.query('SELECT to_jsonb(r) AS body FROM app.assignment_files r WHERE id=$1',[scope.assignment_file_id])).rows,
    workspace:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows}),
    before={job:await job(),protected:await protectedRows(),blobs:await blobRows()};
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(run(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await empty();
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],
    ['union_workspace',/custom_cohort_group_workspace_study_changed/],['union_role',/custom_cohort_job_actor_access_revoked/],
    ['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],['selected_CAD_header',/cache_unavailable/],
    ['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);
    try{await assert.rejects(run(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await empty();
  }
  // The returned native rows are real. Roll back ONLY the actual handoff/job
  // statement after the actual retained read; parent/FIRST/row/head events
  // remain queued. Their genuine COMMIT must refuse the orphan, with no result.
  reads=originalReads();setFault('source_birth_orphan');
  await assert.rejects(run(),e=>e.outcome_unknown===true&&e.code==='55000'&&e.message==='neighborhood_source_resolution_v3_first_birth_conflict');
  assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);await empty();
  reads=originalReads();
  if(laterFirstSource){
    setFault('completed_source_ack');await assert.rejects(run(),e=>e.outcome_unknown===true);
    assert.equal(readFault(),null);
  }else{
    assert.deepEqual(await run(),{status:'original_first_source_birth_retained',operation_id:input.operationId,
      read_only:false,durable_source_resolution_issued:true,source_cursor_advanced:false,fresh_claim_admitted:false,
      context_complete:false,pin_transfer:false,report_update:'none',activation:false});
  }
  assert.equal(originalReads(),reads+1);
  const current=await job(),source=Object.fromEntries(await Promise.all(names.map(async n=>[n,await read(n)])));
  assert.ok(Object.values(source).every(rows=>rows.length===1));
  const handoff=source[names[4]][0].body,first=source[names[1]][0].body,head=source[names[3]][0].body;
  assert.deepEqual(handoff.birth_job,before.job);
  const unchangedFields=j=>Object.fromEntries(Object.entries(j).filter(([k])=>!['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'].includes(k)));
  assert.deepEqual(unchangedFields(current),unchangedFields(before.job));assert.equal(current.status,'retry');
  assert.equal(current.claim_token,null);assert.equal(current.lease_expires_at,null);
  assert.deepEqual(current.checkpoint,handoff.checkpoint);assert.deepEqual(current.checkpoint.evidence_refs,
    [...handoff.birth_job.checkpoint.evidence_refs,head.candidate_reference]);
  assert.equal(current.checkpoint.evidence_refs.length,18);assert.equal(first.first_selected_ordinal,laterFirstSource?2:1);
  assert.equal(first.selected_account_id,laterFirstSource?'CLOSURE-B':'CLOSURE-A');
  assert.deepEqual(await protectedRows(),before.protected);
  const afterBlobs=await blobRows();assert.equal(afterBlobs.length,before.blobs.length+1);
  for(const b of before.blobs)assert.deepEqual(afterBlobs.find(r=>r.body.content_sha256===b.body.content_sha256),b);
  assert.ok(afterBlobs.some(r=>r.body.content_sha256===head.candidate_reference.content_sha256
    &&String(r.body.canonical_utf8_bytes)===head.candidate_reference.canonical_utf8_bytes));
  // The old issued claim cannot replay, recreate birth17 or spend/refund a
  // failure. No generic queue or old continuation can adopt this fresh18.
  reads=originalReads();await assert.rejects(run(),/claim_lost|checkpoint_conflict/);assert.equal(originalReads(),reads);
  assert.deepEqual(await transaction(pool,c=>jobs(c).claimDue({limit:1,leaseSeconds:120})),[]);
  assert.deepEqual(await transaction(pool,c=>continuations(c).claimDue({limit:1,leaseSeconds:120})),[]);
  assert.deepEqual(await job(),current);assert.deepEqual(await protectedRows(),before.protected);assert.deepEqual(await blobRows(),afterBlobs);
  for(const n of names)assert.deepEqual(await read(n),source[n]);
  console.info('[native-first-source-coherent-birth-COMMIT-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    real_original_owner_and_every_current_ending_authority_ENTIRE_cache_native_member_fence:true,
    six_deferred_events_enabled_each_independently_reopens_entire_birth_and_actual_FIRST_graph:true,
    genuine_orphan_COMMIT_refusal_full_job_rows_blobs_rollback:true,
    actual_durable_entire_birth17_FIRST_row_head_blob_and_atomic18_retry_claim_clear:true,
    actual_lost_COMMIT_ACK:!!laterFirstSource,success_delivered_after_real_COMMIT:!laterFirstSource,
    stale_claim_no_original_IO_no_duplicate_generic_and_old_continuation_excluded:true,
    every_prior_native_parent_full_job_other_fields_workspace_reports_choices_and_pins_preserved:true,
    fresh18_claim:false,recovery:false,NEXT_or_EMPTY:false,activation:false,licensed_large_area:false,production_speed:false});
  await runNeighborhoodFirstSourceOwnedClaimV3DatabaseChecks({pool,input,scope,actor,service,claim,originalReads,laterFirstSource});
}
