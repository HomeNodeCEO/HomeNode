import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REFS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'];
const HEAD=['command_id',...REFS,'receipt_reference','sequence'];
const MEMBER=['account_id','ordinal','partition_ordinal','entry_reference','state','assigned_group_id','row_reference',
  'contribution_row_reference','numeric_index_ordinal','reported_year_built','reported_residential_area','reported_site_area','numeric_population_ordinal'];
const FENCE=`job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
  AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
  AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
  AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL`;
const PARENTS=`FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs eighth_body ON eighth_body.organization_id=eighth.organization_id
    AND eighth_body.content_sha256=eighth.receipt_reference->>'content_sha256'
    AND eighth_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND eighth_body.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads numeric_parent ON numeric_parent.operation_id=job.operation_id AND numeric_parent.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs numeric_body ON numeric_body.organization_id=numeric_parent.organization_id
    AND numeric_body.content_sha256=numeric_parent.receipt_reference->>'content_sha256'
    AND numeric_body.canonical_utf8_bytes::text=numeric_parent.receipt_reference->>'canonical_utf8_bytes' AND numeric_body.canonical_utf8_bytes<=4096`;
const DONE=`eighth.command_id=$9::uuid AND eighth.union_reference=$10::jsonb AND eighth.eligibility_reference=$11::jsonb
  AND eighth.evidence_reference=$12::jsonb AND eighth.metrics_reference=$13::jsonb AND eighth.receipt_reference=$14::jsonb
  AND eighth_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
  AND eighth_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND eighth_body.canonical_utf8::jsonb->'after'->>'done'='true'
  AND numeric_parent.command_id=$9::uuid AND numeric_parent.union_reference=$10::jsonb AND numeric_parent.eligibility_reference=$11::jsonb
  AND numeric_parent.evidence_reference=$12::jsonb AND numeric_parent.metrics_reference=$13::jsonb
  AND numeric_parent.statistics_reference=$14::jsonb AND numeric_parent.receipt_reference=$15::jsonb
  AND numeric_body.canonical_utf8::jsonb->>'format'='cohort_selected_numeric_receipt_v2'
  AND numeric_body.canonical_utf8::jsonb->>'sequence'=numeric_parent.sequence::text AND numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'`;
const fail=r=>{throw new TypeError(`custom_cohort_selected_semantic_v2_${r}`);};
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
function member(r){
  if(Object.values(r).every(v=>v===null))return null;
  if(typeof r.account_id!=='string'||!r.account_id||r.account_id.length>64||!r.account_id.isWellFormed()||r.account_id.trim()!==r.account_id
    ||/[\u0000-\u001f\u007f]/.test(r.account_id)||![r.ordinal,r.partition_ordinal].every(n=>Number.isInteger(n)&&n>=1&&n<=2000000)
    ||!['assigned','unassigned'].includes(r.state)||(r.state==='assigned'?typeof r.assigned_group_id!=='string'
      ||!/^recorded-cad:[a-f0-9]{64}$/.test(r.assigned_group_id):r.assigned_group_id!==null))fail('corrupt');
  if(r.numeric_population_ordinal!==r.ordinal)fail('numeric_population_missing_or_corrupt');
  if(r.numeric_index_ordinal!==r.ordinal)fail('numeric_index_missing_or_corrupt');
  for(const key of ['reported_year_built','reported_residential_area','reported_site_area']){
    const value=r[key];if(value!==null&&(typeof value!=='string'||value.length>31||!/^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value)
      ||value.replace('.','').length>30||(value.split('.')[1]?.length??0)>12))fail('numeric_index_missing_or_corrupt');
  }
  return Object.freeze({...r,entry_reference:ref(r.entry_reference,1000000),row_reference:ref(r.row_reference,4096),
    contribution_row_reference:ref(r.contribution_row_reference,4096)});
}

const NATIVE_KEY_ROW=['generation_id','account_id','ordinal','anchor_count','kind','native_key'];
function nativeKeys(result){
  // The SQL itself returns at most251 reference rows, never original payloads
  // or a selected-population roster. Reject overflow before mapping any row.
  if(!result||!Number.isInteger(result.rowCount)||result.rowCount<1||result.rowCount>250
    ||!Array.isArray(result.rows)||isProxy(result.rows)||result.rows.length!==result.rowCount)fail('native_keys_corrupt');
  let header=null,previous=null;const packages=[];
  for(let index=0;index<result.rows.length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(result.rows,String(index));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('native_keys_corrupt');
    const r=data(descriptor.value,NATIVE_KEY_ROW),h={generation_id:r.generation_id,account_id:r.account_id,
      ordinal:r.ordinal,anchor_count:r.anchor_count};
    if(typeof h.generation_id!=='string'||!UUID.test(h.generation_id)||!Number.isInteger(h.anchor_count)
      ||h.anchor_count<0||h.anchor_count>250||h.ordinal!==null&&h.ordinal!==1
      ||(h.account_id===null)!==(h.ordinal===null)||h.account_id!==null&&(typeof h.account_id!=='string'
        ||!h.account_id||h.account_id.length>64||!h.account_id.isWellFormed()||h.account_id.trim()!==h.account_id
        ||/[\u0000-\u001f\u007f]/.test(h.account_id)))fail('native_keys_corrupt');
    if(header===null)header=h;else if(!same(header,h))fail('native_keys_corrupt');
    if(r.kind===null||r.native_key===null){
      if(r.kind!==null||r.native_key!==null||result.rowCount!==1||h.anchor_count!==0)fail('native_keys_corrupt');
      continue;
    }
    if(h.account_id===null||!['source_record','legacy_sale'].includes(r.kind)||typeof r.native_key!=='string'
      ||!/^[1-9][0-9]{0,18}$/.test(r.native_key)||BigInt(r.native_key)>9223372036854775807n)fail('native_keys_corrupt');
    const p={kind:r.kind,native_key:r.native_key};
    if(previous&&(previous.kind==='legacy_sale'&&p.kind==='source_record'||previous.kind===p.kind
      &&(p.kind==='source_record'?BigInt(previous.native_key)>=BigInt(p.native_key):Buffer.compare(
        Buffer.from(previous.native_key),Buffer.from(p.native_key))>=0)))fail('native_keys_corrupt');
    packages.push(Object.freeze(p));previous=p;
  }
  if(packages.length>header.anchor_count||header.account_id===null&&(header.anchor_count!==0||packages.length))fail('native_keys_corrupt');
  return Object.freeze({...header,native_packages:Object.freeze(packages)});
}

/** INACTIVE tenth reference-only durable storage; no independent source authority.
 * Called only by the inactive bounded tenth original owner. Its caller must be that actual
 * bounded owner, freshly reconciling COMPLETE originals/ENTIRE caches, EVERY
 * seventh/eighth/index field and current+ending authorization before advance.
 * No caller ordinal, row, count, numerical value, callback or DONE parameter.
 * The native deferred exact16 checkpoint + continuation fence is mandatory. */
export function createCustomCohortSelectedSemanticV2Repository(raw){
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
  const tx=async()=>{const id=one(await client.query('/* custom-cohort-selected-semantic-v2:transaction */ SELECT txid_current()::text AS transaction_id')).transaction_id;
    if(typeof id!=='string'||!/^[1-9][0-9]{0,19}$/.test(id))fail('caller_transaction_required');return id;};
  // Internal-only transaction binding. The id is obtained from PostgreSQL,
  // never interpolated or caller-supplied. Coalesce the two existing head reads
  // with the pre-DML and post-DML transaction checks instead of extra trips.
  const read=async(expectedTransaction=null,mismatch='caller_transaction_required')=>{
    const withTransaction=expectedTransaction!==null,
      result=data(one(await client.query(`/* custom-cohort-selected-semantic-v2:head-read */
      SELECT ${withTransaction?'txid_current()::text AS transaction_id,':''}head.command_id::text,head.union_reference,head.eligibility_reference,head.evidence_reference,head.metrics_reference,
        head.statistics_reference,head.numeric_reference,head.receipt_reference,head.sequence
      ${PARENTS}
      LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads head ON head.operation_id=job.operation_id AND head.organization_id=job.organization_id
      WHERE ${FENCE} AND ${DONE}`,bound)),withTransaction?['transaction_id',...HEAD]:HEAD);
    if(withTransaction&&(typeof result.transaction_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(result.transaction_id)
      ||result.transaction_id!==expectedTransaction))fail(mismatch);
    const r=withTransaction?Object.fromEntries(HEAD.map(k=>[k,result[k]])):result;
    if(Object.values(r).every(v=>v===null))return null;const a=anchor(r);
    if(a.command_id!==o.command_id||REFS.some(k=>!same(a[k],refs[k])))fail('binding_changed');return a;
  };
  return Object.freeze({async read(...args){if(args.length)fail('invalid_input');return read();},
    async readNextSelectedEntry(...args){
      if(args.length)fail('invalid_input');
      const r=data(one(await client.query(`/* custom-cohort-selected-semantic-v2:next-selected-entry */
        SELECT m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,entry.state,entry.assigned_group_id,
          m.metric_row_reference AS row_reference,m.row_reference AS contribution_row_reference,
          indexed.ordinal AS numeric_index_ordinal,indexed.reported_year_built::text AS reported_year_built,
          indexed.reported_residential_area::text AS reported_residential_area,indexed.reported_site_area::text AS reported_site_area,
          n.ordinal AS numeric_population_ordinal
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id
          AND m.organization_id=job.organization_id AND m.ordinal=coalesce(h.sequence,0)+1
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
          AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
          AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
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
          AND app.neighborhood_selected_semantic_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)`,bound)),MEMBER);
      return member(r);
    },
    // Separate fixed FIRST reopening after actual tenth DONE. Old next reader
    // remains strict and unchanged; no caller ordinal or widened head grammar.
    async readFirstCompletedSelectedEntry(...args){
      if(args.length)fail('invalid_input');
      const r=data(one(await client.query(`/* custom-cohort-selected-semantic-v2:first-completed-selected-entry */
        SELECT m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,entry.state,entry.assigned_group_id,
          m.metric_row_reference AS row_reference,m.row_reference AS contribution_row_reference,
          indexed.ordinal AS numeric_index_ordinal,indexed.reported_year_built::text AS reported_year_built,
          indexed.reported_residential_area::text AS reported_residential_area,indexed.reported_site_area::text AS reported_site_area,
          n.ordinal AS numeric_population_ordinal,s.ordinal AS semantic_population_ordinal
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        LEFT JOIN app.neighborhood_cohort_evidence_blobs semantic_body ON semantic_body.organization_id=h.organization_id
          AND semantic_body.content_sha256=h.receipt_reference->>'content_sha256'
          AND semantic_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND semantic_body.canonical_utf8_bytes<=4096
        LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id
          AND m.organization_id=job.organization_id AND m.ordinal=1
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
          AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
          AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id
          AND indexed.organization_id=m.organization_id AND indexed.ordinal=m.ordinal AND indexed.account_id=m.account_id
          AND indexed.contribution_row_reference=m.row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows s ON s.operation_id=m.operation_id AND s.organization_id=m.organization_id
          AND s.ordinal=m.ordinal AND s.account_id=m.account_id AND s.partition_ordinal=m.partition_ordinal AND s.entry_reference=m.entry_reference
          AND s.metric_row_reference=m.metric_row_reference AND s.contribution_row_reference=m.row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id
          AND metric.organization_id=m.organization_id AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id
          AND metric.partition_ordinal=m.partition_ordinal AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
        LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows u ON u.operation_id=metric.operation_id AND u.organization_id=metric.organization_id
          AND u.ordinal=metric.ordinal AND u.account_id=metric.account_id AND u.partition_ordinal=metric.partition_ordinal AND u.entry_reference=metric.entry_reference
        LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows entry ON entry.operation_id=u.operation_id
          AND entry.organization_id=u.organization_id AND entry.account_id=u.account_id AND entry.ordinal=u.partition_ordinal AND entry.entry_reference=u.entry_reference
        WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND semantic_body.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
          AND semantic_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text
          AND semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'`,bound)),[...MEMBER,'semantic_population_ordinal']);
      if(!Object.values(r).every(v=>v===null)&&r.semantic_population_ordinal!==r.ordinal)fail('semantic_population_missing_or_corrupt');
      const {semantic_population_ordinal,...entry}=r;return member(entry);
    },
    // Independent ORIGINAL anchor/key query, not the combined packet's key
    // list or a cache/count/hash/callback. Still FIRST only, exact16 and read
    // only. It does not issue a durable transaction-index phase or dedup keys
    // across accounts. Every package must ALSO pass the whole original owner.
    async readFirstCompletedTransactionNativeKeys(...args){
      if(args.length)fail('invalid_input');
      return nativeKeys(await client.query(`/* custom-cohort-selected-semantic-v2:first-completed-transaction-native-keys */
        WITH selected_context AS MATERIALIZED (
          SELECT stock.generation_id,job.operation_id,m.account_id,m.ordinal
          ${PARENTS}
          JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads h ON h.operation_id=job.operation_id
            AND h.organization_id=job.organization_id
          JOIN app.neighborhood_cohort_evidence_blobs semantic_body ON semantic_body.organization_id=h.organization_id
            AND semantic_body.content_sha256=h.receipt_reference->>'content_sha256'
            AND semantic_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND semantic_body.canonical_utf8_bytes<=4096
          JOIN app.neighborhood_custom_cohort_selected_union_v2_heads union_head ON union_head.operation_id=job.operation_id
            AND union_head.organization_id=job.organization_id
          JOIN app.neighborhood_cohort_evidence_blobs union_body ON union_body.organization_id=union_head.organization_id
            AND union_body.content_sha256=union_head.receipt_reference->>'content_sha256'
            AND union_body.canonical_utf8_bytes::text=union_head.receipt_reference->>'canonical_utf8_bytes' AND union_body.canonical_utf8_bytes<=16000
          JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id
            AND stock.organization_id=job.organization_id AND stock.report_file_id=job.report_file_id
            AND stock.assignment_file_id=job.assignment_file_id AND stock.account_id=job.account_id
            AND stock.actor_user_id=job.actor_user_id AND stock.status='complete'
          JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id
            AND pin.generation_id=stock.generation_id AND pin.organization_id=stock.organization_id
            AND pin.report_file_id=stock.report_file_id AND pin.assignment_file_id=stock.assignment_file_id
            AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
          JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
            AND generation.status='complete' AND generation.retirement_started_at IS NULL
          LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id
            AND m.organization_id=job.organization_id AND m.ordinal=1
          LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows s ON s.operation_id=m.operation_id AND s.organization_id=m.organization_id
            AND s.ordinal=m.ordinal AND s.account_id=m.account_id AND s.partition_ordinal=m.partition_ordinal AND s.entry_reference=m.entry_reference
            AND s.metric_row_reference=m.metric_row_reference AND s.contribution_row_reference=m.row_reference
          LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
            AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
            AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
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
            AND app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
            AND h.command_id=$9::uuid AND h.union_reference=$10::jsonb AND h.eligibility_reference=$11::jsonb
            AND h.evidence_reference=$12::jsonb AND h.metrics_reference=$13::jsonb AND h.statistics_reference=$14::jsonb AND h.numeric_reference=$15::jsonb
            AND semantic_body.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
            AND semantic_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'
            AND union_head.command_id=$9::uuid AND union_head.receipt_reference=$10::jsonb
            AND union_body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
            AND union_body.canonical_utf8::jsonb->>'sequence'=union_head.sequence::text AND union_body.canonical_utf8::jsonb->'after'->>'done'='true'
            AND semantic_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=union_body.canonical_utf8::jsonb->'after_selected_count'
            AND ((union_body.canonical_utf8::jsonb->>'after_selected_count'='0' AND m.operation_id IS NULL)
              OR (union_body.canonical_utf8::jsonb->>'after_selected_count'<>'0' AND s.ordinal=1 AND n.ordinal=1
                AND indexed.ordinal=1 AND metric.ordinal=1 AND u.ordinal=1 AND entry.account_id=m.account_id))
        ), anchors AS MATERIALIZED (
          SELECT original.kind,original.row_key,original.source_record_id FROM selected_context selected
          CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
          CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.source_record_id FROM app.neighborhood_frozen_source_rows o
            WHERE o.generation_id=selected.generation_id AND o.kind=k.kind AND o.account_id=selected.account_id
            ORDER BY o.row_key COLLATE "C" LIMIT 251) original
        ), gate AS MATERIALIZED (
          SELECT selected.*,(SELECT count(*)::integer FROM anchors) AS anchor_count FROM selected_context selected
        ), packages AS MATERIALIZED (
          SELECT 'source_record'::text AS kind,source_record_id::text AS native_key FROM anchors
            WHERE source_record_id IS NOT NULL AND (SELECT anchor_count FROM gate)<=250 GROUP BY source_record_id
          UNION ALL
          SELECT 'legacy_sale',row_key FROM anchors WHERE kind='sales' AND source_record_id IS NULL
            AND (SELECT anchor_count FROM gate)<=250
        )
        SELECT gate.generation_id::text,gate.account_id,gate.ordinal,gate.anchor_count,packages.kind,packages.native_key
        FROM gate LEFT JOIN packages ON gate.anchor_count<=250
        ORDER BY CASE packages.kind WHEN 'source_record' THEN 0 ELSE 1 END,
          CASE WHEN packages.kind='source_record' THEN packages.native_key::bigint END,
          CASE WHEN packages.kind='legacy_sale' THEN packages.native_key END COLLATE "C"
        LIMIT 251`,bound));
    },
    async advance(...args){
      if(args.length!==2)fail('invalid_input');
      const expected=anchor(args[0]),receipt=ref(args[1],4096),sequence=(expected?.sequence??0)+1,started=await tx();
      if(sequence>2000001)fail('corrupt');
      if(!same(await read(started),expected))fail('conflict');
      // Always derive the next actual ninth-joined eighth row; an actual EMPTY inserts zero.
      // The receipt does not choose the member, decide DONE or inject a row.
      const row=await client.query(`/* custom-cohort-selected-semantic-v2:row-insert */
        INSERT INTO app.neighborhood_custom_cohort_selected_semantic_v2_rows(operation_id,organization_id,ordinal,account_id,partition_ordinal,
          entry_reference,metric_row_reference,contribution_row_reference)
        SELECT job.operation_id,job.organization_id,m.ordinal,m.account_id,m.partition_ordinal,m.entry_reference,m.metric_row_reference,m.row_reference
        ${PARENTS}
        LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
        JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id AND m.organization_id=job.organization_id
          AND m.ordinal=coalesce(h.sequence,0)+1 AND m.ordinal=$16::integer
        JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
          AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
          AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
        JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows indexed ON indexed.operation_id=m.operation_id
          AND indexed.organization_id=m.organization_id AND indexed.ordinal=m.ordinal AND indexed.account_id=m.account_id
          AND indexed.contribution_row_reference=m.row_reference
        WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_semantic_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
        RETURNING ordinal`,[...bound,sequence]);
      if(!row||![0,1].includes(row.rowCount)||row.rows?.length!==row.rowCount||row.rowCount===1&&row.rows[0].ordinal!==sequence)fail('corrupt');
      const r=expected===null?await client.query(`/* custom-cohort-selected-semantic-v2:head-insert */
        INSERT INTO app.neighborhood_custom_cohort_selected_semantic_v2_heads(operation_id,organization_id,command_id,union_reference,
          eligibility_reference,evidence_reference,metrics_reference,statistics_reference,numeric_reference,receipt_reference,sequence)
        SELECT job.operation_id,job.organization_id,$9::uuid,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,1
        ${PARENTS} WHERE ${FENCE} AND ${DONE}
          AND app.neighborhood_selected_semantic_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)
        RETURNING sequence`,[...bound,json(receipt)])
        :await client.query(`/* custom-cohort-selected-semantic-v2:head-advance */
          UPDATE app.neighborhood_custom_cohort_selected_semantic_v2_heads head SET receipt_reference=$16::jsonb,sequence=$17::integer
          ${PARENTS} WHERE ${FENCE} AND ${DONE} AND head.operation_id=job.operation_id AND head.organization_id=job.organization_id
            AND head.command_id=$9::uuid AND head.union_reference=$10::jsonb AND head.eligibility_reference=$11::jsonb
            AND head.evidence_reference=$12::jsonb AND head.metrics_reference=$13::jsonb AND head.statistics_reference=$14::jsonb
            AND head.numeric_reference=$15::jsonb AND head.receipt_reference=$18::jsonb AND head.sequence=$19::integer RETURNING head.sequence`,
          [...bound,json(receipt),sequence,json(expected.receipt_reference),expected.sequence]);
      if(one(r).sequence!==sequence)fail('corrupt');const stored=await read(started,'corrupt');
      if(!same(stored,{command_id:o.command_id,...refs,receipt_reference:receipt,sequence}))fail('corrupt');return stored;
    }});
}
