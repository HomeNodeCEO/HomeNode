import { isProxy } from 'node:util/types';
import { CAPTURE_JOB_LEASE_SECONDS, prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_initial_v2_${reason}`);};
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function scopeOf(raw){const scope=data(raw,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![scope.organization_id,scope.report_file_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');return Object.freeze(scope);}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
const ROUTING=`JOIN app.neighborhood_custom_cohort_initial_v2_jobs e
  ON e.operation_id=job.operation_id AND e.organization_id=job.organization_id AND e.report_file_id=job.report_file_id
    AND e.assignment_file_id=job.assignment_file_id AND e.account_id=job.account_id
    AND e.actor_user_id=job.actor_user_id AND e.request_sha256=job.request_sha256`;
const LANE=`job.request_payload->>'execution_mode'='frozen-originals-v2' AND job.context_sha256 IS NULL
  AND (job.checkpoint IS NULL OR job.checkpoint->>'phase' IN ('subject','frozen_stock_v1'))`;

/** Dormant pristine queue enrollment and actual native initial claim. No free
 * checkpoint adoption or source authority. Both claims and enrollments require
 * the caller's explicit transaction and independently guarded paired COMMIT. */
export function createCustomCohortInitialV2JobRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-initial-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({async enroll(raw){
    const {operationId,scope:rawScope,actorUserId}=data(raw,['operationId','scope','actorUserId']),scope=scopeOf(rawScope);
    if(![operationId,actorUserId].every(v=>typeof v==='string'&&UUID.test(v)))fail('invalid_scope');
    const values=[operationId,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    await client.query(`/* custom-cohort-initial-v2:enroll */ INSERT INTO app.neighborhood_custom_cohort_initial_v2_jobs
      (operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
      SELECT job.operation_id,job.organization_id,job.report_file_id,job.assignment_file_id,job.account_id,job.actor_user_id,job.request_sha256
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid
        AND job.report_file_id=$3::uuid AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid
        AND job.request_payload->>'execution_mode'='frozen-originals-v2' ON CONFLICT(operation_id) DO NOTHING`,values);
    one(await client.query(`/* custom-cohort-initial-v2:enrollment */ SELECT job.operation_id
      FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING}
      WHERE job.operation_id=$1::uuid AND job.organization_id=$2::uuid AND job.report_file_id=$3::uuid
        AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid`,values));
    if(await tx()!==started)fail('caller_transaction_required');
  },async claimDue(raw={leaseSeconds:300}){
    const {leaseSeconds}=data(raw,['leaseSeconds']);
    if(!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max)fail('invalid_options');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    await client.query(`/* custom-cohort-initial-v2:expire */ WITH expired AS (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING}
      WHERE ${LANE} AND job.status='running' AND job.lease_expires_at<=clock_timestamp()
        AND (job.cancellation_requested_at IS NOT NULL OR job.attempts>=5)
      ORDER BY job.lease_expires_at,job.operation_id LIMIT 64 FOR UPDATE OF job SKIP LOCKED
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
        claim_token=NULL,lease_expires_at=NULL,last_error_code=CASE WHEN job.cancellation_requested_at IS NULL THEN 'attempts_exhausted' ELSE 'cancelled' END,
        updated_at=clock_timestamp() FROM expired WHERE job.operation_id=expired.operation_id`);
    const result=await client.query(`/* custom-cohort-initial-v2:claim */ WITH due AS MATERIALIZED (
      SELECT job.operation_id FROM app.neighborhood_custom_cohort_capture_jobs job ${ROUTING}
      WHERE ${LANE} AND job.cancellation_requested_at IS NULL AND job.attempts<5 AND e.attempts=job.attempts
        AND (job.status IN ('queued','retry') AND job.run_after<=clock_timestamp()
          OR job.status='running' AND job.lease_expires_at<=clock_timestamp())
      ORDER BY job.run_after,job.operation_id LIMIT 1 FOR UPDATE OF job SKIP LOCKED
    ), claimed AS (
      UPDATE app.neighborhood_custom_cohort_initial_v2_jobs e SET claim_token=gen_random_uuid(),attempts=job.attempts+1
      FROM due,app.neighborhood_custom_cohort_capture_jobs job WHERE e.operation_id=due.operation_id AND job.operation_id=due.operation_id
      RETURNING e.operation_id,e.claim_token,e.attempts
    ) UPDATE app.neighborhood_custom_cohort_capture_jobs job SET status='running',claim_token=claimed.claim_token,
      attempts=claimed.attempts,lease_expires_at=clock_timestamp()+($1::integer*interval '1 second'),updated_at=clock_timestamp()
      FROM claimed WHERE job.operation_id=claimed.operation_id RETURNING job.operation_id::text,job.claim_token::text,job.attempts,
        job.organization_id::text,job.report_file_id::text,job.assignment_file_id::text,job.account_id,job.actor_user_id::text`,[leaseSeconds]);
    if(!Array.isArray(result?.rows)||result.rowCount!==result.rows.length||result.rows.length>1)fail('corrupt');
    const rows=result.rows.map(row=>{const claim=prepareCustomCohortCaptureJobClaim({operation_id:row.operation_id,claim_token:row.claim_token,attempts:row.attempts}),
      scope=scopeOf(Object.fromEntries(['organization_id','report_file_id','assignment_file_id','account_id'].map(k=>[k,row[k]])));
      if(typeof row.actor_user_id!=='string'||!UUID.test(row.actor_user_id))fail('corrupt');
      return Object.freeze({claim,scope,actor_user_id:row.actor_user_id,authority:'not_established'});});
    if(await tx()!==started)fail('caller_transaction_required');return Object.freeze(rows);
  }});
}
