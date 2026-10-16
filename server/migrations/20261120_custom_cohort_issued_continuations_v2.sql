-- Dormant successful V2 continuation, separate from the five failed claims.
-- This does not complete a capture, transfer pins, or authorize source access.
CREATE TABLE app.neighborhood_custom_cohort_v2_continuations (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 4000002),
  phase text NOT NULL CHECK(phase IN ('frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2')),
  progress_reference jsonb NOT NULL CHECK(octet_length(progress_reference::text) BETWEEN 100 AND 256),
  issued_claim_token uuid NOT NULL,
  issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  consumed_claim_token uuid CHECK(consumed_claim_token IS NULL OR consumed_claim_token<>issued_claim_token)
);
CREATE INDEX neighborhood_cohort_v2_continuations_pending
  ON app.neighborhood_custom_cohort_v2_continuations(operation_id) WHERE consumed_claim_token IS NULL;

CREATE FUNCTION app.guard_neighborhood_cohort_v2_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; actual_reference jsonb; actual_sequence integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_v2_continuation_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000';
  END IF;
  IF NEW.phase='frozen_stock_traversal_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>7 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_recorded_partition_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>8 THEN
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
    -- Consume exactly once while the job is still released. Its next update
    -- must install THIS fresh token without incrementing/resetting attempts.
    IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.attempts<>NEW.issued_attempts OR job.cancellation_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token
    OR job.attempts<>NEW.issued_attempts OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR NEW.consumed_claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>1 THEN RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.sequence<>OLD.sequence+1
      OR OLD.consumed_claim_token IS NULL OR (NEW.issued_attempts=OLD.issued_attempts AND NEW.issued_claim_token<>OLD.consumed_claim_token)
      OR NEW.issued_attempts<OLD.issued_attempts OR NEW.progress_reference=OLD.progress_reference THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cohort_v2_continuation_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_v2_continuations FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_v2_continuation();

CREATE FUNCTION app.guard_neighborhood_cohort_v2_continuation_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=OLD.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
    OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.attempts<OLD.attempts THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_attempt_history_conflict' USING ERRCODE='55000'; END IF;
  IF c.consumed_claim_token IS NULL THEN
    IF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.attempts<>OLD.attempts OR NEW.context_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='running' AND OLD.claim_token=c.issued_claim_token AND OLD.attempts=c.issued_attempts
      AND OLD.lease_expires_at>clock_timestamp() AND OLD.cancellation_requested_at IS NULL
      AND NEW.status='retry' AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.cancellation_requested_at IS NULL AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code THEN RETURN NEW; END IF;
    -- Ordinary cancellation remains effective; it never consumes a success or
    -- converts pending progress into a terminal context/publication.
    IF OLD.status='retry' AND NEW.status IN ('retry','cancelled') AND NEW.cancellation_requested_at IS NOT NULL
      AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000';
  END IF;
  IF OLD.status='retry' AND OLD.claim_token IS NULL AND NEW.status='running' AND NEW.attempts=OLD.attempts THEN
    IF NEW.claim_token IS DISTINCT FROM c.consumed_claim_token OR NEW.claim_token=c.issued_claim_token
      OR NEW.lease_expires_at<=clock_timestamp() OR NEW.cancellation_requested_at IS NOT NULL
      OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cohort_v2_continuation_job_guard BEFORE UPDATE
  ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_v2_continuation_job();

CREATE FUNCTION app.check_neighborhood_cohort_v2_continuation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.checkpoint->>'phase' IS DISTINCT FROM c.phase OR job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM c.progress_reference
    OR job.attempts<>c.issued_attempts OR job.context_sha256 IS NOT NULL
    OR (c.consumed_claim_token IS NULL AND (job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL))
    OR (c.consumed_claim_token IS NOT NULL AND (job.status<>'running' OR job.claim_token IS DISTINCT FROM c.consumed_claim_token
      OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_cohort_v2_continuation_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_v2_continuations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_cohort_v2_continuation_commit();
CREATE FUNCTION app.refuse_neighborhood_cohort_v2_continuation_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_v2_continuation_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER neighborhood_cohort_v2_continuation_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_v2_continuations FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_neighborhood_cohort_v2_continuation_truncate();
COMMENT ON TABLE app.neighborhood_custom_cohort_v2_continuations IS
  'Dormant issued-progress success continuation. Owner must reopen originals/current authority at both ends before release in same TX. Actual native head/checkpoint required; progress cannot be yielded twice. Fresh-token consumption preserves attempts/failure history, never widens five-failure cap or completes context/releases pins. Not selected-union/source/publication authority.';
