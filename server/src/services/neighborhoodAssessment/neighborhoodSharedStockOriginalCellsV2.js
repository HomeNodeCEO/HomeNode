import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { compileNeighborhoodFrozenTypedOriginalV2, getNeighborhoodFrozenTypedOriginalV2Profile }
  from './neighborhoodFrozenTypedOriginalV1.js';
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL, prepareNeighborhoodSharedTypedSource } from './neighborhoodSharedTypedGeneration.js';

export const NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS = Object.freeze({ rows:250,
  original_utf8_bytes:1000000, row_utf8_bytes:2100000, page_utf8_bytes:8000000,
  output_utf8_bytes:2100000, read_utf8_bytes:32000000, queries:128, step_ms:60000, query_ms:5000 });
const L=NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS, TYPED=getNeighborhoodFrozenTypedOriginalV2Profile();
const KINDS=Object.freeze(['parcels','accounts']), ALL=['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
/** Refuse without including retained private observations in the error. */
const fail=reason=>{throw new TypeError(`neighborhood_stock_original_cells_v2_${reason}`);};
/** Compare detached validated DATA, never an authorization claim. */
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
/** Freeze only the owned result tree after validation and original replay. */
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
/** Admit a closed own-data object before touching any untrusted property. */
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||!keys.every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
/** Validate exact native keys in the cache's installed C-text order. */
function cursor(value,kind){
  if(typeof value!=='string'||value.length>64||Buffer.byteLength(value)>256||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_cursor');
  if(value===''||kind==='accounts'&&value===value.trim())return value;
  if(kind!=='parcels'||!/^(?:0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)>9223372036854775807n)fail('invalid_cursor');
  return value;
}
/** Require a single complete SQL metadata envelope. */
const one=result=>{if(result?.rowCount!==1||result.rows?.length!==1)fail('invalid_result');return result.rows[0];};
/** Validate a canonical bounded count without economic floating-point conversion. */
const count=(value,max)=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=BigInt(max);
/** Only a fixed kind, cursor and bounded page size are caller-supplied. */
export function prepareNeighborhoodStockOriginalCellPageV2(value){
  const page=data(value,['kind','cursor','rowLimit']);
  if(!KINDS.includes(page.kind)||!Number.isInteger(page.rowLimit)||page.rowLimit<1||page.rowLimit>L.rows)fail('invalid_page');
  cursor(page.cursor,page.kind);return freeze(page);
}
const DEFINITION=freeze({id:'neighborhood-shared-stock-original-cells-v2',revision:'1',typed_profile:TYPED,
  limits:L,kinds:KINDS,scope:'all_retained_original_parts_of_exact_stock_accounts_including_parts_outside_geometry',
  order:'native_row_key_C_text_not_numeric',scan:'bounded_original_key_prefix_before_stock_membership_no_filtered_whole_generation_scan',
  reconciliation:'recompile_every_delivered_original_payload_and_compare_entire_neutral_cache_row',
  missing_cache_row:'refuse_not_skip',missing_account_original:'not_fabricated_full_stock_denominator_still_required',
  temporal:'owner_retained_effective_year_applied_to_each_cell_before_any_resolution',
  provenance:'original_payload_hash_and_byte_length_recomputed_not_substituted_for_original_replay',
  delivery:'no_original_payload_text_or_geometry_only_reconciled_typed_cells_and_bounded_literal_markers',
  authority:'not_established',coverage:'one_kind_page_only',
  limitations:['no_complete_traversal_or_selected_union_receipt','no_housing_or_amenity_dictionary',
    'no_currency_GLA_historical_or_at_sale_inference','no_acquisition_statistics_publication_or_report_update']});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionRef=prepareNeighborhoodCohortBlob(definitionText);
const PROFILE=freeze({profile_ref:{id:DEFINITION.id,revision:'1',content_sha256:definitionRef.content_sha256},
  definition_blob:{ref:definitionRef,canonical_json:definitionText}});
/** Return the pinned projection definition, not a source or selection capability. */
export function getNeighborhoodStockOriginalCellsV2Profile(){return PROFILE;}

// Start from ORIGINALS, not the cache: a missing typed row cannot disappear.
// The existing generation/kind/C-key PK, stock-account PK and typed PK scope
// one bounded original-key prefix BEFORE stock filtering. Empty scoped pages
// still advance the scan watermark; they do not prove an exhausted kind.
// No current core source, dense roster, spatial sweep or
// caller-selected relation/field/date. Both transport and output prefix budgets
// apply before any original leaves SQL; an oversized candidate refuses, not skips.
export const NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL=`/* neighborhood-shared-stock-original-cells-v2:page */
WITH scan_keys AS MATERIALIZED (
  SELECT o.row_key,o.account_id FROM app.neighborhood_frozen_source_rows o
  WHERE o.generation_id=$2::uuid AND o.kind=$4 AND o.row_key>$5::text COLLATE "C"
  ORDER BY o.row_key LIMIT $6::integer
), candidates AS MATERIALIZED (
  SELECT o.row_key,o.payload::text AS original_text,t.typed,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded,
    t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid
  FROM scan_keys k
  CROSS JOIN LATERAL (SELECT a.account_id FROM app.neighborhood_custom_cohort_stock_accounts a
    WHERE a.operation_id=$1::uuid AND a.account_id=k.account_id OFFSET 0) a
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=$4 AND o.row_key=k.row_key OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid
    AND t.profile_sha256=$3 AND t.kind=$4 AND t.row_key=k.row_key OFFSET 0) t ON true
  ORDER BY o.row_key
), sized AS (
  SELECT *,octet_length(encoded) AS bytes,octet_length(original_text) AS original_bytes,
    sum(octet_length(encoded)+1) OVER(ORDER BY row_key) AS cumulative,
    sum(2*coalesce(octet_length(typed::text),0)+1024) OVER(ORDER BY row_key) AS output_cumulative
  FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes<=$8::integer AND original_bytes<=$9::integer
    AND cumulative+1<=$7::integer AND output_cumulative+1<=$10::integer)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY row_key)||']','[]') AS page_json,
  count(*)::integer AS page_count,(SELECT count(*)::integer FROM candidates) AS candidate_count,
  (SELECT count(*)::integer FROM scan_keys) AS scan_count,(SELECT max(row_key) FROM scan_keys) AS scan_cursor,
  (SELECT count(*)::integer FROM sized WHERE invalid) AS invalid_count,
  (SELECT count(*)::integer FROM sized WHERE bytes>$8::integer OR original_bytes>$9::integer) AS oversized_count,
  CASE WHEN count(*)=(SELECT count(*) FROM candidates) THEN (SELECT max(row_key) FROM scan_keys)
    ELSE max(row_key) END AS next_cursor FROM admitted`;

/** One single-use read under the actual current-authorized V2 capture owner.
 * The original graph/geography/identity, source purpose and stock must already
 * be independently issued and rechecked at both transaction ends. Recompile
 * every delivered original and compare the ENTIRE neutral cache value before
 * projecting the owner's retained year. Hashes/counts/caller callbacks are not
 * original reconciliation. No miss preparation, payload copy, durable write,
 * selection, synchronous per-cell query callback or report authority is minted.
 */
export function createNeighborhoodSharedStockOriginalCellsV2(client,rawOptions,rawGraph,effectiveDate){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if(typeof client?.query!=='function'||typeof options.checkBudget!=='function')fail('invalid_input');
  const g=data(rawGraph,['root','layer_counts']),r=data(g.root,['content_sha256','canonical_utf8_bytes']);
  const root=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes),layers=data(g.layer_counts,ALL);
  if(!Object.values(layers).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000))fail('invalid_input');
  const effective=assessmentDate(effectiveDate),graph=freeze({root,layer_counts:layers});
  let used=false,queries=0,bytes=0,started;
  /** Charge all nested SQL reads against one step's deadline/query/byte budget. */
  const check=()=>{options.checkBudget();if(performance.now()-started>L.step_ms)fail('deadline');};
  /** The stock store and this reader share this exact bounded SQL executor. */
  const execute=async(text,values)=>{
    check();if(++queries>L.queries)fail('query_limit');
    const query=typeof text==='string'?{text,values,query_timeout:L.query_ms}:{...text,query_timeout:L.query_ms};
    const result=await client.query(query);if(!Array.isArray(result?.rows))fail('invalid_result');
    let encoded;try{encoded=JSON.stringify(result.rows);}catch{fail('invalid_result');}
    bytes+=Buffer.byteLength(encoded);if(bytes>L.read_utf8_bytes)fail('byte_limit');check();return result;
  };
  const stocks=createNeighborhoodFrozenJobStock({query:execute},options);
  return Object.freeze({
    /** Reconcile one original-key prefix; a page end proves no earlier traversal. */
    async page(rawPage){
      const page=prepareNeighborhoodStockOriginalCellPageV2(rawPage);if(used)fail('single_use');used=true;started=performance.now();
      const stock=await stocks.read(),original=stock.original;
      const source=prepareNeighborhoodSharedTypedSource(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id);
      const expected={generation_id:original.generation_id,format_version:original.source_format_version,status:'complete',
        source_snapshot:original.source_snapshot,started_at:original.source_transaction_started_at,completed_at:original.completed_at,
        layer_counts:original.layer_counts,row_count:original.row_count,payload_utf8_bytes:original.payload_utf8_bytes};
      if(!same(source,expected)||Object.entries(layers).some(([k,n])=>n>Number(source.layer_counts[k].row_count)))fail('source_mismatch');
      const binding=assessmentEvidenceDigest({source,profile:TYPED}),headerValues=[stock.generation_id,TYPED.profile_ref.content_sha256];
      /** A complete immutable cache is prerequisite DATA, never prepared here. */
      const validateHeader=value=>{
        const h=data(value,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']);
        const p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
        if(h.binding_sha256!==binding||!same(h.source_metadata,source)||h.definition_json!==TYPED.definition_blob.canonical_json
          ||h.status!=='complete'||typeof h.completed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at)
          ||p.format!=='shared_frozen_typed_progress_v2'||p.binding_sha256!==binding||p.kind_index!==7||p.after!==''||p.layer_rows!==0
          ||p.typed_rows!==source.row_count||!count(p.typed_utf8_bytes,8000000000)||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows))fail('cache_unavailable');
      };
      const header=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,headerValues));validateHeader(header);
      const result=one(await execute(NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL,[stock.operation_id,stock.generation_id,
        TYPED.profile_ref.content_sha256,page.kind,page.cursor,page.rowLimit,L.page_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes]));
      if(!Number.isInteger(result.page_count)||!Number.isInteger(result.candidate_count)||!Number.isInteger(result.scan_count)||result.page_count<0
        ||result.candidate_count<result.page_count||result.scan_count<result.candidate_count||result.scan_count>page.rowLimit||result.page_count>layers[page.kind]
        ||result.invalid_count!==0||result.oversized_count!==0||typeof result.page_json!=='string')fail('invalid_result');
      if(Buffer.byteLength(result.page_json)>L.page_utf8_bytes)fail('byte_limit');
      let rows;try{rows=JSON.parse(result.page_json);}catch{fail('invalid_result');}
      if(!Array.isArray(rows)||rows.length!==result.page_count||!rows.length&&result.candidate_count!==0)fail('invalid_result');
      let previous=page.cursor;
      rows=rows.map(value=>{
        check();const row=data(value,['kind','row_key','account_id','source_record_id','original_text',
          'cached_account_id','cached_source_record_id','original_payload_sha256','typed']);
        cursor(row.row_key,page.kind);
        if(row.kind!==page.kind||!row.row_key||Buffer.compare(Buffer.from(row.row_key),Buffer.from(previous))<=0
          ||row.account_id===null||row.source_record_id!==null||typeof row.original_text!=='string'
          ||Buffer.byteLength(row.original_text)>L.original_utf8_bytes||Buffer.byteLength(JSON.stringify(row))>L.row_utf8_bytes)fail('invalid_original');
        const replay=compileNeighborhoodFrozenTypedOriginalV2({kind:row.kind,row_key:row.row_key,payload_text:row.original_text});
        if(!same(replay,row.typed)||replay.account_id!==row.account_id||row.cached_account_id!==row.account_id
          ||replay.source_record_id!==row.source_record_id||row.cached_source_record_id!==row.source_record_id
          ||row.original_payload_sha256!==replay.original.payload_sha256)fail('original_mismatch');
        const observations=structuredClone(replay.observations),year=observations.reported_year_built;
        if(year?.state==='observed'&&year.exact_value>effective.slice(0,4))Object.assign(year,
          {state:'invalid',exact_value:null,unit:null,reason:'year_after_retained_effective_year'});
        previous=row.row_key;check();return {kind:row.kind,row_key:row.row_key,account_id:row.account_id,
          original_payload_sha256:replay.original.payload_sha256,typed:replay,retained_observations:observations};
      });
      if(result.scan_count===0){if(result.scan_cursor!==null)fail('invalid_result');}
      else{cursor(result.scan_cursor,page.kind);
        if(!result.scan_cursor||Buffer.compare(Buffer.from(result.scan_cursor),Buffer.from(page.cursor))<=0
          ||Buffer.compare(Buffer.from(result.scan_cursor),Buffer.from(previous))<0)fail('invalid_result');}
      const next=result.page_count===result.candidate_count?result.scan_cursor:rows.length?previous:null;
      if(result.next_cursor!==next)fail('invalid_result');
      if(Buffer.byteLength(JSON.stringify(rows))>L.output_utf8_bytes)fail('byte_limit');
      if(!same(await stocks.read(),stock)||!same(prepareNeighborhoodSharedTypedSource(
        await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id),source))fail('source_changed');
      const ending=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,headerValues));validateHeader(ending);
      if(!same(ending,header))fail('source_changed');check();
      return freeze({page_version:2,status:'reconciled_stock_original_cells_page',authority:'not_established',coverage:'one_kind_page_only',
        graph,stock,source_metadata:source,typed_profile:TYPED,page_profile:PROFILE,effective_date:effective,
        kind:page.kind,cursor:page.cursor,rows,next_cursor:next??page.cursor,
        scanned_original_count:result.scan_count,scoped_candidate_count:result.candidate_count,
        end_of_kind:result.scan_count<page.rowLimit&&result.page_count===result.candidate_count,
        original_reconciliation:'every_delivered_original_recompiled',selected_union:'not_established',
        source_acquisition:'not_established',report_update:'none'});
    },
  });
}
