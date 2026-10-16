import { isProxy } from 'node:util/types';
import { prepareCohortStockTraversalBatchReceiptV3 } from './cohortStockTraversalBatchReceiptV3.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { canonicalAssessmentJson as json } from './contract.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from './neighborhoodOriginalRecordedGroupV2.js';

const BASE=['binding','source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference','effective_date','stock_account_count'];
const EXTRA=['traversal_reference','profile_reference'];
const fail=()=>{throw new TypeError('cohort_recorded_group_partition_batch_v3_invalid_receipt');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(raw,max){const r=data(raw,['content_sha256','canonical_utf8_bytes']),
  result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>max)fail();return result;}

/** Closed bounded transition DATA, never native/source/membership authority.
 * The actual owner replays every whole original/ENTIRE cache under one budget;
 * native guards must independently bind every consecutive row, its ordinal and
 * immutable entry to this ONE receipt/head/checkpoint/continuation transaction.
 * Every later semantic consumer still reopens and compares the ENTIRE entry. */
export function prepareCohortRecordedGroupPartitionBatchReceiptV3(raw,expected){
  const r=data(raw,['format',...BASE,...EXTRA,'sequence','previous','before','after','accounts','original_count','entries']),
    e=data(expected,[...BASE,...EXTRA]);
  if(r.format!=='cohort_recorded_group_partition_batch_receipt_v3')fail();
  const traversal=ref(r.traversal_reference,16000),profile=ref(r.profile_reference,16000),
    fixed=getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref;
  if(json(traversal)!==json(e.traversal_reference)||json(profile)!==json(e.profile_reference)||json(profile)!==json(fixed))fail();
  const base=prepareCohortStockTraversalBatchReceiptV3({format:'cohort_stock_traversal_batch_receipt_v3',
    ...Object.fromEntries(BASE.map(k=>[k,r[k]])),sequence:r.sequence,previous:r.previous,before:r.before,after:r.after,
    accounts:r.accounts,original_count:r.original_count},Object.fromEntries(BASE.map(k=>[k,e[k]])));
  if(!Array.isArray(r.entries)||isProxy(r.entries)||Object.getPrototypeOf(r.entries)!==Array.prototype
    ||r.entries.length!==base.accounts.length)fail();
  const ds=Object.getOwnPropertyDescriptors(r.entries);
  if(Reflect.ownKeys(ds).length!==r.entries.length+1)fail();
  const entries=Array.from({length:r.entries.length},(_,index)=>{
    const d=ds[index];if(!d?.enumerable||!Object.hasOwn(d,'value'))fail();
    const entry=data(d.value,['account_id','ordinal','entry_reference','state','assigned_group_id']);
    if(entry.account_id!==base.accounts[index].account_id||entry.ordinal!==base.before.account_count+index+1
      ||!['assigned','unassigned'].includes(entry.state)
      ||(entry.state==='assigned'?typeof entry.assigned_group_id!=='string'||!/^recorded-cad:[a-f0-9]{64}$/.test(entry.assigned_group_id)
        :entry.assigned_group_id!==null))fail();
    return Object.freeze({...entry,entry_reference:ref(entry.entry_reference,1000000)});
  });
  return Object.freeze({...base,format:r.format,traversal_reference:traversal,profile_reference:profile,entries:Object.freeze(entries)});
}
