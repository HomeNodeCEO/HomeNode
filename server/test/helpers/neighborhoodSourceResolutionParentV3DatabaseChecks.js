import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createCustomCohortSourceResolutionParentV3Repository as parentWriter } from '../../src/services/neighborhoodAssessment/customCohortSourceResolutionParentV3Repository.js';

const table='app.neighborhood_custom_cohort_source_resolution_v3_parents',
  firstTable='app.neighborhood_custom_cohort_source_resolution_v3_first',
  ddl=readFileSync(new URL('../../migrations/20261219_custom_cohort_source_resolution_parent_v3.sql',import.meta.url),'utf8'),
  firstDdl=readFileSync(new URL('../../migrations/20261220_custom_cohort_source_native_first_v3.sql',import.meta.url),'utf8');

// ONLY an independently captured disposable native CI database. The whole DDL
// and every provisional row are rolled back, including by a REAL rejected
// COMMIT. No installed migration, checkpoint codec or worker is changed.
export async function runNeighborhoodSourceResolutionParentV3DatabaseChecks({pool,scope,claim,owned,unchanged,laterFirstSource,candidate}){
  const client=await pool.connect();let open=false,discard=null;
  const query=(text,values)=>client.query({text,values,query_timeout:6000}),
    count=async()=>Number((await query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n),
    refusal=async(text,values,reason)=>{
      await query('SAVEPOINT refused_parent');
      try{await assert.rejects(query(text,values),reason);}
      finally{await query('ROLLBACK TO SAVEPOINT refused_parent');await query('RELEASE SAVEPOINT refused_parent');}
    };
  try{
    const identity=(await query('SELECT current_database() AS name')).rows[0];
    assert.match(identity.name,/^neighborhood_[a-f0-9]{32}_test$/);
    assert.equal((await query('SELECT to_regclass($1) AS relation',[table])).rows[0].relation,null);
    assert.equal((await query('SELECT to_regclass($1) AS relation',[firstTable])).rows[0].relation,null);
    await query('BEGIN');open=true;
    await query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    await query(ddl);
    // Exercise our statement guard before an INSERT queues deferred events;
    // PostgreSQL otherwise rejects TRUNCATE before invoking the guard itself.
    await refusal(`TRUNCATE ${table}`,[],/custom_cohort_context_immutable/);
    await query(firstDdl);
    await refusal(`TRUNCATE ${firstTable}`,[],/custom_cohort_context_immutable/);
    const values=[claim.operation_id,scope.organization_id],native=(await query(
      'SELECT * FROM app.neighborhood_source_resolution_v3_native_parent($1::uuid,$2::uuid)',values)).rows;
    assert.equal(native.length,1);
    assert.equal((await query('SELECT * FROM app.neighborhood_source_resolution_v3_native_first($1::uuid,$2::uuid)',values)).rowCount,0,
      'a projected native17 result cannot replace the actual retained parent row');
    const actual=native[0],head=owned.index.selected_transaction_index_v2_heads[0];
    assert.deepEqual(actual.parent_checkpoint,owned.job.checkpoint);
    assert.equal(actual.parent_checkpoint.phase,'frozen_selected_transaction_index_refs_v2');
    assert.equal(actual.parent_checkpoint.evidence_refs.length,17);
    assert.deepEqual(actual.index_reference,head.receipt_reference);assert.equal(actual.index_sequence,head.sequence);
    assert.equal(actual.command_id,head.command_id);assert.equal(actual.generation_id,head.generation_id);
    assert.equal(actual.issued_claim_token,claim.claim_token);assert.equal(actual.issued_attempts,claim.attempts);
    for(const key of ['report_file_id','assignment_file_id','account_id','actor_user_id','request_sha256'])
      assert.equal(actual[key],owned.job[key],key);
    assert.equal((await query('SELECT * FROM app.neighborhood_source_resolution_v3_native_parent($1::uuid,$2::uuid)',
      [claim.operation_id,randomUUID()])).rowCount,0);
    const forged=`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(p)||$3::jsonb)).*
      FROM app.neighborhood_source_resolution_v3_native_parent($1::uuid,$2::uuid) p`;
    const copied=structuredClone(actual.parent_checkpoint);copied.evidence_refs[0]=structuredClone(actual.index_reference);
    const projected=structuredClone(actual.parent_checkpoint);projected.phase='frozen_selected_source_resolution_refs_v3';
    projected.evidence_refs.push(structuredClone(actual.index_reference));
    for(const patch of [{parent_checkpoint:copied},{parent_checkpoint:projected},{generation_id:randomUUID()},
      {command_id:randomUUID()},{issued_claim_token:randomUUID()},{issued_attempts:claim.attempts===5?4:claim.attempts+1},
      {report_file_id:randomUUID()},{assignment_file_id:String(BigInt(actual.assignment_file_id)+1n)},{account_id:'FORGED-SUBJECT'},
      {actor_user_id:randomUUID()},{request_sha256:'0'.repeat(64)},
      {index_reference:actual.parent_checkpoint.evidence_refs[0]},{index_sequence:actual.index_sequence+1},
      {issued_transaction_id:'1'}]){
      await refusal(forged,[...values,JSON.stringify(patch)],/neighborhood_source_resolution_v3_actual_parent_required/);
      assert.equal(await count(),0);
    }
    const writerInput={client:{query},scope,claim,actorUserId:owned.job.actor_user_id};
    for(const change of [{claim:{...claim,claim_token:randomUUID()}},{claim:{...claim,attempts:claim.attempts===5?4:claim.attempts+1}},
      {scope:{...scope,organization_id:randomUUID()}},{scope:{...scope,report_file_id:randomUUID()}},
      {scope:{...scope,assignment_file_id:String(BigInt(scope.assignment_file_id)+1n)}},{scope:{...scope,account_id:'FORGED-SUBJECT'}},
      {actorUserId:randomUUID()}]){
      await assert.rejects(parentWriter({...writerInput,...change}).insertActual17Parent(),/claim_or_actual17_parent_lost/);
      assert.equal(await count(),0);
    }
    assert.deepEqual(await parentWriter(writerInput).insertActual17Parent(),actual);assert.equal(await count(),1);
    const first=(await query('SELECT * FROM app.neighborhood_source_resolution_v3_native_first($1::uuid,$2::uuid)',values)).rows;
    assert.equal(first.length,1);const binding=first[0],member=candidate.first_seen_selected_entry;
    assert.equal(binding.operation_id,claim.operation_id);assert.equal(binding.organization_id,scope.organization_id);
    assert.equal(binding.generation_id,actual.generation_id);assert.equal(binding.command_id,actual.command_id);
    assert.deepEqual(binding.index_reference,actual.index_reference);assert.equal(binding.index_sequence,actual.index_sequence);
    assert.equal(binding.issued_transaction_id,actual.issued_transaction_id);
    assert.deepEqual({kind:binding.kind,native_key:binding.native_key,first_selected_ordinal:binding.first_selected_ordinal},candidate.selected_source);
    assert.equal(binding.selected_account_id,member.account_id);assert.equal(binding.first_selected_ordinal,member.ordinal);
    for(const key of ['partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'])assert.deepEqual(binding[key],member[key]);
    const firstCount=async()=>Number((await query(`SELECT count(*)::integer AS n FROM ${firstTable}`)).rows[0].n),
      forgedFirst=`INSERT INTO ${firstTable} SELECT (jsonb_populate_record(NULL::${firstTable},to_jsonb(b)||$3::jsonb)).*
        FROM app.neighborhood_source_resolution_v3_native_first($1::uuid,$2::uuid) b`;
    for(const patch of [{generation_id:randomUUID()},{command_id:randomUUID()},{index_reference:actual.parent_checkpoint.evidence_refs[0]},
      {index_sequence:actual.index_sequence+1},{kind:'legacy_sale'},{native_key:'999999'},
      {first_selected_ordinal:binding.first_selected_ordinal===1?2:1},{selected_account_id:'FORGED-SELECTED'},
      {partition_ordinal:binding.partition_ordinal+1},{entry_reference:actual.index_reference},
      {metric_row_reference:actual.index_reference},{contribution_row_reference:actual.index_reference},{issued_transaction_id:'1'}]){
      await refusal(forgedFirst,[...values,JSON.stringify(patch)],/neighborhood_source_resolution_v3_native_first_required/);
      assert.equal(await firstCount(),0);
    }
    for(const change of [{claim:{...claim,claim_token:randomUUID()}},{claim:{...claim,attempts:claim.attempts===5?4:claim.attempts+1}},
      {scope:{...scope,organization_id:randomUUID()}},{scope:{...scope,report_file_id:randomUUID()}},
      {scope:{...scope,assignment_file_id:String(BigInt(scope.assignment_file_id)+1n)}},{scope:{...scope,account_id:'FORGED-SUBJECT'}},
      {actorUserId:randomUUID()}]){
      await assert.rejects(parentWriter({...writerInput,...change}).insertActualFirstSourceBinding(),/claim_or_actual17_parent_lost/);
      assert.equal(await firstCount(),0);
    }
    assert.deepEqual(await parentWriter(writerInput).insertActualFirstSourceBinding(),binding);assert.equal(await firstCount(),1);
    for(const sql of [`UPDATE ${firstTable} SET native_key=native_key`,`DELETE FROM ${firstTable}`])
      await refusal(sql,[],/neighborhood_source_resolution_v3_first_immutable/);
    for(const sql of [`UPDATE ${table} SET parent_checkpoint=parent_checkpoint`,`DELETE FROM ${table}`])
      await refusal(sql,[],/immutable|mutation_forbidden/);
    await refusal('SET CONSTRAINTS ALL IMMEDIATE',[],/neighborhood_source_resolution_v3_owner_unintegrated/);
    await assert.rejects(query('COMMIT'),/neighborhood_source_resolution_v3_owner_unintegrated/);open=false;
    assert.equal((await query('SELECT to_regclass($1) AS relation',[table])).rows[0].relation,null,
      'real failed COMMIT rolls back both native candidate DDL and every provisional row');
    assert.equal((await query('SELECT to_regclass($1) AS relation',[firstTable])).rows[0].relation,null);
  }catch(error){discard=error;throw error;}
  finally{
    if(open)try{await client.query({text:'ROLLBACK',query_timeout:1000});}catch(error){discard ||= error;}
    client.release(discard||undefined);
  }
  await unchanged();
  console.info('[native-source-resolution-actual17-parent-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_complete17_checkpoint_full_scope_index_generation_command_consumed_continuation_and_live_claim:true,
    forged_or_projected18_checkpoint_wrong_scope_reference_claim_attempt_and_transaction_refused:true,
    closed_writer_actual_native_scope_and_claim_refusals_before_DML:true,
    native_FIRST_requires_retained_actual17_parent_and_exact_first_seen_selected_member:true,
    actual_original_owner_candidate_matches_native_FIRST_without_becoming_SQL_input:true,
    forged_source_member_reference_transaction_and_seven_wrong_scope_claim_inserts_refused:true,
    provisional_parent_immutable_and_real_COMMIT_refused_DDL_and_rows_rolled_back:true,
    all_prior_native_job_parent_rows_blobs_reports_choices_and_pins_unchanged:true,
    exact18_admission:false,source_resolution_issued:false,source_NEXT_or_EMPTY:false,activation:false});
}
