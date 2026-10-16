import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createNeighborhoodSharedTypedOriginalPageV2,NEIGHBORHOOD_SHARED_TYPED_V2_SQL as SQL }
  from '../../src/services/neighborhoodAssessment/neighborhoodSharedTypedGeneration.js';
import { createCustomCohortNeutralCacheOwnerBudget } from '../../src/services/neighborhoodAssessment/customCohortOriginalAccountOwnerBudget.js';
import { getNeighborhoodFrozenTypedOriginalV2Profile } from '../../src/services/neighborhoodAssessment/neighborhoodFrozenTypedOriginalV1.js';

/** Small disposable native cache probe. This is storage/reconciliation proof,
 * never current job/source authorization, acquisition or speed acceptance. */
export async function runSharedTypedReconciliationDatabaseChecks(pool,sql,values,cad=false){
  const tables=cad?['neighborhood_frozen_typed_cad_generations','neighborhood_frozen_typed_cad_rows','neighborhood_frozen_typed_cad_totals']
    :['neighborhood_frozen_typed_v2_generations','neighborhood_frozen_typed_v2_rows','neighborhood_frozen_typed_v2_totals'];
  const input=JSON.parse(values[3]);assert.ok(input.length>0&&input.length<=250);
  const state=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,
    (await pool.query(`SELECT to_jsonb(r) AS body FROM app.${table} r WHERE generation_id=$1 AND profile_sha256=$2 ORDER BY to_jsonb(r)::text LIMIT 251`,values.slice(0,2))).rows])));
  const before=await state();
  const replay=async packet=>tx(pool,async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query(`SELECT 1 FROM app.${tables[0]} WHERE generation_id=$1 AND profile_sha256=$2 FOR UPDATE NOWAIT`,values.slice(0,2));
    const ack=(await client.query(sql,[...values.slice(0,3),JSON.stringify(packet)])).rows[0];
    if(ack.reconciled_count!==packet.length)throw Error('synthetic full-original-cache original_mismatch');return ack;
  });
  const ack=await replay(input);assert.equal(ack.inserted_count,0);assert.equal(ack.reconciled_count,input.length);
  assert.ok(BigInt(ack.typed_utf8_bytes)>0n);assert.deepEqual(await state(),before,'replay cannot double native INSERT totals or advance a header');
  for(const fault of ['typed','text','identity']){
    const changed=structuredClone(input);
    if(fault==='typed')changed[0].typed.cache_conflict_probe=true;
    if(fault==='text')changed[0].original_text+=' ';
    if(fault==='identity')changed[0].typed.account_id='FORGED-CACHE-ACCOUNT';
    await assert.rejects(replay(changed),/original_mismatch/);
    assert.deepEqual(await state(),before,`${fault} mismatch must roll back all cache/header/totals state`);
  }
  console.info('[native-shared-neutral-cache-row-reconciliation-v2]',{companion:cad?'CAD':'seven_layer',
    actual_reused_rows:input.length,new_insert_count:0,every_complete_original_text_and_identity_rechecked:true,
    entire_cached_JSON_equality:true,unchanged_hash_count_typed_forgery_refused:true,text_and_identity_forgery_refused:true,
    header_rows_and_INSERT_totals_unchanged:true,current_authorized_job_handoff:false,licensed_acquisition:false,production_speed:false});
}

/** Disposable storage proof only. The explicit fixed original query below is
 * fixture authority, never a job grant or an issued native coverage cursor. */
export async function runSharedTypedScopedPageDatabaseChecks(pool,generationId,complete=false){
  const readHeader=async()=>(await pool.query(SQL.read,[generationId,
    getNeighborhoodFrozenTypedOriginalV2Profile().profile_ref.content_sha256])).rows[0];
  const before=await readHeader();assert.equal(before.status,complete?'complete':'building');
  const run=async({changed=false,ending=false}={})=>tx(pool,async raw=>{
    await raw.query("SET LOCAL TIME ZONE 'UTC'");let sources=0;
    const client=createCustomCohortNeutralCacheOwnerBudget({async query(c){
      if(ending&&c.text===SQL.source&&++sources===2)throw Error('synthetic scoped neutral ending refusal');
      return raw.query(c);
    }},{checkBudget(){}});
    // This bounded fixture read is outside the writer. Real job ownership must
    // instead replay the native-issued source-root page under current rights.
    const original=(await client.query({text:SQL.page,values:[generationId,'accounts','',1,2_100_000]})).rows[0];
    const rows=JSON.parse(original.page_json);assert.equal(rows.length,1);
    if(changed)rows[0].payload_text+=' ';
    const r=await createNeighborhoodSharedTypedOriginalPageV2(client,{generationId}).reconcile({kind:'accounts',rows});
    return {r,rows};
  });
  const first=await run();assert.equal(first.r.reconciled_rows,1);assert.equal(first.r.inserted_rows,complete?0:1);
  assert.deepEqual(await readHeader(),before,'scoped row insertion cannot advance global builder progress');
  assert.equal((await run()).r.inserted_rows,0);
  await assert.rejects(run({changed:true}),/original_mismatch/);
  await assert.rejects(run({ending:true}),/synthetic scoped neutral ending refusal/);
  assert.deepEqual(await readHeader(),before);
  const totals=(await pool.query(`SELECT row_count::text AS n FROM app.neighborhood_frozen_typed_v2_totals
    WHERE generation_id=$1 AND profile_sha256=$2 AND kind='accounts'`,[generationId,first.r.profile_reference.content_sha256])).rows[0];
  assert.ok(BigInt(totals.n)>=1n);
  console.info('[native-scoped-neutral-original-page-v2]',{cache_status:before.status,actual_reconciled_rows:1,
    new_inserted_rows:first.r.inserted_rows,every_original_compiled:true,complete_cached_JSON_reconciled:true,
    original_text_forgery_and_ending_failure_rollback:true,global_builder_progress_unchanged:true,
    shared_aggregate_source_result_and_compiled_input_budget:true,job_coverage_head:false,
    current_authorized_job_handoff:false,licensed_acquisition:false,production_speed:false});
}

export async function runSharedTypedScopedPageBootstrapDatabaseChecks(pool,generationId){
  const key=[generationId,getNeighborhoodFrozenTypedOriginalV2Profile().profile_ref.content_sha256];
  assert.equal((await pool.query(SQL.read,key)).rowCount,0);
  await assert.rejects(tx(pool,async raw=>{
    await raw.query("SET LOCAL TIME ZONE 'UTC'");
    const client=createCustomCohortNeutralCacheOwnerBudget(raw,{checkBudget(){}}),
      page=(await client.query({text:SQL.page,values:[generationId,'accounts','',1,2_100_000]})).rows[0],
      result=await createNeighborhoodSharedTypedOriginalPageV2(client,{generationId})
        .reconcile({kind:'accounts',rows:JSON.parse(page.page_json)});
    assert.equal(result.inserted_rows,1);assert.equal(result.shared_cache_status,'building');
    const header=(await raw.query(SQL.read,key)).rows[0];
    assert.equal(header.progress.typed_rows,'0');assert.equal(header.progress.kind_index,0);
    throw Error('synthetic scoped neutral bootstrap rollback');
  }),/synthetic scoped neutral bootstrap rollback/);
  assert.equal((await pool.query(SQL.read,key)).rowCount,0);
  for(const table of ['neighborhood_frozen_typed_v2_rows','neighborhood_frozen_typed_v2_totals'])
    assert.equal((await pool.query(`SELECT 1 FROM app.${table} WHERE generation_id=$1 AND profile_sha256=$2 LIMIT 1`,key)).rowCount,0);
}
