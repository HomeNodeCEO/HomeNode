import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareNeighborhoodFrozenStockOriginalProgress } from './neighborhoodFrozenJobStockOriginals.js';

const FORMAT = 'cohort_geographic_original_receipt_v2';
const KEYS = ['format','binding','source_reference','root','graph_verification_reference','stock_reference',
  'sequence','previous','before','after'];
const same = (a,b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
function fail(){throw new TypeError('cohort_geographic_original_receipt_v2_invalid_receipt');}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(raw){
  const r=data(raw,['content_sha256','canonical_utf8_bytes']);
  const result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>16000)fail();
  return result;
}

/** Closed geographic transition DATA only. The real owner must obtain this
 * receipt through its independent issued-head anchor, never an arbitrary blob
 * or caller cursor. SQL separately proves the next exact stock-PK prefix;
 * original EWKB/key/account checks and current rights remain owner-side. */
export function prepareCohortGeographicOriginalReceiptV2(raw,expected){
  const r=data(raw,KEYS),e=data(expected,['binding','source_reference','root','graph_verification_reference','stock_reference']);
  const binding=data(r.binding,['organization_id','report_file_id','assignment_file_id','account_id','operation_id',
    'generation_id','spatial_definition_sha256','source_original_sha256']);
  if(r.format!==FORMAT||!same(binding,e.binding)||!Number.isInteger(r.sequence)||r.sequence<1||r.sequence>200000)fail();
  const references=Object.fromEntries(['source_reference','root','graph_verification_reference','stock_reference'].map(key=>[key,ref(r[key])]));
  if(!Object.keys(references).every(key=>same(references[key],e[key])))fail();
  const previous=r.previous===null?null:ref(r.previous);
  const before=prepareNeighborhoodFrozenStockOriginalProgress(r.before),after=prepareNeighborhoodFrozenStockOriginalProgress(r.after);
  if(!before||!after||before.done||before.stock_sha256!==after.stock_sha256||(r.sequence===1)!==(previous===null))fail();
  if(r.sequence===1&&(before.after_object_id!==null||before.verified_parcels!==0||before.verified_unassociated!==0))fail();
  const delta=after.verified_parcels-before.verified_parcels,unassociated=after.verified_unassociated-before.verified_unassociated;
  if(delta<0||delta>250||unassociated<0||unassociated>delta
    ||delta===0&&(!after.done||after.after_object_id!==before.after_object_id)
    ||delta>0&&(after.after_object_id===null||before.after_object_id!==null
      &&BigInt(after.after_object_id)<=BigInt(before.after_object_id)))fail();
  // A full 250-row last page intentionally needs a separate empty terminal
  // query. A short nonterminal page is also valid under the 8-MB admission cap.
  return Object.freeze({...r,...references,binding:Object.freeze(binding),previous,before,after});
}
