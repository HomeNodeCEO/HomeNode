import assert from 'node:assert/strict';

/** Native ninth DDL/refusal foundation ONLY. No original-source owner, complete
 * indexed population, successful ninth write or statistics is established. */
export async function runNeighborhoodSelectedNumericPopulationV2DatabaseChecks(pool){
  const rows='neighborhood_custom_cohort_selected_numeric_v2_rows',heads='neighborhood_custom_cohort_selected_numeric_v2_heads',
    columns=(await pool.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position`,[rows])).rows;
  assert.deepEqual(columns.map(r=>r.column_name),['operation_id','organization_id','ordinal','account_id','partition_ordinal',
    'entry_reference','metric_row_reference','contribution_row_reference']);
  assert.ok(columns.every(r=>['uuid','integer','text','jsonb'].includes(r.data_type)),'reference-only, no numeric or original payload column');
  const foreign=(await pool.query(`SELECT pg_get_constraintdef(c.oid) AS definition,c.confdeltype,c.confupdtype,
      target.relname AS referenced_table,ns.nspname AS referenced_schema FROM pg_constraint c
      JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace ns ON ns.oid=target.relnamespace
    WHERE c.conrelid=$1::regclass AND c.contype='f'`,['app.'+rows])).rows;
  for(const table of ['neighborhood_custom_cohort_selected_statistics_v2_rows','neighborhood_custom_cohort_selected_numeric_index_v2_rows']){
    const f=foreign.find(r=>r.referenced_schema==='app'&&r.referenced_table===table);assert.ok(f,table);
    assert.match(f.definition,/FOREIGN KEY \(operation_id, ordinal\)/);
    assert.equal(f.confdeltype,'r');assert.equal(f.confupdtype,'r');
  }
  const triggers=(await pool.query(`SELECT tgname,tgdeferrable,tginitdeferred,pg_get_triggerdef(oid) AS definition
    FROM pg_trigger WHERE tgrelid IN ($1::regclass,$2::regclass) AND NOT tgisinternal ORDER BY tgname`,['app.'+rows,'app.'+heads])).rows;
  for(const name of ['row','head']){
    const prefix='neighborhood_selected_numeric_v2_'+name,
      guard=triggers.find(r=>r.tgname===prefix+'_guard'),truncate=triggers.find(r=>r.tgname===prefix+'_truncate'),
      commit=triggers.find(r=>r.tgname===prefix+'_commit');
    assert.match(guard?.definition??'',/BEFORE/);
    for(const event of ['INSERT','UPDATE','DELETE'])assert.ok(guard.definition.includes(event),event);
    assert.match(truncate?.definition??'',/BEFORE TRUNCATE/);
    assert.equal(commit?.tgdeferrable,true);assert.equal(commit?.tginitdeferred,true);
  }
  for(const table of [rows,heads])await assert.rejects(pool.query('TRUNCATE app.'+table),
    error=>error.code==='55000'&&/custom_cohort_context_immutable/.test(error.message));
  const absent='70000000-0000-4000-8000-999999999999',
    refused=(await pool.query(`SELECT app.neighborhood_selected_numeric_v2_checkpoint_matches($1::uuid,$1::uuid,$2::jsonb) AS checkpoint,
      app.neighborhood_selected_numeric_v2_admission_matches($1::uuid,$1::uuid,$2::jsonb) AS admission`,
    [absent,JSON.stringify({phase:'frozen_selected_numeric_refs_v2',evidence_refs:[]})])).rows[0];
  assert.deepEqual(refused,{checkpoint:false,admission:false});
  return {native_DDL_and_immutable_TRUNCATE_refusal_only:true,reference_only_columns:8,
    restrictive_actual_eighth_and_numeric_child_FKs:2,deferred_real_COMMIT_guards:2,
    original_owner_integrated:false,successful_ninth_transition:false,complete_indexed_population:false,
    current_source_authority:false,statistics:false,licensed_acquisition:false,production_speed:false};
}
