import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { scanOriginalJsonText } from './originalJsonTokens.js';

const LIMITS=Object.freeze({original_utf8_bytes:1000000,original_rows:250,label_utf8_bytes:512,output_utf8_bytes:1000000});
const missing=new Set(['unknown','unassigned','n/a','none','not available']);
const compare=(a,b)=>a<b?-1:a>b?1:0;
const sorted=values=>[...new Set(values)].sort(compare);
/** Never include private original labels or source text in an error. */
const fail=reason=>{throw new TypeError(`neighborhood_original_recorded_group_v2_${reason}`);};
/** Freeze detached metadata and fixed profile DATA only. */
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** Admit exact own DATA before reading any hostile getter/proxy. */
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Inspect a required DATA member without treating an object as authority. */
function own(v,k){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('invalid_input');return d.value;}
const definition=freeze({id:'neighborhood-original-recorded-group-v2',revision:'1',limits:LIMITS,
  population:'one_server_chosen_complete_original_stock_account_including_outside_geometry_parts',
  prerequisites:'actual_owner_replays_every_original_and_entire_neutral_cache_before_projection_and_resolution',
  input:'fixed_original_account_county_subdivision_and_parcel_subdivision_name_not_truncated_128byte_cache_markers',
  labels:'512byte_original_literal_trim_whitespace_collapse_lowercase_no_substring_or_majority',
  placeholders:[...missing],invalid:'nontext_disallowed_controls_or_ill_formed_unicode_remain_unassigned',
  oversize:'whole_account_refusal_not_missing_or_prefix',county:'exactly_one_known_county_no_invalid_county_no_Dallas_fallback',
  group_id:'recorded-cad:sha256_of_JSON.stringify({county:normalized_county,label:normalized_label})_legacy_encoding',
  assignment:'exactly_one_known_label_no_invalid_label_otherwise_all_candidates_and_reasons_unassigned',
  missing_parts:'known_labels_plus_missing_or_placeholder_parts_remain_partially_observed_not_fabricated',
  authority:'not_established',basis:'retained_current_CAD_recorded_labels_not_legal_or_historical_membership',
  limitations:['not_complete_catalog_partition_or_selected_union','not_housing_competitive_eligibility_or_recommendation',
    'no_builder_HOA_phase_boundary_or_provider_coverage_inference','not_source_grant_statistics_publication_or_report_update']});
const text=canonicalAssessmentJson(definition),ref=prepareNeighborhoodCohortBlob(text);
const PROFILE=freeze({profile_ref:{id:definition.id,revision:'1',content_sha256:ref.content_sha256},definition_blob:{ref,canonical_json:text}});
/** A fixed versioned projection contract, not a source/selection capability. */
export function getNeighborhoodOriginalRecordedGroupV2Profile(){return PROFILE;}

/** Preserve the legacy bounded literal semantics; do not recover from a hash. */
function label(value){
  if(value===undefined||value===null||typeof value==='string'&&!value.trim())return {state:'missing',raw:null,key:null};
  if(typeof value!=='string'||!value.isWellFormed()||/[\u0000-\u0008\u000e-\u001f\u007f]/.test(value))
    return {state:'invalid',raw:null,key:null};
  if(value.length>LIMITS.label_utf8_bytes||Buffer.byteLength(value)>LIMITS.label_utf8_bytes)fail('recorded_label_text_limit');
  const key=value.trim().replace(/\s+/gu,' ').toLowerCase();
  return {state:missing.has(key)?'placeholder':'known',raw:value,key};
}
/** DATA projection only. The actual reader calls this ONLY after recompiling
 * this exact original and comparing its ENTIRE date-neutral cache value. It
 * cannot authenticate a caller original, current rights, graph or population. */
export function projectNeighborhoodOriginalRecordedGroupLabelsV2(raw){
  const r=data(raw,['kind','row_key','account_id','payload_text']);
  if(!['accounts','parcels'].includes(r.kind)||typeof r.row_key!=='string'||!r.row_key||r.row_key.length>64
    ||!r.row_key.isWellFormed()||/[\u0000-\u001f\u007f]/.test(r.row_key)
    ||typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()
    ||r.account_id!==r.account_id.trim()||/[\u0000-\u001f\u007f]/.test(r.account_id)
    ||typeof r.payload_text!=='string'||Buffer.byteLength(r.payload_text)>LIMITS.original_utf8_bytes)fail('invalid_input');
  let original,index;try{index=scanOriginalJsonText(r.payload_text,'index').index;original=JSON.parse(r.payload_text);}
  catch{fail('invalid_original');}
  if(index.nodes[0].kind!=='object'||original.account_id!==r.account_id
    ||original[r.kind==='accounts'?'account_id':'object_id']!==r.row_key)fail('identity_mismatch');
  return freeze({county:r.kind==='accounts'?label(original.county):null,
    subdivision:label(original[r.kind==='accounts'?'subdivision':'subdivision_name'])});
}

/** Resolve one COMPLETE reconciled account. The owner, not this DATA helper,
 * authenticates that completeness and every original under its single budget.
 * No dense population, selected roster, statistic or durable head is minted. */
export function resolveNeighborhoodOriginalRecordedGroupV2(rows,check){
  if(!Array.isArray(rows)||isProxy(rows)||Object.getPrototypeOf(rows)!==Array.prototype||rows.length>LIMITS.original_rows
    ||typeof check!=='function')fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(rows);if(Reflect.ownKeys(ds).length!==rows.length+1)fail('invalid_input');
  const counties=[],names=[];let id=null,previous=null,accountRows=0,parcelRows=0;
  /** Revalidate bounded projection DATA before deriving membership diagnostics. */
  const cell=raw=>{const c=data(raw,['state','raw','key']);
    if(!['missing','invalid','placeholder','known'].includes(c.state))fail('invalid_input');
    if(c.state==='invalid'){if(c.raw!==null||c.key!==null)fail('invalid_input');}
    else if(canonicalAssessmentJson(c)!==canonicalAssessmentJson(label(c.raw)))fail('invalid_input');
    return c;};
  check();
  for(let i=0;i<rows.length;i++){
    if(!ds[i]?.enumerable||!Object.hasOwn(ds[i],'value'))fail('invalid_input');
    const row=ds[i].value,kind=own(row,'kind'),key=own(row,'row_key'),account=own(row,'account_id');
    if(!['accounts','parcels'].includes(kind)||typeof key!=='string'||!key||typeof account!=='string'||!account
      ||id!==null&&account!==id)fail('invalid_input');id=account;
    const order=`${kind}\u0000${key}`;if(previous!==null&&Buffer.compare(Buffer.from(order),Buffer.from(previous))<=0)fail('invalid_input');previous=order;
    const labels=data(own(row,'original_recorded_labels'),['county','subdivision']);
    if(kind==='accounts'){counties.push(cell(labels.county));accountRows++;}
    else{if(labels.county!==null)fail('invalid_input');parcelRows++;}
    names.push(cell(labels.subdivision));check();
  }
  if(accountRows>1||!parcelRows)fail('incomplete_account');
  const countyKeys=sorted(counties.filter(c=>c.state==='known').map(c=>c.key)),labelKeys=sorted(names.filter(c=>c.state==='known').map(c=>c.key)),reasons=[];
  if(!countyKeys.length)reasons.push('county_unavailable');if(countyKeys.length>1)reasons.push('conflicting_recorded_counties');
  if(counties.some(c=>c.state==='invalid'))reasons.push('invalid_recorded_county');
  if(!labelKeys.length)reasons.push('recorded_subdivision_label_unavailable');if(labelKeys.length>1)reasons.push('conflicting_recorded_subdivision_labels');
  if(names.some(c=>c.state==='invalid'))reasons.push('invalid_recorded_subdivision_label');
  const candidates=countyKeys.length===1&&!reasons.includes('invalid_recorded_county')?labelKeys.map(name=>({
    id:`recorded-cad:${createHash('sha256').update(JSON.stringify({county:countyKeys[0],label:name})).digest('hex')}`,
    normalized_county:countyKeys[0],normalized_label:name,
    raw_label_variants:sorted(names.filter(c=>c.state==='known'&&c.key===name).map(c=>c.raw)),
    raw_county_variants:sorted(counties.filter(c=>c.state==='known').map(c=>c.raw))})):[];
  if(!reasons.length&&candidates.length!==1)fail('incomplete_account');
  const result={profile:PROFILE,account_id:id,state:reasons.length?'unassigned':'assigned',
    assigned_group_id:reasons.length?null:candidates[0].id,reasons,candidate_groups:candidates,
    raw_label_variants:sorted(names.map(c=>c.raw).filter(v=>v!==null)),raw_county_variants:sorted(counties.map(c=>c.raw).filter(v=>v!==null)),
    account_original_state:accountRows?'present':'absent',account_source_row_count:String(accountRows),parcel_source_row_count:String(parcelRows),
    partially_observed:labelKeys.length>0&&names.some(c=>c.state!=='known'),
    recorded_label_match_only:true,basis:definition.basis,authority:'not_established',selected_union:'not_established',report_update:'none'};
  check();if(Buffer.byteLength(JSON.stringify(result))>LIMITS.output_utf8_bytes)fail('byte_limit');return freeze(result);
}
