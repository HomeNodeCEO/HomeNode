-- UNREGISTERED birth-only exact18 checkpoint groundwork. The actual original
-- owner must create parent/FIRST/blob/row/head before this transition. All four
-- existing deferred COMMIT refusals remain, plus a job-level COMMIT refusal.
-- No continuation, durable success, recovery, NEXT, activation or pin transfer.
-- A later fresh18 reader must reopen the retained actual17 snapshot; NEVER
-- manufacture that snapshot by removing a caller/projected eighteenth root.
CREATE FUNCTION app.neighborhood_source_resolution_v3_first_checkpoint(op uuid,org uuid)
RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT jsonb_build_object('phase','frozen_selected_source_resolution_refs_v3',
   'evidence_refs',(p.parent_checkpoint->'evidence_refs')||jsonb_build_array(h.candidate_reference))
 FROM app.neighborhood_source_resolution_v3_native_parent(op,org) actual
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p
  ON p.operation_id=actual.operation_id AND to_jsonb(p)=to_jsonb(actual)
 JOIN app.neighborhood_source_resolution_v3_native_first(op,org) native_first
  ON native_first.operation_id=p.operation_id AND native_first.organization_id=p.organization_id
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_first saved_first
  ON saved_first.operation_id=native_first.operation_id AND to_jsonb(saved_first)=to_jsonb(native_first)
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_rows r
  ON r.operation_id=p.operation_id AND r.organization_id=p.organization_id
   AND r.sequence=1 AND r.issued_transaction_id=p.issued_transaction_id
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_heads h
  ON h.operation_id=r.operation_id AND to_jsonb(h)=to_jsonb(r)
 JOIN app.neighborhood_cohort_evidence_blobs body ON body.organization_id=r.organization_id
  AND r.candidate_reference=jsonb_build_object('content_sha256',body.content_sha256,'canonical_utf8_bytes',body.canonical_utf8_bytes::text)
  AND body.canonical_utf8_bytes<=12000
 WHERE p.issued_transaction_id=txid_current()
  AND octet_length(jsonb_build_object('phase','frozen_selected_source_resolution_refs_v3',
    'evidence_refs',(p.parent_checkpoint->'evidence_refs')||jsonb_build_array(h.candidate_reference))::text)<=4096
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_first_checkpoint(uuid,uuid) FROM PUBLIC;

-- The native job supplies OLD and NEW to this trigger predicate. No caller
-- reference, count, hash, source choice or projected parent admits the save.
-- Compare the ENTIRE native old tuple; only checkpoint/updated_at may change.
CREATE FUNCTION app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(
 old_job app.neighborhood_custom_cohort_capture_jobs,new_job app.neighborhood_custom_cohort_capture_jobs)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_capture_jobs actual
  WHERE actual.operation_id=old_job.operation_id AND to_jsonb(actual)=to_jsonb(old_job)
   AND old_job.status='running' AND old_job.claim_token IS NOT NULL AND old_job.lease_expires_at>clock_timestamp()
   AND old_job.cancellation_requested_at IS NULL AND old_job.context_sha256 IS NULL
   AND old_job.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2'
   AND (to_jsonb(new_job)-ARRAY['checkpoint','updated_at'])=(to_jsonb(old_job)-ARRAY['checkpoint','updated_at'])
   AND new_job.checkpoint IS NOT NULL
   AND new_job.checkpoint=app.neighborhood_source_resolution_v3_first_checkpoint(actual.operation_id,actual.organization_id)),false)
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(
 app.neighborhood_custom_cohort_capture_jobs,app.neighborhood_custom_cohort_capture_jobs) FROM PUBLIC;

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first_checkpoint_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
   RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
   RAISE EXCEPTION 'neighborhood_source_resolution_v3_provisional_checkpoint_immutable' USING ERRCODE='55000'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_provisional_checkpoint_immutable' USING ERRCODE='55000'; END IF;
 IF NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND NOT app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_first_checkpoint_job_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first_checkpoint_job();

CREATE FUNCTION app.reject_neighborhood_source_resolution_v3_first_checkpoint_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'neighborhood_source_resolution_v3_checkpoint_unintegrated' USING ERRCODE='55000';
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_first_checkpoint_commit AFTER UPDATE
 ON app.neighborhood_custom_cohort_capture_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3')
 EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_first_checkpoint_commit();

-- Keep the complete prior selection-intent/wait guard below byte-for-byte
-- apart from the closed birth-only early branch. The independent initial9
-- claim trigger is untouched; all earlier phase/lease/attempt guards remain.

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  -- Only the actual original owner's same-TX native17/FIRST/row/head can
  -- save18. A second mutation or any tuple/lease/attempt/schedule change fails.
  -- This branch still cannot COMMIT or release/consume a continuation.
  IF TG_OP='UPDATE' AND (OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
    OR NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3') THEN
    IF NOT app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW) THEN
      RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
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
  IF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'
    OR receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
