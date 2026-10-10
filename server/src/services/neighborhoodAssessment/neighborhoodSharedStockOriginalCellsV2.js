import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { compileNeighborhoodFrozenTypedOriginalV2, getNeighborhoodFrozenTypedOriginalV2Profile }
  from './neighborhoodFrozenTypedOriginalV1.js';
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL, prepareNeighborhoodSharedTypedSource,
  NEIGHBORHOOD_SHARED_TYPED_CAD_SQL, prepareNeighborhoodSharedTypedCadSource } from './neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedCadImprovementV1Profile } from './neighborhoodFrozenTypedCadImprovementV1.js';
import { reconcileNeighborhoodOriginalCadAccountPackageV2 } from './neighborhoodOriginalCadAccountPackagesV2.js';
import { resolveNeighborhoodOriginalCadAmenityEvidenceV2 } from './neighborhoodOriginalCadAmenityEvidenceV2.js';
import { NEIGHBORHOOD_FIRST_SELECTED_AMENITY_ORIGINAL_PACKAGE_V2_SQL } from './neighborhoodSelectedAmenityOriginalPackageV2.js';
import { NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL,
  NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL } from './neighborhoodSelectedTransactionOriginalPackageV2.js';
import { reconcileNeighborhoodOriginalTransactionPackageV2 } from './neighborhoodOriginalTransactionPackagesV2.js';
import { projectNeighborhoodTransactionPackageV1 } from './neighborhoodSharedTransactionPackagesV1.js';
import { prepareNeighborhoodTransactionRetainedPeriodV1 } from './neighborhoodTransactionTemporalV1.js';
import { resolveNeighborhoodOriginalAccountHousingV2 } from './neighborhoodOriginalAccountHousingV2.js';
import { projectNeighborhoodOriginalRecordedGroupLabelsV2,resolveNeighborhoodOriginalRecordedGroupV2 }
  from './neighborhoodOriginalRecordedGroupV2.js';

export const NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS = Object.freeze({ rows:250,
  original_utf8_bytes:1000000, row_utf8_bytes:2100000, page_utf8_bytes:8000000,
  output_utf8_bytes:2100000, read_utf8_bytes:32000000, queries:128, step_ms:60000, query_ms:5000 });
const L=NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_LIMITS, TYPED=getNeighborhoodFrozenTypedOriginalV2Profile(),
  CAD_TYPED=getNeighborhoodFrozenTypedCadImprovementV1Profile();
const KINDS=Object.freeze(['parcels','accounts']), ALL=['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
/** Refuse without including retained private observations in the error. */
const fail=reason=>{throw new TypeError(`neighborhood_stock_original_cells_v2_${reason}`);};
/** Compare detached validated DATA, never an authorization claim. */
const same=(a,b)=>canonicalAssessmentJson(a)===canonicalAssessmentJson(b);
/** Freeze only the owned result tree after validation and original replay. */
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
/** Admit a closed own-data object before touching any untrusted property. */
function data(value,keys){
  if(!value||isProxy(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_input');
  const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
  if(names.length!==keys.length||!keys.every(k=>descriptors[k]?.enumerable&&Object.hasOwn(descriptors[k],'value')))fail('invalid_input');
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
/** Validate exact native keys in the cache's installed C-text order. */
function cursor(value,kind){
  if(typeof value!=='string'||value.length>64||Buffer.byteLength(value)>256||/[\u0000-\u001f\u007f]/.test(value))fail('invalid_cursor');
  if(value===''||kind==='accounts'&&value===value.trim())return value;
  if(kind!=='parcels'||!/^(?:0|[1-9][0-9]{0,18})$/.test(value)||BigInt(value)>9223372036854775807n)fail('invalid_cursor');
  return value;
}
/** Require a single complete SQL metadata envelope. */
const one=result=>{if(result?.rowCount!==1||result.rows?.length!==1)fail('invalid_result');return result.rows[0];};
/** Validate a canonical bounded count without economic floating-point conversion. */
const count=(value,max)=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=BigInt(max);
/** Only a fixed kind, cursor and bounded page size are caller-supplied. */
export function prepareNeighborhoodStockOriginalCellPageV2(value){
  const page=data(value,['kind','cursor','rowLimit']);
  if(!KINDS.includes(page.kind)||!Number.isInteger(page.rowLimit)||page.rowLimit<1||page.rowLimit>L.rows)fail('invalid_page');
  cursor(page.cursor,page.kind);return freeze(page);
}
const DEFINITION=freeze({id:'neighborhood-shared-stock-original-cells-v2',revision:'1',typed_profile:TYPED,
  limits:L,kinds:KINDS,scope:'all_retained_original_parts_of_exact_stock_accounts_including_parts_outside_geometry',
  order:'native_row_key_C_text_not_numeric',scan:'bounded_original_key_prefix_before_stock_membership_no_filtered_whole_generation_scan',
  reconciliation:'recompile_every_delivered_original_payload_and_compare_entire_neutral_cache_row',
  missing_cache_row:'refuse_not_skip',missing_account_original:'not_fabricated_full_stock_denominator_still_required',
  temporal:'owner_retained_effective_year_applied_to_each_cell_before_any_resolution',
  provenance:'original_payload_hash_and_byte_length_recomputed_not_substituted_for_original_replay',
  delivery:'no_original_payload_text_or_geometry_only_reconciled_typed_cells_and_bounded_literal_markers',
  authority:'not_established',coverage:'one_kind_page_only',
  limitations:['no_complete_traversal_or_selected_union_receipt','no_housing_or_amenity_dictionary',
    'no_currency_GLA_historical_or_at_sale_inference','no_acquisition_statistics_publication_or_report_update']});
const definitionText=canonicalAssessmentJson(DEFINITION),definitionRef=prepareNeighborhoodCohortBlob(definitionText);
const PROFILE=freeze({profile_ref:{id:DEFINITION.id,revision:'1',content_sha256:definitionRef.content_sha256},
  definition_blob:{ref:definitionRef,canonical_json:definitionText}});
/** Return the pinned projection definition, not a source or selection capability. */
export function getNeighborhoodStockOriginalCellsV2Profile(){return PROFILE;}

/** The server chooses the next exact stock account; this is only a keyset. */
export function prepareNeighborhoodStockAccountPackagePageV2(value){
  const page=data(value,['cursor']);cursor(page.cursor,'accounts');return freeze(page);
}
const PACKAGE_DEFINITION=freeze({id:'neighborhood-stock-account-original-package-v2',revision:'1',
  original_cell_profile:PROFILE,limits:L,population:'one_next_exact_stock_account_chosen_by_server',
  completeness:'both_original_kind_counts_bounded_at_251_then_all_or_nothing_total_cap_250',
  parts:'all_retained_parcel_parts_including_outside_geometry_plus_account_original_if_present',
  resolution:'retained_year_before_exact_distinct_value_five_state_resolution_no_summing_parts',
  missing_account:'explicit_zero_originals_no_fabricated_markers',
  units:'reported_sqft_and_year_only_market_value_currency_unknown_not_inferred',
  authority:'not_established',coverage:'one_complete_account_package_not_complete_selected_union',
  limitations:['not_verified_GLA_or_historical_stock','no_amenity_dictionary_or_economic_unit_inference',
    'no_selected_revision_statistics_publication_acquisition_or_report_update']});
const packageDefinitionText=canonicalAssessmentJson(PACKAGE_DEFINITION),packageDefinitionRef=prepareNeighborhoodCohortBlob(packageDefinitionText);
const PACKAGE_PROFILE=freeze({profile_ref:{id:PACKAGE_DEFINITION.id,revision:'1',content_sha256:packageDefinitionRef.content_sha256},
  definition_blob:{ref:packageDefinitionRef,canonical_json:packageDefinitionText}});
/** A fixed interpretation definition, never account/selection/source authority. */
export function getNeighborhoodStockAccountPackageV2Profile(){return PACKAGE_PROFILE;}

// ORIGINAL counts, not cache counts, detect a missing cache row. Every per-kind
// counter stops at cap+1; over-limit packets deliver ZERO original payloads.
// The fixed stock PK picks one next account; neither caller account lists nor
// a filtered generation sweep can choose the population. All indexed probes
// are correlated to that one exact account before materializing any payload.
export const NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL=`/* neighborhood-stock-account-original-package-v2 */
WITH chosen AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 1
), totals AS MATERIALIZED (
  SELECT kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=(SELECT account_id FROM chosen)
    LIMIT ($5::integer+1)) bounded) AS n FROM (VALUES ('parcels'),('accounts')) k(kind)
), members AS MATERIALIZED (
  SELECT o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND (SELECT sum(n) FROM totals)<=$5::integer OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM chosen) AS account_id,(SELECT parcel_count::text FROM chosen) AS geographic_parcel_count,
  (SELECT jsonb_object_agg(kind,n) FROM totals) AS original_counts,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`;

// The exact subject comes from the fenced job, not a caller cursor/account or
// the first C-sorted stock member. CAD fallback is available ONLY when that
// subject belongs to this issued stock (and hence its complete original graph).
// Missing stock membership refuses; it is never fabricated as missing housing.
// Everything after chosen is byte-identical: BOTH original counters, whole
// package admission, every outside part, entire cache replay and shared budget.
export const NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL=NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL
  .replace('/* neighborhood-stock-account-original-package-v2 */','/* neighborhood-stock-subject-housing-original-package-v2 */')
  .replace('account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 1',
    `account_id=(SELECT job.account_id FROM app.neighborhood_custom_cohort_capture_jobs job
      WHERE job.operation_id=$1::uuid AND job.account_id=$4::text) LIMIT 1`);

// One lifetime, ONE aggregate 250-original admission, at most TWO distinct
// native stock accounts. The actual owner supplies its issued next cursor and
// decides whether retained-subject absence requires CAD. Same-account facts
// are deduplicated before counts or payload reads; never open a second reader.
const SUBJECT_AND_CHOSEN_PACKAGE_V2_SQL=`), subject_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_stock_accounts a USING(operation_id)
  WHERE job.operation_id=$1::uuid AND a.account_id=job.account_id AND $10::boolean
), chosen AS MATERIALIZED (
  SELECT * FROM next_account UNION SELECT * FROM subject_account
), totals AS MATERIALIZED (
  SELECT a.account_id,k.kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
    LIMIT ($5::integer+1)) bounded) AS n FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
), members AS MATERIALIZED (
  SELECT o.account_id,o.kind,o.row_key,t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload
    FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND (SELECT sum(n) FROM totals)<=$5::integer
      AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account)) OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM next_account) AS account_id,
  (SELECT parcel_count::text FROM next_account) AS geographic_parcel_count,
  (SELECT account_id FROM subject_account) AS subject_account_id,
  (SELECT parcel_count::text FROM subject_account) AS subject_geographic_parcel_count,
  coalesce((SELECT n FROM totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='parcels'),0) AS next_parcels,
  coalesce((SELECT n FROM totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='accounts'),0) AS next_accounts,
  coalesce((SELECT n FROM totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='parcels'),0) AS subject_parcels,
  coalesce((SELECT n FROM totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='accounts'),0) AS subject_accounts,
  coalesce((SELECT sum(n)::integer FROM totals),0) AS original_count,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY account_id COLLATE "C",kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`;

export const NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL=`/* neighborhood-stock-subject-and-next-original-package-v2 */
WITH next_account AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$4::text COLLATE "C" ORDER BY account_id LIMIT 1
${SUBJECT_AND_CHOSEN_PACKAGE_V2_SQL}`;

// Distinct fixed read-only admission: ordinal1 of the ACTUAL completed union,
// not first C-sorted stock, a caller account/cursor or a count-derived roster.
// Both consumers use the identical aggregate original/transport/output bounds.
export const NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL=`/* neighborhood-stock-subject-and-first-selected-original-package-v2 */
WITH next_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=head.organization_id
    AND body.content_sha256=head.receipt_reference->>'content_sha256'
    AND body.canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r
    ON r.operation_id=job.operation_id AND r.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id
  WHERE job.operation_id=$1::uuid AND r.ordinal=1 AND $4::text=''
    AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
    AND body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
    AND body.canonical_utf8::jsonb->'after'->>'done'='true'
${SUBJECT_AND_CHOSEN_PACKAGE_V2_SQL}`;

// Fifth-pass next ordinal derives ONLY from the actual native eligibility head.
// No external cursor/account/ordinal or second aggregate budget is admitted.
export const NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_ELIGIBILITY_PACKAGE_V2_SQL=`/* neighborhood-stock-subject-and-next-eligibility-original-package-v2 */
WITH next_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=u.organization_id
    AND body.content_sha256=u.receipt_reference->>'content_sha256'
    AND body.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=16000
  LEFT JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r
    ON r.operation_id=job.operation_id AND r.organization_id=job.organization_id AND r.ordinal=coalesce(h.sequence,0)+1
  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id
  WHERE job.operation_id=$1::uuid AND $4::text=''
    AND ((h.operation_id IS NULL AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
      OR app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
    AND body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
    AND body.canonical_utf8::jsonb->'after'->>'done'='true'
${SUBJECT_AND_CHOSEN_PACKAGE_V2_SQL}`;

const METRICS=Object.freeze({reported_year_built:'year',reported_residential_area:'reported_sqft',reported_site_area:'reported_sqft',reported_market_value:null});
/** Compare canonical exact decimal literals; never round economic values. */
function decimal(value){const [whole,fraction='']=value.split('.');return BigInt(whole)*1000000000000n+BigInt(fraction.padEnd(12,'0'));}
/** Resolve only a complete original parcel packet, retaining every reason. */
function resolveAccount(rows){
  const parts=rows.filter(r=>r.kind==='parcels'),observations={};
  for(const [metric,unit] of Object.entries(METRICS)){
    const counts={observed:0,missing:0,invalid:0,unsupported:0};let low=null,high=null;
    for(const part of parts){const c=part.retained_observations[metric];
      if(!Object.hasOwn(counts,c.state)||c.state==='observed'&&(unit===null||c.unit!==unit))fail('invalid_original');
      counts[c.state]++;
      if(c.exact_value!==null){const value=decimal(c.exact_value);
        if(low===null||value<low.value)low={value,text:c.exact_value};if(high===null||value>high.value)high={value,text:c.exact_value};}
    }
    const state=low!==null&&low.value!==high.value?'conflicting':counts.observed?'observed':counts.unsupported?'unsupported':counts.invalid?'invalid':'missing';
    observations[metric]={state,exact_value:['observed','unsupported'].includes(state)?low?.text??null:null,
      unit:state==='observed'?unit:null,source_part_count:String(parts.length),
      ...Object.fromEntries(Object.entries(counts).map(([s,n])=>[`${s}_part_count`,String(n)])),
      conflict_values:state==='conflicting'?[low.text,high.text]:[]};
  }
  return observations;
}

// Start from ORIGINALS, not the cache: a missing typed row cannot disappear.
// The existing generation/kind/C-key PK, stock-account PK and typed PK scope
// one bounded original-key prefix BEFORE stock filtering. Empty scoped pages
// still advance the scan watermark; they do not prove an exhausted kind.
// No current core source, dense roster, spatial sweep or
// caller-selected relation/field/date. Both transport and output prefix budgets
// apply before any original leaves SQL; an oversized candidate refuses, not skips.
export const NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL=`/* neighborhood-shared-stock-original-cells-v2:page */
WITH scan_keys AS MATERIALIZED (
  SELECT o.row_key,o.account_id FROM app.neighborhood_frozen_source_rows o
  WHERE o.generation_id=$2::uuid AND o.kind=$4 AND o.row_key>$5::text COLLATE "C"
  ORDER BY o.row_key LIMIT $6::integer
), candidates AS MATERIALIZED (
  SELECT o.row_key,o.payload::text AS original_text,t.typed,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded,
    t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id
      OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid
  FROM scan_keys k
  CROSS JOIN LATERAL (SELECT a.account_id FROM app.neighborhood_custom_cohort_stock_accounts a
    WHERE a.operation_id=$1::uuid AND a.account_id=k.account_id OFFSET 0) a
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=$4 AND o.row_key=k.row_key OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE t.generation_id=$2::uuid
    AND t.profile_sha256=$3 AND t.kind=$4 AND t.row_key=k.row_key OFFSET 0) t ON true
  ORDER BY o.row_key
), sized AS (
  SELECT *,octet_length(encoded) AS bytes,octet_length(original_text) AS original_bytes,
    sum(octet_length(encoded)+1) OVER(ORDER BY row_key) AS cumulative,
    sum(2*coalesce(octet_length(typed::text),0)+1024) OVER(ORDER BY row_key) AS output_cumulative
  FROM candidates
), admitted AS (SELECT * FROM sized WHERE bytes<=$8::integer AND original_bytes<=$9::integer
    AND cumulative+1<=$7::integer AND output_cumulative+1<=$10::integer)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY row_key)||']','[]') AS page_json,
  count(*)::integer AS page_count,(SELECT count(*)::integer FROM candidates) AS candidate_count,
  (SELECT count(*)::integer FROM scan_keys) AS scan_count,(SELECT max(row_key) FROM scan_keys) AS scan_cursor,
  (SELECT count(*)::integer FROM sized WHERE invalid) AS invalid_count,
  (SELECT count(*)::integer FROM sized WHERE bytes>$8::integer OR original_bytes>$9::integer) AS oversized_count,
  CASE WHEN count(*)=(SELECT count(*) FROM candidates) THEN (SELECT max(row_key) FROM scan_keys)
    ELSE max(row_key) END AS next_cursor FROM admitted`;

/** One single-use read under the actual current-authorized V2 capture owner.
 * The original graph/geography/identity, source purpose and stock must already
 * be independently issued and rechecked at both transaction ends. Recompile
 * every delivered original and compare the ENTIRE neutral cache value before
 * projecting the owner's retained year. Hashes/counts/caller callbacks are not
 * original reconciliation. No miss preparation, payload copy, durable write,
 * selection, synchronous per-cell query callback or report authority is minted.
 */
export function createNeighborhoodSharedStockOriginalCellsV2(client,rawOptions,rawGraph,effectiveDate){
  const options=data(rawOptions,['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if(typeof client?.query!=='function'||typeof options.checkBudget!=='function')fail('invalid_input');
  const g=data(rawGraph,['root','layer_counts']),r=data(g.root,['content_sha256','canonical_utf8_bytes']);
  const root=prepareNeighborhoodCohortBlobReference(r.content_sha256,r.canonical_utf8_bytes),layers=data(g.layer_counts,ALL);
  if(!Object.values(layers).every(n=>Number.isInteger(n)&&n>=0&&n<=2000000))fail('invalid_input');
  const effective=assessmentDate(effectiveDate),graph=freeze({root,layer_counts:layers});
  let used=false,queries=0,bytes=0,started;
  /** Charge all nested SQL reads against one step's deadline/query/byte budget. */
  const check=()=>{options.checkBudget();if(performance.now()-started>L.step_ms)fail('deadline');};
  /** The stock store and this reader share this exact bounded SQL executor. */
  const execute=async(text,values)=>{
    check();if(++queries>L.queries)fail('query_limit');
    const query=typeof text==='string'?{text,values,query_timeout:L.query_ms}:{...text,query_timeout:L.query_ms};
    const result=await client.query(query);if(!Array.isArray(result?.rows))fail('invalid_result');
    let encoded;try{encoded=JSON.stringify(result.rows);}catch{fail('invalid_result');}
    bytes+=Buffer.byteLength(encoded);if(bytes>L.read_utf8_bytes)fail('byte_limit');check();return result;
  };
  const stocks=createNeighborhoodFrozenJobStock({query:execute},options);
  /** Both fixed consumers share one single-use budget and identical fences. */
  async function open(){
      if(used)fail('single_use');used=true;started=performance.now();
      const stock=await stocks.read(),original=stock.original;
      const source=prepareNeighborhoodSharedTypedSource(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id);
      const expected={generation_id:original.generation_id,format_version:original.source_format_version,status:'complete',
        source_snapshot:original.source_snapshot,started_at:original.source_transaction_started_at,completed_at:original.completed_at,
        layer_counts:original.layer_counts,row_count:original.row_count,payload_utf8_bytes:original.payload_utf8_bytes};
      if(!same(source,expected)||Object.entries(layers).some(([k,n])=>n>Number(source.layer_counts[k].row_count)))fail('source_mismatch');
      const binding=assessmentEvidenceDigest({source,profile:TYPED}),headerValues=[stock.generation_id,TYPED.profile_ref.content_sha256];
      /** A complete immutable cache is prerequisite DATA, never prepared here. */
      const validateHeader=value=>{
        const h=data(value,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']);
        const p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
        if(h.binding_sha256!==binding||!same(h.source_metadata,source)||h.definition_json!==TYPED.definition_blob.canonical_json
          ||h.status!=='complete'||typeof h.completed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at)
          ||p.format!=='shared_frozen_typed_progress_v2'||p.binding_sha256!==binding||p.kind_index!==7||p.after!==''||p.layer_rows!==0
          ||p.typed_rows!==source.row_count||!count(p.typed_utf8_bytes,8000000000)||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows))fail('cache_unavailable');
      };
      const header=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,headerValues));validateHeader(header);
      return {stock,source,async finish(){
        if(!same(await stocks.read(),stock)||!same(prepareNeighborhoodSharedTypedSource(
          await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source,[stock.generation_id]),stock.generation_id),source))fail('source_changed');
        const ending=one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read,headerValues));validateHeader(ending);
        if(!same(ending,header))fail('source_changed');check();
      }};
  }
  /** Distinct CAD cache prerequisite inside this SAME single-use executor.
   * The actual owner has already authorized the separate CAD purpose; neither
   * metadata nor this helper grants rights or prepares a cache on miss. */
  async function openCad(stock){
    const readSource=async()=>prepareNeighborhoodSharedTypedCadSource(
      await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.source,[stock.generation_id]),stock.generation_id);
    const source=await readSource();
    if(source.source_snapshot!==stock.original.source_snapshot
      ||source.started_at!==stock.original.source_transaction_started_at)fail('CAD_source_mismatch');
    const binding=assessmentEvidenceDigest({source,profile:CAD_TYPED}),values=[stock.generation_id,CAD_TYPED.profile_ref.content_sha256];
    const validate=value=>{
      const h=data(value,['binding_sha256','source_metadata','definition_json','progress','status','completed_at']),
        p=data(h.progress,['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
      if(h.binding_sha256!==binding||!same(h.source_metadata,source)||h.definition_json!==CAD_TYPED.definition_blob.canonical_json
        ||h.status!=='complete'||typeof h.completed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at)
        ||p.format!=='shared_frozen_typed_CAD_progress_v1'||p.binding_sha256!==binding||p.kind_index!==2||p.after!==''||p.layer_rows!==0
        ||p.typed_rows!==source.row_count||!count(p.typed_utf8_bytes,8000000000)||BigInt(p.typed_utf8_bytes)<BigInt(p.typed_rows))fail('CAD_cache_unavailable');
    };
    const header=one(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,values));validate(header);
    return {source,async finish(){
      if(!same(await readSource(),source))fail('CAD_source_changed');
      const ending=one(await execute(NEIGHBORHOOD_SHARED_TYPED_CAD_SQL.read,values));validate(ending);
      if(!same(ending,header))fail('CAD_source_changed');check();
    }};
  }
  /** Recompile a complete original; never accept the stored cell as authority. */
  function reconcile(value,recordedGroup=false){
    check();const row=data(value,['kind','row_key','account_id','source_record_id','original_text',
      'cached_account_id','cached_source_record_id','original_payload_sha256','typed']);
    if(!KINDS.includes(row.kind))fail('invalid_original');cursor(row.row_key,row.kind);
    if(!row.row_key||row.account_id===null||row.source_record_id!==null||typeof row.original_text!=='string'
      ||Buffer.byteLength(row.original_text)>L.original_utf8_bytes||Buffer.byteLength(JSON.stringify(row))>L.row_utf8_bytes)fail('invalid_original');
    const replay=compileNeighborhoodFrozenTypedOriginalV2({kind:row.kind,row_key:row.row_key,payload_text:row.original_text});
    if(!same(replay,row.typed)||replay.account_id!==row.account_id||row.cached_account_id!==row.account_id
      ||replay.source_record_id!==row.source_record_id||row.cached_source_record_id!==row.source_record_id
      ||row.original_payload_sha256!==replay.original.payload_sha256)fail('original_mismatch');
    const observations=structuredClone(replay.observations),year=observations.reported_year_built;
    if(year?.state==='observed'&&year.exact_value>effective.slice(0,4))Object.assign(year,
      {state:'invalid',exact_value:null,unit:null,reason:'year_after_retained_effective_year'});
    // The neutral cache deliberately retains only128 bytes of marker text.
    // A distinct original projection preserves the recorded catalog's512-byte
    // labels ONLY AFTER this complete original/ENTIRE cache replay. Never
    // fabricate missing membership or recover a longer label from its hash.
    const originalLabels=recordedGroup?projectNeighborhoodOriginalRecordedGroupLabelsV2({kind:row.kind,row_key:row.row_key,
      account_id:row.account_id,payload_text:row.original_text}):null;
    check();return {kind:row.kind,row_key:row.row_key,account_id:row.account_id,
      original_payload_sha256:replay.original.payload_sha256,typed:replay,retained_observations:observations,
      ...(recordedGroup?{original_recorded_labels:originalLabels}:{})};
  }
  /** Same original-count, whole-payload and lifetime SQL budgets for all
   * consumers. Combined facts never reopen under a reset per-method budget. */
  async function accountPackage(rawPage,housing,recordedGroup=false,subjectHousing=false){
      const page=subjectHousing?{cursor:options.scope.account_id}:prepareNeighborhoodStockAccountPackagePageV2(rawPage),
        context=await open(),{stock,source}=context;
      const result=one(await execute(subjectHousing?NEIGHBORHOOD_STOCK_SUBJECT_HOUSING_PACKAGE_V2_SQL:NEIGHBORHOOD_STOCK_ACCOUNT_PACKAGE_V2_SQL,[stock.operation_id,stock.generation_id,
        TYPED.profile_ref.content_sha256,page.cursor,L.rows,L.page_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes]));
      const counts=data(result.original_counts,KINDS);
      if(!Object.values(counts).every(n=>Number.isInteger(n)&&n>=0&&n<=L.rows+1)
        ||!Number.isInteger(result.page_count)||result.page_count<0||result.invalid_count!==0
        ||typeof result.packet_oversize!=='boolean'||typeof result.page_json!=='string')fail('invalid_result');
      const total=counts.parcels+counts.accounts;
      if(total>L.rows){if(result.page_count!==0||result.page_json!=='[]')fail('invalid_result');fail('account_package_row_limit');}
      if(result.packet_oversize)fail('account_package_byte_limit');
      if(result.page_count!==total||counts.parcels>layers.parcels||counts.accounts>layers.accounts
        ||Buffer.byteLength(result.page_json)>L.page_utf8_bytes)fail('invalid_result');
      const present=result.account_id!==null;
      if(present){cursor(result.account_id,'accounts');
        if(!result.account_id||(subjectHousing?result.account_id!==options.scope.account_id
          :Buffer.compare(Buffer.from(result.account_id),Buffer.from(page.cursor))<=0)
          ||!count(result.geographic_parcel_count,2000000)||result.geographic_parcel_count==='0'
          ||BigInt(result.geographic_parcel_count)>BigInt(counts.parcels)||counts.accounts>1)fail('invalid_result');
      }else if(total!==0||result.geographic_parcel_count!==null)fail('invalid_result');
      if(subjectHousing&&!present)fail('subject_not_in_issued_stock');
      let rows;try{rows=JSON.parse(result.page_json);}catch{fail('invalid_result');}
      if(!Array.isArray(rows)||rows.length!==total)fail('invalid_result');
      let previous=null;const seen={parcels:0,accounts:0};
      rows=rows.map(value=>{const row=reconcile(value,recordedGroup),key=`${row.kind}\u0000${row.row_key}`;
        if(row.account_id!==result.account_id||previous!==null&&Buffer.compare(Buffer.from(key),Buffer.from(previous))<=0)fail('invalid_original');
        seen[row.kind]++;previous=key;return row;});
      if(!same(seen,counts))fail('invalid_result');
      const observations=present?resolveAccount(rows):null;
      const recordedHousing=housing&&present?resolveNeighborhoodOriginalAccountHousingV2(rows,check):null;
      const group=recordedGroup&&present?resolveNeighborhoodOriginalRecordedGroupV2(rows,check):null;
      if(Buffer.byteLength(JSON.stringify({rows,observations,...(housing?{recorded_housing:recordedHousing}:{}),
        ...(recordedGroup?{recorded_group:group}:{})}))>L.output_utf8_bytes)fail('byte_limit');
      await context.finish();
      return freeze({page_version:2,status:subjectHousing?'reconciled_exact_subject_original_housing'
        :recordedGroup&&housing?'reconciled_stock_account_recorded_group_and_housing'
        :recordedGroup?'reconciled_stock_account_recorded_group'
        :housing?'reconciled_stock_account_recorded_housing':'reconciled_stock_account_original_package',authority:'not_established',
        coverage:'one_complete_account_package_only',graph,stock,source_metadata:source,typed_profile:TYPED,
        package_profile:PACKAGE_PROFILE,effective_date:effective,cursor:page.cursor,account_id:result.account_id,
        geographic_parcel_count:result.geographic_parcel_count,original_counts:counts,rows,observations,
        ...(housing?{recorded_housing:recordedHousing}:{}),
        ...(recordedGroup?{recorded_group:group}:{}),
        account_original_state:present?counts.accounts===1?'present':'absent':'not_applicable',
        next_cursor:result.account_id??page.cursor,end_of_accounts:!present,
        original_reconciliation:'every_package_original_recompiled',selected_union:'not_established',
        source_acquisition:'not_established',report_update:'none'});
  }
  /** Both complete accounts share every original/transport/output/SQL bound.
   * This is source DATA only; actual issued owner chooses the next cursor and
   * independently fences the full native graph, intent and current authority. */
  async function subjectAndNextPackage(rawPage,rawSubject,firstSelected=false,nextEligibility=false,amenities=false,transactionPeriod=null){
    const page=prepareNeighborhoodStockAccountPackagePageV2(rawPage),{includeSubject}=data(rawSubject,['includeSubject']);
    if(typeof includeSubject!=='boolean')fail('invalid_input');
    const context=await open(),{stock,source}=context,cadContext=amenities?await openCad(stock):null,
      values=[stock.operation_id,stock.generation_id,TYPED.profile_ref.content_sha256,page.cursor,L.rows,L.page_utf8_bytes,
        L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes,includeSubject],
      result=one(await execute(transactionPeriod&&amenities?NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL
      :transactionPeriod?NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL:amenities?NEIGHBORHOOD_FIRST_SELECTED_AMENITY_ORIGINAL_PACKAGE_V2_SQL:nextEligibility
      ?NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_ELIGIBILITY_PACKAGE_V2_SQL:firstSelected
      ?NEIGHBORHOOD_STOCK_SUBJECT_AND_FIRST_SELECTED_PACKAGE_V2_SQL:NEIGHBORHOOD_STOCK_SUBJECT_AND_NEXT_PACKAGE_V2_SQL,
      amenities?[...values,CAD_TYPED.profile_ref.content_sha256]:values));
    const keys=['next_parcels','next_accounts','subject_parcels','subject_accounts',...(amenities?['cad_primary','cad_secondary']:[])];
    if(!keys.every(k=>Number.isInteger(result[k])&&result[k]>=0&&result[k]<=L.rows+1)
      ||!Number.isInteger(result.original_count)||result.original_count<0||result.original_count>(transactionPeriod?3*L.rows+(amenities?6:4):amenities?6:4)*(L.rows+1)
      ||!Number.isInteger(result.page_count)||result.page_count<0||result.invalid_count!==0
      ||typeof result.packet_oversize!=='boolean'||typeof result.page_json!=='string')fail('invalid_result');
    if(includeSubject&&result.subject_account_id===null)fail('subject_not_in_issued_stock');
    if(includeSubject?result.subject_account_id!==options.scope.account_id
      :result.subject_account_id!==null||result.subject_geographic_parcel_count!==null||result.subject_parcels!==0||result.subject_accounts!==0)fail('invalid_result');
    const nextCounts={parcels:result.next_parcels,accounts:result.next_accounts},subjectCounts={parcels:result.subject_parcels,accounts:result.subject_accounts},
      duplicated=includeSubject&&result.account_id===result.subject_account_id;
    if(duplicated&&!same(nextCounts,subjectCounts))fail('invalid_result');
    const total=nextCounts.parcels+nextCounts.accounts+(duplicated?0:subjectCounts.parcels+subjectCounts.accounts)
      +(amenities?result.cad_primary+result.cad_secondary:0)+(transactionPeriod?result.transaction_original_count:0);
    if(transactionPeriod){
      if(!['anchor_count','transaction_original_count','package_count'].every(k=>Number.isInteger(result[k])&&result[k]>=0)
        ||result.anchor_count>3*(L.rows+1)||result.package_count>L.rows||result.transaction_original_count>3*L.rows*(L.rows+1))fail('invalid_result');
      if(result.anchor_count>L.rows){if(result.page_count!==0||result.page_json!=='[]')fail('invalid_result');fail('account_package_row_limit');}
    }
    if(result.original_count!==total)fail('invalid_result');
    if(total>L.rows){if(result.page_count!==0||result.page_json!=='[]')fail('invalid_result');fail('account_package_row_limit');}
    if(result.packet_oversize)fail('account_package_byte_limit');
    if(result.page_count!==total||Buffer.byteLength(result.page_json)>L.page_utf8_bytes)fail('invalid_result');
    function member(id,geographic,counts,subject=false){
      if(id===null){if(geographic!==null||counts.parcels!==0||counts.accounts!==0)fail('invalid_result');return;}
      cursor(id,'accounts');
      if(!id||(subject?id!==options.scope.account_id:Buffer.compare(Buffer.from(id),Buffer.from(page.cursor))<=0)
        ||!count(geographic,2000000)||geographic==='0'||BigInt(geographic)>BigInt(counts.parcels)||counts.accounts>1
        ||counts.parcels>layers.parcels||counts.accounts>layers.accounts)fail('invalid_result');
    }
    member(result.account_id,result.geographic_parcel_count,nextCounts);
    member(result.subject_account_id,result.subject_geographic_parcel_count,subjectCounts,true);
    if(nextCounts.parcels+(duplicated?0:subjectCounts.parcels)>layers.parcels
      ||nextCounts.accounts+(duplicated?0:subjectCounts.accounts)>layers.accounts)fail('invalid_result');
    let encoded;try{encoded=JSON.parse(result.page_json);}catch{fail('invalid_result');}
    if(!Array.isArray(encoded)||encoded.length!==total)fail('invalid_result');
    let cadEvidence=null;
    if(amenities){
      if(result.cad_primary>Number(cadContext.source.layer_counts.primary.row_count)
        ||result.cad_secondary>Number(cadContext.source.layer_counts.secondary.row_count))fail('invalid_result');
      const cadRows=encoded.filter(r=>r?.kind==='primary'||r?.kind==='secondary');
      const cadPacket=reconcileNeighborhoodOriginalCadAccountPackageV2({account_id:result.account_id,
        geographic_parcel_count:result.geographic_parcel_count,counts:{primary:String(result.cad_primary),secondary:String(result.cad_secondary)},
        row_count:cadRows.length,invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(cadRows)},page,effective,check);
      const account=cadPacket.rows[0]??null;
      cadEvidence={original_counts:{primary:result.cad_primary,secondary:result.cad_secondary},source_metadata:cadContext.source,
        typed_profile:CAD_TYPED,account_id:account?.account_id??null,observations:account?.observations??null,
        amenity_evidence:account===null?null:resolveNeighborhoodOriginalCadAmenityEvidenceV2(account,check)};
      encoded=encoded.filter(r=>r?.kind!=='primary'&&r?.kind!=='secondary');
    }
    let transactions=null;
    if(transactionPeriod){
      const kinds=['source_records','sales','sale_links'],groups=new Map(),seen=new Set(),transactionRows=encoded.filter(r=>kinds.includes(r?.kind));
      let anchors=0;
      if(transactionRows.length!==result.transaction_original_count)fail('invalid_result');
      for(const row of transactionRows){
        check();const kind=row.source_record_id===null?'legacy_sale':'source_record',key=kind==='legacy_sale'?row.row_key:row.source_record_id;
        if(typeof key!=='string'||!/^[1-9][0-9]{0,18}$/.test(key)||BigInt(key)>9223372036854775807n
          ||kind==='legacy_sale'&&row.kind!=='sales')fail('invalid_original');
        const identity=`${row.kind}:${row.row_key}`,groupKey=`${kind}:${key}`;
        if(seen.has(identity))fail('invalid_original');seen.add(identity);
        if(!groups.has(groupKey))groups.set(groupKey,{kind,key,rows:[]});groups.get(groupKey).rows.push(row);
        if(row.account_id===result.account_id)anchors++;
      }
      if(groups.size!==result.package_count||anchors!==result.anchor_count)fail('invalid_result');
      const packages=[];
      for(const group of [...groups.values()].sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.key}`),Buffer.from(`${b.kind}:${b.key}`)))){
        group.rows.sort((a,b)=>Buffer.compare(Buffer.from(`${a.kind}:${a.row_key}`),Buffer.from(`${b.kind}:${b.row_key}`)));
        const counts=Object.fromEntries(kinds.map(k=>[k,String(group.rows.filter(r=>r.kind===k).length)])),page={kind:group.kind,cursor:''},
          reconciled=reconcileNeighborhoodOriginalTransactionPackageV2({package_key:group.key,counts,row_count:group.rows.length,
            invalid_count:0,packet_oversize:false,packet_json:JSON.stringify(group.rows),scan_count:1,scan_cursor:group.key},page,check),
          projected=projectNeighborhoodTransactionPackageV1(reconciled.packet,page,layers,effective,transactionPeriod).package;
        if(projected===null||!projected.rows.some(r=>r.stock_member===true&&r.projection.account_id===result.account_id))fail('invalid_original');
        packages.push(projected);check();
      }
      transactions={account_id:result.account_id,anchor_original_count:result.anchor_count,original_count:result.transaction_original_count,
        package_count:result.package_count,packages,retained_observation_period:transactionPeriod,
        coverage:'all_native_source_associations_and_source_less_sales_for_one_selected_account_only',
        economic_transaction_equivalence:'not_established',transaction_eligibility:'not_established',
        price_allocation:'not_established',complete_selected_union_transactions:false};
      encoded=encoded.filter(r=>!kinds.includes(r?.kind));
    }
    const accounts=new Map();let previous=null;
    for(const value of encoded){
      const row=reconcile(value,true),key=`${row.account_id}\u0000${row.kind}\u0000${row.row_key}`;
      if(![result.account_id,result.subject_account_id].includes(row.account_id)
        ||previous!==null&&Buffer.compare(Buffer.from(key),Buffer.from(previous))<=0)fail('invalid_original');
      if(!accounts.has(row.account_id))accounts.set(row.account_id,[]);accounts.get(row.account_id).push(row);previous=key;
    }
    function packageFor(id,geographic,counts){
      if(id===null)return null;const rows=accounts.get(id)??[],seen={parcels:0,accounts:0};
      rows.forEach(row=>seen[row.kind]++);if(!same(seen,counts))fail('invalid_result');
      return {account_id:id,geographic_parcel_count:geographic,original_counts:counts,rows,observations:resolveAccount(rows),
        recorded_housing:resolveNeighborhoodOriginalAccountHousingV2(rows,check),recorded_group:resolveNeighborhoodOriginalRecordedGroupV2(rows,check),
        account_original_state:counts.accounts===1?'present':'absent'};
    }
    const next=packageFor(result.account_id,result.geographic_parcel_count,nextCounts),
      subject=duplicated?next:packageFor(result.subject_account_id,result.subject_geographic_parcel_count,subjectCounts);
    // Charge the ENTIRE outgoing envelope; duplicated facts are marked as an
    // alias rather than serialized twice. Neither metadata nor the second
    // account receives a reset output allowance.
    const output={page_version:2,status:transactionPeriod&&amenities?'reconciled_subject_and_first_selected_combined_original_package'
      :transactionPeriod?'reconciled_subject_and_first_selected_stock_transaction_original_package'
      :amenities?'reconciled_subject_and_first_selected_stock_CAD_amenity_original_package'
      :nextEligibility?'reconciled_subject_and_next_eligibility_stock_original_package'
      :firstSelected?'reconciled_subject_and_first_selected_stock_original_package'
      :'reconciled_subject_and_next_stock_original_package',authority:'not_established',
      coverage:'at_most_two_complete_distinct_accounts_one_aggregate_budget',graph,stock,source_metadata:source,typed_profile:TYPED,
      package_profile:PACKAGE_PROFILE,effective_date:effective,cursor:page.cursor,account_id:result.account_id,
      next_cursor:result.account_id??page.cursor,end_of_accounts:result.account_id===null,next,subject:duplicated?null:subject,
      subject_included:includeSubject,subject_equals_next:duplicated,distinct_original_count:total,
      ...(amenities?{selected_CAD:cadEvidence}:{}),
      ...(transactionPeriod?{selected_transactions:transactions}:{}),
      original_reconciliation:'every_distinct_original_once_entire_neutral_cache',selected_union:'not_established',
      eligibility:'not_established',source_acquisition:'not_established',report_update:'none'};
    if(Buffer.byteLength(JSON.stringify(output))>L.output_utf8_bytes)fail('byte_limit');
    await context.finish();if(cadContext)await cadContext.finish();return freeze(output);
  }
  return Object.freeze({
    /** Reconcile one original-key prefix; a page end proves no earlier traversal. */
    async page(rawPage){
      const page=prepareNeighborhoodStockOriginalCellPageV2(rawPage),context=await open(),{stock,source}=context;
      const result=one(await execute(NEIGHBORHOOD_STOCK_ORIGINAL_CELLS_V2_PAGE_SQL,[stock.operation_id,stock.generation_id,
        TYPED.profile_ref.content_sha256,page.kind,page.cursor,page.rowLimit,L.page_utf8_bytes,L.row_utf8_bytes,L.original_utf8_bytes,L.output_utf8_bytes]));
      if(!Number.isInteger(result.page_count)||!Number.isInteger(result.candidate_count)||!Number.isInteger(result.scan_count)||result.page_count<0
        ||result.candidate_count<result.page_count||result.scan_count<result.candidate_count||result.scan_count>page.rowLimit||result.page_count>layers[page.kind]
        ||result.invalid_count!==0||result.oversized_count!==0||typeof result.page_json!=='string')fail('invalid_result');
      if(Buffer.byteLength(result.page_json)>L.page_utf8_bytes)fail('byte_limit');
      let rows;try{rows=JSON.parse(result.page_json);}catch{fail('invalid_result');}
      if(!Array.isArray(rows)||rows.length!==result.page_count||!rows.length&&result.candidate_count!==0)fail('invalid_result');
      let previous=page.cursor;
      rows=rows.map(value=>{
        const row=reconcile(value);
        if(row.kind!==page.kind||Buffer.compare(Buffer.from(row.row_key),Buffer.from(previous))<=0)fail('invalid_original');
        previous=row.row_key;return row;
      });
      if(result.scan_count===0){if(result.scan_cursor!==null)fail('invalid_result');}
      else{cursor(result.scan_cursor,page.kind);
        if(!result.scan_cursor||Buffer.compare(Buffer.from(result.scan_cursor),Buffer.from(page.cursor))<=0
          ||Buffer.compare(Buffer.from(result.scan_cursor),Buffer.from(previous))<0)fail('invalid_result');}
      const next=result.page_count===result.candidate_count?result.scan_cursor:rows.length?previous:null;
      if(result.next_cursor!==next)fail('invalid_result');
      if(Buffer.byteLength(JSON.stringify(rows))>L.output_utf8_bytes)fail('byte_limit');
      await context.finish();
      return freeze({page_version:2,status:'reconciled_stock_original_cells_page',authority:'not_established',coverage:'one_kind_page_only',
        graph,stock,source_metadata:source,typed_profile:TYPED,page_profile:PROFILE,effective_date:effective,
        kind:page.kind,cursor:page.cursor,rows,next_cursor:next??page.cursor,
        scanned_original_count:result.scan_count,scoped_candidate_count:result.candidate_count,
        end_of_kind:result.scan_count<page.rowLimit&&result.page_count===result.candidate_count,
        original_reconciliation:'every_delivered_original_recompiled',selected_union:'not_established',
        source_acquisition:'not_established',report_update:'none'});
    },
    /** All retained originals for ONE server-picked account, or complete refusal. */
    accountPackage:rawPage=>accountPackage(rawPage,false),
    /** Distinct dormant bounded consumer; legacy package bytes stay unchanged. */
    housingAccountPackage:rawPage=>accountPackage(rawPage,true),
    /** Original512-byte county/labels after whole original/ENTIRE cache replay;
     * distinct dormant consumer, not a complete catalog/selected partition. */
    recordedGroupAccountPackage:rawPage=>accountPackage(rawPage,false,true),
    /** One original packet supplies housing, full recorded labels and all
     * retained-date metric cells together; never a second reader/budget. The
     * original single-purpose consumers above retain their exact shapes. */
    recordedGroupAndHousingAccountPackage:rawPage=>accountPackage(rawPage,true,true),
    /** Exact native job subject only; absent stock refuses, never substitutes
     * the first member. No caller account, cursor, reader or reset budget. */
    subjectHousingAccountPackage(...args){if(args.length)fail('invalid_input');return accountPackage(null,true,false,true);},
    /** Actual owner resolves preferred subject first; only absence requests
     * native subject CAD. No second child reader or reset aggregate budget. */
    subjectAndRecordedGroupHousingAccountPackage(...args){if(args.length!==2)fail('invalid_input');return subjectAndNextPackage(...args);},
    /** Fixed ordinal1 only; no source account, ordinal, cursor or callback input.
     * Actual owner MUST also replay the complete union/partition/catalog and
     * immutable intent/current authorization. This reader issues no progress. */
    subjectAndFirstSelectedRecordedGroupHousingAccountPackage(...args){
      if(args.length!==1)fail('invalid_input');return subjectAndNextPackage({cursor:''},args[0],true);
    },
    subjectAndNextEligibilityRecordedGroupHousingAccountPackage(...args){
      if(args.length!==1)fail('invalid_input');return subjectAndNextPackage({cursor:''},args[0],false,true);
    },
    /** Fixed selected ordinal1 plus its ENTIRE primary/secondary originals.
     * Required subject fallback is deduplicated in the SAME aggregate packet. */
    subjectAndFirstSelectedAmenityAccountPackage(...args){
      if(args.length!==1)fail('invalid_input');return subjectAndNextPackage({cursor:''},args[0],true,false,true);
    },
    /** Exact native selected account chooses all associated source IDs; whole
     * all-date source packages and legacy originals share the SAME stock cap.
     * Dates are actual-owner retained input, never a source filter or cursor. */
    async subjectAndFirstSelectedTransactionAccountPackage(...args){
      if(args.length!==2)fail('invalid_input');
      const period=prepareNeighborhoodTransactionRetainedPeriodV1(args[1],effective);
      return subjectAndNextPackage({cursor:''},args[0],true,false,false,period);
    },
    /** No composition of separate readers: stock/subject/CAD/whole transaction
     * packages share ONE250 original admission and the SAME single-use child.
     * Actual owner supplies retained dates and separate both-end CAD rights. */
    async subjectAndFirstSelectedCombinedAccountPackage(...args){
      if(args.length!==2)fail('invalid_input');
      const period=prepareNeighborhoodTransactionRetainedPeriodV1(args[1],effective);
      return subjectAndNextPackage({cursor:''},args[0],true,false,true,period);
    },
  });
}
