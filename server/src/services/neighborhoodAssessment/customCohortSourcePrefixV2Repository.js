import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=reason=>{throw new TypeError(`custom_cohort_source_prefix_v2_${reason}`);};
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(value){const r=data(value,['content_sha256','canonical_utf8_bytes']);
  const out=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(out.canonical_utf8_bytes)>16000)fail('invalid_reference');return out;}
function head(value){if(value===null)return null;
  const h=data(value,['source_reference','root_reference','sequence']);
  if(!Number.isInteger(h.sequence)||h.sequence<1||h.sequence>200000)fail('corrupt');
  return Object.freeze({source_reference:ref(h.source_reference),root_reference:ref(h.root_reference),sequence:h.sequence});}
function one(result){if(result?.rowCount!==1||result.rows?.length!==1)fail('claim_lost');return result.rows[0];}
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;

/** Independent monotonic issuance only. The actual owner reads the fixed
 * prepared original page and checks current/ending actor, subject and rights.
 * Native guards derive the one-node transition and atomic checkpoint commit.
 * No adoption of an already assembled free prefix or caller cursor/DONE. */
export function createCustomCohortSourcePrefixV2Repository(raw){
  const {client,claim:rawClaim,scope:rawScope,actorUserId}=data(raw,['client','claim','scope','actorUserId']);
  if(typeof client?.query!=='function')fail('invalid_input');
  const claim=prepareCustomCohortCaptureJobClaim(rawClaim),scope=data(rawScope,
    ['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![scope.organization_id,scope.report_file_id,actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id
    ||scope.account_id.length>64||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id
    ||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
    scope.assignment_file_id,scope.account_id,actorUserId];
  const read=async()=>{const r=one(await client.query(`/* custom-cohort-source-prefix-v2:read */
    SELECT h.source_reference,h.root_reference,h.sequence FROM app.neighborhood_custom_cohort_capture_jobs job
    LEFT JOIN app.neighborhood_custom_cohort_source_prefix_v2_heads h USING(operation_id)
    WHERE ${FENCE}`,values));
    return r.sequence===null&&r.source_reference===null&&r.root_reference===null?null:head(r);};
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-source-prefix-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({read,async advance(rawExpected,rawNext){
    const expected=head(rawExpected),next=data(rawNext,['source_reference','root_reference']),source=ref(next.source_reference),root=ref(next.root_reference),
      sequence=(expected?.sequence??0)+1;
    if(sequence>200000)fail('limit');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');
    if(!same(await read(),expected))fail('conflict');
    const result=expected===null?await client.query(`/* custom-cohort-source-prefix-v2:insert */
      INSERT INTO app.neighborhood_custom_cohort_source_prefix_v2_heads
        (operation_id,organization_id,actor_user_id,request_sha256,subject_reference,stock_reference,
         source_reference,root_reference,sequence,issued_claim_token,issued_attempts)
      SELECT job.operation_id,job.organization_id,job.actor_user_id,job.request_sha256,
        job.checkpoint->'evidence_refs'->0,job.checkpoint->'evidence_refs'->1,$9::jsonb,$10::jsonb,1,job.claim_token,job.attempts
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
      ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`,[...values,canonicalAssessmentJson(source),canonicalAssessmentJson(root)])
      :await client.query(`/* custom-cohort-source-prefix-v2:advance */
      UPDATE app.neighborhood_custom_cohort_source_prefix_v2_heads h SET source_reference=$9::jsonb,root_reference=$10::jsonb,
        sequence=$11::integer,issued_claim_token=job.claim_token,issued_attempts=job.attempts
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} AND h.operation_id=job.operation_id
        AND h.organization_id=job.organization_id AND h.actor_user_id=job.actor_user_id AND h.request_sha256=job.request_sha256
        AND h.source_reference=$12::jsonb AND h.root_reference=$13::jsonb AND h.sequence=$14::integer
      RETURNING h.sequence`,[...values,canonicalAssessmentJson(source),canonicalAssessmentJson(root),sequence,
        canonicalAssessmentJson(expected.source_reference),canonicalAssessmentJson(expected.root_reference),expected.sequence]);
    if(one(result).sequence!==sequence)fail('corrupt');
    const stored=await read();if(!same(stored,{source_reference:source,root_reference:root,sequence}))fail('corrupt');
    if(await tx()!==started)fail('caller_transaction_required');return stored;
  }});
}
