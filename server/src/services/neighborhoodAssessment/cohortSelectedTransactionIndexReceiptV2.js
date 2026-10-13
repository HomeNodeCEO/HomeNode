import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as REFS } from './cohortSelectedTransactionIndexFirstCandidateV2.js';

// INACTIVE owner work in progress. DATA validation is not an issued index,
// original reconciliation, source rights, or permission to remove DB guards.
// The future owner must derive the plan from its own native head, reopen the
// complete original graph and all current/ending fences, then atomically issue
// the member, namespaced registries, exact edges, head, checkpoint and yield.
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'];
const STATE=['selected_ordinal','source_record_keys','legacy_sale_keys','done'];
const EXPECTED=['command_id',...REFS,'generation_id','selected_stock_count'];
const fail=()=>{throw new TypeError('cohort_selected_transaction_index_v2_invalid_data');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function integer(v,max){if(!Number.isSafeInteger(v)||Object.is(v,-0)||v<0||v>max)fail();return v;}
function uuid(v){if(typeof v!=='string'||!UUID.test(v))fail();return v;}
function ref(v,max){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;}
function state(v,selected){
  const s=data(v,STATE);integer(s.selected_ordinal,selected);
  // A unique registry may contain 2m * 250 = 500m keys, not just 2m. This is
  // only a bounded grammar; no count establishes an identity or completeness.
  integer(s.source_record_keys,500000000);integer(s.legacy_sale_keys,500000000);
  if(typeof s.done!=='boolean'||s.source_record_keys+s.legacy_sale_keys>s.selected_ordinal*250
    ||s.done&&s.selected_ordinal!==selected)fail();
  return Object.freeze(s);
}
function member(v,before,selected){
  if(v===null){if(before.selected_ordinal!==selected)fail();return null;}
  const m=data(v,MEMBER);
  if(before.selected_ordinal===selected||m.ordinal!==before.selected_ordinal+1||integer(m.partition_ordinal,2000000)<1
    ||typeof m.account_id!=='string'||!m.account_id||m.account_id.length>64||!m.account_id.isWellFormed()
    ||m.account_id.trim()!==m.account_id||/[\u0000-\u001f\u007f]/.test(m.account_id))fail();
  return Object.freeze({...m,entry_reference:ref(m.entry_reference,1000000),metric_row_reference:ref(m.metric_row_reference,4096),
    contribution_row_reference:ref(m.contribution_row_reference,4096)});
}
function expected(v){
  const e=data(v,EXPECTED);uuid(e.command_id);uuid(e.generation_id);integer(e.selected_stock_count,2000000);
  return Object.freeze({...e,...Object.fromEntries(REFS.map(k=>[k,ref(e[k],['numeric_reference','semantic_reference'].includes(k)?4096:16000)]))});
}

/** Closed, per-account, bounded native plan. Existing registry first-seen
 * ordinals remain immutable. A repeated source still appears in this account's
 * exact package set and must be fully reopened; it is NOT skipped because it
 * was registered for a previous account. No caller-selected cursor is admitted
 * by the future zero-argument repository reader. This codec itself is DATA. */
export function prepareCohortSelectedTransactionIndexPlanV2(...args){
  if(args.length!==1)fail();
  const p=data(args[0],['generation_id','selected_stock_count','before','selected_entry','anchor_count','native_packages']);
  uuid(p.generation_id);integer(p.selected_stock_count,2000000);integer(p.anchor_count,250);
  const before=state(p.before,p.selected_stock_count);if(before.done)fail();
  const selected=member(p.selected_entry,before,p.selected_stock_count),a=p.native_packages;
  if(!Array.isArray(a)||isProxy(a)||Object.getPrototypeOf(a)!==Array.prototype||a.length>250
    ||Reflect.ownKeys(a).length!==a.length+1||a.length>p.anchor_count)fail();
  const packages=[],existing={source_record:0,legacy_sale:0};let previous=null;
  for(let i=0;i<a.length;i++){
    const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail();
    const k=data(d.value,['kind','native_key','first_selected_ordinal']);
    if(!['source_record','legacy_sale'].includes(k.kind)||typeof k.native_key!=='string'
      ||!/^[1-9][0-9]{0,18}$/.test(k.native_key)||BigInt(k.native_key)>9223372036854775807n)fail();
    if(k.first_selected_ordinal!==null){
      if(integer(k.first_selected_ordinal,before.selected_ordinal)<1)fail();existing[k.kind]++;
    }
    if(previous&&(previous.kind==='legacy_sale'&&k.kind==='source_record'||previous.kind===k.kind
      &&(k.kind==='source_record'?BigInt(previous.native_key)>=BigInt(k.native_key)
        :Buffer.compare(Buffer.from(previous.native_key),Buffer.from(k.native_key))>=0)))fail();
    packages.push(Object.freeze(k));previous=k;
  }
  if(selected===null&&(p.anchor_count!==0||packages.length)||p.anchor_count>0&&packages.length===0
    ||existing.source_record>before.source_record_keys||existing.legacy_sale>before.legacy_sale_keys)fail();
  return Object.freeze({...p,before,selected_entry:selected,native_packages:Object.freeze(packages)});
}

/** Compact proposal for the eventual exact-17 owner. No original payloads,
 * roster, registry arrays, economic interpretations, dates or quarter claims.
 * Only native head/edge/first-seen checks plus original replay can issue it. */
export function prepareCohortSelectedTransactionIndexReceiptV2(...args){
  if(args.length!==2)fail();const e=expected(args[1]),r=data(args[0],['format',...EXPECTED,'sequence','previous','before','after',
    'selected_entry','association_anchor_count','source_package_count','legacy_package_count','new_source_record_keys','new_legacy_sale_keys']);
  if(r.format!=='cohort_selected_transaction_index_receipt_v2')fail();
  const bound=expected(Object.fromEntries(EXPECTED.map(k=>[k,r[k]])));if(!same(bound,e))fail();
  const before=state(r.before,e.selected_stock_count),after=state(r.after,e.selected_stock_count);
  if(before.done||integer(r.sequence,2000001)<1||r.sequence!==before.selected_ordinal+1
    ||(before.selected_ordinal===0)!==(r.previous===null))fail();
  const selected=member(r.selected_entry,before,e.selected_stock_count);
  for(const k of ['association_anchor_count','source_package_count','legacy_package_count','new_source_record_keys','new_legacy_sale_keys'])integer(r[k],250);
  if(r.source_package_count+r.legacy_package_count>r.association_anchor_count
    ||r.association_anchor_count>0&&r.source_package_count+r.legacy_package_count===0
    ||r.new_source_record_keys>r.source_package_count||r.new_legacy_sale_keys>r.legacy_package_count
    ||r.source_package_count-r.new_source_record_keys>before.source_record_keys
    ||r.legacy_package_count-r.new_legacy_sale_keys>before.legacy_sale_keys
    ||after.source_record_keys!==before.source_record_keys+r.new_source_record_keys
    ||after.legacy_sale_keys!==before.legacy_sale_keys+r.new_legacy_sale_keys)fail();
  if(selected===null){
    if(!after.done||after.selected_ordinal!==before.selected_ordinal||r.association_anchor_count!==0
      ||r.source_package_count!==0||r.legacy_package_count!==0||r.new_source_record_keys!==0||r.new_legacy_sale_keys!==0)fail();
  }else if(after.done||after.selected_ordinal!==selected.ordinal)fail();
  const result=Object.freeze({...r,...bound,before,after,selected_entry:selected,previous:r.previous===null?null:ref(r.previous,4096)});
  if(Buffer.byteLength(json(result))>4096)fail();return result;
}

/** Derive deltas from a bounded native plan, not supplied count arithmetic.
 * This is NOT persistence or acceptance. The original owner must independently
 * verify this exact plan again after all ending fences before any DML. */
export function buildCohortSelectedTransactionIndexReceiptV2(...args){
  if(args.length!==1)fail();const o=data(args[0],['command_id',...REFS,'plan','previous']),p=prepareCohortSelectedTransactionIndexPlanV2(o.plan),
    e=expected({command_id:o.command_id,...Object.fromEntries(REFS.map(k=>[k,o[k]])),generation_id:p.generation_id,selected_stock_count:p.selected_stock_count}),
    sources=p.native_packages.filter(k=>k.kind==='source_record'),legacies=p.native_packages.filter(k=>k.kind==='legacy_sale'),
    addedSource=sources.filter(k=>k.first_selected_ordinal===null).length,addedLegacy=legacies.filter(k=>k.first_selected_ordinal===null).length;
  return prepareCohortSelectedTransactionIndexReceiptV2({format:'cohort_selected_transaction_index_receipt_v2',...e,
    sequence:p.before.selected_ordinal+1,previous:o.previous,before:p.before,
    after:{selected_ordinal:p.selected_entry?.ordinal??p.before.selected_ordinal,
      source_record_keys:p.before.source_record_keys+addedSource,legacy_sale_keys:p.before.legacy_sale_keys+addedLegacy,done:p.selected_entry===null},
    selected_entry:p.selected_entry,association_anchor_count:p.anchor_count,source_package_count:sources.length,legacy_package_count:legacies.length,
    new_source_record_keys:addedSource,new_legacy_sale_keys:addedLegacy},e);
}
