import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const fail=r=>{throw new TypeError(`custom_cohort_selected_union_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function anchor(v){if(v===null)return null;const a=data(v,['command_id','receipt_reference','sequence']);
  if(typeof a.command_id!=='string'||!UUID.test(a.command_id)||!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...a,receipt_reference:ref(a.receipt_reference)});}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
/** Closed native storage only, NOT original/source/selection authority. Actual
 * owner independently replays every original/entire cache/partition entry,
 * compares catalog literals and fences current authority BEFORE these writes.
 * All rows/head/checkpoint/single-consume continuation commit in that SAME TX. */
export function createCustomCohortSelectedUnionV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id']),{client}=o,
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,o.actorUserId];
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-selected-union-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const read=async()=>{const r=data(one(await client.query(`/* custom-cohort-selected-union-v2:head-read */
    SELECT head.command_id::text,head.receipt_reference,head.sequence
    FROM app.neighborhood_custom_cohort_capture_jobs job
    JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
    LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
    WHERE ${FENCE} AND command.command_id=$9::uuid`,[...values,o.command_id])),['command_id','receipt_reference','sequence']);
    if(Object.values(r).every(v=>v===null))return null;const a=anchor(r);if(a.command_id!==o.command_id)fail('binding_changed');return a;};
  const counts=async()=>{const r=data(one(await client.query(`/* custom-cohort-selected-union-v2:counts */
    SELECT coalesce(sum(g.member_count) FILTER(WHERE g.group_id<>'discovery:unassigned'),0)::integer AS assigned_accounts,
      coalesce(sum(g.member_count) FILTER(WHERE g.group_id='discovery:unassigned'),0)::integer AS unassigned_accounts,
      count(g.group_id) FILTER(WHERE g.group_id<>'discovery:unassigned')::integer AS assigned_groups,
      coalesce((SELECT r.ordinal FROM app.neighborhood_custom_cohort_selected_union_v2_rows r
        WHERE r.operation_id=job.operation_id AND r.organization_id=job.organization_id ORDER BY r.ordinal DESC LIMIT 1),0)::integer AS selected_count
    FROM app.neighborhood_custom_cohort_capture_jobs job
    LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_groups g USING(operation_id,organization_id)
    WHERE ${FENCE} GROUP BY job.operation_id`,values)),['assigned_accounts','unassigned_accounts','assigned_groups','selected_count']);
    if(!Object.values(r).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000)||r.assigned_accounts+r.unassigned_accounts>2000000
      ||r.assigned_groups>2048||r.assigned_groups>r.assigned_accounts||r.selected_count>r.assigned_accounts+r.unassigned_accounts)fail('corrupt');
    return Object.freeze(r);};
  return Object.freeze({read,counts,async contribute(rawExpected,rawEntry){
    const expected=anchor(rawExpected),e=data(rawEntry,['account_id','partition_ordinal','entry_reference','group_id']);
    if(typeof e.account_id!=='string'||!e.account_id||e.account_id.length>64||!e.account_id.isWellFormed()
      ||e.account_id.trim()!==e.account_id||/[\u0000-\u001f\u007f]/.test(e.account_id)
      ||!Number.isInteger(e.partition_ordinal)||e.partition_ordinal!==(expected?.sequence??0)+1||e.partition_ordinal>2000000
      ||typeof e.group_id!=='string'||!/^(recorded-cad:[a-f0-9]{64}|discovery:unassigned)$/.test(e.group_id))fail('invalid_entry');
    const entry=ref(e.entry_reference,1000000),started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    if(!same(await read(),expected))fail('conflict');
    const common=[...values,e.account_id,e.partition_ordinal,json(entry),e.group_id];
    if(one(await client.query(`/* custom-cohort-selected-union-v2:group-contribute */
      INSERT INTO app.neighborhood_custom_cohort_selected_union_v2_groups(operation_id,organization_id,group_id,member_count,last_ordinal)
      SELECT job.operation_id,job.organization_id,$12,1,$10::integer FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry USING(operation_id,organization_id)
      WHERE ${FENCE} AND entry.account_id=$9 AND entry.ordinal=$10::integer AND entry.entry_reference=$11::jsonb
        AND coalesce(entry.assigned_group_id,'discovery:unassigned')=$12
      ON CONFLICT(operation_id,group_id) DO UPDATE SET member_count=neighborhood_custom_cohort_selected_union_v2_groups.member_count+1,
        last_ordinal=EXCLUDED.last_ordinal RETURNING last_ordinal`,common)).last_ordinal!==e.partition_ordinal)fail('corrupt');
    const result=await client.query(`/* custom-cohort-selected-union-v2:member-insert */
      INSERT INTO app.neighborhood_custom_cohort_selected_union_v2_rows(operation_id,organization_id,account_id,ordinal,partition_ordinal,entry_reference)
      SELECT job.operation_id,job.organization_id,entry.account_id,
        coalesce((SELECT r.ordinal FROM app.neighborhood_custom_cohort_selected_union_v2_rows r
          WHERE r.operation_id=job.operation_id AND r.organization_id=job.organization_id ORDER BY r.ordinal DESC LIMIT 1),0)+1,
        entry.ordinal,entry.entry_reference FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry USING(operation_id,organization_id)
      WHERE ${FENCE} AND entry.account_id=$9 AND entry.ordinal=$10::integer AND entry.entry_reference=$11::jsonb
        AND coalesce(entry.assigned_group_id,'discovery:unassigned')=$12 AND command.included_group_ids ? $12
      RETURNING ordinal`,common);
    if(!Array.isArray(result?.rows)||result.rowCount!==result.rows.length||result.rowCount>1)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');return counts();
  },async advance(rawExpected,rawReceipt){
    const expected=anchor(rawExpected),receipt=ref(rawReceipt),sequence=(expected?.sequence??0)+1,started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');if(!same(await read(),expected))fail('conflict');
    const r=expected===null?await client.query(`/* custom-cohort-selected-union-v2:head-insert */
      INSERT INTO app.neighborhood_custom_cohort_selected_union_v2_heads(operation_id,organization_id,command_id,receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,$9::uuid,$10::jsonb,1
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} RETURNING sequence`,[...values,o.command_id,json(receipt)])
      :await client.query(`/* custom-cohort-selected-union-v2:head-advance */
        UPDATE app.neighborhood_custom_cohort_selected_union_v2_heads head SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} AND head.operation_id=job.operation_id
          AND head.organization_id=job.organization_id AND head.command_id=$11::uuid AND head.receipt_reference=$12::jsonb
          AND head.sequence=$13::integer RETURNING head.sequence`,[...values,json(receipt),sequence,o.command_id,json(expected.receipt_reference),expected.sequence]);
    if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
    if(!same(stored,{command_id:o.command_id,receipt_reference:receipt,sequence})||await tx()!==started)fail('corrupt');return stored;
  }});
}
