import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { assessmentDate,assessmentEvidenceDigest,canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob,prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { NEIGHBORHOOD_SHARED_TYPED_CAD_SQL,prepareNeighborhoodSharedTypedCadSource } from './neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenCadImprovementProfile } from './neighborhoodFrozenCadImprovements.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';

export const NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_LIMITS=Object.freeze({rows:250,row_utf8_bytes:32768,
  page_utf8_bytes:2100000,read_utf8_bytes:32000000,queries:48,step_ms:60000});
const L=NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_LIMITS,PROFILE=getNeighborhoodFrozenTypedCadImprovementV1Profile(),SOURCE=getNeighborhoodFrozenCadImprovementProfile();
const KINDS=['primary','secondary'],HASH=/^[a-f0-9]{64}$/,TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const fail=r=>{throw new TypeError(`neighborhood_shared_job_CAD_${r}`);};
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length
  ||!keys.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable&&Object.hasOwn(d,'value');}))fail('invalid_data');return v;}
function account(v,empty=false){if(typeof v!=='string'||!v.isWellFormed()||!empty&&!v||Buffer.byteLength(v)>64||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail('invalid_data');return v;}
const count=(v,max)=>typeof v==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<=BigInt(max);
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('invalid_result');return r.rows[0];};
function key(v,kind,accountId,empty=false){if(empty&&v==='')return v;
  if(kind==='primary'?v!==accountId:typeof v!=='string'||!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)fail('invalid_data');return v;}
export function prepareNeighborhoodSharedJobCadPage(value){
  const v=data(value,['kind','cursor','rowLimit']),c=data(v.cursor,['account_id','row_key']);
  if(!KINDS.includes(v.kind)||!Number.isInteger(v.rowLimit)||v.rowLimit<1||v.rowLimit>L.rows)fail('invalid_page');
  account(c.account_id,true);key(c.row_key,v.kind,c.account_id,true);
  if((c.account_id==='')!==(c.row_key===''))fail('invalid_page');
  return freeze({kind:v.kind,cursor:{...c},rowLimit:v.rowLimit});
}
export function prepareNeighborhoodSharedJobCadAccountPage(value){
  const v=data(value,['cursor','rowLimit']);account(v.cursor,true);
  if(!Number.isInteger(v.rowLimit)||v.rowLimit<1||v.rowLimit>L.rows)fail('invalid_page');
  return freeze({cursor:v.cursor,rowLimit:v.rowLimit});
}
const ACCOUNT_DEFINITION=freeze({id:'neighborhood-current-CAD-stock-account-projection-v1',revision:'1',
  syntax_profile:PROFILE.profile_ref,source_profile:SOURCE.profile_ref,limits:L,
  population:'every_exact_pinned_stock_account_including_absent_primary',
  primary:'one_native_account_row_no_cross_source_coalescing_summing_or_housing_inference',
  secondary:'exact_native_row_count_only_no_type_dictionary_area_sum_or_garage_inference',
  temporal:'retained_effective_year_before_projection_future_year_invalid_other_current_fields_not_historical',
  numeric:'exact_decimal_strings_native_boolean_NULL_missing_not_zero_or_false',
  coverage:'one_account_page_not_complete_population',authority:'not_established',
  limitations:['not_verified_GLA_or_bathroom_equivalence','not_historical_stock_or_at_sale_amenities',
    'no_housing_eligibility_or_secondary_type_resolution','no_source_license_or_acquisition_receipt',
    'no_selected_union_statistics_or_report_update']});
const accountText=canonicalAssessmentJson(ACCOUNT_DEFINITION),accountBlob=prepareNeighborhoodCohortBlob(accountText);
const ACCOUNT_PROFILE=freeze({profile_ref:{id:ACCOUNT_DEFINITION.id,revision:'1',content_sha256:accountBlob.content_sha256},
  definition_blob:{ref:accountBlob,canonical_json:accountText}});
export function getNeighborhoodSharedJobCadAccountProfile(){return ACCOUNT_PROFILE;}
// Exact stock-account PK probes and the generation/profile/kind/account/key
// cache index; no geometry clipping, array of the stock, current core read or
// count of the whole population. C-text cache order is not native bigint order.
export const NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL=`/* neighborhood-shared-job-CAD:page */
WITH candidates AS MATERIALIZED (
  SELECT typed.account_id,typed.row_key,jsonb_build_object('kind',typed.kind,'account_id',typed.account_id,
    'row_key',typed.row_key,'original_payload_sha256',typed.original_payload_sha256,'typed',typed.typed)::text AS encoded
  FROM app.neighborhood_custom_cohort_stock_accounts stock
  JOIN app.neighborhood_frozen_typed_cad_rows typed ON typed.account_id=stock.account_id
  WHERE stock.operation_id=$1::uuid AND typed.generation_id=$2::uuid AND typed.profile_sha256=$3 AND typed.kind=$4
    AND (typed.account_id,typed.row_key)>($5::text COLLATE "C",$6::text COLLATE "C")
  ORDER BY typed.account_id,typed.row_key LIMIT $7::integer
), sized AS (
  SELECT *,octet_length(encoded) AS bytes,sum(octet_length(encoded)+1) OVER(ORDER BY account_id,row_key) AS cumulative FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes<=$9::integer AND cumulative+1<=$8::integer)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY account_id,row_key)||']','[]') AS page_json,count(*)::integer AS page_count,
  (SELECT count(*)::integer FROM candidates) AS candidate_count,
  (SELECT count(*)::integer FROM sized WHERE bytes>$9::integer) AS oversized_count,
  (SELECT account_id FROM admitted ORDER BY account_id DESC,row_key DESC LIMIT 1) AS next_account,
  (SELECT row_key FROM admitted ORDER BY account_id DESC,row_key DESC LIMIT 1) AS next_key FROM admitted`;

// Account keysets retain missing-primary members. Only one native primary and
// one constant-size secondary count cross into Node, never secondary row arrays.
export const NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL=`/* neighborhood-shared-job-CAD:account-page */
WITH accounts AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT $5::integer
), candidates AS MATERIALIZED (
  SELECT a.account_id,jsonb_build_object('account_id',a.account_id,'geographic_parcel_count',a.parcel_count::text,
    'primary',CASE WHEN p.row_key IS NULL THEN NULL ELSE jsonb_build_object('kind',p.kind,'account_id',p.account_id,
      'row_key',p.row_key,'original_payload_sha256',p.original_payload_sha256,'typed',p.typed) END,
    'secondary_original_count',(SELECT count(*)::text FROM app.neighborhood_frozen_typed_cad_rows s
      WHERE s.generation_id=$2::uuid AND s.profile_sha256=$3 AND s.kind='secondary' AND s.account_id=a.account_id))::text AS encoded
  FROM accounts a LEFT JOIN app.neighborhood_frozen_typed_cad_rows p ON p.generation_id=$2::uuid
    AND p.profile_sha256=$3 AND p.kind='primary' AND p.account_id=a.account_id AND p.row_key=a.account_id
), sized AS (
  SELECT *,octet_length(encoded) AS bytes,sum(octet_length(encoded)+1) OVER(ORDER BY account_id) AS cumulative FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes<=$7::integer AND cumulative+1<=$6::integer)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY account_id)||']','[]') AS page_json,count(*)::integer AS page_count,
  (SELECT count(*)::integer FROM candidates) AS candidate_count,
  (SELECT count(*)::integer FROM sized WHERE bytes>$7::integer) AS oversized_count,
  max(account_id) AS next_account FROM admitted`;

const FIELDS={primary:{reported_year_built:'year',reported_living_area:'reported_sqft',reported_bedrooms:'reported_bedrooms',
  reported_baths:'CAD_reported_baths',reported_units:'reported_units',reported_pool_flag:'reported_pool_flag'},
  secondary:{reported_improvement_number:'reported_improvement_number',reported_improvement_area:'reported_sqft'}};
function rawOf(value){const r=data(value,['state','json_type','value_text','utf8_bytes','value_sha256']);
  if(!['json_null','scalar','oversize','non_scalar'].includes(r.state)||!['null','string','number','boolean','object','array'].includes(r.json_type)
    ||!Number.isInteger(r.utf8_bytes)||r.utf8_bytes<0||r.utf8_bytes>1000000)fail('invalid_typed_row');
  if(r.state==='json_null'?(r.json_type!=='null'):r.state==='non_scalar'?!['object','array'].includes(r.json_type)
    :!['string','number','boolean'].includes(r.json_type))fail('invalid_typed_row');
  if(r.state==='json_null'){if(r.json_type!=='null'||r.value_text!==null||r.value_sha256!==null||r.utf8_bytes!==0)fail('invalid_typed_row');}
  else if(!HASH.test(r.value_sha256??'')||r.value_text!==null&&(typeof r.value_text!=='string'||!r.value_text.isWellFormed()||Buffer.byteLength(r.value_text)>128
    ||Buffer.byteLength(r.value_text)!==r.utf8_bytes||createHash('sha256').update(r.value_text,'utf8').digest('hex')!==r.value_sha256)
    ||r.state==='scalar'&&(r.value_text===null||r.utf8_bytes>128)||r.state==='oversize'&&(r.value_text!==null||r.utf8_bytes<=128)
    ||r.state==='non_scalar'&&(r.value_text===null)!==(r.utf8_bytes>128))fail('invalid_typed_row');
  return r;
}
// Independently reconcile each retained cell with its bounded literal, without
// reading the original payload or converting economic values to JS Number.
function expectedCell(raw,name,unit){
  const cell=(state,exact_value,reason)=>({state,exact_value,unit:state==='observed'?unit:null,reason});
  if(raw.state==='json_null'||name!=='reported_pool_flag'&&raw.state==='scalar'&&raw.json_type==='string'&&!raw.value_text.trim())return cell('missing',null,'raw_value_missing');
  if(raw.state==='oversize')return cell('unsupported',null,'raw_value_oversize');
  if(name==='reported_pool_flag')return raw.state==='scalar'&&raw.json_type==='boolean'&&['true','false'].includes(raw.value_text)
    ?cell('observed',raw.value_text==='true',null):cell('invalid',null,'raw_value_type_invalid');
  if(raw.state!=='scalar'||raw.json_type!=='string')return cell('invalid',null,'raw_value_type_invalid');
  const text=raw.value_text.trim();if(!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text))return cell('invalid',null,'raw_value_invalid');
  let [whole,fraction='']=text.replace(/^\+/,'').split('.');whole=whole.replace(/^0+/,'')||'0';fraction=fraction.replace(/0+$/,'');
  const integral=['reported_bedrooms','reported_units','reported_improvement_number','reported_year_built'].includes(name);
  if(whole.length+fraction.length>30||fraction.length>12||name==='reported_living_area'&&whole==='0'&&!fraction
    ||integral&&(fraction||BigInt(whole)>2147483647n)||name==='reported_year_built'&&(BigInt(whole)<1600n||BigInt(whole)>9999n))return cell('invalid',null,'raw_value_invalid');
  return cell('observed',whole+(fraction?`.${fraction}`:''),null);
}
function decodeRow(value,kind){const r=data(value,['kind','account_id','row_key','original_payload_sha256','typed']);
  if(r.kind!==kind||!HASH.test(r.original_payload_sha256??''))fail('invalid_typed_row');account(r.account_id);key(r.row_key,kind,r.account_id);
  const t=data(r.typed,['typed_CAD_improvement_version','interpretation_profile_ref','temporal_basis','original','account_id',
    'observations','markers','authority','coverage','source_freshness']);
  const original=data(t.original,['kind','row_key','original_profile_ref','payload_sha256','payload_utf8_bytes']);
  if(t.typed_CAD_improvement_version!==1||!same(t.interpretation_profile_ref,PROFILE.profile_ref)||!same(original.original_profile_ref,SOURCE.profile_ref)
    ||t.temporal_basis!=='date_neutral_original_syntax'||t.account_id!==r.account_id||original.kind!==kind||original.row_key!==r.row_key
    ||original.payload_sha256!==r.original_payload_sha256||!Number.isInteger(original.payload_utf8_bytes)||original.payload_utf8_bytes<1||original.payload_utf8_bytes>1000000
    ||t.authority!=='not_established'||t.coverage!=='one_original_only'||t.source_freshness!=='not_established')fail('invalid_typed_row');
  const fields=FIELDS[kind],cells=data(t.observations,Object.keys(fields));
  for(const [name,value] of Object.entries(cells)){const c=data(value,['state','exact_value','unit','reason','raw']),raw=rawOf(c.raw);
    if(!same({state:c.state,exact_value:c.exact_value,unit:c.unit,reason:c.reason},expectedCell(raw,name,fields[name])))fail('invalid_typed_row');
  }
  const markers=data(t.markers,kind==='primary'?[]:['sec_imp_type']);if(kind==='secondary')rawOf(markers.sec_imp_type);
  if(Buffer.byteLength(canonicalAssessmentJson(r))>L.row_utf8_bytes)fail('row_limit');return freeze(r);
}
function decodeAccountRow(value,effective,source){
  const r=data(value,['account_id','geographic_parcel_count','primary','secondary_original_count']);account(r.account_id);
  if(!count(r.geographic_parcel_count,2000000)||r.geographic_parcel_count==='0'
    ||!count(r.secondary_original_count,Number(source.layer_counts.secondary.row_count))
    ||Buffer.byteLength(canonicalAssessmentJson(r))>L.row_utf8_bytes)fail('invalid_result');
  const primary=r.primary===null?null:decodeRow(r.primary,'primary');
  if(primary&&primary.account_id!==r.account_id)fail('invalid_result');
  const observations=Object.fromEntries(Object.keys(FIELDS.primary).map(name=>{
    if(!primary)return [name,{state:'missing',exact_value:null,unit:null,reason:'primary_original_absent'}];
    const {state,exact_value,unit,reason}=primary.typed.observations[name];
    if(name==='reported_year_built'&&state==='observed'&&exact_value>effective.slice(0,4))
      return [name,{state:'invalid',exact_value:null,unit:null,reason:'year_after_retained_effective_year'}];
    return [name,{state,exact_value,unit,reason}];
  }));
  return freeze({account_id:r.account_id,geographic_parcel_count:r.geographic_parcel_count,
    primary_original_count:primary?'1':'0',secondary_original_count:r.secondary_original_count,
    primary_original:primary?.typed.original??null,observations,
    secondary_type_resolution:'not_established',housing_eligibility:'not_established',
    temporal_basis:'current_retained_CAD_not_historical_or_at_sale',source_freshness:'not_established'});
}
/** One bounded read-only DATA step. Only the future current-authorized owner
 * may compose this: actual issued V2 graph/geo/identity, actor/assignment/subject,
 * extra CAD source rights and live claim/pin at BOTH ends remain mandatory.
 * No cache-miss preparation, original payload, current core, source grant,
 * date policy, amenities resolution, complete acquisition or report receipt. */
export function createNeighborhoodSharedJobCadImprovementPages(client,rawOptions,rawGraph){
  return cadPages(client,rawOptions,rawGraph,null);
}
/** Fixed account projection. The actual owner supplies its retained date; this
 * DATA entry point cannot authorize source access or certify historical facts. */
export function createNeighborhoodSharedJobCadAccountPages(client,rawOptions,rawGraph,effectiveDate){
  return cadPages(client,rawOptions,rawGraph,assessmentDate(effectiveDate));
}
function cadPages(client,rawOptions,rawGraph,effective){
  const projectingAccounts=effective!==null;
  const o={...data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget'])};
  if(typeof client?.query!=='function'||typeof o.checkBudget!=='function')fail('invalid_input');
  const g=data(rawGraph,['root','layer_counts']),ref=data(g.root,['content_sha256','canonical_utf8_bytes']);
  const root=prepareNeighborhoodCohortBlobReference(ref.content_sha256,ref.canonical_utf8_bytes),counts=data(g.layer_counts,
    ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs']);
  if(!Object.values(counts).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000))fail('invalid_input');
  const graph=freeze({root,layer_counts:{...counts}});let used=false,queries=0,readBytes=0,started;
  const check=()=>{o.checkBudget();if(performance.now()-started>L.step_ms)fail('deadline');};
  const execute=async(text,values)=>{check();if(++queries>L.queries)fail('query_limit');
    const q=typeof text==='string'?{text,values,query_timeout:5000}:{...text,query_timeout:5000};const r=await client.query(q);
    if(!Array.isArray(r?.rows))fail('invalid_result');
    // This is transport accounting, not an evidence identity. The evidence
    // canonicalizer's smaller blob cap must not truncate a valid 2.1 MB page.
    let encoded;try{encoded=JSON.stringify(r.rows);}catch{fail('invalid_result');}
    readBytes+=Buffer.byteLength(encoded);if(readBytes>L.read_utf8_bytes)fail('byte_limit');check();return r;};
  const store=createNeighborhoodFrozenJobStock({query:execute},o);
  return Object.freeze({async page(rawPage){const page=projectingAccounts?prepareNeighborhoodSharedJobCadAccountPage(rawPage):prepareNeighborhoodSharedJobCadPage(rawPage);if(used)fail('single_use');used=true;started=performance.now();
    const stock=await store.read(),source=prepareNeighborhoodSharedTypedCadSource(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,[stock.generation_id]),stock.generation_id);
    if(source.source_snapshot!==stock.original.source_snapshot||source.started_at!==stock.original.source_transaction_started_at
      ||Object.entries(graph.layer_counts).some(([k,n])=>n>Number(stock.original.layer_counts[k].row_count)))fail('source_mismatch');
    const binding=assessmentEvidenceDigest({source,profile:PROFILE}),headerValues=[stock.generation_id,PROFILE.profile_ref.content_sha256];
    const validate=raw=>{const h=data(raw,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']);
      const p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
      if(h.binding_sha256!==binding||h.status!=='complete'||!same(h.source_metadata,source)||h.definition_json!==PROFILE.definition_blob.canonical_json
        ||!TIME.test(h.completed_at??'')||p.format!=='shared_frozen_typed_CAD_progress_v1'||p.binding_sha256!==binding||p.kind_index!==2
        ||p.after!==''||p.layer_rows!==0||p.typed_rows!==source.row_count||!count(p.typed_utf8_bytes,8000000000)||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows))fail('cache_unavailable');};
    const header=one(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,headerValues));validate(header);
    const r=one(await execute(projectingAccounts?NEIGHBORHOOD_SHARED_JOB_CAD_ACCOUNT_PAGE_SQL:NEIGHBORHOOD_SHARED_JOB_CAD_PAGE_SQL,
      projectingAccounts?[stock.operation_id,stock.generation_id,PROFILE.profile_ref.content_sha256,page.cursor,page.rowLimit,L.page_utf8_bytes,L.row_utf8_bytes]
        :[stock.operation_id,stock.generation_id,PROFILE.profile_ref.content_sha256,page.kind,page.cursor.account_id,page.cursor.row_key,page.rowLimit,L.page_utf8_bytes,L.row_utf8_bytes]));
    if(!Number.isInteger(r.page_count)||!Number.isInteger(r.candidate_count)||r.page_count<0||r.candidate_count<r.page_count
      ||r.candidate_count>page.rowLimit||r.oversized_count!==0||typeof r.page_json!=='string')fail('invalid_result');
    if(Buffer.byteLength(r.page_json)>L.page_utf8_bytes||Buffer.byteLength(r.page_json)>L.read_utf8_bytes)fail('byte_limit');
    let rows;try{rows=JSON.parse(r.page_json);}catch{fail('invalid_result');}
    if(!Array.isArray(rows)||rows.length!==r.page_count||rows.length===0&&r.candidate_count!==0)fail('invalid_result');
    let previous=projectingAccounts?{account_id:page.cursor,row_key:''}:page.cursor;rows=rows.map(value=>{const row=projectingAccounts?decodeAccountRow(value,effective,source):decodeRow(value,page.kind);
      const order=Buffer.compare(Buffer.from(row.account_id),Buffer.from(previous.account_id));
      if(order<0||order===0&&(projectingAccounts||Buffer.compare(Buffer.from(row.row_key),Buffer.from(previous.row_key))<=0))fail('invalid_order');
      previous={account_id:row.account_id,row_key:projectingAccounts?'':row.row_key};return row;});
    if(r.next_account!==(rows.length?previous.account_id:null)||!projectingAccounts&&r.next_key!==(rows.length?previous.row_key:null))fail('invalid_result');
    if(!same(await store.read(),stock)||!same(prepareNeighborhoodSharedTypedCadSource(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,[stock.generation_id]),stock.generation_id),source))fail('source_changed');
    const ending=one(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,headerValues));validate(ending);if(!same(ending,header))fail('source_changed');check();
    if(projectingAccounts)return freeze({page_version:1,status:'current_CAD_account_projection_page',authority:'not_established',coverage:'one_account_page_only',
      graph,stock,source_metadata:source,typed_profile:PROFILE,projection_profile:ACCOUNT_PROFILE,effective_date:effective,
      cursor:page.cursor,rows,next_cursor:previous.account_id,end_of_accounts:r.candidate_count<page.rowLimit&&r.page_count===r.candidate_count,
      absent_primary:'missing_not_zero_or_no_amenity',source_acquisition:'not_established',report_update:'none'});
    return freeze({page_version:1,status:'shared_CAD_original_syntax_page',authority:'not_established',coverage:'one_kind_page_only',
      graph,stock,source_metadata:source,typed_profile:PROFILE,kind:page.kind,cursor:page.cursor,rows,next_cursor:previous,
      end_of_kind:r.candidate_count<page.rowLimit&&r.page_count===r.candidate_count,
      absent_rows:'not_zero_or_no_amenity',source_acquisition:'not_established',report_update:'none'});
  }});
}
