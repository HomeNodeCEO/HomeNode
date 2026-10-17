import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { scanOriginalJsonText } from './originalJsonTokens.js';
import { getNeighborhoodFrozenCadImprovementProfile } from './neighborhoodFrozenCadImprovements.js';

const sha=text=>createHash('sha256').update(text,'utf8').digest('hex');
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=reason=>{throw new TypeError(`neighborhood_frozen_typed_CAD_${reason}`);};
export const NEIGHBORHOOD_FROZEN_TYPED_CAD_V1_LIMITS=Object.freeze({original_utf8_bytes:1_000_000,
  output_utf8_bytes:16_384,raw_literal_utf8_bytes:128,numeric_token_characters:128,canonical_digits:30,
  fractional_digits:12,integer_max:2_147_483_647});
const L=NEIGHBORHOOD_FROZEN_TYPED_CAD_V1_LIMITS;
const SOURCE=getNeighborhoodFrozenCadImprovementProfile();
const FIELDS=freeze({
  primary:{reported_year_built:['year_built','year','year'],reported_living_area:['living_area_sqft','positive','reported_sqft'],
    reported_bedrooms:['bedroom_count','integer','reported_bedrooms'],reported_baths:['bath_count','nonnegative','CAD_reported_baths'],
    reported_units:['number_units','integer','reported_units']},
  secondary:{reported_improvement_number:['sec_imp_number','integer','reported_improvement_number'],
    reported_improvement_area:['sec_imp_sqft','nonnegative','reported_sqft']},
});
const KEYS=freeze({primary:['account_id','year_built','living_area_sqft','bedroom_count','bath_count','number_units','pool'],
  secondary:['id','account_id','sec_imp_number','sec_imp_type','sec_imp_sqft']});
const DEFINITION=freeze({id:'neighborhood-frozen-date-neutral-typed-CAD-improvement-v1',revision:'1',
  original_profile_ref:SOURCE.profile_ref,original_definition_blob:SOURCE.definition_blob,fields:FIELDS,
  boolean_field:{primary:'pool',admission:'only_native_JSON_boolean_not_text_or_numeric'},
  diagnostic_fields:{secondary:['sec_imp_type']},limits:L,
  numeric:{encoding:'SQL_decimal_integer_text_before_JSON',canonical:'exact_decimal_strings_no_floats',
    year:'integer_1600_through_9999_calendar_syntax_only',integer:'nonnegative_int32',
    grammar:'^\\+?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$',
    forbidden:['negative_including_negative_zero','exponents','symbols','commas','Number_conversion'],
    unknown:'NULL_or_blank_is_missing_not_zero'},
  temporal:'no_effective_date_parameter_or_cache_key_consumers_must_apply_retained_year_policy_before_resolution',
  identity:'one_exact_primary_account_or_native_secondary_bigint_row_key_not_sec_imp_number',
  meaning:'local_current_CAD_literals_not_verified_GLA_historical_stock_or_at_sale_amenities',
  classification:'none_no_garage_pool_outbuilding_type_aliases_or_housing_inference',
  aggregation:'none_no_cross_row_sums_counts_deduplication_or_conflict_resolution',
  authority:'not_established',coverage:'one_original_only',
  limitations:['no_provider_dictionary','no_source_rights_or_acquisition','no_job_graph_extension',
    'no_complete_population_statistics','no_report_update','no_legacy_profile_change'],
});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionBlob=prepareNeighborhoodCohortBlob(definitionText);
const PROFILE=freeze({profile_ref:{id:DEFINITION.id,revision:DEFINITION.revision,content_sha256:definitionBlob.content_sha256},
  definition_blob:{ref:definitionBlob,canonical_json:definitionText}});
/** Return the immutable, hash-bound syntax profile; this is not source authority. */
export function getNeighborhoodFrozenTypedCadImprovementV1Profile(){return PROFILE;}
/** Admit exactly three own data fields without invoking accessors or proxies. */
function inputOf(value){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds),keys=['kind','row_key','payload_text'];
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
/** Retain bounded literal diagnostics and exact token hashes without numeric coercion. */
function rawLiteral(payload,node,text,field){
  if(node.kind==='null')return {state:'json_null',json_type:'null',value_text:null,utf8_bytes:0,value_sha256:null};
  const value=node.kind==='string'?payload[field]:text.slice(node.start,node.end),bytes=Buffer.byteLength(value);
  return {state:['string','number','boolean'].includes(node.kind)?bytes>L.raw_literal_utf8_bytes?'oversize':'scalar':'non_scalar',
    json_type:node.kind,value_text:bytes<=L.raw_literal_utf8_bytes?value:null,utf8_bytes:bytes,value_sha256:sha(value)};
}
/** Canonicalize admitted decimal text exactly, or return null for policy-invalid syntax. */
function exactDecimal(text,policy){
  const token=text.trim();if(token.length>L.numeric_token_characters||!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token))return null;
  let [whole,fraction='']=token.replace(/^\+/,'').split('.');whole=whole.replace(/^0+/,'')||'0';fraction=fraction.replace(/0+$/,'');
  if(whole.length+fraction.length>L.canonical_digits||fraction.length>L.fractional_digits
    ||policy==='positive'&&whole==='0'&&!fraction
    ||['integer','year'].includes(policy)&&(fraction||BigInt(whole)>BigInt(L.integer_max))
    ||policy==='year'&&(BigInt(whole)<1600n||BigInt(whole)>9999n))return null;
  return whole+(fraction?`.${fraction}`:'');
}
/** Keep missing, unsupported and invalid numeric literals distinct from exact observations. */
function numeric(raw,policy,unit){
  const cell=(state,exact_value,reason)=>({state,exact_value,unit:state==='observed'?unit:null,reason,raw});
  if(raw.state==='json_null'||raw.state==='scalar'&&raw.json_type==='string'&&!raw.value_text.trim())return cell('missing',null,'raw_value_missing');
  if(raw.state==='oversize')return cell('unsupported',null,'raw_value_oversize');
  if(raw.state!=='scalar'||raw.json_type!=='string')return cell('invalid',null,'raw_value_type_invalid');
  const exact=exactDecimal(raw.value_text,policy);return exact===null?cell('invalid',null,'raw_value_invalid'):cell('observed',exact,null);
}
/** Admit only native JSON booleans; missing evidence never becomes an observed false. */
function boolean(raw){
  const cell=(state,exact_value,reason)=>({state,exact_value,unit:state==='observed'?'reported_pool_flag':null,reason,raw});
  if(raw.state==='json_null')return cell('missing',null,'raw_value_missing');
  if(raw.state==='oversize')return cell('unsupported',null,'raw_value_oversize');
  if(raw.state!=='scalar'||raw.json_type!=='boolean'||!['true','false'].includes(raw.value_text))return cell('invalid',null,'raw_value_type_invalid');
  return cell('observed',raw.value_text==='true',null);
}
/** Pure one-original date-neutral DATA only. Never grants source rights,
 * extends a previously issued seven-layer graph, classifies improvement types,
 * sums a garage area or changes a property/report. Existing profiles stay fixed. */
export function compileNeighborhoodFrozenTypedCadImprovementV1(value){
  if(arguments.length!==1)fail('invalid_input');const i=inputOf(value);
  if(!['primary','secondary'].includes(i.kind)||typeof i.row_key!=='string'||!i.row_key||i.row_key.length>256||Buffer.byteLength(i.row_key)>256
    ||typeof i.payload_text!=='string'||i.payload_text.length>L.original_utf8_bytes||Buffer.byteLength(i.payload_text)>L.original_utf8_bytes)fail('invalid_input');
  let payload,index;try{index=scanOriginalJsonText(i.payload_text,'index').index;payload=JSON.parse(i.payload_text);}catch{fail('invalid_original');}
  if(index.nodes[0].kind!=='object')fail('invalid_original');
  const tokens=new Map(index.nodes[0].members.map(m=>[m.key,index.nodes[m.value]])),keys=KEYS[i.kind];
  if(tokens.size!==keys.length||!keys.every(k=>tokens.has(k)))fail('original_shape_mismatch');
  const account=payload.account_id;
  if(typeof account!=='string'||!account||!account.isWellFormed()||Buffer.byteLength(account)>64||account!==account.trim()
    ||/[\u0000-\u001f\u007f]/.test(account))fail('identity_mismatch');
  if(i.kind==='primary'?i.row_key!==account:typeof payload.id!=='string'||payload.id!==i.row_key
    ||!(/^[1-9][0-9]{0,18}$/).test(payload.id)||BigInt(payload.id)>9223372036854775807n)fail('identity_mismatch');
  const raw=field=>rawLiteral(payload,tokens.get(field),i.payload_text,field);
  const observations=Object.fromEntries(Object.entries(FIELDS[i.kind]).map(([name,[field,policy,unit]])=>[name,numeric(raw(field),policy,unit)]));
  if(i.kind==='primary')observations.reported_pool_flag=boolean(raw('pool'));
  const result={typed_CAD_improvement_version:1,interpretation_profile_ref:PROFILE.profile_ref,
    temporal_basis:'date_neutral_original_syntax',original:{kind:i.kind,row_key:i.row_key,
      original_profile_ref:SOURCE.profile_ref,payload_sha256:sha(i.payload_text),payload_utf8_bytes:Buffer.byteLength(i.payload_text)},
    account_id:account,observations,markers:i.kind==='secondary'?{sec_imp_type:raw('sec_imp_type')}:{},
    authority:'not_established',coverage:'one_original_only',source_freshness:'not_established'};
  if(Buffer.byteLength(canonicalAssessmentJson(result))>L.output_utf8_bytes)fail('output_limit');return freeze(result);
}
