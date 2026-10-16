import { isProxy } from 'node:util/types';
import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const REFS=['source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference'];
const EXPECTED=['binding',...REFS,'effective_date','stock_account_count'];
const KEYS=['format',...EXPECTED,'sequence','previous','before','after'];
const same=(a,b)=>json(a)===json(b);
const fail=()=>{throw new TypeError('cohort_stock_traversal_receipt_v2_invalid_receipt');};
/** Closed own DATA only; no getters, proxies or inherited continuations. */
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||!keys.every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
/** Metadata references cannot smuggle original payloads into a job checkpoint. */
function ref(value){const r=data(value,['content_sha256','canonical_utf8_bytes']);
  const result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>16000)fail();return result;}
/** Fixed native C-text stock cursor, not a browser-selected member. */
function progress(value,total){
  const p=data(value,['after_account','account_count','done']);
  if(typeof p.after_account!=='string'||p.after_account.length>64||!p.after_account.isWellFormed()
    ||Buffer.byteLength(p.after_account)>256||p.after_account.trim()!==p.after_account||/[\u0000-\u001f\u007f]/.test(p.after_account)
    ||!Number.isInteger(p.account_count)||p.account_count<0||p.account_count>total||typeof p.done!=='boolean'
    ||(p.account_count===0)!==(p.after_account==='')||p.done&&p.account_count!==total)fail();
  return Object.freeze(p);
}

/** Transition DATA only. An independently issued native head chooses the
 * continuation. The actual owner must replay EVERY original of the next whole
 * stock account against the ENTIRE neutral cache with both-end current rights.
 * This receipt stores no cells, selection, statistics or original payloads.
 * A count/hash/receipt alone must never replace that replay for a later consumer.
 */
export function prepareCohortStockTraversalReceiptV2(raw,expected){
  const r=data(raw,KEYS),e=data(expected,EXPECTED);
  const binding=data(r.binding,['organization_id','report_file_id','assignment_file_id','account_id','operation_id',
    'generation_id','spatial_definition_sha256','source_original_sha256']);
  if(r.format!=='cohort_stock_traversal_receipt_v2'||!same(binding,e.binding)
    ||r.effective_date!==assessmentDate(e.effective_date)||typeof r.stock_account_count!=='string'
    ||!/^[1-9][0-9]{0,6}$/.test(r.stock_account_count)||Number(r.stock_account_count)>2000000
    ||r.stock_account_count!==e.stock_account_count||!Number.isInteger(r.sequence)||r.sequence<1||r.sequence>2000001)fail();
  const refs=Object.fromEntries(REFS.map(k=>[k,ref(r[k])]));
  if(!REFS.every(k=>same(refs[k],e[k])))fail();
  const previous=r.previous===null?null:ref(r.previous),total=Number(r.stock_account_count),
    before=progress(r.before,total),after=progress(r.after,total);
  if((r.sequence===1)!==(previous===null)||before.done
    ||r.sequence!==before.account_count+1
    ||r.sequence===1&&!same(before,{after_account:'',account_count:0,done:false}))fail();
  if(after.done){
    // Even after the last nonempty account, only a new empty native probe ends
    // traversal. The owner never translates a key/count into a free DONE blob.
    if(after.account_count!==before.account_count||after.after_account!==before.after_account)fail();
  }else if(after.account_count!==before.account_count+1
    ||Buffer.compare(Buffer.from(after.after_account),Buffer.from(before.after_account))<=0)fail();
  return Object.freeze({...r,binding:Object.freeze(binding),...refs,previous,before,after});
}
