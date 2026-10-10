import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { CACHED_SALE_WITNESS_V2_FIELDS } from './cachedSaleWitnessV2.js';
import { interpretCustomCohortDateNeutralReportedSaleWitnessV1 } from './customCohortReportedSaleWitnessV2.js';

const PROFILE=getNeighborhoodFrozenTypedOriginalV2Profile(),DEFINITION=JSON.parse(PROFILE.definition_blob.canonical_json);
export const NEIGHBORHOOD_TYPED_TRANSACTION_V2_KINDS=Object.freeze(['source_records','sales','sale_links']);
const HASH=/^[a-f0-9]{64}$/,JSON_NUMBER=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
/** Refuse a fixed validation reason without exposing retained source values. */
const fail=r=>{throw new TypeError(`neighborhood_typed_transaction_v2_${r}`);};
/** Compare closed DATA structurally using the common canonical encoding. */
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
/** Freeze the validated owned snapshot, not a caller's mutable object graph. */
const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
/** Snapshot exactly the expected enumerable own data properties; never invoke accessors. */
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_data');
  const d=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(d);
  if(names.length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_data');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
/** Bound and snapshot the diagnostic graph before any retained values are interpreted. */
function seal(value){
  let nodes=0,bytes=0;
  /** Visit only supported finite scalars and plain objects within fixed depth/byte limits. */
  const visit=(v,depth)=>{
    if(++nodes>4000||depth>16)fail('input_limit');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){bytes+=Buffer.byteLength(v);if(bytes>262144||!v.isWellFormed())fail('input_limit');return v;}
    if(typeof v==='number'){if(!Number.isFinite(v))fail('invalid_data');return v;}
    if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_data');
    const d=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(d);
    if(keys.some(k=>typeof k!=='string'||!d[k].enumerable||!Object.hasOwn(d[k],'value')))fail('invalid_data');
    return Object.fromEntries(keys.map(k=>[k,visit(d[k].value,depth+1)]));
  };
  return visit(value,0);
}
/** Retain a positive native BIGINT identity as exact text, without Number conversion. */
function nativeId(v){if(typeof v!=='string'||!/^[1-9][0-9]{0,18}$/.test(v)||BigInt(v)>9223372036854775807n)fail('invalid_identity');return v;}
/** Admit only a bounded exact account identity or an explicit missing account. */
function account(v){if(v===null)return v;
  if(typeof v!=='string'||!v||!v.isWellFormed()||Buffer.byteLength(v)>64||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail('invalid_identity');return v;}
/** Reconcile diagnostic state, JSON type, literal bytes and hash before cell replay. */
function raw(value){
  const r=data(value,['state','json_type','value_text','utf8_bytes','value_sha256']);
  if(['absent','json_null'].includes(r.state)){
    if(r.json_type!==(r.state==='absent'?null:'null')||r.value_text!==null||r.utf8_bytes!==0||r.value_sha256!==null)fail('invalid_raw');
    return r;
  }
  const scalar=['string','number','boolean'].includes(r.json_type);
  if(!['scalar','oversize','non_scalar'].includes(r.state)||!Number.isInteger(r.utf8_bytes)||r.utf8_bytes<0||r.utf8_bytes>1000000
    ||!HASH.test(r.value_sha256??'')||(r.state==='non_scalar'?!['array','object'].includes(r.json_type):!scalar)
    ||r.state==='scalar'&&(r.value_text===null||r.utf8_bytes>128)
    ||r.state==='oversize'&&(r.value_text!==null||r.utf8_bytes<=128||r.json_type==='boolean')
    ||r.state==='non_scalar'&&(r.value_text===null)!==(r.utf8_bytes>128))fail('invalid_raw');
  if(r.value_text!==null){
    if(typeof r.value_text!=='string'||!r.value_text.isWellFormed()||Buffer.byteLength(r.value_text)!==r.utf8_bytes
      ||createHash('sha256').update(r.value_text,'utf8').digest('hex')!==r.value_sha256)fail('invalid_raw');
    if(r.json_type==='number'&&!JSON_NUMBER.test(r.value_text)||r.json_type==='boolean'&&!['true','false'].includes(r.value_text))fail('invalid_raw');
    if(r.state==='non_scalar'){
      let v;try{v=JSON.parse(r.value_text);}catch{fail('invalid_raw');}
      if(r.json_type==='array'?!Array.isArray(v):!v||typeof v!=='object'||Array.isArray(v))fail('invalid_raw');
    }
  }
  return r;
}
/** Recognize missing syntax without coercing false, zero or unsupported observations. */
const missing=r=>['absent','json_null'].includes(r.state)||r.state==='scalar'&&r.json_type==='string'&&!r.value_text.trim();
/** Replay the installed exact-decimal syntax policy without economic Number conversion. */
function numeric(r,[,policy,unit,encoding]){
  /** Build one closed numeric state; unsupported units never become observed units. */
  const cell=(state,exact_value,reason)=>({state,exact_value,unit:state==='observed'?unit:null,reason});
  if(missing(r))return cell('missing',null,`raw_value_${r.state==='scalar'?'blank':r.state}`);
  if(r.state==='oversize')return cell('unsupported',null,'raw_value_oversize');
  if(r.state!=='scalar'||r.json_type!==(encoding==='text'?'string':'number'))return cell('invalid',null,'raw_value_type_invalid');
  const token=r.value_text.trim();let exact=null;
  if(token.length<=128&&/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)){
    let [whole,fraction='']=token.replace(/^\+/,'').split('.');whole=whole.replace(/^0+/,'')||'0';fraction=fraction.replace(/0+$/,'');
    if(whole.length+fraction.length<=30&&fraction.length<=12&&!(policy==='positive'&&whole==='0'&&!fraction)
      &&!(['integer','year'].includes(policy)&&(fraction||BigInt(whole)>2147483647n))
      &&!(policy==='year'&&(BigInt(whole)<1600n||BigInt(whole)>9999n)))exact=whole+(fraction?`.${fraction}`:'');
  }
  return exact===null?cell('invalid',null,'raw_value_invalid'):unit===null?cell('unsupported',exact,'unit_not_established'):cell('observed',exact,null);
}
/** Replay date-neutral calendar syntax only; retained-period admission happens later. */
function calendar(r){
  /** Preserve distinct missing, invalid, unsupported and observed calendar states. */
  const cell=(state,exact_value,reason)=>({state,exact_value,reason});
  if(missing(r))return cell('missing',null,'missing_date');
  if(r.state==='oversize')return cell('unsupported',null,'unsupported_date');
  const token=r.state==='scalar'&&r.json_type==='string'?r.value_text.trim():'';
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(token)||token.startsWith('0000'))return cell('invalid',null,'invalid_date');
  try{assessmentDate(token);}catch{return cell('invalid',null,'invalid_date');}
  return cell('observed',token,null);
}
/** Reproduce the pinned same-payload interpreter from its exact consumed diagnostics. */
function witnessed(value){
  const w=data(value,['interpretation_profile_ref','observation_basis','observations','record_type','close_date','diagnostics']);
  const d=data(w.diagnostics,['root_state','root_json_type','raw_fields','status_interpretations']);
  // Replay only the fixed diagnostic fields consumed by the pinned interpreter.
  // Unused placeholders are private validation machinery, never source facts,
  // emitted witness fields, originals or a claim that absent values were read.
  const fields=Object.fromEntries(CACHED_SALE_WITNESS_V2_FIELDS.map(k=>[k,d.root_state==='object'
    ?{state:'absent',json_type:null,value_text:null,utf8_bytes:null}
    :{state:'payload_unavailable',json_type:null,value_text:null,utf8_bytes:null}]));
  const definitions=JSON.parse(DEFINITION.reported_sale_witness.exact_definition_blob.canonical_json);
  const keys=[...new Set([...Object.values(definitions.fields).flatMap(f=>[f.value_field,f.unit_field]).filter(Boolean),
    ...definitions.units.generic_currency_fields,'MlsStatus','StandardStatus','CloseDate'])];
  const retained=data(d.raw_fields,keys);
  for(const k of keys)fields[k]=retained[k];
  let expected;try{expected=interpretCustomCohortDateNeutralReportedSaleWitnessV1({witness_version:2,
    root_state:d.root_state,root_json_type:d.root_json_type,fields});}catch{fail('invalid_witness');}
  if(!same(w,expected))fail('invalid_witness');return expected;
}

/** Reconcile one cached neutral transaction original from bounded diagnostics.
 * No original payload read, caller profile/date, cross-source fallback, provider
 * dictionary, transaction eligibility, selection or complete-population claim.
 * Cache/issued-head/current-rights admission remains the actual owner's duty. */
export function prepareNeighborhoodTypedTransactionV2(value){
  const r=data(seal(value),['kind','row_key','account_id','source_record_id','original_payload_sha256','typed']);
  if(!NEIGHBORHOOD_TYPED_TRANSACTION_V2_KINDS.includes(r.kind))fail('invalid_kind');
  nativeId(r.row_key);account(r.account_id);if(r.source_record_id!==null)nativeId(r.source_record_id);
  if(!HASH.test(r.original_payload_sha256??'')||r.kind==='source_records'&&r.source_record_id!==r.row_key
    ||r.kind==='sale_links'&&r.source_record_id===null)fail('invalid_identity');
  const t=data(r.typed,['typed_original_version','interpretation_profile_ref','temporal_basis','original','account_id','source_record_id',
    'observations','dates','markers','same_payload_reported_sale','authority','coverage','source_freshness']);
  const o=data(t.original,['kind','row_key','payload_sha256','payload_utf8_bytes']);
  if(t.typed_original_version!==2||!same(t.interpretation_profile_ref,PROFILE.profile_ref)||t.temporal_basis!=='date_neutral_original_syntax'
    ||o.kind!==r.kind||o.row_key!==r.row_key||o.payload_sha256!==r.original_payload_sha256
    ||!Number.isInteger(o.payload_utf8_bytes)||o.payload_utf8_bytes<1||o.payload_utf8_bytes>1000000
    ||t.account_id!==r.account_id||t.source_record_id!==r.source_record_id||t.authority!=='not_established'
    ||t.coverage!=='one_original_only'||t.source_freshness!=='not_established')fail('invalid_typed_row');
  const fields=DEFINITION.fields[r.kind]??{},observations=data(t.observations,Object.keys(fields));
  for(const [k,v] of Object.entries(observations)){
    const c=data(v,['state','exact_value','unit','reason','raw']),literal=raw(c.raw);
    if(!same({state:c.state,exact_value:c.exact_value,unit:c.unit,reason:c.reason},numeric(literal,fields[k])))fail('invalid_cell');
  }
  const dates=data(t.dates,DEFINITION.date_fields[r.kind]??[]);
  for(const v of Object.values(dates)){
    const c=data(v,['state','exact_value','reason','raw']),literal=raw(c.raw);
    if(!same({state:c.state,exact_value:c.exact_value,reason:c.reason},calendar(literal)))fail('invalid_cell');
  }
  const markers=data(t.markers,DEFINITION.markers[r.kind]);Object.values(markers).forEach(raw);
  if(r.kind==='source_records')witnessed(t.same_payload_reported_sale);else if(t.same_payload_reported_sale!==null)fail('invalid_witness');
  if(Buffer.byteLength(canonicalAssessmentJson(t))>65536)fail('row_limit');
  return freeze({...r,typed:{...t,original:o,observations,dates,markers}});
}
