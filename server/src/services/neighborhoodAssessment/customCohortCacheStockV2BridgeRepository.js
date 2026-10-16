import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim,CAPTURE_JOB_LEASE_SECONDS } from './customCohortCaptureJobRepository.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_cache_stock_v2_${reason}`);};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function scopeOf(v){const s=data(v,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![s.organization_id,s.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof s.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(s.assignment_file_id)||BigInt(s.assignment_file_id)>9223372036854775807n
    ||typeof s.account_id!=='string'||!s.account_id||s.account_id.length>64||!s.account_id.isWellFormed()
    ||s.account_id.trim()!==s.account_id||/[\u0000-\u001f\u007f]/.test(s.account_id))fail('invalid_scope');return Object.freeze(s);}
const RETURN=`job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
  job.assignment_file_id::text,job.account_id,job.actor_user_id::text`;
const CLAIM_JOB=`UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=claimed.claim_token,
  attempts=claimed.attempts,lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
  FROM claimed WHERE job.operation_id=claimed.operation_id RETURNING ${RETURN}`;
const EXISTING=`/* custom-cohort-cache-stock-v2:claim-existing */ WITH due AS MATERIALIZED (
  SELECT job.operation_id,job.attempts+1 AS attempts FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_cache_stock_v2_bridges b USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
  WHERE b.completed_reference IS NULL AND job.attempts=b.attempts AND job.attempts<5
    AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,b.claim_token,b.attempts)
    AND job.checkpoint->>'phase'='frozen_identity_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=6
    AND (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp())
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), claimed AS (UPDATE app.neighborhood_custom_cohort_cache_stock_v2_bridges b SET claim_token=gen_random_uuid(),attempts=due.attempts
  FROM due WHERE b.operation_id=due.operation_id RETURNING b.operation_id,b.claim_token,b.attempts
) ${CLAIM_JOB}`;
const INITIAL=`/* custom-cohort-cache-stock-v2:claim-initial */ WITH due AS MATERIALIZED (
  SELECT job.*,e.parent_sequence,e.identity_reference,e.sequence AS cache_sequence,e.receipt_reference AS cache_reference,d.receipt_reference AS cad_reference
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
  JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads h ON h.operation_id=e.operation_id AND h.organization_id=e.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs r ON r.organization_id=e.organization_id AND r.content_sha256=e.receipt_reference->>'content_sha256'
    AND r.canonical_utf8_bytes::text=e.receipt_reference->>'canonical_utf8_bytes' AND r.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_cad_success_v2_jobs d ON d.operation_id=job.operation_id AND d.organization_id=job.organization_id
    AND d.report_file_id=job.report_file_id AND d.assignment_file_id=job.assignment_file_id AND d.account_id=job.account_id
    AND d.actor_user_id=job.actor_user_id AND d.request_sha256=job.request_sha256
  JOIN app.neighborhood_custom_cohort_cad_cache_v2_heads cad ON cad.operation_id=d.operation_id AND cad.organization_id=d.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs cb ON cb.organization_id=d.organization_id AND cb.content_sha256=d.receipt_reference->>'content_sha256'
    AND cb.canonical_utf8_bytes::text=d.receipt_reference->>'canonical_utf8_bytes' AND cb.canonical_utf8_bytes<=16000
  WHERE job.request_payload->>'execution_mode'='frozen-originals-v2' AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL
    AND job.checkpoint->>'phase'='frozen_identity_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=6
    AND c.phase='frozen_identity_refs_v2' AND c.sequence=e.parent_sequence AND c.progress_reference=e.identity_reference
    AND c.consumed_claim_token=e.initial_claim_token AND e.consumed_claim_token IS NULL AND e.sequence>0
    AND h.sequence=e.sequence AND h.receipt_reference=e.receipt_reference AND h.identity_reference=e.identity_reference
    AND r.canonical_utf8::jsonb->>'format'='cohort_neutral_cache_receipt_v2' AND r.canonical_utf8::jsonb->'after'->>'kind_index'='7'
    AND job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.run_after<=clock_timestamp()
    AND d.cache_sequence=e.sequence AND d.cache_reference=e.receipt_reference AND d.sequence>0 AND d.consumed_claim_token IS NULL
    AND cad.sequence=d.sequence AND cad.receipt_reference=d.receipt_reference AND cad.neutral_reference=e.receipt_reference
    AND cb.canonical_utf8::jsonb->>'format'='cohort_CAD_cache_coverage_receipt_v2' AND cb.canonical_utf8::jsonb->'after'->>'done'='true'
    AND job.attempts=d.issued_attempts AND job.attempts BETWEEN 1 AND 5
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b WHERE b.operation_id=job.operation_id)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors a WHERE a.operation_id=job.operation_id)
  ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
), claimed AS (
  INSERT INTO app.neighborhood_custom_cohort_cache_stock_v2_bridges(operation_id,organization_id,report_file_id,assignment_file_id,
    account_id,actor_user_id,request_sha256,parent_sequence,identity_reference,cache_sequence,cache_reference,cad_reference,claim_token,attempts)
  SELECT operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256,
    parent_sequence,identity_reference,cache_sequence,cache_reference,cad_reference,gen_random_uuid(),attempts FROM due
  RETURNING operation_id,claim_token,attempts
) ${CLAIM_JOB}`;
const FENCE=`job.operation_id=$1::uuid AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.attempts=$3::integer AND job.context_sha256 IS NULL
  AND job.cancellation_requested_at IS NULL`;

/** Dormant native first-stock adoption only. No original/source callbacks,
 * caller phase/reference, sequence widening, route or scheduler activation. */
export function createCustomCohortCacheStockV2BridgeRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];};
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-cache-stock-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const values=(rawClaim,rawOptions)=>{const claim=prepareCustomCohortCaptureJobClaim(rawClaim),o=data(rawOptions,['scope','actorUserId']),s=scopeOf(o.scope);
    if(typeof o.actorUserId!=='string'||!UUID.test(o.actorUserId))fail('invalid_scope');
    return [claim.operation_id,claim.claim_token,claim.attempts,s.organization_id,s.report_file_id,s.assignment_file_id,s.account_id,o.actorUserId];};
  return Object.freeze({async claimDue(raw={leaseSeconds:300}){
    const {leaseSeconds}=data(raw,['leaseSeconds']);if(!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    let result=await client.query(EXISTING,[leaseSeconds]);if(result?.rowCount===0&&result.rows?.length===0)result=await client.query(INITIAL,[leaseSeconds]);
    if(!Array.isArray(result?.rows)||result.rowCount!==result.rows.length||result.rows.length>1)fail('corrupt');
    const rows=result.rows.map(r=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:r.operation_id,claim_token:r.claim_token,attempts:r.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,r[k]])));
      if(typeof r.actor_user_id!=='string'||!UUID.test(r.actor_user_id))fail('corrupt');return Object.freeze({claim,scope,actor_user_id:r.actor_user_id,authority:'not_established'});});
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze(rows);
  },async assertClaim(rawClaim,rawOptions){
    const v=values(rawClaim,rawOptions);one(await client.query(`/* custom-cohort-cache-stock-v2:live-claim */
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
        AND job.status='running' AND job.claim_token=$2::uuid AND job.lease_expires_at>clock_timestamp()
        AND app.neighborhood_cache_stock_v2_matches(job.operation_id,job.organization_id,$2::uuid,$3::integer)`,v));
  },async complete(rawClaim,rawOptions){
    const v=values(rawClaim,rawOptions),started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    one(await client.query(`/* custom-cohort-cache-stock-v2:complete */
      UPDATE app.neighborhood_custom_cohort_cache_stock_v2_bridges b SET completed_reference=h.receipt_reference
      FROM app.neighborhood_custom_cohort_capture_jobs job,app.neighborhood_custom_cohort_stock_traversal_v2_anchors h
      WHERE ${FENCE} AND b.operation_id=job.operation_id AND b.organization_id=job.organization_id
        AND b.claim_token=$2::uuid AND b.attempts=$3::integer AND b.completed_reference IS NULL
        AND h.operation_id=job.operation_id AND h.organization_id=job.organization_id AND h.sequence=1 AND h.issued_transaction_id=txid_current()
        AND job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
        AND job.checkpoint->>'phase'='frozen_stock_traversal_refs_v2' AND job.checkpoint->'evidence_refs'->6=h.receipt_reference
      RETURNING b.operation_id`,v));
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze({status:'native_cache_stock_handoff_retained',context_complete:false,pin_transfer:false});
  }});
}
