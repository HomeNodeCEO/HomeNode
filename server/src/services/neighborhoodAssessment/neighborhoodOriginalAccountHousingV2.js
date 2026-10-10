import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';
import { LEGACY,CAD_DESCRIPTIONS,LABELS,ALTERNATIVES,CUSTOM_COHORT_RECORDED_HOUSING_STATES,
  getCustomCohortRecordedHousingInterpretation } from './customCohortRecordedHousingProfiles.js';

const HOUSING=getCustomCohortRecordedHousingInterpretation(5,2),STATES=CUSTOM_COHORT_RECORDED_HOUSING_STATES;
/** Refuse without exposing retained private literals. */
const fail=r=>{throw new TypeError(`neighborhood_original_account_housing_v2_${r}`);};
/** Freeze only detached owned DATA, not an authorization capability. */
function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** Inspect an own DATA property without invoking hostile getters or proxies. */
function own(v,k){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptor(v,k);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('invalid_input');return d.value;}
const definition=freeze({id:'neighborhood-original-account-recorded-housing-v2',revision:'1',
  retained_interpretation:HOUSING,limit_original_rows:250,
  population:'one_server_chosen_complete_stock_account_including_all_outside_geometry_parcel_parts',
  prerequisites:'actual_owner_replays_every_original_and_entire_neutral_cache_before_this_DATA_resolution',
  county:'one_original_account_DALLAS_or_DALLAS_COUNTY_only_no_missing_county_fabrication',
  normalization:'whole_string_trim_and_case_only_no_substring_numeric_class_quality_or_one_unit_inference',
  incomplete_literal:'nontext_oversize_or_control_marker_keeps_parcel_unknown_not_borrowed_from_other_fields',
  aggregation:'all_parcels_known_plus_unresolved_partial_recognized_conflicts_never_majority_first_or_area_sum',
  states:STATES,basis:'retained_current_recorded_housing_not_verified_or_historical_housing',
  authority:'not_established',limitations:['not_subject_housing_precedence_or_cross_source_merge',
    'not_current_CAD_amenity_garage_dictionary','not_eligibility_selected_union_source_grant_statistics_publication_or_report_update']});
const text=canonicalAssessmentJson(definition),ref=prepareNeighborhoodCohortBlob(text);
const PROFILE=freeze({profile_ref:{id:definition.id,revision:'1',content_sha256:ref.content_sha256},definition_blob:{ref,canonical_json:text}});
/** Fixed definition; the caller cannot choose or upgrade an interpretation. */
export function getNeighborhoodOriginalAccountHousingV2Profile(){return PROFILE;}

/** Read only a bounded compiler literal, never a numeric/code alias. */
function literal(markers,field){const c=own(markers,field),state=own(c,'state');
  if(['absent','json_null'].includes(state))return {value:'',unavailable:false};
  if(state!=='scalar'||own(c,'json_type')!=='string')return {value:'',unavailable:true};
  const value=own(c,'value_text');if(typeof value!=='string'||Buffer.byteLength(value)>128
    ||!value.isWellFormed()||/[\u0000-\u001f\u007f]/.test(value))return {value:'',unavailable:true};
  return {value:value.trim().toUpperCase(),unavailable:false};}
const category=(dictionary,key)=>Object.hasOwn(dictionary,key)?dictionary[key]:null;
const resolution=(state,category=null)=>({state,category:state==='observed'?category:null});

/** Bounded DATA only, called AFTER the actual owner has recompiled every
 * complete-account original and matched its entire neutral cache. This helper
 * authenticates no originals, county, population, source rights or selection.
 * It preserves every parcel reason and never mutates neutral bytes or reports. */
export function resolveNeighborhoodOriginalAccountHousingV2(rows,check){
  if(!Array.isArray(rows)||isProxy(rows)||Object.getPrototypeOf(rows)!==Array.prototype||rows.length>250
    ||typeof check!=='function')fail('invalid_input');check();
  const parts=[],accounts=[];let accountId=null;
  for(let i=0;i<rows.length;i++){const d=Object.getOwnPropertyDescriptor(rows,String(i));
    if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('invalid_input');
    const row=d.value,kind=own(row,'kind'),id=own(row,'account_id'),key=own(row,'row_key');
    if(!['parcels','accounts'].includes(kind)||typeof id!=='string'||!id||typeof key!=='string'||!key
      ||accountId!==null&&id!==accountId)fail('invalid_input');accountId=id;
    const markers=own(own(row,'typed'),'markers');
    if(kind==='accounts')accounts.push(literal(markers,'county'));
    else{
      const fields=['class_code','class_description','use_description','structure_type'].map(k=>literal(markers,k));
      const values=fields.map(c=>c.value),categories=new Set(),code=category(LEGACY,values[0]);if(code)categories.add(code);
      for(const value of values.slice(1)){const found=category(LABELS,value)??category(CAD_DESCRIPTIONS,value);if(found)categories.add(found);}
      const result=categories.size>1?resolution('conflicting'):fields.some(c=>c.unavailable)?resolution('unknown')
        :values.some(v=>ALTERNATIVES.includes(v))?resolution('unknown')
        :categories.size===1?resolution('observed',[...categories][0]):resolution(values.some(Boolean)?'unknown':'missing');
      parts.push({row_key:key,...result});
    }check();
  }
  if(accounts.length>1||!parts.length)fail('incomplete_account');
  const county=accounts[0]??null,countyState=!county||county.unavailable?'unknown':!county.value?'missing'
    :['DALLAS','DALLAS COUNTY'].includes(county.value)?'observed':'unknown';
  const counts=Object.fromEntries(STATES.map(s=>[s,'0'])),categories=new Set();
  for(const part of parts){check();if(countyState!=='observed')Object.assign(part,resolution('unknown'));
    counts[part.state]=String(Number(counts[part.state])+1);if(part.state==='observed')categories.add(part.category);}
  const state=counts.conflicting!=='0'||categories.size>1?'conflicting':categories.size===1?
    counts.observed===String(parts.length)?'observed':'partial':counts.missing===String(parts.length)?'missing':'unknown';
  check();return freeze({...resolution(state,[...categories][0]??null),profile:PROFILE,
    retained_housing_interpretation:HOUSING.profile_ref,account_id:accountId,county_state:countyState,
    account_original_state:accounts.length?'present':'absent',source_part_count:String(parts.length),part_states:counts,parts,
    basis:definition.basis,authority:'not_established',selected_union:'not_established',report_update:'none'});
}
