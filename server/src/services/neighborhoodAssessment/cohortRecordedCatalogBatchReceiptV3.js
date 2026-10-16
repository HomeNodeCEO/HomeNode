import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortRecordedGroupPartitionBatchReceiptV3 } from './cohortRecordedGroupPartitionBatchReceiptV3.js';

const BASE=['binding','source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference','effective_date','stock_account_count','traversal_reference','profile_reference'];
const fail=()=>{throw new TypeError('cohort_recorded_catalog_batch_v3_invalid_receipt');};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function counts(v,total){const c=data(v,['assigned_accounts','unassigned_accounts','assigned_groups']);
  if(!Object.values(c).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000)
    ||c.assigned_accounts+c.unassigned_accounts!==total||c.assigned_groups>2048
    ||c.assigned_groups>c.assigned_accounts||(c.assigned_groups===0)!==(c.assigned_accounts===0))fail();
  return Object.freeze(c);}

/** Bounded transition DATA only. The actual native owner must replay EVERY
 * whole original, ENTIRE cache and ENTIRE native partition entry before ONE
 * transaction retains its group increments, receipt/head/checkpoint/release.
 * Counts and entry hashes never replace complete semantic original replay. */
export function prepareCohortRecordedCatalogBatchReceiptV3(raw,expected){
  const r=data(raw,['format',...BASE,'sequence','previous','before','after','accounts','original_count','entries',
    'partition_reference','before_counts','after_counts']),e=data(expected,[...BASE,'partition_reference']);
  if(r.format!=='cohort_recorded_catalog_batch_receipt_v3')fail();
  const p=data(r.partition_reference,['content_sha256','canonical_utf8_bytes']),
    partition=prepareNeighborhoodCohortBlobReference(p.content_sha256,p.canonical_utf8_bytes);
  if(Number(partition.canonical_utf8_bytes)>16000||json(partition)!==json(e.partition_reference))fail();
  const base=prepareCohortRecordedGroupPartitionBatchReceiptV3({format:'cohort_recorded_group_partition_batch_receipt_v3',
    ...Object.fromEntries(BASE.map(k=>[k,r[k]])),sequence:r.sequence,previous:r.previous,before:r.before,after:r.after,
    accounts:r.accounts,original_count:r.original_count,entries:r.entries},Object.fromEntries(BASE.map(k=>[k,e[k]])));
  const before=counts(r.before_counts,base.before.account_count),after=counts(r.after_counts,base.after.account_count),
    assigned=base.entries.filter(entry=>entry.state==='assigned').length;
  if(after.assigned_accounts-before.assigned_accounts!==assigned
    ||after.unassigned_accounts-before.unassigned_accounts!==base.entries.length-assigned
    ||after.assigned_groups<before.assigned_groups||after.assigned_groups>before.assigned_groups+assigned
    ||base.after.done&&json(before)!==json(after))fail();
  return Object.freeze({...base,format:r.format,partition_reference:partition,before_counts:before,after_counts:after});
}
