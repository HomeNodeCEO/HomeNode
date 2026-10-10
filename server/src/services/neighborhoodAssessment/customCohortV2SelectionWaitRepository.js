import { isProxy } from 'node:util/types';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_v2_selection_wait_${reason}`);};
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}
/** Closed storage primitive, NOT source/selection/current-human authority.
 * Only the actual original owner may call after ALL ending fences in SAME TX.
 * No caller DONE, checkpoint, head, group IDs, schedule, reset or source adapter. */
export function createCustomCohortV2SelectionWaitRepository(client){
  if(typeof client?.query!=='function')fail('client_required');
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-v2-selection-wait:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({async awaitSelection(rawClaim,rawOptions){
    const claim=prepareCustomCohortCaptureJobClaim(rawClaim),options=data(rawOptions,['scope','actorUserId']),
      scope=data(options.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
    if(![scope.organization_id,scope.report_file_id,options.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
      ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
      ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
      ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
      ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
    const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
      scope.assignment_file_id,scope.account_id,options.actorUserId],started=await tx();
    if(await tx()!==started)fail('caller_transaction_required');
    const row=data(one(await client.query(`/* custom-cohort-v2-selection-wait:release */
      UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET status='awaiting_selection',claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
          AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
          AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
          AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL
        RETURNING job.status,job.attempts,job.checkpoint->'evidence_refs'->8 AS catalog_reference`,values)),
      ['status','attempts','catalog_reference']);
    if(row.status!=='awaiting_selection'||row.attempts!==claim.attempts)fail('corrupt');
    const r=data(row.catalog_reference,['content_sha256','canonical_utf8_bytes']),
      reference=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
    if(Number(reference.canonical_utf8_bytes)>16000)fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');
    return Object.freeze({status:'awaiting_selection',attempts:row.attempts,catalog_reference:reference,
      lease_released:true,evidence_retained:true,genuine_selection_intent:false,context_complete:false,pin_transfer:false});
  }});
}
