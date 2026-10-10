import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const PARENTS=`FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
    AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
    AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
    AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
    AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000`;
const DONE=`u.command_id=$9::uuid AND u.receipt_reference=$10::jsonb
  AND fifth.command_id=$9::uuid AND fifth.union_reference=u.receipt_reference AND fifth.receipt_reference=$11::jsonb
  AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
  AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
  AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
  AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
  AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
  AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'`;
const fail=r=>{throw new TypeError(`custom_cohort_selected_evidence_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function anchor(v){if(v===null)return null;const a=data(v,['command_id','union_reference','eligibility_reference','receipt_reference','sequence']);
  if(typeof a.command_id!=='string'||!UUID.test(a.command_id)||!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...a,union_reference:ref(a.union_reference),eligibility_reference:ref(a.eligibility_reference),receipt_reference:ref(a.receipt_reference)});}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
/** UNMOUNTED sixth-pass storage candidate, not source/selection authority.
 * Runtime use requires the additive native head/checkpoint/deferred guards and
 * an actual bounded current-authorized original owner. The owner must reopen
 * every original and ALL current/ending fences, then atomically retain head,
 * receipt, checkpoint and single-use continuation in this caller transaction.
 * No caller ordinal/cursor/DONE/decision/observations or source callback. */
export function createCustomCohortSelectedEvidenceV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id','union_reference','eligibility_reference']),{client}=o,
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']),
    union=ref(o.union_reference),eligibility=ref(o.eligibility_reference);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,o.actorUserId],
    bound=[...values,o.command_id,json(union),json(eligibility)];
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-selected-evidence-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const read=async()=>{const r=data(one(await client.query(`/* custom-cohort-selected-evidence-v2:head-read */
    SELECT head.command_id::text,head.union_reference,head.eligibility_reference,head.receipt_reference,head.sequence
    ${PARENTS}
    LEFT JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads head ON head.operation_id=job.operation_id AND head.organization_id=job.organization_id
    WHERE ${FENCE} AND ${DONE}`,bound)),['command_id','union_reference','eligibility_reference','receipt_reference','sequence']);
    if(Object.values(r).every(v=>v===null))return null;const a=anchor(r);
    if(a.command_id!==o.command_id||!same(a.union_reference,union)||!same(a.eligibility_reference,eligibility))fail('binding_changed');return a;};
  return Object.freeze({async read(...args){if(args.length)fail('invalid_input');return read();},async readNextSelectedEntry(...args){
    if(args.length)fail('invalid_input');
    const r=data(one(await client.query(`/* custom-cohort-selected-evidence-v2:next-selected-entry */
      SELECT r.account_id,r.ordinal,r.partition_ordinal,r.entry_reference,entry.state,entry.assigned_group_id
      ${PARENTS}
      LEFT JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r ON r.operation_id=job.operation_id
        AND r.organization_id=job.organization_id AND r.ordinal=coalesce(h.sequence,0)+1
      LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=r.operation_id
        AND entry.organization_id=r.organization_id AND entry.account_id=r.account_id AND entry.ordinal=r.partition_ordinal
        AND entry.entry_reference=r.entry_reference
      WHERE ${FENCE} AND ${DONE}
        AND ((h.operation_id IS NULL AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
          OR (h.command_id=$9::uuid AND h.union_reference=$10::jsonb AND h.eligibility_reference=$11::jsonb
            AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)))`,bound)),
      ['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id']);
    if(Object.values(r).every(v=>v===null))return null;
    if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()||r.account_id.trim()!==r.account_id
      ||/[\u0000-\u001f\u007f]/.test(r.account_id)||![r.ordinal,r.partition_ordinal].every(n=>Number.isInteger(n)&&n>=1&&n<=2000000)
      ||!['assigned','unassigned'].includes(r.state)||(r.state==='assigned'?typeof r.assigned_group_id!=='string'
        ||!/^recorded-cad:[a-f0-9]{64}$/.test(r.assigned_group_id):r.assigned_group_id!==null))fail('corrupt');
    return Object.freeze({...r,entry_reference:ref(r.entry_reference,1000000)});
  },async advance(...args){
    if(args.length!==2)fail('invalid_input');
    const expected=anchor(args[0]),receipt=ref(args[1]),sequence=(expected?.sequence??0)+1,started=await tx();
    if(sequence>2000001)fail('corrupt');if(await tx()!==started)fail('caller_transaction_required');
    if(!same(await read(),expected))fail('conflict');
    const r=expected===null?await client.query(`/* custom-cohort-selected-evidence-v2:head-insert */
      INSERT INTO app.neighborhood_custom_cohort_selected_evidence_v2_heads(operation_id,organization_id,command_id,union_reference,eligibility_reference,receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,$9::uuid,$10::jsonb,$11::jsonb,$12::jsonb,1
      ${PARENTS} WHERE ${FENCE} AND ${DONE}
        AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
      RETURNING sequence`,[...bound,json(receipt)])
      :await client.query(`/* custom-cohort-selected-evidence-v2:head-advance */
        UPDATE app.neighborhood_custom_cohort_selected_evidence_v2_heads head SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} AND head.operation_id=job.operation_id
          AND head.organization_id=job.organization_id AND head.command_id=$11::uuid AND head.union_reference=$12::jsonb
          AND head.eligibility_reference=$13::jsonb AND head.receipt_reference=$14::jsonb AND head.sequence=$15::integer RETURNING head.sequence`,
        [...values,json(receipt),sequence,o.command_id,json(union),json(eligibility),json(expected.receipt_reference),expected.sequence]);
    if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
    if(!same(stored,{command_id:o.command_id,union_reference:union,eligibility_reference:eligibility,receipt_reference:receipt,sequence})
      ||await tx()!==started)fail('corrupt');return stored;
  }});
}
