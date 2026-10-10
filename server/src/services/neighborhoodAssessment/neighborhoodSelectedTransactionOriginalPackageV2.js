// Fixed actual DONE-union ordinal1. The actual owner must independently reopen
// the full original graph, native partition/catalog/intent and both-end rights.
// Three indexed ORIGINAL account prefixes find native source IDs without dates
// or cached membership. Each whole source package includes outside/unresolved
// rows; source-less sales retain their own native ID. All required stock and
// transaction originals share ONE250 cap BEFORE any payload materialization.
export const NEIGHBORHOOD_FIRST_SELECTED_TRANSACTION_ORIGINAL_PACKAGE_V2_SQL=`/* neighborhood-first-selected-transaction-original-package-v2 */
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
), all_totals AS MATERIALIZED (
  SELECT n FROM stock_totals UNION ALL SELECT n FROM transaction_totals
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
      AND (SELECT count(*) FROM anchors)<=$5::integer AND (SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer
      AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account)) OFFSET 0) o
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
      AND (SELECT count(*) FROM anchors)<=$5::integer AND (SELECT coalesce(sum(n),0) FROM all_totals)<=$5::integer
      AND (NOT $10::boolean OR EXISTS(SELECT 1 FROM subject_account)) OFFSET 0) o
  LEFT JOIN LATERAL (SELECT t.row_key,t.account_id,t.source_record_id,t.original_payload_sha256,t.typed FROM app.neighborhood_frozen_typed_v2_rows t
    WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind=o.kind AND t.row_key=o.row_key OFFSET 0) t ON true
), sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT account_id FROM next_account) AS account_id,(SELECT parcel_count::text FROM next_account) AS geographic_parcel_count,
  (SELECT account_id FROM subject_account) AS subject_account_id,(SELECT parcel_count::text FROM subject_account) AS subject_geographic_parcel_count,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='parcels'),0) AS next_parcels,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM next_account) AND kind='accounts'),0) AS next_accounts,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='parcels'),0) AS subject_parcels,
  coalesce((SELECT n FROM stock_totals WHERE account_id=(SELECT account_id FROM subject_account) AND kind='accounts'),0) AS subject_accounts,
  (SELECT count(*)::integer FROM anchors) AS anchor_count,
  coalesce((SELECT sum(n)::integer FROM transaction_totals),0) AS transaction_original_count,
  (SELECT count(*)::integer FROM packages) AS package_count,
  coalesce((SELECT sum(n)::integer FROM all_totals),0) AS original_count,count(*)::integer AS page_count,
  coalesce(sum(CASE WHEN invalid THEN 1 ELSE 0 END),0)::integer AS invalid_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(max(original_bytes),0)>$8::integer
    OR coalesce(sum(bytes+1),0)+2>$6::integer OR coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2>$9::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(max(original_bytes),0)<=$8::integer
    AND coalesce(sum(bytes+1),0)+2<=$6::integer AND coalesce(sum(2*coalesce(typed_bytes,0)+1024),0)+2<=$9::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY account_id COLLATE "C",kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS page_json
FROM sized`;
