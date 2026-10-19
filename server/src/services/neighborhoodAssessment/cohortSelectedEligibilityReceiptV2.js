import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES as CATEGORIES,
  CUSTOM_COHORT_RECORDED_HOUSING_STATES as STATES } from './customCohortRecordedHousingProfiles.js';

export const SELECTED_RECORDED_ELIGIBILITY_METRICS=Object.freeze(['reported_year_built','reported_residential_area','reported_site_area']);
const fail=()=>{throw new TypeError('cohort_selected_eligibility_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;}
function integer(v,max=2000000){if(!Number.isInteger(v)||v<0||v>max)fail();return v;}
function state(v,max){const s=data(v,['selected_ordinal','done']);integer(s.selected_ordinal,max);if(typeof s.done!=='boolean')fail();return Object.freeze(s);}
function counts(v,ordinal){const c=data(v,SELECTED_RECORDED_ELIGIBILITY_METRICS);Object.values(c).forEach(n=>integer(n,ordinal));return Object.freeze(c);}
/** Closed transition DATA, NEVER original/source/selection/statistics authority.
 * The actual bounded DB owner must independently reopen EVERY original/ENTIRE
 * cache/full partition/catalog and current/end rights for each native ordinal.
 * Only three recorded-comparison bits/counts are retained, no value copies.
 * Currency, economic units, historical housing and complete eligibility remain
 * unestablished; every later semantic consumer must reopen originals again. */
export function prepareCohortSelectedEligibilityReceiptV2(raw,expected){
  const e=data(expected,['union_reference','command_id','selected_stock_count']),r=data(raw,
    ['format',...Object.keys(e),'subject_housing','sequence','previous','before','after','selected_entry','eligible','before_counts','after_counts']);
  if(r.format!=='cohort_selected_recorded_eligibility_receipt_v2'
    ||typeof r.command_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.command_id)
    ||r.command_id!==e.command_id||r.selected_stock_count!==integer(e.selected_stock_count)
    ||!same(ref(r.union_reference),ref(e.union_reference)))fail();
  const subject=data(r.subject_housing,['state','category']);
  if(!STATES.includes(subject.state)||(subject.state==='observed'?!CATEGORIES.includes(subject.category):subject.category!==null))fail();
  const before=state(r.before,e.selected_stock_count),after=state(r.after,e.selected_stock_count),
    a=counts(r.before_counts,before.selected_ordinal),b=counts(r.after_counts,after.selected_ordinal);
  if(before.done||r.sequence!==before.selected_ordinal+1||integer(r.sequence,2000001)<1
    ||r.sequence===1&&(r.previous!==null||before.selected_ordinal!==0||Object.values(a).some(n=>n!==0))
    ||r.sequence!==1&&r.previous===null)fail();
  const previous=r.previous===null?null:ref(r.previous);let entry=null,eligible=null;
  if(after.done){
    if(after.selected_ordinal!==before.selected_ordinal||after.selected_ordinal!==e.selected_stock_count
      ||r.selected_entry!==null||r.eligible!==null||!same(a,b))fail();
  }else{
    if(after.selected_ordinal!==before.selected_ordinal+1)fail();
    entry=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']);
    if(typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
      ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
      ||entry.ordinal!==after.selected_ordinal||integer(entry.partition_ordinal)<1)fail();
    entry=Object.freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)});
    eligible=data(r.eligible,SELECTED_RECORDED_ELIGIBILITY_METRICS);
    for(const k of SELECTED_RECORDED_ELIGIBILITY_METRICS)if(typeof eligible[k]!=='boolean'||b[k]!==a[k]+Number(eligible[k])
      ||subject.state!=='observed'&&eligible[k])fail();
    Object.freeze(eligible);
  }
  const result=Object.freeze({...r,union_reference:ref(r.union_reference),subject_housing:Object.freeze(subject),previous,
    before,after,selected_entry:entry,eligible,before_counts:a,after_counts:b});
  if(Buffer.byteLength(json(result))>16000)fail();return result;
}
