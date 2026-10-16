-- Unregistered successor to 20261209. No initial adoption, route or schedule.
CREATE TABLE app.neighborhood_custom_cohort_prefix_success_v2_jobs (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL, actor_user_id uuid NOT NULL, request_sha256 text NOT NULL,
  issued_transaction_id bigint NOT NULL DEFAULT txid_current()
);
CREATE FUNCTION app.guard_neighborhood_prefix_success_v2_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_prefix_success_v2_job_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR NEW.actor_user_id<>job.actor_user_id OR NEW.request_sha256<>job.request_sha256
    OR NEW.issued_transaction_id<>txid_current() OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR (NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2_jobs e WHERE e.operation_id=NEW.operation_id)
      AND (job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_v1' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>2
        OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_prefix_v2_heads h WHERE h.operation_id=NEW.operation_id))) THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_job_binding_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_prefix_success_v2_job_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_prefix_success_v2_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_prefix_success_v2_job();
CREATE TRIGGER neighborhood_prefix_success_v2_job_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_prefix_success_v2_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_prefix_success_v2_jobs FROM PUBLIC;

-- Prefix pages have their own finite sequence. They never spend or widen any
-- existing graph/geographic/identity continuation sequence ceiling.
CREATE TABLE app.neighborhood_custom_cohort_prefix_success_v2 (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_prefix_success_v2_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000),
  source_reference jsonb NOT NULL, root_reference jsonb NOT NULL,
  issued_claim_token uuid NOT NULL, issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  consumed_claim_token uuid CHECK(consumed_claim_token IS NULL OR consumed_claim_token<>issued_claim_token),
  consumed_attempts integer CHECK(consumed_attempts BETWEEN 1 AND 5),
  CHECK((consumed_claim_token IS NULL)=(consumed_attempts IS NULL))
);
CREATE FUNCTION app.guard_neighborhood_prefix_success_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_prefix_success_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR h.organization_id<>job.organization_id
    OR h.actor_user_id<>job.actor_user_id OR h.request_sha256<>job.request_sha256
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2_jobs e WHERE e.operation_id=job.operation_id
      AND e.organization_id=job.organization_id AND e.actor_user_id=job.actor_user_id AND e.request_sha256=job.request_sha256)
    OR NEW.sequence<>h.sequence OR NEW.source_reference IS DISTINCT FROM h.source_reference OR NEW.root_reference IS DISTINCT FROM h.root_reference
    OR job.checkpoint IS DISTINCT FROM jsonb_build_object('phase','frozen_source_refs_v2',
      'evidence_refs',jsonb_build_array(h.subject_reference,h.stock_reference,h.source_reference))
    OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['consumed_claim_token','consumed_attempts'])=(to_jsonb(OLD)-ARRAY['consumed_claim_token','consumed_attempts'])
    AND NEW.consumed_claim_token IS NOT NULL AND NEW.consumed_claim_token IS DISTINCT FROM OLD.consumed_claim_token THEN
    -- One fresh success claim, or an ordinary failed/expired recovery. Only
    -- recovery spends an attempt, in the paired job write checked at COMMIT.
    IF OLD.consumed_claim_token IS NULL THEN
      IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.attempts<>NEW.issued_attempts
        OR NEW.consumed_attempts IS DISTINCT FROM job.attempts OR job.run_after>clock_timestamp() THEN
        RAISE EXCEPTION 'neighborhood_prefix_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    ELSIF job.attempts>=5 OR job.attempts IS DISTINCT FROM OLD.consumed_attempts
      OR NEW.consumed_attempts IS DISTINCT FROM job.attempts+1
      OR NOT (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'neighborhood_prefix_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF h.issued_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running'
    OR job.lease_expires_at<=clock_timestamp() OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token
    OR job.attempts<>NEW.issued_attempts OR h.issued_claim_token IS DISTINCT FROM NEW.issued_claim_token
    OR h.issued_attempts<>NEW.issued_attempts OR NEW.consumed_claim_token IS NOT NULL OR NEW.consumed_attempts IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_issuance_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>1 AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2 c WHERE c.operation_id=NEW.operation_id) THEN
      RAISE EXCEPTION 'neighborhood_prefix_success_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.sequence<>OLD.sequence+1
    OR NEW.source_reference=OLD.source_reference OR NEW.root_reference=OLD.root_reference
    OR OLD.consumed_claim_token IS DISTINCT FROM job.claim_token OR OLD.consumed_attempts IS DISTINCT FROM job.attempts
    OR OLD.consumed_claim_token IS NULL OR job.attempts<OLD.issued_attempts THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_prefix_success_v2_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_prefix_success_v2 FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_prefix_success_v2();
CREATE TRIGGER neighborhood_prefix_success_v2_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_prefix_success_v2 FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_prefix_success_v2 FROM PUBLIC;

CREATE FUNCTION app.assert_neighborhood_prefix_success_v2_commit(operation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
  c app.neighborhood_custom_cohort_prefix_success_v2%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=operation;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=operation;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_prefix_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO c FROM app.neighborhood_custom_cohort_prefix_success_v2 WHERE operation_id=operation;
  IF NOT FOUND OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
    OR c.sequence<>h.sequence OR c.source_reference IS DISTINCT FROM h.source_reference OR c.root_reference IS DISTINCT FROM h.root_reference
    OR job.checkpoint IS DISTINCT FROM jsonb_build_object('phase','frozen_source_refs_v2',
      'evidence_refs',jsonb_build_array(h.subject_reference,h.stock_reference,h.source_reference)) THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF c.consumed_claim_token IS NULL THEN
    IF h.issued_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'retry' OR job.claim_token IS NOT NULL
      OR job.lease_expires_at IS NOT NULL OR c.issued_attempts<>job.attempts OR c.issued_claim_token<>h.issued_claim_token THEN
      RAISE EXCEPTION 'neighborhood_prefix_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  ELSIF job.status<>'running' OR job.claim_token IS DISTINCT FROM c.consumed_claim_token OR job.lease_expires_at<=clock_timestamp()
    OR job.attempts IS DISTINCT FROM c.consumed_attempts OR job.attempts<c.issued_attempts OR job.attempts>5 THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN;
END $$;
CREATE FUNCTION app.check_neighborhood_prefix_success_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.assert_neighborhood_prefix_success_v2_commit(NEW.operation_id);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_prefix_success_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_prefix_success_v2 DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_prefix_success_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_prefix_success_v2_job_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_prefix_success_v2_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_prefix_success_v2_commit();

-- Preserve the manual native-prefix contract for unenrolled jobs. Enrolled
-- original owners must instead release their lease with a fresh native success.
CREATE OR REPLACE FUNCTION app.check_neighborhood_source_prefix_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
BEGIN
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2_jobs e WHERE e.operation_id=NEW.operation_id) THEN
    PERFORM app.assert_neighborhood_prefix_success_v2_commit(NEW.operation_id);
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF h.issued_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running'
    OR job.claim_token IS DISTINCT FROM h.issued_claim_token OR job.attempts<>h.issued_attempts
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint IS DISTINCT FROM jsonb_build_object('phase','frozen_source_refs_v2',
      'evidence_refs',jsonb_build_array(h.subject_reference,h.stock_reference,h.source_reference)) THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.guard_neighborhood_prefix_success_v2_job_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2_jobs e WHERE e.operation_id=OLD.operation_id)
    AND (NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.attempts<OLD.attempts) THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF OLD.checkpoint->>'phase'='frozen_source_refs_v2' AND NEW.status='running'
    AND (OLD.status<>'running' OR NEW.claim_token IS DISTINCT FROM OLD.claim_token)
    AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2_jobs e WHERE e.operation_id=NEW.operation_id)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prefix_success_v2 c WHERE c.operation_id=NEW.operation_id
      AND c.organization_id=NEW.organization_id AND c.consumed_claim_token=NEW.claim_token AND c.consumed_attempts=NEW.attempts) THEN
    RAISE EXCEPTION 'neighborhood_prefix_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_prefix_success_v2_job_claim BEFORE UPDATE
  ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_prefix_success_v2_job_claim();
