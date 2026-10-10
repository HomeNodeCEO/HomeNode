import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortRecordedGroupPartitionReceiptV2 } from './cohortRecordedGroupPartitionReceiptV2.js';

const BASE=['binding','source_reference','root','graph_verification_reference','stock_verification_reference',
  'identity_verification_reference','stock_reference','effective_date','stock_account_count','traversal_reference','profile_reference'];
const fail=()=>{throw new TypeError('cohort_recorded_catalog_v2_invalid_receipt');};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail();
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function counts(v,total){const c=data(v,['assigned_accounts','unassigned_accounts','assigned_groups']);
  if(!Object.values(c).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000)
    ||c.assigned_accounts+c.unassigned_accounts!==total||c.assigned_groups>2048
    ||c.assigned_groups>c.assigned_accounts||(c.assigned_groups===0)!==(c.assigned_accounts===0))fail();
  return Object.freeze(c);}
/** Closed transition DATA, never source/selection authority. The actual owner
 * reconciles every whole original account and ENTIRE partition entry before
 * one native summary increment, issued head and retention checkpoint. */
export function prepareCohortRecordedCatalogReceiptV2(raw,expected){
  const r=data(raw,['format',...BASE,'sequence','previous','before','after','entry_reference',
    'partition_reference','before_counts','after_counts']),e=data(expected,[...BASE,'partition_reference']);
  if(r.format!=='cohort_recorded_catalog_receipt_v2')fail();
  const p=data(r.partition_reference,['content_sha256','canonical_utf8_bytes']),
    partition=prepareNeighborhoodCohortBlobReference(p.content_sha256,p.canonical_utf8_bytes);
  if(Number(partition.canonical_utf8_bytes)>16000||json(partition)!==json(e.partition_reference))fail();
  const base=prepareCohortRecordedGroupPartitionReceiptV2({format:'cohort_recorded_group_partition_receipt_v2',
    ...Object.fromEntries(BASE.map(k=>[k,r[k]])),sequence:r.sequence,previous:r.previous,before:r.before,after:r.after,
    entry_reference:r.entry_reference},Object.fromEntries(BASE.map(k=>[k,e[k]])));
  const before=counts(r.before_counts,base.before.account_count),after=counts(r.after_counts,base.after.account_count);
  if(base.after.done?json(before)!==json(after)
    :after.assigned_accounts<before.assigned_accounts||after.unassigned_accounts<before.unassigned_accounts
      ||after.assigned_groups<before.assigned_groups||after.assigned_groups>before.assigned_groups+1
      ||after.assigned_accounts===before.assigned_accounts&&after.assigned_groups!==before.assigned_groups)fail();
  return Object.freeze({...base,format:r.format,partition_reference:partition,before_counts:before,after_counts:after});
}
