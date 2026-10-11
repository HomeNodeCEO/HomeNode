import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const PARENTS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=()=>{throw new TypeError('cohort_selected_numeric_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function integer(n,max=2000000){if(!Number.isSafeInteger(n)||n<0||n>max)fail();return n;}
function ref(v,max=16000){
  const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail();return p;
}
function state(v,max){const s=data(v,['selected_ordinal','done']);integer(s.selected_ordinal,max);
  if(typeof s.done!=='boolean')fail();return Object.freeze(s);}

/** Ninth transition DATA ONLY; no counts, values, source rows or callbacks.
 * This closed reference is not proof of current rights or original equality.
 * The actual bounded owner must reopen the COMPLETE issued graph, every whole
 * original and ENTIRE neutral cache, compare every seventh/eighth/index field,
 * then recheck all ending authority before the native atomic transition.
 * A later semantic statistics pass must reopen originals AGAIN. */
export function prepareCohortSelectedNumericReceiptV2(...args){
  if(args.length!==2)fail();
  const keys=[...PARENTS,'command_id','selected_stock_count'],e=data(args[1],keys),
    r=data(args[0],['format',...keys,'sequence','previous','before','after','selected_entry','contribution_row_reference']);
  if(r.format!=='cohort_selected_numeric_receipt_v2'||typeof e.command_id!=='string'||!UUID.test(e.command_id)
    ||r.command_id!==e.command_id||r.selected_stock_count!==integer(e.selected_stock_count))fail();
  const parents={};for(const key of PARENTS){parents[key]=ref(r[key]);if(!same(parents[key],ref(e[key])))fail();}
  const before=state(r.before,e.selected_stock_count),after=state(r.after,e.selected_stock_count);
  if(before.done||integer(r.sequence,2000001)<1||r.sequence!==before.selected_ordinal+1
    ||r.sequence===1&&(r.previous!==null||before.selected_ordinal!==0)||r.sequence!==1&&r.previous===null)fail();
  let entry=null,contribution=null;
  if(after.done){
    if(after.selected_ordinal!==before.selected_ordinal||after.selected_ordinal!==e.selected_stock_count
      ||r.selected_entry!==null||r.contribution_row_reference!==null)fail();
  }else{
    if(after.selected_ordinal!==before.selected_ordinal+1)fail();
    entry=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference']);
    if(typeof entry.account_id!=='string'||!entry.account_id||entry.account_id.length>64||!entry.account_id.isWellFormed()
      ||entry.account_id.trim()!==entry.account_id||/[\u0000-\u001f\u007f]/.test(entry.account_id)
      ||entry.ordinal!==after.selected_ordinal||integer(entry.partition_ordinal)<1)fail();
    entry=Object.freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)});
    contribution=ref(r.contribution_row_reference,4096);
  }
  const result=Object.freeze({...r,...parents,previous:r.previous===null?null:ref(r.previous,4096),before,after,
    selected_entry:entry,contribution_row_reference:contribution});
  if(Buffer.byteLength(json(result))>4096)fail();return result;
}
