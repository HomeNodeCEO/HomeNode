import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const PARENTS=`FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads seventh USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs seventh_body ON seventh_body.organization_id=seventh.organization_id
    AND seventh_body.content_sha256=seventh.receipt_reference->>'content_sha256'
    AND seventh_body.canonical_utf8_bytes::text=seventh.receipt_reference->>'canonical_utf8_bytes' AND seventh_body.canonical_utf8_bytes<=16000`;
const DONE=`seventh.command_id=$9::uuid AND seventh.union_reference=$10::jsonb
  AND seventh.eligibility_reference=$11::jsonb AND seventh.evidence_reference=$12::jsonb AND seventh.receipt_reference=$13::jsonb
  AND seventh_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
  AND seventh_body.canonical_utf8::jsonb->>'sequence'=seventh.sequence::text AND seventh_body.canonical_utf8::jsonb->'after'->>'done'='true'`;
const fail=r=>{throw new TypeError(`custom_cohort_selected_statistics_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(ds);
  if(names.length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function anchor(v){if(v===null)return null;const a=data(v,['command_id','union_reference','eligibility_reference','evidence_reference','metrics_reference','receipt_reference','sequence']);
  if(typeof a.command_id!=='string'||!UUID.test(a.command_id)||!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...a,union_reference:ref(a.union_reference),eligibility_reference:ref(a.eligibility_reference),evidence_reference:ref(a.evidence_reference),metrics_reference:ref(a.metrics_reference),receipt_reference:ref(a.receipt_reference)});}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}

/** INACTIVE native contribution storage, NOT source/selection/statistics authority.
 * Only the actual bounded original owner may derive contributions. No caller
 * ordinal, source callback, population array, counts or DONE adapter. Native
 * exact14/deferred guards require the atomic job/continuation transition. */
export function createCustomCohortSelectedStatisticsV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id','union_reference','eligibility_reference','evidence_reference','metrics_reference']),{client}=o,
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']),
    union=ref(o.union_reference),eligibility=ref(o.eligibility_reference),evidence=ref(o.evidence_reference),metrics=ref(o.metrics_reference);
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,o.actorUserId],
    bound=[...values,o.command_id,json(union),json(eligibility),json(evidence),json(metrics)],
    headKeys=['command_id','union_reference','eligibility_reference','evidence_reference','metrics_reference','receipt_reference','sequence'];
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-selected-statistics-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const read=async()=>{
    const r=data(one(await client.query(`/* custom-cohort-selected-statistics-v2:head-read */
      SELECT head.command_id::text,head.union_reference,head.eligibility_reference,head.evidence_reference,head.metrics_reference,head.receipt_reference,head.sequence
      ${PARENTS}
      LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads head ON head.operation_id=job.operation_id AND head.organization_id=job.organization_id
      WHERE ${FENCE} AND ${DONE}`,bound)),headKeys);
    if(Object.values(r).every(v=>v===null))return null;const a=anchor(r);
    if(a.command_id!==o.command_id||!same(a.union_reference,union)||!same(a.eligibility_reference,eligibility)||!same(a.evidence_reference,evidence)
      ||!same(a.metrics_reference,metrics))fail('binding_changed');return a;
  };
  return Object.freeze({async read(...args){if(args.length)fail('invalid_input');return read();},
    async readNextSelectedEntry(...args){
      if(args.length)fail('invalid_input');
      const r=data(one(await client.query(`/* custom-cohort-selected-statistics-v2:next-selected-entry */
        SELECT m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,entry.state,entry.assigned_group_id,m.row_reference
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows m ON m.operation_id=job.operation_id
          AND m.organization_id=job.organization_id AND m.ordinal=coalesce(h.sequence,0)+1
        LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=m.operation_id AND u.organization_id=m.organization_id
          AND u.ordinal=m.ordinal AND u.account_id=m.account_id AND u.partition_ordinal=m.partition_ordinal AND u.entry_reference=m.entry_reference
        LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id
          AND entry.organization_id=u.organization_id AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference
        WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_statistics_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)`,bound)),
        ['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference']);
      if(Object.values(r).every(v=>v===null))return null;
      if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()||r.account_id.trim()!==r.account_id
        ||/[\u0000-\u001f\u007f]/.test(r.account_id)||![r.ordinal,r.partition_ordinal].every(n=>Number.isInteger(n)&&n>=1&&n<=2000000)
        ||!['assigned','unassigned'].includes(r.state)||(r.state==='assigned'?typeof r.assigned_group_id!=='string'
          ||!/^recorded-cad:[a-f0-9]{64}$/.test(r.assigned_group_id):r.assigned_group_id!==null))fail('corrupt');
      return Object.freeze({...r,entry_reference:ref(r.entry_reference,1000000),row_reference:ref(r.row_reference,4096)});
    },
    /** Fixed first ordinal AFTER actual DONE eighth. The returned references
     * are structural only. The original owner MUST derive a fresh contribution
     * from complete originals and compare EVERY retained field before return.
     * Never silently substitute seventh rows for a missing eighth member. */
    async readFirstFrequencyEntry(...args){
      if(args.length)fail('invalid_input');
      const r=data(one(await client.query(`/* custom-cohort-selected-statistics-v2:first-frequency-entry */
        SELECT m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,entry.state,entry.assigned_group_id,
          m.metric_row_reference AS row_reference,m.row_reference AS contribution_row_reference
        ${PARENTS}
        JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id
          AND b.content_sha256=h.receipt_reference->>'content_sha256'
          AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
        LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=h.operation_id
          AND m.organization_id=h.organization_id AND m.ordinal=1
        LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id
          AND metric.organization_id=m.organization_id AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id
          AND metric.partition_ordinal=m.partition_ordinal AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id AND u.organization_id=metric.organization_id
          AND u.ordinal=metric.ordinal AND u.account_id=metric.account_id AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference
        LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id
          AND entry.organization_id=u.organization_id AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference
        WHERE ${FENCE} AND ${DONE} AND h.command_id=seventh.command_id AND h.union_reference=seventh.union_reference
          AND h.eligibility_reference=seventh.eligibility_reference AND h.evidence_reference=seventh.evidence_reference
          AND h.metrics_reference=seventh.receipt_reference
          AND b.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
          AND b.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'
          AND app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)`,bound)),
        ['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference','contribution_row_reference']);
      if(Object.values(r).every(v=>v===null))return null;
      if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()||r.account_id.trim()!==r.account_id
        ||/[\u0000-\u001f\u007f]/.test(r.account_id)||r.ordinal!==1||!Number.isInteger(r.partition_ordinal)||r.partition_ordinal<1||r.partition_ordinal>2000000
        ||!['assigned','unassigned'].includes(r.state)||(r.state==='assigned'?typeof r.assigned_group_id!=='string'
          ||!/^recorded-cad:[a-f0-9]{64}$/.test(r.assigned_group_id):r.assigned_group_id!==null))fail('corrupt');
      return Object.freeze({...r,entry_reference:ref(r.entry_reference,1000000),row_reference:ref(r.row_reference,4096),
        contribution_row_reference:ref(r.contribution_row_reference,4096)});
    },async advance(...args){
      if(args.length!==3)fail('invalid_input');
      const expected=anchor(args[0]),receipt=ref(args[1]),rowRef=args[2]===null?null:ref(args[2],4096),
        sequence=(expected?.sequence??0)+1,started=await tx();
      if(sequence>2000001)fail('corrupt');if(await tx()!==started)fail('caller_transaction_required');
      if(!same(await read(),expected))fail('conflict');
      if(rowRef!==null){
        const inserted=one(await client.query(`/* custom-cohort-selected-statistics-v2:row-insert */
          INSERT INTO app.neighborhood_custom_cohort_selected_statistics_v2_rows(operation_id,organization_id,ordinal,account_id,partition_ordinal,entry_reference,metric_row_reference,row_reference)
          SELECT job.operation_id,job.organization_id,m.ordinal,m.account_id,m.partition_ordinal,m.entry_reference,m.row_reference,$14::jsonb
          ${PARENTS}
          LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
          JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows m ON m.operation_id=job.operation_id AND m.organization_id=job.organization_id
            AND m.ordinal=coalesce(h.sequence,0)+1 AND m.ordinal=$15::integer
          WHERE ${FENCE} AND ${DONE}
            AND app.neighborhood_selected_statistics_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
          RETURNING ordinal,row_reference`,[...bound,json(rowRef),sequence]));
        if(inserted.ordinal!==sequence||!same(inserted.row_reference,rowRef))fail('corrupt');
      }
      const r=expected===null?await client.query(`/* custom-cohort-selected-statistics-v2:head-insert */
        INSERT INTO app.neighborhood_custom_cohort_selected_statistics_v2_heads(operation_id,organization_id,command_id,union_reference,eligibility_reference,evidence_reference,metrics_reference,receipt_reference,sequence)
        SELECT job.operation_id,job.organization_id,$9::uuid,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,1
        ${PARENTS} WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_statistics_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
        RETURNING sequence`,[...bound,json(receipt)])
        :await client.query(`/* custom-cohort-selected-statistics-v2:head-advance */
          UPDATE app.neighborhood_custom_cohort_selected_statistics_v2_heads head SET receipt_reference=$9::jsonb,sequence=$10::integer
          FROM app.neighborhood_custom_cohort_capture_jobs job WHERE ${FENCE} AND head.operation_id=job.operation_id
            AND head.organization_id=job.organization_id AND head.command_id=$11::uuid AND head.union_reference=$12::jsonb
            AND head.eligibility_reference=$13::jsonb AND head.evidence_reference=$14::jsonb AND head.metrics_reference=$15::jsonb
            AND head.receipt_reference=$16::jsonb AND head.sequence=$17::integer RETURNING head.sequence`,
          [...values,json(receipt),sequence,o.command_id,json(union),json(eligibility),json(evidence),json(metrics),json(expected.receipt_reference),expected.sequence]);
      if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
      if(!same(stored,{command_id:o.command_id,union_reference:union,eligibility_reference:eligibility,evidence_reference:evidence,
        metrics_reference:metrics,receipt_reference:receipt,sequence})||await tx()!==started)fail('corrupt');return stored;
    }});
}
