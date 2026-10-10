import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL as SQL,NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_LIMITS as L }
  from '../../src/services/neighborhoodAssessment/neighborhoodOriginalCadAccountPackagesV2.js';

/** Rolled-back TEMP SQL admission/plan DATA. Does not issue originals, cache,
 * source rights, selected-union authority or licensed/live acceptance. */
export async function runNeighborhoodOriginalCadAccountPackageDatabaseChecks(client){
  const operation=randomUUID(),generation=randomUUID(),profile='c'.repeat(64);
  const sql=SQL.replaceAll('app.neighborhood_custom_cohort_stock_accounts','pg_temp.cad_stock')
    .replaceAll('app.neighborhood_frozen_cad_improvement_rows','pg_temp.cad_originals')
    .replaceAll('app.neighborhood_frozen_typed_cad_rows','pg_temp.cad_typed');
  const values=[operation,generation,profile,'',L.rows,L.packet_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes];
  /** Read one complete envelope with independently chosen fixed test bounds. */
  const read=async(overrides={})=>{const args=[...values];for(const [i,v] of Object.entries(overrides))args[Number(i)]=v;
    const r=await client.query(sql,args);assert.equal(r.rowCount,1);return r.rows[0];};
  await client.query('BEGIN');
  try{
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TEMP TABLE cad_stock(operation_id uuid,account_id text COLLATE "C",parcel_count bigint,
      PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE cad_originals(generation_id uuid,kind text,row_key text COLLATE "C",account_id text COLLATE "C",
      payload jsonb,payload_sha256 text,payload_utf8_bytes bigint,PRIMARY KEY(generation_id,kind,row_key)) ON COMMIT DROP`);
    await client.query('CREATE INDEX cad_original_account_idx ON pg_temp.cad_originals(generation_id,account_id,kind,row_key)');
    await client.query(`CREATE TEMP TABLE cad_typed(generation_id uuid,profile_sha256 text,kind text,row_key text COLLATE "C",
      account_id text,original_payload_sha256 text,typed jsonb,PRIMARY KEY(generation_id,profile_sha256,kind,row_key)) ON COMMIT DROP`);
    await client.query("INSERT INTO pg_temp.cad_stock VALUES($1::uuid,'A',2),($1::uuid,'B',1)",[operation]);
    await client.query(`INSERT INTO pg_temp.cad_originals SELECT $1::uuid,k.kind,(1000000+n)::text,'A',
      '{"SQL_DATA_only":true}'::jsonb,$2::text,22 FROM (VALUES ('primary'),('secondary')) k(kind)
      CROSS JOIN generate_series(1,1000) n`,[generation,profile]);
    for(const table of ['cad_stock','cad_originals','cad_typed'])await client.query(`ANALYZE pg_temp.${table}`);
    const huge=await read();assert.deepEqual(huge.counts,{primary:'251',secondary:'251'});assert.equal(huge.row_count,0);assert.equal(huge.packet_json,'[]');
    const plan=(await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,values)).rows[0]['QUERY PLAN'][0].Plan,nodes=[];
    /** Identify actual bounded counter input separately from scalar InitPlans. */
    const walk=node=>{nodes.push(node);(node.Plans??[]).forEach(walk);};walk(plan);
    const cap=nodes.filter(n=>n['Node Type']==='Limit'&&n['Actual Rows']===251&&n['Actual Loops']===2);assert.equal(cap.length,1);
    const input=cap[0].Plans.filter(n=>n['Parent Relationship']==='Outer');assert.equal(input.length,1);assert.equal(input[0]['Actual Rows'],251);
    assert.ok(['Index Scan','Index Only Scan'].includes(input[0]['Node Type']),'ordered counter must not sort or bitmap the whole account before LIMIT');
    assert.equal(input[0]['Index Name'],'cad_original_account_idx');
    await client.query("DELETE FROM pg_temp.cad_originals WHERE kind='primary' AND row_key<>'1000001' OR kind='secondary' AND row_key>'1000249'");
    await client.query(`INSERT INTO pg_temp.cad_typed SELECT generation_id,$1::text,kind,row_key,account_id,$1::text,
      '{"SQL_DATA_only":true}'::jsonb FROM pg_temp.cad_originals`,[profile]);
    const full=await read();assert.deepEqual(full.counts,{primary:'1',secondary:'249'});assert.equal(full.row_count,250);
    assert.equal(full.invalid_count,0);assert.equal(full.packet_oversize,false);assert.equal(JSON.parse(full.packet_json).length,250);
    await client.query(`INSERT INTO pg_temp.cad_originals VALUES($1::uuid,'secondary','1000250','A','{}',$2::text,2)`,[generation,profile]);
    const over=await read();assert.deepEqual(over.counts,{primary:'1',secondary:'250'});assert.equal(over.row_count,0);assert.equal(over.packet_json,'[]');
    await client.query("DELETE FROM pg_temp.cad_originals WHERE kind='secondary' AND row_key='1000250'");
    for(const overrides of [{5:10},{6:10},{7:10},{8:10}]){const r=await read(overrides);assert.equal(r.packet_oversize,true);assert.equal(r.packet_json,'[]');}
    await client.query("DELETE FROM pg_temp.cad_typed WHERE kind='secondary' AND row_key='1000001'");
    const missing=await read();assert.equal(missing.invalid_count,1);assert.equal(missing.row_count,250);
    assert.equal(JSON.parse(missing.packet_json).find(r=>r.kind==='secondary'&&r.row_key==='1000001').typed,null);
    const absent=await read({3:'A'});assert.equal(absent.account_id,'B');assert.equal(absent.row_count,0);assert.equal(absent.packet_json,'[]');
    assert.deepEqual(absent.counts,{primary:'0',secondary:'0'});
    const end=await read({3:'B'});assert.equal(end.account_id,null);assert.equal(end.geographic_parcel_count,null);assert.equal(end.row_count,0);
    console.info('[native-original-CAD-account-package-admission-DATA-v2]',{kind_count_cap:251,actual_count_input_rows:251,
      actual_count_loops:2,complete_total_cap:250,whole_251_refusal:true,oversized_payload_delivery:0,whole_byte_refusal:true,
      missing_cache_not_skipped:true,absent_primary_denominator:true,fresh_empty_probe:true,temporary_DATA_only:true,
      issued_owner_authority:false,original_reconciliation:false,licensed_or_live_acceptance:false});
  }finally{await client.query('ROLLBACK');}
}
