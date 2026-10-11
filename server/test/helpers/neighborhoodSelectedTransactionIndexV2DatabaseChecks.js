import assert from 'node:assert/strict';
import {withCustomCohortJobTransaction} from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

const tables=['neighborhood_custom_cohort_selected_transaction_index_v2_rows',
  'neighborhood_custom_cohort_selected_transaction_source_v2_keys','neighborhood_custom_cohort_selected_transaction_legacy_v2_keys',
  'neighborhood_custom_cohort_selected_transaction_index_v2_edges','neighborhood_custom_cohort_selected_transaction_index_v2_heads'];
const keys='app.neighborhood_selected_transaction_index_v2_next_keys($1::uuid,$2::uuid)',
  member=`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_rows
    (operation_id,organization_id,generation_id,ordinal,account_id,partition_ordinal,entry_reference,metric_row_reference,contribution_row_reference)
    SELECT DISTINCT $1::uuid,$2::uuid,generation_id,ordinal,account_id,partition_ordinal,entry_reference,metric_row_reference,contribution_row_reference
    FROM ${keys} WHERE account_id IS NOT NULL`,
  sources=`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
    (operation_id,organization_id,generation_id,source_record_id,first_selected_ordinal)
    SELECT $1::uuid,$2::uuid,generation_id,native_key::bigint,ordinal FROM ${keys} WHERE kind='source_record'`,
  legacy=`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
    (operation_id,organization_id,generation_id,legacy_sale_key,first_selected_ordinal)
    SELECT $1::uuid,$2::uuid,generation_id,native_key,ordinal FROM ${keys} WHERE kind='legacy_sale'`,
  edges=`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_edges
    (operation_id,organization_id,generation_id,ordinal,account_id,kind,source_record_id,legacy_sale_key)
    SELECT $1::uuid,$2::uuid,generation_id,ordinal,account_id,kind,
      CASE WHEN kind='source_record' THEN native_key::bigint END,CASE WHEN kind='legacy_sale' THEN native_key END
    FROM ${keys} WHERE kind IS NOT NULL`,
  head=`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_heads
    (operation_id,organization_id,generation_id,command_id,union_reference,eligibility_reference,evidence_reference,
      metrics_reference,statistics_reference,numeric_reference,semantic_reference,receipt_reference,sequence,issued_transaction_id)
    SELECT s.operation_id,s.organization_id,stock.generation_id,s.command_id,s.union_reference,s.eligibility_reference,s.evidence_reference,
      s.metrics_reference,s.statistics_reference,s.numeric_reference,s.receipt_reference,s.receipt_reference,1,txid_current()
    FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads s JOIN app.neighborhood_custom_cohort_job_stocks stock USING(operation_id,organization_id)
    WHERE s.operation_id=$1::uuid AND s.organization_id=$2::uuid`;

/** Provisional native storage checks on an independently issued exact16 graph.
 * Direct SQL is intentional and cannot COMMIT. This is NOT the original owner,
 * current rights, successful phase17, cross-account dedup or recovery acceptance.
 * No full new owner calls are added to the near-deadline native fixtures. */
export async function runNeighborhoodSelectedTransactionIndexV2DatabaseChecks(pool,operation,organization,value){
  const bound=[operation,organization],empty=value.empty_selected_union,
    snapshot=async()=>Promise.all(tables.map(async table=>(await pool.query(`SELECT * FROM app.${table} WHERE operation_id=$1`,[operation])).rows)),
    before=await snapshot(),plan=(await pool.query(`SELECT * FROM ${keys}`,bound)).rows,
    matched=async client=>(await client.query('SELECT app.neighborhood_selected_transaction_index_v2_next_edges_match($1::uuid,$2::uuid) AS matched',bound)).rows[0].matched;
  assert.ok(before.every(rows=>rows.length===0));assert.ok(plan.length>=1&&plan.length<=250);
  assert.equal(plan[0].account_id,value.selected_entry?.account_id??null);assert.equal(plan[0].ordinal,empty?null:1);
  assert.deepEqual(plan.filter(r=>r.kind!==null).map(r=>({kind:r.kind,native_key:r.native_key})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [...value.native_packages].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(plan[0].anchor_count,value.membership.associations.filter(r=>r.account_id===value.selected_entry?.account_id).length);
  const triggers=(await pool.query(`SELECT c.relname,t.tgdeferrable,t.tginitdeferred,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='app' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal`,[tables])).rows;
  for(const table of tables){
    const rows=triggers.filter(t=>t.relname===table);assert.equal(rows.length,3,table);
    assert.ok(rows.some(t=>t.definition.includes('BEFORE')&&['INSERT','UPDATE','DELETE'].every(event=>t.definition.includes(event))));
    assert.ok(rows.some(t=>t.definition.includes('BEFORE TRUNCATE')));
    assert.ok(rows.some(t=>t.tgdeferrable&&t.tginitdeferred));
  }
  // All restrictive FK children are explicit; reach the native immutable guard.
  await assert.rejects(pool.query('TRUNCATE app.neighborhood_custom_cohort_selected_transaction_index_v2_rows, app.neighborhood_custom_cohort_selected_transaction_source_v2_keys, app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys, app.neighborhood_custom_cohort_selected_transaction_index_v2_edges'),
    error=>error.code==='55000'&&/custom_cohort_context_immutable/.test(error.message));
  const client=await pool.connect();let discard;
  try{
    await client.query('BEGIN');
    const refusal=async(sql,pattern,values=bound)=>{
      await client.query('SAVEPOINT native_transaction_index_refusal');
      await assert.rejects(client.query(sql,values),pattern);
      await client.query('ROLLBACK TO SAVEPOINT native_transaction_index_refusal');
      await client.query('RELEASE SAVEPOINT native_transaction_index_refusal');
    };
    assert.equal(await matched(client),empty);
    await refusal(head,/selected_transaction_index_v2_owner_unintegrated/);
    if(!empty){
      await refusal(member.replace('SELECT DISTINCT $1::uuid,$2::uuid,generation_id,ordinal',
        "SELECT DISTINCT $1::uuid,$2::uuid,'70000000-0000-4000-8000-999999999999'::uuid,ordinal"),/native_binding/);
      // Change only the SELECT, not the explicit INSERT column list.
      await refusal(member.replace('SELECT DISTINCT $1::uuid,$2::uuid,generation_id,ordinal',
        'SELECT DISTINCT $1::uuid,$2::uuid,generation_id,ordinal+1'),/member_binding/);
      assert.equal((await client.query(member,bound)).rowCount,1);assert.equal(await matched(client),false);
      await client.query(sources,bound);await client.query(legacy,bound);
      // Full registries without edges still fail exact set reconciliation.
      assert.equal(await matched(client),false);
      for(const sql of [sources,legacy])await client.query(sql+' ON CONFLICT DO NOTHING',bound);
      await refusal(`UPDATE app.neighborhood_custom_cohort_selected_transaction_source_v2_keys SET first_selected_ordinal=2 WHERE operation_id=$1`,/immutable/,[operation]);
      await refusal(`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
        (operation_id,organization_id,generation_id,source_record_id,first_selected_ordinal)
        SELECT $1::uuid,$2::uuid,generation_id,9223372036854775807,ordinal FROM ${keys} LIMIT 1`,/native_key/);
      await refusal(`INSERT INTO app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
        (operation_id,organization_id,generation_id,legacy_sale_key,first_selected_ordinal)
        SELECT $1::uuid,$2::uuid,generation_id,'9223372036854775807',ordinal FROM ${keys} LIMIT 1`,/native_key/);
      await client.query(edges,bound);assert.equal(await matched(client),true);
      await refusal(`UPDATE app.neighborhood_custom_cohort_selected_transaction_index_v2_edges SET account_id='CLOSURE-OUTSIDE' WHERE operation_id=$1`,/immutable/,[operation]);
      await refusal('SET CONSTRAINTS ALL IMMEDIATE',/selected_transaction_index_v2_owner_unintegrated/);
      assert.equal(await matched(client),true,'savepoint refusal preserves the provisional exact set');
    }
    await client.query('ROLLBACK');
  }catch(error){discard=error;try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release(discard);}
  assert.deepEqual(await snapshot(),before);
  if(!empty){
    // Real COMMIT, not SET CONSTRAINTS alone. Outcome is re-read independently:
    // the production helper correctly marks a rejected COMMIT as unknown first.
    await assert.rejects(withCustomCohortJobTransaction(pool,async transaction=>{
      await transaction.query(member,bound);await transaction.query(sources,bound);await transaction.query(legacy,bound);
      await transaction.query(edges,bound);assert.equal(await matched(transaction),true);
    }),error=>error.code==='55000'&&error.outcome_unknown===true&&/selected_transaction_index_v2_owner_unintegrated/.test(error.message));
    assert.deepEqual(await snapshot(),before,'fresh read proves no provisional child survived the refused COMMIT');
  }
  return {native_storage_foundation_only:true,exact16_issued_parent:true,empty,
    bounded_original_key_sets:true,separate_native_source_BIGINT_and_legacy_C_namespaces:true,
    provisional_missing_edges_refused:!empty,provisional_exact_edges:!empty,
    immutable_first_seen_and_edges:!empty,unintegrated_head_refused:true,
    unintegrated_deferred_and_real_COMMIT_refused:!empty,no_retained_children:true,
    actual_eleventh_owner:false,phase17:false,global_selected_native_deduplication:false,
    source_authority:false,licensed_acquisition:false,production_speed:false};
}
