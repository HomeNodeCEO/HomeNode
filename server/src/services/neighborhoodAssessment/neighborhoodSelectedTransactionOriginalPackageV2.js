import { COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL } from './completedIndexFirstSourceV3Sql.js';

// Fixed actual DONE-union ordinal1. The actual owner must independently reopen
// the full original graph, native partition/catalog/intent and both-end rights.
// Three indexed ORIGINAL account prefixes find native source IDs without dates
// or cached membership. Each whole source package includes outside/unresolved
// rows; source-less sales retain their own native ID. All required stock and
// transaction originals share ONE250 cap BEFORE any payload materialization.
function sql(withCad,nextEvidence=false,completedEvidence=false,nextMetrics=false,completedMetrics=false){
  const admission=`(SELECT count(*) FROM anchors)<=$5::integer AND (SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer
      AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account))`;
  const encodingAdmission=`${admission} AND NOT (SELECT oversize FROM raw_gate)`;
  const evidenceJoins=nextEvidence||completedEvidence||nextMetrics||completedMetrics?`
  JOIN app.neighborhood_custom_cohort_v2_selection_intents command ON command.operation_id=job.operation_id
    AND command.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_selected_eligibility_v2_heads fifth ON fifth.operation_id=job.operation_id
    AND fifth.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs fifth_body ON fifth_body.organization_id=fifth.organization_id
    AND fifth_body.content_sha256=fifth.receipt_reference->>'content_sha256'
    AND fifth_body.canonical_utf8_bytes::text=fifth.receipt_reference->>'canonical_utf8_bytes' AND fifth_body.canonical_utf8_bytes<=16000
  LEFT JOIN app.neighborhood_custom_cohort_selected_evidence_v2_heads evidence ON evidence.operation_id=job.operation_id
    AND evidence.organization_id=job.organization_id
  LEFT JOIN app.neighborhood_cohort_evidence_blobs evidence_body ON evidence_body.organization_id=evidence.organization_id
    AND evidence_body.content_sha256=evidence.receipt_reference->>'content_sha256'
    AND evidence_body.canonical_utf8_bytes::text=evidence.receipt_reference->>'canonical_utf8_bytes' AND evidence_body.canonical_utf8_bytes<=16000${nextMetrics||completedMetrics?`
  LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads metrics ON metrics.operation_id=job.operation_id AND metrics.organization_id=job.organization_id
  LEFT JOIN app.neighborhood_cohort_evidence_blobs metrics_body ON metrics_body.organization_id=metrics.organization_id
    AND metrics_body.content_sha256=metrics.receipt_reference->>'content_sha256'
    AND metrics_body.canonical_utf8_bytes::text=metrics.receipt_reference->>'canonical_utf8_bytes' AND metrics_body.canonical_utf8_bytes<=16000`:''}`:'';
  const evidenceAdmission=nextEvidence||completedEvidence||nextMetrics||completedMetrics?`
    AND job.status='running' AND job.claim_token IS NOT NULL AND job.lease_expires_at>clock_timestamp()
    AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
    AND head.command_id=command.command_id AND fifth.command_id=command.command_id
    AND fifth.union_reference=head.receipt_reference
    AND body.canonical_utf8::jsonb->>'sequence'=head.sequence::text
    AND fifth_body.canonical_utf8::jsonb->>'format'='cohort_selected_recorded_eligibility_receipt_v2'
    AND fifth_body.canonical_utf8::jsonb->>'sequence'=fifth.sequence::text
    AND fifth_body.canonical_utf8::jsonb->'after'->>'done'='true'
    AND fifth_body.canonical_utf8::jsonb->'selected_stock_count'=body.canonical_utf8::jsonb->'after_selected_count'
    AND fifth_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'
    AND ${completedEvidence||nextMetrics||completedMetrics?`(evidence.command_id=command.command_id AND evidence.union_reference=head.receipt_reference
        AND evidence.eligibility_reference=fifth.receipt_reference
        AND ${completedMetrics?`(metrics.command_id=command.command_id AND metrics.union_reference=head.receipt_reference
          AND metrics.eligibility_reference=fifth.receipt_reference AND metrics.evidence_reference=evidence.receipt_reference
          AND app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
          AND metrics_body.canonical_utf8::jsonb->>'sequence'=metrics.sequence::text
          AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND metrics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'
          AND metrics_body.canonical_utf8::jsonb->'selected_stock_count'=body.canonical_utf8::jsonb->'after_selected_count')`:nextMetrics?`((metrics.operation_id IS NULL
          AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
          OR (metrics.command_id=command.command_id AND metrics.union_reference=head.receipt_reference
            AND metrics.eligibility_reference=fifth.receipt_reference AND metrics.evidence_reference=evidence.receipt_reference
            AND app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
            AND metrics_body.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
            AND metrics_body.canonical_utf8::jsonb->>'sequence'=metrics.sequence::text
            AND metrics_body.canonical_utf8::jsonb->'after'->>'done'='false'))`:
          'app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)'}
        AND evidence_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
        AND evidence_body.canonical_utf8::jsonb->>'sequence'=evidence.sequence::text
        AND evidence_body.canonical_utf8::jsonb->'after'->>'done'='true'
        AND evidence_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'
        AND evidence_body.canonical_utf8::jsonb->'selected_stock_count'=body.canonical_utf8::jsonb->'after_selected_count')`:`((evidence.operation_id IS NULL
        AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
      OR (evidence.command_id=command.command_id AND evidence.union_reference=head.receipt_reference
        AND evidence.eligibility_reference=fifth.receipt_reference
        AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
        AND evidence_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
        AND evidence_body.canonical_utf8::jsonb->>'sequence'=evidence.sequence::text
        AND evidence_body.canonical_utf8::jsonb->'after'->>'done'='false'))`}`:'';
  return `/* neighborhood-${completedMetrics?'first-selected-statistics':nextMetrics?'next-selected-metric':completedEvidence?'first-selected-metric':nextEvidence?'next-selected-combined-evidence':`first-selected-${withCad?'combined-evidence':'transaction'}`}-original-package-v2 */
WITH next_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=head.organization_id
    AND body.content_sha256=head.receipt_reference->>'content_sha256'
    AND body.canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=16000${evidenceJoins}
  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r
    ON r.operation_id=job.operation_id AND r.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id
  WHERE job.operation_id=$1::uuid AND r.ordinal=${nextMetrics?'coalesce(metrics.sequence,0)+1':nextEvidence?'coalesce(evidence.sequence,0)+1':'1'} AND $4::text=''
    ${nextEvidence||completedEvidence||nextMetrics||completedMetrics?evidenceAdmission.trim(): 'AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)'}
    AND body.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
    AND body.canonical_utf8::jsonb->'after'->>'done'='true'
), subject_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_stock_accounts a USING(operation_id)
  WHERE job.operation_id=$1::uuid AND a.account_id=job.account_id AND $10::boolean
), chosen AS MATERIALIZED (
  SELECT * FROM next_account UNION SELECT * FROM subject_account
), anchors AS MATERIALIZED (
  SELECT o.kind,o.row_key,o.source_record_id FROM next_account a
  CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.source_record_id FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
    ORDER BY o.row_key COLLATE "C" LIMIT ($5::integer+1)) o
), packages AS MATERIALIZED (
  SELECT 'source_record'::text AS package_kind,source_record_id::text AS package_key
    FROM anchors WHERE source_record_id IS NOT NULL AND (SELECT count(*) FROM anchors)<=$5::integer GROUP BY source_record_id
  UNION ALL
  SELECT 'legacy_sale',row_key FROM anchors WHERE kind='sales' AND source_record_id IS NULL
    AND (SELECT count(*) FROM anchors)<=$5::integer
), stock_totals AS MATERIALIZED (
  SELECT a.account_id,k.kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
    LIMIT ($5::integer+1)) bounded) AS n FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
), transaction_totals AS MATERIALIZED (
  SELECT p.package_kind,p.package_key,k.kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind
      AND (p.package_kind='source_record' AND o.source_record_id=p.package_key::bigint
        OR p.package_kind='legacy_sale' AND o.kind='sales' AND o.source_record_id IS NULL AND o.row_key=p.package_key)
    LIMIT ($5::integer+1)) bounded) AS n FROM packages p CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
)${withCad?`, cad_totals AS MATERIALIZED (
  SELECT a.account_id,k.kind,(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
    LIMIT ($5::integer+1)) bounded) AS n FROM next_account a CROSS JOIN (VALUES ('primary'),('secondary')) k(kind)
)`:''}, all_totals AS MATERIALIZED (
  SELECT n FROM stock_totals UNION ALL SELECT n FROM transaction_totals${withCad?' UNION ALL SELECT n FROM cad_totals':''}
), raw_sizes AS MATERIALIZED (
  -- Retain only byte lengths, never raw payload strings or encoded envelopes.
  -- All source families share the SAME count/byte admission before encoding.
  SELECT octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND ${admission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
  UNION ALL
  SELECT octet_length(o.payload::text),octet_length(t.typed::text)
  FROM packages p CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind
      AND (p.package_kind='source_record' AND o.source_record_id=p.package_key::bigint
        OR p.package_kind='legacy_sale' AND o.kind='sales' AND o.source_record_id IS NULL AND o.row_key=p.package_key)
      AND ${admission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
${withCad?`  UNION ALL
  SELECT octet_length(o.payload::text),octet_length(t.typed::text)
  FROM next_account a CROSS JOIN (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.payload FROM app.neighborhood_frozen_cad_improvement_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND ${admission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.typed FROM app.neighborhood_frozen_typed_cad_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$11 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
`:''}), raw_gate AS MATERIALIZED (
  SELECT coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(max(original_bytes::bigint+coalesce(typed_bytes,0)),0)>$7::integer
    OR coalesce(sum(original_bytes::bigint+coalesce(typed_bytes,0)+1),0)+2>$6::integer
    OR coalesce(sum(2::bigint*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS oversize
  FROM raw_sizes
), members AS MATERIALIZED (
  SELECT o.kind,o.row_key,o.account_id,NULL::text AS package_kind,NULL::text AS package_key,
    t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text) AS original_bytes,octet_length(t.typed::text) AS typed_bytes,
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text AS encoded
  FROM chosen a CROSS JOIN (VALUES ('parcels'),('accounts')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND ${encodingAdmission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
  UNION ALL
  SELECT o.kind,o.row_key,o.account_id,p.package_kind,p.package_key,
    t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id OR t.source_record_id IS DISTINCT FROM o.source_record_id AS invalid,
    octet_length(o.payload::text),octet_length(t.typed::text),
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,
      'source_record_id',o.source_record_id::text,'original_text',o.payload::text,
      'cached_account_id',t.account_id,'cached_source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed,
      'stock_member',CASE WHEN o.account_id IS NULL THEN NULL ELSE EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts a
        WHERE a.operation_id=$1::uuid AND a.account_id=o.account_id) END)::text
  FROM packages p CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.source_record_id,o.payload FROM app.neighborhood_frozen_source_rows o
    WHERE o.generation_id=$2::uuid AND o.kind=k.kind
      AND (p.package_kind='source_record' AND o.source_record_id=p.package_key::bigint
        OR p.package_kind='legacy_sale' AND o.kind='sales' AND o.source_record_id IS NULL AND o.row_key=p.package_key)
      AND ${encodingAdmission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
${withCad?`  UNION ALL
  SELECT o.kind,o.row_key,o.account_id,NULL::text,NULL::text,
    t.row_key IS NULL OR t.account_id IS DISTINCT FROM o.account_id AS invalid,
    octet_length(o.payload::text),octet_length(t.typed::text),
    jsonb_build_object('kind',o.kind,'row_key',o.row_key,'account_id',o.account_id,'original_text',o.payload::text,
      'payload_sha256',o.payload_sha256,'payload_utf8_bytes',o.payload_utf8_bytes::text,
      'cached_account_id',t.account_id,'original_payload_sha256',t.original_payload_sha256,'typed',t.typed)::text
  FROM next_account a CROSS JOIN (VALUES ('primary'),('secondary')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.account_id,o.payload,o.payload_sha256,o.payload_utf8_bytes
    FROM app.neighborhood_frozen_cad_improvement_rows o WHERE o.generation_id=$2::uuid AND o.kind=k.kind AND o.account_id=a.account_id
      AND ${encodingAdmission} OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.original_payload_sha256,t.typed
    FROM app.neighborhood_frozen_typed_cad_rows t WHERE t.generation_id=$2::uuid AND t.profile_sha256=$11
      AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
`:''}), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM next_account) AS account_id,(SELECT parcel_count::text FROM next_account) AS geographic_parcel_count,
  (SELECT account_id FROM subject_account) AS subject_account_id,(SELECT parcel_count::text FROM subject_account) AS subject_geographic_parcel_count,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='parcels'),0) AS next_parcels,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='accounts'),0) AS next_accounts,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='parcels'),0) AS subject_parcels,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='accounts'),0) AS subject_accounts,
${withCad?`  coalesce((SELECT n FROM cad_totals WHERE kind='primary'),0) AS cad_primary,
  coalesce((SELECT n FROM cad_totals WHERE kind='secondary'),0) AS cad_secondary,
`:''}  (SELECT count(*)::integer FROM anchors) AS anchor_count,
  coalesce((SELECT sum(n)::integer FROM transaction_totals),0) AS transaction_original_count,
  (SELECT count(*)::integer FROM packages) AS package_count,
  coalesce((SELECT sum(n)::integer FROM all_totals),0) AS original_count,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  (SELECT oversize FROM raw_gate) OR coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN NOT (SELECT oversize FROM raw_gate) AND coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY account_id COLLATE "C",kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`;}
export const NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL=sql(false);
// Distinct fixed plan, never caller-selected SQL: selected CAD and whole source
// associations join the SAME original admission before any payload read. The
// actual owner must additionally authorize/fence the separate CAD purpose.
export const NEIGHBORHOOD_FIRST_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL=sql(true);
// Sixth-pass candidate plan ONLY. Not mounted or used by an owner yet: the new
// exact native head/checkpoint migration, separate current-authorized admission,
// original reconciliation, atomic head/receipt/continuation and cloud-native
// coverage must be implemented before any runtime use or acceptance claim.
// Existing first-selected SQL remains byte-for-byte unchanged.
export const NEIGHBORHOOD_NEXT_SELECTED_COMBINED_ORIGINAL_PACKAGE_V2_SQL=sql(true,true);
// Read-only metric-source reopening, fixed native ordinal1 AFTER all three
// parents are DONE. The owner still replays the complete original graph and
// every required original/ENTIRE cache; the sixth acknowledgement supplies
// no numerical cells or membership authority. No distribution is established.
export const NEIGHBORHOOD_FIRST_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL=sql(true,false,true);

// Seventh-pass native next ordinal only; full original/ENTIRE-cache/current-rights
// owner remains mandatory. Existing first/sixth plan strings are unchanged.
export const NEIGHBORHOOD_NEXT_SELECTED_METRIC_ORIGINAL_PACKAGE_V2_SQL=sql(true,false,false,true);

// Separate read-only statistics-source boundary AFTER actual DONE seventh.
// Fixed ordinal1, not a statistic/frequency/roster or caller ordinal adapter.
// The actual owner must reconcile the native seventh row field-by-field to
// THIS call's complete originals and pass every ending fence before returning.
export const NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL=sql(true,false,false,false,true);

// Additive native eighth next-ordinal plan. Derive only from the fixed SQL
// constant (never a caller string, ordinal or callback); all old six plans stay
// byte-for-byte unchanged. Admission recursively requires the DONE seventh and
// exact13 initial/exact14 native head. Whole originals/ENTIRE caches and the
// shared aggregate bounds remain mandatory inside the actual original owner.
export const NEIGHBORHOOD_NEXT_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-selected-statistics-original-package-v2','neighborhood-next-selected-statistics-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r',`  LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads statistics
    ON statistics.operation_id=job.operation_id AND statistics.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r`)
    .replace('r.ordinal=1 AND $4::text=', 'r.ordinal=coalesce(statistics.sequence,0)+1 AND $4::text=')
    .replace('app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      'app.neighborhood_selected_statistics_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)');

// Distinct fixed-first frequency-source boundary, NOT numerical frequency
// authority. All five actual native parents must be DONE with exact14 roots.
// The owner independently replays complete originals/ENTIRE caches and compares
// EVERY seventh metric and eighth contribution field. Older seven plans remain
// byte-identical. No caller ordinal, source callback, roster or count adapter.
export const NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_SELECTED_STATISTICS_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-selected-statistics-original-package-v2','neighborhood-first-selected-frequency-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r',`  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads statistics
    ON statistics.operation_id=job.operation_id AND statistics.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs statistics_body ON statistics_body.organization_id=statistics.organization_id
    AND statistics_body.content_sha256=statistics.receipt_reference->>'content_sha256'
    AND statistics_body.canonical_utf8_bytes::text=statistics.receipt_reference->>'canonical_utf8_bytes' AND statistics_body.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r`)
    .replace('app.neighborhood_selected_metrics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      `app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND statistics.command_id=command.command_id AND statistics.union_reference=head.receipt_reference
          AND statistics.eligibility_reference=fifth.receipt_reference AND statistics.evidence_reference=evidence.receipt_reference
          AND statistics.metrics_reference=metrics.receipt_reference
          AND statistics_body.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
          AND statistics_body.canonical_utf8::jsonb->>'sequence'=statistics.sequence::text
          AND statistics_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND statistics_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'
          AND statistics_body.canonical_utf8::jsonb->'selected_stock_count'=body.canonical_utf8::jsonb->'after_selected_count'`);

// Ninth native ordinal plan, separate from the unchanged strict14 fixed-first
// reader. No caller ordinal or free roster; the actual owner reopens COMPLETE
// originals/ENTIRE caches and compares every seventh/eighth/index cell afresh.
export const NEIGHBORHOOD_NEXT_SELECTED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-selected-frequency-original-package-v2','neighborhood-next-selected-numeric-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r',`  LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads numeric_population
    ON numeric_population.operation_id=job.operation_id AND numeric_population.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r`)
    .replace('r.ordinal=1 AND $4::text=', 'r.ordinal=coalesce(numeric_population.sequence,0)+1 AND $4::text=')
    .replace('app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      'app.neighborhood_selected_numeric_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)');

// Separate fixed-FIRST original reopening AFTER the ninth's fresh EMPTY.
// This is a source seam for provisional native rank candidates, NOT a complete
// semantic statistics pass. No caller ordinal or widening of any old reader.
export const NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_SELECTED_FREQUENCY_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-selected-frequency-original-package-v2','neighborhood-first-completed-numeric-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r',`  JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads numeric_population
    ON numeric_population.operation_id=job.operation_id AND numeric_population.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs numeric_body ON numeric_body.organization_id=numeric_population.organization_id
    AND numeric_body.content_sha256=numeric_population.receipt_reference->>'content_sha256'
    AND numeric_body.canonical_utf8_bytes::text=numeric_population.receipt_reference->>'canonical_utf8_bytes' AND numeric_body.canonical_utf8_bytes<=4096
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r`)
    .replace('app.neighborhood_selected_statistics_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      `app.neighborhood_selected_numeric_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND numeric_population.command_id=command.command_id AND numeric_population.statistics_reference=statistics.receipt_reference
          AND numeric_body.canonical_utf8::jsonb->>'format'='cohort_selected_numeric_receipt_v2'
          AND numeric_body.canonical_utf8::jsonb->>'sequence'=numeric_population.sequence::text
          AND numeric_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND numeric_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'`);

// Tenth pass: ONLY its own native head determines the next account. The ninth
// is an immutable DONE parent, never the cursor and never current authority.
// No caller ordinal/roster/callback or weakening of the shared original plan.
export const NEIGHBORHOOD_NEXT_SELECTED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-completed-numeric-original-package-v2','neighborhood-next-selected-semantic-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r',`  LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads semantic
    ON semantic.operation_id=job.operation_id AND semantic.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r`)
    .replace('r.ordinal=1 AND $4::text=', 'r.ordinal=coalesce(semantic.sequence,0)+1 AND $4::text=')
    .replace('app.neighborhood_selected_numeric_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      'app.neighborhood_selected_semantic_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)');

// Read-only transaction-source boundary AFTER the actual tenth fresh EMPTY.
// Old plans stay byte-identical. Native selected membership is DISTINCT from
// stock_member; neither a linked account nor the subject becomes selected.
// The same aggregate original/raw-byte gates run BEFORE encoding these flags.
export const NEIGHBORHOOD_FIRST_COMPLETED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL=
  NEIGHBORHOOD_FIRST_COMPLETED_NUMERIC_ORIGINAL_PACKAGE_V2_SQL
    .replace('neighborhood-first-completed-numeric-original-package-v2','neighborhood-first-completed-semantic-original-package-v2')
    .replace('  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r',`  JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads semantic
    ON semantic.operation_id=job.operation_id AND semantic.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs semantic_body ON semantic_body.organization_id=semantic.organization_id
    AND semantic_body.content_sha256=semantic.receipt_reference->>'content_sha256'
    AND semantic_body.canonical_utf8_bytes::text=semantic.receipt_reference->>'canonical_utf8_bytes' AND semantic_body.canonical_utf8_bytes<=4096
  JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows r`)
    .replace('app.neighborhood_selected_numeric_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
      `app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
          AND semantic.command_id=command.command_id AND semantic.union_reference=head.receipt_reference
          AND semantic.eligibility_reference=fifth.receipt_reference AND semantic.evidence_reference=evidence.receipt_reference
          AND semantic.metrics_reference=metrics.receipt_reference AND semantic.statistics_reference=statistics.receipt_reference
          AND semantic.numeric_reference=numeric_population.receipt_reference
          AND semantic_body.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
          AND semantic_body.canonical_utf8::jsonb->>'sequence'=semantic.sequence::text
          AND semantic_body.canonical_utf8::jsonb->'after'->>'done'='true'
          AND semantic_body.canonical_utf8::jsonb->'after'->'selected_ordinal'=body.canonical_utf8::jsonb->'after_selected_count'`)
    .replace("'stock_member',CASE WHEN o.account_id IS NULL",`'selected_union_member',CASE WHEN o.account_id IS NULL THEN NULL ELSE EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_selected_union_v2_rows selected
        WHERE selected.operation_id=$1::uuid AND selected.account_id=o.account_id) END,
      'stock_member',CASE WHEN o.account_id IS NULL`)
    .replace('  (SELECT count(*)::integer FROM anchors) AS anchor_count,',`  EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_capture_jobs job
    JOIN app.neighborhood_custom_cohort_selected_union_v2_rows selected ON selected.operation_id=job.operation_id
      AND selected.organization_id=job.organization_id AND selected.account_id=job.account_id
    WHERE job.operation_id=$1::uuid) AS subject_selected_union_member,
  (SELECT count(*)::integer FROM anchors) AS anchor_count,`);

// UNREGISTERED eleventh-owner source seam. Its own native NEXT function, not
// the DONE semantic sequence or a caller ordinal, selects the account. Even a
// previously indexed shared source is reopened in FULL for the next account.
// The owner must separately compare the independently read native plan and
// every prior original-derived field, then repeat ALL ending authority fences.
// No index/job/continuation write or source right is established by this SQL.
function transactionIndexOriginalPackageSql(completedFirst=false){
  let result=NEIGHBORHOOD_FIRST_COMPLETED_SEMANTIC_ORIGINAL_PACKAGE_V2_SQL;
  // Fail closed if an inherited fixed fragment moves or becomes ambiguous;
  // these are module-owned literals, never caller strings or SQL callbacks.
  const replace=(from,to)=>{
    if(result.indexOf(from)<0||result.indexOf(from)!==result.lastIndexOf(from))
      throw new TypeError('neighborhood_selected_transaction_index_original_sql_shape');
    result=result.replace(from,to);
  };
  replace('neighborhood-first-completed-semantic-original-package-v2',completedFirst
    ?'neighborhood-first-completed-index-source-original-package-v3':'neighborhood-next-selected-transaction-index-original-package-v2');
  replace('WITH next_account AS MATERIALIZED (',completedFirst?`WITH transaction_index_context AS MATERIALIZED (
${COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL}
), next_account AS MATERIALIZED (`:`WITH transaction_index_context AS MATERIALIZED (
  SELECT DISTINCT k.generation_id,k.account_id,k.ordinal,k.partition_ordinal,
    k.entry_reference,k.metric_row_reference,k.contribution_row_reference
  FROM app.neighborhood_custom_cohort_capture_jobs job
  CROSS JOIN LATERAL app.neighborhood_selected_transaction_index_v2_next_keys(job.operation_id,job.organization_id) k
  WHERE job.operation_id=$1::uuid AND k.generation_id=$2::uuid
), next_account AS MATERIALIZED (`);
  replace('  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id',
    `  JOIN transaction_index_context index_next ON index_next.account_id=r.account_id AND index_next.ordinal=r.ordinal
    AND index_next.partition_ordinal=r.partition_ordinal AND index_next.entry_reference=r.entry_reference
    AND index_next.metric_row_reference=r.metric_row_reference AND index_next.contribution_row_reference=r.row_reference
  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id`);
  replace('r.ordinal=1 AND $4::text=',"r.ordinal=index_next.ordinal AND $4::text=");
  replace('app.neighborhood_selected_semantic_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)',
    completedFirst?'app.neighborhood_selected_transaction_index_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)'
      :'app.neighborhood_selected_transaction_index_v2_admission_matches(job.operation_id,job.organization_id,job.checkpoint)');
  replace('WHERE job.operation_id=$1::uuid AND a.account_id=job.account_id AND $10::boolean',
    `WHERE job.operation_id=$1::uuid AND a.account_id=job.account_id AND $10::boolean
    AND EXISTS(SELECT 1 FROM transaction_index_context)`);
  replace('SELECT (SELECT account_id FROM next_account) AS account_id,',
    `SELECT (SELECT count(*)=1 FROM transaction_index_context) AS transaction_index_context_present,
  (SELECT account_id FROM transaction_index_context) AS transaction_index_account_id,
  (SELECT account_id FROM next_account) AS account_id,`);
  return result;
}
export const NEIGHBORHOOD_NEXT_SELECTED_TRANSACTION_INDEX_ORIGINAL_PACKAGE_V2_SQL=transactionIndexOriginalPackageSql();
export const NEIGHBORHOOD_FIRST_COMPLETED_INDEX_SOURCE_ORIGINAL_PACKAGE_V3_SQL=transactionIndexOriginalPackageSql(true);
