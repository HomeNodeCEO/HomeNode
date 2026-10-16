import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction as tx } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

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
