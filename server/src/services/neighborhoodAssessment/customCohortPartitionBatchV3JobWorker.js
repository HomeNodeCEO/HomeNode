// Inactive exact-V3 partition worker; every step invokes the real original owner.
import { CAPTURE_JOB_LEASE_SECONDS,createCustomCohortCaptureJobRepository } from './customCohortCaptureJobRepository.js';
import { createCustomCohortPartitionBatchV3WorkerRepository } from './customCohortPartitionBatchV3WorkerRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';
const failureReason=error=>error?.message==='custom_cohort_job_actor_access_revoked'||error?.reason==='assignment_access_denied'?'access_revoked'
  :['cancelled','deadline_exceeded','subject_changed','market_policy_changed'].includes(error?.reason)?error.reason:'capture_failed';

/** One dormant original-backed partition step after native stock DONE.
 * Actual native cache coverage is rechecked around every whole original/cache
 * replay. Completed partition stays for catalog; no publication/pin transfer. */
export async function runCustomCohortPartitionBatchV3JobOnce({pool,cohortService,
  claimRepositoryFactory=createCustomCohortPartitionBatchV3WorkerRepository,
  repositoryFactory=createCustomCohortCaptureJobRepository,loadActor=loadCurrentCustomCohortJobActor,
  leaseSeconds=300,heartbeatSeconds=15}={}){
  if(typeof pool?.connect!=='function'||typeof cohortService?.continueCoveredOriginalFrozenCaptureJobRecordedPartitionBatchReferencesV3!=='function'
    ||![claimRepositoryFactory,repositoryFactory,loadActor].every(v=>typeof v==='function')
    ||!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max
    ||!Number.isInteger(heartbeatSeconds)||heartbeatSeconds<1||heartbeatSeconds*3>=leaseSeconds)
    throw new TypeError('custom_cohort_partition_batch_v3_worker_invalid_input');
  let row;
  try{[row]=await transaction(pool,client=>claimRepositoryFactory(client).claimDue({leaseSeconds}));}
  catch(error){if(error?.outcome_unknown)return Object.freeze({status:'outcome_unknown'});throw error;}
  if(!row)return Object.freeze({status:'idle'});
  const {claim,scope}=row,controller=new AbortController();let timer,heartbeatPromise,stopping=false;
  const checkHeartbeat=async()=>{const r=await transaction(pool,client=>repositoryFactory(client).heartbeat(claim,{leaseSeconds}));
    if(r.cancellation_requested)controller.abort();};
  const heartbeat=()=>{if(stopping)return;heartbeatPromise=checkHeartbeat().catch(()=>controller.abort()).finally(()=>{
    if(!stopping)timer=setTimeout(heartbeat,heartbeatSeconds*1000);});};
  try{
    const {auth,request}=await transaction(pool,async client=>({auth:await loadActor(client,row.actor_user_id,scope.organization_id),
      request:await repositoryFactory(client).readRequest(claim,{scope,actorUserId:row.actor_user_id})}));
    if(!['frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2'].includes(row.phase)
      ||row.progress_done!==(row.phase==='frozen_stock_traversal_refs_v2')||request.execution_mode!=='frozen-originals-v2'||request.private_sales_import||request.operation_id!==claim.operation_id
      ||request.discovery?.profile_id!=='custom-suburban-radius-v2')throw new TypeError('custom_cohort_partition_batch_v3_worker_invalid_job');
    await checkHeartbeat();if(controller.signal.aborted)throw Object.assign(new Error('cancelled'),{reason:'cancelled'});
    timer=setTimeout(heartbeat,heartbeatSeconds*1000);
    const result=await cohortService.continueCoveredOriginalFrozenCaptureJobRecordedPartitionBatchReferencesV3({auth,accountId:scope.account_id,
      assignmentFileId:scope.assignment_file_id,operationId:request.operation_id,observationPeriod:request.observation_period,discovery:request.discovery},
    {captureJobClaim:claim,signal:controller.signal});
    const c=result?.continuation;
    if(result?.status!=='original_recorded_partition_batch_progress_retained'||result.operation_id!==claim.operation_id
      ||result.receipt_format!=='cohort_recorded_group_partition_batch_receipt_v3'||result.one_receipt_per_whole_batch!==true
      ||!Number.isInteger(result.batch_accounts)||result.batch_accounts<0||result.batch_accounts>8
      ||!Number.isInteger(result.batch_originals)||result.batch_originals<0||result.batch_originals>250
      ||result.covered_neutral_originals!==true||result.context_complete!==false||result.pin_transfer!==false||result.report_update!=='none'
      ||c?.status!=='continuation_pending'||c.phase!=='frozen_recorded_partition_refs_v2'||c.attempts!==claim.attempts
      ||c.fresh_claim_required!==true||c.context_complete!==false||c.pin_transfer!==false)
      throw new TypeError('custom_cohort_partition_batch_v3_worker_invalid_result');
    return Object.freeze({status:'continuation_pending',operation_id:claim.operation_id,context_complete:false,pin_transfer:false,report_update:'none'});
  }catch(error){
    try{const reason=failureReason(error),outcome=await transaction(pool,client=>repositoryFactory(client).failClaim(claim,reason));
      return Object.freeze({status:outcome.status,operation_id:claim.operation_id,reason});}
    catch(failure){if(failure?.message==='custom_cohort_capture_job_claim_lost'||failure?.outcome_unknown)
      return Object.freeze({status:'outcome_unknown',operation_id:claim.operation_id});throw failure;}
  }finally{stopping=true;clearTimeout(timer);await heartbeatPromise?.catch(()=>{});}
}
