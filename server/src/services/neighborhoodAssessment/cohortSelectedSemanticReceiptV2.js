import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { parseExactDecimalPagedObservationV1 as decimal12 } from './exactDecimalPagedDistributionV1.js';
import { emptyCohortSelectedStatisticsCountsV2, advanceCohortSelectedStatisticsCountsV2 } from './cohortSelectedStatisticsReceiptV2.js';

const METRICS=['reported_year_built','reported_residential_area','reported_site_area'];
const REFS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'];
const VALUES=['low','q1_lower','q1_upper','median_lower','median_upper','q3_lower','q3_upper','high'];
const RANK=['metric','selected_count','observed_count',...VALUES,'q1_remainder','median_remainder','q3_remainder'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('cohort_selected_semantic_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;}
function integer(n,max=2000000){if(!Number.isSafeInteger(n)||n<0||n>max)fail();return n;}
function count(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,6})$/.test(v)||BigInt(v)>2000000n)fail();return Number(v);}
function total(v){if(typeof v!=='string'||!/^(0|[1-9][0-9]{0,59})$/.test(v))fail();return BigInt(v);}
function ranks(raw,selected){
  if(!raw||isProxy(raw)||!Array.isArray(raw)||Object.getPrototypeOf(raw)!==Array.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(raw);
  if(ds.length?.value!==3||Reflect.ownKeys(ds).length!==4)fail();
  return METRICS.map((key,i)=>{
    if(!ds[i]?.enumerable||!Object.hasOwn(ds[i],'value'))fail();
    const r=data(ds[i].value,RANK),n=count(r.observed_count);
    if(r.metric!==key||count(r.selected_count)!==selected||n>selected)fail();
    for(const [q,k] of [['q1',1],['median',2],['q3',3]])
      if(r[q+'_remainder']!==(n?((n-1)*k)%4:0)||!r[q+'_remainder']&&r[q+'_lower']!==r[q+'_upper'])fail();
    if(!n){if(VALUES.some(k=>r[k]!==null))fail();}
    else{
      const v=Object.fromEntries(VALUES.map(k=>[k,decimal12(r[k])]));
      for(const side of ['lower','upper']){
        const ordered=[v.low,v['q1_'+side],v['median_'+side],v['q3_'+side],v.high];
        if(ordered.some((n,j)=>j&&n<ordered[j-1]))fail();
      }
      if(['q1','median','q3'].some(k=>v[k+'_lower']>v[k+'_upper'])||n===1&&v.low!==v.high)fail();
    }
    return r;
  });
}
const quantile=(r,k)=>r[k+'_lower']===null?null:
  decimal12(r[k+'_lower'])*100n+(decimal12(r[k+'_upper'])-decimal12(r[k+'_lower']))*BigInt(r[k+'_remainder'])*25n;
function finite(v){if(v===null)return null;const s=v.toString().padStart(15,'0'),f=s.slice(-14).replace(/0+$/,'');return s.slice(0,-14)+(f?'.'+f:'');}
function ratio(n,d){if(!d)return null;let a=n,b=d;while(b){const r=a%b;a=b;b=r;}return {numerator:(n/a).toString(),denominator:(d/a).toString()};}

/** Bounded derived state only. This validator is NOT source/selection authority.
 * The actual durable owner must freshly reopen every whole original/ENTIRE
 * cache and compare every seventh/eighth/index/ninth field before each step. */
export function prepareCohortSelectedSemanticSummaryV2(...args){
  if(args.length!==3)fail();const [raw,ordinal,selected]=args;
  integer(selected);integer(ordinal,selected);
  const s=data(raw,['format','ranks','counts','totals']);
  if(s.format!=='cohort_selected_semantic_summary_v2')fail();
  const r=ranks(s.ranks,selected),counts=advanceCohortSelectedStatisticsCountsV2(s.counts,ordinal,null),all=data(s.totals,METRICS),out={};
  for(const [i,key] of METRICS.entries()){
    const t=data(all[key],['observed_count','sum_scaled14','absolute_deviation_scaled14']);
    if(integer(t.observed_count,ordinal)!==counts[key].eligible_count||t.observed_count>count(r[i].observed_count))fail();
    const sum=total(t.sum_scaled14),dev=total(t.absolute_deviation_scaled14);
    if(!t.observed_count&&(sum||dev)||!count(r[i].observed_count)&&(sum||dev))fail();out[key]=t;
  }
  const result=freeze({...s,ranks:r,counts,totals:out});if(Buffer.byteLength(json(result))>16000)fail();return result;
}
export function initializeCohortSelectedSemanticSummaryV2(...args){
  if(args.length!==2)fail();const [rawRanks,selected]=args;
  return prepareCohortSelectedSemanticSummaryV2({format:'cohort_selected_semantic_summary_v2',ranks:ranks(rawRanks,selected),
    counts:emptyCohortSelectedStatisticsCountsV2(),totals:Object.fromEntries(METRICS.map(k=>[k,
      {observed_count:0,sum_scaled14:'0',absolute_deviation_scaled14:'0'}]))},0,selected);
}
export function advanceCohortSelectedSemanticSummaryV2(...args){
  if(args.length!==4)fail();const [raw,ordinal,selected,cells]=args,before=prepareCohortSelectedSemanticSummaryV2(raw,ordinal,selected);
  if(cells===null)return before;
  const detached=Object.fromEntries(Object.entries(data(cells,[...METRICS,'reported_market_value'])).map(([k,c])=>[k,
    data(c,['reported_value_state','complete_observed_parts','recorded_comparison_eligible','contribution_exact_value',
      'contribution_unit','exclusion_reasons','source_part_count','part_counts'])]));
  const counts=advanceCohortSelectedStatisticsCountsV2(before.counts,ordinal,detached),totals={};
  for(const [i,key] of METRICS.entries()){
    const t=before.totals[key],value=detached[key].contribution_exact_value;
    if(value===null){totals[key]=t;continue;}
    const v=decimal12(value)*100n,m=quantile(before.ranks[i],'median');if(m===null)fail();
    totals[key]={observed_count:t.observed_count+1,sum_scaled14:(total(t.sum_scaled14)+v).toString(),
      absolute_deviation_scaled14:(total(t.absolute_deviation_scaled14)+(v>m?v-m:m-v)).toString()};
  }
  return prepareCohortSelectedSemanticSummaryV2({...before,counts,totals},ordinal+1,selected);
}
/** Exact results only after the actual owner's separate fresh EMPTY probe and
 * equality of EVERY independently rederived state/part/reason/eligible counter.
 * Mathematical DATA alone cannot authorize publication or a live report. */
export function finalizeCohortSelectedSemanticSummaryV2(...args){
  if(args.length!==3)fail();const [raw,selected,originalCounts]=args,s=prepareCohortSelectedSemanticSummaryV2(raw,selected,selected);
  if(!same(s.counts,advanceCohortSelectedStatisticsCountsV2(originalCounts,selected,null)))fail();
  return freeze(Object.fromEntries(METRICS.map((key,i)=>{
    const r=s.ranks[i],t=s.totals[key],n=count(r.observed_count),median=quantile(r,'median');
    if(t.observed_count!==n)fail();
    return [key,{selected_count:selected,observed_count:n,unit:key==='reported_year_built'?'year':'reported_sqft',
      low:r.low,q1:finite(quantile(r,'q1')),median:finite(median),q3:finite(quantile(r,'q3')),high:r.high,
      mean:n?ratio(total(t.sum_scaled14),BigInt(n)*10n**14n):null,
      cod_percent:n&&median!==0n?ratio(100n*total(t.absolute_deviation_scaled14),BigInt(n)*median):null,
      cod_reason:!n?'no_eligible_observations':median===0n?'zero_median':null}];
  })));
}
export function prepareCohortSelectedSemanticReceiptV2(...args){
  if(args.length!==2)fail();const keys=[...REFS,'command_id','selected_stock_count'],e=data(args[1],keys),
    r=data(args[0],['format',...keys,'sequence','previous','before','after','selected_entry','contribution_row_reference',
      'before_summary_reference','after_summary_reference']);
  if(r.format!=='cohort_selected_semantic_receipt_v2'||typeof e.command_id!=='string'||!UUID.test(e.command_id)||r.command_id!==e.command_id
    ||r.selected_stock_count!==integer(e.selected_stock_count))fail();
  const refs={};for(const key of REFS){refs[key]=ref(r[key]);if(!same(refs[key],ref(e[key])))fail();}
  const before=data(r.before,['selected_ordinal','done']),after=data(r.after,['selected_ordinal','done']);
  integer(before.selected_ordinal,e.selected_stock_count);integer(after.selected_ordinal,e.selected_stock_count);
  if(before.done!==false||typeof after.done!=='boolean'||integer(r.sequence,2000001)<1||r.sequence!==before.selected_ordinal+1
    ||r.sequence===1&&(r.previous!==null||r.before_summary_reference!==null)||r.sequence!==1&&(r.previous===null||r.before_summary_reference===null))fail();
  let entry=null,contribution=null;
  if(after.done){if(after.selected_ordinal!==before.selected_ordinal||after.selected_ordinal!==e.selected_stock_count
    ||r.selected_entry!==null||r.contribution_row_reference!==null)fail();}
  else{
    if(after.selected_ordinal!==before.selected_ordinal+1)fail();entry=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']);
    if(typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
      ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
      ||entry.ordinal!==after.selected_ordinal||integer(entry.partition_ordinal)<1)fail();
    entry={...entry,entry_reference:ref(entry.entry_reference,1000000)};contribution=ref(r.contribution_row_reference,4096);
  }
  const result=freeze({...r,...refs,before,after,selected_entry:entry,contribution_row_reference:contribution,
    previous:r.previous===null?null:ref(r.previous,4096),before_summary_reference:r.before_summary_reference===null?null:ref(r.before_summary_reference),
    after_summary_reference:ref(r.after_summary_reference)});
  if(Buffer.byteLength(json(result))>4096)fail();return result;
}
