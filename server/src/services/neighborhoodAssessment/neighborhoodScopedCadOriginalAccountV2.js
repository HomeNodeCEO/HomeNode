import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { isCustomCohortNeutralCacheOwnerBudget } from './customCohortOriginalAccountOwnerBudget.js';
import { prepareNeighborhoodOriginalCadAccountPackagePageV2 } from './neighborhoodOriginalCadAccountPackagesV2.js';
import { compileNeighborhoodFrozenTypedCadImprovementV1 } from './neighborhoodFrozenTypedCadImprovementV1.js';
import { createNeighborhoodSharedTypedCadOriginalPageV1,prepareNeighborhoodSharedTypedCadSource,
  NEIGHBORHOOD_SHARED_TYPED_CAD_SQL } from './neighborhoodSharedTypedGeneration.js';

const L=Object.freeze({rows:250,original_utf8_bytes:1_000_000,packet_utf8_bytes:2_100_000}),KINDS=['primary','secondary'];
const fail=r=>{throw new TypeError(`neighborhood_scoped_CAD_original_account_v2_${r}`);};
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('invalid_result');return r.rows[0];};

// Exact next native stock account; BOTH native kind counters stop at 251
// before any original payload is retained. An oversized complete account or
// packet produces no encoded originals, never a misleading admitted prefix.
export const NEIGHBORHOOD_SCOPED_CAD_ORIGINAL_ACCOUNT_V2_SQL=`/* neighborhood-scoped-CAD-original-account-v2:page */
WITH chosen AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$3::text COLLATE "C" ORDER BY account_id LIMIT 1
),totals AS MATERIALIZED (
  SELECT kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
    ORDER BY o.row_key LIMIT ($4::integer+1)) bounded) AS n FROM (VALUES ('primary'),('secondary')) k(kind)
),raw_sizes AS MATERIALIZED (
  SELECT octet_length(o.payload::text) AS bytes FROM (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.payload FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
      AND (SELECT sum(n) FROM totals)<=$4::integer OFFSET 0) o
),raw_gate AS MATERIALIZED (
  SELECT coalesce(max(bytes),0)>$5::integer OR coalesce(sum(bytes::bigint+1),0)+2>$6::integer AS oversize FROM raw_sizes
),members AS MATERIALIZED (
  SELECT o.kind,o.row_key,jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
    'payload_text',o.payload::text)::text AS encoded
  FROM (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.payload FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
      AND (SELECT sum(n) FROM totals)<=$4::integer AND NOT (SELECT oversize FROM raw_gate) OFFSET 0) o
),sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM chosen) AS account_id,(SELECT parcel_count::text FROM chosen) AS geographic_parcel_count,
  (SELECT jsonb_object_agg(kind,n) FROM totals) AS counts,count(*)::integer AS row_count,
  (SELECT oversize FROM raw_gate) OR coalesce(sum(bytes::bigint+1),0)+2>$6::integer AS packet_oversize,
  CASE WHEN NOT (SELECT oversize FROM raw_gate) AND coalesce(sum(bytes::bigint+1),0)+2<=$6::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS packet_json
FROM sized`;

/** One manual owner substep, using its SAME aggregate executor. The real
 * coordinator authorizes the separate CAD purpose/current actor/assignment/
 * draft/subject and independently issued DONE parents at BOTH ends. A cursor
 * locates one complete account; it is never an issued coverage prefix. This
 * supplies no native head, automatic claim, completion, consumer admission,
 * generation backfill, current-core read, source grant or publication. */
export function createNeighborhoodScopedCadOriginalAccountV2(client,rawOptions){
  if(!isCustomCohortNeutralCacheOwnerBudget(client))fail('aggregate_owner_required');
  const o=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  const stockStore=createNeighborhoodFrozenJobStock(client,o);let used=false;
  const query=async(text,values)=>{o.checkBudget();const r=await client.query({text,values,query_timeout:5000});o.checkBudget();return r;};
  return Object.freeze({async reconcile(rawPage){
    if(used)fail('single_use');used=true;
    const page=prepareNeighborhoodOriginalCadAccountPackagePageV2(rawPage),stock=await stockStore.read();
    const readSource=async()=>prepareNeighborhoodSharedTypedCadSource(
      await query(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,[stock.generation_id]),stock.generation_id);
    const source=await readSource();
    if(source.source_snapshot!==stock.original.source_snapshot||source.started_at!==stock.original.source_transaction_started_at)fail('source_mismatch');
    const r=data(one(await query(NEIGHBORHOOD_SCOPED_CAD_ORIGINAL_ACCOUNT_V2_SQL,
      [stock.operation_id,stock.generation_id,page.cursor,L.rows,L.original_utf8_bytes,L.packet_utf8_bytes])),
    ['account_id','geographic_parcel_count','counts','row_count','packet_oversize','packet_json']),counts=data(r.counts,KINDS);
    if(!KINDS.every(k=>Number.isInteger(counts[k])&&counts[k]>=0&&counts[k]<=251)
      ||!Number.isInteger(r.row_count)||r.row_count<0||typeof r.packet_oversize!=='boolean'||typeof r.packet_json!=='string')fail('invalid_result');
    const total=counts.primary+counts.secondary;
    if(total>L.rows){if(r.row_count!==0||r.packet_json!=='[]')fail('invalid_result');fail('row_limit');}
    if(r.packet_oversize||Buffer.byteLength(r.packet_json)>L.packet_utf8_bytes)fail('byte_limit');
    if(counts.primary>1||r.row_count!==total)fail('invalid_result');
    const present=r.account_id!==null;
    if(present){prepareNeighborhoodOriginalCadAccountPackagePageV2({cursor:r.account_id});
      if(!r.account_id||Buffer.compare(Buffer.from(r.account_id),Buffer.from(page.cursor))<=0
        ||typeof r.geographic_parcel_count!=='string'||!/^[1-9][0-9]{0,6}$/.test(r.geographic_parcel_count)
        ||BigInt(r.geographic_parcel_count)>2_000_000n)fail('invalid_result');
    }else if(r.geographic_parcel_count!==null||total!==0||r.packet_json!=='[]')fail('invalid_result');
    let packet;try{packet=JSON.parse(r.packet_json);}catch{fail('invalid_result');}
    if(!Array.isArray(packet)||packet.length!==total)fail('invalid_result');
    const pages={primary:[],secondary:[]};let prior=null;
    for(const raw of packet){
      o.checkBudget();const row=data(raw,['kind','row_key','account_id','payload_text']);
      if(!KINDS.includes(row.kind)||row.account_id!==r.account_id||typeof row.row_key!=='string'
        ||typeof row.payload_text!=='string'||Buffer.byteLength(row.payload_text)>L.original_utf8_bytes)fail('invalid_original');
      const key=`${row.kind}\0${row.row_key}`;
      if(prior!==null&&Buffer.compare(Buffer.from(key),Buffer.from(prior))<=0)fail('invalid_order');prior=key;
      const replay=compileNeighborhoodFrozenTypedCadImprovementV1({kind:row.kind,row_key:row.row_key,payload_text:row.payload_text});
      if(replay.account_id!==r.account_id)fail('original_mismatch');
      pages[row.kind].push({row_key:row.row_key,payload_text:row.payload_text});
    }
    if(KINDS.some(k=>pages[k].length!==counts[k]))fail('invalid_result');
    let inserted=0,reconciled=0,typedBytes=0n;
    if(present)for(const kind of KINDS){
      const ack=await createNeighborhoodSharedTypedCadOriginalPageV1(client,{generationId:stock.generation_id,checkBudget:o.checkBudget})
        .reconcile({kind,rows:pages[kind]});
      inserted+=ack.inserted_rows;reconciled+=ack.reconciled_rows;typedBytes+=BigInt(ack.typed_utf8_bytes);
    }
    if(!same(await stockStore.read(),stock)||!same(await readSource(),source))fail('source_changed');o.checkBudget();
    return Object.freeze({status:'scoped_CAD_original_account_cache_reconciled_v2',authority:'not_established',
      generation_id:stock.generation_id,account_id:r.account_id,geographic_parcel_count:r.geographic_parcel_count,
      original_counts:Object.freeze({...counts}),reconciled_rows:reconciled,inserted_rows:inserted,typed_utf8_bytes:String(typedBytes),
      cursor:page.cursor,next_cursor:r.account_id??page.cursor,end_of_accounts:!present,
      original_reconciliation:'every_complete_account_original_and_entire_cached_JSON',
      global_progress_advanced:false,job_coverage:'not_established',automatic_handoff:false,source_acquisition:'not_established',report_update:'none'});
  }});
}
