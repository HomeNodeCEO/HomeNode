import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest,canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob,prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobSourceSeeds } from './neighborhoodFrozenJobSourceSeeds.js';
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL,prepareNeighborhoodSharedTypedSource } from './neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { NEIGHBORHOOD_TYPED_TRANSACTION_V2_KINDS,prepareNeighborhoodTypedTransactionV2 } from './neighborhoodFrozenTypedTransactionV2.js';

export const NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_LIMITS=Object.freeze({rows:250,row_utf8_bytes:66560,
  page_utf8_bytes:2100000,read_utf8_bytes:32000000,queries:128,step_ms:60000,query_ms:5000});
const L=NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_LIMITS,PROFILE=getNeighborhoodFrozenTypedOriginalV2Profile();
const ALL_KINDS=['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
const fail=r=>{throw new TypeError(`neighborhood_shared_transaction_v2_${r}`);};
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(d);
  if(names.length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));}
function cursor(v){if(v==='')return v;if(typeof v!=='string'||!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)fail('invalid_cursor');return v;}
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('invalid_result');return r.rows[0];};
const count=(v,max)=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=BigInt(max);
export function prepareNeighborhoodSharedTransactionPageV2(value){
  const p=data(value,['kind','cursor','rowLimit']);cursor(p.cursor);
  if(!NEIGHBORHOOD_TYPED_TRANSACTION_V2_KINDS.includes(p.kind)||!Number.isInteger(p.rowLimit)||p.rowLimit<1||p.rowLimit>L.rows)fail('invalid_page');
  return freeze(p);
}
const DEFINITION=freeze({id:'neighborhood-shared-job-one-hop-transaction-pages-v2',revision:'1',typed_profile:PROFILE,
  kinds:NEIGHBORHOOD_TYPED_TRANSACTION_V2_KINDS,limits:L,order:'native_row_key_C_text_not_numeric',
  scope:'exact_prepared_original_stock_seeds_all_dates_one_hop_no_secondary_CAD_or_second_hop',
  legacy_sales:'source_record_id_null_exact_original_stock_accounts_only_no_fabricated_source_or_price_allocation',
  observations:'independently_reconciled_neutral_cells_and_same_payload_reported_witness_diagnostics_no_normalized_fallback',
  temporal:'no_filter_or_report_date_in_cache_apply_retained_year_and_period_before_later_resolution',
  coverage:'one_kind_page_only_not_complete_transactions',authority:'not_established',
  limitations:['no_verified_transaction_completion_consideration_or_economic_property_equivalence',
    'no_historical_stock_or_at_sale_GLA','no_selection_or_statistics','no_source_license_or_acquisition_receipt','no_report_update']});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionRef=prepareNeighborhoodCohortBlob(definitionText);
const PAGE_PROFILE=freeze({profile_ref:{id:DEFINITION.id,revision:'1',content_sha256:definitionRef.content_sha256},
  definition_blob:{ref:definitionRef,canonical_json:definitionText}});
export function getNeighborhoodSharedTransactionPageV2Profile(){return PAGE_PROFILE;}

// Generation/profile/kind/row-key index plus exact prepared seed/account PKs.
// Read every seeded source/sale/link, including outside/unresolved links; never
// use those outside accounts as new discovery seeds or CAD lookup accounts.
export const NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL=`/* neighborhood-shared-job-transactions-v2:page */
WITH candidates AS MATERIALIZED (
  SELECT t.row_key,jsonb_build_object('kind',t.kind,'row_key',t.row_key,'account_id',t.account_id,
    'source_record_id',t.source_record_id::text,'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM app.neighborhood_frozen_typed_v2_rows t
  WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=$4 AND t.row_key>$5::text COLLATE "C"
    AND (EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_seeds s
      WHERE s.operation_id=$1::uuid AND s.generation_id=$2::uuid AND s.source_record_id=t.source_record_id)
      OR (t.kind='sales' AND t.source_record_id IS NULL AND EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts a WHERE a.operation_id=$1::uuid AND a.account_id=t.account_id)))
  ORDER BY t.row_key LIMIT $6::integer
), sized AS (
  SELECT *,octet_length(encoded) AS bytes,sum(octet_length(encoded)+1) OVER(ORDER BY row_key) AS cumulative FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes<=$8::integer AND cumulative+1<=$7::integer)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY row_key)||']','[]') AS page_json,count(*)::integer AS page_count,
  (SELECT count(*)::integer FROM candidates) AS candidate_count,
  (SELECT count(*)::integer FROM sized WHERE bytes>$8::integer) AS oversized_count,max(row_key) AS next_cursor FROM admitted`;

/** One read-only DATA page. Actual current-authorized owner must first reopen
 * completed issued graph/geography/identity and original source rights, and
 * repeat all admission at delivery. No miss preparation, original payload
 * copy, second-hop discovery, date/selection filter, write, route or worker. */
export function createNeighborhoodSharedJobTransactionPagesV2(client,rawOptions,rawGraph){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if(typeof client?.query!=='function'||typeof options.checkBudget!=='function')fail('invalid_input');
  const g=data(rawGraph,['root','layer_counts']),r=data(g.root,['content_sha256','canonical_utf8_bytes']);
  const root=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes),layers=data(g.layer_counts,ALL_KINDS);
  if(!Object.values(layers).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000))fail('invalid_input');
  const graph=freeze({root,layer_counts:layers});let used=false,queries=0,bytes=0,started;
  const check=()=>{options.checkBudget();if(performance.now()-started>L.step_ms)fail('deadline');};
  const execute=async(text,values)=>{
    check();if(++queries>L.queries)fail('query_limit');
    const q=typeof text==='string'?{text,values,query_timeout:L.query_ms}:{...text,query_timeout:L.query_ms};
    const result=await client.query(q);if(!Array.isArray(result?.rows))fail('invalid_result');
    let encoded;try{encoded=JSON.stringify(result.rows);}catch{fail('invalid_result');}
    bytes+=Buffer.byteLength(encoded);if(bytes>L.read_utf8_bytes)fail('byte_limit');check();return result;
  };
  const seeds=createNeighborhoodFrozenJobSourceSeeds({query:execute},options);
  return Object.freeze({async page(rawPage){
    const page=prepareNeighborhoodSharedTransactionPageV2(rawPage);if(used)fail('single_use');used=true;started=performance.now();
    const seed=await seeds.read(),stock=seed.stock,original=stock.original;
    const source=prepareNeighborhoodSharedTypedSource(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id);
    const expected={generation_id:original.generation_id,format_version:original.source_format_version,status:'complete',
      source_snapshot:original.source_snapshot,started_at:original.source_transaction_started_at,completed_at:original.completed_at,
      layer_counts:original.layer_counts,row_count:original.row_count,payload_utf8_bytes:original.payload_utf8_bytes};
    if(!same(source,expected)||Object.entries(layers).some(([k,n])=>n>Number(source.layer_counts[k].row_count)))fail('source_mismatch');
    const binding=assessmentEvidenceDigest({source,profile:PROFILE}),values=[stock.generation_id,PROFILE.profile_ref.content_sha256];
    const validate=raw=>{
      const h=data(raw,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']);
      const p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
      if(h.binding_sha256!==binding||!same(h.source_metadata,source)||h.definition_json!==PROFILE.definition_blob.canonical_json||h.status!=='complete'
        ||typeof h.completed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at)
        ||p.format!=='shared_frozen_typed_progress_v2'||p.binding_sha256!==binding||p.kind_index!==7||p.after!==''||p.layer_rows!==0
        ||p.typed_rows!==source.row_count||!count(p.typed_utf8_bytes,8000000000)||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows))fail('cache_unavailable');
    };
    const header=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,values));validate(header);
    const result=one(await execute(NEIGHBORHOOD_SHARED_JOB_TRANSACTION_V2_PAGE_SQL,
      [stock.operation_id,stock.generation_id,PROFILE.profile_ref.content_sha256,page.kind,page.cursor,page.rowLimit,L.page_utf8_bytes,L.row_utf8_bytes]));
    if(!Number.isInteger(result.page_count)||!Number.isInteger(result.candidate_count)||result.page_count<0
      ||result.candidate_count<result.page_count||result.candidate_count>page.rowLimit||result.oversized_count!==0
      ||result.page_count>layers[page.kind]||typeof result.page_json!=='string')fail('invalid_result');
    if(Buffer.byteLength(result.page_json)>L.page_utf8_bytes)fail('byte_limit');
    let rows;try{rows=JSON.parse(result.page_json);}catch{fail('invalid_result');}
    if(!Array.isArray(rows)||rows.length!==result.page_count||!rows.length&&result.candidate_count!==0)fail('invalid_result');
    let previous=page.cursor;rows=rows.map(value=>{
      const row=prepareNeighborhoodTypedTransactionV2(value);
      if(row.kind!==page.kind||Buffer.compare(Buffer.from(row.row_key),Buffer.from(previous))<=0
        ||Buffer.byteLength(canonicalAssessmentJson(row))>L.row_utf8_bytes)fail('invalid_order_or_row');
      previous=row.row_key;return row;
    });
    if(result.next_cursor!==(rows.length?previous:null))fail('invalid_result');
    if(!same(await seeds.read(),seed)||!same(prepareNeighborhoodSharedTypedSource(
      await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id),source))fail('source_changed');
    const ending=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,values));validate(ending);if(!same(ending,header))fail('source_changed');check();
    return freeze({page_version:2,status:'shared_one_hop_transaction_originals_page',authority:'not_established',coverage:'one_kind_page_only',
      graph,stock,seed_index:seed,source_metadata:source,typed_profile:PROFILE,page_profile:PAGE_PROFILE,
      kind:page.kind,cursor:page.cursor,rows,next_cursor:previous,
      end_of_kind:result.candidate_count<page.rowLimit&&result.page_count===result.candidate_count,
      temporal_basis:'date_neutral_syntax_retained_year_and_period_admission_required',
      transaction_eligibility:'not_established',source_acquisition:'not_established',report_update:'none'});
  }});
}
