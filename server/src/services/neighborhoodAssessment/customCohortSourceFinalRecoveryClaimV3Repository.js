import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_source_final_recovery_v3_${reason}`);};
function optionsOf(value){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_options');
  const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
  if(keys.length!==2||!['limit','leaseSeconds'].every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_options');
  const {limit,leaseSeconds}=value;
  if(!Number.isInteger(limit)||limit<1||limit>4||!Number.isInteger(leaseSeconds)
    ||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
  return {limit,leaseSeconds};
}
function rowOf(row){
  const claim=prepareCustomCohortCaptureJobClaim({operation_id:row.operation_id,claim_token:row.claim_token,attempts:row.attempts}),
    scope={organization_id:row.organization_id,report_file_id:row.report_file_id,
      assignment_file_id:row.assignment_file_id,account_id:row.account_id};
  if(claim.attempts!==5||![scope.organization_id,scope.report_file_id,row.actor_user_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('corrupt');
  return Object.freeze({claim,scope:Object.freeze(scope),actor_user_id:row.actor_user_id,authority:'not_established'});
}

/** UNREGISTERED structural recovery only. Consume the committed actual retry4
 * once and spend the final attempt5. Retain the ENTIRE retry job and every
 * independent native original/FIRST parent. This supplies no source authority,
 * original IO, expired recovery, lower attempt, renewal or default worker. */
export function createCustomCohortSourceFinalRecoveryClaimV3Repository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const r=await client.query('/* custom-cohort-source-final-recovery-v3:transaction */ SELECT txid_current()::text AS transaction_id');
    if(r?.rowCount!==1||r.rows?.length!==1||typeof r.rows[0].transaction_id!=='string'
      ||!/^[1-9][0-9]{0,19}$/.test(r.rows[0].transaction_id))fail('caller_transaction_required');
    return r.rows[0].transaction_id;};
  return Object.freeze({async claimDue(...args){
    if(args.length>1)fail('invalid_options');
    const {limit,leaseSeconds}=optionsOf(args.length?args[0]:{limit:1,leaseSeconds:120}),started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const r=await client.query(`/* custom-cohort-source-final-recovery-v3:claim */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id,job.organization_id FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_source_resolution_v3_last_retries failure USING(operation_id,organization_id)
        WHERE job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND job.attempts=4
          AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
          AND job.run_after<=clock_timestamp() AND failure.issued_transaction_id<>txid_current()
          AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_recoveries r
            WHERE r.operation_id=job.operation_id)
        ORDER BY job.run_after,job.operation_id LIMIT $1 FOR UPDATE OF job SKIP LOCKED
      ), issued AS (
        INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_recoveries
          (operation_id,organization_id,preclaim_job,claim_token,attempts,issued_at,lease_seconds,lease_expires_at,
            retry_transaction_id,issued_transaction_id)
        SELECT job.operation_id,job.organization_id,to_jsonb(job),gen_random_uuid(),job.attempts+1,
          stamp.at,$2::integer,stamp.at+($2::integer*interval '1 second'),failure.issued_transaction_id,txid_current()
        FROM due JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id,organization_id)
        JOIN app.neighborhood_custom_cohort_source_resolution_v3_last_retries failure USING(operation_id,organization_id)
        JOIN LATERAL app.neighborhood_source_resolution_v3_retry_first(job.operation_id,job.organization_id) first_row ON true
        CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE first_row.operation_id=job.operation_id) stamp
        ON CONFLICT(operation_id) DO NOTHING RETURNING *
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='running',claim_token=issued.claim_token,attempts=issued.attempts,
          lease_expires_at=issued.lease_expires_at,updated_at=issued.issued_at
        FROM issued WHERE job.operation_id=issued.operation_id AND job.organization_id=issued.organization_id
          AND to_jsonb(job)=issued.preclaim_job AND issued.issued_transaction_id=txid_current()
        RETURNING job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
          job.assignment_file_id::text,job.account_id,job.actor_user_id::text`,[limit,leaseSeconds]);
    if(!Array.isArray(r?.rows)||r.rows.length>limit||r.rowCount!==r.rows.length)fail('corrupt');
    const rows=r.rows.map(rowOf);if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze(rows);
  }});
}
