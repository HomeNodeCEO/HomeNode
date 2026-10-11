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

-- Bounded CURRENT-account equality and immutable prefix, never a full retained
-- registry/population recount. Past rows were checked when their issued head
-- committed; only this ordinal's identities and first-seen delta are new.
CREATE OR REPLACE FUNCTION app.neighborhood_selected_transaction_index_v2_next_edges_match(op uuid,org uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH expected AS MATERIALIZED (SELECT * FROM app.neighborhood_selected_transaction_index_v2_next_keys(op,org)),
 header AS MATERIALIZED (SELECT * FROM expected LIMIT 1), retained AS MATERIALIZED (
  SELECT e.* FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_edges e
  JOIN header h ON e.operation_id=op AND e.ordinal=h.ordinal
 ), prefix AS MATERIALIZED (
  SELECT coalesce(h.ordinal,coalesce(i.sequence,0)) AS ordinal FROM header h
  LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads i ON i.operation_id=op
 )
 SELECT coalesce(EXISTS(SELECT 1 FROM header h WHERE h.anchor_count<=250
  AND (h.account_id IS NULL OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_rows r
   WHERE r.operation_id=op AND r.organization_id=org AND r.generation_id=h.generation_id
    AND r.ordinal=h.ordinal AND r.account_id=h.account_id AND r.partition_ordinal=h.partition_ordinal
    AND r.entry_reference=h.entry_reference AND r.metric_row_reference=h.metric_row_reference
    AND r.contribution_row_reference=h.contribution_row_reference))
  AND NOT EXISTS(SELECT 1 FROM expected x WHERE x.kind IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM retained r WHERE r.kind=x.kind AND r.native_key=x.native_key))
  AND NOT EXISTS(SELECT 1 FROM retained r WHERE NOT EXISTS(
   SELECT 1 FROM expected x WHERE x.kind=r.kind AND x.native_key=r.native_key))
  AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.organization_id IS DISTINCT FROM org
   OR r.generation_id IS DISTINCT FROM h.generation_id OR r.account_id IS DISTINCT FROM h.account_id)
  AND NOT EXISTS(SELECT 1 FROM retained r JOIN app.neighborhood_custom_cohort_selected_transaction_source_v2_keys k
   ON k.operation_id=r.operation_id AND k.source_record_id=r.source_record_id
   WHERE k.organization_id IS DISTINCT FROM org OR k.generation_id IS DISTINCT FROM h.generation_id OR k.first_selected_ordinal>h.ordinal)
  AND NOT EXISTS(SELECT 1 FROM retained r JOIN app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys k
   ON k.operation_id=r.operation_id AND k.legacy_sale_key=r.legacy_sale_key
   WHERE k.organization_id IS DISTINCT FROM org OR k.generation_id IS DISTINCT FROM h.generation_id OR k.first_selected_ordinal>h.ordinal)
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys k
   WHERE k.operation_id=op AND k.first_selected_ordinal=h.ordinal AND NOT EXISTS(
    SELECT 1 FROM retained r WHERE r.kind='source_record' AND r.source_record_id=k.source_record_id))
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys k
   WHERE k.operation_id=op AND k.first_selected_ordinal=h.ordinal AND NOT EXISTS(
    SELECT 1 FROM retained r WHERE r.kind='legacy_sale' AND r.legacy_sale_key=k.legacy_sale_key))
  -- Op-only ranges deliberately do not hide wrong-org provisional children.
  -- Their indexed existence probes reject future/orphan deltas, including at
  -- fresh EMPTY, without revisiting the previously committed population.
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_rows r
   WHERE r.operation_id=op AND r.ordinal>(SELECT ordinal FROM prefix) LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_edges r
   WHERE r.operation_id=op AND r.ordinal>(SELECT ordinal FROM prefix) LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys k
   WHERE k.operation_id=op AND k.first_selected_ordinal>(SELECT ordinal FROM prefix) LIMIT 1)
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys k
   WHERE k.operation_id=op AND k.first_selected_ordinal>(SELECT ordinal FROM prefix) LIMIT 1)),false)
$$;

-- These trigger FUNCTIONS are intentionally NOT attached yet. Registering or
-- replacing the installed unconditional refusals before the actual original
-- owner, dedicated intent and exact17 single-use yield exist would be unsafe.
CREATE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_head_issued() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
 s app.neighborhood_custom_cohort_selected_semantic_v2_heads%ROWTYPE;
 k record; body jsonb; prior jsonb; before_state jsonb; after_state jsonb; selected_entry jsonb;
 expected_body jsonb; parent_count jsonb; source_count integer; legacy_count integer;
 new_source integer; new_legacy integer; prior_source bigint; prior_legacy bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id FOR UPDATE;
 SELECT * INTO STRICT s FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 IF job.organization_id IS DISTINCT FROM NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL
  OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
  OR NEW.issued_transaction_id IS DISTINCT FROM txid_current() OR NEW.command_id IS DISTINCT FROM s.command_id
  OR NEW.union_reference IS DISTINCT FROM s.union_reference OR NEW.eligibility_reference IS DISTINCT FROM s.eligibility_reference
  OR NEW.evidence_reference IS DISTINCT FROM s.evidence_reference OR NEW.metrics_reference IS DISTINCT FROM s.metrics_reference
  OR NEW.statistics_reference IS DISTINCT FROM s.statistics_reference OR NEW.numeric_reference IS DISTINCT FROM s.numeric_reference
  OR NEW.semantic_reference IS DISTINCT FROM s.receipt_reference
  OR NOT app.neighborhood_selected_transaction_index_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_binding_conflict' USING ERRCODE='55000'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.sequence<>1 OR NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  before_state:=jsonb_build_object('selected_ordinal',0,'source_record_keys',0,'legacy_sale_keys',0,'done',false);
 ELSE
  -- Exactly one advance per transaction; older deferred child checks cannot
  -- silently attach to a second later head issued in the same transaction.
  IF OLD.issued_transaction_id=txid_current() OR NEW.sequence<>OLD.sequence+1
   OR (to_jsonb(NEW)-ARRAY['receipt_reference','sequence','issued_transaction_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence','issued_transaction_id'])
   OR NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
   WHERE organization_id=NEW.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
    AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF prior->>'format' IS DISTINCT FROM 'cohort_selected_transaction_index_receipt_v2'
   OR prior->'sequence' IS DISTINCT FROM to_jsonb(OLD.sequence) OR prior->'after'->'done' IS DISTINCT FROM 'false'::jsonb
   OR prior->'after'->'selected_ordinal' IS DISTINCT FROM to_jsonb(OLD.sequence) THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  before_state:=prior->'after';
 END IF;
 SELECT * INTO k FROM app.neighborhood_selected_transaction_index_v2_next_keys(NEW.operation_id,NEW.organization_id) LIMIT 1;
 IF NOT FOUND OR k.anchor_count>250 OR NEW.generation_id IS DISTINCT FROM k.generation_id
  OR NOT app.neighborhood_selected_transaction_index_v2_next_edges_match(NEW.operation_id,NEW.organization_id) THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_exact_edges_conflict' USING ERRCODE='55000'; END IF;
 SELECT canonical_utf8::jsonb->'selected_stock_count' INTO STRICT parent_count FROM app.neighborhood_cohort_evidence_blobs
  WHERE organization_id=NEW.organization_id AND content_sha256=s.receipt_reference->>'content_sha256'
   AND canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
 -- These are <=250 current-account packages and <=250 first-seen rows, not a
 -- count of the global registry and never a substitute for exact edge sets.
 SELECT count(*) FILTER(WHERE kind='source_record')::integer,count(*) FILTER(WHERE kind='legacy_sale')::integer
  INTO source_count,legacy_count FROM app.neighborhood_selected_transaction_index_v2_next_keys(NEW.operation_id,NEW.organization_id);
 SELECT count(*)::integer INTO new_source FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
  WHERE operation_id=NEW.operation_id AND first_selected_ordinal=k.ordinal;
 SELECT count(*)::integer INTO new_legacy FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
  WHERE operation_id=NEW.operation_id AND first_selected_ordinal=k.ordinal;
 IF before_state IS NULL OR (before_state-ARRAY['selected_ordinal','source_record_keys','legacy_sale_keys','done'])<>'{}'::jsonb
  OR before_state->'done' IS DISTINCT FROM 'false'::jsonb OR before_state->'selected_ordinal' IS DISTINCT FROM to_jsonb(NEW.sequence-1)
  OR jsonb_typeof(before_state->'source_record_keys') IS DISTINCT FROM 'number'
  OR jsonb_typeof(before_state->'legacy_sale_keys') IS DISTINCT FROM 'number'
  OR (before_state->>'source_record_keys') !~ '^(0|[1-9][0-9]{0,8})$'
  OR (before_state->>'legacy_sale_keys') !~ '^(0|[1-9][0-9]{0,8})$' THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
 prior_source:=(before_state->>'source_record_keys')::bigint;prior_legacy:=(before_state->>'legacy_sale_keys')::bigint;
 IF prior_source>500000000 OR prior_legacy>500000000 OR prior_source+prior_legacy>(NEW.sequence-1)::bigint*250
  OR new_source>source_count OR new_legacy>legacy_count OR source_count+legacy_count>k.anchor_count
  OR source_count-new_source>prior_source OR legacy_count-new_legacy>prior_legacy THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_delta_conflict' USING ERRCODE='55000'; END IF;
 IF k.account_id IS NULL THEN
  IF before_state->'selected_ordinal' IS DISTINCT FROM parent_count OR k.anchor_count<>0 OR source_count<>0
   OR legacy_count<>0 OR new_source<>0 OR new_legacy<>0 THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_complete_union_conflict' USING ERRCODE='55000'; END IF;
  selected_entry:='null'::jsonb;
 ELSE
  IF k.ordinal<>NEW.sequence OR k.ordinal>(parent_count::text)::integer THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_member_conflict' USING ERRCODE='55000'; END IF;
  selected_entry:=jsonb_build_object('account_id',k.account_id,'ordinal',k.ordinal,'partition_ordinal',k.partition_ordinal,
   'entry_reference',k.entry_reference,'metric_row_reference',k.metric_row_reference,'contribution_row_reference',k.contribution_row_reference);
 END IF;
 after_state:=jsonb_build_object('selected_ordinal',coalesce(k.ordinal,NEW.sequence-1),
  'source_record_keys',prior_source+new_source,'legacy_sale_keys',prior_legacy+new_legacy,'done',k.account_id IS NULL);
 IF prior_source+new_source>500000000 OR prior_legacy+new_legacy>500000000
  OR prior_source+new_source+prior_legacy+new_legacy>coalesce(k.ordinal,NEW.sequence-1)::bigint*250 THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_delta_conflict' USING ERRCODE='55000'; END IF;
 expected_body:=jsonb_build_object('format','cohort_selected_transaction_index_receipt_v2','command_id',NEW.command_id::text,
  'union_reference',NEW.union_reference,'eligibility_reference',NEW.eligibility_reference,'evidence_reference',NEW.evidence_reference,
  'metrics_reference',NEW.metrics_reference,'statistics_reference',NEW.statistics_reference,'numeric_reference',NEW.numeric_reference,
  'semantic_reference',NEW.semantic_reference,'generation_id',NEW.generation_id::text,'selected_stock_count',parent_count,
  'sequence',NEW.sequence,'previous',CASE WHEN TG_OP='INSERT' THEN 'null'::jsonb ELSE OLD.receipt_reference END,
  'before',before_state,'after',after_state,'selected_entry',selected_entry,'association_anchor_count',k.anchor_count,
  'source_package_count',source_count,'legacy_package_count',legacy_count,'new_source_record_keys',new_source,'new_legacy_sale_keys',new_legacy);
 SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
  WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
   AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
 IF body IS DISTINCT FROM expected_body THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_transition_conflict' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app.check_neighborhood_selected_transaction_index_v2_head_commit_issued() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_transaction_index_v2_heads%ROWTYPE;
 job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads WHERE operation_id=NEW.operation_id;
 SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
 SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
 IF h.organization_id IS DISTINCT FROM NEW.organization_id OR h.receipt_reference IS DISTINCT FROM NEW.receipt_reference
  OR h.sequence IS DISTINCT FROM NEW.sequence OR h.issued_transaction_id IS DISTINCT FROM txid_current()
  OR NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
  OR c.organization_id IS DISTINCT FROM NEW.organization_id OR c.phase<>'frozen_selected_transaction_index_refs_v2'
  OR c.progress_reference IS DISTINCT FROM h.receipt_reference OR c.issued_attempts IS DISTINCT FROM job.attempts
  OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL
  OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_orphan_progress' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION app.check_neighborhood_selected_transaction_index_v2_child_commit_issued() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_transaction_index_v2_heads%ROWTYPE; body jsonb; child_ordinal integer;
 job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads WHERE operation_id=NEW.operation_id;
 SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
 SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
 IF TG_TABLE_NAME IN ('neighborhood_custom_cohort_selected_transaction_source_v2_keys','neighborhood_custom_cohort_selected_transaction_legacy_v2_keys')
  THEN child_ordinal:=NEW.first_selected_ordinal; ELSE child_ordinal:=NEW.ordinal; END IF;
 SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
  WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
   AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
 IF h.organization_id IS DISTINCT FROM NEW.organization_id OR h.generation_id IS DISTINCT FROM NEW.generation_id
  OR h.sequence IS DISTINCT FROM child_ordinal OR h.issued_transaction_id IS DISTINCT FROM txid_current()
  OR body->'selected_entry'->'ordinal' IS DISTINCT FROM to_jsonb(child_ordinal)
  OR body->'after'->'done' IS DISTINCT FROM 'false'::jsonb
  OR NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
  OR c.organization_id IS DISTINCT FROM NEW.organization_id OR c.phase<>'frozen_selected_transaction_index_refs_v2'
  OR c.progress_reference IS DISTINCT FROM h.receipt_reference OR c.issued_attempts IS DISTINCT FROM job.attempts
  OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL
  OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_orphan_child' USING ERRCODE='55000'; END IF;
 RETURN NULL;
END $$;

-- TODO, before registration: attach the complete native guards ONLY with the
-- coherent whole-original NEXT owner/current+ALL ending fences, separate
-- original-package SQL/adapter, exact17 checkpoint and single-use continuation
-- including ordinary4->5 recovery. The dedicated native16/17 intent reader and
-- same-TX pre-DML/post-head storage repository are authored but NOT yet called
-- by that owner and NOT natively verified. Require independently captured
-- shared-source native positive/negative/orphan/rollback/lostACK/EMPTY proofs.
