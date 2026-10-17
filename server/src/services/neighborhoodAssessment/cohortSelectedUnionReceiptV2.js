import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortRecordedCatalogReceiptV2 } from './cohortRecordedCatalogReceiptV2.js';

const BASE=['binding','source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference','effective_date','stock_account_count','traversal_reference',
  'profile_reference','partition_reference'];
const fail=()=>{throw new TypeError('cohort_selected_union_v2_invalid_receipt');};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Transition DATA only. Actual source authority is the bounded DB owner's
 * independent whole-original/entire-cache/partition replay, never this receipt. */
export function prepareCohortSelectedUnionReceiptV2(raw,expected){
  const r=data(raw,['format',...BASE,'sequence','previous','before','after','entry_reference','before_counts','after_counts',
    'catalog_reference','command_id','before_selected_count','after_selected_count']),
    e=data(expected,[...BASE,'catalog_reference','command_id']);
  if(r.format!=='cohort_selected_union_receipt_v2'||r.command_id!==e.command_id
    ||typeof r.command_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.command_id))fail();
  const p=data(r.catalog_reference,['content_sha256','canonical_utf8_bytes']),
    catalog=prepareNeighborhoodCohortBlobReference(p.content_sha256,p.canonical_utf8_bytes);
  if(Number(catalog.canonical_utf8_bytes)>16000||json(catalog)!==json(e.catalog_reference))fail();
  const base=prepareCohortRecordedCatalogReceiptV2({format:'cohort_recorded_catalog_receipt_v2',
    ...Object.fromEntries(BASE.map(k=>[k,r[k]])),sequence:r.sequence,previous:r.previous,before:r.before,after:r.after,
    entry_reference:r.entry_reference,before_counts:r.before_counts,after_counts:r.after_counts},
  Object.fromEntries(BASE.map(k=>[k,e[k]])));
  const a=r.before_selected_count,b=r.after_selected_count;
  if(![a,b].every(n=>Number.isInteger(n)&&n>=0)||a>base.before.account_count||b>base.after.account_count
    ||b<a||b>a+1||base.after.done&&b!==a||base.sequence===1&&a!==0)fail();
  return Object.freeze({...base,format:r.format,catalog_reference:catalog,command_id:r.command_id,
    before_selected_count:a,after_selected_count:b});
}
