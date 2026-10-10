import { isProxy } from 'node:util/types';
import { assessmentDate,canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { compileNeighborhoodFrozenTypedCadImprovementV1,getNeighborhoodFrozenTypedCadImprovementV1Profile }
  from './neighborhoodFrozenTypedCadImprovementV1.js';

export const NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_LIMITS=Object.freeze({rows:250,
  original_utf8_bytes:1000000,row_utf8_bytes:2100000,packet_utf8_bytes:8000000,output_utf8_bytes:2100000});
const L=NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_LIMITS,KINDS=['primary','secondary'];
/** Refuse without exposing private original values. */
const fail=r=>{throw new TypeError(`neighborhood_original_CAD_account_package_v2_${r}`);};
/** Closed DATA inspection never invokes a caller accessor or proxy. */
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Freeze only validated owned DATA. */
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** Native account identifiers use exact bounded C-text, not numeric coercion. */
function account(v,empty=false){if(typeof v!=='string'||!v.isWellFormed()||!empty&&!v||Buffer.byteLength(v)>64
  ||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail('invalid_account');return v;}
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
/** Only a cursor is caller DATA; the server chooses the complete next account. */
export function prepareNeighborhoodOriginalCadAccountPackagePageV2(value){const p=data(value,['cursor']);account(p.cursor,true);return freeze(p);}
const definition=freeze({id:'neighborhood-original-CAD-account-packages-v2',revision:'1',limits:L,
  syntax_profile:getNeighborhoodFrozenTypedCadImprovementV1Profile().profile_ref,
  admission:'next_exact_stock_account_original_primary_secondary_counts_each_cap_251_before_whole_payload_total_250',
  reconciliation:'every_original_recompiled_entire_cache_native_identity_recomputed_hash_bytes_before_projection',
  primary:'optional_one_native_account_original_absence_explicit_missing_denominator',
  secondary:'every_native_row_id_retained_duplicate_improvement_numbers_not_deduplicated_no_alias_dictionary_or_area_sum',
  temporal:'owner_retained_effective_year_before_primary_projection_current_not_historical_or_at_sale',
  observations:'exact_CAD_reported_units_and_native_boolean_false_distinct_from_NULL_missing',
  authority:'not_established',coverage:'one_complete_account_not_complete_population',
  limitations:['no_housing_eligibility_garage_type_or_verified_GLA_bathroom_equivalence',
    'no_source_license_acquisition_selected_union_statistics_publication_or_report_update']});
const text=canonicalAssessmentJson(definition),ref=prepareNeighborhoodCohortBlob(text);
const PROFILE=freeze({profile_ref:{id:definition.id,revision:'1',content_sha256:ref.content_sha256},definition_blob:{ref,canonical_json:text}});
/** Fixed interpretation definition is not source or selection authority. */
export function getNeighborhoodOriginalCadAccountPackageV2Profile(){return PROFILE;}

// Existing native (generation,account,kind,row_key) original index and exact
// neutral-cache PK probes. Counts stop at 251 BEFORE any original payload;
// a whole over-limit account cannot be admitted as a misleading prefix.
export const NEIGHBORHOOD_ORIGINAL_CAD_ACCOUNT_PACKAGE_V2_SQL=`/* neighborhood-original-CAD-account-package-v2 */
WITH chosen AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 1
),totals AS MATERIALIZED (
  SELECT kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
    ORDER BY o.row_key LIMIT ($5::integer+1)) bounded) AS n FROM (VALUES ('primary'),('secondary')) k(kind)
),raw_sizes AS MATERIALIZED (
  -- Byte lengths only under the complete-account count cap. Do not retain
  -- payload strings or JSON envelopes before the whole-packet byte decision.
  SELECT octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes
  FROM (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.payload
    FROM app.neighborhood_frozen_cad_improvement_rows o WHERE o.generation_id=$2::uuid
      AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
      AND (SELECT sum(n) FROM totals)<=$5::integer OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.typed FROM app.neighborhood_frozen_typed_cad_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
),raw_gate AS MATERIALIZED (
  SELECT coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(max(original_bytes::bigint+coalesce(typed_bytes,0)),0)>$7::integer
    OR coalesce(sum(original_bytes::bigint+coalesce(typed_bytes,0)+1),0)+2>$6::integer
    OR coalesce(sum(2::bigint*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS oversize
  FROM raw_sizes
),members AS MATERIALIZED (
  SELECT o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,'original_text',o.payload::text,
      'payload_sha256',o.payload_sha256,'payload_utf8_bytes',o.payload_utf8_bytes::text,
      'cached_account_id',t.account_id,'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.payload,o.payload_sha256,o.payload_utf8_bytes
    FROM app.neighborhood_frozen_cad_improvement_rows o WHERE o.generation_id=$2::uuid
      AND o.account_id=(SELECT account_id FROM chosen) AND o.kind=k.kind
      AND (SELECT sum(n) FROM totals)<=$5::integer AND NOT (SELECT oversize FROM raw_gate) OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_cad_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
),sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM chosen) AS account_id,(SELECT parcel_count::text FROM chosen) AS geographic_parcel_count,
  (SELECT jsonb_object_agg(kind,n::text) FROM totals) AS counts,count(*)::integer AS row_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  (SELECT oversize FROM raw_gate) OR coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN NOT (SELECT oversize FROM raw_gate) AND coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS packet_json
FROM sized`;

/** Original-replay DATA kernel, not a source/selected-union receipt. Only the
 * actual bounded DB owner authenticates native counts, stock and both-end rights.
 * Every original and complete cache is reconciled before date/amenity projection.
 * Original payload text is neither returned nor copied into durable evidence. */
export function reconcileNeighborhoodOriginalCadAccountPackageV2(value,pageValue,effectiveDate,check){
  const page=prepareNeighborhoodOriginalCadAccountPackagePageV2(pageValue),effective=assessmentDate(effectiveDate);
  if(typeof check!=='function')fail('invalid_input');check();
  const r=data(value,['account_id','geographic_parcel_count','counts','row_count','invalid_count','packet_oversize','packet_json']);
  const counts=data(r.counts,KINDS);
  if(KINDS.some(k=>typeof counts[k]!=='string'||!/^(?:0|[1-9]\d{0,2})$/.test(counts[k])||BigInt(counts[k])>251n))fail('invalid_counts');
  const total=Number(counts.primary)+Number(counts.secondary);
  if(!Number.isInteger(r.row_count)||r.row_count<0||r.invalid_count!==0||typeof r.packet_oversize!=='boolean'
    ||typeof r.packet_json!=='string')fail('invalid_result');
  if(total>L.rows){if(r.row_count!==0||r.packet_json!=='[]')fail('invalid_result');fail('row_limit');}
  if(counts.primary!=='0'&&counts.primary!=='1')fail('invalid_counts');
  if(r.packet_oversize||Buffer.byteLength(r.packet_json)>L.packet_utf8_bytes)fail('byte_limit');
  if(r.row_count!==total)fail('invalid_result');
  if(r.account_id===null){if(r.geographic_parcel_count!==null||total!==0||r.packet_json!=='[]')fail('invalid_result');
    return freeze({rows:[],next_cursor:page.cursor,end_of_accounts:true});}
  account(r.account_id);if(compare(r.account_id,page.cursor)<=0||typeof r.geographic_parcel_count!=='string'
    ||!/^[1-9]\d{0,6}$/.test(r.geographic_parcel_count)||BigInt(r.geographic_parcel_count)>2000000n)fail('invalid_result');
  let originals;try{originals=JSON.parse(r.packet_json);}catch{fail('invalid_result');}
  if(!Array.isArray(originals)||originals.length!==total)fail('invalid_result');
  let previous=null;const seen={primary:0,secondary:0};
  const rows=originals.map(value=>{
    check();const o=data(value,['kind','row_key','account_id','original_text','payload_sha256','payload_utf8_bytes',
      'cached_account_id','original_payload_sha256','typed']);
    if(!KINDS.includes(o.kind)||o.account_id!==r.account_id||o.cached_account_id!==r.account_id
      ||typeof o.original_text!=='string'||Buffer.byteLength(o.original_text)>L.original_utf8_bytes
      ||Buffer.byteLength(JSON.stringify(o))>L.row_utf8_bytes)fail('invalid_original');
    const replay=compileNeighborhoodFrozenTypedCadImprovementV1({kind:o.kind,row_key:o.row_key,payload_text:o.original_text});
    if(replay.account_id!==r.account_id||canonicalAssessmentJson(replay)!==canonicalAssessmentJson(o.typed)
      ||o.original_payload_sha256!==replay.original.payload_sha256||o.payload_sha256!==replay.original.payload_sha256
      ||o.payload_utf8_bytes!==String(replay.original.payload_utf8_bytes))fail('original_mismatch');
    if(previous&&(compare(o.kind,previous.kind)<0||o.kind===previous.kind&&compare(o.row_key,previous.row_key)<=0))fail('invalid_order');
    previous={kind:o.kind,row_key:o.row_key};seen[o.kind]++;check();
    return {kind:o.kind,row_key:o.row_key,account_id:o.account_id,original_payload_sha256:replay.original.payload_sha256,typed:replay};
  });
  if(KINDS.some(k=>String(seen[k])!==counts[k]))fail('invalid_counts');
  const primary=rows.find(o=>o.kind==='primary')??null;
  const names=['reported_year_built','reported_living_area','reported_bedrooms','reported_baths','reported_units','reported_pool_flag'];
  const observations=Object.fromEntries(names.map(name=>{
    if(!primary)return [name,{state:'missing',exact_value:null,unit:null,reason:'primary_original_absent'}];
    const {state,exact_value,unit,reason}=primary.typed.observations[name];
    if(name==='reported_year_built'&&state==='observed'&&exact_value>effective.slice(0,4))
      return [name,{state:'invalid',exact_value:null,unit:null,reason:'year_after_retained_effective_year'}];
    return [name,{state,exact_value,unit,reason}];
  }));
  const result={rows:[{account_id:r.account_id,geographic_parcel_count:r.geographic_parcel_count,
    primary_original_count:counts.primary,secondary_original_count:counts.secondary,primary,observations,
    secondary_originals:rows.filter(o=>o.kind==='secondary'),secondary_type_resolution:'not_established',housing_eligibility:'not_established',
    temporal_basis:'current_retained_CAD_not_historical_or_at_sale',source_freshness:'not_established'}],
  next_cursor:r.account_id,end_of_accounts:false};
  if(Buffer.byteLength(JSON.stringify(result))>L.output_utf8_bytes)fail('byte_limit');check();return freeze(result);
}
