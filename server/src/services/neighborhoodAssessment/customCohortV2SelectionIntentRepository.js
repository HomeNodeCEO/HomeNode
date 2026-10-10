import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint, prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { getNeighborhoodOriginalRecordedGroupV2Profile } from './neighborhoodOriginalRecordedGroupV2.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_v2_selection_intent_${reason}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('operation_unavailable');return r.rows[0];}
function ref(v){const r=data(v,['content_sha256','canonical_utf8_bytes']);return prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);}
function integer(v){if(!Number.isSafeInteger(v)||v<1||v>2147483647)fail('invalid_workspace_revision');return v;}

/** Explicit bounded human intent only, never an account roster, source facts,
 * eligible membership, aggregate, publication, or prior-choice inference. */
export function prepareCustomCohortV2SelectionIntent(value){
  const v=data(value,['command_id','catalog_reference','workspace_revision','included_recorded_group_ids']);
  if(typeof v.command_id!=='string'||!UUID.test(v.command_id))fail('invalid_command');
  const reference=ref(v.catalog_reference);
  if(Number(reference.canonical_utf8_bytes)>16000)fail('invalid_catalog_reference');
  // Reject Proxy arrays before the shared closed descriptor grammar, including
  // index getters, sparse arrays, symbols, duplicates and unknown ID syntax.
  if(isProxy(v.included_recorded_group_ids))fail('invalid_group_ids');
  const groups=prepareCustomNeighborhoodRecordedGroupIds(v.included_recorded_group_ids,3);
  const result=Object.freeze({command_id:v.command_id,catalog_reference:reference,
    workspace_revision:integer(v.workspace_revision),included_recorded_group_ids:groups});
  if(Buffer.byteLength(json(result))>200000)fail('byte_limit');
  return result;
}

/** Closed storage/claim primitive, NOT current-user/source authority. Called
 * only INSIDE the actual original owner's transaction after current private
 * draft/assignment/actor and pending workspace/prior-head checks. All original
 * and ending fences must succeed before COMMIT; otherwise command AND lease
 * roll back. No caller claim, lease, head, profile, schedule, reset or adapter. */
export function createCustomCohortV2SelectionIntentRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-v2-selection-intent:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({async resume(operationId,raw){
    const o=data(raw,['scope','actorUserId','intent','workspaceTarget']),scope=data(o.scope,
      ['organization_id','report_file_id','assignment_file_id','account_id']),intent=prepareCustomCohortV2SelectionIntent(o.intent),
      target=data(o.workspaceTarget,['authority','workspace_revision','workspace_checkpoint']);
    if(![operationId,scope.organization_id,scope.report_file_id,o.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
      ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
      ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
      ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
      ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
    const workspace=prepareCustomNeighborhoodWorkspaceCheckpoint(target.workspace_checkpoint);
    if(target.authority!=='prior_workspace_target_only_not_new_selection'||integer(target.workspace_revision)!==intent.workspace_revision
      ||workspace.workspace_version!==7||workspace.pending_capture?.operation_id!==operationId)fail('workspace_changed');
    const values=[operationId,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const job=data(one(await client.query(`/* custom-cohort-v2-selection-intent:job-lock */
      SELECT job.status,job.attempts,job.claim_token::text,job.lease_expires_at>clock_timestamp() AS live,
        job.request_sha256,job.checkpoint
      FROM app.neighborhood_custom_cohort_capture_jobs job
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid AND job.report_file_id=$3::uuid
        AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid
        AND job.status IN ('awaiting_selection','running') AND job.cancellation_requested_at IS NULL
        AND job.context_sha256 IS NULL FOR UPDATE NOWAIT`,values)),
      ['status','attempts','claim_token','live','request_sha256','checkpoint']);
    if(!Number.isInteger(job.attempts)||job.attempts<1||job.attempts>5||!(/^[a-f0-9]{64}$/.test(job.request_sha256??''))
      ||job.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||job.checkpoint?.evidence_refs?.length!==9
      ||!same(job.checkpoint.evidence_refs[8],intent.catalog_reference))fail('checkpoint_changed');
    const profile=getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref;
    const expected={command_id:intent.command_id,request_sha256:job.request_sha256,checkpoint:job.checkpoint,
      profile_reference:profile,workspace_revision:intent.workspace_revision,workspace_checkpoint:workspace,
      included_group_ids:intent.included_recorded_group_ids,issued_attempts:job.attempts};
    const read=async()=>{
      const r=await client.query(`/* custom-cohort-v2-selection-intent:read */
        SELECT command_id::text,request_sha256,checkpoint,profile_reference,workspace_revision,workspace_checkpoint,
          included_group_ids,issued_attempts,resume_claim_token::text
        FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=$1::uuid AND organization_id=$2::uuid`,values.slice(0,2));
      if(r?.rowCount===0&&r.rows?.length===0)return null;
      const row=data(one(r),[...Object.keys(expected),'resume_claim_token']);
      if(!same(Object.fromEntries(Object.keys(expected).map(k=>[k,row[k]])),expected)
        ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token))fail('command_conflict');
      return row;
    };
    let command=await read(),replayed=command!==null;
    if(command===null){
      if(job.status!=='awaiting_selection'||job.claim_token!==null||job.live!==null)fail('waiting_required');
      await client.query(`/* custom-cohort-v2-selection-intent:insert */
        INSERT INTO app.neighborhood_custom_cohort_v2_selection_intents
          (operation_id,organization_id,command_id,request_sha256,checkpoint,profile_reference,
           workspace_revision,workspace_checkpoint,included_group_ids,issued_attempts,resume_claim_token)
        SELECT job.operation_id,job.organization_id,$7::uuid,job.request_sha256,job.checkpoint,head.profile_reference,
          $8::integer,$9::jsonb,$10::jsonb,job.attempts,gen_random_uuid()
        FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_recorded_catalog_v2_heads head USING(operation_id,organization_id)
        WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid AND job.report_file_id=$3::uuid
          AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid
          AND job.status='awaiting_selection' AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`,
      [...values,intent.command_id,intent.workspace_revision,json(workspace),json(intent.included_recorded_group_ids)]);
      command=await read();if(command===null)fail('operation_unavailable');
      const resumed=one(await client.query(`/* custom-cohort-v2-selection-intent:resume */
        UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status='running',claim_token=$7::uuid,lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
        WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid AND job.report_file_id=$3::uuid
          AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid
          AND job.status='awaiting_selection' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
          AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL AND job.attempts=$8::integer
        RETURNING operation_id::text,claim_token::text,attempts`,[...values,command.resume_claim_token,job.attempts]));
      if(!same(prepareCustomCohortCaptureJobClaim(resumed),{operation_id:operationId,claim_token:command.resume_claim_token,attempts:job.attempts}))fail('claim_lost');
    }else if(job.status!=='running'||job.claim_token!==command.resume_claim_token||job.live!==true)fail('claim_lost');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,replayed,
      claim:prepareCustomCohortCaptureJobClaim({operation_id:operationId,claim_token:command.resume_claim_token,attempts:job.attempts}),
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  }});
}
