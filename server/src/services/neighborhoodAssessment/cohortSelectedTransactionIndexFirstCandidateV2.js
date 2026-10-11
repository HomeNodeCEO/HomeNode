import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

export const SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS=Object.freeze(['union_reference','eligibility_reference',
  'evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'];
const fail=()=>{throw new TypeError('cohort_selected_transaction_index_first_candidate_v2_invalid');};
const data=(v,keys)=>{
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
};
const ref=(v,max)=>{const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;};
const uuid=v=>{if(typeof v!=='string'||!UUID.test(v))fail();return v;};
function member(v,count){
  if(v===null){if(count!==0)fail();return null;}
  const m=data(v,MEMBER);
  if(count===0||m.ordinal!==1||!Number.isInteger(m.partition_ordinal)||m.partition_ordinal<1||m.partition_ordinal>2000000
    ||typeof m.account_id!=='string'||!m.account_id||m.account_id.length>64||!m.account_id.isWellFormed()
    ||m.account_id.trim()!==m.account_id||/[\u0000-\u001f\u007f]/.test(m.account_id))fail();
  return Object.freeze({...m,entry_reference:ref(m.entry_reference,1000000),metric_row_reference:ref(m.metric_row_reference,4096),
    contribution_row_reference:ref(m.contribution_row_reference,4096)});
}
/** Closed bounded DATA only. Never source rights, original reconciliation or an
 * issued receipt. The actual owner must obtain this plan natively before the
 * original packet and again AFTER every ending fence. FIRST/unissued only. */
export function prepareCohortSelectedTransactionIndexFirstPlanV2(raw){
  const p=data(raw,['generation_id','selected_stock_count','selected_entry','anchor_count','native_packages']);
  uuid(p.generation_id);
  if(!Number.isInteger(p.selected_stock_count)||p.selected_stock_count<0||p.selected_stock_count>2000000
    ||!Number.isInteger(p.anchor_count)||p.anchor_count<0||p.anchor_count>250)fail();
  const selected=member(p.selected_entry,p.selected_stock_count),a=p.native_packages;
  if(!Array.isArray(a)||isProxy(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length>250
    ||Reflect.ownKeys(a).length!==a.length+1||a.length>p.anchor_count)fail();
  let previous=null;const packages=[];
  for(let i=0;i<a.length;i++){
    const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();
    const k=data(d.value,['kind','native_key']);
    if(!['source_record','legacy_sale'].includes(k.kind)||typeof k.native_key!=='string'
      ||!/^[1-9][0-9]{0,18}$/.test(k.native_key)||BigInt(k.native_key)>9223372036854775807n)fail();
    if(previous&&(previous.kind==='legacy_sale'&&k.kind==='source_record'||previous.kind===k.kind
      &&(k.kind==='source_record'?BigInt(previous.native_key)>=BigInt(k.native_key)
        :Buffer.compare(Buffer.from(previous.native_key),Buffer.from(k.native_key))>=0)))fail();
    packages.push(Object.freeze(k));previous=k;
  }
  if(selected===null&&(p.anchor_count!==0||packages.length)||p.anchor_count>0&&packages.length===0)fail();
  return Object.freeze({...p,selected_entry:selected,native_packages:Object.freeze(packages)});
}

/** Counts are a compact proposal derived from the bounded exact native set,
 * not proof of completeness. No full-population array, original payload, time,
 * economics or calendar-quarter claim is retained in this candidate. */
export function prepareCohortSelectedTransactionIndexFirstCandidateV2(raw){
  const o=data(raw,['command_id',...SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS,'plan']),
    plan=prepareCohortSelectedTransactionIndexFirstPlanV2(o.plan),
    roots=Object.fromEntries(SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS.map(k=>[k,ref(o[k],['numeric_reference','semantic_reference'].includes(k)?4096:16000)])),
    source=plan.native_packages.filter(k=>k.kind==='source_record').length,
    legacy=plan.native_packages.length-source;
  const candidate=Object.freeze({format:'cohort_selected_transaction_index_first_candidate_v2',command_id:uuid(o.command_id),...roots,
    generation_id:plan.generation_id,selected_stock_count:plan.selected_stock_count,sequence:1,previous_reference:null,
    before:Object.freeze({selected_ordinal:0,source_record_keys:0,legacy_sale_keys:0,done:false}),
    after:Object.freeze({selected_ordinal:plan.selected_entry===null?0:1,source_record_keys:source,legacy_sale_keys:legacy,done:plan.selected_entry===null}),
    selected_entry:plan.selected_entry,association_anchor_count:plan.anchor_count,
    scope:'first_unissued_native_index_candidate_only',durable_index_issued:false});
  if(Buffer.byteLength(json(candidate))>4096)fail();return candidate;
}
