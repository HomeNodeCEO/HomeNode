-- UNREGISTERED OWNER WORK IN PROGRESS. Do not register/apply this partial
-- migration until the complete-original owner, same-TX issuance/deferred guards,
-- dedicated intent admission, exact17 job/continuation and native acceptance are
-- integrated coherently. The installed 20261205 unconditional COMMIT/head
-- refusals remain unchanged. These native functions alone issue NOTHING.

-- Exact17 recursively retains the actual issued exact16 graph. This is a native
-- graph join, not a caller-created/projected checkpoint or count/hash authority.
CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1
 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
 JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
 JOIN app.neighborhood_cohort_evidence_blobs sb ON sb.organization_id=s.organization_id
  AND sb.content_sha256=s.receipt_reference->>'content_sha256'
  AND sb.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND sb.canonical_utf8_bytes<=4096
 JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=h.operation_id AND u.organization_id=h.organization_id
 JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
  AND ub.content_sha256=u.receipt_reference->>'content_sha256'
  AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
 JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id
  AND b.content_sha256=h.receipt_reference->>'content_sha256'
  AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
 JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=h.operation_id AND stock.organization_id=h.organization_id
  AND stock.generation_id=h.generation_id AND stock.status='complete'
 WHERE h.operation_id=op AND h.organization_id=org AND h.command_id=s.command_id
  AND h.union_reference=s.union_reference AND h.eligibility_reference=s.eligibility_reference
  AND h.evidence_reference=s.evidence_reference AND h.metrics_reference=s.metrics_reference
  AND h.statistics_reference=s.statistics_reference AND h.numeric_reference=s.numeric_reference AND h.semantic_reference=s.receipt_reference
  AND u.command_id=s.command_id AND u.receipt_reference=s.union_reference
  AND cp->>'phase'='frozen_selected_transaction_index_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=17
  AND (cp-'phase'-'evidence_refs')='{}'::jsonb AND cp->'evidence_refs'->16=h.receipt_reference
  AND app.neighborhood_selected_semantic_v2_checkpoint_matches(op,org,
    jsonb_build_object('phase','frozen_selected_semantic_refs_v2','evidence_refs',(cp->'evidence_refs')-16))
  AND sb.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
  AND sb.canonical_utf8::jsonb->>'sequence'=s.sequence::text AND sb.canonical_utf8::jsonb->'after'->>'done'='true'
  AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
  AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
  AND sb.canonical_utf8::jsonb->'after'->'selected_ordinal'=ub.canonical_utf8::jsonb->'after_selected_count'
  AND b.canonical_utf8::jsonb->>'format'='cohort_selected_transaction_index_receipt_v2'
  AND b.canonical_utf8::jsonb->>'sequence'=h.sequence::text
  AND b.canonical_utf8::jsonb->>'command_id'=h.command_id::text
  AND b.canonical_utf8::jsonb->>'generation_id'=stock.generation_id::text
  AND b.canonical_utf8::jsonb->'selected_stock_count'=ub.canonical_utf8::jsonb->'after_selected_count'),false)
$$;

CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_admission_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1
 FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads s
 JOIN app.neighborhood_cohort_evidence_blobs sb ON sb.organization_id=s.organization_id
  AND sb.content_sha256=s.receipt_reference->>'content_sha256'
  AND sb.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND sb.canonical_utf8_bytes<=4096
 JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=s.operation_id AND u.organization_id=s.organization_id
 JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
  AND ub.content_sha256=u.receipt_reference->>'content_sha256'
  AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
 WHERE s.operation_id=op AND s.organization_id=org AND s.command_id=u.command_id AND s.union_reference=u.receipt_reference
  AND sb.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2'
  AND sb.canonical_utf8::jsonb->>'sequence'=s.sequence::text AND sb.canonical_utf8::jsonb->'after'->>'done'='true'
  AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
  AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
  AND sb.canonical_utf8::jsonb->'after'->'selected_ordinal'=ub.canonical_utf8::jsonb->'after_selected_count'
  AND ((app.neighborhood_selected_semantic_v2_checkpoint_matches(op,org,cp) AND NOT EXISTS(
    SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h WHERE h.operation_id=op))
   OR app.neighborhood_selected_transaction_index_v2_checkpoint_matches(op,org,cp))),false)
$$;

-- Same installed signature, no caller ordinal/generation/key roster. Every
-- account's complete association set is returned even for already registered
-- packages; global deduplication MUST NOT skip an account's original replay.
CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_keys(op uuid,org uuid)
RETURNS TABLE(generation_id uuid,account_id text,ordinal integer,partition_ordinal integer,
 entry_reference jsonb,metric_row_reference jsonb,contribution_row_reference jsonb,
 anchor_count integer,kind text,native_key text)
LANGUAGE sql STABLE AS $$
 WITH selected_context AS MATERIALIZED (
  SELECT stock.generation_id,m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,m.metric_row_reference,m.row_reference AS contribution_row_reference
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs sb ON sb.organization_id=s.organization_id
   AND sb.content_sha256=s.receipt_reference->>'content_sha256' AND sb.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND sb.canonical_utf8_bytes<=4096
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=job.operation_id AND u.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
   AND ub.content_sha256=u.receipt_reference->>'content_sha256' AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id AND stock.organization_id=job.organization_id
   AND stock.report_file_id=job.report_file_id AND stock.assignment_file_id=job.assignment_file_id AND stock.account_id=job.account_id
   AND stock.actor_user_id=job.actor_user_id AND stock.status='complete'
  JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id AND pin.generation_id=stock.generation_id
   AND pin.organization_id=stock.organization_id AND pin.report_file_id=stock.report_file_id AND pin.assignment_file_id=stock.assignment_file_id
   AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
  JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
   AND generation.status='complete' AND generation.retirement_started_at IS NULL
  LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
  LEFT JOIN app.neighborhood_cohort_evidence_blobs hb ON hb.organization_id=h.organization_id
   AND hb.content_sha256=h.receipt_reference->>'content_sha256' AND hb.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND hb.canonical_utf8_bytes<=4096
  LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id AND m.organization_id=job.organization_id AND m.ordinal=coalesce(h.sequence,0)+1
  LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows r ON r.operation_id=m.operation_id AND r.organization_id=m.organization_id
   AND r.ordinal=m.ordinal AND r.account_id=m.account_id AND r.partition_ordinal=m.partition_ordinal AND r.entry_reference=m.entry_reference
   AND r.metric_row_reference=m.metric_row_reference AND r.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
   AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
   AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i ON i.operation_id=m.operation_id AND i.organization_id=m.organization_id
   AND i.ordinal=m.ordinal AND i.account_id=m.account_id AND i.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id AND metric.organization_id=m.organization_id
   AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id AND metric.partition_ordinal=m.partition_ordinal
   AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows member ON member.operation_id=metric.operation_id AND member.organization_id=metric.organization_id
   AND member.ordinal=metric.ordinal AND member.account_id=metric.account_id AND member.partition_ordinal=metric.partition_ordinal AND member.entry_reference=metric.entry_reference
  LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows p ON p.operation_id=member.operation_id AND p.organization_id=member.organization_id
   AND p.account_id=member.account_id AND p.ordinal=member.partition_ordinal AND p.entry_reference=member.entry_reference
  WHERE job.operation_id=op AND job.organization_id=org AND job.status='running' AND job.claim_token IS NOT NULL
   AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
   AND app.neighborhood_selected_transaction_index_v2_admission_matches(op,org,job.checkpoint)
   AND sb.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2' AND sb.canonical_utf8::jsonb->>'sequence'=s.sequence::text
   AND sb.canonical_utf8::jsonb->'after'->>'done'='true'
   AND u.command_id=s.command_id AND u.receipt_reference=s.union_reference
   AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2' AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text
   AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
   AND ub.canonical_utf8::jsonb->'after_selected_count'=sb.canonical_utf8::jsonb->'after'->'selected_ordinal'
   AND (h.operation_id IS NULL OR (h.command_id=s.command_id AND h.generation_id=stock.generation_id
    AND h.union_reference=s.union_reference AND h.eligibility_reference=s.eligibility_reference AND h.evidence_reference=s.evidence_reference
    AND h.metrics_reference=s.metrics_reference AND h.statistics_reference=s.statistics_reference AND h.numeric_reference=s.numeric_reference
    AND h.semantic_reference=s.receipt_reference AND hb.canonical_utf8::jsonb->>'format'='cohort_selected_transaction_index_receipt_v2'
    AND hb.canonical_utf8::jsonb->>'sequence'=h.sequence::text AND hb.canonical_utf8::jsonb->'after'->>'done'='false'
    AND hb.canonical_utf8::jsonb->'after'->>'selected_ordinal'=h.sequence::text))
   -- A fresh EMPTY is allowed only at the exact retained prefix, including
   -- zero. The last nonempty account never makes the index DONE.
   AND ((coalesce(h.sequence,0)=(ub.canonical_utf8::jsonb->>'after_selected_count')::integer AND m.operation_id IS NULL)
    OR (coalesce(h.sequence,0)<(ub.canonical_utf8::jsonb->>'after_selected_count')::integer AND r.ordinal=m.ordinal AND n.ordinal=m.ordinal
     AND i.ordinal=m.ordinal AND metric.ordinal=m.ordinal AND member.ordinal=m.ordinal AND p.account_id=m.account_id))
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
  SELECT 'legacy_sale',row_key FROM anchors WHERE kind='sales' AND source_record_id IS NULL AND (SELECT anchor_count FROM gate)<=250
 )
 SELECT gate.*,packages.kind,packages.native_key FROM gate LEFT JOIN packages ON gate.anchor_count<=250
 ORDER BY CASE packages.kind WHEN 'source_record' THEN 0 ELSE 1 END,
  CASE WHEN packages.kind='source_record' THEN packages.native_key::bigint END,
  CASE WHEN packages.kind='legacy_sale' THEN packages.native_key END COLLATE "C"
 LIMIT 251
$$;

-- TODO, before registration: bounded bidirectional edge/delta/first-seen head
-- guard and real deferred orphan/COMMIT guards; same-TX head repository with
-- pre-DML and post-head transaction checks; native16/17 intent admission;
-- whole-original NEXT owner/current+ALL ending fences; exact17 checkpoint and
-- single-use continuation including ordinary4->5 recovery; independently
-- captured shared-source native positive/negative/rollback/EMPTY acceptance.
