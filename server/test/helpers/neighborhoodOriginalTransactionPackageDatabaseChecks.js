import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL as SQL,NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_LIMITS as L }
  from '../../src/services/neighborhoodAssessment/neighborhoodOriginalTransactionPackagesV2.js';

/** Rolled-back SQL admission/plan DATA only. These TEMP tables do not issue
 * originals, cache, rights, selected-union or licensed/live acceptance. */
export async function runNeighborhoodOriginalTransactionPackageDatabaseChecks(client){
  const operation=randomUUID(),generation=randomUUID(),profile='b'.repeat(64),source='9007199254740993';
  const substitute=text=>text.replaceAll('app.neighborhood_frozen_source_rows','pg_temp.tx_originals')
    .replaceAll('app.neighborhood_frozen_typed_v2_rows','pg_temp.tx_typed')
    .replaceAll('app.neighborhood_custom_cohort_stock_accounts','pg_temp.tx_stock')
    .replaceAll('app.neighborhood_custom_cohort_source_seeds','pg_temp.tx_seeds');
  const queries={source_record:substitute(SQL.source_record),legacy_sale:substitute(SQL.legacy_sale)};
  const values=[operation,generation,profile,'',L.rows,L.packet_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes];
  /** Read a complete SQL envelope under independently chosen fixed test bounds. */
  const read=async(kind='source_record',overrides={})=>{const args=[...values];for(const [i,v] of Object.entries(overrides))args[Number(i)]=v;
    const r=await client.query(queries[kind],args);assert.equal(r.rowCount,1);return r.rows[0];};
  await client.query('BEGIN');
  try{
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TEMP TABLE tx_originals(generation_id uuid,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,payload jsonb,PRIMARY KEY(generation_id,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE INDEX tx_original_source_idx ON pg_temp.tx_originals(generation_id,kind,source_record_id,row_key COLLATE "C")
      WHERE source_record_id IS NOT NULL`);
    await client.query(`CREATE TEMP TABLE tx_typed(generation_id uuid,profile_sha256 text,kind text,row_key text COLLATE "C",
      account_id text,source_record_id bigint,original_payload_sha256 text,typed jsonb,
      PRIMARY KEY(generation_id,profile_sha256,kind,row_key)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE tx_stock(operation_id uuid,account_id text COLLATE "C",PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE tx_seeds(operation_id uuid,generation_id uuid,source_record_id bigint,
      PRIMARY KEY(operation_id,source_record_id)) ON COMMIT DROP`);
    await client.query("INSERT INTO pg_temp.tx_stock VALUES($1,'A')",[operation]);
    await client.query('INSERT INTO pg_temp.tx_seeds VALUES($1,$2,$3)',[operation,generation,source]);
    await client.query(`INSERT INTO pg_temp.tx_originals SELECT $1,k.kind,(1000000+n)::text,'A',$2,
      '{"SQL_admission_DATA_only":true}'::jsonb FROM (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
      CROSS JOIN generate_series(1,1000) n`,[generation,source]);
    for(const table of ['tx_originals','tx_typed','tx_stock','tx_seeds'])await client.query(`ANALYZE pg_temp.${table}`);
    const huge=await read();assert.deepEqual(huge.counts,{source_records:'251',sales:'251',sale_links:'251'});
    assert.equal(huge.row_count,0);assert.equal(huge.packet_json,'[]');
    const plan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${queries.source_record}`,values)).rows[0]['QUERY PLAN'][0].Plan;
    const nodes=[];
    /** Inspect execution tree by actual cap/loop count, never positional InitPlan. */
    const walk=node=>{nodes.push(node);(node.Plans??[]).forEach(walk);};walk(plan);
    const cap=nodes.filter(n=>n['Node Type']==='Limit'&&n['Actual Rows']===251&&n['Actual Loops']===3);
    assert.equal(cap.length,1);const main=cap[0].Plans.filter(n=>n['Parent Relationship']==='Outer');
    assert.equal(main.length,1);assert.equal(main[0]['Actual Rows'],251);
    await client.query("DELETE FROM pg_temp.tx_originals WHERE kind<>'sales' OR row_key>'1000249'");
    // The same exact identity occupies both C-text and BIGINT columns. Declare
    // both types instead of asking PostgreSQL to infer one incompatible $2 type.
    await client.query(`INSERT INTO pg_temp.tx_originals VALUES($1::uuid,'source_records',$2::text,'A',$2::bigint,'{"SQL_admission_DATA_only":true}')`,[generation,source]);
    await client.query(`INSERT INTO pg_temp.tx_typed SELECT generation_id,$1,kind,row_key,account_id,source_record_id,$1,
      '{"SQL_admission_DATA_only":true}'::jsonb FROM pg_temp.tx_originals`,[profile]);
    const full=await read();assert.deepEqual(full.counts,{source_records:'1',sales:'249',sale_links:'0'});
    assert.equal(full.row_count,250);assert.equal(full.invalid_count,0);assert.equal(full.packet_oversize,false);
    assert.equal(JSON.parse(full.packet_json).length,250);
    await client.query(`INSERT INTO pg_temp.tx_originals VALUES($1,'sales','1000250','A',$2,'{}')`,[generation,source]);
    const over=await read();assert.deepEqual(over.counts,{source_records:'1',sales:'250',sale_links:'0'});
    assert.equal(over.row_count,0);assert.equal(over.packet_json,'[]');
    await client.query("DELETE FROM pg_temp.tx_originals WHERE row_key='1000250'");
    for(const overrides of [{5:10},{7:10},{8:10}]){const r=await read('source_record',overrides);assert.equal(r.packet_oversize,true);assert.equal(r.packet_json,'[]');}
    await client.query("DELETE FROM pg_temp.tx_typed WHERE kind='sales' AND row_key='1000001'");
    const absent=await read();assert.equal(absent.invalid_count,1);assert.equal(absent.row_count,250);
    assert.equal(JSON.parse(absent.packet_json).find(r=>r.kind==='sales'&&r.row_key==='1000001').typed,null);
    const terminal=await read('source_record',{3:source});assert.equal(terminal.package_key,null);assert.equal(terminal.scan_count,0);
    await client.query(`INSERT INTO pg_temp.tx_originals SELECT $1,'sales',(2000000+n)::text,
      CASE WHEN n>250 THEN 'A' ELSE 'OUTSIDE' END,NULL,'{"legacy_SQL_DATA_only":true}'::jsonb FROM generate_series(1,252) n`,[generation]);
    await client.query('ANALYZE pg_temp.tx_originals');
    const sparse=await read('legacy_sale',{3:'2000000'});assert.equal(sparse.package_key,null);assert.equal(sparse.scan_count,250);
    assert.equal(sparse.scan_cursor,'2000250');assert.equal(sparse.packet_json,'[]');
    const legacyPlan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${queries.legacy_sale}`,
      values.map((v,i)=>i===3?'2000000':v))).rows[0]['QUERY PLAN'][0].Plan;
    /** Locate the materialized raw scan before membership filtering. */
    const find=node=>node['Subplan Name']==='CTE scan_keys'?node:(node.Plans??[]).map(find).find(Boolean);
    const scan=find(legacyPlan);assert.equal(scan['Node Type'],'Limit');assert.equal(scan['Actual Rows'],250);
    const input=scan.Plans.filter(n=>n['Parent Relationship']==='Outer');assert.equal(input.length,1);assert.equal(input[0]['Actual Rows'],250);
    const legacy=await read('legacy_sale',{3:sparse.scan_cursor});assert.equal(legacy.package_key,'2000251');
    assert.equal(legacy.scan_count,2);assert.equal(legacy.scan_cursor,'2000252');assert.equal(legacy.row_count,1);
    assert.equal(legacy.invalid_count,1,'missing legacy cache is not silently skipped');
    const next=await read('legacy_sale',{3:legacy.package_key});assert.equal(next.package_key,'2000252');
    assert.equal((await read('legacy_sale',{3:next.package_key})).scan_count,0);
    console.info('[native-original-transaction-package-admission-DATA-v2]',{kind_count_cap:251,actual_count_input_rows:251,
      actual_count_loops:3,complete_total_cap:250,whole_251_refusal:true,oversized_payload_delivery:0,
      raw_legacy_prefix_cap:250,actual_legacy_scan_input_rows:250,sparse_watermark:true,no_skipped_later_member:true,
      missing_cache_not_skipped:true,whole_byte_refusal:true,fresh_empty_probe:true,temporary_DATA_only:true,
      issued_owner_authority:false,original_reconciliation:false,licensed_or_live_acceptance:false});
  }finally{await client.query('ROLLBACK');}
}
