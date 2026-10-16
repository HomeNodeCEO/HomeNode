import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

export const CAD_CACHE_COVERAGE_V2_BINDINGS=Object.freeze(['source_reference','root_reference','graph_reference',
  'geographic_reference','identity_reference','stock_reference','neutral_reference']);
const REFS=[...CAD_CACHE_COVERAGE_V2_BINDINGS,'typed_profile_reference'];
const EXPECTED=['binding',...REFS,'cad_source_metadata','cad_purpose','cad_decision','stock_account_count'];
const INITIAL=Object.freeze({after_account:'',account_count:0,original_count:0,typed_utf8_bytes:'0',done:false});
const fail=()=>{throw new TypeError('cohort_CAD_cache_coverage_receipt_v2_invalid_receipt');};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Detach bounded own JSON DATA without invoking nested getters or proxies. */
function tree(value){let nodes=0;const visit=(v,depth)=>{
  if(++nodes>2048||depth>12||isProxy(v))fail();
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){if(!v.isWellFormed()||Buffer.byteLength(v)>16000)fail();return v;}
  if(typeof v==='number'){if(!Number.isFinite(v))fail();return v;}
  if(!v||typeof v!=='object')fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Array.isArray(v)){
    if(Object.getPrototypeOf(v)!==Array.prototype||v.length>64||Reflect.ownKeys(ds).length!==v.length+1)fail();
    return Object.freeze(Array.from({length:v.length},(_,i)=>{const d=ds[String(i)];if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();return visit(d.value,depth+1);}));
  }
  if(Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(ds).length>64)fail();
  return Object.freeze(Object.fromEntries(Reflect.ownKeys(ds).map(k=>{
    const d=ds[k];if(typeof k!=='string'||!d.enumerable||!Object.hasOwn(d,'value'))fail();return [k,visit(d.value,depth+1)];})));
};return visit(value,0);}
function ref(v){const r=data(v,['content_sha256','canonical_utf8_bytes']),out=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(out.canonical_utf8_bytes)>16000)fail();return out;}
function account(v,empty=false){if(typeof v!=='string'||!v.isWellFormed()||(!empty&&!v)||Buffer.byteLength(v)>64
  ||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail();return v;}
function state(raw){const s=data(raw,Object.keys(INITIAL));account(s.after_account,true);
  if(!Number.isInteger(s.account_count)||s.account_count<0||s.account_count>2_000_000
    ||!Number.isInteger(s.original_count)||s.original_count<0||s.original_count>4_000_000||typeof s.done!=='boolean'
    ||typeof s.typed_utf8_bytes!=='string'||!/^(?:0|[1-9][0-9]{0,9})$/.test(s.typed_utf8_bytes)
    ||BigInt(s.typed_utf8_bytes)>8_000_000_000n||BigInt(s.typed_utf8_bytes)<BigInt(s.original_count)
    ||(s.account_count===0)!==(s.after_account===''))fail();return Object.freeze(s);}
export const initialCohortCadCacheCoverageV2State=()=>INITIAL;

/** Closed one-account transition DATA. Actual source/whole-cache replay and
 * both-end authorization belong to the real owner; only the native independent
 * head can issue this progress. A valid receipt alone never grants coverage. */
export function prepareCohortCadCacheCoverageReceiptV2(raw,rawExpected){
  const r=tree(data(raw,['format',...EXPECTED,'sequence','previous','before','after','entry'])),e=tree(data(rawExpected,EXPECTED));
  if(r.format!=='cohort_CAD_cache_coverage_receipt_v2'||!EXPECTED.every(k=>same(r[k],e[k]))
    ||typeof r.stock_account_count!=='string'||!/^[1-9][0-9]{0,6}$/.test(r.stock_account_count)||Number(r.stock_account_count)>2_000_000
    ||!Number.isInteger(r.sequence)||r.sequence<1||r.sequence>2_000_001)fail();
  const refs=Object.fromEntries(REFS.map(k=>[k,ref(r[k])])),previous=r.previous===null?null:ref(r.previous);
  const before=state(r.before),after=state(r.after);
  if(before.done||before.account_count>=Number(r.stock_account_count)+1||after.account_count>Number(r.stock_account_count)
    ||r.sequence!==before.account_count+1||(r.sequence===1)!==(previous===null)
    ||r.sequence===1&&!same(before,INITIAL))fail();
  let entry=null;
  if(r.entry!==null){entry=data(r.entry,['account_id','geographic_parcel_count','primary_count','secondary_count']);account(entry.account_id);
    if(Buffer.compare(Buffer.from(entry.account_id),Buffer.from(before.after_account))<=0
      ||typeof entry.geographic_parcel_count!=='string'||!/^[1-9][0-9]{0,6}$/.test(entry.geographic_parcel_count)
      ||Number(entry.geographic_parcel_count)>2_000_000||![0,1].includes(entry.primary_count)
      ||!Number.isInteger(entry.secondary_count)||entry.secondary_count<0||entry.secondary_count>250
      ||entry.primary_count+entry.secondary_count>250||after.done||after.after_account!==entry.account_id
      ||after.account_count!==before.account_count+1||after.original_count!==before.original_count+entry.primary_count+entry.secondary_count)fail();
  }else if(!after.done||before.account_count!==Number(r.stock_account_count)
    ||!same({...after,done:false},before))fail();
  const delta=BigInt(after.typed_utf8_bytes)-BigInt(before.typed_utf8_bytes),rows=entry?entry.primary_count+entry.secondary_count:0;
  if(delta<BigInt(rows)||delta>32_000_000n||rows===0&&delta!==0n||Buffer.byteLength(json(r))>16000)fail();
  return Object.freeze({...r,...refs,previous,before,after,entry:entry===null?null:Object.freeze(entry)});
}
