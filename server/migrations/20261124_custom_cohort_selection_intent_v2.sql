-- Dormant explicit NEW-study intent; NOT selected membership or source facts.
CREATE TABLE app.neighborhood_custom_cohort_v2_selection_intents (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE,
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  checkpoint jsonb NOT NULL CHECK(octet_length(checkpoint::text) BETWEEN 100 AND 4096),
  profile_reference jsonb NOT NULL CHECK(octet_length(profile_reference::text) BETWEEN 100 AND 256),
  workspace_revision integer NOT NULL CHECK(workspace_revision>0),
  workspace_checkpoint jsonb NOT NULL CHECK(octet_length(workspace_checkpoint::text) BETWEEN 10 AND 65536),
  included_group_ids jsonb NOT NULL CHECK(jsonb_typeof(included_group_ids)='array' AND octet_length(included_group_ids::text)<=200000),
  issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  resume_claim_token uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION app.guard_neighborhood_cohort_v2_selection_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb; workspace record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_v2_selection_intent_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'awaiting_selection' OR job.claim_token IS NOT NULL
    OR job.lease_expires_at IS NOT NULL OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.attempts<>NEW.issued_attempts OR job.request_sha256<>NEW.request_sha256 OR job.checkpoint IS DISTINCT FROM NEW.checkpoint
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'
    OR jsonb_array_length(job.checkpoint->'evidence_refs') IS DISTINCT FROM 9
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c WHERE c.operation_id=job.operation_id
      AND NEW.resume_claim_token IN (c.issued_claim_token,c.consumed_claim_token)) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_waiting_required' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads
    WHERE operation_id=job.operation_id AND organization_id=job.organization_id;
  IF head.stock_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->1
    OR head.source_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->2
    OR head.graph_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->3
    OR head.geographic_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->4
    OR head.identity_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->5
    OR head.traversal_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->6
    OR head.partition_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->7
    OR head.receipt_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->8
    OR head.profile_reference IS DISTINCT FROM NEW.profile_reference THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=job.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'
    OR receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  -- These are only known catalog ID choices, never authoritative group counts
  -- or eligibility. Complete original reconciliation remains the real owner.
  IF jsonb_array_length(NEW.included_group_ids)>2049
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.included_group_ids) AS items(v) WHERE jsonb_typeof(v)<>'string')<>0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id)
      WHERE id !~ '^(recorded-cad:[a-f0-9]{64}|discovery:unassigned)$')
    OR (SELECT count(*) FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id) WHERE id<>'discovery:unassigned')>2048
    OR (SELECT count(*) FROM jsonb_array_elements_text(NEW.included_group_ids))
      <>(SELECT count(DISTINCT id) FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id)
      WHERE NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
        WHERE g.operation_id=job.operation_id AND g.organization_id=job.organization_id AND g.group_id=id)) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_group_conflict' USING ERRCODE='55000'; END IF;
  SELECT revision,section_value INTO STRICT workspace FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=job.assignment_file_id AND section_key='neighborhood_workspace' FOR SHARE NOWAIT;
  IF workspace.revision<>NEW.workspace_revision OR workspace.section_value IS DISTINCT FROM NEW.workspace_checkpoint
    OR NEW.workspace_checkpoint->>'workspace_version' IS DISTINCT FROM '7'
    OR NEW.workspace_checkpoint->'pending_capture'->>'operation_id' IS DISTINCT FROM job.operation_id::text
    OR NEW.workspace_checkpoint->'pending_capture'->'observation_period' IS DISTINCT FROM job.request_payload->'observation_period'
    OR NEW.workspace_checkpoint->'pending_capture'->'discovery' IS DISTINCT FROM job.request_payload->'discovery'
    OR NEW.workspace_checkpoint->'pending_capture'->'private_sales_import' IS DISTINCT FROM job.request_payload->'private_sales_import'
    OR NEW.workspace_checkpoint->'active'->'context_ref'->>'context_id'=job.operation_id::text THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_workspace_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cohort_v2_selection_intent_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_v2_selection_intents FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_v2_selection_intent();
CREATE FUNCTION app.refuse_neighborhood_cohort_v2_selection_intent_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_v2_selection_intent_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER neighborhood_cohort_v2_selection_intent_no_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_v2_selection_intents FOR EACH STATEMENT EXECUTE FUNCTION app.refuse_neighborhood_cohort_v2_selection_intent_truncate();

CREATE FUNCTION app.check_neighborhood_cohort_v2_selection_intent_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.resume_claim_token
    OR job.attempts<>NEW.issued_attempts OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR job.context_sha256 IS NOT NULL OR job.request_sha256<>NEW.request_sha256 OR job.checkpoint IS DISTINCT FROM NEW.checkpoint THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_orphan_resume' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_cohort_v2_selection_intent_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_v2_selection_intents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_cohort_v2_selection_intent_commit();

-- Preserve the previous waiting boundary verbatim unless this exact immutable
-- command authorizes its one fresh resume. No worker/general retry can do so.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2') THEN
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
      OR NEW.checkpoint IS DISTINCT FROM command.checkpoint OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase'='frozen_recorded_catalog_refs_v2' THEN
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
COMMENT ON TABLE app.neighborhood_custom_cohort_v2_selection_intents IS
  'Immutable explicit NEW-study group-ID intent only. Actual authenticated original owner checks current actor/assignment/private draft/subject/source rights and pending V7/prior head both ends in ONE 256-query/32MB/60s transaction; provisional command and fresh 120s lease roll back on every refusal. No complete catalog semantic replay, selected union, statistics, publication, source acquisition, context completion or pin transfer is established.';
