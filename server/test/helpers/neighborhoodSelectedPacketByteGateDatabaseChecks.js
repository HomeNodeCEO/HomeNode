import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL as TRANSACTION,
  NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL as COMBINED }
  from '../../src/services/neighborhoodAssessment/neighborhoodSelectedTransactionOriginalPackageV2.js';
import { NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS as L }
  from '../../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';

/** Rolled-back TEMP SQL admission/plan DATA, not issued selection or rights.
 * Test-only relation/predicate substitution isolates byte admission. The separate
 * actual issued-owner fixture still verifies the COMPLETE original graph and
 * native checkpoint/selection/current/end authority; these TEMP rows do not.
 */
export async function runNeighborhoodSelectedPacketByteGateDatabaseChecks(client){
  const operation=randomUUID(),generation=randomUUID(),organization=randomUUID(),profile='a'.repeat(64),cadProfile='b'.repeat(64),
    tableNames={neighborhood_frozen_source_rows:'selected_gate_originals',neighborhood_frozen_typed_v2_rows:'selected_gate_typed',
      neighborhood_frozen_cad_improvement_rows:'selected_gate_cad',neighborhood_frozen_typed_cad_rows:'selected_gate_cad_typed',
      neighborhood_custom_cohort_stock_accounts:'selected_gate_stock',neighborhood_custom_cohort_capture_jobs:'selected_gate_jobs',
      neighborhood_custom_cohort_selected_union_v2_heads:'selected_gate_heads',neighborhood_cohort_evidence_blobs:'selected_gate_blobs',
      neighborhood_custom_cohort_selected_union_v2_rows:'selected_gate_union'},
    substitute=text=>{for(const [name,temp] of Object.entries(tableNames))text=text.replaceAll(`app.${name}`,`pg_temp.${temp}`);
      return text.replaceAll('app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)','true');};
  await client.query('BEGIN');
  try{
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TEMP TABLE selected_gate_originals(generation_id uuid,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,payload jsonb,PRIMARY KEY(generation_id,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE INDEX selected_gate_original_account_idx ON pg_temp.selected_gate_originals(generation_id,kind,account_id,row_key COLLATE "C")`);
    await client.query(`CREATE INDEX selected_gate_original_source_idx ON pg_temp.selected_gate_originals(generation_id,kind,source_record_id,row_key COLLATE "C")`);
    await client.query(`CREATE TEMP TABLE selected_gate_typed(generation_id uuid,profile_sha256 text,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,original_payload_sha256 text,typed jsonb,
      PRIMARY KEY(generation_id,profile_sha256,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_cad(generation_id uuid,kind text,row_key text COLLATE "C",account_id text,
      payload jsonb,payload_sha256 text,payload_utf8_bytes bigint,PRIMARY KEY(generation_id,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE INDEX selected_gate_cad_account_idx ON pg_temp.selected_gate_cad(generation_id,kind,account_id,row_key COLLATE "C")`);
    await client.query(`CREATE TEMP TABLE selected_gate_cad_typed(generation_id uuid,profile_sha256 text,kind text,row_key text COLLATE "C",
      account_id text,original_payload_sha256 text,typed jsonb,PRIMARY KEY(generation_id,profile_sha256,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_stock(operation_id uuid,account_id text COLLATE "C",parcel_count bigint,
      PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_jobs(operation_id uuid PRIMARY KEY,organization_id uuid,account_id text,checkpoint jsonb) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_heads(operation_id uuid,organization_id uuid,receipt_reference jsonb) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_blobs(organization_id uuid,content_sha256 text,canonical_utf8_bytes bigint,canonical_utf8 text) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE selected_gate_union(operation_id uuid,organization_id uuid,account_id text,ordinal integer,
      PRIMARY KEY(operation_id,organization_id,ordinal)) ON COMMIT DROP`);
    await client.query("INSERT INTO pg_temp.selected_gate_stock VALUES($1,'A',1),($1,'B',1)",[operation]);
    await client.query("INSERT INTO pg_temp.selected_gate_jobs VALUES($1,$2,'A','{}')",[operation,organization]);
    const body=JSON.stringify({format:'cohort_selected_union_receipt_v2',after:{done:true}}),bytes=Buffer.byteLength(body);
    await client.query('INSERT INTO pg_temp.selected_gate_heads VALUES($1,$2,$3)',[operation,organization,
      JSON.stringify({content_sha256:profile,canonical_utf8_bytes:String(bytes)})]);
    await client.query('INSERT INTO pg_temp.selected_gate_blobs VALUES($1,$2,$3,$4)',[organization,profile,bytes,body]);
    await client.query("INSERT INTO pg_temp.selected_gate_union VALUES($1,$2,'B',1)",[operation,organization]);
    for(const withCad of [false,true]){
      for(const name of ['selected_gate_originals','selected_gate_typed','selected_gate_cad','selected_gate_cad_typed'])
        await client.query(`DELETE FROM pg_temp.${name}`);
      await client.query(`INSERT INTO pg_temp.selected_gate_originals
        SELECT $1,k.kind,k.row_key,k.account_id,k.source_id,'{"SQL_DATA_only":true}'::jsonb
        FROM (VALUES ('parcels','A-part','A',NULL::bigint),('parcels','B-part','B',NULL::bigint),('accounts','B','B',NULL::bigint),
          ('source_records','10','B',10::bigint),('sales','20','B',10::bigint),('sale_links','30','B',10::bigint)) k(kind,row_key,account_id,source_id)`,[generation]);
      if(withCad)await client.query(`INSERT INTO pg_temp.selected_gate_cad
        SELECT $1,CASE WHEN n=1 THEN 'primary' ELSE 'secondary' END,n::text,'B','{"SQL_DATA_only":true}'::jsonb,$2,22
        FROM generate_series(1,244)n`,[generation,cadProfile]);
      else await client.query(`INSERT INTO pg_temp.selected_gate_originals
        SELECT $1,'sales',(100+n)::text,'B',10,'{"SQL_DATA_only":true}'::jsonb FROM generate_series(1,244)n`,[generation]);
      await client.query(`INSERT INTO pg_temp.selected_gate_typed SELECT generation_id,$1,kind,row_key,account_id,source_record_id,$1,
        '{"SQL_DATA_only":true}'::jsonb FROM pg_temp.selected_gate_originals`,[profile]);
      await client.query(`INSERT INTO pg_temp.selected_gate_cad_typed SELECT generation_id,$1,kind,row_key,account_id,$1,
        '{"SQL_DATA_only":true}'::jsonb FROM pg_temp.selected_gate_cad`,[cadProfile]);
      for(const name of Object.values(tableNames))await client.query(`ANALYZE pg_temp.${name}`);
      const sql=substitute(withCad?COMBINED:TRANSACTION),values=[operation,generation,profile,'',L.rows,L.page_utf8_bytes,
        L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes,true,...(withCad?[cadProfile]:[])],
        read=async(overrides={})=>{const args=[...values];for(const [i,v] of Object.entries(overrides))args[Number(i)]=v;
          const r=await client.query(sql,args);assert.equal(r.rowCount,1);return r.rows[0];},
        plan=async()=>{const p=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0].Plan,nodes=[];
          const walk=n=>{nodes.push(n);(n.Plans??[]).forEach(walk);};walk(p);return nodes;};
      const full=await read();assert.equal(full.account_id,'B');assert.equal(full.subject_account_id,'A');
      assert.equal(full.original_count,250);assert.equal(full.page_count,250);assert.equal(full.packet_oversize,false);
      assert.equal(full.invalid_count,0);assert.equal(JSON.parse(full.page_json).length,250);
      // Each original fits 1 MB, but their combined raw size exceeds 8 MB.
      for(const name of ['selected_gate_originals','selected_gate_cad'])
        await client.query(`UPDATE pg_temp.${name} SET payload=jsonb_build_object('SQL_DATA_only',repeat('x',40000))`);
      const over=await read();assert.equal(over.original_count,250);assert.equal(over.page_count,0);
      assert.equal(over.packet_oversize,true);assert.equal(over.page_json,'[]');
      const nodes=await plan();assert.equal(nodes.find(n=>n['Subplan Name']==='CTE raw_sizes')['Actual Rows'],250);
      assert.equal(nodes.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0,'no encoding after combined raw-byte refusal');
      for(const name of ['selected_gate_originals','selected_gate_cad'])
        await client.query(`UPDATE pg_temp.${name} SET payload='{"SQL_DATA_only":true}'::jsonb`);
      await client.query("UPDATE pg_temp.selected_gate_originals SET payload=jsonb_build_object('SQL_DATA_only',repeat('x',1000000)) WHERE row_key='B-part'");
      const largeOriginal=await read();assert.equal(largeOriginal.page_count,0);assert.equal(largeOriginal.packet_oversize,true);assert.equal(largeOriginal.page_json,'[]');
      await client.query(`UPDATE pg_temp.selected_gate_originals SET payload='{"SQL_DATA_only":true}'::jsonb WHERE row_key='B-part'`);
      const rawLower=(await client.query(`SELECT (sum(n)+2)::text AS n FROM (
        SELECT octet_length(o.payload::text)::bigint+octet_length(t.typed::text)+1 AS n
          FROM pg_temp.selected_gate_originals o JOIN pg_temp.selected_gate_typed t USING(generation_id,kind,row_key)
        UNION ALL SELECT octet_length(o.payload::text)::bigint+octet_length(t.typed::text)+1
          FROM pg_temp.selected_gate_cad o JOIN pg_temp.selected_gate_cad_typed t USING(generation_id,kind,row_key)) s`)).rows[0].n;
      const exactOver=await read({5:Number(rawLower)});assert.equal(exactOver.page_count,250);
      assert.equal(exactOver.packet_oversize,true);assert.equal(exactOver.page_json,'[]','raw lower bounds never replace exact encoding admission');
      await client.query("INSERT INTO pg_temp.selected_gate_originals VALUES($1,'parcels','one-over','B',NULL,'{}')",[generation]);
      const oneOver=await read();assert.equal(oneOver.original_count,251);assert.equal(oneOver.page_count,0);assert.equal(oneOver.page_json,'[]');
      const countNodes=await plan();assert.equal(countNodes.find(n=>n['Subplan Name']==='CTE raw_sizes')['Actual Rows'],0);
      assert.equal(countNodes.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0);
      await client.query("DELETE FROM pg_temp.selected_gate_originals WHERE row_key='one-over'");
      await client.query("DELETE FROM pg_temp.selected_gate_typed WHERE row_key='B-part'");
      const missing=await read();assert.equal(missing.original_count,250);assert.equal(missing.page_count,250);
      assert.equal(missing.invalid_count,1);assert.equal(JSON.parse(missing.page_json).find(r=>r.row_key==='B-part').typed,null);
      await client.query("UPDATE pg_temp.selected_gate_jobs SET account_id='NOT-STOCK'");
      const noSubject=await read();assert.equal(noSubject.subject_account_id,null);assert.equal(noSubject.page_count,0);assert.equal(noSubject.page_json,'[]');
      await client.query("UPDATE pg_temp.selected_gate_jobs SET account_id='A'");
      const empty=await read({3:'nonempty-cursor',9:false});assert.equal(empty.account_id,null);assert.equal(empty.original_count,0);
      assert.equal(empty.page_count,0);assert.equal(empty.packet_oversize,false);assert.equal(empty.page_json,'[]');
    }
    console.info('[native-selected-transaction-combined-raw-byte-gate-DATA-v2]',{both_fixed_plans:true,original_cap:250,
      mixed_families_share_one_byte_gate:true,actual_raw_size_rows:250,actual_raw_over_limit_encoded_rows:0,
      count_251_reads_zero_raw_sizes_and_zero_encoded_members:true,original_1MB_gate:true,
      raw_fit_exact_encoding_over_refused:true,missing_cache_not_skipped:true,missing_subject_zero_payload:true,
      fresh_empty_probe:true,temporary_DATA_only:true,issued_owner_authority:false,original_reconciliation:false,
      complete_selected_union_or_licensed_or_live_acceptance:false});
  }finally{await client.query('ROLLBACK');}
}
