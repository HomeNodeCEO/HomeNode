import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES as CATEGORIES,
  CUSTOM_COHORT_RECORDED_HOUSING_STATES as STATES } from './customCohortRecordedHousingProfiles.js';

export const SELECTED_REPORTED_METRIC_ROW_V2_BASIS='current_retained_reported_comparison_not_verified_GLA_currency_historical_housing_or_economic_transaction';
export const SELECTED_REPORTED_METRIC_ROW_V2_MAX_BYTES=4096;
const UNITS=Object.freeze({reported_year_built:'year',reported_residential_area:'reported_sqft',
  reported_site_area:'reported_sqft',reported_market_value:null});
const KEYS=['command_id','union_reference','eligibility_reference','evidence_reference','selected_entry',
  'effective_date','observation_period','subject_housing','housing_comparison'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('cohort_selected_metric_row_v2_invalid_row');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']);let p;
  try{p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);}catch{fail();}
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;
}
function date(v){try{return assessmentDate(v);}catch{fail();}}
function metadata(raw){
  const m=data(raw,KEYS),entry=data(m.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']),
    subject=data(m.subject_housing,['state','category']),period=data(m.observation_period,['start_date','end_date']);
  if(typeof m.command_id!=='string'||!UUID.test(m.command_id)
    ||typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
    ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
    ||![entry.ordinal,entry.partition_ordinal].every(n=>Number.isInteger(n)&&n>=1&&n<=2000000)
    ||!STATES.includes(subject.state)||(subject.state==='observed'?!CATEGORIES.includes(subject.category):subject.category!==null)
    ||!['matching','different','unresolved'].includes(m.housing_comparison)
    ||m.housing_comparison!=='unresolved'&&subject.state!=='observed')fail();
  const observation_period={start_date:date(period.start_date),end_date:date(period.end_date)};
  if(observation_period.start_date>observation_period.end_date)fail();
  return {...m,union_reference:ref(m.union_reference),eligibility_reference:ref(m.eligibility_reference),
    evidence_reference:ref(m.evidence_reference),selected_entry:Object.freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)}),
    effective_date:date(m.effective_date),observation_period:Object.freeze(observation_period),subject_housing:Object.freeze(subject)};
}
/** Closed bounded row DATA only. This authenticates NO original, native member,
 * selection, rights, dates or population. The actual owner must build it from
 * THIS call's complete original/ENTIRE-cache replay and exact native parents,
 * then pass ALL ending fences before returning or retaining it. A caller row,
 * reference, hash or ACK must NEVER substitute for that owner. There is no
 * durable metric head, new checkpoint grammar, aggregate or publication here.
 * Market currency stays unsupported; absent/incomplete values never become0.
 */
export function prepareCohortSelectedMetricRowV2(...args){
  if(args.length!==2)fail();const r=data(args[0],['format',...KEYS,'metrics','basis']),e=metadata(args[1]),
    m=metadata(Object.fromEntries(KEYS.map(k=>[k,r[k]])));
  if(r.format!=='cohort_selected_reported_metric_row_v2'||r.basis!==SELECTED_REPORTED_METRIC_ROW_V2_BASIS||json(m)!==json(e))fail();
  const cells=data(r.metrics,Object.keys(UNITS)),metrics={};
  for(const [key,unit] of Object.entries(UNITS)){
    const c=data(cells[key],['recorded_comparison_eligible','complete_observed_parts','exact_value','unit']);
    if(typeof c.recorded_comparison_eligible!=='boolean'||typeof c.complete_observed_parts!=='boolean'
      ||c.recorded_comparison_eligible!==(m.housing_comparison==='matching'&&c.complete_observed_parts))fail();
    if(!c.complete_observed_parts){if(c.exact_value!==null||c.unit!==null)fail();}
    else{
      if(unit===null||c.unit!==unit||typeof c.exact_value!=='string'||c.exact_value.length>31
        ||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(c.exact_value)
        ||c.exact_value.replace('.','').length>30||(c.exact_value.split('.')[1]?.length??0)>12
        ||key==='reported_residential_area'&&c.exact_value==='0'
        ||key==='reported_year_built'&&(!/^[1-9][0-9]{3}$/.test(c.exact_value)
          ||Number(c.exact_value)<1600||Number(c.exact_value)>Number(m.effective_date.slice(0,4))))fail();
    }
    metrics[key]=Object.freeze(c);
  }
  const row=Object.freeze({format:r.format,...m,metrics:Object.freeze(metrics),basis:r.basis});
  if(Buffer.byteLength(json(row))>SELECTED_REPORTED_METRIC_ROW_V2_MAX_BYTES)fail();return row;
}
