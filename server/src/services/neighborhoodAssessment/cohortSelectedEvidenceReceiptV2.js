import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('cohort_selected_evidence_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(v,max=16000){
  const r=data(v,['content_sha256','canonical_utf8_bytes']),
    p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;
}
function integer(v,max=2000000){if(!Number.isInteger(v)||v<0||v>max)fail();return v;}
function state(v,max){
  const s=data(v,['selected_ordinal','done']);integer(s.selected_ordinal,max);
  if(typeof s.done!=='boolean')fail();return Object.freeze(s);
}
/** Closed sixth-pass transition DATA ONLY, not original/source/selection or
 * semantic authority. Before retaining a receipt the actual bounded DB owner
 * must independently reopen EVERY selected stock/CAD/whole-transaction original,
 * required subject original, ENTIRE cache, native partition/catalog/union and
 * DONE fifth pass, under all current and ending source/actor/claim/subject fences.
 * Native heads and deferred guards must bind the exact next ordinal atomically
 * to checkpoint and single-use continuation; this validator cannot do that.
 * No original, typed value, diagnostic, decision or per-source payload copies.
 * Every later semantic consumer MUST independently reopen originals again. */
export function prepareCohortSelectedEvidenceReceiptV2(raw,expected){
  const keys=['union_reference','eligibility_reference','command_id','selected_stock_count'],
    e=data(expected,keys),r=data(raw,['format',...keys,'sequence','previous','before','after','selected_entry']);
  if(r.format!=='cohort_selected_evidence_receipt_v2'||typeof e.command_id!=='string'||!UUID.test(e.command_id)
    ||r.command_id!==e.command_id||r.selected_stock_count!==integer(e.selected_stock_count)
    ||!same(ref(r.union_reference),ref(e.union_reference))
    ||!same(ref(r.eligibility_reference),ref(e.eligibility_reference)))fail();
  const before=state(r.before,e.selected_stock_count),after=state(r.after,e.selected_stock_count);
  if(before.done||r.sequence!==before.selected_ordinal+1||integer(r.sequence,2000001)<1
    ||r.sequence===1&&(r.previous!==null||before.selected_ordinal!==0)
    ||r.sequence!==1&&r.previous===null)fail();
  const previous=r.previous===null?null:ref(r.previous);let entry=null;
  if(after.done){
    // Only a newly reopened EMPTY probe at the complete native selected count
    // can justify this DATA shape; an empty prefix or cursor is never sufficient.
    if(after.selected_ordinal!==before.selected_ordinal||after.selected_ordinal!==e.selected_stock_count
      ||r.selected_entry!==null)fail();
  }else{
    if(after.selected_ordinal!==before.selected_ordinal+1)fail();
    entry=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']);
    if(typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
      ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
      ||entry.ordinal!==after.selected_ordinal||integer(entry.partition_ordinal)<1)fail();
    entry=Object.freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)});
  }
  const result=Object.freeze({...r,union_reference:ref(r.union_reference),eligibility_reference:ref(r.eligibility_reference),
    previous,before,after,selected_entry:entry});
  if(Buffer.byteLength(json(result))>16000)fail();return result;
}
