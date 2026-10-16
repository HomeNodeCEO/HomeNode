import { isProxy } from 'node:util/types';
import { prepareCohortStockTraversalReceiptV2 } from './cohortStockTraversalReceiptV2.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from './contract.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from './neighborhoodOriginalRecordedGroupV2.js';

const EXTRA=['traversal_reference','profile_reference'];
const BASE=['binding','source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference','effective_date','stock_account_count'];
const fail=()=>{throw new TypeError('cohort_recorded_group_partition_v2_invalid_receipt');};
/** Closed detached DATA only. Native issuance and original replay are separate. */
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
/** Small prerequisite metadata; the per-account group blob is separately bounded. */
function ref(raw,max){const r=data(raw,['content_sha256','canonical_utf8_bytes']),
  result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>max)fail();return result;}
/** Original-backed account partition progress, NOT selected-union authority.
 * Each nonempty step must commit its derived group blob, immutable ordinal row,
 * independent native head and retention checkpoint in the SAME owner TX.
 * Every later semantic consumer must reopen the original account and compare
 * the ENTIRE result; valid hashes/counts/ordinals are not original authority. */
export function prepareCohortRecordedGroupPartitionReceiptV2(raw,expected){
  const r=data(raw,['format',...BASE,...EXTRA,'sequence','previous','before','after','entry_reference']),
    e=data(expected,[...BASE,...EXTRA]);
  if(r.format!=='cohort_recorded_group_partition_receipt_v2')fail();
  const traversal=ref(r.traversal_reference,16000),profile=ref(r.profile_reference,16000),
    fixed=getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref;
  if(json(traversal)!==json(e.traversal_reference)||json(profile)!==json(e.profile_reference)||json(profile)!==json(fixed))fail();
  const base=prepareCohortStockTraversalReceiptV2({format:'cohort_stock_traversal_receipt_v2',
    ...Object.fromEntries(BASE.map(k=>[k,r[k]])),sequence:r.sequence,previous:r.previous,before:r.before,after:r.after},
  Object.fromEntries(BASE.map(k=>[k,e[k]])));
  const entry=r.entry_reference===null?null:ref(r.entry_reference,1000000);
  if(base.after.done!==(entry===null))fail();
  return Object.freeze({...base,format:r.format,traversal_reference:traversal,profile_reference:profile,entry_reference:entry});
}
