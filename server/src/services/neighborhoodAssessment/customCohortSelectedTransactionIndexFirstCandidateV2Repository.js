import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as REFS,prepareCohortSelectedTransactionIndexFirstPlanV2 } from './cohortSelectedTransactionIndexFirstCandidateV2.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=r=>{throw new TypeError(`custom_cohort_selected_transaction_index_first_candidate_v2_${r}`);};
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
const ROW=['transaction_id','generation_id','account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference',
  'contribution_row_reference','anchor_count','kind','native_key','selected_stock_count'];
const CHILDREN=['selected_transaction_index_v2_rows','selected_transaction_source_v2_keys','selected_transaction_legacy_v2_keys',
  'selected_transaction_index_v2_edges','selected_transaction_index_v2_heads'];

/** INACTIVE read-only actual native plan. No caller ordinal, keys, count,
 * callback, transaction id or DONE. No DML/receipt/continuation/phase17. The
 * complete-original context owner remains the sole source/authority boundary. */
export function createCustomCohortSelectedTransactionIndexFirstCandidateV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id',...REFS]),
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof o.client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64||!scope.account_id.isWellFormed()
    ||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const roots=REFS.map(k=>{const r=data(o[k],['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
    if(Number(p.canonical_utf8_bytes)>(['numeric_reference','semantic_reference'].includes(k)?4096:16000))fail('invalid_reference');return json(p);}),
    bound=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,
      scope.account_id,o.actorUserId,o.command_id,...roots];
  let transaction=null;
  return Object.freeze({async readFirstCandidate(...args){
    if(args.length)fail('invalid_input');
    if(transaction===null){
      const r=await o.client.query('/* custom-cohort-selected-transaction-first-candidate-v2:transaction */ SELECT txid_current()::text AS transaction_id');
      if(r?.rowCount!==1||r.rows?.length!==1)fail('caller_transaction_required');
      transaction=data(r.rows[0],['transaction_id']).transaction_id;
      if(typeof transaction!=='string'||!/^[1-9][0-9]{0,19}$/.test(transaction))fail('caller_transaction_required');
    }
    const result=await o.client.query(`/* custom-cohort-selected-transaction-first-candidate-v2:native-plan */
      WITH bound_context AS MATERIALIZED (
        SELECT job.operation_id,job.organization_id,(ub.canonical_utf8::jsonb->>'after_selected_count')::integer AS selected_stock_count
        FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
        JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=job.operation_id AND u.organization_id=job.organization_id
        JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
          AND ub.content_sha256=u.receipt_reference->>'content_sha256'
          AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
          AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
          AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
          AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
          AND s.command_id=$9::uuid AND s.union_reference=$10::jsonb AND s.eligibility_reference=$11::jsonb
          AND s.evidence_reference=$12::jsonb AND s.metrics_reference=$13::jsonb AND s.statistics_reference=$14::jsonb
          AND s.numeric_reference=$15::jsonb AND s.receipt_reference=$16::jsonb
          AND u.command_id=$9::uuid AND u.receipt_reference=$10::jsonb
          AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
          AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
          AND app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          ${CHILDREN.map(t=>`AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_${t} existing WHERE existing.operation_id=job.operation_id LIMIT 1)`).join('\n          ')}
      )
      SELECT txid_current()::text AS transaction_id,k.*,c.selected_stock_count FROM bound_context c
      CROSS JOIN LATERAL app.neighborhood_selected_transaction_index_v2_next_keys(c.operation_id,c.organization_id) k
      ORDER BY CASE k.kind WHEN 'source_record' THEN 0 ELSE 1 END,
        CASE WHEN k.kind='source_record' THEN k.native_key::bigint END,
        CASE WHEN k.kind='legacy_sale' THEN k.native_key END COLLATE "C" LIMIT 251`,bound);
    if(!result||!Number.isInteger(result.rowCount)||result.rowCount<1||result.rowCount>250||!Array.isArray(result.rows)
      ||isProxy(result.rows)||Object.getPrototypeOf(result.rows)!==Array.prototype||result.rows.length!==result.rowCount
      ||Reflect.ownKeys(result.rows).length!==result.rows.length+1)fail('native_plan_missing_or_corrupt');
    let plan=null;const packages=[];
    for(let i=0;i<result.rows.length;i++){
      const d=Object.getOwnPropertyDescriptor(result.rows,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail('native_plan_missing_or_corrupt');
      const r=data(d.value,ROW);
      if(r.transaction_id!==transaction)fail('caller_transaction_required');
      const fields=['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'],
        empty=fields.every(k=>r[k]===null),rawHeader={generation_id:r.generation_id,selected_stock_count:r.selected_stock_count,
          selected_entry:empty?null:Object.fromEntries(fields.map(k=>[k,r[k]])),anchor_count:r.anchor_count};
      // Validate nested native DATA before canonical comparison; never invoke a
      // hostile nested toJSON/getter while checking repeated headers.
      let header;
      try{const {native_packages,...prepared}=prepareCohortSelectedTransactionIndexFirstPlanV2({...rawHeader,
        native_packages:r.kind===null&&r.native_key===null?[]:[{kind:r.kind,native_key:r.native_key}]});header=prepared;}
      catch{fail('native_plan_missing_or_corrupt');}
      if(plan===null)plan=header;else if(json(plan)!==json(header))fail('native_plan_missing_or_corrupt');
      if(r.kind===null||r.native_key===null){if(r.kind!==null||r.native_key!==null||result.rowCount!==1||r.anchor_count!==0)fail('native_plan_missing_or_corrupt');}
      else packages.push({kind:r.kind,native_key:r.native_key});
    }
    try{return prepareCohortSelectedTransactionIndexFirstPlanV2({...plan,native_packages:packages});}
    catch{fail('native_plan_missing_or_corrupt');}
  }});
}
