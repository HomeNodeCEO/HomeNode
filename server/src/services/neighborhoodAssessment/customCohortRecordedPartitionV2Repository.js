import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const BINDINGS=['source_reference','root_reference','graph_reference','geographic_reference','identity_reference',
  'stock_reference','traversal_reference','profile_reference'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`;
const fail=reason=>{throw new TypeError(`custom_cohort_recorded_partition_v2_${reason}`);};
const same=(a,b)=>json(a)===json(b);
/** Closed DATA prevents a caller continuation/payload from entering this store. */
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(raw,max=16000){const r=data(raw,['content_sha256','canonical_utf8_bytes']),
  result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>max)fail('invalid_reference');return result;}
function anchorOf(raw){if(raw===null)return null;const a=data(raw,[...BINDINGS,'receipt_reference','sequence']);
  if(!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...Object.fromEntries([...BINDINGS,'receipt_reference'].map(k=>[k,ref(a[k])])),sequence:a.sequence});}
function entryOf(raw){if(raw===null)return null;const e=data(raw,['account_id','ordinal','entry_reference','state','assigned_group_id']);
  if(typeof e.account_id!=='string'||!e.account_id||e.account_id.length>64||!e.account_id.isWellFormed()
    ||e.account_id.trim()!==e.account_id||/[\u0000-\u001f\u007f]/.test(e.account_id)
    ||!Number.isInteger(e.ordinal)||e.ordinal<1||e.ordinal>2000000||!['assigned','unassigned'].includes(e.state)
    ||(e.state==='assigned'?typeof e.assigned_group_id!=='string'||!/^recorded-cad:[a-f0-9]{64}$/.test(e.assigned_group_id)
      :e.assigned_group_id!==null))fail('invalid_entry');
  return Object.freeze({...e,entry_reference:ref(e.entry_reference,1000000)});}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}

/** Fixed owner-only native CAS/ordinal store. This repository does NOT acquire
 * originals or authorize a user. Its trusted caller must own one bounded TX,
 * replay the complete original account/ENTIRE cache, and fence current rights
 * both ends. Deferred native guards refuse orphan rows or a free head. */
export function createCustomCohortRecordedPartitionV2Repository(raw){
  const input=data(raw,['client','claim','scope','actorUserId',...BINDINGS]),{client,actorUserId}=input,
    claim=prepareCustomCohortCaptureJobClaim(input.claim),scope=data(input.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const frozen=Object.fromEntries(BINDINGS.map(k=>[k,ref(input[k])])),values=[claim.operation_id,claim.claim_token,claim.attempts,
    scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,actorUserId];
  const read=async()=>{const row=one(await client.query(`/* custom-cohort-recorded-partition-v2:anchor-read */
    SELECT anchor.source_reference,anchor.root_reference,anchor.graph_reference,anchor.geographic_reference,
      anchor.identity_reference,anchor.stock_reference,anchor.traversal_reference,anchor.profile_reference,anchor.receipt_reference,anchor.sequence
    FROM app.neighborhood_custom_cohort_capture_jobs job
    LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_heads anchor ON anchor.operation_id=job.operation_id
    WHERE ${FENCE}`,values));
    if([...BINDINGS,'receipt_reference','sequence'].every(k=>row[k]===null))return null;
    const anchor=anchorOf(row);if(!BINDINGS.every(k=>same(anchor[k],frozen[k])))fail('binding_changed');return anchor;};
  const txid=async()=>{const id=one(await client.query('/* custom-cohort-recorded-partition-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({read,async advance(rawExpected,rawReceipt,rawEntry){
    const expected=anchorOf(rawExpected),receipt=ref(rawReceipt),entry=entryOf(rawEntry),sequence=(expected?.sequence??0)+1;
    if(sequence>2000001||entry&&entry.ordinal!==sequence||expected&&!BINDINGS.every(k=>same(expected[k],frozen[k])))fail('binding_changed');
    const started=await txid();if(await txid()!==started)fail('caller_transaction_required');
    if(!same(await read(),expected))fail('conflict');
    if(entry){const inserted=await client.query(`/* custom-cohort-recorded-partition-v2:entry-insert */
      INSERT INTO app.neighborhood_custom_cohort_recorded_partition_v2_rows
        (operation_id,organization_id,account_id,ordinal,entry_reference,state,assigned_group_id)
      SELECT job.operation_id,job.organization_id,$9,$10::integer,$11::jsonb,$12,$13
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} RETURNING ordinal`,
    [...values,entry.account_id,entry.ordinal,json(entry.entry_reference),entry.state,entry.assigned_group_id]);
      if(one(inserted).ordinal!==entry.ordinal)fail('corrupt');}
    const bound=BINDINGS.map(k=>json(frozen[k])),receiptJson=json(receipt);
    const result=expected===null?await client.query(`/* custom-cohort-recorded-partition-v2:anchor-insert */
      INSERT INTO app.neighborhood_custom_cohort_recorded_partition_v2_heads
        (operation_id,organization_id,source_reference,root_reference,graph_reference,geographic_reference,identity_reference,stock_reference,traversal_reference,profile_reference,receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,1
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
      ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`,[...values,...bound,receiptJson])
      :await client.query(`/* custom-cohort-recorded-partition-v2:anchor-advance */
        UPDATE app.neighborhood_custom_cohort_recorded_partition_v2_heads anchor SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
          AND anchor.operation_id=job.operation_id AND anchor.organization_id=job.organization_id
          AND anchor.source_reference=$11::jsonb AND anchor.root_reference=$12::jsonb AND anchor.graph_reference=$13::jsonb
          AND anchor.geographic_reference=$14::jsonb AND anchor.identity_reference=$15::jsonb AND anchor.stock_reference=$16::jsonb
          AND anchor.traversal_reference=$17::jsonb AND anchor.profile_reference=$18::jsonb
          AND anchor.receipt_reference=$19::jsonb AND anchor.sequence=$20::integer RETURNING anchor.sequence`,
        [...values,receiptJson,sequence,...bound,json(expected.receipt_reference),expected.sequence]);
    if(one(result).sequence!==sequence)fail('corrupt');
    const stored=await read();if(!same(stored,{...frozen,receipt_reference:receipt,sequence}))fail('corrupt');
    if(await txid()!==started)fail('caller_transaction_required');return stored;
  }});
}
