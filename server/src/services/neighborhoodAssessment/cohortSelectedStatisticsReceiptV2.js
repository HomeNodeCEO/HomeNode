import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { SELECTED_STATISTICS_CONTRIBUTION_V2_POLICY as POLICY,
  SELECTED_STATISTICS_REPORTED_VALUE_STATES as STATES } from './cohortSelectedStatisticsContributionV2.js';

export const SELECTED_STATISTICS_V2_METRICS=Object.freeze(['reported_year_built','reported_residential_area','reported_site_area','reported_market_value']);
export const SELECTED_STATISTICS_V2_REASONS=Object.freeze([
  'subject_housing_missing','subject_housing_unknown','subject_housing_partial','subject_housing_conflicting',
  'account_housing_missing','account_housing_unknown','account_housing_partial','account_housing_conflicting',
  'different_recorded_housing_category','recorded_value_missing','recorded_value_invalid','recorded_value_conflicting',
  'recorded_value_unsupported','missing_parts','invalid_parts','unsupported_parts','currency_not_established',
]);
const PARTS=['observed','missing','invalid','unsupported'],METRICS=SELECTED_STATISTICS_V2_METRICS,REASONS=SELECTED_STATISTICS_V2_REASONS;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('cohort_selected_statistics_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function integer(n,max=2000000){if(!Number.isSafeInteger(n)||n<0||n>max)fail();return n;}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;}
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function reasons(v){
  if(isProxy(v)||!Array.isArray(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length>REASONS.length
    ||Reflect.ownKeys(v).length!==v.length+1)fail();
  const out=[];
  for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));
    if(!d?.enumerable||!Object.hasOwn(d,'value')||!REASONS.includes(d.value)||out.includes(d.value))fail();out.push(d.value);}
  return out;
}
function counts(raw,ordinal){
  integer(ordinal);const all=data(raw,METRICS),out={};let sourceTotal=null;
  for(const key of METRICS){
    const c=data(all[key],['value_states','complete_observed_count','eligible_count','excluded_count','source_part_counts','exclusion_reason_counts']),
      values=data(c.value_states,STATES),parts=data(c.source_part_counts,PARTS),excluded=data(c.exclusion_reason_counts,REASONS);
    for(const n of Object.values(values))integer(n,ordinal);
    if(Object.values(values).reduce((a,b)=>a+b,0)!==ordinal)fail();
    integer(c.complete_observed_count,values.observed);integer(c.eligible_count,c.complete_observed_count);integer(c.excluded_count,ordinal);
    if(c.eligible_count+c.excluded_count!==ordinal||key==='reported_market_value'&&(c.complete_observed_count||c.eligible_count))fail();
    for(const n of Object.values(parts))integer(n,ordinal*250);
    const total=Object.values(parts).reduce((a,b)=>a+b,0);
    if(total<ordinal||total>ordinal*250||sourceTotal!==null&&sourceTotal!==total)fail();sourceTotal=total;
    for(const n of Object.values(excluded))integer(n,c.excluded_count);
    if(Object.values(excluded).reduce((a,b)=>a+b,0)<c.excluded_count)fail();
    out[key]={...c,value_states:values,source_part_counts:parts,exclusion_reason_counts:excluded};
  }
  return freeze(out);
}
export function emptyCohortSelectedStatisticsCountsV2(...args){
  if(args.length)fail();return counts(Object.fromEntries(METRICS.map(key=>[key,{value_states:Object.fromEntries(STATES.map(k=>[k,0])),
    complete_observed_count:0,eligible_count:0,excluded_count:0,source_part_counts:Object.fromEntries(PARTS.map(k=>[k,0])),
    exclusion_reason_counts:Object.fromEntries(REASONS.map(k=>[k,0]))}])),0);
}
/** Counter DATA ONLY. Neither original-shaped cells nor these counts confer
 * source/selection authority. The actual bounded owner derives cells from its
 * fresh complete original replay, compares the native seventh row, rechecks all
 * ending fences and only THEN atomically retains native eighth progress. */
export function advanceCohortSelectedStatisticsCountsV2(...args){
  if(args.length!==3)fail();const [raw,ordinal,rawMetrics]=args,before=counts(raw,ordinal);
  if(rawMetrics===null)return before;if(ordinal===2000000)fail();
  const cells=data(rawMetrics,METRICS),out={};let total=null;
  for(const key of METRICS){
    const c=data(cells[key],['reported_value_state','complete_observed_parts','recorded_comparison_eligible',
      'contribution_exact_value','contribution_unit','exclusion_reasons','source_part_count','part_counts']),
      parts=data(c.part_counts,PARTS),why=reasons(c.exclusion_reasons);
    if(!STATES.includes(c.reported_value_state)||typeof c.complete_observed_parts!=='boolean'
      ||typeof c.recorded_comparison_eligible!=='boolean'||integer(c.source_part_count,250)<1)fail();
    for(const n of Object.values(parts))integer(n,c.source_part_count);
    if(Object.values(parts).reduce((a,b)=>a+b,0)!==c.source_part_count||total!==null&&total!==c.source_part_count)fail();total=c.source_part_count;
    if(c.complete_observed_parts!==(c.reported_value_state==='observed'&&parts.observed===total&&key!=='reported_market_value')
      ||c.recorded_comparison_eligible&&!c.complete_observed_parts
      ||(c.recorded_comparison_eligible?why.length!==0:why.length===0))fail();
    if(c.reported_value_state==='observed'&&parts.observed===0
      ||c.reported_value_state==='missing'&&parts.missing!==total
      ||c.reported_value_state==='invalid'&&(parts.invalid===0||parts.observed||parts.unsupported)
      ||c.reported_value_state==='unsupported'&&(parts.unsupported===0||parts.observed)
      ||c.reported_value_state==='conflicting'&&parts.observed<2)fail();
    for(const k of STATES.filter(k=>k!=='observed'))if(why.includes(`recorded_value_${k}`)!==(c.reported_value_state===k))fail();
    for(const k of PARTS.filter(k=>k!=='observed'))if(why.includes(`${k}_parts`)!==(parts[k]>0))fail();
    if(why.includes('currency_not_established')!==(key==='reported_market_value'))fail();
    if(c.recorded_comparison_eligible){
      const v=c.contribution_exact_value;
      if(typeof v!=='string'||v.length>31||! /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(v)
        ||v.replace('.','').length>30||(v.split('.')[1]?.length??0)>12
        ||c.contribution_unit!==(key==='reported_year_built'?'year':'reported_sqft')
        ||key==='reported_year_built'&&(!/^[1-9][0-9]{3}$/.test(v)||Number(v)<1600)
        ||key==='reported_residential_area'&&v==='0')fail();
    }else if(c.contribution_exact_value!==null||c.contribution_unit!==null)fail();
    const b=before[key];out[key]={value_states:Object.fromEntries(STATES.map(k=>[k,b.value_states[k]+Number(k===c.reported_value_state)])),
      complete_observed_count:b.complete_observed_count+Number(c.complete_observed_parts),eligible_count:b.eligible_count+Number(c.recorded_comparison_eligible),
      excluded_count:b.excluded_count+Number(!c.recorded_comparison_eligible),source_part_counts:Object.fromEntries(PARTS.map(k=>[k,b.source_part_counts[k]+parts[k]])),
      exclusion_reason_counts:Object.fromEntries(REASONS.map(k=>[k,b.exclusion_reason_counts[k]+Number(why.includes(k))]))};
  }
  return counts(out,ordinal+1);
}
function state(raw,max){const s=data(raw,['selected_ordinal','done']);integer(s.selected_ordinal,max);if(typeof s.done!=='boolean')fail();return freeze(s);}
/** Closed eighth transition DATA ONLY. Native head/ordinal/checkpoint/deferred
 * commit/continuation and current-authorized original owner are mandatory.
 * NO statistics/frequencies/source copies. Five states and overlapping reasons
 * are retained separately; source parts never become account denominators. */
export function prepareCohortSelectedStatisticsReceiptV2(...args){
  if(args.length!==2)fail();const keys=['union_reference','eligibility_reference','evidence_reference','metrics_reference','command_id','selected_stock_count'],
    e=data(args[1],keys),r=data(args[0],['format','policy',...keys,'sequence','previous','before','after','selected_entry','row_reference','before_counts','after_counts']);
  if(r.format!=='cohort_selected_statistics_receipt_v2'||r.policy!==POLICY||typeof e.command_id!=='string'||!UUID.test(e.command_id)
    ||r.command_id!==e.command_id||r.selected_stock_count!==integer(e.selected_stock_count))fail();
  const parents={};for(const k of keys.filter(k=>k.endsWith('_reference'))){parents[k]=ref(r[k]);if(!same(parents[k],ref(e[k])))fail();}
  const before=state(r.before,e.selected_stock_count),after=state(r.after,e.selected_stock_count),
    beforeCounts=counts(r.before_counts,before.selected_ordinal),afterCounts=counts(r.after_counts,after.selected_ordinal);
  if(before.done||r.sequence!==before.selected_ordinal+1||integer(r.sequence,2000001)<1
    ||r.sequence===1&&(r.previous!==null||before.selected_ordinal!==0)||r.sequence!==1&&r.previous===null)fail();
  let entry=null,row=null;
  if(after.done){
    if(after.selected_ordinal!==before.selected_ordinal||after.selected_ordinal!==e.selected_stock_count
      ||r.selected_entry!==null||r.row_reference!==null||!same(beforeCounts,afterCounts))fail();
  }else{
    if(after.selected_ordinal!==before.selected_ordinal+1)fail();
    entry=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']);
    if(typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
      ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
      ||entry.ordinal!==after.selected_ordinal||integer(entry.partition_ordinal)<1)fail();
    entry=freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)});row=ref(r.row_reference,4096);
    for(const key of METRICS){const b=beforeCounts[key],a=afterCounts[key];
      for(const field of ['complete_observed_count','eligible_count','excluded_count'])if(a[field]<b[field]||a[field]>b[field]+1)fail();
      for(const [field,max] of [['value_states',1],['source_part_counts',250],['exclusion_reason_counts',1]])
        for(const k of Object.keys(b[field]))if(a[field][k]<b[field][k]||a[field][k]>b[field][k]+max)fail();
    }
  }
  const result=freeze({...r,...parents,previous:r.previous===null?null:ref(r.previous),before,after,selected_entry:entry,row_reference:row,
    before_counts:beforeCounts,after_counts:afterCounts});
  if(Buffer.byteLength(json(result))>16000)fail();return result;
}
