import { isProxy } from 'node:util/types';
import { assessmentDate,canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const REFS=['source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference'];
const EXPECTED=['binding',...REFS,'effective_date','stock_account_count'];
const KEYS=['format',...EXPECTED,'sequence','previous','before','after','accounts','original_count'];
const fail=()=>{throw new TypeError('cohort_stock_traversal_batch_v3_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(value){const r=data(value,['content_sha256','canonical_utf8_bytes']),
  result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>16000)fail();return result;}
function account(value){
  if(typeof value!=='string'||value.length>64||!value.isWellFormed()||Buffer.byteLength(value)>256
    ||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))fail();return value;
}
function progress(raw,total){const p=data(raw,['after_account','account_count','done']);account(p.after_account);
  if(!Number.isInteger(p.account_count)||p.account_count<0||p.account_count>total||typeof p.done!=='boolean'
    ||(p.account_count===0)!==(p.after_account==='')||p.done&&p.account_count!==total)fail();return Object.freeze(p);}

/** Closed transition DATA, never an original/source capability. The native
 * guard must independently admit this exact consecutive stock prefix and CAS;
 * the actual owner must replay EVERY whole original/ENTIRE cache and all
 * current/ending authority before issuing ONE receipt/head/checkpoint/release.
 * Account ordinals and receipt sequence are deliberately separate. Historical
 * single-account V2 receipts and their parser remain completely unchanged. */
export function prepareCohortStockTraversalBatchReceiptV3(raw,expected){
  const r=data(raw,KEYS),e=data(expected,EXPECTED),binding=data(r.binding,
    ['organization_id','report_file_id','assignment_file_id','account_id','operation_id',
      'generation_id','spatial_definition_sha256','source_original_sha256']);
  if(r.format!=='cohort_stock_traversal_batch_receipt_v3'||!same(binding,e.binding)
    ||r.effective_date!==assessmentDate(e.effective_date)||typeof r.stock_account_count!=='string'
    ||!/^[1-9][0-9]{0,6}$/.test(r.stock_account_count)||Number(r.stock_account_count)>2000000
    ||r.stock_account_count!==e.stock_account_count||!Number.isInteger(r.sequence)||r.sequence<1||r.sequence>2000001)fail();
  const refs=Object.fromEntries(REFS.map(k=>[k,ref(r[k])]));if(!REFS.every(k=>same(refs[k],e[k])))fail();
  const previous=r.previous===null?null:ref(r.previous),total=Number(r.stock_account_count),
    before=progress(r.before,total),after=progress(r.after,total);
  if((r.sequence===1)!==(previous===null)||before.done
    ||r.sequence>before.account_count+1||r.sequence<Math.ceil(before.account_count/8)+1
    ||r.sequence===1&&!same(before,{after_account:'',account_count:0,done:false}))fail();
  if(!Array.isArray(r.accounts)||isProxy(r.accounts)||Object.getPrototypeOf(r.accounts)!==Array.prototype||r.accounts.length>8)fail();
  const ds=Object.getOwnPropertyDescriptors(r.accounts);
  if(Reflect.ownKeys(ds).length!==r.accounts.length+1)fail();
  let last=before.after_account,originalCount=0;
  const accounts=Array.from({length:r.accounts.length},(_,index)=>{
    const d=ds[index];if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();
    const p=data(d.value,['account_id','geographic_parcel_count','original_counts']),c=data(p.original_counts,['parcels','accounts']);
    account(p.account_id);
    if(!p.account_id||Buffer.compare(Buffer.from(p.account_id),Buffer.from(last))<=0
      ||!Number.isInteger(c.parcels)||c.parcels<1||c.parcels>250||!Number.isInteger(c.accounts)||c.accounts<0||c.accounts>1
      ||typeof p.geographic_parcel_count!=='string'||!/^[1-9][0-9]{0,6}$/.test(p.geographic_parcel_count)
      ||BigInt(p.geographic_parcel_count)>BigInt(c.parcels))fail();
    last=p.account_id;originalCount+=c.parcels+c.accounts;
    return Object.freeze({...p,original_counts:Object.freeze(c)});
  });
  if(!Number.isInteger(r.original_count)||r.original_count!==originalCount||originalCount>250
    ||after.done!==(accounts.length===0)||after.account_count!==before.account_count+accounts.length||after.after_account!==last)fail();
  return Object.freeze({...r,binding:Object.freeze(binding),...refs,previous,before,after,
    accounts:Object.freeze(accounts)});
}
