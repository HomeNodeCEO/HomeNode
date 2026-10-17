import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_selected_union_v2_recovery_${reason}`);};
const JOINS=`JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_v2_continuations c USING(operation_id,organization_id)`;
// Structural scheduling only. The owner still reopens EVERY original, current
// actor/assignment/draft/subject/workspace and both ending source-purpose fences.
// No first-nine-root intent or unconsumed success continuation is eligible.
const BINDING=`head.command_id=command.command_id AND job.request_sha256=command.request_sha256
  AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
  AND c.phase='frozen_selected_union_refs_v2' AND c.progress_reference=head.receipt_reference
  AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts>=command.issued_attempts
  AND job.attempts BETWEEN c.issued_attempts AND 5
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
  AND ((job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL
      AND job.last_error_code IS NOT NULL AND job.run_after<=clock_timestamp())
    OR (job.status='running' AND job.lease_expires_at<=clock_timestamp()
      AND ((job.attempts=c.issued_attempts AND job.claim_token=c.consumed_claim_token)
        OR (job.attempts>c.issued_attempts AND job.claim_token<>c.consumed_claim_token
          AND job.claim_token<>c.issued_claim_token AND job.claim_token<>command.resume_claim_token))))`;
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
  if(![scope.organization_id,scope.report_file_id,row.actor_user_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('corrupt');
  return Object.freeze({claim,scope:Object.freeze(scope),actor_user_id:row.actor_user_id,authority:'not_established'});
}
/** INACTIVE, closed recovery of actual native union progress only. Generic
 * admission and the independent initial-intent fence remain unchanged. The
 * caller owns the transaction; no checkpoint, roots, failure or schedule reset. */
export function createCustomCohortSelectedUnionV2RecoveryRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const r=await client.query('/* custom-cohort-selected-union-v2-recovery:transaction */ SELECT txid_current()::text AS transaction_id');
    if(r?.rowCount!==1||r.rows?.length!==1||!/^[1-9][0-9]{0,19}$/.test(r.rows[0].transaction_id??''))fail('caller_transaction_required');
    return r.rows[0].transaction_id;};
  return Object.freeze({async claimDue(rawOptions={limit:1,leaseSeconds:120}){
    const {limit,leaseSeconds}=optionsOf(rawOptions),started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    await client.query(`/* custom-cohort-selected-union-v2-recovery:expire */
      WITH expired AS MATERIALIZED (
        SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${JOINS}
        WHERE ${BINDING} AND job.status='running' AND job.attempts=5
        ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='failed',claim_token=NULL,lease_expires_at=NULL,last_error_code='attempts_exhausted',updated_at=clock_timestamp()
        FROM expired WHERE job.operation_id=expired.operation_id`);
    const r=await client.query(`/* custom-cohort-selected-union-v2-recovery:claim */
      WITH due AS MATERIALIZED (
        SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${JOINS}
        WHERE ${BINDING} AND job.attempts<5
        ORDER BY job.run_after,job.operation_id LIMIT $1 FOR UPDATE OF job SKIP LOCKED
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='running',attempts=job.attempts+1,claim_token=gen_random_uuid(),
          lease_expires_at=clock_timestamp()+($2::integer*interval '1 second'),updated_at=clock_timestamp()
        FROM due WHERE job.operation_id=due.operation_id
        RETURNING job.operation_id::text,job.claim_token::text,job.attempts,job.organization_id::text,job.report_file_id::text,
          job.assignment_file_id::text,job.account_id,job.actor_user_id::text`,[limit,leaseSeconds]);
    if(!Array.isArray(r?.rows)||r.rows.length>limit||r.rowCount!==r.rows.length)fail('corrupt');
    const rows=r.rows.map(rowOf);if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze(rows);
  }});
}
