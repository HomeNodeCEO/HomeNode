// Fixed native FIRST, shared by two independent reads in one bounded owner
// transaction. No caller account, ordinal, source key or progress cursor.
// The completed index is metadata, never current source-purpose authority.
export const COMPLETED_INDEX_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT h.generation_id,m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,
  m.metric_row_reference,m.contribution_row_reference,h.receipt_reference AS index_reference,
  h.sequence AS index_sequence,k.kind,k.native_key,k.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h USING(operation_id,organization_id)
 JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=h.organization_id
  AND body.content_sha256=h.receipt_reference->>'content_sha256'
  AND body.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND body.canonical_utf8_bytes<=4096
 CROSS JOIN LATERAL (
  (SELECT 'source_record'::text AS kind,source_record_id::text AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
   WHERE operation_id=h.operation_id AND organization_id=h.organization_id AND generation_id=h.generation_id
   ORDER BY source_record_id LIMIT 1)
  UNION ALL
  (SELECT 'legacy_sale'::text AS kind,legacy_sale_key AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
   WHERE operation_id=h.operation_id AND organization_id=h.organization_id AND generation_id=h.generation_id
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys existing
     WHERE existing.operation_id=h.operation_id LIMIT 1)
   ORDER BY legacy_sale_key COLLATE "C" LIMIT 1)
 ) k
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_rows m ON m.operation_id=h.operation_id
  AND m.organization_id=h.organization_id AND m.generation_id=h.generation_id AND m.ordinal=k.first_selected_ordinal
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge ON edge.operation_id=m.operation_id
  AND edge.organization_id=m.organization_id AND edge.generation_id=m.generation_id AND edge.ordinal=m.ordinal
  AND edge.account_id=m.account_id AND edge.kind=k.kind AND edge.native_key=k.native_key
 WHERE job.operation_id=$1::uuid AND h.generation_id=$2::uuid AND job.status='running'
  AND job.claim_token IS NOT NULL AND job.lease_expires_at>clock_timestamp()
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
  AND app.neighborhood_selected_transaction_index_v2_checkpoint_matches(job.operation_id,job.organization_id,job.checkpoint)
  AND body.canonical_utf8::jsonb->>'format'='cohort_selected_transaction_index_receipt_v2'
  AND body.canonical_utf8::jsonb->>'sequence'=h.sequence::text
  AND body.canonical_utf8::jsonb->'after'->>'done'='true'`;

// Separate actual owned18 seam. Native functions reopen the ENTIRE immutable
// birth/preclaim/current-claim tuple and reselect FIRST/member/edge. The old17
// literal above remains unchanged; no caller root/ordinal/source SQL is input.
export const OWNED_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_owned_first_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_owned_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;

// Separate actual recovered5 context; initial owned18 SQL above is unchanged.
export const RECOVERED_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_recovered_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_recovered_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;

// Separate native second2 context; every earlier SQL export remains intact.
export const SECOND_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_second_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_second_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;

// Separate actual native third3 context; every earlier export remains intact.
export const THIRD_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_third_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_third_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;

// Separate actual normal fourth4 context; no historical initial4 borrowing.
export const FOURTH_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_fourth_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_fourth_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;

// Separate actual normal fifth5 context; no historical initial4 borrowing.
export const FIFTH_FIRST_SOURCE_CONTEXT_V3_SQL=`
 SELECT p.generation_id,f.selected_account_id AS account_id,f.first_selected_ordinal AS ordinal,
  f.partition_ordinal,f.entry_reference,f.metric_row_reference,f.contribution_row_reference,
  p.index_reference,p.index_sequence,f.kind,f.native_key,f.first_selected_ordinal
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN LATERAL app.neighborhood_source_resolution_v3_fifth_parent(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) p ON true
 JOIN LATERAL app.neighborhood_source_resolution_v3_fifth_first(
  job.operation_id,job.organization_id,job.claim_token,job.attempts) f
  ON f.operation_id=p.operation_id AND f.organization_id=p.organization_id
 WHERE job.operation_id=$1::uuid AND p.generation_id=$2::uuid`;
