import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { SELECTED_TRANSACTION_INDEX_V2_PARENT_KEYS as REFS } from './cohortSelectedTransactionIndexFirstCandidateV2.js';
import { prepareCohortSelectedTransactionIndexPlanV2 } from './cohortSelectedTransactionIndexReceiptV2.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','metric_row_reference','contribution_row_reference'];
const ORIGINAL_MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference',
  'contribution_row_reference','numeric_index_ordinal','reported_year_built','reported_residential_area','reported_site_area',
  'numeric_population_ordinal','semantic_population_ordinal'];
const ROW=['transaction_id','generation_id',...MEMBER,'anchor_count','kind','native_key','first_selected_ordinal','registry_matches',
  'selected_stock_count','before','head_receipt_reference','head_sequence','original_member'];
const fail=r=>{throw new TypeError(`custom_cohort_selected_transaction_index_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const d=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(d).length!==keys.length||!keys.every(k=>d[k]?.enumerable&&Object.hasOwn(d[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function ref(v,max=4096){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function one(result){if(result?.rowCount!==1||result.rows?.length!==1)fail('claim_lost');return result.rows[0];}
function txid(v){if(typeof v!=='string'||!/^[1-9][0-9]{0,19}$/.test(v))fail('caller_transaction_required');return v;}
function originalMember(value,selected){
  if(selected===null){if(value!==null)fail('native_member_missing_or_corrupt');return null;}
  const raw=data(value,ORIGINAL_MEMBER),m={...raw,entry_reference:ref(raw.entry_reference,1000000),
    row_reference:ref(raw.row_reference),contribution_row_reference:ref(raw.contribution_row_reference)};
  if(!same(Object.fromEntries(MEMBER.map(k=>[k,k==='metric_row_reference'?m.row_reference:m[k]])),selected)
    ||!['assigned','unassigned'].includes(m.state)||(m.state==='assigned'?typeof m.assigned_group_id!=='string'
      ||!/^recorded-cad:[a-f0-9]{64}$/.test(m.assigned_group_id):m.assigned_group_id!==null)
    ||['numeric_index_ordinal','numeric_population_ordinal','semantic_population_ordinal'].some(k=>m[k]!==selected.ordinal))
    fail('native_member_missing_or_corrupt');
  for(const key of ['reported_year_built','reported_residential_area','reported_site_area']){
    const v=m[key];if(v!==null&&(typeof v!=='string'||v.length>31||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(v)
      ||v.replace('.','').length>30||(v.split('.')[1]?.length??0)>12))fail('native_member_missing_or_corrupt');
  }
  const {semantic_population_ordinal,...entry}=m;
  return Object.freeze(entry);
}

// This is the actual current native binding, not a caller-created checkpoint
// projection. The exact16/17 admission is added only to NEXT and pre-head DML;
// post-head readback must run before the owner's atomic checkpoint and yield.
const BOUND=`WITH bound_context AS MATERIALIZED (
 SELECT job.operation_id,job.organization_id,job.checkpoint,s.command_id,s.union_reference,s.eligibility_reference,
  s.evidence_reference,s.metrics_reference,s.statistics_reference,s.numeric_reference,s.receipt_reference AS semantic_reference,
  (ub.canonical_utf8::jsonb->>'after_selected_count')::integer AS selected_stock_count
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
 JOIN app.neighborhood_cohort_evidence_blobs sb ON sb.organization_id=s.organization_id
  AND sb.content_sha256=s.receipt_reference->>'content_sha256'
  AND sb.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND sb.canonical_utf8_bytes<=4096
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
  AND u.command_id=s.command_id AND u.receipt_reference=s.union_reference
  AND sb.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
  AND sb.canonical_utf8::jsonb->>'sequence'=s.sequence::text AND sb.canonical_utf8::jsonb->'after'->>'done'='true'
  AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
  AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
  AND sb.canonical_utf8::jsonb->'after'->'selected_ordinal'=ub.canonical_utf8::jsonb->'after_selected_count'
 FOR UPDATE OF job NOWAIT
)`;
const NEXT='app.neighborhood_selected_transaction_index_v2_next_keys(c.operation_id,c.organization_id)';
const ADMISSION='app.neighborhood_selected_transaction_index_v2_admission_matches(c.operation_id,c.organization_id,c.checkpoint)';

/** UNREGISTERED owner WIP. Only readNext is connected to the inactive context
 * original-reader seam; advance is NOT called by any owner/route/worker yet.
 * Storage only: the complete-original owner must replay EVERY prior field and
 * current account's COMPLETE packages, ENTIRE caches/required subject and ALL
 * current/ending rights/actor/workspace/claim fences before calling advance.
 * No caller plan, ordinal, generation, keys, counts, callback or DONE. Native
 * guards independently reconstruct the full compact receipt and exact edges.
 * Its deferred same-TX exact17 checkpoint + single-use yield remain mandatory;
 * the installed unconditional refusal is NOT removed by this module. */
export function createCustomCohortSelectedTransactionIndexV2Repository(...args){
  if(args.length!==1)fail('invalid_input');
  const o=data(args[0],['client','claim','scope','actorUserId','command_id',...REFS]),
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']);
  if(typeof o.client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)||BigInt(scope.assignment_file_id)>9223372036854775807n
    ||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64||!scope.account_id.isWellFormed()
    ||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const roots=REFS.map(k=>json(ref(o[k],['numeric_reference','semantic_reference'].includes(k)?4096:16000))),
    bound=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,
      scope.account_id,o.actorUserId,o.command_id,...roots];
  let transaction=null,observed=null,advanced=false;
  const read=async()=>{
    if(advanced)fail('already_advanced');
    if(transaction===null){
      transaction=txid(data(one(await o.client.query('/* custom-cohort-selected-transaction-index-v2:transaction */ SELECT txid_current()::text AS transaction_id')),
        ['transaction_id']).transaction_id);
    }
    const result=await o.client.query(`/* custom-cohort-selected-transaction-index-v2:native-plan */
     ${BOUND}
     SELECT txid_current()::text AS transaction_id,k.*,
      CASE k.kind WHEN 'source_record' THEN sr.first_selected_ordinal WHEN 'legacy_sale' THEN ls.first_selected_ordinal END AS first_selected_ordinal,
      CASE k.kind WHEN 'source_record' THEN sr.operation_id IS NULL OR (sr.organization_id=c.organization_id AND sr.generation_id=k.generation_id)
       WHEN 'legacy_sale' THEN ls.operation_id IS NULL OR (ls.organization_id=c.organization_id AND ls.generation_id=k.generation_id)
       ELSE true END AS registry_matches,c.selected_stock_count,
      CASE WHEN h.operation_id IS NULL THEN jsonb_build_object('selected_ordinal',0,'source_record_keys',0,'legacy_sale_keys',0,'done',false)
       ELSE hb.canonical_utf8::jsonb->'after' END AS before,h.receipt_reference AS head_receipt_reference,h.sequence AS head_sequence,
      CASE WHEN k.account_id IS NULL THEN NULL ELSE jsonb_build_object(
       'account_id',m.account_id,'ordinal',m.ordinal,'partition_ordinal',m.partition_ordinal,'entry_reference',m.entry_reference,
       'state',entry.state,'assigned_group_id',entry.assigned_group_id,'row_reference',m.metric_row_reference,
       'contribution_row_reference',m.row_reference,'numeric_index_ordinal',indexed.ordinal,
       'reported_year_built',indexed.reported_year_built::text,'reported_residential_area',indexed.reported_residential_area::text,
       'reported_site_area',indexed.reported_site_area::text,'numeric_population_ordinal',n.ordinal,'semantic_population_ordinal',semantic.ordinal)
       END AS original_member
     FROM bound_context c CROSS JOIN LATERAL ${NEXT} k
     LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=c.operation_id AND m.organization_id=c.organization_id
      AND m.ordinal=k.ordinal AND m.account_id=k.account_id AND m.partition_ordinal=k.partition_ordinal
      AND m.entry_reference=k.entry_reference AND m.metric_row_reference=k.metric_row_reference AND m.row_reference=k.contribution_row_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
      AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
      AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id
      AND indexed.organization_id=m.organization_id AND indexed.ordinal=m.ordinal AND indexed.account_id=m.account_id
      AND indexed.contribution_row_reference=m.row_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows semantic ON semantic.operation_id=m.operation_id
      AND semantic.organization_id=m.organization_id AND semantic.ordinal=m.ordinal AND semantic.account_id=m.account_id
      AND semantic.partition_ordinal=m.partition_ordinal AND semantic.entry_reference=m.entry_reference
      AND semantic.metric_row_reference=m.metric_row_reference AND semantic.contribution_row_reference=m.row_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id AND metric.organization_id=m.organization_id
      AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id AND metric.partition_ordinal=m.partition_ordinal
      AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id AND u.organization_id=metric.organization_id
      AND u.ordinal=metric.ordinal AND u.account_id=metric.account_id AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference
     LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id AND entry.organization_id=u.organization_id
      AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference
     LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h ON h.operation_id=c.operation_id
     LEFT JOIN app.neighborhood_cohort_evidence_blobs hb ON hb.organization_id=h.organization_id
      AND hb.content_sha256=h.receipt_reference->>'content_sha256'
      AND hb.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND hb.canonical_utf8_bytes<=4096
     LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_source_v2_keys sr
      ON sr.operation_id=c.operation_id AND k.kind='source_record' AND sr.source_record_id=k.native_key::bigint
     LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys ls
      ON ls.operation_id=c.operation_id AND k.kind='legacy_sale' AND ls.legacy_sale_key=k.native_key
     WHERE ${ADMISSION}
     ORDER BY CASE k.kind WHEN 'source_record' THEN 0 ELSE 1 END,
      CASE WHEN k.kind='source_record' THEN k.native_key::bigint END,
      CASE WHEN k.kind='legacy_sale' THEN k.native_key END COLLATE "C" LIMIT 251`,bound);
    if(!result||!Number.isInteger(result.rowCount)||result.rowCount<1||result.rowCount>250||!Array.isArray(result.rows)
      ||isProxy(result.rows)||Object.getPrototypeOf(result.rows)!==Array.prototype||result.rows.length!==result.rowCount
      ||Reflect.ownKeys(result.rows).length!==result.rows.length+1)fail('native_plan_missing_or_corrupt');
    let packet=null;const packages=[];
    for(let i=0;i<result.rows.length;i++){
      const d=Object.getOwnPropertyDescriptor(result.rows,String(i));if(!d||!d.enumerable||!Object.hasOwn(d,'value'))fail('native_plan_missing_or_corrupt');
      const r=data(d.value,ROW);if(r.transaction_id!==transaction)fail('caller_transaction_required');
      if(r.registry_matches!==true)fail('registry_binding_changed');
      const empty=MEMBER.every(k=>r[k]===null),p={generation_id:r.generation_id,selected_stock_count:r.selected_stock_count,before:r.before,
        selected_entry:empty?null:Object.fromEntries(MEMBER.map(k=>[k,r[k]])),anchor_count:r.anchor_count},
        noPackage=r.kind===null&&r.native_key===null&&r.first_selected_ordinal===null,
        nativePackage={kind:r.kind,native_key:r.native_key,first_selected_ordinal:r.first_selected_ordinal};
      let header,previous;
      try{const {native_packages,...validated}=prepareCohortSelectedTransactionIndexPlanV2({...p,native_packages:noPackage?[]:[nativePackage]});header=validated;
        previous=r.head_receipt_reference===null?null:ref(r.head_receipt_reference);
      }catch{fail('native_plan_missing_or_corrupt');}
      if((r.head_sequence===null)!==(previous===null)||previous===null&&header.before.selected_ordinal!==0
        ||previous!==null&&r.head_sequence!==header.before.selected_ordinal)fail('native_plan_missing_or_corrupt');
      const selected_entry=originalMember(r.original_member,header.selected_entry),next={header,previous,selected_entry};
      if(packet===null)packet=next;else if(!same(packet,next))fail('native_plan_missing_or_corrupt');
      if(noPackage){if(result.rowCount!==1||header.anchor_count!==0)fail('native_plan_missing_or_corrupt');}
      else packages.push(nativePackage);
    }
    try{return Object.freeze({plan:prepareCohortSelectedTransactionIndexPlanV2({...packet.header,native_packages:packages}),
      previous:packet.previous,selected_entry:packet.selected_entry});}
    catch{fail('native_plan_missing_or_corrupt');}
  };
  const changed=(r,count)=>{if(!r||r.rowCount!==count||!Array.isArray(r.rows)||r.rows.length!==0)fail('native_delta_conflict');};
  return Object.freeze({async readNext(...a){if(a.length)fail('invalid_input');const r=await read();observed=r;return r;},
    async advance(...a){
      if(a.length!==1)fail('invalid_input');const receipt=ref(a[0]);if(observed===null)fail('native_plan_required');
      const fresh=await read();if(!same(fresh,observed))fail('native_plan_changed');
      const p=fresh.plan,sequence=p.before.selected_ordinal+1,sources=p.native_packages.filter(k=>k.kind==='source_record'),
        legacies=p.native_packages.filter(k=>k.kind==='legacy_sale');
      // Every identity below comes from NEXT inside SQL. RETURNING/count checks
      // are only bounded DML consistency; exact bidirectional native guards are
      // the identity/completeness fence, never ON CONFLICT or counts alone.
      changed(await o.client.query(`/* custom-cohort-selected-transaction-index-v2:member-insert */
       ${BOUND} INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_rows
        (operation_id,organization_id,generation_id,account_id,ordinal,partition_ordinal,entry_reference,metric_row_reference,contribution_row_reference)
       SELECT DISTINCT c.operation_id,c.organization_id,k.generation_id,k.account_id,k.ordinal,k.partition_ordinal,k.entry_reference,k.metric_row_reference,k.contribution_row_reference
       FROM bound_context c CROSS JOIN LATERAL ${NEXT} k WHERE ${ADMISSION} AND k.account_id IS NOT NULL`,bound),p.selected_entry===null?0:1);
      for(const [kind,table,column,keys] of [['source_record','source_v2_keys','source_record_id',sources],['legacy_sale','legacy_v2_keys','legacy_sale_key',legacies]]){
        changed(await o.client.query(`/* custom-cohort-selected-transaction-index-v2:${kind}-insert */
         ${BOUND} INSERT INTO app.neighborhood_custom_cohort_selected_transaction_${table}
          (operation_id,organization_id,generation_id,${column},first_selected_ordinal)
         SELECT c.operation_id,c.organization_id,k.generation_id,${kind==='source_record'?'k.native_key::bigint':'k.native_key'},k.ordinal
         FROM bound_context c CROSS JOIN LATERAL ${NEXT} k WHERE ${ADMISSION} AND k.kind='${kind}'
         ON CONFLICT(operation_id,${column}) DO NOTHING`,bound),keys.filter(k=>k.first_selected_ordinal===null).length);
      }
      changed(await o.client.query(`/* custom-cohort-selected-transaction-index-v2:edge-insert */
       ${BOUND} INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_edges
        (operation_id,organization_id,generation_id,ordinal,account_id,kind,source_record_id,legacy_sale_key)
       SELECT c.operation_id,c.organization_id,k.generation_id,k.ordinal,k.account_id,k.kind,
        CASE WHEN k.kind='source_record' THEN k.native_key::bigint END,CASE WHEN k.kind='legacy_sale' THEN k.native_key END
       FROM bound_context c CROSS JOIN LATERAL ${NEXT} k WHERE ${ADMISSION} AND k.kind IS NOT NULL`,bound),p.native_packages.length);
      const params=[...bound,json(receipt)],r=fresh.previous===null
        ?await o.client.query(`/* custom-cohort-selected-transaction-index-v2:head-insert */
          ${BOUND} INSERT INTO app.neighborhood_custom_cohort_selected_transaction_index_v2_heads
           (operation_id,organization_id,generation_id,command_id,${REFS.join(',')},receipt_reference,sequence,issued_transaction_id)
          SELECT DISTINCT c.operation_id,c.organization_id,k.generation_id,c.command_id,${REFS.map(k=>`c.${k}`).join(',')},$17::jsonb,1,txid_current()
          FROM bound_context c CROSS JOIN LATERAL ${NEXT} k WHERE ${ADMISSION} RETURNING sequence`,params)
        :await o.client.query(`/* custom-cohort-selected-transaction-index-v2:head-advance */
          ${BOUND} UPDATE app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
          SET receipt_reference=$17::jsonb,sequence=h.sequence+1,issued_transaction_id=txid_current()
          FROM bound_context c WHERE h.operation_id=c.operation_id AND h.organization_id=c.organization_id
           AND h.receipt_reference=$18::jsonb AND h.sequence=$19::integer AND ${ADMISSION} RETURNING h.sequence`,
          [...params,json(fresh.previous),p.before.selected_ordinal]);
      if(data(one(r),['sequence']).sequence!==sequence)fail('native_delta_conflict');
      const stored=data(one(await o.client.query(`/* custom-cohort-selected-transaction-index-v2:head-readback */
       ${BOUND} SELECT txid_current()::text AS transaction_id,h.receipt_reference,h.sequence,h.generation_id::text,
        coalesce(h.command_id=c.command_id AND ${REFS.map(k=>`h.${k}=c.${k}`).join(' AND ')}
         AND h.issued_transaction_id=txid_current(),false) AS binding_matches
       FROM bound_context c JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
        ON h.operation_id=c.operation_id AND h.organization_id=c.organization_id`,bound)),
        ['transaction_id','receipt_reference','sequence','generation_id','binding_matches']);
      if(stored.transaction_id!==transaction)fail('caller_transaction_required');
      if(stored.binding_matches!==true||stored.sequence!==sequence||stored.generation_id!==p.generation_id||!same(ref(stored.receipt_reference),receipt))fail('native_delta_conflict');
      advanced=true;return Object.freeze({receipt_reference:receipt,sequence,generation_id:p.generation_id});
    }});
}
