import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BINDINGS=['source_reference','root_reference','graph_reference','geographic_reference','stock_reference'];
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL`;
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
function fail(reason){throw new TypeError(`custom_cohort_identity_v2_anchor_${reason}`);}
function data(value,keys){
  if(!value||types.isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>names.includes(k)&&ds[k].enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(raw){const r=data(raw,['content_sha256','canonical_utf8_bytes']);
  const result=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(result.canonical_utf8_bytes)>16000)fail('invalid_reference');return result;}
function anchorOf(raw){
  if(raw===null)return null;
  const a=data(raw,[...BINDINGS,'receipt_reference','sequence']);
  if(!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>200000)fail('corrupt');
  return Object.freeze({...Object.fromEntries([...BINDINGS,'receipt_reference'].map(k=>[k,ref(a[k])])),sequence:a.sequence});
}
function one(r){if(r?.rowCount!==1||!Array.isArray(r.rows)||r.rows.length!==1)fail('claim_lost');return r.rows[0];}

/** Internal indexed issuance head, never a checkpoint-supplied continuation.
 * A real current-authorized identity owner must require completed issued graph
 * and geography, validate exact original identities/one-hop associations, then
 * atomically commit receipt/anchor/checkpoint with ending rights. This repository
 * is not such an owner, a source grant or proof of original validation. Its
 * caller must own one explicit transaction; anchor/owner DML integrity is trust. */
export function createCustomCohortIdentityV2AnchorRepository(raw){
  const input=data(raw,['client','claim','scope','actorUserId',...BINDINGS]);
  const {client,actorUserId}=input,claim=prepareCustomCohortCaptureJobClaim(input.claim);
  if(typeof client?.query!=='function')fail('invalid_input');
  const scope=data(input.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(![scope.organization_id,scope.report_file_id,actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'
    ||!scope.account_id||scope.account_id.length>64||!scope.account_id.isWellFormed()
    ||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const frozen=Object.fromEntries(BINDINGS.map(k=>[k,ref(input[k])])),values=[claim.operation_id,claim.claim_token,claim.attempts,
    scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,actorUserId];
  const read=async()=>{
    const row=one(await client.query(`/* custom-cohort-identity-v2:anchor-read */
      SELECT anchor.source_reference,anchor.root_reference,anchor.graph_reference,anchor.geographic_reference,
        anchor.stock_reference,anchor.receipt_reference,anchor.sequence FROM app.neighborhood_custom_cohort_capture_jobs job
      LEFT JOIN app.neighborhood_custom_cohort_identity_v2_anchors anchor ON anchor.operation_id=job.operation_id
      WHERE ${FENCE}`,values));
    if([...BINDINGS,'receipt_reference','sequence'].every(k=>row[k]===null))return null;
    const anchor=anchorOf(row);if(!BINDINGS.every(k=>same(anchor[k],frozen[k])))fail('binding_changed');return anchor;
  };
  const transactionId=async()=>{const id=one(await client.query(
    '/* custom-cohort-identity-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  return Object.freeze({read,async advance(rawExpected,rawReceipt){
    const expected=anchorOf(rawExpected),receipt=ref(rawReceipt),sequence=(expected?.sequence??0)+1;
    if(sequence>200000||expected&&!BINDINGS.every(k=>same(expected[k],frozen[k])))fail('binding_changed');
    const started=await transactionId();if(await transactionId()!==started)fail('caller_transaction_required');
    if(!same(await read(),expected))fail('conflict');
    const boundJson=BINDINGS.map(k=>canonicalAssessmentJson(frozen[k])),receiptJson=canonicalAssessmentJson(receipt);
    const result=expected===null?await client.query(`/* custom-cohort-identity-v2:anchor-insert */
      INSERT INTO app.neighborhood_custom_cohort_identity_v2_anchors
        (operation_id,organization_id,source_reference,root_reference,graph_reference,geographic_reference,stock_reference,receipt_reference,sequence)
      SELECT job.operation_id,job.organization_id,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,1
      FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
      ON CONFLICT(operation_id) DO NOTHING RETURNING sequence`,[...values,...boundJson,receiptJson])
      :await client.query(`/* custom-cohort-identity-v2:anchor-advance */
        UPDATE app.neighborhood_custom_cohort_identity_v2_anchors anchor SET receipt_reference=$9::jsonb,sequence=$10::integer
        FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE}
          AND anchor.operation_id=job.operation_id AND anchor.organization_id=job.organization_id
          AND anchor.source_reference=$11::jsonb AND anchor.root_reference=$12::jsonb
          AND anchor.graph_reference=$13::jsonb AND anchor.geographic_reference=$14::jsonb AND anchor.stock_reference=$15::jsonb
          AND anchor.receipt_reference=$16::jsonb AND anchor.sequence=$17::integer RETURNING anchor.sequence`,
      [...values,receiptJson,sequence,...boundJson,canonicalAssessmentJson(expected.receipt_reference),expected.sequence]);
    if(one(result).sequence!==sequence)fail('corrupt');
    const stored=await read();if(!same(stored,{...frozen,receipt_reference:receipt,sequence}))fail('corrupt');
    if(await transactionId()!==started)fail('caller_transaction_required');return stored;
  }});
}
