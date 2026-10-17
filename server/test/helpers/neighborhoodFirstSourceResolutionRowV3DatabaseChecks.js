import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository as blobs } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const rows='app.neighborhood_custom_cohort_source_resolution_v3_rows',
  heads='app.neighborhood_custom_cohort_source_resolution_v3_heads';

// Test observation AFTER the actual service's real row AND head INSERTs. Never
// replace a query result or supply a plan/candidate/source-rights callback to
// the production owner. All probes run on its actual PostgreSQL transaction.
export async function observeNeighborhoodFirstSourceResolutionRowV3({raw,result,scope,expectedOrdinal}){
  assert.equal(result.rowCount,1);const head=result.rows[0],op=head.operation_id;
  const retained=(await raw.query(`SELECT r.*,b.canonical_utf8 FROM ${rows} r
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=r.organization_id
      AND b.content_sha256=r.candidate_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=r.candidate_reference->>'canonical_utf8_bytes'
    WHERE r.operation_id=$1 AND r.organization_id=$2`,[op,scope.organization_id])).rows;
  assert.equal(retained.length,1);const {canonical_utf8,...row}=retained[0];assert.deepEqual(row,head);
  const current=(await raw.query('SELECT txid_current()::text AS id')).rows[0].id;
  assert.equal(head.issued_transaction_id,current);
  const actual=(await raw.query('SELECT * FROM app.neighborhood_source_resolution_v3_native_first($1,$2)',[op,scope.organization_id])).rows;
  assert.equal(actual.length,1);const first=actual[0],body=JSON.parse(canonical_utf8);
  assert.equal(canonical_utf8,json(body));assert.ok(Buffer.byteLength(canonical_utf8)<=12000);
  assert.equal(body.command_id,first.command_id);assert.equal(body.generation_id,first.generation_id);
  assert.deepEqual(body.transaction_index_reference,first.index_reference);assert.equal(body.transaction_index_sequence,first.index_sequence);
  assert.deepEqual(body.selected_source,{kind:'source_record',native_key:'501',first_selected_ordinal:expectedOrdinal});
  assert.equal(first.first_selected_ordinal,expectedOrdinal);
  assert.deepEqual(body.first_seen_selected_entry,{account_id:first.selected_account_id,ordinal:first.first_selected_ordinal,
    partition_ordinal:first.partition_ordinal,entry_reference:first.entry_reference,
    metric_row_reference:first.metric_row_reference,contribution_row_reference:first.contribution_row_reference});
  // Independent golden observations survive storage as exact strings; neither
  // the outside native sale nor unsupported currency becomes allocated price.
  const resolution=body.resolution;
  assert.equal(resolution.unique_native_sale.account_id,'CLOSURE-OUTSIDE');
  assert.deepEqual(resolution.unique_native_sale.recorded_price,{state:'unsupported',exact_value:'9007199254740993',unit:null,reason:'unit_not_established'});
  assert.equal(resolution.native_calendar_quarter,'2010-Q1');assert.equal(resolution.native_period_disposition.state,'outside_period');
  assert.equal(resolution.same_payload_reported.closing_date.state,'missing');
  assert.equal(resolution.same_payload_reported.observations.reported_close_price.exact_value,'9007199254740993');
  const refuse=async(sql,values,reason)=>{
    await raw.query('SAVEPOINT refused_source_resolution');
    try{await assert.rejects(raw.query(sql,values),reason);}
    finally{await raw.query('ROLLBACK TO SAVEPOINT refused_source_resolution');await raw.query('RELEASE SAVEPOINT refused_source_resolution');}
  };
  for(const mutate of [p=>p.command_id='70000000-0000-4000-8000-000000000099',p=>p.generation_id=p.command_id,
    p=>p.transaction_index_reference=p.first_seen_selected_entry.entry_reference,p=>p.transaction_index_sequence++,
    p=>p.selected_stock_count++,p=>p.selected_source.native_key='503',p=>p.selected_source.first_selected_ordinal=expectedOrdinal===1?2:1,
    p=>p.first_seen_selected_entry.account_id='FORGED-SELECTED',p=>p.first_seen_selected_entry.metric_row_reference=p.transaction_index_reference,
    p=>p.resolution.native_key='503',p=>p.resolution.authority='established',p=>p.source_cursor_advanced=true,p=>p.extra=true]){
    // The blob's canonical hash is a representation check, not authority. A
    // perfectly well-formed forged blob still fails the native FIRST binding.
    await raw.query('SAVEPOINT refused_source_candidate');
    try{
      const changed=structuredClone(body);mutate(changed);const reference=await blobs(raw,scope.organization_id).put(json(changed));
      await assert.rejects(raw.query(`INSERT INTO ${rows} SELECT operation_id,organization_id,sequence,$2::jsonb,issued_transaction_id
        FROM ${rows} WHERE operation_id=$1`,[op,json(reference)]),/original_candidate_binding_required/);
    }finally{await raw.query('ROLLBACK TO SAVEPOINT refused_source_candidate');await raw.query('RELEASE SAVEPOINT refused_source_candidate');}
  }
  for(const table of [rows,heads])for(const statement of [`UPDATE ${table} SET sequence=sequence WHERE operation_id=$1`,
    `DELETE FROM ${table} WHERE operation_id=$1`])await refuse(statement,[op],/source_resolution_v3_(row|head)_immutable/);
  await refuse(`INSERT INTO ${rows} SELECT operation_id,organization_id,sequence,candidate_reference||'{"extra":true}'::jsonb,
    issued_transaction_id FROM ${rows} WHERE operation_id=$1`,[op],/original_candidate_binding_required/);
  await refuse(`INSERT INTO ${heads} SELECT operation_id,organization_id,sequence,
    jsonb_set(candidate_reference,'{content_sha256}',to_jsonb(repeat('0',64))),issued_transaction_id FROM ${rows} WHERE operation_id=$1`,
  [op],/original_row_required/);
  assert.deepEqual((await raw.query(`SELECT * FROM ${heads} WHERE operation_id=$1`,[op])).rows,[head]);
}

export async function runNeighborhoodFirstSourceResolutionRowV3DatabaseChecks({pool,input,scope,actor,service,
  claim,empty,setFault,readFault,originalReads,laterFirstSource}){
  const method='retainCoveredOriginalFrozenCaptureJobFirstSourceResolutionReferencesV3',options={captureJobClaim:claim},
    bind=()=>service[method](input,options);
  for(const key of ['source','candidate','binding','checkpoint','resolution','candidateReference','row','head']){
    const reads=originalReads();await assert.rejects(service[method](input,{...options,[key]:{}}),/invalid_options/);
    assert.equal(originalReads(),reads);await empty();
  }
  let reads=originalReads();
  await pool.query('DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2',[scope.organization_id,actor]);
  try{await assert.rejects(bind(),/custom_cohort_job_actor_access_revoked/);assert.equal(originalReads(),reads);}
  finally{await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
  await empty();
  for(const [fault,reason]of [['completed_source_cache',/original_mismatch/],['union_workspace',/custom_cohort_group_workspace_study_changed/],
    ['union_role',/custom_cohort_job_actor_access_revoked/],['catalog_replay_rights',/market_data_access_denied|market_policy_changed/],
    ['selected_CAD_deny',/market_data_access_denied|cad_policy_changed/],['selected_CAD_header',/cache_unavailable/],['selected_CAD_coverage',/coverage_unavailable/]]){
    reads=originalReads();setFault(fault);
    try{await assert.rejects(bind(),reason);assert.equal(readFault(),null);assert.equal(originalReads(),reads+1);}
    finally{if(fault==='union_role')await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",[scope.organization_id,actor]);}
    await empty();
  }
  for(let attempt=0;attempt<2;attempt++){
    reads=originalReads();setFault('source_resolution_observe');
    await assert.rejects(bind(),e=>e.outcome_unknown===true&&e.code==='55000'&&e.message.includes('source_resolution_v3_owner_unintegrated'));
    assert.equal(readFault(),null,'actual row/head INSERT observation must execute before deferred COMMIT refusal');
    assert.equal(originalReads(),reads+1);await empty();
  }
  console.info('[native-first-source-resolution-actual-original-row-head-v3]',{
    independent_capture:laterFirstSource?'B_ordinal2_after_empty_A':'A_ordinal1',
    actual_service_owns_original_IO_ENTIRE_caches_current_ending_authority_and_all_native_members:true,
    actual_native_parent_FIRST_blob_row_and_head_same_transaction_observed_before_real_COMMIT:true,
    exact_original_outside_sale_unsafe_decimal_unsupported_currency_dates_and_reported_observations_preserved:true,
    canonical_forged_blob_binding_and_authority_cursor_extra_fields_refuse_without_source_authority_substitution:true,
    actual_row_head_immutability_wrong_head_reference_refusal_and_identical_fresh_same_claim_repeat:true,
    seven_ending_faults_refuse_all_provisional_rows_AND_blobs_rollback_all_prior_state_unchanged:true,
    real_deferred_COMMIT_refuses_no_success_delivery:true,exact18:false,durable_issuance:false,
    source_NEXT_or_EMPTY:false,economics:false,publication:false,activation:false,licensed_large_area:false,production_speed:false});
}
