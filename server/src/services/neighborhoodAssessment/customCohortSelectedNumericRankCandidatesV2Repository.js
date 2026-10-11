import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureJobClaim } from './customCohortCaptureJobRepository.js';
import { parseExactDecimalPagedObservationV1 as decimal } from './exactDecimalPagedDistributionV1.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const METRICS=['reported_year_built','reported_residential_area','reported_site_area'];
const REFS=['union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference'];
const VALUES=['low','q1_lower','q1_upper','median_lower','median_upper','q3_lower','q3_upper','high'];
const KEYS=['metric','selected_count','observed_count',...VALUES,'q1_remainder','median_remainder','q3_remainder'];
const fail=reason=>{throw new TypeError(`custom_cohort_selected_numeric_rank_candidates_v2_${reason}`);};
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const ds=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(ds).length!==keys.length||!keys.every(k=>ds[k]?.enumerable&&Object.hasOwn(ds[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
function ref(value,max=16000){const r=data(value,['content_sha256','canonical_utf8_bytes']),p=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes);
  if(Number(p.canonical_utf8_bytes)>max)fail('invalid_reference');return p;}
function count(value){if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,6})$/.test(value)||BigInt(value)>2000000n)fail('corrupt');return Number(value);}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

// Fixed SQL, not caller-selected identifiers, rank/ordinal, roster or counts.
// Each account keeps multiplicity; ordinal is a stable tie breaker. Native
// numeric comparisons only, no float/interpolation/rounded numeric typmod.
// Only THREE fixed rows leave PostgreSQL, not a population array/JSON stream.
const columns=METRICS.map((metric,i)=>`SELECT '${metric}'::text AS metric,${i} AS metric_order,m.ordinal,m.${metric} AS value,
    row_number() OVER(ORDER BY m.${metric},m.ordinal) AS rank
  FROM members m WHERE m.${metric} IS NOT NULL`).join('\n  UNION ALL\n  ');
export const CUSTOM_COHORT_SELECTED_NUMERIC_RANK_CANDIDATES_V2_SQL=`/* custom-cohort-selected-numeric-rank-candidates-v2:read */
WITH admitted AS MATERIALIZED (
  SELECT job.operation_id,job.organization_id,eighth_body.canonical_utf8::jsonb AS eighth,
    numeric_body.canonical_utf8::jsonb AS ninth
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads h USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs eighth_body ON eighth_body.organization_id=eighth.organization_id
    AND eighth_body.content_sha256=eighth.receipt_reference->>'content_sha256'
    AND eighth_body.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND eighth_body.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_cohort_evidence_blobs numeric_body ON numeric_body.organization_id=h.organization_id
    AND numeric_body.content_sha256=h.receipt_reference->>'content_sha256'
    AND numeric_body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND numeric_body.canonical_utf8_bytes<=4096
  JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
  WHERE job.operation_id=$1::uuid AND job.claim_token=$2::uuid AND job.attempts=$3::integer
    AND job.organization_id=$4::uuid AND job.report_file_id=$5::uuid AND job.assignment_file_id=$6::bigint
    AND job.account_id=$7 AND job.actor_user_id=$8::uuid AND job.status='running'
    AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
    AND h.command_id=$9::uuid AND h.union_reference=$10::jsonb AND h.eligibility_reference=$11::jsonb
    AND h.evidence_reference=$12::jsonb AND h.metrics_reference=$13::jsonb
    AND h.statistics_reference=$14::jsonb AND h.receipt_reference=$15::jsonb
    AND app.neighborhood_selected_numeric_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
    AND numeric_body.canonical_utf8::jsonb->>'format'='cohort_selected_numeric_receipt_v2'
    AND numeric_body.canonical_utf8::jsonb->>'sequence'=h.sequence::text
    AND numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'
    AND eighth_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
    AND eighth_body.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text
    AND eighth_body.canonical_utf8::jsonb->'after'->>'done'='true'
    AND c.phase='frozen_selected_numeric_refs_v2' AND c.progress_reference=h.receipt_reference
    AND c.consumed_claim_token IS NOT NULL AND c.issued_attempts<=job.attempts
    AND ((job.attempts=c.issued_attempts AND c.consumed_claim_token=job.claim_token)
      OR (job.attempts>c.issued_attempts AND job.claim_token<>c.consumed_claim_token AND job.claim_token<>c.issued_claim_token))
), members AS MATERIALIZED (
  SELECT n.ordinal,i.reported_year_built,i.reported_residential_area,i.reported_site_area
  FROM admitted a
  JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n USING(operation_id,organization_id)
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=n.operation_id AND m.organization_id=n.organization_id
    AND m.ordinal=n.ordinal AND m.account_id=n.account_id AND m.partition_ordinal=n.partition_ordinal
    AND m.entry_reference=n.entry_reference AND m.metric_row_reference=n.metric_row_reference AND m.row_reference=n.contribution_row_reference
  JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i ON i.operation_id=n.operation_id AND i.organization_id=n.organization_id
    AND i.ordinal=n.ordinal AND i.account_id=n.account_id AND i.contribution_row_reference=n.contribution_row_reference
), totals AS MATERIALIZED (
  SELECT count(*) AS selected_count,count(reported_year_built) AS year_count,
    count(reported_residential_area) AS residential_count,count(reported_site_area) AS site_count FROM members
), complete AS MATERIALIZED (
  SELECT t.* FROM admitted a CROSS JOIN totals t
  WHERE t.selected_count=(a.eighth->>'selected_stock_count')::bigint
    AND t.selected_count=(a.ninth->'after'->>'selected_ordinal')::bigint
    AND t.year_count=(a.eighth->'after_counts'->'reported_year_built'->>'eligible_count')::bigint
    AND t.residential_count=(a.eighth->'after_counts'->'reported_residential_area'->>'eligible_count')::bigint
    AND t.site_count=(a.eighth->'after_counts'->'reported_site_area'->>'eligible_count')::bigint
), ranked AS MATERIALIZED (
  ${columns}
), metrics AS (
  SELECT metric,metric_order,c.selected_count,
    CASE metric_order WHEN 0 THEN c.year_count WHEN 1 THEN c.residential_count ELSE c.site_count END AS observed_count
  FROM complete c CROSS JOIN (VALUES ('reported_year_built',0),('reported_residential_area',1),('reported_site_area',2)) AS names(metric,metric_order)
)
SELECT names.metric,names.selected_count::text,names.observed_count::text,
  min(r.value)::text AS low,max(r.value)::text AS high,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)/4)::text AS q1_lower,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)/4+CASE WHEN (names.observed_count-1)%4=0 THEN 0 ELSE 1 END)::text AS q1_upper,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*2/4)::text AS median_lower,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*2/4+CASE WHEN ((names.observed_count-1)*2)%4=0 THEN 0 ELSE 1 END)::text AS median_upper,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*3/4)::text AS q3_lower,
  max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*3/4+CASE WHEN ((names.observed_count-1)*3)%4=0 THEN 0 ELSE 1 END)::text AS q3_upper,
  CASE WHEN names.observed_count=0 THEN 0 ELSE (names.observed_count-1)%4 END::integer AS q1_remainder,
  CASE WHEN names.observed_count=0 THEN 0 ELSE ((names.observed_count-1)*2)%4 END::integer AS median_remainder,
  CASE WHEN names.observed_count=0 THEN 0 ELSE ((names.observed_count-1)*3)%4 END::integer AS q3_remainder
FROM metrics names LEFT JOIN ranked r ON r.metric=names.metric AND r.metric_order=names.metric_order
GROUP BY names.metric,names.metric_order,names.selected_count,names.observed_count ORDER BY names.metric_order`;

/** INACTIVE native structural rank candidates only, NOT a statistics owner.
 * Complete immutable ninth progress does NOT grant current source/selection
 * authority. A later bounded semantic owner MUST reopen COMPLETE originals,
 * ENTIRE caches, every seventh/eighth/index field and all current+ending
 * actor/assignment/private-draft/subject/source/claim/workspace fences AGAIN,
 * reconcile every eligible/state count, then derive exact quantiles/deviations.
 * No publication, counts/hash shortcut, caller population or activation. */
export function createCustomCohortSelectedNumericRankCandidatesV2Repository(raw){
  const o=data(raw,['client','claim','scope','actorUserId','command_id',...REFS]),{client}=o,
    claim=prepareCustomCohortCaptureJobClaim(data(o.claim,['operation_id','claim_token','attempts'])),
    scope=data(o.scope,['organization_id','report_file_id','assignment_file_id','account_id']),
    refs=Object.fromEntries(REFS.map(k=>[k,ref(o[k],k==='numeric_reference'?4096:16000)]));
  if(typeof client?.query!=='function'||![scope.organization_id,scope.report_file_id,o.actorUserId,o.command_id].every(v=>typeof v==='string'&&UUID.test(v))
    ||typeof scope.assignment_file_id!=='string'||!/^[1-9][0-9]{0,18}$/.test(scope.assignment_file_id)
    ||BigInt(scope.assignment_file_id)>9223372036854775807n||typeof scope.account_id!=='string'||!scope.account_id||scope.account_id.length>64
    ||!scope.account_id.isWellFormed()||scope.account_id.trim()!==scope.account_id||/[\u0000-\u001f\u007f]/.test(scope.account_id))fail('invalid_scope');
  const values=[claim.operation_id,claim.claim_token,claim.attempts,scope.organization_id,scope.report_file_id,scope.assignment_file_id,
    scope.account_id,o.actorUserId,o.command_id,...REFS.map(k=>json(refs[k]))];
  const tx=async()=>{const r=await client.query('/* custom-cohort-selected-numeric-rank-candidates-v2:transaction */ SELECT txid_current()::text AS transaction_id');
    if(r?.rowCount!==1||r.rows?.length!==1||typeof r.rows[0]?.transaction_id!=='string'||!/^[1-9][0-9]{0,19}$/.test(r.rows[0].transaction_id))fail('caller_transaction_required');
    return r.rows[0].transaction_id;};
  return Object.freeze({async read(...args){
    if(args.length)fail('invalid_input');const started=await tx(),result=await client.query(CUSTOM_COHORT_SELECTED_NUMERIC_RANK_CANDIDATES_V2_SQL,values);
    if(result?.rowCount!==3||!Array.isArray(result.rows)||result.rows.length!==3)fail('claim_lost_or_incomplete');
    const rows=result.rows.map((row,index)=>{
      const r=data(row,KEYS),selected=count(r.selected_count),observed=count(r.observed_count);
      if(r.metric!==METRICS[index]||observed>selected||index&&r.selected_count!==result.rows[0].selected_count)fail('corrupt');
      for(const [name,k] of [['q1',1],['median',2],['q3',3]]){
        const remainder=observed?((observed-1)*k)%4:0;
        if(r[name+'_remainder']!==remainder||remainder===0&&r[name+'_lower']!==r[name+'_upper'])fail('corrupt');
      }
      if(!observed){if(VALUES.some(k=>r[k]!==null))fail('corrupt');}
      else{
        const v=Object.fromEntries(VALUES.map(k=>[k,decimal(r[k])]));
        for(const side of ['lower','upper']){
          const ordered=[v.low,v['q1_'+side],v['median_'+side],v['q3_'+side],v.high];
          if(ordered.some((n,i)=>i&&n<ordered[i-1]))fail('corrupt');
        }
        if(['q1','median','q3'].some(k=>v[k+'_lower']>v[k+'_upper'])||observed===1&&v.low!==v.high)fail('corrupt');
      }
      return r;
    });
    if(await tx()!==started)fail('caller_transaction_required');
    return freeze({format:'cohort_selected_numeric_rank_candidates_v2',command_id:o.command_id,...refs,metrics:rows,
      authority:'not_established',original_reconciliation:'not_established',statistics:'not_established',
      later_semantic_owner:'must_reopen_complete_originals_ENTIRE_caches_and_all_current_ending_authority_again'});
  }});
}
