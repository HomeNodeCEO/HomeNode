-- Dormant worker adoption of a real authenticated NEW-study lease only.
-- Not registered: no queue, source grant, selected member or publication.
CREATE TABLE app.neighborhood_custom_cohort_selected_initial_dispatch_v2 (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  claim_token uuid NOT NULL UNIQUE,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 5),
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  issued_transaction_id bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(operation_id,claim_token),
  UNIQUE(operation_id,attempts)
);

CREATE FUNCTION app.check_neighborhood_selected_initial_dispatch_v2(operation uuid, token uuid, attempt integer,
  organization uuid, command uuid, actor uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  intent app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=operation;
  SELECT * INTO STRICT intent FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=operation;
  RETURN job.organization_id=organization AND intent.organization_id=organization AND intent.command_id=command
    AND job.actor_user_id=actor AND job.claim_token=token AND job.attempts=attempt
    AND job.status='running' AND job.lease_expires_at>clock_timestamp()
    AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
    AND job.request_sha256=intent.request_sha256 AND job.checkpoint=intent.checkpoint
    AND job.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2'
    AND jsonb_array_length(job.checkpoint->'evidence_refs')=9
    AND attempt>=intent.issued_attempts
    AND CASE WHEN attempt=intent.issued_attempts THEN token=intent.resume_claim_token
      ELSE token<>intent.resume_claim_token END;
END $$;

CREATE FUNCTION app.guard_neighborhood_selected_initial_dispatch_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'neighborhood_selected_initial_dispatch_v2_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.issued_transaction_id<>txid_current() OR
    app.check_neighborhood_selected_initial_dispatch_v2(NEW.operation_id,NEW.claim_token,NEW.attempts,
      NEW.organization_id,NEW.command_id,NEW.actor_user_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'neighborhood_selected_initial_dispatch_v2_live_intent_required' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_initial_dispatch_v2_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_initial_dispatch_v2 FOR EACH ROW
  EXECUTE FUNCTION app.guard_neighborhood_selected_initial_dispatch_v2();

CREATE FUNCTION app.check_neighborhood_selected_initial_dispatch_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.check_neighborhood_selected_initial_dispatch_v2(NEW.operation_id,NEW.claim_token,NEW.attempts,
    NEW.organization_id,NEW.command_id,NEW.actor_user_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'neighborhood_selected_initial_dispatch_v2_orphan_claim' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_initial_dispatch_v2_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_initial_dispatch_v2 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_initial_dispatch_v2_commit();

CREATE FUNCTION app.refuse_neighborhood_selected_initial_dispatch_v2_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_selected_initial_dispatch_v2_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER neighborhood_selected_initial_dispatch_v2_no_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_selected_initial_dispatch_v2 FOR EACH STATEMENT
  EXECUTE FUNCTION app.refuse_neighborhood_selected_initial_dispatch_v2_truncate();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_initial_dispatch_v2 IS
  'Dormant single-adopter ledger for the real authenticated NEW-study lease or ordinary recovery. At most five attempts per operation. No source authorization, caller choice, membership, statistic, publication or pin release; actual original owner must recheck all current rights and originals before advancing.';
