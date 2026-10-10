import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim, CAPTURE_JOB_LEASE_SECONDS } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PHASES=['frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2'];
const fail=reason=>{throw new TypeError(`custom_cohort_v2_continuation_${reason}`);};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function scopeOf(raw){const s=data(raw,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![s.organization_id,s.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof s.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(s.assignment_file_id)||BigInt(s.assignment_file_id)>9223372036854775807n
    ||typeof s.account_id!=='string'||!s.account_id||s.account_id.length>64||!s.account_id.isWellFormed()
    ||s.account_id.trim()!==s.account_id||/[\u0000-\u001f\u007f]/.test(s.account_id))fail('invalid_scope');return Object.freeze(s);}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
/** Storage only: the actual owner must verify EVERY original/current rights,
 * final claim/cache/subject fences and retain the issued roots in this SAME TX.
 * No caller checkpoint, phase, DONE, token, retry count or source callback. */
export function createCustomCohortV2ContinuationRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-v2-continuation:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({async yieldIssued(rawClaim,rawOptions){
    const claim=prepareCustomCohortCaptureJobClaim(rawClaim),options=data(rawOptions,['scope','actorUserId']),scope=scopeOf(options.scope);
    if(typeof options.actorUserId!=='string'||!UUID.test(options.actorUserId))fail('invalid_scope');
    const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
      scope.assignment_file_id,scope.account_id,options.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=one(await client.query(`/* custom-cohort-v2-continuation:yield */
      WITH issued AS (
        INSERT INTO app.neighborhood_custom_cohort_v2_continuations
          (operation_id,organization_id,sequence,phase,progress_reference,issued_claim_token,issued_attempts,consumed_claim_token)
        SELECT job.operation_id,job.organization_id,1,job.checkpoint->>'phase',job.checkpoint->'evidence_refs'->-1,job.claim_token,job.attempts,NULL
        FROM app.neighborhood_custom_cohort_capture_jobs job
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
          AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
          AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
          AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL
        ON CONFLICT(operation_id) DO UPDATE SET sequence=neighborhood_custom_cohort_v2_continuations.sequence+1,
          phase=EXCLUDED.phase,progress_reference=EXCLUDED.progress_reference,issued_claim_token=EXCLUDED.issued_claim_token,
          issued_attempts=EXCLUDED.issued_attempts,consumed_claim_token=NULL
        WHERE neighborhood_custom_cohort_v2_continuations.consumed_claim_token IS NOT NULL
          AND neighborhood_custom_cohort_v2_continuations.progress_reference<>EXCLUDED.progress_reference
        RETURNING operation_id,sequence,phase,progress_reference
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='retry',claim_token=NULL,lease_expires_at=NULL,run_after=clock_timestamp(),updated_at=clock_timestamp()
        FROM issued WHERE job.operation_id=issued.operation_id AND job.claim_token=$2::uuid AND job.attempts=$3::integer
        RETURNING issued.sequence,issued.phase,issued.progress_reference,job.attempts`,values));
    if(!Number.isInteger(row.sequence)||row.sequence<1||row.sequence>6000003||row.attempts!==claim.attempts||!PHASES.includes(row.phase))fail('corrupt');
    const r=data(row.progress_reference,['content_sha256','canonical_utf8_bytes']),reference=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
    if(Number(reference.canonical_utf8_bytes)>16000)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({status:'continuation_pending',continuation_sequence:row.sequence,phase:row.phase,
      progress_reference:reference,attempts:row.attempts,fresh_claim_required:true,context_complete:false,pin_transfer:false});
  },async claimDue(rawOptions={limit:1,leaseSeconds:120}){
    const {limit,leaseSeconds}=data(rawOptions,['limit','leaseSeconds']);
    if(!Number.isInteger(limit)||limit<1||limit>4||!Number.isInteger(leaseSeconds)
      ||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    const result=await client.query(`/* custom-cohort-v2-continuation:claim */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id
        WHERE c.consumed_claim_token IS NULL AND job.status='retry' AND job.attempts=c.issued_attempts
          AND job.attempts BETWEEN 1 AND 5 AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
          AND job.cancellation_requested_at IS NULL AND job.run_after<=clock_timestamp()
        ORDER BY job.run_after,job.operation_id LIMIT $1 FOR UPDATE OF job SKIP LOCKED
      ), consumed AS (
        UPDATE app.neighborhood_custom_cohort_v2_continuations c SET consumed_claim_token=gen_random_uuid()
        FROM due WHERE c.operation_id=due.operation_id AND c.consumed_claim_token IS NULL
        RETURNING c.operation_id,c.consumed_claim_token
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=consumed.consumed_claim_token,
        lease_expires_at=clock_timestamp()+($2::integer*interval '1 second'),updated_at=clock_timestamp()
        FROM consumed WHERE job.operation_id=consumed.operation_id
        RETURNING job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
          job.assignment_file_id::text,job.account_id,job.actor_user_id::text`,[limit,leaseSeconds]);
    if(!Array.isArray(result?.rows)||result.rows.length>limit||result.rowCount!==result.rows.length)fail('corrupt');
    const rows=result.rows.map(r=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:r.operation_id,claim_token:r.claim_token,attempts:r.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,r[k]])));
      if(typeof r.actor_user_id!=='string'||!UUID.test(r.actor_user_id))fail('corrupt');
      return Object.freeze({claim,scope,actor_user_id:r.actor_user_id,authority:'not_established'});});
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze(rows);
  }});
}
