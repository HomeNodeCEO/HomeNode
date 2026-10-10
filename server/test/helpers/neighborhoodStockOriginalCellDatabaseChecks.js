import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL as SQL, NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,
  NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL,NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,
  NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS as L }
  from '../../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';

/** SQL admission DATA only, on the already verified isolated native database.
 * TEMP rows are deliberately not issued originals/cache/rights. Table-name
 * substitution is test-only, never a production caller capability. Roll back
 * every fixture row and all four TEMP tables before returning to the owner test.
 */
export async function runNeighborhoodStockOriginalCellDatabaseChecks(client){
  const operation=randomUUID(),generation=randomUUID(),profile='a'.repeat(64);
  const substitute=text=>text.replaceAll('app.neighborhood_frozen_source_rows','pg_temp.stock_cell_data_originals')
    .replaceAll('app.neighborhood_frozen_typed_v2_rows','pg_temp.stock_cell_data_typed')
    .replaceAll('app.neighborhood_custom_cohort_stock_accounts','pg_temp.stock_cell_data_accounts')
    .replaceAll('app.neighborhood_custom_cohort_capture_jobs','pg_temp.stock_cell_data_jobs');
  const sql=substitute(SQL),packetSql=substitute(NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL);
  const values=[operation,generation,profile,'parcels','',250,L.page_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes];
  /** Read one complete SQL result, not an issued-owner reconciliation receipt. */
  const page=async overrides=>{const args=[...values];for(const [index,value] of Object.entries(overrides??{}))args[Number(index)]=value;
    const result=await client.query(sql,args);assert.equal(result.rowCount,1);return result.rows[0];};
  await client.query('BEGIN');
  try{
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TEMP TABLE stock_cell_data_originals(generation_id uuid,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,payload jsonb,PRIMARY KEY(generation_id,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE stock_cell_data_typed(generation_id uuid,profile_sha256 text,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,original_payload_sha256 text,typed jsonb,
      PRIMARY KEY(generation_id,profile_sha256,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE stock_cell_data_accounts(operation_id uuid,account_id text COLLATE "C",parcel_count bigint,
      PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE stock_cell_data_jobs(operation_id uuid PRIMARY KEY,account_id text COLLATE "C") ON COMMIT DROP`);
    await client.query("INSERT INTO pg_temp.stock_cell_data_jobs VALUES($1,'A')",[operation]);
    await client.query(`CREATE INDEX stock_cell_data_account_idx ON pg_temp.stock_cell_data_originals
      (generation_id,kind,account_id,row_key COLLATE "C") WHERE account_id IS NOT NULL`);
    await client.query("INSERT INTO pg_temp.stock_cell_data_accounts VALUES($1,'A',1)",[operation]);
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals
      SELECT $1::uuid,'parcels',(1000000+n)::text,CASE WHEN n=10001 THEN 'OUTSIDE' ELSE 'A' END,NULL,
        jsonb_build_object('object_id',(1000000+n)::text,'account_id',CASE WHEN n=10001 THEN 'OUTSIDE' ELSE 'A' END,'DATA_only',true)
      FROM generate_series(1,10001) n`,[generation]);
    await client.query(`INSERT INTO pg_temp.stock_cell_data_typed
      SELECT generation_id,$1,kind,row_key,account_id,NULL,$1,'{"SQL_admission_DATA_only":true}'::jsonb
      FROM pg_temp.stock_cell_data_originals`,[profile]);
    for(const table of ['stock_cell_data_originals','stock_cell_data_typed','stock_cell_data_accounts'])
      await client.query(`ANALYZE pg_temp.${table}`);
    const full=await page();assert.equal(full.page_count,250);assert.equal(full.candidate_count,250);
    assert.equal(full.invalid_count,0);assert.equal(full.oversized_count,0);assert.equal(full.next_cursor,'1000250');
    assert.equal(full.scan_count,250);assert.equal(full.scan_cursor,'1000250');
    assert.equal(JSON.parse(full.page_json).length,250);
    const explained=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0].Plan;
    /** Find the materialized fixed key prefix independently of InitPlan order. */
    const findScan=node=>node['Subplan Name']==='CTE scan_keys'?node:(node.Plans??[]).map(findScan).find(Boolean);
    const scan=findScan(explained);assert.ok(scan);assert.equal(scan['Node Type'],'Limit');assert.equal(scan['Actual Rows'],250);
    const mainInput=(scan.Plans??[]).filter(p=>p['Parent Relationship']==='Outer');assert.equal(mainInput.length,1);
    assert.match(mainInput[0]['Node Type'],/^Index(?: Only)? Scan$/);assert.equal(mainInput[0]['Actual Rows'],250);
    const first=await page({5:1}),prefix=await page({6:Buffer.byteLength(first.page_json)});
    assert.equal(prefix.page_count,1);assert.equal(prefix.candidate_count,250);assert.equal(prefix.next_cursor,'1000001');
    const outputPrefix=await page({9:1200});assert.equal(outputPrefix.page_count,1);assert.equal(outputPrefix.candidate_count,250);
    const oversize=await page({8:10});assert.equal(oversize.oversized_count,250);assert.equal(oversize.page_count,0);
    assert.equal(oversize.candidate_count,250);assert.equal(oversize.page_json,'[]','oversized originals never cross the SQL envelope');
    await client.query("DELETE FROM pg_temp.stock_cell_data_typed WHERE row_key='1000001'");
    const missing=await page({5:1});assert.equal(missing.invalid_count,1);assert.equal(missing.candidate_count,1);
    assert.equal(JSON.parse(missing.page_json)[0].typed,null,'an absent cache row stays a refusal, not a skipped original');
    const outside=await page({4:'1010000',5:1});assert.equal(outside.candidate_count,0);assert.equal(outside.page_json,'[]');
    assert.equal(outside.scan_count,1);assert.equal(outside.scan_cursor,'1010001');assert.equal(outside.next_cursor,'1010001');
    const empty=await page({4:outside.next_cursor,5:1});assert.equal(empty.scan_count,0);assert.equal(empty.next_cursor,null);
    console.info('[native-stock-original-cell-admission-DATA-v2]',{scoped_originals:10000,outside_excluded:1,
      original_key_prefix_cap:250,actual_plan_key_prefix_rows:250,actual_plan_index_input_rows:250,
      sparse_empty_page_advances_without_false_end:true,
      candidate_cap:250,transport_prefix:1,output_prefix:1,oversized_original_payload_rows:0,
      missing_cache_row_not_skipped:true,fresh_empty_probe:true,temporary_DATA_only:true,
      issued_owner_authority:false,original_reconciliation:false,licensed_or_live_acceptance:false});
    const packetValues=[operation,generation,profile,'',L.rows,L.page_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes],
      pairSql=substitute(NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL),pairValues=[...packetValues,true];
    /** Complete SQL packet or zero payload delivery; not a licensed source. */
    const packet=async overrides=>{const args=[...packetValues];for(const [i,v] of Object.entries(overrides??{}))args[Number(i)]=v;
      const r=await client.query(packetSql,args);assert.equal(r.rowCount,1);return r.rows[0];};
    const huge=await packet();assert.deepEqual(huge.original_counts,{parcels:251,accounts:0});
    assert.equal(huge.page_count,0);assert.equal(huge.page_json,'[]','over-limit original parts never reach Node');
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals
      SELECT $1::uuid,'accounts',('A-'||n),'A',NULL,'{"SQL_admission_DATA_only":true}'::jsonb FROM generate_series(1,1000) n`,[generation]);
    await client.query('ANALYZE pg_temp.stock_cell_data_originals');
    const both=await packet();assert.deepEqual(both.original_counts,{parcels:251,accounts:251});assert.equal(both.page_count,0);
    const plan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${packetSql}`,packetValues)).rows[0]['QUERY PLAN'][0].Plan;
    /** Locate the count cap by execution, not arbitrary InitPlan position. */
    const nodes=[];const walk=node=>{nodes.push(node);(node.Plans??[]).forEach(walk);};walk(plan);
    const cap=nodes.filter(n=>n['Node Type']==='Limit'&&n['Actual Rows']===251&&n['Actual Loops']===2);
    assert.equal(cap.length,1);const outer=cap[0].Plans.filter(n=>n['Parent Relationship']==='Outer');
    assert.equal(outer.length,1);assert.equal(outer[0]['Actual Rows'],251);
    await client.query("DELETE FROM pg_temp.stock_cell_data_originals WHERE kind='accounts' OR row_key>'1000249'");
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals VALUES($1,'accounts','A','A',NULL,'{"account_id":"A"}')`,[generation]);
    await client.query(`INSERT INTO pg_temp.stock_cell_data_typed
      SELECT generation_id,$1,kind,row_key,account_id,NULL,$1,'{"SQL_admission_DATA_only":true}'::jsonb
      FROM pg_temp.stock_cell_data_originals ON CONFLICT DO NOTHING`,[profile]);
    const admitted=await packet();assert.deepEqual(admitted.original_counts,{parcels:249,accounts:1});
    assert.equal(admitted.page_count,250);assert.equal(admitted.invalid_count,0);assert.equal(admitted.packet_oversize,false);
    assert.equal(JSON.parse(admitted.page_json).length,250);
    const planNodes=async(statement,args)=>{const p=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${statement}`,args)).rows[0]['QUERY PLAN'][0].Plan,all=[];
      const visit=n=>{all.push(n);(n.Plans??[]).forEach(visit);};visit(p);return all;};
    // Three distinct fixed admissions, sharing the same two production SQL
    // stems. Derived selected/fifth-pass plans also run in full issued owners.
    for(const [statement,args] of [[packetSql,packetValues],
      [substitute(NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL),[...packetValues.slice(0,3),'A',...packetValues.slice(4)]],
      [pairSql,pairValues]]){
      const read=async values=>(await client.query(statement,values??args)).rows[0];
      await client.query("UPDATE pg_temp.stock_cell_data_originals SET payload=jsonb_build_object('DATA_only',repeat('x',40000))");
      const rawOver=await read();assert.equal(rawOver.page_count,0);assert.equal(rawOver.packet_oversize,true);assert.equal(rawOver.page_json,'[]');
      const rawPlan=await planNodes(statement,args);assert.equal(rawPlan.find(n=>n['Subplan Name']==='CTE raw_sizes')['Actual Rows'],250);
      assert.equal(rawPlan.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0);
      await client.query(`UPDATE pg_temp.stock_cell_data_originals SET payload='{"SQL_admission_DATA_only":true}'::jsonb`);
      await client.query("UPDATE pg_temp.stock_cell_data_originals SET payload=jsonb_build_object('DATA_only',repeat('x',1000000)) WHERE kind='accounts'");
      const largeOriginal=await read();assert.equal(largeOriginal.page_count,0);assert.equal(largeOriginal.packet_oversize,true);
      await client.query(`UPDATE pg_temp.stock_cell_data_originals SET payload='{"SQL_admission_DATA_only":true}'::jsonb WHERE kind='accounts'`);
      const lower=Number((await client.query(`SELECT (sum(octet_length(o.payload::text)::bigint+octet_length(t.typed::text)+1)+2)::text AS n
        FROM pg_temp.stock_cell_data_originals o JOIN pg_temp.stock_cell_data_typed t USING(generation_id,kind,row_key)`)).rows[0].n),exactArgs=[...args];
      exactArgs[5]=lower;const exactOver=await read(exactArgs);assert.equal(exactOver.page_count,250);
      assert.equal(exactOver.packet_oversize,true);assert.equal(exactOver.page_json,'[]');
    }
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals VALUES($1,'parcels','1000250','A',NULL,'{"account_id":"A"}')`,[generation]);
    const oneOver=await packet();assert.deepEqual(oneOver.original_counts,{parcels:250,accounts:1});
    assert.equal(oneOver.page_count,0);assert.equal(oneOver.page_json,'[]');
    const countPlan=await planNodes(packetSql,packetValues);
    assert.equal(countPlan.find(n=>n['Subplan Name']==='CTE raw_sizes')['Actual Rows'],0);
    assert.equal(countPlan.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0);
    await client.query("DELETE FROM pg_temp.stock_cell_data_originals WHERE row_key='1000250'");
    const tooBig=await packet({7:10});assert.equal(tooBig.packet_oversize,true);assert.equal(tooBig.page_json,'[]');
    const transport=await packet({5:10});assert.equal(transport.packet_oversize,true);assert.equal(transport.page_json,'[]');
    const output=await packet({8:10});assert.equal(output.packet_oversize,true);assert.equal(output.page_json,'[]');
    await client.query("DELETE FROM pg_temp.stock_cell_data_typed WHERE row_key='1000001'");
    const absent=await packet();assert.equal(absent.invalid_count,1);assert.equal(absent.page_count,250);
    assert.equal(JSON.parse(absent.page_json).find(r=>r.row_key==='1000001').typed,null);
    const terminal=await packet({3:'A'});assert.equal(terminal.account_id,null);assert.equal(terminal.geographic_parcel_count,null);
    assert.deepEqual(terminal.original_counts,{parcels:0,accounts:0});assert.equal(terminal.page_json,'[]');
    console.info('[native-stock-account-package-admission-DATA-v2]',{total_cap:250,one_over:251,
      both_kind_count_caps:251,actual_main_count_input_rows:251,actual_count_loops:2,oversized_original_payload_rows:0,
      three_fixed_raw_byte_admissions:true,actual_raw_size_rows:250,actual_raw_over_limit_encoded_rows:0,
      per_original_1MB_gate:true,raw_fit_exact_encoding_over_refused:true,count_251_zero_raw_sizes_and_encoded_members:true,
      missing_cache_not_skipped:true,whole_byte_refusal:true,fresh_empty_probe:true,temporary_DATA_only:true,
      issued_owner_authority:false,original_reconciliation:false,licensed_or_live_acceptance:false});
    const pair=async overrides=>{const args=[...pairValues];for(const [i,v] of Object.entries(overrides??{}))args[Number(i)]=v;
        const r=await client.query(pairSql,args);assert.equal(r.rowCount,1);return r.rows[0];};
    const dedup=await pair();assert.equal(dedup.account_id,'A');assert.equal(dedup.subject_account_id,'A');
    assert.equal(dedup.original_count,250);assert.equal(dedup.page_count,250,'same subject and next do not double-charge or duplicate originals');
    await client.query("INSERT INTO pg_temp.stock_cell_data_accounts VALUES($1,'B',1)",[operation]);
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals VALUES($1,'parcels','B-part','B',NULL,'{"account_id":"B"}')`,[generation]);
    await client.query(`INSERT INTO pg_temp.stock_cell_data_typed
      SELECT generation_id,$1,kind,row_key,account_id,NULL,$1,'{"SQL_admission_DATA_only":true}'::jsonb
      FROM pg_temp.stock_cell_data_originals WHERE row_key='B-part'`,[profile]);
    const aggregateOver=await pair({3:'A'});assert.equal(aggregateOver.account_id,'B');assert.equal(aggregateOver.subject_account_id,'A');
    assert.equal(aggregateOver.next_parcels,1);assert.equal(aggregateOver.subject_parcels,249);assert.equal(aggregateOver.subject_accounts,1);
    assert.equal(aggregateOver.original_count,251);assert.equal(aggregateOver.page_count,0);assert.equal(aggregateOver.page_json,'[]');
    const pairOverPlan=await planNodes(pairSql,[...pairValues.slice(0,3),'A',...pairValues.slice(4)]);
    assert.equal(pairOverPlan.find(n=>n['Subplan Name']==='CTE raw_sizes')['Actual Rows'],0);
    assert.equal(pairOverPlan.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0);
    const blocked=await pair({3:'A',9:false});assert.equal(blocked.subject_account_id,null);assert.equal(blocked.original_count,1);
    assert.equal(blocked.page_count,1);assert.equal(JSON.parse(blocked.page_json)[0].account_id,'B');
    await client.query("UPDATE pg_temp.stock_cell_data_jobs SET account_id='NOT-STOCK'");
    const missingSubject=await pair({3:'A'});assert.equal(missingSubject.subject_account_id,null);assert.equal(missingSubject.original_count,1);
    assert.equal(missingSubject.page_count,0);assert.equal(missingSubject.page_json,'[]','missing subject blocks all payload admission');
    await client.query("UPDATE pg_temp.stock_cell_data_jobs SET account_id='A'");
    const pairEmpty=await pair({3:'B',9:false});assert.equal(pairEmpty.account_id,null);assert.equal(pairEmpty.original_count,0);
    assert.equal(pairEmpty.page_json,'[]');
    await client.query(`INSERT INTO pg_temp.stock_cell_data_originals
      SELECT $1::uuid,k.kind,('pair-'||a.id||'-'||k.kind||'-'||n),a.id,NULL,'{"SQL_admission_DATA_only":true}'::jsonb
      FROM (VALUES ('A'),('B')) a(id) CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind) CROSS JOIN generate_series(1,1000) n`,[generation]);
    await client.query('ANALYZE pg_temp.stock_cell_data_originals');
    const allCaps=await pair({3:'A'});assert.equal(allCaps.next_parcels,251);assert.equal(allCaps.next_accounts,251);
    assert.equal(allCaps.subject_parcels,251);assert.equal(allCaps.subject_accounts,251);assert.equal(allCaps.original_count,1004);
    assert.equal(allCaps.page_count,0);assert.equal(allCaps.page_json,'[]');
    const pairPlan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${pairSql}`,[...pairValues.slice(0,3),'A',...pairValues.slice(4)])).rows[0]['QUERY PLAN'][0].Plan;
    nodes.length=0;walk(pairPlan);const pairCap=nodes.filter(n=>n['Node Type']==='Limit'&&n['Actual Rows']===251&&n['Actual Loops']===4);
    assert.equal(pairCap.length,1);assert.equal(pairCap[0].Plans.filter(n=>n['Parent Relationship']==='Outer')[0]['Actual Rows'],251);
    console.info('[native-subject-next-original-packet-admission-DATA-v2]',{distinct_accounts_max:2,one_aggregate_original_cap:250,
      same_account_originals_deduplicated:250,different_accounts_aggregate_251_zero_payload:true,
      all_four_kind_counts_cap_plus_one:251,actual_count_loops:4,missing_subject_zero_payload:true,
      blocked_fallback_does_not_read_subject:true,fresh_empty_next_probe:true,temporary_DATA_only:true,
      issued_owner_authority:false,original_reconciliation:false,eligibility:false,licensed_or_live_acceptance:false});
  }finally{await client.query('ROLLBACK');}
}
