import { isProxy } from 'node:util/types';
import { LABELS, ALTERNATIVES, UNKNOWN, CUSTOM_COHORT_RECORDED_HOUSING_LIMITS }
  from './customCohortRecordedHousingProfiles.js';

const fail=()=>{throw new TypeError('custom_cohort_retained_subject_housing_invalid_material');};
function get(value,key){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const d=Object.getOwnPropertyDescriptor(value,key);
  if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();return d.value;
}
const category=value=>Object.hasOwn(LABELS,value)?LABELS[value]:null;
const result=(state,origin,category=null)=>Object.freeze({state,category:state==='observed'?category:null,origin});

/** Subject precedence DATA only. The caller must reload the actual retained
 * subject and compare current material under current assignment/draft rights.
 * null means ONLY absent: it requests a separately original-reconciled subject
 * CAD fallback, never a default, source grant, eligibility or inferred category.
 * Matches the retained precedence of the existing dense presentation; it does
 * not require that presentation's dense roster or manufacture its authority.
 */
export function resolveCustomCohortRetainedSubjectHousing(material,target,{check=()=>{}}={}){
  if(typeof check!=='function')fail();check();
  if(get(material,'material_input_version')!==1||get(material,'workflow_type')!=='custom_appraisal'
    ||get(material,'profile_id')!=='custom-neighborhood-physical-stock-inputs-v1'||get(material,'profile_revision')!=='1'
    ||!['account_id','assignment_file_id','report_file_id'].every(k=>get(material,k)===get(target,k)))fail();
  function cell(fields,key){
    const c=get(fields,key),state=get(c,'state'),raw=get(c,'value');
    if(!['absent','json_null','present'].includes(state)||(state==='present'?typeof raw!=='string':raw!==null))fail();
    if(state==='present'&&(!raw.isWellFormed()||Buffer.byteLength(raw)>CUSTOM_COHORT_RECORDED_HOUSING_LIMITS.subject_literal_utf8_bytes))fail();
    check();return {state,value:state==='present'?/[\u0000-\u001f\u007f]/.test(raw)?raw:raw.trim().toUpperCase():''};
  }
  function node(value,origin){
    const state=get(value,'state');if(!['absent','json_null','present'].includes(state))fail();
    if(state==='absent')return null;if(state==='json_null')return result('missing',origin);
    const fields=get(value,'value'),type=cell(fields,'housing_type'),style=cell(fields,'structural_style'),attachment=cell(fields,'attachment_type'),
      primary=type.state==='absent'?style:type;
    if(primary.state==='absent'&&attachment.state==='absent')return null;
    if(primary.state==='json_null'||primary.state==='present'&&!primary.value)return result('missing',origin);
    if(UNKNOWN.includes(primary.value))return result('unknown',origin);
    const primaryCategory=category(primary.value),paired=['SINGLE FAMILY','SINGLE FAMILY RESIDENCE'].includes(primary.value)
      &&attachment.value==='DETACHED'?'detached_single_family':null;
    if(!primaryCategory&&!paired)return result('unknown',origin);
    const categories=new Set([primaryCategory??paired]),secondary=type.state==='absent'?null:category(style.value);
    if(secondary)categories.add(secondary);
    const mixed=[type.value,style.value,attachment.value].some(v=>ALTERNATIVES.includes(v)),
      conflict=categories.has('detached_single_family')&&attachment.value==='ATTACHED'
        ||categories.has('townhouse')&&attachment.value==='DETACHED';
    return categories.size>1||conflict?result('conflicting',origin):mixed?result('unknown',origin)
      :result('observed',origin,[...categories][0]);
  }
  const characteristics=get(get(material,'assignment_sections'),'property_characteristics'),storage=get(characteristics,'storage_state');
  if(!['absent','object'].includes(storage))fail();
  const saved=storage==='absent'?null:node(get(get(characteristics,'projection'),'housing_profile'),'saved_subject');
  const resolved=saved??node(get(get(material,'retained_public'),'housing_profile'),'retained_subject_public');
  check();return resolved;
}
