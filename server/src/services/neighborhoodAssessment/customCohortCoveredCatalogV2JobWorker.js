import { CAPTURE_JOB_LEASE_SECONDS,createCustomCohortCaptureJobRepository } from './customCohortCaptureJobRepository.js';
import { createCustomCohortCoveredCatalogV2WorkerRepository } from './customCohortCoveredCatalogV2WorkerRepository.js';
import { loadCurrentCustomCohortJobActor } from './customCohortJobActor.js';
import { withCustomCohortJobTransaction as transaction } from './customCohortJobTransaction.js';
const failureReason=error=>error?.message==='custom_cohort_job_actor_access_revoked'||error?.reason==='assignment_access_denied'?'access_revoked'
  :['cancelled','deadline_exceeded','subject_changed','market_policy_changed'].includes(error?.reason)?error.reason:'capture_failed';

/** One dormant original-backed catalog step after native partition DONE.
 * Actual native cache coverage is rechecked around every whole original/cache
 * and entire partition entry replay. Catalog DONE stays for selection-wait. */
export async function runCustomCohortCoveredCatalogV2JobOnce({pool,cohortService,
  claimRepositoryFactory=createCustomCohortCoveredCatalogV2WorkerRepository,
  repositoryFactory=createCustomCohortCaptureJobRepository,loadActor=loadCurrentCustomCohortJobActor,
  leaseSeconds=300,heartbeatSeconds=15}={}){
  if(typeof pool?.connect!=='function'||typeof cohortService?.continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2!=='function'
    ||![claimRepositoryFactory,repositoryFactory,loadActor].every(v=>typeof v==='function')
    ||!Number.isInteger(leaseSeconds)||leaseSeconds<CAPTURE_JOB_LEASE_SECONDS.min||leaseSeconds>CAPTURE_JOB_LEASE_SECONDS.max
    ||!Number.isInteger(heartbeatSeconds)||heartbeatSeconds<1||heartbeatSeconds*3>=leaseSeconds)
    throw new TypeError('custom_cohort_covered_catalog_v2_worker_invalid_input');
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
    if(!['frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2'].includes(row.phase)
      ||row.progress_done!==(row.phase==='frozen_recorded_partition_refs_v2')||request.execution_mode!=='frozen-originals-v2'||request.private_sales_import||request.operation_id!==claim.operation_id
      ||request.discovery?.profile_id!=='custom-suburban-radius-v2')throw new TypeError('custom_cohort_covered_catalog_v2_worker_invalid_job');
    await checkHeartbeat();if(controller.signal.aborted)throw Object.assign(new Error('cancelled'),{reason:'cancelled'});
    timer=setTimeout(heartbeat,heartbeatSeconds*1000);
    const result=await cohortService.continueCoveredOriginalFrozenCaptureJobRecordedCatalogReferencesV2({auth,accountId:scope.account_id,
      assignmentFileId:scope.assignment_file_id,operationId:request.operation_id,observationPeriod:request.observation_period,discovery:request.discovery},
    {captureJobClaim:claim,signal:controller.signal});
    const c=result?.continuation;
    if(result?.status!=='original_recorded_catalog_progress_retained'||result.operation_id!==claim.operation_id
      ||result.covered_neutral_originals!==true||result.context_complete!==false||result.pin_transfer!==false||result.report_update!=='none'
      ||c?.status!=='continuation_pending'||c.phase!=='frozen_recorded_catalog_refs_v2'||c.attempts!==claim.attempts
      ||c.fresh_claim_required!==true||c.context_complete!==false||c.pin_transfer!==false)
      throw new TypeError('custom_cohort_covered_catalog_v2_worker_invalid_result');
    return Object.freeze({status:'continuation_pending',operation_id:claim.operation_id,context_complete:false,pin_transfer:false,report_update:'none'});
  }catch(error){
    try{const reason=failureReason(error),outcome=await transaction(pool,client=>repositoryFactory(client).failClaim(claim,reason));
      return Object.freeze({status:outcome.status,operation_id:claim.operation_id,reason});}
    catch(failure){if(failure?.message==='custom_cohort_capture_job_claim_lost'||failure?.outcome_unknown)
      return Object.freeze({status:'outcome_unknown',operation_id:claim.operation_id});throw failure;}
  }finally{stopping=true;clearTimeout(timer);await heartbeatPromise?.catch(()=>{});}
}
