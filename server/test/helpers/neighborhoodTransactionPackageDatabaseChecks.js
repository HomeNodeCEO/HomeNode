import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL as SQL, projectNeighborhoodTransactionPackageV1 }
  from '../../src/services/neighborhoodAssessment/neighborhoodSharedTransactionPackagesV1.js';

/** Native execution of the fixed package plans on rolled-back TEMP DATA only.
 * No original/cache/issued head is changed or fabricated as owner authority.
 * Actual issued/current-rights owner coverage is a separate integration fixture. */
export async function runNeighborhoodTransactionPackageDatabaseChecks(client) {
  const operation=randomUUID(),generation=randomUUID(),profile='a'.repeat(64);
  const values=[operation,generation,profile,'',250,2100000,66752];
  const graph={parcels:1,accounts:1,source_records:1,sales:1000,sale_links:1000,sync_state:0,sync_runs:0};
  const fixed=Object.fromEntries(Object.entries(SQL).map(([kind,sql])=>[kind,sql
    .replaceAll('app.neighborhood_frozen_typed_v2_rows','pg_temp.package_plan_rows')
    .replaceAll('app.neighborhood_custom_cohort_source_seeds','pg_temp.package_plan_seeds')
    .replaceAll('app.neighborhood_custom_cohort_stock_accounts','pg_temp.package_plan_stock')]));
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query(`CREATE TEMP TABLE package_plan_rows(generation_id uuid,profile_sha256 text,kind text,
      row_key text COLLATE "C",account_id text,source_record_id bigint,original_payload_sha256 text,typed jsonb) ON COMMIT DROP`);
    await client.query(`CREATE INDEX ON package_plan_rows(generation_id,profile_sha256,kind,source_record_id,row_key)`);
    await client.query(`CREATE INDEX ON package_plan_rows(generation_id,profile_sha256,kind,row_key)`);
    await client.query(`CREATE TEMP TABLE package_plan_seeds(operation_id uuid,generation_id uuid,source_record_id bigint,
      PRIMARY KEY(operation_id,generation_id,source_record_id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE package_plan_stock(operation_id uuid,account_id text,
      PRIMARY KEY(operation_id,account_id)) ON COMMIT DROP`);
    await client.query('INSERT INTO package_plan_seeds VALUES($1,$2,1)',[operation,generation]);
    await client.query("INSERT INTO package_plan_stock VALUES($1,'A')",[operation]);
    for(const [sales,links,counts] of [[0,249,{source_records:'1',sales:'0',sale_links:'249'}],
      [0,250,{source_records:'1',sales:'0',sale_links:'250'}],
      [1000,1000,{source_records:'1',sales:'251',sale_links:'251'}]]){
      await client.query('TRUNCATE pg_temp.package_plan_rows');
      await client.query(`INSERT INTO package_plan_rows
        SELECT $1::uuid,$2::text,'source_records','1','A',1,$3::text,'{"plan_fixture":true}'::jsonb
        UNION ALL SELECT $1::uuid,$2::text,kind,n::text,'A',1,$3::text,'{"plan_fixture":true}'::jsonb
        FROM (SELECT 'sales' AS kind,generate_series(1,$4::integer) AS n
          UNION ALL SELECT 'sale_links',generate_series(1,$5::integer)) fixture_rows`,[generation,profile,profile,sales,links]);
      await client.query('ANALYZE pg_temp.package_plan_rows');
      const result=await client.query(fixed.source_record,values);
      assert.equal(result.rowCount,1);const packet=result.rows[0];
      assert.equal(packet.package_key,'1');assert.deepEqual(packet.counts,counts);
      if(links===249){
        assert.equal(packet.row_count,250);assert.equal(JSON.parse(packet.packet_json).length,250);
      }else{
        assert.equal(packet.row_count,0);assert.equal(packet.packet_json,'[]');
        assert.throws(()=>projectNeighborhoodTransactionPackageV1(packet,{kind:'source_record',cursor:''},graph,
          '2026-10-07',{start_date:'2025-01-01',end_date:'2026-10-07'}),/package_row_limit/);
      }
      if(sales===1000){
        const explained=await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${fixed.source_record}`,values);
        const nodes=[];
        const visit=node=>{nodes.push(node);for(const child of node.Plans??[])visit(child);};
        visit(explained.rows[0]['QUERY PLAN'][0].Plan);
        const bounded=nodes.filter(n=>n['Node Type']==='Limit'&&n['Actual Rows']===251);
        assert.equal(bounded.length,2,'oversized sale and link counters stop at exactly cap+1');
        for(const node of bounded)assert.equal(node.Plans[0]['Actual Rows'],251,'counter child never returns the full 1000 rows');
        assert.equal(nodes.find(n=>n['Subplan Name']==='CTE members')['Actual Rows'],0,
          'oversized package materializes no payload member');
      }
    }
    const ended=(await client.query(fixed.source_record,[...values.slice(0,3),'1',...values.slice(4)])).rows[0];
    assert.equal(ended.package_key,null);assert.deepEqual(ended.counts,{source_records:'0',sales:'0',sale_links:'0'});
    assert.equal(ended.row_count,0);assert.equal(ended.packet_json,'[]');
    await client.query(`INSERT INTO package_plan_rows VALUES($1,$2,'sales','9999','A',NULL,$2,'{"plan_fixture":true}')`,[generation,profile]);
    const legacy=(await client.query(fixed.legacy_sale,values)).rows[0];
    assert.equal(legacy.package_key,'9999');assert.deepEqual(legacy.counts,{source_records:'0',sales:'1',sale_links:'0'});
    assert.equal(legacy.row_count,1);assert.equal(JSON.parse(legacy.packet_json).length,1);
    console.info('[native-package-count-admission-plans-v1]',{at_cap:250,one_over:251,
      oversized_rows_per_kind:1000,bounded_rows_per_kind:251,oversized_payload_rows:0,
      fresh_empty_probe:true,legacy_plan:true,temporary_DATA_only:true,issued_owner_authority:false,licensed_or_live_acceptance:false});
  }finally{await client.query('ROLLBACK');}
}
