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
function authority(raw){
  const scope=data(raw.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![scope.organization_id,scope.report_file_id,raw.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  return scope;
}
function workspaceOf(raw,operationId){
  const target=data(raw,['authority','workspace_revision','workspace_checkpoint']),
    workspace=prepareCustomNeighborhoodWorkspaceCheckpoint(target.workspace_checkpoint);
  if(target.authority!=='prior_workspace_target_only_not_new_selection'||workspace.workspace_version!==7
    ||workspace.pending_capture?.operation_id!==operationId)fail('workspace_changed');
  return {revision:integer(target.workspace_revision),checkpoint:workspace};
}

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
    const o=data(raw,['scope','actorUserId','intent','workspaceTarget']),scope=authority(o),
      intent=prepareCustomCohortV2SelectionIntent(o.intent),target=workspaceOf(o.workspaceTarget,operationId),workspace=target.checkpoint;
    if(typeof operationId!=='string'||!UUID.test(operationId))fail('invalid_scope');
    if(target.revision!==intent.workspace_revision)fail('workspace_changed');
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
  },
  /** Read-only worker primitive, NOT a human resume/retry/reset operation. The
   * actual owner supplies today's scoped live claim and locked pending target,
   * after CURRENT source policy. IDs come ONLY from the immutable command.
   * A normal replacement attempt may reopen it; the original resume endpoint
   * still cannot mint a new lease or replay against that replacement claim. */
  async readRetained(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:retained-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint']);
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||!same(row.checkpoint,row.job_checkpoint)||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'
      ||!Array.isArray(row.checkpoint.evidence_refs)||row.checkpoint.evidence_refs.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)
      ||(claim.attempts===row.issued_attempts)!==(claim.claim_token===row.resume_claim_token))fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Separate fourth-pass reader. The old nine-root readRetained/resume paths
   * stay strict. A successful same-attempt fresh token is admitted ONLY by the
   * actual native fourth-phase head/checkpoint AND consumed continuation. */
  async readForReplay(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:replay-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce((job.checkpoint=command.checkpoint AND head.operation_id IS NULL)
          OR (app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
            AND c.phase='frozen_selected_union_refs_v2' AND c.progress_reference=head.receipt_reference
            AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
            AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
              OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
                AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token))),false) AS replay_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
      LEFT JOIN app.neighborhood_custom_cohort_v2_continuations c USING(operation_id,organization_id)
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','replay_binding']);
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.replay_binding!==true)fail('checkpoint_changed');
    const initial=same(row.checkpoint,row.job_checkpoint),progressed=row.job_checkpoint?.phase==='frozen_selected_union_refs_v2'
      &&row.job_checkpoint.evidence_refs?.length===10&&same(row.job_checkpoint.evidence_refs.slice(0,9),row.checkpoint.evidence_refs);
    if(!initial&&!progressed)fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)
      ||(initial?(claim.attempts===row.issued_attempts)!==(claim.claim_token===row.resume_claim_token)
        :claim.claim_token===row.resume_claim_token))fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Separate fifth-pass admission. Neither original human resume nor the
   * strict nine/ten-root readers can consume eleven roots. Requires a DONE
   * native union and its consumed single-use continuation (or ordinary higher
   * failure attempt), with exact immutable command/workspace and first9 roots. */
  async readForEligibility(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:eligibility-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND ((h.operation_id IS NULL AND c.phase='frozen_selected_union_refs_v2' AND c.progress_reference=u.receipt_reference
              AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
            OR (c.phase='frozen_selected_eligibility_refs_v2' AND c.progress_reference=h.receipt_reference
              AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)))
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS eligibility_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=u.organization_id
        AND body.content_sha256=u.receipt_reference->>'content_sha256'
        AND body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','eligibility_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.eligibility_binding!==true||!['frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_union_refs_v2'?10:11)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  }});
}
