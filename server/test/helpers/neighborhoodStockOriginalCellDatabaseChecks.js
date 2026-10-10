import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL as SQL,
  NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS as L }
  from '../../src/services/neighborhoodAssessment/neighborhoodSharedStockOriginalCellsV2.js';

/** SQL admission DATA only, on the already verified isolated native database.
 * TEMP rows are deliberately not issued originals/cache/rights. Table-name
 * substitution is test-only, never a production caller capability. Roll back
 * every fixture row and all three TEMP tables before returning to the owner test.
 */
export async function runNeighborhoodStockOriginalCellDatabaseChecks(client){
  const operation=randomUUID(),generation=randomUUID(),profile='a'.repeat(64);
  const sql=SQL.replaceAll('app.neighborhood_frozen_source_rows','pg_temp.stock_cell_data_originals')
    .replaceAll('app.neighborhood_frozen_typed_v2_rows','pg_temp.stock_cell_data_typed')
    .replaceAll('app.neighborhood_custom_cohort_stock_accounts','pg_temp.stock_cell_data_accounts');
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
    await client.query(`CREATE TEMP TABLE stock_cell_data_accounts(operation_id uuid,account_id text,
      PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query("INSERT INTO pg_temp.stock_cell_data_accounts VALUES($1,'A')",[operation]);
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
  }finally{await client.query('ROLLBACK');}
}
