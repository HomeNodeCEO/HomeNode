-- UNREGISTERED provisional atomic18 handoff. No durable/fresh18 admission,
-- recovery, activation, NEXT, publication or pin transfer. All five earlier
-- unconditional COMMIT refusals remain, with a sixth for this handoff row.
-- Capture the ENTIRE actual17 job BEFORE the owned18 transition, not a
-- projection made by stripping the new checkpoint or rewriting a native job.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_handoffs (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_parents(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence=1),
 birth_job jsonb NOT NULL CHECK(octet_length(birth_job::text) BETWEEN 100 AND 32768),
 checkpoint jsonb NOT NULL CHECK(octet_length(checkpoint::text) BETWEEN 100 AND 4096),
 issued_claim_token uuid NOT NULL,
 issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0)
);

CREATE FUNCTION app.neighborhood_source_resolution_v3_native_first_handoff(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_handoffs
LANGUAGE sql VOLATILE AS $$
 SELECT job.operation_id,job.organization_id,1,to_jsonb(job),cp.checkpoint,
  job.claim_token,job.attempts,txid_current()
 FROM app.neighborhood_source_resolution_v3_native_parent(op,org) actual
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p
  ON p.operation_id=actual.operation_id AND to_jsonb(p)=to_jsonb(actual)
 JOIN app.neighborhood_custom_cohort_capture_jobs job
  ON job.operation_id=p.operation_id AND job.organization_id=p.organization_id
  AND job.report_file_id=p.report_file_id AND job.assignment_file_id=p.assignment_file_id
  AND job.account_id=p.account_id AND job.actor_user_id=p.actor_user_id AND job.request_sha256=p.request_sha256
  AND job.claim_token=p.issued_claim_token AND job.attempts=p.issued_attempts AND job.checkpoint=p.parent_checkpoint
 CROSS JOIN LATERAL (SELECT app.neighborhood_source_resolution_v3_first_checkpoint(op,org) AS checkpoint) cp
 WHERE p.issued_transaction_id=txid_current() AND cp.checkpoint IS NOT NULL
  AND job.status='running' AND job.lease_expires_at>clock_timestamp()
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_native_first_handoff(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual app.neighborhood_custom_cohort_source_resolution_v3_handoffs%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_source_resolution_v3_handoff_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO actual FROM app.neighborhood_source_resolution_v3_native_first_handoff(NEW.operation_id,NEW.organization_id);
 IF actual.operation_id IS NULL OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(actual) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_handoff_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_first_handoff_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_handoffs FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first_handoff();
CREATE TRIGGER neighborhood_source_resolution_v3_first_handoff_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_handoffs FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE FUNCTION app.reject_neighborhood_source_resolution_v3_first_handoff_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_source_resolution_v3_handoff_unintegrated' USING ERRCODE='55000'; END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_first_handoff_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_handoffs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_first_handoff_commit();

-- OLD and NEW are native trigger rows. Every non-transition field (including
-- attempts, error history, request, actor/assignment/draft target and context)
-- remains identical. A valid eighteen-root shape alone cannot clear a claim.
-- The writer consumes INSERT RETURNING directly; these VOLATILE predicates
-- also observe the caller statement's INSERT when independently checking the
-- real immutable row. Keep this volatility: STABLE snapshots cannot do that.
-- https://www.postgresql.org/docs/current/xfunc-volatility.html
CREATE FUNCTION app.neighborhood_source_resolution_v3_first_handoff_transition_matches(
 old_job app.neighborhood_custom_cohort_capture_jobs,new_job app.neighborhood_custom_cohort_capture_jobs)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_capture_jobs actual
  JOIN app.neighborhood_custom_cohort_source_resolution_v3_handoffs h
   ON h.operation_id=actual.operation_id AND h.organization_id=actual.organization_id
  JOIN app.neighborhood_source_resolution_v3_native_first_handoff(actual.operation_id,actual.organization_id) native
   ON to_jsonb(h)=to_jsonb(native)
  WHERE actual.operation_id=old_job.operation_id AND to_jsonb(actual)=to_jsonb(old_job)
   AND h.birth_job=to_jsonb(old_job) AND h.issued_transaction_id=txid_current()
   AND old_job.status='running' AND old_job.lease_expires_at>clock_timestamp()
   AND old_job.cancellation_requested_at IS NULL AND old_job.context_sha256 IS NULL
   AND old_job.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2'
   AND new_job.status='retry' AND new_job.claim_token IS NULL AND new_job.lease_expires_at IS NULL
   AND new_job.checkpoint=h.checkpoint
   AND new_job.run_after BETWEEN transaction_timestamp() AND clock_timestamp()
   AND new_job.updated_at BETWEEN transaction_timestamp() AND clock_timestamp()
   AND (to_jsonb(new_job)-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])
    =(to_jsonb(old_job)-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])),false)
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_first_handoff_transition_matches(
 app.neighborhood_custom_cohort_capture_jobs,app.neighborhood_custom_cohort_capture_jobs) FROM PUBLIC;

-- The two prior trigger bodies are retained below. Their only change admits
-- this exact native full-tuple birth handoff alongside the previous birth-only
-- checkpoint save. Later provisional18 mutations remain forbidden. The
-- independent initial9 guard and every deferred COMMIT refusal are untouched.

CREATE OR REPLACE FUNCTION app.guard_neighborhood_source_resolution_v3_first_checkpoint_job() RETURNS trigger LANGUAGE plpgsql AS $$
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
  AND NOT (app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW)
      OR app.neighborhood_source_resolution_v3_first_handoff_transition_matches(OLD,NEW)) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  -- Only the actual original owner's same-TX native17/FIRST/row/head can
  -- save18. A second mutation or any tuple/lease/attempt/schedule change fails.
  -- This branch still cannot COMMIT or release/consume a continuation.
  IF TG_OP='UPDATE' AND (OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
    OR NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3') THEN
    IF NOT (app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW)
      OR app.neighborhood_source_resolution_v3_first_handoff_transition_matches(OLD,NEW)) THEN
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
