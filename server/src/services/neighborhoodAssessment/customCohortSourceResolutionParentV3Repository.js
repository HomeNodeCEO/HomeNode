import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  fields=['operation_id','organization_id','report_file_id','assignment_file_id','account_id','actor_user_id',
    'request_sha256','command_id','generation_id','index_reference','index_sequence','parent_checkpoint',
    'issued_claim_token','issued_attempts','issued_transaction_id'],
  fail=reason=>{throw new TypeError(`custom_cohort_source_resolution_parent_v3_${reason}`);};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_or_actual17_parent_lost');return r.rows[0];}
function reference(v,max=999999999){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('native_parent_corrupt');return p;}
function checkpoint(v){
  const p=data(v,['phase','evidence_refs']),a=p.evidence_refs;
  if(p.phase!=='frozen_selected_transaction_index_refs_v2'||!Array.isArray(a)||isProxy(a)
    ||Object.getPrototypeOf(a)!==Array.prototype||a.length!==17||Reflect.ownKeys(a).length!==18)fail('native_parent_corrupt');
  const refs=[];for(let i=0;i<a.length;i++){
    const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('native_parent_corrupt');
    refs.push(reference(d.value,i===16?4096:999999999));
  }
  const result=Object.freeze({phase:p.phase,evidence_refs:Object.freeze(refs)});
  if(Buffer.byteLength(json(result))>4096)fail('native_parent_corrupt');return result;
}

// Dormant storage primitive inside the future actual original owner's bounded
// transaction. This does NOT authorize sources/actors, reconcile originals,
// issue18, save/yield progress or remove the unconditional COMMIT refusal.
// No caller checkpoint, cursor, source, reference, generation or row is input.
export function createCustomCohortSourceResolutionParentV3Repository(...args){
  if(args.length!==1)fail('invalid_input');
  const o=data(args[0],['client','claim','scope','actorUserId']),
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof o.client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64||!scope.account_id.isWellFormed()
    ||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,o.actorUserId,claim.claim_token,claim.attempts],
    selected=`SELECT p.* FROM app.neighborhood_source_resolution_v3_native_parent($1::uuid,$2::uuid) p
      WHERE p.report_file_id=$3::uuid AND p.assignment_file_id=$4::bigint AND p.account_id=$5 AND p.actor_user_id=$6::uuid
        AND p.issued_claim_token=$7::uuid AND p.issued_attempts=$8::integer`,
    tx=async()=>{const id=data(one(await o.client.query('/* custom-cohort-source-resolution-parent-v3:transaction */ SELECT txid_current()::text AS transaction_id')),['transaction_id']).transaction_id;
      if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;},
    prepare=(v,id)=>{
      const p=data(v,fields);
      for(const [key,value]of Object.entries({...scope,operation_id:claim.operation_id,actor_user_id:o.actorUserId,
        issued_claim_token:claim.claim_token,issued_attempts:claim.attempts,issued_transaction_id:id}))if(p[key]!==value)fail('native_parent_corrupt');
      if(![p.command_id,p.generation_id].every(v=>typeof v==='string'&&UUID.test(v))||typeof p.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.request_sha256)
        ||!Number.isSafeInteger(p.index_sequence)||p.index_sequence<1||p.index_sequence>2000001)fail('native_parent_corrupt');
      const index=reference(p.index_reference,4096),parent=checkpoint(p.parent_checkpoint);
      if(json(index)!==json(parent.evidence_refs[16]))fail('native_parent_corrupt');
      const result=Object.freeze({...p,index_reference:index,parent_checkpoint:parent});
      if(Buffer.byteLength(json(result))>8192)fail('native_parent_corrupt');return result;
    };
  return Object.freeze({async insertActual17Parent(...a){
    if(a.length)fail('invalid_input');
    const id=await tx();if(await tx()!==id)fail('caller_transaction_required');
    const expected=prepare(one(await o.client.query('/* custom-cohort-source-resolution-parent-v3:native */ '+selected,values)),id);
    if(await tx()!==id)fail('caller_transaction_required');
    const retained=prepare(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:insert */
      INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_parents ${selected} RETURNING *`,values)),id);
    if(json(retained)!==json(expected))fail('native_parent_changed');
    if(await tx()!==id)fail('caller_transaction_required');return retained;
  }});
}
