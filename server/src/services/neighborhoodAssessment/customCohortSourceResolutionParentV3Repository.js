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
// issue durable18, yield progress or remove the unconditional COMMIT refusal.
// The separate provisional checkpoint changes only roots. Its atomic birth
// handoff also clears the exact claim after retaining the ENTIRE old job; it
// still cannot COMMIT, admit a fresh18 claim or deliver durable success.
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
  const firstFields=['operation_id','organization_id','generation_id','command_id','index_reference','index_sequence',
    'kind','native_key','first_selected_ordinal','selected_account_id','partition_ordinal','entry_reference',
    'metric_row_reference','contribution_row_reference','issued_transaction_id'],
    firstSelected=`SELECT b.* FROM app.neighborhood_source_resolution_v3_native_first($1::uuid,$2::uuid) b
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p USING(operation_id,organization_id)
      WHERE p.report_file_id=$3::uuid AND p.assignment_file_id=$4::bigint AND p.account_id=$5 AND p.actor_user_id=$6::uuid
        AND p.issued_claim_token=$7::uuid AND p.issued_attempts=$8::integer`,
    prepareFirst=(v,id)=>{
      const p=data(v,firstFields);
      if(p.operation_id!==claim.operation_id||p.organization_id!==scope.organization_id||p.issued_transaction_id!==id
        ||![p.generation_id,p.command_id].every(v=>typeof v==='string'&&UUID.test(v))
        ||!Number.isSafeInteger(p.index_sequence)||p.index_sequence<2||p.index_sequence>2000001
        ||!['source_record','legacy_sale'].includes(p.kind)||typeof p.native_key!=='string'
        ||!/^[1-9][0-9]{0,18}$/.test(p.native_key)||BigInt(p.native_key)>9223372036854775807n
        ||!Number.isSafeInteger(p.first_selected_ordinal)||p.first_selected_ordinal<1||p.first_selected_ordinal>=p.index_sequence
        ||!Number.isSafeInteger(p.partition_ordinal)||p.partition_ordinal<1||p.partition_ordinal>2000000
        ||typeof p.selected_account_id!=='string'||!p.selected_account_id||p.selected_account_id.length>64
        ||!p.selected_account_id.isWellFormed()||p.selected_account_id.trim()!==p.selected_account_id
        ||/[\u0000-\u001f\u007f]/.test(p.selected_account_id))fail('native_first_corrupt');
      return Object.freeze({...p,index_reference:reference(p.index_reference,4096),entry_reference:reference(p.entry_reference,1000000),
        metric_row_reference:reference(p.metric_row_reference,4096),contribution_row_reference:reference(p.contribution_row_reference,4096)});
    };
  const candidateFields=['operation_id','organization_id','sequence','candidate_reference','issued_transaction_id'],
    prepareCandidateRow=(v,id,expected)=>{
      const p=data(v,candidateFields),r=Object.freeze({...p,candidate_reference:reference(p.candidate_reference,12000)});
      if(p.operation_id!==claim.operation_id||p.organization_id!==scope.organization_id||p.sequence!==1
        ||p.issued_transaction_id!==id||json(r.candidate_reference)!==json(expected))fail('native_candidate_changed');return r;
    },
    candidateSelected=`SELECT b.operation_id,b.organization_id,1::integer AS sequence,$9::jsonb AS candidate_reference,b.issued_transaction_id
      FROM (${firstSelected}) b JOIN app.neighborhood_custom_cohort_source_resolution_v3_first saved
        ON saved.operation_id=b.operation_id AND to_jsonb(saved)=to_jsonb(b)`,
    headSelected=`SELECT r.* FROM (${firstSelected}) b
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_first saved
        ON saved.operation_id=b.operation_id AND to_jsonb(saved)=to_jsonb(b)
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_rows r
        ON r.operation_id=b.operation_id AND r.organization_id=b.organization_id
        AND r.issued_transaction_id=b.issued_transaction_id AND r.sequence=1`;
  let candidateRow=null,retainedParent=null,retainedFirst=null,retainedHead=null,savedCheckpoint=false;
  return Object.freeze({async insertActual17Parent(...a){
    if(a.length)fail('invalid_input');
    const id=await tx();if(await tx()!==id)fail('caller_transaction_required');
    const expected=prepare(one(await o.client.query('/* custom-cohort-source-resolution-parent-v3:native */ '+selected,values)),id);
    if(await tx()!==id)fail('caller_transaction_required');
    const retained=prepare(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:insert */
      INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_parents ${selected} RETURNING *`,values)),id);
    if(json(retained)!==json(expected))fail('native_parent_changed');
    if(await tx()!==id)fail('caller_transaction_required');retainedParent=retained;return retained;
  },async insertActualFirstSourceBinding(...a){
    if(a.length)fail('invalid_input');
    const id=await tx();if(await tx()!==id)fail('caller_transaction_required');
    const expected=prepareFirst(one(await o.client.query('/* custom-cohort-source-resolution-parent-v3:first-native */ '+firstSelected,values)),id);
    if(await tx()!==id)fail('caller_transaction_required');
    const retained=prepareFirst(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:first-insert */
      INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_first ${firstSelected} RETURNING *`,values)),id);
    if(json(retained)!==json(expected))fail('native_first_changed');
    if(await tx()!==id)fail('caller_transaction_required');retainedFirst=retained;return retained;
  },async insertActualFirstSourceCandidate(...a){
    // Representation only: the actual bounded original owner derives and
    // stores this blob itself. SQL independently binds its entire metadata to
    // retained17/FIRST; it does not infer source rights from the reference.
    if(a.length!==1||candidateRow!==null)fail('invalid_input');const candidate=reference(a[0],12000);
    const id=await tx();if(await tx()!==id)fail('caller_transaction_required');
    prepareFirst(one(await o.client.query('/* custom-cohort-source-resolution-parent-v3:candidate-native */ '+firstSelected,values)),id);
    if(await tx()!==id)fail('caller_transaction_required');
    const retained=prepareCandidateRow(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:candidate-insert */
      INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_rows ${candidateSelected} RETURNING *`,
    [...values,json(candidate)])),id,candidate);
    if(await tx()!==id)fail('caller_transaction_required');candidateRow=retained;return retained;
  },async insertActualFirstSourceHead(...a){
    if(a.length||candidateRow===null)fail('candidate_row_required');
    // The private candidate's actual issued TX is independently re-derived by
    // headSelected's native-FIRST/actual17 join below. Use that real native
    // read as the first transaction observation; retain the following explicit
    // observation and ending check instead of two redundant leading probes.
    const id=candidateRow.issued_transaction_id;
    const current=prepareCandidateRow(one(await o.client.query(
      '/* custom-cohort-source-resolution-parent-v3:head-native */ '+headSelected,values)),id,candidateRow.candidate_reference);
    if(json(current)!==json(candidateRow))fail('native_candidate_changed');
    if(await tx()!==id)fail('caller_transaction_required');
    const retained=prepareCandidateRow(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:head-insert */
      INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_heads ${headSelected} RETURNING *`,values)),id,candidateRow.candidate_reference);
    if(json(retained)!==json(candidateRow))fail('native_candidate_changed');
    if(await tx()!==id)fail('caller_transaction_required');retainedHead=retained;return retained;
  },async saveActualFirstSourceCheckpoint(...a){
    // Birth-only and still uncommittable. No caller checkpoint/reference,
    // projected18-to17 reconstruction or ordinary checkpoint codec widening.
    if(a.length||retainedParent===null||retainedHead===null||savedCheckpoint)fail('native_checkpoint_required');
    const id=retainedParent.issued_transaction_id;
    const expected=Object.freeze({phase:'frozen_selected_source_resolution_refs_v3',
      evidence_refs:Object.freeze([...retainedParent.parent_checkpoint.evidence_refs,retainedHead.candidate_reference])}),
      scoped=`job.operation_id=$1::uuid AND job.organization_id=$2::uuid AND job.report_file_id=$3::uuid
        AND job.assignment_file_id=$4::bigint AND job.account_id=$5 AND job.actor_user_id=$6::uuid
        AND job.claim_token=$7::uuid AND job.attempts=$8::integer`,
      prepareSaved=v=>{const r=data(v,['checkpoint','transaction_id']);
        if(r.transaction_id!==id)fail('caller_transaction_required');
        const p=data(r.checkpoint,['phase','evidence_refs']);
        // Comparing the complete closed data shape also refuses executable
        // descriptors before canonical serialization can invoke them.
        const refs=p.evidence_refs;
        if(p.phase!==expected.phase||!Array.isArray(refs)||isProxy(refs)||Object.getPrototypeOf(refs)!==Array.prototype
          ||refs.length!==18||Reflect.ownKeys(refs).length!==19)fail('native_checkpoint_changed');
        const prepared=[];for(let i=0;i<18;i++){
          const d=Object.getOwnPropertyDescriptor(refs,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('native_checkpoint_changed');
          prepared.push(reference(d.value,i===17?12000:i===16?4096:999999999));
        }
        const result=Object.freeze({phase:p.phase,evidence_refs:Object.freeze(prepared)});
        if(Buffer.byteLength(json(result))>4096||json(result)!==json(expected))fail('native_checkpoint_changed');return result;
      };
    // One real native statement re-derives18 and returns its actual TX. The
    // immutable retained17 birth TX is also a WHERE fence, so autocommit or a
    // replaced transaction cannot mutate even before JS examines RETURNING.
    // Both native job guards still compare the entire OLD tuple and actual
    // parent/FIRST/row/head again. No original/authority read is omitted.
    const retained=prepareSaved(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:checkpoint-save */
      UPDATE app.neighborhood_custom_cohort_capture_jobs job
      SET checkpoint=app.neighborhood_source_resolution_v3_first_checkpoint(job.operation_id,job.organization_id),
        updated_at=clock_timestamp()
      FROM app.neighborhood_custom_cohort_source_resolution_v3_parents birth
      WHERE ${scoped} AND birth.operation_id=job.operation_id AND birth.organization_id=job.organization_id
        AND birth.issued_transaction_id=txid_current() AND birth.parent_checkpoint=job.checkpoint
      RETURNING job.checkpoint,txid_current()::text AS transaction_id`,values)));
    savedCheckpoint=true;return retained;
  },async saveAndYieldActualFirstSourceCheckpoint(...a){
    // A separate provisional atomic birth handoff. The native INSERT captures
    // the ENTIRE actual17 job and independently derives18 before one UPDATE
    // clears this exact claim. All six deferred COMMIT refusals remain.
    if(a.length||retainedParent===null||retainedFirst===null||retainedHead===null||savedCheckpoint)fail('native_checkpoint_required');
    const id=retainedParent.issued_transaction_id,expected={phase:'frozen_selected_source_resolution_refs_v3',
      evidence_refs:[...retainedParent.parent_checkpoint.evidence_refs,retainedHead.candidate_reference]};
    const r=data(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:handoff-save */
      WITH issued AS (
        INSERT INTO app.neighborhood_custom_cohort_source_resolution_v3_handoffs
        SELECT h.* FROM app.neighborhood_source_resolution_v3_native_first_handoff($1::uuid,$2::uuid) h
        WHERE h.birth_job->>'report_file_id'=$3 AND h.birth_job->>'assignment_file_id'=$4
          AND h.birth_job->>'account_id'=$5 AND h.birth_job->>'actor_user_id'=$6
          AND h.issued_claim_token=$7::uuid AND h.issued_attempts=$8::integer
        RETURNING *
      ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
        SET checkpoint=issued.checkpoint,status='retry',claim_token=NULL,lease_expires_at=NULL,
          run_after=clock_timestamp(),updated_at=clock_timestamp()
        FROM issued WHERE job.operation_id=issued.operation_id AND job.organization_id=issued.organization_id
          AND to_jsonb(job)=issued.birth_job AND issued.issued_transaction_id=txid_current()
        RETURNING job.checkpoint,job.status,job.claim_token::text,job.lease_expires_at,job.attempts,
          issued.sequence,issued.issued_claim_token::text,issued.issued_attempts,
          txid_current()::text AS transaction_id`,values)),
    ['checkpoint','status','claim_token','lease_expires_at','attempts','sequence','issued_claim_token','issued_attempts','transaction_id']);
    if(r.transaction_id!==id)fail('caller_transaction_required');
    const cp=data(r.checkpoint,['phase','evidence_refs']),refs=cp.evidence_refs;
    if(!Array.isArray(refs)||isProxy(refs)||Object.getPrototypeOf(refs)!==Array.prototype
      ||refs.length!==18||Reflect.ownKeys(refs).length!==19)fail('native_checkpoint_changed');
    const prepared=[];for(let i=0;i<18;i++){
      const d=Object.getOwnPropertyDescriptor(refs,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('native_checkpoint_changed');
      prepared.push(reference(d.value,i===17?12000:i===16?4096:999999999));
    }
    const checkpoint=Object.freeze({phase:cp.phase,evidence_refs:Object.freeze(prepared)});
    if(Buffer.byteLength(json(checkpoint))>4096||json(checkpoint)!==json(expected)
      ||r.status!=='retry'||r.claim_token!==null||r.lease_expires_at!==null||r.attempts!==claim.attempts
      ||r.sequence!==1||r.issued_claim_token!==claim.claim_token||r.issued_attempts!==claim.attempts)fail('native_handoff_changed');
    // Reopen the immutable ENTIRE actual17 birth under the real18 retry state.
    // The new native reader independently rechecks the actual index, stock,
    // generation pin, original consumed continuation and FIRST/member edge.
    // Original birth TX/token/attempt stay unchanged;18 is never stripped or
    // passed back as17. One extra metadata query shares the same owner budget.
    const reopened=data(one(await o.client.query(`/* custom-cohort-source-resolution-parent-v3:handoff-retained-read */
      SELECT to_jsonb(p)||jsonb_build_object('assignment_file_id',p.assignment_file_id::text,
          'issued_transaction_id',p.issued_transaction_id::text) AS parent,
        to_jsonb(f)||jsonb_build_object('issued_transaction_id',f.issued_transaction_id::text) AS first,
        txid_current()::text AS transaction_id
      FROM app.neighborhood_source_resolution_v3_retained_first_after_handoff($1::uuid,$2::uuid) f
      JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p USING(operation_id,organization_id)
      WHERE p.report_file_id=$3::uuid AND p.assignment_file_id=$4::bigint AND p.account_id=$5 AND p.actor_user_id=$6::uuid
        AND p.issued_claim_token=$7::uuid AND p.issued_attempts=$8::integer AND p.issued_transaction_id=txid_current()`,values)),
    ['parent','first','transaction_id']);
    if(reopened.transaction_id!==id)fail('caller_transaction_required');
    if(json(prepare(reopened.parent,id))!==json(retainedParent)
      ||json(prepareFirst(reopened.first,id))!==json(retainedFirst))fail('retained_birth_changed');
    savedCheckpoint=true;
    return Object.freeze({checkpoint,status:'provisional_source_handoff',attempts:claim.attempts,continuation_sequence:1,
      durable_source_resolution_issued:false,fresh_claim_admitted:false,context_complete:false,pin_transfer:false});
  }});
}
