import assert from 'node:assert/strict';
import { createCustomCohortCaptureJobRepository as jobs } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortSelectedUnionV2RecoveryRepository as recovery } from '../../src/services/neighborhoodAssessment/customCohortSelectedUnionV2RecoveryRepository.js';
import { withCustomCohortJobTransaction as transaction } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

// A separately built real native nine-root graph, retained for this bounded
// consumer. No copied parent, clock/lease/attempt rewrite, or free source data.
export async function runNeighborhoodInitialUnionRecoveryV2DatabaseChecks({pool,scope,operationId,originalClaim,
  runStep,setFault,restoreFault,originalReads,queryCount,assertOwnerQueries}){
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,/^neighborhood_[a-f0-9]{32}_test$/);
  const wholeJobSql='SELECT to_jsonb(j) AS body FROM app.neighborhood_custom_cohort_capture_jobs j WHERE operation_id=$1',
    job=async client=>(await client.query(wholeJobSql,[operationId])).rows[0].body,
    rows=async table=>(await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r WHERE operation_id=$1
      ORDER BY to_jsonb(r)::text COLLATE "C"`,[operationId])).rows,
    parentNames=(await pool.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
      USING(table_schema,table_name) WHERE c.table_schema='app' AND c.column_name='operation_id'
      AND t.table_type='BASE TABLE' AND c.table_name<>'neighborhood_custom_cohort_capture_jobs'
      AND c.table_name NOT LIKE 'neighborhood_custom_cohort_selected_union_v2_%' ORDER BY c.table_name`)).rows.map(r=>r.table_name);
  assert.ok(parentNames.length>8&&parentNames.every(n=>/^[a-z_][a-z0-9_]*$/.test(n)));
  const protectedRows=async()=>({parents:await Promise.all(parentNames.map(rows)),
    report:(await pool.query('SELECT to_jsonb(r) AS body FROM app.report_files r WHERE id=$1',[scope.report_file_id])).rows,
    assignment:(await pool.query('SELECT to_jsonb(r) AS body FROM app.assignment_files r WHERE id=$1',[scope.assignment_file_id])).rows,
    workspace:(await pool.query(`SELECT to_jsonb(r) AS body FROM app.custom_appraisal_workfile_sections r
      WHERE assignment_file_id=$1 ORDER BY section_key`,[scope.assignment_file_id])).rows}),
    union=async()=>Promise.all(['heads','groups','rows'].map(s=>rows(`neighborhood_custom_cohort_selected_union_v2_${s}`))),
    blobs=async()=>(await pool.query(`SELECT to_jsonb(b) AS body FROM app.neighborhood_cohort_evidence_blobs b
      WHERE organization_id=$1 ORDER BY content_sha256`,[scope.organization_id])).rows,
    before={job:await job(pool),parents:await protectedRows(),blobs:await blobs(),union:await union()};
  assert.equal(before.job.checkpoint.evidence_refs.length,9);assert.equal(before.job.attempts,2);
  assert.deepEqual(before.union,[[],[],[]]);
  assert.equal(Object.hasOwn(before.job.request_payload,'execution_mode'),false,
    'this independently issued protected graph retains the current allowlisted request grammar');
  assert.equal((await pool.query(`SELECT app.neighborhood_v2_initial_union_claim_bound(job) AS bound
    FROM app.neighborhood_custom_cohort_capture_jobs job WHERE operation_id=$1 AND organization_id=$2`,
  [operationId,scope.organization_id])).rows[0].bound,true,'actual entire initial9/native command/catalog/stock/pin must bind');
  const remaining=Number((await pool.query(`SELECT EXTRACT(EPOCH FROM (lease_expires_at-clock_timestamp()))*1000 AS ms
    FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1`,[operationId])).rows[0].ms);
  if(remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.ceil(remaining)+20));
  let reads=originalReads();await assert.rejects(runStep(originalClaim),/claim_lost/);assert.equal(originalReads(),reads);
  assert.deepEqual(await transaction(pool,c=>jobs(c).claimDue({limit:1,leaseSeconds:15})),[]);
  assert.deepEqual(await transaction(pool,c=>recovery(c).claimDue({limit:1,leaseSeconds:15})),[]);
  assert.deepEqual(await job(pool),before.job);
  // Actual expired9 claims through the fifth-failure ceiling, with natural
  // minimum15 leases and a REAL PostgreSQL ROLLBACK of the ENTIRE job tuple.
  // These are raw fixture transactions, not the bounded acquisition owner.
  const raw=await pool.connect();
  try{
    await raw.query('BEGIN');
    const owner=recovery(raw);
    for(const attempt of [3,4,5]){
      const nextRows=await owner.claimInitialDue({limit:1,leaseSeconds:15});
      assert.equal(nextRows.length,1,'one actual expired initial9 claim must be recoverable');
      const [next]=nextRows;assert.equal(next.claim.attempts,attempt);
      assert.notEqual(next.claim.claim_token,originalClaim.claim_token);assert.equal(next.authority,'not_established');
      const current=await job(raw);assert.deepEqual(current.checkpoint,before.job.checkpoint);
      const keep=j=>Object.fromEntries(Object.entries(j).filter(([k])=>!['attempts','claim_token','lease_expires_at','updated_at'].includes(k)));
      assert.deepEqual(keep(current),keep(before.job));
      assert.deepEqual(await owner.claimInitialDue({limit:1,leaseSeconds:15}),[]);
      await raw.query('SELECT pg_sleep(15.05)');
    }
    assert.deepEqual(await owner.claimInitialDue({limit:1,leaseSeconds:15}),[]);
    const exhausted=await job(raw);assert.equal(exhausted.status,'failed');assert.equal(exhausted.attempts,5);
    assert.equal(exhausted.last_error_code,'attempts_exhausted');assert.equal(exhausted.claim_token,null);assert.equal(exhausted.lease_expires_at,null);
    const keep=j=>Object.fromEntries(Object.entries(j).filter(([k])=>!['status','attempts','claim_token','lease_expires_at','last_error_code','updated_at'].includes(k)));
    assert.deepEqual(keep(exhausted),keep(before.job));
    assert.deepEqual(await owner.claimInitialDue({limit:1,leaseSeconds:15}),[]);assert.deepEqual(await job(raw),exhausted);
  }finally{await raw.query('ROLLBACK');raw.release();}
  assert.deepEqual(await job(pool),before.job);assert.deepEqual(await protectedRows(),before.parents);
  assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await union(),before.union);
  // Commit one actual fresh recovery claim before the real original owner.
  const claimed=(await Promise.all([1,2].map(()=>transaction(pool,c=>recovery(c).claimInitialDue({limit:1,leaseSeconds:120}))))).flat();
  assert.equal(claimed.length,1);const claim=claimed[0].claim,owned=await job(pool);
  assert.equal(claim.attempts,3);assert.notEqual(claim.claim_token,originalClaim.claim_token);
  const unchanged=async()=>{assert.deepEqual(await job(pool),owned);assert.deepEqual(await protectedRows(),before.parents);
    assert.deepEqual(await blobs(),before.blobs);assert.deepEqual(await union(),before.union);};
  await unchanged();reads=originalReads();await assert.rejects(runStep(originalClaim),/claim_lost/);assert.equal(originalReads(),reads);
  for(const [fault,reason]of [['catalog_owner_bytes_ending',/original_account_owner_byte_limit/],
    ['catalog_prior_head_ending',/group_workspace_selection_changed/],['catalog_workspace_revision_ending',/workspace_target_changed/],
    ['catalog_workspace_pending_ending',/group_workspace_study_changed/],['catalog_workspace_missing_ending',/group_workspace_unavailable/],
    ['license',/market_data_access_denied/],['role',/job_actor_access_revoked/],['subject',/subject_changed/],
    ['transaction_header',/cache_unavailable/],['stock_cells_original',/original_mismatch/],
    ['union_orphan_commit',e=>e.outcome_unknown===true&&/neighborhood_selected_union_v2_orphan_progress/.test(e.message)]]){
    setFault(fault);const from=queryCount();
    try{await assert.rejects(runStep(claim),reason);}
    finally{await restoreFault(fault);}
    assertOwnerQueries(from);await unchanged();
  }
  const from=queryCount();setFault('commit');reads=originalReads();
  await assert.rejects(runStep(claim),e=>e.outcome_unknown===true);assert.equal(originalReads(),reads+1);assertOwnerQueries(from);
  const first=await union(),advanced=await job(pool);
  assert.equal(first[0].length,1);assert.equal(first[0][0].body.sequence,1);
  assert.equal(advanced.status,'retry');assert.equal(advanced.attempts,3);assert.equal(advanced.last_error_code,before.job.last_error_code);
  assert.equal(advanced.claim_token,null);assert.equal(advanced.lease_expires_at,null);
  assert.deepEqual(advanced.checkpoint.evidence_refs.slice(0,9),before.job.checkpoint.evidence_refs);
  assert.equal(advanced.checkpoint.evidence_refs.length,10);
  const keptJob=j=>Object.fromEntries(Object.entries(j).filter(([k])=>!['status','claim_token','lease_expires_at','checkpoint','run_after','updated_at'].includes(k)));
  assert.deepEqual(keptJob(advanced),keptJob(owned));
  reads=originalReads();await assert.rejects(runStep(claim),/claim_lost/);assert.equal(originalReads(),reads);
  assert.deepEqual(await transaction(pool,c=>recovery(c).claimInitialDue({limit:1,leaseSeconds:15})),[]);
  // All prior parents except the actual consumed catalog continuation remain
  // identical; that existing continuation advances only with the real first10.
  const after=await protectedRows(),continuationIndex=parentNames.indexOf('neighborhood_custom_cohort_v2_continuations');
  assert.ok(continuationIndex>=0);after.parents[continuationIndex]=before.parents.parents[continuationIndex];
  assert.deepEqual(after,before.parents);
  const c=(await rows('neighborhood_custom_cohort_v2_continuations'))[0].body;
  const oldContinuation=before.parents.parents[continuationIndex][0].body;
  assert.deepEqual(c,{...oldContinuation,sequence:oldContinuation.sequence+1,phase:'frozen_selected_union_refs_v2',
    issued_attempts:3,issued_claim_token:claim.claim_token,consumed_claim_token:null,progress_reference:first[0][0].body.receipt_reference});
  assert.deepEqual(await transaction(pool,c=>jobs(c).cancel(scope,operationId)),{status:'cancelled'});
  console.info('[native-initial9-expired-union-recovery-v2]',{
    independent_actual9_command_consumed_catalog_parent_pin_and_every_root:true,
    natural_original120s_expiry_no_clock_lease_attempt_parent_grant_rewrite:true,
    original_expiry_and_cancellation_graph_unchanged_and_separate:true,
    natural_minimum15s_recovery3_4_5_terminal_exhaustion_no6_and_explicit_full_tuple_ROLLBACK:true,
    two_competing_closed_recoverers_single_committed_fresh_claim3_before_actual_original_owner:true,
    stale_original_claim_refuses_before_original_IO_and_all_current_ending_fences_repeat:true,
    real_orphan_COMMIT_refusal_and_lost_actual_first_union_COMMIT_ACK_no_duplicate:true,
    unchanged_original9_command_prior_native_parents_workspace_reports_choices_pins_and_failure_history:true,
    generic_admission_unchanged:true,source_authority:false,publication:false,worker_activation:false,licensed_acquisition:false,production_speed:false});
}
