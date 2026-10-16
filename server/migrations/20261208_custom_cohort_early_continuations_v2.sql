-- Dormant early original-owner success handoff. Apply atomically AFTER the
-- transaction-index owner candidate when composing this unregistered stack.
-- No prefix/caller checkpoint is admitted, no source rights/worker activated.
CREATE TABLE app.neighborhood_custom_cohort_early_v2_jobs (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  issued_transaction_id bigint NOT NULL DEFAULT txid_current() CHECK(issued_transaction_id>0)
);
CREATE FUNCTION app.guard_neighborhood_early_v2_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_early_v2_job_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR NEW.actor_user_id<>job.actor_user_id
    OR NEW.request_sha256<>job.request_sha256 OR NEW.issued_transaction_id<>txid_current()
    OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR job.context_sha256 IS NOT NULL OR (NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_early_v2_jobs e
      WHERE e.operation_id=NEW.operation_id) AND (job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_source_refs_v2'
        OR jsonb_array_length(job.checkpoint->'evidence_refs')<>3)) THEN
    RAISE EXCEPTION 'neighborhood_early_v2_job_binding_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_early_v2_job_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_early_v2_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_early_v2_job();
CREATE TRIGGER neighborhood_early_v2_job_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_early_v2_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_early_v2_jobs FROM PUBLIC;

ALTER TABLE app.neighborhood_custom_cohort_graph_v2_anchors ADD COLUMN issued_transaction_id bigint CHECK(issued_transaction_id>0);
ALTER TABLE app.neighborhood_custom_cohort_geo_v2_anchors ADD COLUMN issued_transaction_id bigint CHECK(issued_transaction_id>0);
ALTER TABLE app.neighborhood_custom_cohort_identity_v2_anchors ADD COLUMN issued_transaction_id bigint CHECK(issued_transaction_id>0);

-- Runs AFTER each existing BEFORE identity/edge/count guard (trigger names
-- sort alphabetically). A caller cannot stamp an old receipt as freshly issued.
-- Existing rows remain NULL, never backfilled as present-transaction issuance.
CREATE FUNCTION app.stamp_neighborhood_early_v2_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.issued_transaction_id IS NOT NULL)
    OR (TG_OP='UPDATE' AND NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id) THEN
    RAISE EXCEPTION 'neighborhood_early_v2_issuance_immutable' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER zz_neighborhood_graph_v2_issuance BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_graph_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.stamp_neighborhood_early_v2_issuance();
CREATE TRIGGER zz_neighborhood_geo_v2_issuance BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_geo_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.stamp_neighborhood_early_v2_issuance();
CREATE TRIGGER zz_neighborhood_identity_v2_issuance BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_identity_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.stamp_neighborhood_early_v2_issuance();

-- Once enrolled, actual early-anchor progress cannot COMMIT without its
-- matching native success/release in that SAME transaction. Rolling back only
-- the yield statement cannot strand or launder the original head/checkpoint.
CREATE FUNCTION app.check_neighborhood_early_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE; actual_ref jsonb; actual_tx bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_early_v2_jobs e
    WHERE e.operation_id=NEW.operation_id AND e.organization_id=NEW.organization_id) THEN RETURN NEW; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_early_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF job.checkpoint->>'phase'='frozen_verify_refs_v2' THEN
    SELECT receipt_reference,issued_transaction_id INTO STRICT actual_ref,actual_tx
      FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  ELSIF job.checkpoint->>'phase'='frozen_geo_verify_refs_v2' THEN
    SELECT receipt_reference,issued_transaction_id INTO STRICT actual_ref,actual_tx
      FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  ELSIF job.checkpoint->>'phase'='frozen_identity_refs_v2' THEN
    SELECT receipt_reference,issued_transaction_id INTO STRICT actual_ref,actual_tx
      FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  ELSE RAISE EXCEPTION 'neighborhood_early_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF actual_tx IS DISTINCT FROM txid_current() OR c.organization_id<>job.organization_id
    OR c.phase IS DISTINCT FROM job.checkpoint->>'phase' OR c.progress_reference IS DISTINCT FROM actual_ref
    OR job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM actual_ref OR c.issued_attempts<>job.attempts
    OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL
    OR job.lease_expires_at IS NOT NULL OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_early_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_early_v2_job_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_early_v2_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_early_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_graph_early_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_graph_v2_anchors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_early_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_geo_early_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_geo_v2_anchors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_early_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_identity_early_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_identity_v2_anchors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_early_v2_commit();

ALTER TABLE app.neighborhood_custom_cohort_v2_continuations
  DROP CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check,
  ADD CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check CHECK(phase IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2','frozen_identity_refs_v2','frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'));

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; actual_reference jsonb; actual_sequence integer; first_union_bridge boolean:=false; early_issued_tx bigint; early_receipt jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_v2_continuation_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000';
  END IF;
  -- Early source passes share finite existing later ceilings; none is widened.
  IF NEW.sequence<1
    OR (NEW.phase='frozen_verify_refs_v2' AND NEW.sequence>200000)
    OR (NEW.phase='frozen_geo_verify_refs_v2' AND NEW.sequence>400000)
    OR (NEW.phase='frozen_identity_refs_v2' AND NEW.sequence>600000)
    OR (NEW.phase='frozen_selected_transaction_index_refs_v2' AND NEW.sequence>22000011)
    OR (NEW.phase='frozen_selected_semantic_refs_v2' AND NEW.sequence>20000010)
    OR (NEW.phase='frozen_selected_numeric_refs_v2' AND NEW.sequence>18000009)
    OR (NEW.phase NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') AND NEW.sequence>16000008) THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.phase IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2','frozen_identity_refs_v2') THEN
    IF NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_early_v2_jobs e
      WHERE e.operation_id=NEW.operation_id AND e.organization_id=NEW.organization_id
        AND e.actor_user_id=job.actor_user_id AND e.request_sha256=job.request_sha256) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000'; END IF;
    IF NEW.phase='frozen_verify_refs_v2' THEN
      SELECT receipt_reference,sequence,issued_transaction_id INTO STRICT actual_reference,actual_sequence,early_issued_tx
        FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    ELSIF NEW.phase='frozen_geo_verify_refs_v2' THEN
      SELECT receipt_reference,sequence,issued_transaction_id INTO STRICT actual_reference,actual_sequence,early_issued_tx
        FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    ELSE
      SELECT receipt_reference,sequence,issued_transaction_id INTO STRICT actual_reference,actual_sequence,early_issued_tx
        FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    END IF;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>(CASE NEW.phase WHEN 'frozen_verify_refs_v2' THEN 4
      WHEN 'frozen_geo_verify_refs_v2' THEN 5 ELSE 6 END) OR job.context_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT early_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=actual_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=actual_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  ELSIF NEW.phase='frozen_stock_traversal_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>7 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_recorded_partition_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>8 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_recorded_catalog_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>9 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_union_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_union_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_eligibility_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_evidence_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_evidence_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_metrics_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_metrics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_statistics_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_numeric_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_semantic_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_transaction_index_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF job.context_sha256 IS NOT NULL OR NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSE RAISE EXCEPTION 'neighborhood_v2_continuation_phase_conflict' USING ERRCODE='55000'; END IF;
  IF job.checkpoint->>'phase' IS DISTINCT FROM NEW.phase
    OR job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM actual_reference OR NEW.progress_reference IS DISTINCT FROM actual_reference THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.operation_id=OLD.operation_id AND NEW.organization_id=OLD.organization_id
    AND NEW.sequence=OLD.sequence AND NEW.phase=OLD.phase AND NEW.progress_reference=OLD.progress_reference
    AND NEW.issued_claim_token=OLD.issued_claim_token AND NEW.issued_attempts=OLD.issued_attempts
    AND OLD.consumed_claim_token IS NULL AND NEW.consumed_claim_token IS NOT NULL THEN
    IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.attempts<>NEW.issued_attempts OR job.cancellation_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  -- Consumption uses a later transaction. New early success must come from
  -- an actual independently guarded anchor advance in this SAME transaction.
  IF NEW.phase IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2','frozen_identity_refs_v2')
    AND early_issued_tx IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;
  -- Consuming a retained continuation above is a later TX. Issuing a NEW
  -- exact17 continuation here requires the actual head issued in THIS TX.
  IF NEW.phase='frozen_selected_transaction_index_refs_v2' AND NOT EXISTS(
    SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
    WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.issued_transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;
  IF job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token
    OR job.attempts<>NEW.issued_attempts OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR NEW.consumed_claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    -- BEFORE INSERT also fires for the provisional row of INSERT ... ON
    -- CONFLICT DO UPDATE. A union may never create a free continuation, but
    -- its already-existing native continuation must reach the UPDATE guard
    -- below. That guard still enforces the exact old head, next sequence,
    -- consumed token and first-human bridge; this is not a new-row admission.
    IF NEW.sequence<>1
      OR (NEW.phase='frozen_verify_refs_v2' AND actual_sequence<>1 AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations existing WHERE existing.operation_id=NEW.operation_id))
      OR (NEW.phase IN ('frozen_geo_verify_refs_v2','frozen_identity_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') AND NOT EXISTS(
      SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations existing
      WHERE existing.operation_id=NEW.operation_id AND existing.organization_id=NEW.organization_id)) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    -- ONLY the first actual union head may bridge the fresh authenticated human
    -- resume token at the same attempt; all later consumed-token rules remain.
    IF OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase='frozen_selected_union_refs_v2' AND actual_sequence=1 THEN
      SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents command
        WHERE command.operation_id=NEW.operation_id AND command.organization_id=NEW.organization_id
          AND command.resume_claim_token=NEW.issued_claim_token AND command.issued_attempts=NEW.issued_attempts
          AND command.checkpoint->'evidence_refs'->8=OLD.progress_reference) INTO first_union_bridge;
    END IF;
    IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.sequence<>OLD.sequence+1
      OR OLD.consumed_claim_token IS NULL OR (NEW.issued_attempts=OLD.issued_attempts AND NEW.issued_claim_token<>OLD.consumed_claim_token AND NOT first_union_bridge)
      OR NEW.issued_attempts<OLD.issued_attempts OR NEW.progress_reference=OLD.progress_reference
      OR (OLD.phase='frozen_verify_refs_v2' AND NEW.phase NOT IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2'))
      OR (OLD.phase='frozen_geo_verify_refs_v2' AND NEW.phase NOT IN ('frozen_geo_verify_refs_v2','frozen_identity_refs_v2'))
      OR (OLD.phase='frozen_identity_refs_v2' AND NEW.phase NOT IN ('frozen_identity_refs_v2','frozen_stock_traversal_refs_v2'))
      OR (NEW.phase='frozen_verify_refs_v2' AND OLD.phase<>'frozen_verify_refs_v2')
      OR (NEW.phase='frozen_geo_verify_refs_v2' AND OLD.phase NOT IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2'))
      OR (NEW.phase='frozen_identity_refs_v2' AND OLD.phase NOT IN ('frozen_geo_verify_refs_v2','frozen_identity_refs_v2'))
      OR (NEW.phase=OLD.phase AND NEW.phase IN ('frozen_verify_refs_v2','frozen_geo_verify_refs_v2','frozen_identity_refs_v2')
        AND early_receipt->'previous' IS DISTINCT FROM OLD.progress_reference)
      OR (OLD.phase='frozen_verify_refs_v2' AND NEW.phase='frozen_geo_verify_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_geo_v2_anchors h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.graph_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_geo_verify_refs_v2' AND NEW.phase='frozen_identity_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_identity_v2_anchors h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.geographic_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_identity_refs_v2' AND NEW.phase='frozen_stock_traversal_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.identity_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_recorded_partition_refs_v2' AND NEW.phase='frozen_stock_traversal_refs_v2')
      OR (OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase NOT IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'))
      OR (NEW.phase='frozen_selected_union_refs_v2' AND OLD.phase NOT IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'))
      OR (OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase='frozen_selected_union_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents command
          WHERE command.operation_id=NEW.operation_id AND command.organization_id=NEW.organization_id
            AND command.checkpoint->'evidence_refs'->8=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (NEW.phase='frozen_selected_eligibility_refs_v2' AND OLD.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase='frozen_selected_eligibility_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.union_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (NEW.phase='frozen_selected_evidence_refs_v2' AND OLD.phase NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase='frozen_selected_evidence_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.eligibility_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (NEW.phase='frozen_selected_metrics_refs_v2' AND OLD.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase='frozen_selected_metrics_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.evidence_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (NEW.phase='frozen_selected_statistics_refs_v2' AND OLD.phase NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase='frozen_selected_statistics_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.metrics_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_statistics_refs_v2' AND NEW.phase NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'))
      OR (NEW.phase='frozen_selected_numeric_refs_v2' AND OLD.phase NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'))
      OR (OLD.phase='frozen_selected_statistics_refs_v2' AND NEW.phase='frozen_selected_numeric_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.statistics_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_numeric_refs_v2' AND NEW.phase NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'))
      OR (NEW.phase='frozen_selected_semantic_refs_v2' AND OLD.phase NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'))
      OR (OLD.phase='frozen_selected_numeric_refs_v2' AND NEW.phase='frozen_selected_semantic_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.numeric_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_semantic_refs_v2' AND NEW.phase NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))
      OR (OLD.phase='frozen_selected_transaction_index_refs_v2' AND NEW.phase<>'frozen_selected_transaction_index_refs_v2')
      OR (NEW.phase='frozen_selected_transaction_index_refs_v2' AND OLD.phase NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))
      OR (OLD.phase='frozen_selected_semantic_refs_v2' AND NEW.phase='frozen_selected_transaction_index_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.semantic_reference=OLD.progress_reference))) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION app.stamp_neighborhood_early_v2_issuance() IS
  'Fresh actual original-anchor DML transaction only; independent edge/current-original owner guards remain mandatory. No source prefix, source grant, context completion, worker or publication activation.';
