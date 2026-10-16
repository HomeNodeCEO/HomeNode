import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim,CAPTURE_JOB_LEASE_SECONDS } from './customCohortCaptureJobRepository.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=r=>{throw new TypeError(`custom_cohort_CAD_success_v2_${r}`);};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(ds).length!==keys.length
    ||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function scopeOf(v){const s=data(v,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![s.organization_id,s.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof s.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(s.assignment_file_id)||BigInt(s.assignment_file_id)>9223372036854775807n
    ||typeof s.account_id!=='string'||!s.account_id||Buffer.byteLength(s.account_id)>64||!s.account_id.isWellFormed()
    ||s.account_id.trim()!==s.account_id||/[\u0000-\u001f\u007f]/.test(s.account_id))fail('invalid_scope');return Object.freeze(s);}
const RETURN=`job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
  job.assignment_file_id::text,job.account_id,job.actor_user_id::text`;
const CLAIM_JOB=`UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=claimed.consumed_claim_token,
  attempts=claimed.consumed_attempts,lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
  FROM claimed WHERE job.operation_id=claimed.operation_id RETURNING ${RETURN}`;
const EXISTING=`/* custom-cohort-CAD-success-v2:claim-existing */ WITH due AS MATERIALIZED (
  SELECT job.operation_id,CASE WHEN e.consumed_claim_token IS NULL THEN job.attempts ELSE job.attempts+1 END AS attempts
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_cad_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
  LEFT JOIN app.neighborhood_custom_cohort_cad_cache_v2_heads h USING(operation_id,organization_id)
  LEFT JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=e.organization_id
    AND b.content_sha256=e.receipt_reference->>'content_sha256' AND b.canonical_utf8_bytes::text=e.receipt_reference->>'canonical_utf8_bytes'
  WHERE app.neighborhood_cad_success_v2_parent_matches(e.operation_id,e.organization_id,e.cache_sequence,e.cache_reference)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges s WHERE s.operation_id=job.operation_id)
    AND (e.sequence=0 AND h.operation_id IS NULL OR e.sequence>0 AND h.sequence=e.sequence AND h.receipt_reference=e.receipt_reference
      AND b.canonical_utf8_bytes<=16000 AND b.canonical_utf8::jsonb->'after'->>'done'='false')
    AND (e.consumed_claim_token IS NULL AND job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
      AND job.attempts=e.issued_attempts AND job.run_after<=clock_timestamp()
      OR e.consumed_claim_token IS NOT NULL AND job.attempts=e.consumed_attempts AND job.attempts<5
        AND (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()))
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), claimed AS (UPDATE app.neighborhood_custom_cohort_cad_success_v2_jobs e
  SET consumed_claim_token=gen_random_uuid(),consumed_attempts=due.attempts FROM due WHERE e.operation_id=due.operation_id
  RETURNING e.operation_id,e.consumed_claim_token,e.consumed_attempts) ${CLAIM_JOB}`;
const INITIAL=`/* custom-cohort-CAD-success-v2:claim-initial */ WITH due AS MATERIALIZED (
  SELECT job.*,e.sequence AS cache_sequence,e.receipt_reference AS cache_reference
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
  WHERE app.neighborhood_cad_success_v2_parent_matches(e.operation_id,e.organization_id,e.sequence,e.receipt_reference)
    AND job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.run_after<=clock_timestamp()
    AND job.attempts=e.issued_attempts AND job.attempts BETWEEN 1 AND 5
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs d WHERE d.operation_id=job.operation_id)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_cache_v2_heads h WHERE h.operation_id=job.operation_id)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges s WHERE s.operation_id=job.operation_id)
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), claimed AS (INSERT INTO app.neighborhood_custom_cohort_cad_success_v2_jobs
    (operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256,
      cache_sequence,cache_reference,sequence,consumed_claim_token,consumed_attempts)
  SELECT operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256,
    cache_sequence,cache_reference,0,gen_random_uuid(),attempts FROM due
  RETURNING operation_id,consumed_claim_token,consumed_attempts) ${CLAIM_JOB}`;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running' AND job.lease_expires_at>clock_timestamp()
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;

/** Native continuation metadata only. All originals, entire-cache comparison,
 * current/ending source rights and actor fences belong to the actual owner. */
export function createCustomCohortCadCacheV2ContinuationRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];},
    tx=async()=>{const id=one(await client.query('/* custom-cohort-CAD-success-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
      if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;},
    values=(rawClaim,rawOptions)=>{const claim=prepareCustomCohortCaptureJobClaim(rawClaim),o=data(rawOptions,['scope','actorUserId']),s=scopeOf(o.scope);
      if(typeof o.actorUserId!=='string'||!UUID.test(o.actorUserId))fail('invalid_scope');
      return [claim.operation_id,claim.claim_token,claim.attempts,s.organization_id,s.report_file_id,s.assignment_file_id,s.account_id,o.actorUserId];};
  return Object.freeze({async claimDue(raw={leaseSeconds:300}){
    const {leaseSeconds}=data(raw,['leaseSeconds']);if(!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');let r=await client.query(EXISTING,[leaseSeconds]);
    if(r?.rowCount===0&&r.rows?.length===0)r=await client.query(INITIAL,[leaseSeconds]);
    if(!Array.isArray(r?.rows)||r.rowCount!==r.rows.length||r.rows.length>1)fail('corrupt');
    const result=r.rows.map(row=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:row.operation_id,claim_token:row.claim_token,attempts:row.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,row[k]])));
      if(typeof row.actor_user_id!=='string'||!UUID.test(row.actor_user_id))fail('corrupt');return Object.freeze({claim,scope,actor_user_id:row.actor_user_id,authority:'not_established'});});
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze(result);
  },async assertClaim(rawClaim,rawOptions){const v=values(rawClaim,rawOptions);
    one(await client.query(`/* custom-cohort-CAD-success-v2:live-claim */ SELECT job.operation_id
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
        AND app.neighborhood_cad_success_v2_matches(job.operation_id,job.organization_id,job.claim_token,job.attempts)`,v));
  },async yieldIssued(rawClaim,rawOptions){const v=values(rawClaim,rawOptions),started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    const row=one(await client.query(`/* custom-cohort-CAD-success-v2:yield */ WITH issued AS (
      UPDATE app.neighborhood_custom_cohort_cad_success_v2_jobs e SET sequence=h.sequence,receipt_reference=h.receipt_reference,
        issued_claim_token=job.claim_token,issued_attempts=job.attempts,issued_lease_expires_at=NULL,
        consumed_claim_token=NULL,consumed_attempts=NULL,consumed_transaction_id=NULL
      FROM app.neighborhood_custom_cohort_capture_jobs job,app.neighborhood_custom_cohort_cad_cache_v2_heads h
      WHERE ${FENCE} AND e.operation_id=job.operation_id AND e.organization_id=job.organization_id
        AND e.consumed_claim_token=job.claim_token AND e.consumed_attempts=job.attempts
        AND h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        AND h.sequence=e.sequence+1 AND h.issued_transaction_id=txid_current()
      RETURNING e.operation_id,e.sequence
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='retry',claim_token=NULL,lease_expires_at=NULL,
      run_after=clock_timestamp(),updated_at=clock_timestamp() FROM issued WHERE ${FENCE} AND job.operation_id=issued.operation_id
      RETURNING issued.sequence,job.attempts`,v));
    if(!Number.isInteger(row.sequence)||row.sequence<1||row.sequence>2000001||row.attempts!==v[2])fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze({status:'continuation_pending',lane:'CAD_cache_v2',
      sequence:row.sequence,attempts:row.attempts,fresh_claim_required:true,context_complete:false,pin_transfer:false});
  }});
}
