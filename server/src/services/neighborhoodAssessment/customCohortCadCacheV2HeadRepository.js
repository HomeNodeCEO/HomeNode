import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { CAD_CACHE_COVERAGE_V2_BINDINGS as BINDINGS } from './cohortCadCacheCoverageReceiptV2.js';

const fail=r=>{throw new TypeError(`custom_cohort_CAD_cache_v2_head_${r}`);};
const same=(a,b)=>json(a)===json(b),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`;
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);if(Reflect.ownKeys(ds).length!==keys.length
    ||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v){const r=data(v,['content_sha256','canonical_utf8_bytes']),out=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(out.canonical_utf8_bytes)>16000)fail('invalid_reference');return out;}
function anchor(raw){if(raw===null)return null;const h=data(raw,[...BINDINGS,'receipt_reference','sequence']);
  if(!Number.isInteger(h.sequence)||h.sequence<1||h.sequence>2_000_001)fail('corrupt');
  return Object.freeze({...Object.fromEntries([...BINDINGS,'receipt_reference'].map(k=>[k,ref(h[k])])),sequence:h.sequence});}
const one=r=>{if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];};

/** Independent manual CAD coverage only. Native guards require actual E DONE,
 * all original parents and the exact next complete stock account. The real
 * owner still replays every original/whole cache and both-end source rights.
 * No automatic enrollment, claim release, job phase or pin transfer. */
export function createCustomCohortCadCacheV2HeadRepository(raw){
  return repository(raw,false);
}
export function createCustomCohortCadCacheV2AutomaticHeadRepository(raw){
  return repository(raw,true);
}
function repository(raw,automatic){
  const o=data(raw,['client','claim','scope','actorUserId',...BINDINGS]),{client,actorUserId}=o,
    claim=prepareCustomCohortCaptureJobClaim(o.claim),scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||!scope.account_id.isWellFormed()||Buffer.byteLength(scope.account_id)>64
    ||scope.account_id!==scope.account_id.trim()||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const frozen=Object.fromEntries(BINDINGS.map(k=>[k,ref(o[k])])),values=[claim.operation_id,claim.claim_token,claim.attempts,
    scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,actorUserId],
    mode=automatic?'app.neighborhood_cad_success_v2_matches(job.operation_id,job.organization_id,job.claim_token,job.attempts)'
      :"job.request_payload->>'execution_mode' IS NULL AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c WHERE c.operation_id=job.operation_id)",
    fence=`${FENCE} AND ${mode}`;
  const read=async()=>{const row=one(await client.query(`/* custom-cohort-CAD-cache-v2:anchor-read */
    SELECT ${BINDINGS.map(k=>`h.${k}`).join(',')},h.receipt_reference,h.sequence
    FROM app.neighborhood_custom_cohort_capture_jobs job
    LEFT JOIN app.neighborhood_custom_cohort_cad_cache_v2_heads h ON h.operation_id=job.operation_id WHERE ${fence}`,values));
    if([...BINDINGS,'receipt_reference','sequence'].every(k=>row[k]===null))return null;
    const h=anchor(row);if(!BINDINGS.every(k=>same(h[k],frozen[k])))fail('binding_changed');return h;};
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-CAD-cache-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({read,async advance(rawExpected,rawReceipt){
    const expected=anchor(rawExpected),receipt=ref(rawReceipt),sequence=(expected?.sequence??0)+1;
    if(sequence>2_000_001||expected&&!BINDINGS.every(k=>same(expected[k],frozen[k])))fail('binding_changed');
    const started=await tx();if(await tx()!==started)fail('caller_transaction_required');if(!same(await read(),expected))fail('conflict');
    const bound=BINDINGS.map(k=>json(frozen[k]));
    const r=expected===null?await client.query(`/* custom-cohort-CAD-cache-v2:anchor-insert */
      INSERT INTO app.neighborhood_custom_cohort_cad_cache_v2_heads
        (operation_id,organization_id,${BINDINGS.join(',')},receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,${BINDINGS.map((_,i)=>`$${i+9}::jsonb`).join(',')},$16::jsonb,1
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${fence} ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`,
    [...values,...bound,json(receipt)])
      :await client.query(`/* custom-cohort-CAD-cache-v2:anchor-advance */
        UPDATE app.neighborhood_custom_cohort_cad_cache_v2_heads h SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${fence}
          AND h.operation_id=job.operation_id AND h.organization_id=job.organization_id
          AND ${BINDINGS.map((k,i)=>`h.${k}=$${i+11}::jsonb`).join(' AND ')}
          AND h.receipt_reference=$18::jsonb AND h.sequence=$19::integer RETURNING h.sequence`,
      [...values,json(receipt),sequence,...bound,json(expected.receipt_reference),expected.sequence]);
    if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
    if(!same(stored,{...frozen,receipt_reference:receipt,sequence}))fail('corrupt');if(await tx()!==started)fail('caller_transaction_required');return stored;
  }});
}
