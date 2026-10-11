import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REFS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference'];
const HEAD=['command_id',...REFS,'receipt_reference','sequence'];
const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference',
  'contribution_row_reference','numeric_index_ordinal','reported_year_built','reported_residential_area','reported_site_area'];
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const PARENTS=`FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs eighth_body ON eighth_body.organization_id=eighth.organization_id
    AND eighth_body.content_sha256=eighth.receipt_reference->>'content_sha256'
    AND eighth_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND eighth_body.canonical_utf8_bytes<=16000`;
const DONE=`eighth.command_id=$9::uuid AND eighth.union_reference=$10::jsonb AND eighth.eligibility_reference=$11::jsonb
  AND eighth.evidence_reference=$12::jsonb AND eighth.metrics_reference=$13::jsonb AND eighth.receipt_reference=$14::jsonb
  AND eighth_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
  AND eighth_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND eighth_body.canonical_utf8::jsonb->'after'->>'done'='true'`;
const fail=r=>{throw new TypeError(`custom_cohort_selected_numeric_v2_${r}`);};
const same=(a,b)=>json(a)===json(b);
function data(v,keys){
  if(!v||isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(v);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(v,max=16000){const r=data(v,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function anchor(v){
  if(v===null)return null;const a=data(v,HEAD);
  if(typeof a.command_id!=='string'||!UUID.test(a.command_id)||!Number.isInteger(a.sequence)||a.sequence<1||a.sequence>2000001)fail('corrupt');
  return Object.freeze({...a,...Object.fromEntries(REFS.map(k=>[k,ref(a[k])])),receipt_reference:ref(a.receipt_reference,4096)});
}
function one(r){if(r?.rowCount!==1||r.rows?.length!==1)fail('claim_lost');return r.rows[0];}

/** INACTIVE reference-only ninth storage, not source/selected-union authority.
 * Called only by the inactive bounded ninth original owner. Its caller must be that actual
 * bounded owner, freshly reconciling COMPLETE originals/ENTIRE caches, EVERY
 * seventh/eighth/index field and current+ending authorization before advance.
 * No caller ordinal, row, count, numerical value, callback or DONE parameter.
 * The native deferred exact15 checkpoint + continuation fence is mandatory. */
export function createCustomCohortSelectedNumericV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id',...REFS]),{client}=o,
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']),
    refs=Object.fromEntries(REFS.map(k=>[k,ref(o[k])]));
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const bound=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,scope.account_id,
    o.actorUserId,o.command_id,...REFS.map(k=>json(refs[k]))];
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-selected-numeric-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  const read=async()=>{
    const r=data(one(await client.query(`/* custom-cohort-selected-numeric-v2:head-read */
      SELECT head.command_id::text,head.union_reference,head.eligibility_reference,head.evidence_reference,head.metrics_reference,
        head.statistics_reference,head.receipt_reference,head.sequence
      ${PARENTS}
      LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads head ON head.operation_id=job.operation_id AND head.organization_id=job.organization_id
      WHERE ${FENCE} AND ${DONE}`,bound)),HEAD);
    if(Object.values(r).every(v=>v===null))return null;const a=anchor(r);
    if(a.command_id!==o.command_id||REFS.some(k=>!same(a[k],refs[k])))fail('binding_changed');return a;
  };
  return Object.freeze({async read(...args){if(args.length)fail('invalid_input');return read();},
    async readNextSelectedEntry(...args){
      if(args.length)fail('invalid_input');
      const r=data(one(await client.query(`/* custom-cohort-selected-numeric-v2:next-selected-entry */
        SELECT m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,entry.state,entry.assigned_group_id,
          m.metric_row_reference AS row_reference,m.row_reference AS contribution_row_reference,
          indexed.ordinal AS numeric_index_ordinal,indexed.reported_year_built::text AS reported_year_built,
          indexed.reported_residential_area::text AS reported_residential_area,indexed.reported_site_area::text AS reported_site_area
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id
          AND m.organization_id=job.organization_id AND m.ordinal=coalesce(h.sequence,0)+1
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id
          AND indexed.organization_id=m.organization_id AND indexed.ordinal=m.ordinal AND indexed.account_id=m.account_id
          AND indexed.contribution_row_reference=m.row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id
          AND metric.organization_id=m.organization_id AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id
          AND metric.partition_ordinal=m.partition_ordinal AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id AND u.organization_id=metric.organization_id
          AND u.ordinal=metric.ordinal AND u.account_id=metric.account_id AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference
        LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id
          AND entry.organization_id=u.organization_id AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference
        WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_numeric_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)`,bound)),MEMBER);
      if(Object.values(r).every(v=>v===null))return null;
      if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()||r.account_id.trim()!==r.account_id
        ||/[\u0000-\u001f\u007f]/.test(r.account_id)||![r.ordinal,r.partition_ordinal].every(n=>Number.isInteger(n)&&n>=1&&n<=2000000)
        ||!['assigned','unassigned'].includes(r.state)||(r.state==='assigned'?typeof r.assigned_group_id!=='string'
          ||!/^recorded-cad:[a-f0-9]{64}$/.test(r.assigned_group_id):r.assigned_group_id!==null))fail('corrupt');
      if(r.numeric_index_ordinal!==r.ordinal)fail('numeric_index_missing_or_corrupt');
      for(const key of ['reported_year_built','reported_residential_area','reported_site_area']){
        const value=r[key];if(value!==null&&(typeof value!=='string'||value.length>31||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value)
          ||value.replace('.','').length>30||(value.split('.')[1]?.length??0)>12))fail('numeric_index_missing_or_corrupt');
      }
      return Object.freeze({...r,entry_reference:ref(r.entry_reference,1000000),row_reference:ref(r.row_reference,4096),
        contribution_row_reference:ref(r.contribution_row_reference,4096)});
    },
    async advance(...args){
      if(args.length!==2)fail('invalid_input');
      const expected=anchor(args[0]),receipt=ref(args[1],4096),sequence=(expected?.sequence??0)+1,started=await tx();
      if(sequence>2000001)fail('corrupt');if(await tx()!==started)fail('caller_transaction_required');
      if(!same(await read(),expected))fail('conflict');
      // Always derive the next actual eighth row; an actual EMPTY inserts zero.
      // The receipt does not choose the member, decide DONE or inject a row.
      const row=await client.query(`/* custom-cohort-selected-numeric-v2:row-insert */
        INSERT INTO app.neighborhood_custom_cohort_selected_numeric_v2_rows(operation_id,organization_id,ordinal,account_id,partition_ordinal,
          entry_reference,metric_row_reference,contribution_row_reference)
        SELECT job.operation_id,job.organization_id,m.ordinal,m.account_id,m.partition_ordinal,m.entry_reference,m.metric_row_reference,m.row_reference
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id AND m.organization_id=job.organization_id
          AND m.ordinal=coalesce(h.sequence,0)+1 AND m.ordinal=$15::integer
        JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id
          AND indexed.organization_id=m.organization_id AND indexed.ordinal=m.ordinal AND indexed.account_id=m.account_id
          AND indexed.contribution_row_reference=m.row_reference
        WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_numeric_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
        RETURNING ordinal`,[...bound,sequence]);
      if(!row||![0,1].includes(row.rowCount)||row.rows?.length!==row.rowCount||row.rowCount===1&&row.rows[0].ordinal!==sequence)fail('corrupt');
      const r=expected===null?await client.query(`/* custom-cohort-selected-numeric-v2:head-insert */
        INSERT INTO app.neighborhood_custom_cohort_selected_numeric_v2_heads(operation_id,organization_id,command_id,union_reference,
          eligibility_reference,evidence_reference,metrics_reference,statistics_reference,receipt_reference,sequence)
        SELECT job.operation_id,job.organization_id,$9::uuid,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,1
        ${PARENTS} WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_numeric_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
        RETURNING sequence`,[...bound,json(receipt)])
        :await client.query(`/* custom-cohort-selected-numeric-v2:head-advance */
          UPDATE app.neighborhood_custom_cohort_selected_numeric_v2_heads head SET receipt_reference=$15::jsonb,sequence=$16::integer
          ${PARENTS} WHERE ${FENCE} AND ${DONE} AND head.operation_id=job.operation_id AND head.organization_id=job.organization_id
            AND head.command_id=$9::uuid AND head.union_reference=$10::jsonb AND head.eligibility_reference=$11::jsonb
            AND head.evidence_reference=$12::jsonb AND head.metrics_reference=$13::jsonb AND head.statistics_reference=$14::jsonb
            AND head.receipt_reference=$17::jsonb AND head.sequence=$18::integer RETURNING head.sequence`,
          [...bound,json(receipt),sequence,json(expected.receipt_reference),expected.sequence]);
      if(one(r).sequence!==sequence)fail('corrupt');const stored=await read();
      if(!same(stored,{command_id:o.command_id,...refs,receipt_reference:receipt,sequence})||await tx()!==started)fail('corrupt');return stored;
    }});
}
