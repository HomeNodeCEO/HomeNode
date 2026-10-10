import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { compileNeighborhoodFrozenTypedOriginalV2, getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';

const KINDS=['source_records','sales','sale_links'];
export const NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_LIMITS=Object.freeze({rows:250,
  original_utf8_bytes:1000000,row_utf8_bytes:2100000,packet_utf8_bytes:8000000,output_utf8_bytes:2100000});
const L=NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_LIMITS;
/** Refuse without exposing private retained values. */
const fail=reason=>{throw new TypeError(`neighborhood_original_transaction_package_v2_${reason}`);};
/** Inspect closed own DATA properties without executing accessors or proxies. */
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
/** Freeze validated owned profile DATA. */
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Native positive BIGINT identities remain exact strings. */
function key(value){if(typeof value!=='string'||!/^\d{1,19}$/.test(value)||value[0]==='0'||BigInt(value)>9223372036854775807n)fail('invalid_key');return value;}
/** C-text order is the original sales keyset order, not numeric order. */
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const definition=freeze({id:'neighborhood-original-transaction-packages-v2',revision:'1',
  typed_profile:getNeighborhoodFrozenTypedOriginalV2Profile(),limits:L,
  admission:'original_source_sale_link_counts_each_cap_plus_one_before_whole_payload_materialization',
  reconciliation:'every_original_recompiled_entire_neutral_cache_native_identity_hash_bytes_compared_before_projection',
  source_order:'exact_native_BIGINT_original_stock_seed',
  legacy_order:'original_sales_C_key_prefix_cap_250_BEFORE_stock_source_less_filter_sparse_watermark',
  projection:'unchanged_native_package_v1_with_owner_retained_year_period_before_association_no_discard',
  missing_cache:'refuse_not_skip',over_limit:'refuse_whole_package_zero_payload_delivery',
  authority:'not_established',coverage:'one_complete_native_package_not_complete_population',
  limitations:['no_provider_membership_or_economic_equivalence','no_currency_allocation_or_eligibility',
    'no_selected_union_statistics_acquisition_publication_or_report_update']});
const text=canonicalAssessmentJson(definition),ref=prepareNeighborhoodCohortBlob(text);
const PROFILE=freeze({profile_ref:{id:definition.id,revision:'1',content_sha256:ref.content_sha256},definition_blob:{ref,canonical_json:text}});
/** Immutable interpretation definition, not source/selection authority. */
export function getNeighborhoodOriginalTransactionPackageV2Profile(){return PROFILE;}

/** Build only two fixed plans. Caller strings never enter query structure. */
function sql(legacy){
  const scan=legacy?`SELECT o.row_key,o.account_id,o.source_record_id FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind='sales' AND o.row_key>$4::text COLLATE "C"
    ORDER BY o.row_key LIMIT $5::integer`
    :`SELECT source_record_id::text AS row_key FROM app.neighborhood_custom_cohort_source_seeds
    WHERE operation_id=$1::uuid AND generation_id=$2::uuid
      AND source_record_id>coalesce(nullif($4::text,''),'0')::bigint ORDER BY source_record_id LIMIT 1`;
  const chosen=legacy?`SELECT k.row_key AS package_key FROM scan_keys k
    WHERE k.source_record_id IS NULL AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts a
      WHERE a.operation_id=$1::uuid AND a.account_id=k.account_id) ORDER BY k.row_key COLLATE "C" LIMIT 1`
    :'SELECT row_key AS package_key FROM scan_keys';
  const predicate=legacy?"o.kind='sales' AND o.source_record_id IS NULL AND o.row_key=(SELECT package_key FROM chosen)"
    :'o.source_record_id=(SELECT package_key::bigint FROM chosen)';
  return `/* neighborhood-original-transaction-package-v2:${legacy?'legacy':'source'} */
WITH scan_keys AS MATERIALIZED (${scan}),chosen AS MATERIALIZED (${chosen}),
totals AS MATERIALIZED (
  SELECT kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND ${predicate} LIMIT ($5::integer+1)) bounded) AS n
  FROM (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
),members AS MATERIALIZED (
  SELECT o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed,
      'stock_member',CASE WHEN o.account_id IS NULL THEN NULL ELSE EXISTS(SELECT 1
        FROM app.neighborhood_custom_cohort_stock_accounts a WHERE a.operation_id=$1::uuid AND a.account_id=o.account_id) END)::text AS encoded
  FROM (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind
      AND ${predicate} AND (SELECT sum(n) FROM totals)<=$5::integer OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
),sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT package_key FROM chosen) AS package_key,
  (SELECT jsonb_object_agg(kind,n::text) FROM totals) AS counts,count(*)::integer AS row_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS packet_json,
  (SELECT count(*)::integer FROM scan_keys) AS scan_count,(SELECT max(row_key COLLATE "C") FROM scan_keys) AS scan_cursor
FROM sized`;
}
export const NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL=Object.freeze({source_record:sql(false),legacy_sale:sql(true)});

/** Original replay DATA kernel. Only the actual bounded DB owner can authenticate
 * SQL counts, stock membership and issued/current source fences. This helper
 * cannot issue a traversal or selected-union receipt. No original text escapes. */
export function reconcileNeighborhoodOriginalTransactionPackageV2(value,pageValue,check){
  const page=data(pageValue,['kind','cursor']);
  if(!['source_record','legacy_sale'].includes(page.kind)||typeof page.cursor!=='string'||typeof check!=='function')fail('invalid_input');
  if(page.cursor!=='')key(page.cursor);check();
  const raw=data(value,['package_key','counts','row_count','invalid_count','packet_oversize','packet_json','scan_count','scan_cursor']);
  const counts=data(raw.counts,KINDS);
  if(KINDS.some(k=>typeof counts[k]!=='string'||!/^(?:0|[1-9]\d{0,2})$/.test(counts[k])||BigInt(counts[k])>251n))fail('invalid_counts');
  const total=KINDS.reduce((sum,k)=>sum+Number(counts[k]),0);
  if(!Number.isInteger(raw.row_count)||raw.row_count<0||raw.invalid_count!==0||typeof raw.packet_oversize!=='boolean'
    ||typeof raw.packet_json!=='string'||!Number.isInteger(raw.scan_count)||raw.scan_count<0
    ||raw.scan_count>(page.kind==='legacy_sale'?L.rows:1))fail('invalid_result');
  if(total>L.rows){if(raw.row_count!==0||raw.packet_json!=='[]')fail('invalid_result');fail('row_limit');}
  if(raw.packet_oversize||Buffer.byteLength(raw.packet_json)>L.packet_utf8_bytes)fail('byte_limit');
  if(raw.row_count!==total)fail('invalid_result');
  if(raw.scan_count===0){if(raw.scan_cursor!==null||raw.package_key!==null)fail('invalid_result');}
  else{key(raw.scan_cursor);if(page.cursor&&(page.kind==='source_record'?BigInt(raw.scan_cursor)<=BigInt(page.cursor):compare(raw.scan_cursor,page.cursor)<=0))fail('invalid_order');}
  if(raw.package_key===null){if(total!==0||raw.packet_json!=='[]')fail('invalid_result');}
  else{key(raw.package_key);
    if(raw.scan_count===0||page.kind==='source_record'&&raw.scan_cursor!==raw.package_key
      ||page.kind==='legacy_sale'&&compare(raw.package_key,raw.scan_cursor)>0)fail('invalid_result');}
  let originals;try{originals=JSON.parse(raw.packet_json);}catch{fail('invalid_result');}
  if(!Array.isArray(originals)||originals.length!==total)fail('invalid_result');
  const rows=originals.map(value=>{
    check();const r=data(value,['kind','row_key','account_id','source_record_id','original_text',
      'cached_account_id','cached_source_record_id','original_payload_sha256','typed','stock_member']);
    if(!KINDS.includes(r.kind)||typeof r.original_text!=='string'||Buffer.byteLength(r.original_text)>L.original_utf8_bytes
      ||Buffer.byteLength(JSON.stringify(r))>L.row_utf8_bytes)fail('invalid_original');key(r.row_key);
    const replay=compileNeighborhoodFrozenTypedOriginalV2({kind:r.kind,row_key:r.row_key,payload_text:r.original_text});
    if(canonicalAssessmentJson(replay)!==canonicalAssessmentJson(r.typed)||replay.account_id!==r.account_id
      ||r.cached_account_id!==r.account_id||replay.source_record_id!==r.source_record_id
      ||r.cached_source_record_id!==r.source_record_id||r.original_payload_sha256!==replay.original.payload_sha256)fail('original_mismatch');
    check();return {row:{kind:r.kind,row_key:r.row_key,account_id:r.account_id,source_record_id:r.source_record_id,
      original_payload_sha256:replay.original.payload_sha256,typed:replay},stock_member:r.stock_member};
  });
  const packet_json=JSON.stringify(rows);if(Buffer.byteLength(packet_json)>L.output_utf8_bytes)fail('byte_limit');
  return {packet:{package_key:raw.package_key,counts,row_count:raw.row_count,packet_oversize:false,packet_json},
    scanned_original_count:raw.scan_count,next_scan_cursor:raw.scan_cursor??page.cursor,
    empty_scan_terminal:raw.scan_count<(page.kind==='legacy_sale'?L.rows:1)};
}
