import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_expired_source_recovery_failure_v3_${reason}`);};
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length
    ||!keys.every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}

// UNREGISTERED bookkeeping only, in the caller's actual transaction. Retain
// the ENTIRE real expired recovered18 claim at failure5. This grants no
// source authority, success, retry/refund, lease extension or pin release.
export function createCustomCohortExpiredSourceRecoveryFailureV3Repository(...args){
  if(args.length!==1)fail('invalid_input');
  const o=data(args[0],['client','claim','scope','actorUserId']),
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof o.client?.query!=='function'||claim.attempts!==5
    ||![scope.organization_id,scope.report_file_id,o.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope_or_final_claim');
  const tx=async()=>{
    const r=await o.client.query('/* custom-cohort-expired-source-recovery-v3:transaction */ SELECT txid_current()::text AS transaction_id');
    if(r?.rowCount!==1||r.rows?.length!==1||typeof r.rows[0].transaction_id!=='string'
      ||!/^[1-9][0-9]{0,19}$/.test(r.rows[0].transaction_id))fail('caller_transaction_required');
    return r.rows[0].transaction_id;
  };
  return Object.freeze({async failExpired(...values){
    if(values.length!==0)fail('invalid_input');
    const code='attempts_exhausted',started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const r=await o.client.query(`/* custom-cohort-expired-source-recovery-v3:fail-final */
      WITH recorded AS (
        INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_expired_ends
          (operation_id,organization_id,claimed_job,failure_code,issued_at,claim_transaction_id,issued_transaction_id)
        SELECT job.operation_id,job.organization_id,to_jsonb(job),$9::text,stamp.at,issued.issued_transaction_id,txid_current()
        FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN LATERAL app.neighborhood_source_resolution_v3_expired_first(
          job.operation_id,job.organization_id,job.claim_token,job.attempts) native ON true
        JOIN app.neighborhood_custom_cohort_source_resolution_v3_recoveries issued
          ON issued.operation_id=job.operation_id AND issued.organization_id=job.organization_id
        CROSS JOIN LATERAL (SELECT clock_timestamp() AS at WHERE native.operation_id=job.operation_id) stamp
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer AND job.attempts=5
          AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
          AND job.account_id=$7 AND job.actor_user_id=$8::uuid
        ON CONFLICT(operation_id) DO NOTHING RETURNING *
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='failed',claim_token=NULL,lease_expires_at=NULL,last_error_code=recorded.failure_code,updated_at=recorded.issued_at
        FROM recorded WHERE job.operation_id=recorded.operation_id AND job.organization_id=recorded.organization_id
          AND to_jsonb(job)=recorded.claimed_job AND recorded.issued_transaction_id=txid_current()
        RETURNING job.status,job.attempts,job.last_error_code AS failure_code`,
    [claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
      scope.assignment_file_id,scope.account_id,o.actorUserId,code]);
    if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');
    const result=data(r.rows[0],['status','attempts','failure_code']);
    if(result.status!=='failed'||result.attempts!==5||result.failure_code!==code)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze(result);
  }});
}
