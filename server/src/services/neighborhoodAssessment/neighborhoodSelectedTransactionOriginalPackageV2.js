// Fixed actual DONE-union ordinal1. The actual owner must independently reopen
// the full original graph, native partition/catalog/intent and both-end rights.
// Three indexed ORIGINAL account prefixes find native source IDs without dates
// or cached membership. Each whole source package includes outside/unresolved
// rows; source-less sales retain their own native ID. All required stock and
// transaction originals share ONE250 cap BEFORE any payload materialization.
function sql(withCad,nextEvidence=false){
  const admission=`(SELECT count(*) FROM anchors)<=$5::integer AND (SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer
      AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account))`;
  const encodingAdmission=`${admission} AND NOT (SELECT oversize FROM raw_gate)`;
  const evidenceJoins=nextEvidence?`
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
    AND evidence_body.canonical_utf8_bytes::text=evidence.receipt_reference->>'canonical_utf8_bytes' AND evidence_body.canonical_utf8_bytes<=16000`:'';
  const evidenceAdmission=nextEvidence?`
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
    AND ((evidence.operation_id IS NULL
        AND app.neighborhood_selected_eligibility_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint))
      OR (evidence.command_id=command.command_id AND evidence.union_reference=head.receipt_reference
        AND evidence.eligibility_reference=fifth.receipt_reference
        AND app.neighborhood_selected_evidence_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
        AND evidence_body.canonical_utf8::jsonb->>'format'='cohort_selected_evidence_receipt_v2'
        AND evidence_body.canonical_utf8::jsonb->>'sequence'=evidence.sequence::text
        AND evidence_body.canonical_utf8::jsonb->'after'->>'done'='false'))`:'';
  return `/* neighborhood-${nextEvidence?'next-selected-combined-evidence':`first-selected-${withCad?'combined-evidence':'transaction'}`}-original-package-v2 */
WITH next_account AS MATERIALIZED (
  SELECT a.account_id,a.parcel_count FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads head USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=head.organization_id
    AND body.content_sha256=head.receipt_reference->>'content_sha256'
    AND body.canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=16000${evidenceJoins}
  JOIN app.neighborhood_custom_cohort_selected_union_v2_rows r
    ON r.operation_id=job.operation_id AND r.organization_id=job.organization_id
  JOIN app.neighborhood_custom_cohort_stock_accounts a ON a.operation_id=r.operation_id AND a.account_id=r.account_id
  WHERE job.operation_id=$1::uuid AND r.ordinal=${nextEvidence?'coalesce(evidence.sequence,0)+1':'1'} AND $4::text=''
    ${nextEvidence?evidenceAdmission.trim(): 'AND app.neighborhood_selected_union_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)'}
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
