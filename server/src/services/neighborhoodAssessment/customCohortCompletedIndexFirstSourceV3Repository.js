import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCohortSelectedTransactionIndexReceiptV2 } from './cohortSelectedTransactionIndexReceiptV2.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEYS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference','semantic_reference'];
const fail=reason=>{throw new TypeError(`custom_cohort_completed_index_first_source_v3_${reason}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function reference(v,max){const r=data(v,['content_sha256','canonical_utf8_bytes']);
  const p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_or_completed_index_lost');return r.rows[0];}
function integer(v,max){if(!Number.isSafeInteger(v)||Object.is(v,-0)||v<1||v>max)fail('native_plan_corrupt');return v;}

// Inactive native metadata ONLY. This is not a source adapter, source-purpose
// decision, original replay or an economic transaction. A future actual source
// owner must reopen the chosen WHOLE package and required subject/selected
// originals, ENTIRE caches and all native members, then repeat this native read
// AFTER both ending source-purpose/actor/assignment/draft/subject/workspace
// fences in the SAME bounded transaction. No route or worker calls this module.
export function createCustomCohortCompletedIndexFirstSourceV3Repository(...args){
  if(args.length!==1)fail('invalid_input');
  const o=data(args[0],['client','claim','scope','actorUserId']),
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof o.client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64||!scope.account_id.isWellFormed()
    ||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,
    scope.assignment_file_id,scope.account_id,o.actorUserId];
  let started=null,observed=null;
  return Object.freeze({async readFirst(...a){
    if(a.length)fail('invalid_input');
    if(started===null){
      started=data(one(await o.client.query('/* custom-cohort-completed-index-first-source-v3:transaction */ SELECT txid_current()::text AS transaction_id')),['transaction_id']).transaction_id;
      if(typeof started!=='string'||!/^[1-9][0-9]{0,19}$/.test(started))fail('caller_transaction_required');
    }
    const r=data(one(await o.client.query(`/* custom-cohort-completed-index-first-source-v3:native-first */
      WITH bound_context AS MATERIALIZED (
        SELECT h.*,b.canonical_utf8::jsonb AS receipt,job.claim_token,job.attempts
        FROM app.neighborhood_custom_cohort_capture_jobs job
        JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h USING(operation_id,organization_id)
        JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id
          AND b.content_sha256=h.receipt_reference->>'content_sha256'
          AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
        JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id AND stock.organization_id=job.organization_id
          AND stock.generation_id=h.generation_id AND stock.report_file_id=job.report_file_id
          AND stock.assignment_file_id=job.assignment_file_id AND stock.account_id=job.account_id
          AND stock.actor_user_id=job.actor_user_id AND stock.status='complete'
        JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id
          AND pin.generation_id=stock.generation_id AND pin.organization_id=stock.organization_id AND pin.report_file_id=stock.report_file_id
          AND pin.assignment_file_id=stock.assignment_file_id AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
        JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
          AND generation.status='complete' AND generation.retirement_started_at IS NULL
        JOIN app.neighborhood_custom_cohort_v2_selection_intents command ON command.operation_id=job.operation_id
          AND command.organization_id=job.organization_id AND command.command_id=h.command_id AND command.request_sha256=job.request_sha256
        JOIN app.neighborhood_custom_cohort_v2_continuations continuation ON continuation.operation_id=job.operation_id
          AND continuation.organization_id=job.organization_id AND continuation.phase=job.checkpoint->>'phase'
          AND continuation.progress_reference=h.receipt_reference AND continuation.consumed_claim_token IS NOT NULL
          AND continuation.issued_attempts>=command.issued_attempts
          AND ((job.attempts=continuation.issued_attempts AND job.claim_token=continuation.consumed_claim_token)
            OR (job.attempts>continuation.issued_attempts AND job.claim_token<>continuation.issued_claim_token
              AND job.claim_token<>continuation.consumed_claim_token AND job.claim_token<>command.resume_claim_token))
        WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
          AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
          AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
          AND job.request_payload->>'execution_mode'='frozen-originals-v2'
          AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
          AND app.neighborhood_selected_transaction_index_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND b.canonical_utf8::jsonb->'after'->>'done'='true'
        FOR UPDATE OF job NOWAIT
      ), first_source AS MATERIALIZED (
        SELECT k.kind,k.native_key,k.first_selected_ordinal FROM bound_context c
        CROSS JOIN LATERAL (
          (SELECT 'source_record'::text AS kind,source_record_id::text AS native_key,first_selected_ordinal
            FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
            WHERE operation_id=c.operation_id AND organization_id=c.organization_id AND generation_id=c.generation_id
            ORDER BY source_record_id LIMIT 1)
          UNION ALL
          (SELECT 'legacy_sale'::text AS kind,legacy_sale_key AS native_key,first_selected_ordinal
            FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
            WHERE operation_id=c.operation_id AND organization_id=c.organization_id AND generation_id=c.generation_id
              AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys existing
                WHERE existing.operation_id=c.operation_id LIMIT 1)
            ORDER BY legacy_sale_key COLLATE "C" LIMIT 1)
        ) k
      )
      SELECT txid_current()::text AS transaction_id,c.receipt_reference AS head_reference,c.sequence AS head_sequence,c.receipt,
        jsonb_build_object('command_id',c.command_id,${KEYS.map(k=>`'${k}',c.${k}`).join(',')},
          'generation_id',c.generation_id,'selected_stock_count',c.receipt->'selected_stock_count') AS expected,
        k.kind,k.native_key,k.first_selected_ordinal,
        CASE WHEN k.kind IS NULL THEN NULL ELSE jsonb_build_object('account_id',m.account_id,'ordinal',m.ordinal,
          'partition_ordinal',m.partition_ordinal,'entry_reference',m.entry_reference,'metric_row_reference',m.metric_row_reference,
          'contribution_row_reference',m.contribution_row_reference) END AS selected_entry,
        coalesce(CASE WHEN k.kind IS NULL THEN c.receipt->'after'->>'source_record_keys'='0'
          AND c.receipt->'after'->>'legacy_sale_keys'='0'
          ELSE m.ordinal=k.first_selected_ordinal AND edge.ordinal=m.ordinal AND metric.ordinal=m.ordinal
            AND semantic.ordinal=m.ordinal AND contribution.ordinal=m.ordinal AND u.ordinal=m.ordinal END,false) AS bindings_match
      FROM bound_context c LEFT JOIN first_source k ON true
      LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_rows m ON m.operation_id=c.operation_id
        AND m.organization_id=c.organization_id AND m.generation_id=c.generation_id AND m.ordinal=k.first_selected_ordinal
      LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge ON edge.operation_id=m.operation_id
        AND edge.organization_id=m.organization_id AND edge.generation_id=m.generation_id AND edge.ordinal=m.ordinal AND edge.account_id=m.account_id
        AND edge.kind=k.kind AND edge.native_key=k.native_key
      LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows semantic ON semantic.operation_id=m.operation_id
        AND semantic.organization_id=m.organization_id AND semantic.account_id=m.account_id AND semantic.ordinal=m.ordinal
        AND semantic.partition_ordinal=m.partition_ordinal AND semantic.entry_reference=m.entry_reference
        AND semantic.metric_row_reference=m.metric_row_reference AND semantic.contribution_row_reference=m.contribution_row_reference
      LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows contribution ON contribution.operation_id=m.operation_id
        AND contribution.organization_id=m.organization_id AND contribution.account_id=m.account_id AND contribution.ordinal=m.ordinal
        AND contribution.partition_ordinal=m.partition_ordinal AND contribution.entry_reference=m.entry_reference
        AND contribution.metric_row_reference=m.metric_row_reference AND contribution.row_reference=m.contribution_row_reference
      LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id
        AND metric.organization_id=m.organization_id AND metric.account_id=m.account_id AND metric.ordinal=m.ordinal
        AND metric.partition_ordinal=m.partition_ordinal AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
      LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id
        AND u.organization_id=metric.organization_id AND u.account_id=metric.account_id AND u.ordinal=metric.ordinal
        AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference`,values)),
      ['transaction_id','head_reference','head_sequence','receipt','expected','kind','native_key','first_selected_ordinal','selected_entry','bindings_match']);
    if(r.transaction_id!==started)fail('caller_transaction_required');
    if(r.bindings_match!==true)fail('native_plan_corrupt');
    const receipt=prepareCohortSelectedTransactionIndexReceiptV2(r.receipt,r.expected),head=reference(r.head_reference,4096);
    if(!receipt.after.done||receipt.sequence!==r.head_sequence||receipt.sequence!==receipt.selected_stock_count+1)fail('native_plan_corrupt');
    let selected=null,source=null;
    if(r.kind===null){
      if(r.native_key!==null||r.first_selected_ordinal!==null||r.selected_entry!==null
        ||receipt.after.source_record_keys!==0||receipt.after.legacy_sale_keys!==0)fail('native_plan_corrupt');
    }else{
      if(!['source_record','legacy_sale'].includes(r.kind)||typeof r.native_key!=='string'||!/^[1-9][0-9]{0,18}$/.test(r.native_key)
        ||BigInt(r.native_key)>9223372036854775807n||receipt.after[r.kind==='source_record'?'source_record_keys':'legacy_sale_keys']===0
        ||r.kind==='legacy_sale'&&receipt.after.source_record_keys!==0)fail('native_plan_corrupt');
      integer(r.first_selected_ordinal,receipt.selected_stock_count);
      const m=data(r.selected_entry,['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference']);
      if(m.ordinal!==r.first_selected_ordinal||typeof m.account_id!=='string'||!m.account_id||m.account_id.length>64
        ||!m.account_id.isWellFormed()||m.account_id.trim()!==m.account_id||/[\u0000-\u001f\u007f]/.test(m.account_id))fail('native_plan_corrupt');
      integer(m.partition_ordinal,2000000);
      selected=Object.freeze({...m,entry_reference:reference(m.entry_reference,1000000),metric_row_reference:reference(m.metric_row_reference,4096),
        contribution_row_reference:reference(m.contribution_row_reference,4096)});
      source=Object.freeze({kind:r.kind,native_key:r.native_key,first_selected_ordinal:r.first_selected_ordinal});
    }
    const plan=Object.freeze({format:'cohort_completed_index_first_source_plan_v3',command_id:receipt.command_id,
      generation_id:receipt.generation_id,index_reference:head,index_sequence:receipt.sequence,selected_stock_count:receipt.selected_stock_count,
      registered_source_keys:receipt.after.source_record_keys,registered_legacy_keys:receipt.after.legacy_sale_keys,
      source,selected_entry:selected,read_only:true,originals_reconciled:false,source_authority:false,economic_transaction:false});
    if(Buffer.byteLength(json(plan))>4096)fail('byte_limit');
    if(observed!==null&&!same(observed,plan))fail('native_plan_changed');
    observed=plan;return plan;
  }});
}
