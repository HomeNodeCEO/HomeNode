import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim,CAPTURE_JOB_LEASE_SECONDS } from './customCohortCaptureJobRepository.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_neutral_success_v2_${reason}`);};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function scopeOf(raw){const s=data(raw,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![s.organization_id,s.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof s.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(s.assignment_file_id)||BigInt(s.assignment_file_id)>9223372036854775807n
    ||typeof s.account_id!=='string'||!s.account_id||s.account_id.length>64||!s.account_id.isWellFormed()
    ||s.account_id.trim()!==s.account_id||/[\u0000-\u001f\u007f]/.test(s.account_id))fail('invalid_scope');return Object.freeze(s);}
const RETURN=`job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
  job.assignment_file_id::text,job.account_id,job.actor_user_id::text`;
const CURRENT=`job.checkpoint->>'phase'='frozen_identity_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=6
  AND job.request_payload->>'execution_mode'='frozen-originals-v2' AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL`;
const EXISTING=`/* custom-cohort-neutral-success-v2:claim-existing */ WITH due AS MATERIALIZED (
  SELECT job.operation_id,CASE WHEN e.consumed_claim_token IS NULL THEN job.attempts ELSE job.attempts+1 END AS attempts
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
  LEFT JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads h USING(operation_id,organization_id)
  LEFT JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=e.organization_id
    AND b.content_sha256=e.receipt_reference->>'content_sha256' AND b.canonical_utf8_bytes::text=e.receipt_reference->>'canonical_utf8_bytes'
  WHERE ${CURRENT} AND job.checkpoint->'evidence_refs'->5=e.identity_reference
    AND (e.sequence=0 AND h.operation_id IS NULL OR e.sequence>0 AND h.sequence=e.sequence AND h.receipt_reference=e.receipt_reference
      AND b.canonical_utf8_bytes<=16000 AND b.canonical_utf8::jsonb->'after'->>'kind_index'<>'7')
    AND (e.consumed_claim_token IS NULL AND job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
      AND job.attempts=e.issued_attempts AND job.run_after<=clock_timestamp()
      OR e.consumed_claim_token IS NOT NULL AND job.attempts=e.consumed_attempts AND job.attempts<5
        AND (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()))
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), claimed AS (
  UPDATE app.neighborhood_custom_cohort_neutral_success_v2_jobs e
    SET consumed_claim_token=gen_random_uuid(),consumed_attempts=due.attempts
  FROM due WHERE e.operation_id=due.operation_id RETURNING e.operation_id,e.consumed_claim_token,e.consumed_attempts
) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=claimed.consumed_claim_token,
  attempts=claimed.consumed_attempts,lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
  FROM claimed WHERE job.operation_id=claimed.operation_id RETURNING ${RETURN}`;
const INITIAL=`/* custom-cohort-neutral-success-v2:claim-initial */ WITH due AS MATERIALIZED (
  SELECT job.*,c.sequence AS parent_sequence,c.progress_reference AS identity_reference,gen_random_uuid() AS nonce
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_v2_continuations c USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_identity_v2_anchors a ON a.operation_id=job.operation_id AND a.organization_id=job.organization_id
    AND a.receipt_reference=c.progress_reference
  JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=a.organization_id AND b.content_sha256=a.receipt_reference->>'content_sha256'
    AND b.canonical_utf8_bytes::text=a.receipt_reference->>'canonical_utf8_bytes'
  WHERE ${CURRENT} AND c.phase='frozen_identity_refs_v2' AND c.progress_reference=job.checkpoint->'evidence_refs'->5
    AND c.consumed_claim_token IS NULL AND job.status='retry' AND job.attempts=c.issued_attempts AND job.attempts BETWEEN 1 AND 5
    AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.run_after<=clock_timestamp()
    AND b.canonical_utf8_bytes<=16000 AND b.canonical_utf8::jsonb->>'format'='cohort_source_identity_receipt_v2'
    AND b.canonical_utf8::jsonb->'after'->>'kind_index'='7'
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=job.operation_id)
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), enrolled AS (
  INSERT INTO app.neighborhood_custom_cohort_neutral_success_v2_jobs(operation_id,organization_id,report_file_id,assignment_file_id,
    account_id,actor_user_id,request_sha256,parent_sequence,identity_reference,initial_claim_token,sequence,consumed_claim_token,consumed_attempts)
  SELECT operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256,
    parent_sequence,identity_reference,nonce,0,nonce,attempts FROM due
  RETURNING operation_id,initial_claim_token,consumed_attempts
), consumed AS (
  UPDATE app.neighborhood_custom_cohort_v2_continuations c SET consumed_claim_token=enrolled.initial_claim_token
  FROM enrolled WHERE c.operation_id=enrolled.operation_id AND c.consumed_claim_token IS NULL RETURNING c.operation_id
) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=enrolled.initial_claim_token,
  lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
  FROM enrolled,consumed WHERE job.operation_id=enrolled.operation_id AND job.operation_id=consumed.operation_id RETURNING ${RETURN}`;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running' AND job.lease_expires_at>clock_timestamp()
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;

/** Native metadata only. The actual original owner must perform every original,
 * complete-cache comparison and current/ending authority check in its own TX.
 * Cache DONE is excluded from claims/recovery; no next-owner handoff yet. */
export function createCustomCohortNeutralCacheV2ContinuationRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];};
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-neutral-success-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const claimRows=r=>{if(!Array.isArray(r?.rows)||r.rowCount!==r.rows.length||r.rows.length>1)fail('corrupt');
    return Object.freeze(r.rows.map(row=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:row.operation_id,claim_token:row.claim_token,attempts:row.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,row[k]])));
      if(typeof row.actor_user_id!=='string'||!UUID.test(row.actor_user_id))fail('corrupt');
      return Object.freeze({claim,scope,actor_user_id:row.actor_user_id,authority:'not_established'});}));};
  return Object.freeze({async claimDue(raw={leaseSeconds:300}){
    const {leaseSeconds}=data(raw,['leaseSeconds']);
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    let rows=claimRows(await client.query(EXISTING,[leaseSeconds]));
    if(!rows.length)rows=claimRows(await client.query(INITIAL,[leaseSeconds]));
    if(await tx()!==started)fail('caller_transaction_required');return rows;
  },async yieldIssued(rawClaim,rawOptions){
    const claim=prepareCustomCohortCaptureJobClaim(rawClaim),options=data(rawOptions,['scope','actorUserId']),scope=scopeOf(options.scope);
    if(typeof options.actorUserId!=='string'||!UUID.test(options.actorUserId))fail('invalid_scope');
    const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,options.actorUserId],
      started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    const row=one(await client.query(`/* custom-cohort-neutral-success-v2:yield */ WITH issued AS (
      UPDATE app.neighborhood_custom_cohort_neutral_success_v2_jobs e SET sequence=h.sequence,receipt_reference=h.receipt_reference,
        issued_claim_token=job.claim_token,issued_attempts=job.attempts,
        consumed_claim_token=NULL,consumed_attempts=NULL,consumed_transaction_id=NULL
      FROM app.neighborhood_custom_cohort_capture_jobs job,app.neighborhood_custom_cohort_neutral_cache_v2_heads h
      WHERE ${FENCE} AND e.operation_id=job.operation_id AND e.organization_id=job.organization_id
        AND h.operation_id=job.operation_id AND h.organization_id=job.organization_id
      RETURNING e.operation_id,e.sequence
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='retry',claim_token=NULL,lease_expires_at=NULL,
      run_after=clock_timestamp(),updated_at=clock_timestamp() FROM issued
      WHERE ${FENCE} AND job.operation_id=issued.operation_id RETURNING issued.sequence,job.attempts`,values));
    if(!Number.isInteger(row.sequence)||row.sequence<1||row.sequence>200000||row.attempts!==claim.attempts)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({status:'continuation_pending',lane:'neutral_cache_v2',sequence:row.sequence,attempts:row.attempts,
      fresh_claim_required:true,context_complete:false,pin_transfer:false});
  }});
}
