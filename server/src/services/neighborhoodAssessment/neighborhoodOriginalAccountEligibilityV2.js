import { isProxy } from 'node:util/types';
import { CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES as CATEGORIES,
  CUSTOM_COHORT_RECORDED_HOUSING_STATES as STATES } from './customCohortRecordedHousingProfiles.js';

const METRICS={reported_year_built:'year',reported_residential_area:'reported_sqft',
  reported_site_area:'reported_sqft',reported_market_value:null};
const fail=()=>{throw new TypeError('neighborhood_original_account_eligibility_v2_invalid_input');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function count(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,2})$/.test(v)||Number(v)>250)fail();return Number(v);}
function category(state,value){if(!STATES.includes(state)||(state==='observed'?!CATEGORIES.includes(value):value!==null))fail();}
function exact(value){
  if(typeof value!=='string'||value.length>31||! /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value)
    ||value.replace('.','').length>30||(value.split('.')[1]?.length??0)>12)fail();
  return value;
}
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};

/** One bounded account's decision DATA, NOT original/selection authority.
 * The actual owner must reconcile EVERY original and ENTIRE cache, exact
 * partition/catalog/intent and native membership under all current/end fences.
 * No callbacks, source capabilities, defaults, medians or population arrays.
 * Matching recorded housing and complete equal reported values do NOT verify
 * an economic unit, GLA, currency, historical housing or report eligibility.
 */
export function resolveNeighborhoodOriginalAccountEligibilityV2(...args){
  if(args.length!==1)fail();const [raw]=args;
  const input=data(raw,['subject','housing','original_counts','observations']),
    subject=data(input.subject,['state','category']),
    housing=data(input.housing,['state','category','county_state','source_part_count','part_states']),
    originals=data(input.original_counts,['parcels','accounts']);
  category(subject.state,subject.category);category(housing.state,housing.category);
  if(!Number.isInteger(originals.parcels)||originals.parcels<1||!Number.isInteger(originals.accounts)
    ||originals.accounts<0||originals.accounts>1||originals.parcels+originals.accounts>250
    ||count(housing.source_part_count)!==originals.parcels||!['observed','missing','unknown'].includes(housing.county_state))fail();
  const partStates=data(housing.part_states,STATES),parts=Object.fromEntries(STATES.map(k=>[k,count(partStates[k])]));
  if(Object.values(parts).reduce((a,b)=>a+b,0)!==originals.parcels
    ||housing.state==='observed'&&(parts.observed!==originals.parcels||housing.county_state!=='observed'||originals.accounts!==1))fail();
  const reasons=[];
  if(subject.state!=='observed')reasons.push(`subject_housing_${subject.state}`);
  if(housing.state!=='observed')reasons.push(`account_housing_${housing.state}`);
  const known=subject.state==='observed'&&housing.state==='observed',matches=known&&subject.category===housing.category;
  if(known&&!matches)reasons.push('different_recorded_housing_category');
  const observations=data(input.observations,Object.keys(METRICS)),metrics={};
  for(const [metric,unit] of Object.entries(METRICS)){
    const cell=data(observations[metric],['state','exact_value','unit','source_part_count','observed_part_count',
      'missing_part_count','invalid_part_count','unsupported_part_count','conflict_values']),
      counts=Object.fromEntries(['observed','missing','invalid','unsupported'].map(k=>[k,count(cell[`${k}_part_count`])])),
      total=count(cell.source_part_count);
    if(total!==originals.parcels||Object.values(counts).reduce((a,b)=>a+b,0)!==total
      ||!['observed','missing','invalid','unsupported','conflicting'].includes(cell.state)
      ||cell.state==='observed'&&(unit===null||cell.unit!==unit||counts.observed===0)
      ||cell.state!=='observed'&&cell.unit!==null)fail();
    if(cell.exact_value!==null)exact(cell.exact_value);
    if(cell.state==='observed'?cell.exact_value===null:cell.state!=='unsupported'&&cell.exact_value!==null)fail();
    if(cell.state==='missing'&&counts.missing!==total||cell.state==='invalid'&&(counts.invalid===0||counts.observed||counts.unsupported)
      ||cell.state==='unsupported'&&(counts.unsupported===0||counts.observed))fail();
    const conflicts=cell.conflict_values;
    if(isProxy(conflicts)||!Array.isArray(conflicts)||Object.getPrototypeOf(conflicts)!==Array.prototype
      ||conflicts.length!==(cell.state==='conflicting'?2:0))fail();
    for(let i=0;i<conflicts.length;i++){
      const d=Object.getOwnPropertyDescriptor(conflicts,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();exact(d.value);
    }
    const complete=counts.observed===total&&cell.state==='observed'&&unit!==null,metricReasons=[];
    if(cell.state!=='observed')metricReasons.push(`recorded_value_${cell.state}`);
    for(const state of ['missing','invalid','unsupported'])if(counts[state])metricReasons.push(`${state}_parts`);
    if(unit===null)metricReasons.push('currency_not_established');
    const zero=cell.exact_value==='0';
    if(complete&&(metric==='reported_residential_area'&&zero||metric==='reported_year_built'
      &&(!/^[1-9][0-9]{3}$/.test(cell.exact_value)||Number(cell.exact_value)<1600)))fail();
    metrics[metric]={recorded_comparison_eligible:matches&&complete,complete_observed_parts:complete,
      exact_value:complete?cell.exact_value:null,unit:complete?unit:null,
      reasons:[...reasons,...metricReasons],source_part_count:total,part_counts:counts};
  }
  return frozen({format:'neighborhood_original_account_recorded_eligibility_v2',
    housing:{matches_subject:matches,state:known?matches?'matching':'different':'unresolved',reasons},metrics,
    basis:'retained_current_recorded_housing_and_reported_values_not_verified_or_historical',
    authority:'not_established',coverage:'one_original_reconciled_account_decision_only',
    complete_selected_union_eligibility:false,issued_eligibility_progress:false,
    economic_unit:'not_established',statistics:'not_established',publication:'not_established',report_update:'none'});
}
