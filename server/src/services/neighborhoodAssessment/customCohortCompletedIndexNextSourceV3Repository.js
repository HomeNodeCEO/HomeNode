import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createCustomCohortCompletedIndexFirstSourceV3Repository as firstRepository } from './customCohortCompletedIndexFirstSourceV3Repository.js';
import { COMPLETED_INDEX_NEXT_SOURCE_CONTEXT_V3_SQL as NEXT } from './completedIndexNextSourceV3Sql.js';

const fail=reason=>{throw new TypeError(`custom_cohort_completed_index_next_source_v3_${reason}`);};
const same=(a,b)=>json(a)===json(b);
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length
    ||!keys.every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
function ref(value,max=4096){
  const r=data(value,['content_sha256','canonical_utf8_bytes']);
  const p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('native_plan_corrupt');return p;
}
function integer(value,max){
  if(!Number.isSafeInteger(value)||Object.is(value,-0)||value<1||value>max)fail('native_plan_corrupt');return value;
}

// READ ONLY metadata. The closed original owner must independently reopen the
// entire selected account/package, subject, ENTIRE caches and native members,
// then repeat this selection after ALL current/ending fences in the same
// bounded transaction. No caller source, account, cursor, count or callback.
export function createCustomCohortCompletedIndexNextSourceV3Repository(...args){
  if(args.length!==1)fail('invalid_input');
  const raw=data(args[0],['client','claim','scope','actorUserId']),o={...raw,
    claim:Object.freeze(data(raw.claim,['operation_id','claim_token','attempts'])),
    scope:Object.freeze(data(raw.scope,['organization_id','report_file_id','assignment_file_id','account_id']))};
  // This independently validates the exact detached scope and actual complete
  // native17 context, including job lock, original continuation and every root.
  const first=firstRepository(o);let observed=null,transaction=null;
  return Object.freeze({async readNextSource(...values){
    if(values.length)fail('invalid_input');
    const predecessor=await first.readFirst();
    if(predecessor.source===null)fail('no_registered_source');
    const result=await o.client.query(`/* custom-cohort-completed-index-next-source-v3:native-next */
      SELECT txid_current()::text AS transaction_id,chosen.* FROM (${NEXT}
       AND job.claim_token=$3::uuid AND job.attempts=$4::integer AND job.organization_id=$5::uuid
       AND job.report_file_id=$6::uuid AND job.assignment_file_id=$7::bigint
       AND job.account_id=$8 AND job.actor_user_id=$9::uuid) chosen`,
    [o.claim.operation_id,predecessor.generation_id,o.claim.claim_token,o.claim.attempts,o.scope.organization_id,
      o.scope.report_file_id,o.scope.assignment_file_id,o.scope.account_id,o.actorUserId]);
    if(result?.rowCount!==1||result.rows?.length!==1)fail('no_next_registered_source');
    const r=data(result.rows[0],['transaction_id','generation_id','account_id','ordinal','partition_ordinal',
      'entry_reference','metric_row_reference','contribution_row_reference','index_reference','index_sequence',
      'kind','native_key','first_selected_ordinal']);
    if(typeof r.transaction_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(r.transaction_id))fail('caller_transaction_required');
    if(transaction!==null&&r.transaction_id!==transaction)fail('caller_transaction_required');transaction=r.transaction_id;
    if(r.generation_id!==predecessor.generation_id||!same(ref(r.index_reference),predecessor.index_reference)
      ||r.index_sequence!==predecessor.index_sequence||!['source_record','legacy_sale'].includes(r.kind)
      ||typeof r.native_key!=='string'||!/^[1-9][0-9]{0,18}$/.test(r.native_key)
      ||BigInt(r.native_key)>9223372036854775807n
      ||predecessor[r.kind==='source_record'?'registered_source_keys':'registered_legacy_keys']<1
      ||r.kind==='source_record'&&(predecessor.source.kind!=='source_record'||BigInt(r.native_key)<=BigInt(predecessor.source.native_key))
      ||r.kind==='legacy_sale'&&predecessor.source.kind==='legacy_sale'
        &&Buffer.compare(Buffer.from(r.native_key),Buffer.from(predecessor.source.native_key))<=0
      ||r.ordinal!==r.first_selected_ordinal)fail('native_plan_corrupt');
    integer(r.ordinal,predecessor.selected_stock_count);integer(r.partition_ordinal,2000000);
    if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()
      ||r.account_id.trim()!==r.account_id||/[\u0000-\u001f\u007f]/.test(r.account_id))fail('native_plan_corrupt');
    const source=Object.freeze({kind:r.kind,native_key:r.native_key,first_selected_ordinal:r.first_selected_ordinal}),
      selected=Object.freeze({account_id:r.account_id,ordinal:r.ordinal,partition_ordinal:r.partition_ordinal,
        entry_reference:ref(r.entry_reference,1000000),metric_row_reference:ref(r.metric_row_reference),
        contribution_row_reference:ref(r.contribution_row_reference)}),
      plan=Object.freeze({...predecessor,format:'cohort_completed_index_next_source_plan_v3',
        predecessor:predecessor.source,source,selected_entry:selected});
    if(Buffer.byteLength(json(plan))>4096)fail('byte_limit');
    if(observed!==null&&!same(observed,plan))fail('native_plan_changed');observed=plan;return plan;
  }});
}
