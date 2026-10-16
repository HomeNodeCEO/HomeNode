-- DEVELOPMENT fixture ONLY; unregistered/inactive.
-- Preserve the latest installed/candidate V2 intent-through-transaction-index guard branches;
-- add ONLY terminal V3 batch-catalog lease release. This supplies no current/source/human authority.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2')) THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status='awaiting_selection' THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_live_claim_required' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO command FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=OLD.operation_id;
  IF FOUND THEN
    -- Intent and its issued nine roots are not a completed context. This slice
    -- cannot alter roots, erase failure history, issue success or wait again.
    IF NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
      OR (NEW.checkpoint IS DISTINCT FROM command.checkpoint
        AND NOT app.neighborhood_selected_union_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_evidence_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_metrics_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))
      OR (OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_eligibility_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_evidence_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_metrics_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_statistics_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_numeric_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_semantic_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_transaction_index_refs_v2')
      OR (NEW.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint
        AND NOT app.neighborhood_transaction_index_v2_checkpoint_transition_matches(OLD.operation_id,OLD.organization_id,OLD.checkpoint,NEW.checkpoint))
      OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') THEN
    IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='awaiting_selection' THEN
    IF NEW.status<>'cancelled' OR NEW.cancellation_requested_at IS NULL
      OR (to_jsonb(NEW)-ARRAY['status','cancellation_requested_at','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancellation_requested_at','updated_at']) THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status<>'awaiting_selection' THEN RETURN NEW; END IF;
  IF OLD.status<>'running' OR OLD.claim_token IS NULL OR OLD.lease_expires_at IS NULL
    OR OLD.lease_expires_at<=clock_timestamp() OR OLD.cancellation_requested_at IS NOT NULL
    OR OLD.context_sha256 IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_live_claim_required' USING ERRCODE='55000'; END IF;
  IF OLD.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'
    OR jsonb_array_length(OLD.checkpoint->'evidence_refs') IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads
    WHERE operation_id=OLD.operation_id AND organization_id=OLD.organization_id;
  IF head.stock_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->1
    OR head.source_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->2
    OR head.graph_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->3
    OR head.geographic_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->4
    OR head.identity_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->5
    OR head.traversal_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->6
    OR head.partition_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->7
    OR head.receipt_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->8 THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=OLD.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(receipt))<>22
      OR receipt->'accounts' IS DISTINCT FROM '[]'::jsonb OR receipt->'entries' IS DISTINCT FROM '[]'::jsonb
      OR receipt->'original_count' IS DISTINCT FROM '0'::jsonb
      OR receipt->'before'->>'done' IS DISTINCT FROM 'false'
      OR receipt->'after' IS DISTINCT FROM jsonb_set(receipt->'before','{done}','true'::jsonb)
      OR receipt->'after_counts' IS DISTINCT FROM receipt->'before_counts'
      OR receipt->'partition_reference' IS DISTINCT FROM head.partition_reference
      OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads p
        JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors t ON t.operation_id=p.operation_id AND t.organization_id=p.organization_id
        JOIN app.neighborhood_cohort_evidence_blobs pb ON pb.organization_id=p.organization_id
          AND pb.content_sha256=p.receipt_reference->>'content_sha256'
          AND pb.canonical_utf8_bytes::text=p.receipt_reference->>'canonical_utf8_bytes' AND pb.canonical_utf8_bytes<=16000
        JOIN app.neighborhood_cohort_evidence_blobs tb ON tb.organization_id=t.organization_id
          AND tb.content_sha256=t.receipt_reference->>'content_sha256'
          AND tb.canonical_utf8_bytes::text=t.receipt_reference->>'canonical_utf8_bytes' AND tb.canonical_utf8_bytes<=16000
        WHERE p.operation_id=OLD.operation_id AND p.organization_id=OLD.organization_id
          AND p.receipt_reference=head.partition_reference AND t.receipt_reference=head.traversal_reference
          AND p.traversal_reference=t.receipt_reference AND p.profile_reference=head.profile_reference
          AND p.source_reference=head.source_reference AND p.root_reference=head.root_reference
          AND p.graph_reference=head.graph_reference AND p.geographic_reference=head.geographic_reference
          AND p.identity_reference=head.identity_reference AND p.stock_reference=head.stock_reference
          AND pb.canonical_utf8::jsonb->>'format'='cohort_recorded_group_partition_batch_receipt_v3'
          AND pb.canonical_utf8::jsonb->'after'->>'done'='true'
          AND tb.canonical_utf8::jsonb->>'format'='cohort_stock_traversal_batch_receipt_v3'
          AND tb.canonical_utf8::jsonb->'after'->>'done'='true') THEN
      RAISE EXCEPTION 'neighborhood_batch_selection_wait_v3_catalog_conflict' USING ERRCODE='55000'; END IF;
  ELSIF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  IF receipt->>'format' NOT IN ('cohort_recorded_catalog_receipt_v2','cohort_recorded_catalog_batch_receipt_v3')
    OR receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
