-- Unregistered. Compose after 20261210 before enabling any native queue.
CREATE TABLE app.neighborhood_custom_cohort_initial_v2_jobs (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL, report_file_id uuid NOT NULL, assignment_file_id bigint NOT NULL,
  account_id text NOT NULL, actor_user_id uuid NOT NULL, request_sha256 text NOT NULL,
  issued_transaction_id bigint NOT NULL DEFAULT txid_current(),
  claim_token uuid, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  claim_transaction_id bigint CHECK(claim_transaction_id>0),
  CHECK((claim_token IS NULL)=(attempts=0)), CHECK((claim_token IS NULL)=(claim_transaction_id IS NULL))
);
CREATE FUNCTION app.guard_neighborhood_initial_v2_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_initial_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR NEW.report_file_id<>job.report_file_id
    OR NEW.assignment_file_id<>job.assignment_file_id OR NEW.account_id<>job.account_id
    OR NEW.actor_user_id<>job.actor_user_id OR NEW.request_sha256<>job.request_sha256
    OR job.request_payload->>'execution_mode' IS DISTINCT FROM 'frozen-originals-v2'
    OR job.request_payload->'discovery'->>'profile_id' IS DISTINCT FROM 'custom-suburban-radius-v2'
    OR job.request_payload ? 'private_sales_import' THEN
    RAISE EXCEPTION 'neighborhood_initial_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.issued_transaction_id<>txid_current() OR NEW.claim_token IS NOT NULL OR NEW.attempts<>0 OR NEW.claim_transaction_id IS NOT NULL
      OR (NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_initial_v2_jobs e WHERE e.operation_id=NEW.operation_id)
        AND (job.status<>'queued' OR job.attempts<>0 OR job.checkpoint IS NOT NULL OR job.claim_token IS NOT NULL
          OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prepared_generation_pins p WHERE p.operation_id=NEW.operation_id))) THEN
      RAISE EXCEPTION 'neighborhood_initial_v2_pristine_queue_required' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['claim_token','attempts','claim_transaction_id'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['claim_token','attempts','claim_transaction_id'])
      OR NEW.claim_token IS NULL OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token
      OR NEW.attempts<>job.attempts+1 OR job.attempts>=5 OR job.attempts<>OLD.attempts
      OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
      OR NOT (job.checkpoint IS NULL OR job.checkpoint->>'phase' IN ('subject','frozen_stock_v1'))
      OR NOT (job.status IN ('queued','retry') AND job.run_after<=clock_timestamp()
        OR job.status='running' AND job.lease_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'neighborhood_initial_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    NEW.claim_transaction_id:=txid_current();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_initial_v2_job_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_initial_v2_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_initial_v2_job();
CREATE TRIGGER neighborhood_initial_v2_job_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_initial_v2_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_initial_v2_jobs FROM PUBLIC;

CREATE FUNCTION app.check_neighborhood_initial_v2_claim_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  e app.neighborhood_custom_cohort_initial_v2_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT e FROM app.neighborhood_custom_cohort_initial_v2_jobs WHERE operation_id=NEW.operation_id;
  IF e.claim_token IS NULL THEN
    IF job.status<>'queued' OR job.attempts<>0 OR job.checkpoint IS NOT NULL OR job.claim_token IS NOT NULL
      OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_initial_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  ELSIF e.claim_transaction_id<>txid_current() OR job.status<>'running' OR job.claim_token IS DISTINCT FROM e.claim_token
    OR job.attempts<>e.attempts OR job.lease_expires_at<=clock_timestamp() OR job.context_sha256 IS NOT NULL
    OR job.cancellation_requested_at IS NOT NULL
    OR NOT (job.checkpoint IS NULL OR job.checkpoint->>'phase' IN ('subject','frozen_stock_v1')) THEN
    RAISE EXCEPTION 'neighborhood_initial_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_initial_v2_claim_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_initial_v2_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_initial_v2_claim_commit();

CREATE FUNCTION app.guard_neighborhood_initial_v2_job_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_initial_v2_jobs e WHERE e.operation_id=OLD.operation_id)
    AND (NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.attempts<OLD.attempts) THEN
    RAISE EXCEPTION 'neighborhood_initial_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.request_payload->>'execution_mode'='frozen-originals-v2' AND NEW.status='running'
    AND (OLD.status<>'running' OR OLD.lease_expires_at<=clock_timestamp() OR NEW.claim_token IS DISTINCT FROM OLD.claim_token)
    AND (OLD.checkpoint IS NULL OR OLD.checkpoint->>'phase' IN ('subject','frozen_stock_v1'))
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_initial_v2_jobs e WHERE e.operation_id=NEW.operation_id
      AND e.organization_id=NEW.organization_id AND e.actor_user_id=NEW.actor_user_id AND e.request_sha256=NEW.request_sha256
      AND e.claim_token=NEW.claim_token AND e.attempts=NEW.attempts AND e.claim_transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'neighborhood_initial_v2_claim_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_initial_v2_job_claim BEFORE UPDATE
  ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_initial_v2_job_claim();

CREATE FUNCTION app.check_neighborhood_initial_v2_queue_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.request_payload->>'execution_mode'='frozen-originals-v2'
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_initial_v2_jobs e WHERE e.operation_id=job.operation_id
      AND e.organization_id=job.organization_id AND e.report_file_id=job.report_file_id AND e.assignment_file_id=job.assignment_file_id
      AND e.account_id=job.account_id AND e.actor_user_id=job.actor_user_id AND e.request_sha256=job.request_sha256) THEN
    RAISE EXCEPTION 'neighborhood_initial_v2_enrollment_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_initial_v2_queue_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_capture_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_initial_v2_queue_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_initial_v2_jobs IS
  'Dormant explicit frozen-originals-v2 queue enrollment and native single-use initial claim. Actor/request/scope immutable. Initial/failed recovery spends existing five-attempt budget; successful stock then prefix owners retain current and ending rights and atomically transfer to prefix success. Routing DATA grants no source rights, selected completeness, publication or pin retirement.';
