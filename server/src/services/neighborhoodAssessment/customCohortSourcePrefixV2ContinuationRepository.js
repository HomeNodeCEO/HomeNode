import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_prefix_success_v2_${reason}`);};
function data(value,keys){if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function scopeOf(raw){const scope=data(raw,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![scope.organization_id,scope.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');return Object.freeze(scope);}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const ROUTING=`JOIN app.neighborhood_custom_cohort_prefix_success_v2_jobs e
  ON e.operation_id=job.operation_id AND e.organization_id=job.organization_id AND e.actor_user_id=job.actor_user_id AND e.request_sha256=job.request_sha256
  JOIN app.neighborhood_custom_cohort_source_prefix_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_prefix_success_v2 c ON c.operation_id=h.operation_id AND c.organization_id=h.organization_id
    AND c.sequence=h.sequence AND c.source_reference=h.source_reference AND c.root_reference=h.root_reference
  JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=job.organization_id
    AND b.content_sha256=h.root_reference->>'content_sha256' AND b.canonical_utf8_bytes::text=h.root_reference->>'canonical_utf8_bytes'
  CROSS JOIN LATERAL (SELECT CASE WHEN b.canonical_utf8_bytes BETWEEN 1 AND 16000 AND octet_length(b.canonical_utf8)<=16000
    THEN b.canonical_utf8::jsonb END AS root) routing`;
const LANE=`job.checkpoint->>'phase'='frozen_source_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=3
  AND job.checkpoint->'evidence_refs'->0=h.subject_reference AND job.checkpoint->'evidence_refs'->1=h.stock_reference
  AND job.checkpoint->'evidence_refs'->2=h.source_reference AND job.context_sha256 IS NULL
  AND routing.root->>'format'='cohort_original_source_references_v2'`;
const DONE=`NOT EXISTS(SELECT 1 FROM unnest(ARRAY['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs']) kind
  WHERE routing.root->'layers'->kind->>'ended' IS DISTINCT FROM 'true')`;
const RETURNING=`job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
  job.assignment_file_id::text,job.account_id,job.actor_user_id::text,due.progress_done`;

/** Dormant native-prefix success lane. Every source query/current permission
 * remains in its original owner. Routing metadata is bounded DATA only. */
export function createCustomCohortSourcePrefixV2ContinuationRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-prefix-success-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const scoped=(rawClaim,rawOptions)=>{const claim=prepareCustomCohortCaptureJobClaim(rawClaim),options=data(rawOptions,['scope','actorUserId']),scope=scopeOf(options.scope);
    if(typeof options.actorUserId!=='string'||!UUID.test(options.actorUserId))fail('invalid_scope');
    return {claim,values:[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
      scope.assignment_file_id,scope.account_id,options.actorUserId]};};
  return Object.freeze({async beginIssued(rawClaim,rawOptions){
    const {values}=scoped(rawClaim,rawOptions),started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    await client.query(`/* custom-cohort-prefix-success-v2:begin */ INSERT INTO app.neighborhood_custom_cohort_prefix_success_v2_jobs
      (operation_id,organization_id,actor_user_id,request_sha256) SELECT job.operation_id,job.organization_id,job.actor_user_id,job.request_sha256
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} ON CONFLICT(operation_id) DO NOTHING`,values);
    one(await client.query(`/* custom-cohort-prefix-success-v2:enrollment */ SELECT e.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
      JOIN app.neighborhood_custom_cohort_prefix_success_v2_jobs e USING(operation_id,organization_id,actor_user_id,request_sha256)
      WHERE ${FENCE}`,values));
    if(await tx()!==started)fail('caller_transaction_required');
  },async yieldIssued(rawClaim,rawOptions){
    const {claim,values}=scoped(rawClaim,rawOptions),started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    const row=one(await client.query(`/* custom-cohort-prefix-success-v2:yield */ WITH issued AS (
      INSERT INTO app.neighborhood_custom_cohort_prefix_success_v2
        (operation_id,organization_id,sequence,source_reference,root_reference,issued_claim_token,issued_attempts,consumed_claim_token,consumed_attempts)
      SELECT h.operation_id,h.organization_id,h.sequence,h.source_reference,h.root_reference,job.claim_token,job.attempts,NULL,NULL
      FROM app.neighborhood_custom_cohort_capture_jobs job JOIN app.neighborhood_custom_cohort_source_prefix_v2_heads h USING(operation_id,organization_id)
      WHERE ${FENCE} AND h.issued_transaction_id=txid_current()
      ON CONFLICT(operation_id) DO UPDATE SET sequence=EXCLUDED.sequence,source_reference=EXCLUDED.source_reference,
        root_reference=EXCLUDED.root_reference,issued_claim_token=EXCLUDED.issued_claim_token,issued_attempts=EXCLUDED.issued_attempts,
        consumed_claim_token=NULL,consumed_attempts=NULL,consumed_transaction_id=NULL
      WHERE neighborhood_custom_cohort_prefix_success_v2.consumed_claim_token IS NOT NULL
        AND EXCLUDED.sequence=neighborhood_custom_cohort_prefix_success_v2.sequence+1
      RETURNING operation_id,sequence,source_reference
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='retry',claim_token=NULL,lease_expires_at=NULL,
      run_after=clock_timestamp(),updated_at=clock_timestamp() FROM issued
      WHERE job.operation_id=issued.operation_id AND job.claim_token=$2::uuid AND job.attempts=$3::integer
      RETURNING issued.sequence,issued.source_reference,job.attempts`,values));
    if(!Number.isInteger(row.sequence)||row.sequence<1||row.sequence>200000||row.attempts!==claim.attempts)fail('corrupt');
    const r=data(row.source_reference,['content_sha256','canonical_utf8_bytes']),reference=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
    if(Number(reference.canonical_utf8_bytes)>16000)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({status:'continuation_pending',phase:'frozen_source_refs_v2',continuation_sequence:row.sequence,
      progress_reference:reference,attempts:row.attempts,fresh_claim_required:true,context_complete:false,pin_transfer:false});
  },async claimDue(rawOptions={leaseSeconds:300}){
    const {leaseSeconds}=data(rawOptions,['leaseSeconds']);
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    await client.query(`/* custom-cohort-prefix-success-v2:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING}
      WHERE ${LANE} AND job.status='running' AND job.lease_expires_at<=clock_timestamp()
        AND (job.cancellation_requested_at IS NOT NULL OR job.attempts>=5)
      ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        claim_token=NULL,lease_expires_at=NULL,last_error_code=CASE WHEN job.cancellation_requested_at IS NULL THEN 'attempts_exhausted' ELSE 'cancelled' END,
        updated_at=clock_timestamp() FROM expired WHERE job.operation_id=expired.operation_id`);
    let result;
    for(const recovery of [false,true]){
      result=await client.query(`/* custom-cohort-prefix-success-v2:claim-${recovery?'recovery':'success'} */ WITH due AS MATERIALIZED (
        SELECT job.operation_id,${DONE} AS progress_done FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING}
        WHERE ${LANE} AND job.cancellation_requested_at IS NULL
          AND ${recovery?`c.consumed_claim_token IS NOT NULL AND c.consumed_attempts=job.attempts AND job.attempts<5
          AND (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp())`
          :`c.consumed_claim_token IS NULL AND job.status='retry' AND job.attempts=c.issued_attempts AND job.attempts BETWEEN 1 AND 5
          AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.run_after<=clock_timestamp()`}
        ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
      ), consumed AS (
        UPDATE app.neighborhood_custom_cohort_prefix_success_v2 c SET consumed_claim_token=gen_random_uuid(),consumed_attempts=job.attempts+${Number(recovery)}
        FROM due,app.neighborhood_custom_cohort_capture_jobs job WHERE c.operation_id=due.operation_id AND job.operation_id=due.operation_id
        RETURNING c.operation_id,c.consumed_claim_token,c.consumed_attempts
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=consumed.consumed_claim_token,
        attempts=consumed.consumed_attempts,lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
        FROM consumed,due WHERE job.operation_id=consumed.operation_id AND job.operation_id=due.operation_id RETURNING ${RETURNING}`,[leaseSeconds]);
      if(result?.rowCount!==0||!Array.isArray(result.rows)||result.rows.length!==0)break;
    }
    if(!Array.isArray(result?.rows)||result.rowCount!==result.rows.length||result.rows.length>1)fail('corrupt');
    const rows=result.rows.map(row=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:row.operation_id,claim_token:row.claim_token,attempts:row.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,row[k]])));
      if(typeof row.actor_user_id!=='string'||!UUID.test(row.actor_user_id)||typeof row.progress_done!=='boolean')fail('corrupt');
      return Object.freeze({claim,scope,actor_user_id:row.actor_user_id,phase:'frozen_source_refs_v2',progress_done:row.progress_done,authority:'not_established'});});
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze(rows);
  }});
}
