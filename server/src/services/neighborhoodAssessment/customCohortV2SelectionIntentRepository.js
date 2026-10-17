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
function retainedSourceCheckpoint(value,phase,length){
  const c=data(value,['phase','evidence_refs']),a=c.evidence_refs;
  if(c.phase!==phase||!Array.isArray(a)||isProxy(a)||Object.getPrototypeOf(a)!==Array.prototype
    ||a.length!==length||Reflect.ownKeys(a).length!==length+1)fail('checkpoint_changed');
  const roots=[];for(let i=0;i<length;i++){
    const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('checkpoint_changed');
    const r=ref(d.value);if(i>=14&&Number(r.canonical_utf8_bytes)>4096)fail('checkpoint_changed');roots.push(r);
  }
  const result=Object.freeze({phase:c.phase,evidence_refs:Object.freeze(roots)});
  if(Buffer.byteLength(json(result))>4096)fail('checkpoint_changed');return result;
}
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
  },
  /** Separate sixth-pass admission. Both the native selected union and the
   * recorded-eligibility parent must be DONE. No caller ordinal, token, roots
   * or source authority; strict older readers keep their original grammars. */
  async readForEvidence(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:evidence-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND ((h.operation_id IS NULL AND c.phase='frozen_selected_eligibility_refs_v2' AND c.progress_reference=fifth.receipt_reference
              AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
            OR (h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
              AND c.phase='frozen_selected_evidence_refs_v2' AND c.progress_reference=h.receipt_reference
              AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)))
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS evidence_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','evidence_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.evidence_binding!==true||!['frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_eligibility_refs_v2'?11:12)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Separate seventh-pass admission. Both the native selected union and the
   * recorded-eligibility AND sixth evidence parents must be DONE. No caller ordinal, token, roots
   * or source authority; strict older readers keep their original grammars. */
  async readForMetrics(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:metrics-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND ((h.operation_id IS NULL AND c.phase='frozen_selected_evidence_refs_v2' AND c.progress_reference=sixth.receipt_reference
              AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
            OR (h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
              AND h.evidence_reference=sixth.receipt_reference
              AND c.phase='frozen_selected_metrics_refs_v2' AND c.progress_reference=h.receipt_reference
              AND app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)))
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS metrics_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','metrics_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.metrics_binding!==true||!['frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_evidence_refs_v2'?12:13)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Read-only statistics source admission, not distribution authority. Exact13
   * roots and all FOUR DONE native parents; the owner must freshly reopen the
   * complete original graph/current rights and reconcile the stored metric row.
   * No widening of the strict sixth/seventh readers or caller cursor/roster. */
  async readForStatistics(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:statistics-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
          AND h.evidence_reference=sixth.receipt_reference
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase='frozen_selected_metrics_refs_v2' AND c.progress_reference=h.receipt_reference
          AND app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS statistics_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=h.organization_id
        AND metrics_body.content_sha256=h.receipt_reference->>'content_sha256'
        AND metrics_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','statistics_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.statistics_binding!==true||cp?.phase!=='frozen_selected_metrics_refs_v2'
      ||!Array.isArray(roots)||roots.length!==13
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Additive exact13/14 native contribution admission; old fixed-first reader stays exact13. */
  async readForStatisticsContributions(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:statistics-contributions-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
          AND h.evidence_reference=sixth.receipt_reference
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase=job.checkpoint->>'phase' AND c.progress_reference=job.checkpoint->'evidence_refs'->-1
          AND app.neighborhood_selected_statistics_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS contributions_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=h.organization_id
        AND metrics_body.content_sha256=h.receipt_reference->>'content_sha256'
        AND metrics_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','contributions_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.contributions_binding!==true||!['frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_metrics_refs_v2'?13:14)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  /** Strict exact14, all FIVE actual DONE parents. Read-only source boundary;
   * old exact13 and initial/progressed eighth readers remain unchanged. */
  async readForFrequencies(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:frequency-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
          AND h.evidence_reference=sixth.receipt_reference
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND eighth.command_id=command.command_id AND eighth.union_reference=u.receipt_reference
          AND eighth.eligibility_reference=fifth.receipt_reference AND eighth.evidence_reference=sixth.receipt_reference
          AND eighth.metrics_reference=h.receipt_reference
          AND contribution_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
          AND contribution_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND contribution_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND contribution_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND contribution_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase='frozen_selected_statistics_refs_v2' AND c.progress_reference=eighth.receipt_reference
          AND app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS frequency_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=h.organization_id
        AND metrics_body.content_sha256=h.receipt_reference->>'content_sha256'
        AND metrics_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth ON eighth.operation_id=job.operation_id AND eighth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs contribution_body ON contribution_body.organization_id=eighth.organization_id
        AND contribution_body.content_sha256=eighth.receipt_reference->>'content_sha256'
        AND contribution_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND contribution_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','frequency_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.frequency_binding!==true||cp?.phase!=='frozen_selected_statistics_refs_v2'
      ||!Array.isArray(roots)||roots.length!==14
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  // Separate strict14/strict15 ninth admission; no old command reader widens.
  async readForNumericPopulation(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:numeric-population-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
          AND h.evidence_reference=sixth.receipt_reference
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND eighth.command_id=command.command_id AND eighth.union_reference=u.receipt_reference
          AND eighth.eligibility_reference=fifth.receipt_reference AND eighth.evidence_reference=sixth.receipt_reference
          AND eighth.metrics_reference=h.receipt_reference
          AND contribution_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
          AND contribution_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND contribution_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND contribution_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND contribution_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase=job.checkpoint->>'phase'
          AND c.progress_reference=CASE WHEN c.phase='frozen_selected_statistics_refs_v2' THEN eighth.receipt_reference ELSE numeric_population.receipt_reference END
          AND app.neighborhood_selected_numeric_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS numeric_population_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=h.organization_id
        AND metrics_body.content_sha256=h.receipt_reference->>'content_sha256'
        AND metrics_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth ON eighth.operation_id=job.operation_id AND eighth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs contribution_body ON contribution_body.organization_id=eighth.organization_id
        AND contribution_body.content_sha256=eighth.receipt_reference->>'content_sha256'
        AND contribution_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND contribution_body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads numeric_population
        ON numeric_population.operation_id=job.operation_id AND numeric_population.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','numeric_population_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.numeric_population_binding!==true||!['frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_statistics_refs_v2'?14:15)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  // Separate exact15/exact16 semantic admission. Every old reader stays strict.
  async readForTransactionSource(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),started=await tx(),
      admitted=await createCustomCohortV2SelectionIntentRepository(client).readForSemanticStatistics(rawClaim,raw);
    // Additional exact16 DONE admission, not a widening of any old reader.
    // The actual owner still opens the whole issued graph and both-end rights.
    const row=one(await client.query(`/* custom-cohort-v2-selection-intent:completed-semantic-transaction-source */
      SELECT true AS complete FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads h USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id
        AND b.content_sha256=h.receipt_reference->>'content_sha256'
        AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=job.operation_id AND u.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
        AND ub.content_sha256=u.receipt_reference->>'content_sha256'
        AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
        AND h.command_id=$9::uuid AND h.command_id=u.command_id AND h.union_reference=u.receipt_reference
        AND app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
        AND b.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
        AND b.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'
        AND b.canonical_utf8::jsonb->'after'->'selected_ordinal'=ub.canonical_utf8::jsonb->'after_selected_count'`,
    [claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,
      scope.account_id,o.actorUserId,admitted.command_id]));
    if(row.complete!==true)fail('unfinished_selected_semantic');
    if(await tx()!==started)fail('caller_transaction_required');return admitted;
  },
  // Separate inactive exact16/17 admission for the eventual NEXT index owner.
  // Do NOT delegate to readForTransactionSource/readForSemanticStatistics or
  // project an actual17 checkpoint into their unchanged exact15/16 readers.
  async readForTransactionIndex(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:transaction-index-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(s.command_id=command.command_id AND u.command_id=command.command_id AND s.union_reference=u.receipt_reference
          AND semantic_body.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
          AND semantic_body.canonical_utf8::jsonb->>'sequence'=s.sequence::text AND semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND semantic_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND semantic_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase=job.checkpoint->>'phase'
          AND c.progress_reference=CASE WHEN c.phase='frozen_selected_semantic_refs_v2' THEN s.receipt_reference ELSE indexed.receipt_reference END
          AND app.neighborhood_selected_transaction_index_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS transaction_index_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs semantic_body ON semantic_body.organization_id=s.organization_id
        AND semantic_body.content_sha256=s.receipt_reference->>'content_sha256'
        AND semantic_body.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND semantic_body.canonical_utf8_bytes<=4096
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads indexed
        ON indexed.operation_id=job.operation_id AND indexed.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','transaction_index_binding']);
    // Validate closed native DATA before any canonical comparison. Native SQL,
    // not these reference arrays, proves the actual graph/continuation binding.
    const checkpoint=(raw,phase,length)=>{
      const c=data(raw,['phase','evidence_refs']),a=c.evidence_refs;
      if(c.phase!==phase||!Array.isArray(a)||isProxy(a)||Object.getPrototypeOf(a)!==Array.prototype
        ||a.length!==length||Reflect.ownKeys(a).length!==length+1)fail('checkpoint_changed');
      const roots=[];for(let i=0;i<length;i++){
        const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail('checkpoint_changed');
        const r=ref(d.value);if(i>=14&&Number(r.canonical_utf8_bytes)>4096)fail('checkpoint_changed');roots.push(r);
      }
      return Object.freeze({phase:c.phase,evidence_refs:Object.freeze(roots)});
    },phase=data(row.job_checkpoint,['phase','evidence_refs']).phase;
    if(!['frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'].includes(phase))fail('checkpoint_changed');
    const issued=checkpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      cp=checkpoint(row.job_checkpoint,phase,phase==='frozen_selected_semantic_refs_v2'?16:17),
      profile=ref(row.profile_reference),workspace=prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint);
    if(typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)||row.request_sha256!==row.job_request_sha256
      ||!same(profile,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)||row.transaction_index_binding!==true
      ||!same(cp.evidence_refs.slice(0,9),issued.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(workspace,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  // Separate owned18 admission. Retained17 comes ONLY from its entire native
  // immutable birth. The ordinary16/17 reader and initial token rules above
  // remain unchanged; no caller checkpoint or phase selects this protocol.
  async readForOwnedFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:owned-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_owned_first_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_owned_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForRecoveredFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:recovered-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_recovered_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_recovered_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForSecondFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:second-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_second_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_second_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForThirdFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:third-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_third_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_third_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForFourthFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:fourth-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_fourth_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_fourth_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForFifthFirstSource(...args){
    if(args.length!==2)fail('invalid_input');
    const claim=prepareCustomCohortCaptureJobClaim(data(args[0],['operation_id','claim_token','attempts'])),
      o=data(args[1],['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,scope.organization_id,claim.claim_token,claim.attempts,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:fifth-first-source-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,p.parent_checkpoint AS retained_birth_checkpoint
      FROM app.neighborhood_source_resolution_v3_fifth_parent($1::uuid,$2::uuid,$3::uuid,$4::integer) p
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id,command_id,request_sha256)
      JOIN app.neighborhood_source_resolution_v3_fifth_first($1::uuid,$2::uuid,$3::uuid,$4::integer) first_row
        USING(operation_id,organization_id)
      WHERE p.report_file_id=$5::uuid AND p.assignment_file_id=$6::bigint AND p.account_id=$7 AND p.actor_user_id=$8::uuid
      FOR SHARE OF command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token','retained_birth_checkpoint']);
    const issued=retainedSourceCheckpoint(row.checkpoint,'frozen_recorded_catalog_refs_v2',9),
      birth=retainedSourceCheckpoint(row.retained_birth_checkpoint,'frozen_selected_transaction_index_refs_v2',17);
    if(!same(birth.evidence_refs.slice(0,9),issued.evidence_refs)
      ||typeof row.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.request_sha256)
      ||!same(ref(row.profile_reference),getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(prepareCustomNeighborhoodWorkspaceCheckpoint(row.workspace_checkpoint),target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:issued.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  },
  async readForSemanticStatistics(rawClaim,raw){
    const claim=prepareCustomCohortCaptureJobClaim(data(rawClaim,['operation_id','claim_token','attempts'])),
      o=data(raw,['scope','actorUserId','workspaceTarget']),scope=authority(o),target=workspaceOf(o.workspaceTarget,claim.operation_id),
      values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
        scope.assignment_file_id,scope.account_id,o.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-intent:semantic-statistics-read */
      SELECT command.command_id::text,command.request_sha256,command.checkpoint,command.profile_reference,
        command.workspace_revision,command.workspace_checkpoint,command.included_group_ids,command.issued_attempts,
        command.resume_claim_token::text,job.request_sha256 AS job_request_sha256,job.checkpoint AS job_checkpoint,
        coalesce(u.command_id=command.command_id AND fifth.command_id=command.command_id AND fifth.union_reference=u.receipt_reference
          AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND union_body.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
          AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND fifth_body.canonical_utf8::jsonb->'union_reference'=u.receipt_reference
          AND fifth_body.canonical_utf8::jsonb->>'command_id'=command.command_id::text
          AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth.command_id=command.command_id AND sixth.union_reference=u.receipt_reference AND sixth.eligibility_reference=fifth.receipt_reference
          AND sixth_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
          AND sixth_body.canonical_utf8::jsonb->>'sequence'=sixth.sequence::text AND sixth_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND sixth_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND sixth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND h.command_id=command.command_id AND h.union_reference=u.receipt_reference AND h.eligibility_reference=fifth.receipt_reference
          AND h.evidence_reference=sixth.receipt_reference
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND eighth.command_id=command.command_id AND eighth.union_reference=u.receipt_reference
          AND eighth.eligibility_reference=fifth.receipt_reference AND eighth.evidence_reference=sixth.receipt_reference
          AND eighth.metrics_reference=h.receipt_reference
          AND contribution_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
          AND contribution_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND contribution_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND contribution_body.canonical_utf8::jsonb->'selected_stock_count'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND contribution_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
          AND c.phase=job.checkpoint->>'phase'
          AND c.progress_reference=CASE WHEN c.phase='frozen_selected_numeric_refs_v2' THEN numeric_population.receipt_reference ELSE semantic.receipt_reference END
          AND app.neighborhood_selected_semantic_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
          AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
            OR (job.attempts>c.issued_attempts AND job.claim_token<>c.issued_claim_token
              AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>command.resume_claim_token)),false) AS semantic_binding
      FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
      JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth USING(operation_id,organization_id)
      JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=u.organization_id
        AND union_body.content_sha256=u.receipt_reference->>'content_sha256'
        AND union_body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
        AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
        AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads sixth ON sixth.operation_id=job.operation_id AND sixth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs sixth_body ON sixth_body.organization_id=sixth.organization_id
        AND sixth_body.content_sha256=sixth.receipt_reference->>'content_sha256'
        AND sixth_body.canonical_utf8_bytes::text=sixth.receipt_reference->>'canonical_utf8_bytes' AND sixth_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=h.organization_id
        AND metrics_body.content_sha256=h.receipt_reference->>'content_sha256'
        AND metrics_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000
      JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth ON eighth.operation_id=job.operation_id AND eighth.organization_id=job.organization_id
      JOIN app.neighborhood_cohort_evidence_blobs contribution_body ON contribution_body.organization_id=eighth.organization_id
        AND contribution_body.content_sha256=eighth.receipt_reference->>'content_sha256'
        AND contribution_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND contribution_body.canonical_utf8_bytes<=16000
      LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads numeric_population
        ON numeric_population.operation_id=job.operation_id AND numeric_population.organization_id=job.organization_id
      LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads semantic
        ON semantic.operation_id=job.operation_id AND semantic.organization_id=job.organization_id
      JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
      WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
        AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
        AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      FOR SHARE OF job,command NOWAIT`,values)),['command_id','request_sha256','checkpoint','profile_reference',
      'workspace_revision','workspace_checkpoint','included_group_ids','issued_attempts','resume_claim_token',
      'job_request_sha256','job_checkpoint','semantic_binding']);
    const cp=row.job_checkpoint,roots=cp?.evidence_refs;
    if(!/^[a-f0-9]{64}$/.test(row.request_sha256??'')||row.request_sha256!==row.job_request_sha256
      ||row.checkpoint?.phase!=='frozen_recorded_catalog_refs_v2'||row.checkpoint.evidence_refs?.length!==9
      ||!same(row.profile_reference,getNeighborhoodOriginalRecordedGroupV2Profile().definition_blob.ref)
      ||row.semantic_binding!==true||!['frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'].includes(cp?.phase)
      ||!Array.isArray(roots)||roots.length!==(cp.phase==='frozen_selected_numeric_refs_v2'?15:16)
      ||!same(roots.slice(0,9),row.checkpoint.evidence_refs))fail('checkpoint_changed');
    if(row.workspace_revision!==target.revision||!same(row.workspace_checkpoint,target.checkpoint))fail('workspace_changed');
    if(!Number.isInteger(row.issued_attempts)||row.issued_attempts<1||row.issued_attempts>claim.attempts
      ||typeof row.resume_claim_token!=='string'||!UUID.test(row.resume_claim_token)||claim.claim_token===row.resume_claim_token)fail('claim_lost');
    const intent=prepareCustomCohortV2SelectionIntent({command_id:row.command_id,catalog_reference:row.checkpoint.evidence_refs[8],
      workspace_revision:row.workspace_revision,included_recorded_group_ids:row.included_group_ids});
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({command_id:intent.command_id,claim,issued_attempts:row.issued_attempts,
      included_recorded_group_ids:intent.included_recorded_group_ids,catalog_reference:intent.catalog_reference});
  }
  });
}
