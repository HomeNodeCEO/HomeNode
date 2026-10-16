-- UNREGISTERED: compose the complete CAD owner/worker/stock adoption together.
-- No worker schedule, source grant, consumer/publication or pin activation.
CREATE TABLE app.neighborhood_custom_cohort_cad_success_v2_jobs (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_neutral_success_v2_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL,report_file_id uuid NOT NULL,assignment_file_id bigint NOT NULL,account_id text NOT NULL,
  actor_user_id uuid NOT NULL,request_sha256 text NOT NULL,
  cache_sequence integer NOT NULL CHECK(cache_sequence BETWEEN 1 AND 200000),
  cache_reference jsonb NOT NULL CHECK(octet_length(cache_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 2000001),
  receipt_reference jsonb CHECK(receipt_reference IS NULL OR octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  issued_claim_token uuid,issued_attempts integer CHECK(issued_attempts BETWEEN 1 AND 5),issued_transaction_id bigint CHECK(issued_transaction_id>0),
  issued_lease_expires_at timestamptz,
  consumed_claim_token uuid,consumed_attempts integer CHECK(consumed_attempts BETWEEN 1 AND 5),consumed_transaction_id bigint CHECK(consumed_transaction_id>0),
  cache_sha256 text GENERATED ALWAYS AS(cache_reference->>'content_sha256') STORED,
  receipt_sha256 text GENERATED ALWAYS AS(receipt_reference->>'content_sha256') STORED,
  FOREIGN KEY(organization_id,cache_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(organization_id,receipt_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK((sequence=0)=(receipt_reference IS NULL)),CHECK((sequence=0)=(issued_claim_token IS NULL)),
  CHECK((sequence=0)=(issued_attempts IS NULL)),CHECK((sequence=0)=(issued_transaction_id IS NULL)),
  CHECK((sequence=0)=(issued_lease_expires_at IS NULL)),
  CHECK((consumed_claim_token IS NULL)=(consumed_attempts IS NULL)),CHECK((consumed_claim_token IS NULL)=(consumed_transaction_id IS NULL)),
  CHECK(consumed_claim_token IS NULL OR consumed_claim_token IS DISTINCT FROM issued_claim_token)
);

-- Native metadata lineage, never source-purpose authority or original replay.
CREATE FUNCTION app.neighborhood_cad_success_v2_parent_matches(operation uuid,organization uuid,cache_sequence integer,cache_reference jsonb)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_capture_jobs job
    JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=job.operation_id AND c.organization_id=job.organization_id
    JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads h ON h.operation_id=e.operation_id AND h.organization_id=e.organization_id
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id AND b.content_sha256=h.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE job.operation_id=operation AND job.organization_id=organization
      AND job.request_payload->>'execution_mode'='frozen-originals-v2' AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL
      AND job.checkpoint->>'phase'='frozen_identity_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=6
      AND e.sequence=cache_sequence AND e.receipt_reference=cache_reference AND e.consumed_claim_token IS NULL
      AND h.sequence=e.sequence AND h.receipt_reference=e.receipt_reference AND h.identity_reference=e.identity_reference
      AND h.stock_reference=job.checkpoint->'evidence_refs'->1 AND h.source_reference=job.checkpoint->'evidence_refs'->2
      AND h.graph_reference=job.checkpoint->'evidence_refs'->3 AND h.geographic_reference=job.checkpoint->'evidence_refs'->4
      AND h.identity_reference=job.checkpoint->'evidence_refs'->5
      AND c.phase='frozen_identity_refs_v2' AND c.sequence=e.parent_sequence AND c.progress_reference=e.identity_reference
      AND c.consumed_claim_token=e.initial_claim_token
      AND b.canonical_utf8::jsonb->>'format'='cohort_neutral_cache_receipt_v2'
      AND b.canonical_utf8::jsonb->'after'->>'kind_index'='7' AND b.canonical_utf8::jsonb->'after'->'position'='null'::jsonb)
$$;
CREATE FUNCTION app.neighborhood_cad_success_v2_matches(operation uuid,organization uuid,token uuid,attempt integer)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e
    JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    WHERE e.operation_id=operation AND e.organization_id=organization AND e.consumed_claim_token=token AND e.consumed_attempts=attempt
      AND e.consumed_transaction_id>0 AND app.neighborhood_cad_success_v2_parent_matches(operation,organization,e.cache_sequence,e.cache_reference)
      AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges s WHERE s.operation_id=operation))
$$;
CREATE FUNCTION app.guard_neighborhood_cad_success_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  neutral app.neighborhood_custom_cohort_neutral_success_v2_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_cad_cache_v2_heads%ROWTYPE; body jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_cad_success_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT neutral FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR NEW.report_file_id<>job.report_file_id OR NEW.assignment_file_id<>job.assignment_file_id
    OR NEW.account_id<>job.account_id OR NEW.actor_user_id<>job.actor_user_id OR NEW.request_sha256<>job.request_sha256
    OR NOT app.neighborhood_cad_success_v2_parent_matches(NEW.operation_id,NEW.organization_id,NEW.cache_sequence,NEW.cache_reference)
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges s WHERE s.operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>0 OR h.operation_id IS NOT NULL OR NEW.consumed_claim_token IS NULL OR NEW.consumed_transaction_id IS NOT NULL
      OR NEW.consumed_claim_token IN(neutral.initial_claim_token,neutral.issued_claim_token)
      OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.run_after>clock_timestamp()
      OR NEW.consumed_attempts IS DISTINCT FROM job.attempts OR job.attempts<>neutral.issued_attempts THEN
      RAISE EXCEPTION 'neighborhood_cad_success_v2_initial_claim_conflict' USING ERRCODE='55000'; END IF;
    NEW.consumed_transaction_id:=txid_current();RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['sequence','receipt_reference','issued_claim_token','issued_attempts','issued_transaction_id','issued_lease_expires_at',
      'consumed_claim_token','consumed_attempts','consumed_transaction_id','receipt_sha256','cache_sha256']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['sequence','receipt_reference','issued_claim_token','issued_attempts','issued_transaction_id','issued_lease_expires_at',
      'consumed_claim_token','consumed_attempts','consumed_transaction_id','receipt_sha256','cache_sha256']) THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.sequence=OLD.sequence THEN
    IF NEW.receipt_reference IS DISTINCT FROM OLD.receipt_reference OR NEW.issued_claim_token IS DISTINCT FROM OLD.issued_claim_token
      OR NEW.issued_attempts IS DISTINCT FROM OLD.issued_attempts OR NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id
      OR NEW.issued_lease_expires_at IS DISTINCT FROM OLD.issued_lease_expires_at
      OR NEW.consumed_claim_token IS NULL OR NEW.consumed_claim_token IN(OLD.consumed_claim_token,OLD.issued_claim_token)
      OR NEW.consumed_transaction_id IS DISTINCT FROM OLD.consumed_transaction_id THEN
      RAISE EXCEPTION 'neighborhood_cad_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.sequence>0 THEN
      SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
        WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
          AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
      IF body->'after'->>'done' IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'neighborhood_cad_success_v2_DONE' USING ERRCODE='55000'; END IF;
    END IF;
    IF OLD.consumed_claim_token IS NULL THEN
      IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.run_after>clock_timestamp()
        OR job.attempts IS DISTINCT FROM OLD.issued_attempts OR NEW.consumed_attempts IS DISTINCT FROM job.attempts THEN
        RAISE EXCEPTION 'neighborhood_cad_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    ELSIF job.attempts IS DISTINCT FROM OLD.consumed_attempts OR job.attempts>=5 OR NEW.consumed_attempts IS DISTINCT FROM job.attempts+1
      OR NOT(job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'neighborhood_cad_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    NEW.consumed_transaction_id:=txid_current();RETURN NEW;
  END IF;
  IF NEW.sequence<>OLD.sequence+1 OR h.operation_id IS NULL OR h.sequence<>NEW.sequence OR h.receipt_reference IS DISTINCT FROM NEW.receipt_reference
    OR h.neutral_reference IS DISTINCT FROM NEW.cache_reference OR h.issued_transaction_id IS DISTINCT FROM txid_current()
    OR h.issued_claim_token IS DISTINCT FROM job.claim_token OR h.issued_attempts<>job.attempts
    OR job.status<>'running' OR (job.lease_expires_at>clock_timestamp()) IS DISTINCT FROM true
    OR OLD.consumed_claim_token IS DISTINCT FROM job.claim_token OR OLD.consumed_attempts IS DISTINCT FROM job.attempts
    OR NEW.issued_claim_token IS DISTINCT FROM job.claim_token OR NEW.issued_attempts IS DISTINCT FROM job.attempts
    OR NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id OR NEW.issued_lease_expires_at IS NOT NULL
    OR NEW.consumed_claim_token IS NOT NULL OR NEW.consumed_attempts IS NOT NULL OR NEW.consumed_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_issuance_conflict' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();NEW.issued_lease_expires_at:=job.lease_expires_at;RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cad_success_v2_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_cad_success_v2_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cad_success_v2();
CREATE TRIGGER neighborhood_cad_success_v2_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_cad_success_v2_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_cad_success_v2_jobs FROM PUBLIC;

CREATE FUNCTION app.assert_neighborhood_cad_success_v2_commit(operation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  e app.neighborhood_custom_cohort_cad_success_v2_jobs%ROWTYPE; h app.neighborhood_custom_cohort_cad_cache_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=operation;
  SELECT * INTO STRICT e FROM app.neighborhood_custom_cohort_cad_success_v2_jobs WHERE operation_id=operation;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=operation;
  IF NOT app.neighborhood_cad_success_v2_parent_matches(operation,e.organization_id,e.cache_sequence,e.cache_reference)
    OR e.sequence=0 AND h.operation_id IS NOT NULL
    OR e.sequence>0 AND (h.operation_id IS NULL OR h.sequence<>e.sequence OR h.receipt_reference IS DISTINCT FROM e.receipt_reference) THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF e.consumed_claim_token IS NULL THEN
    IF e.sequence=0 OR e.issued_transaction_id IS DISTINCT FROM txid_current() OR h.issued_transaction_id IS DISTINCT FROM txid_current()
      OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.attempts IS DISTINCT FROM e.issued_attempts OR h.issued_claim_token IS DISTINCT FROM e.issued_claim_token
      OR h.issued_attempts<>e.issued_attempts OR (e.issued_lease_expires_at>clock_timestamp()) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'neighborhood_cad_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  ELSIF e.consumed_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running'
    OR job.claim_token IS DISTINCT FROM e.consumed_claim_token OR job.attempts IS DISTINCT FROM e.consumed_attempts
    OR (job.lease_expires_at>clock_timestamp()) IS DISTINCT FROM true
    OR NOT app.neighborhood_cad_success_v2_matches(operation,e.organization_id,e.consumed_claim_token,e.consumed_attempts) THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION app.check_neighborhood_cad_success_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM app.assert_neighborhood_cad_success_v2_commit(NEW.operation_id);RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER neighborhood_cad_success_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_cad_success_v2_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_cad_success_v2_commit();

-- Activation is coherent only before this dormant stock stage has any rows.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges) THEN
  RAISE EXCEPTION 'neighborhood_cad_success_v2_stock_stage_already_enrolled' USING ERRCODE='55000'; END IF; END $$;
ALTER TABLE app.neighborhood_custom_cohort_cache_stock_v2_bridges ADD COLUMN cad_reference jsonb
  CHECK(cad_reference IS NULL OR octet_length(cad_reference::text) BETWEEN 100 AND 256);
ALTER TABLE app.neighborhood_custom_cohort_cache_stock_v2_bridges ADD COLUMN cad_sha256 text GENERATED ALWAYS AS(cad_reference->>'content_sha256') STORED;
ALTER TABLE app.neighborhood_custom_cohort_cache_stock_v2_bridges ADD FOREIGN KEY(organization_id,cad_sha256)
  REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION app.guard_neighborhood_cad_stock_adoption_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e app.neighborhood_custom_cohort_cad_success_v2_jobs%ROWTYPE; h app.neighborhood_custom_cohort_cad_cache_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT e FROM app.neighborhood_custom_cohort_cad_success_v2_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=e.organization_id AND content_sha256=e.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=e.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF e.organization_id<>NEW.organization_id OR e.report_file_id<>NEW.report_file_id OR e.assignment_file_id<>NEW.assignment_file_id
    OR e.account_id<>NEW.account_id OR e.actor_user_id<>NEW.actor_user_id OR e.request_sha256<>NEW.request_sha256
    OR e.cache_sequence<>NEW.cache_sequence OR e.cache_reference IS DISTINCT FROM NEW.cache_reference
    OR e.sequence=0 OR e.consumed_claim_token IS NOT NULL OR e.receipt_reference IS DISTINCT FROM NEW.cad_reference
    OR h.sequence<>e.sequence OR h.receipt_reference IS DISTINCT FROM e.receipt_reference OR h.neutral_reference IS DISTINCT FROM e.cache_reference
    OR body->>'format' IS DISTINCT FROM 'cohort_CAD_cache_coverage_receipt_v2' OR body->'after'->>'done' IS DISTINCT FROM 'true'
    OR NEW.claim_token IN(e.issued_claim_token) OR TG_OP='UPDATE' AND NEW.cad_reference IS DISTINCT FROM OLD.cad_reference THEN
    RAISE EXCEPTION 'neighborhood_cad_stock_adoption_v2_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cad_stock_adoption_v2_guard BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_cache_stock_v2_bridges FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cad_stock_adoption_v2();

CREATE FUNCTION app.guard_neighborhood_cad_success_v2_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e app.neighborhood_custom_cohort_cad_success_v2_jobs%ROWTYPE;
BEGIN
  SELECT * INTO e FROM app.neighborhood_custom_cohort_cad_success_v2_jobs WHERE operation_id=OLD.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
    OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.attempts<OLD.attempts THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges s WHERE s.operation_id=OLD.operation_id) THEN
    RETURN NEW; END IF;
  IF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_job_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.status='running' AND (OLD.status<>'running' OR OLD.lease_expires_at<=clock_timestamp() OR NEW.claim_token IS DISTINCT FROM OLD.claim_token)
    AND (e.consumed_claim_token IS DISTINCT FROM NEW.claim_token OR e.consumed_attempts IS DISTINCT FROM NEW.attempts
      OR e.consumed_transaction_id IS DISTINCT FROM txid_current() OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
      OR NEW.cancellation_requested_at IS NOT NULL OR (NEW.lease_expires_at>clock_timestamp()) IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'neighborhood_cad_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.status='retry' AND e.consumed_claim_token IS NULL THEN
    IF e.sequence=0 OR e.issued_transaction_id IS DISTINCT FROM txid_current() OR e.issued_claim_token IS DISTINCT FROM OLD.claim_token
      OR e.issued_attempts IS DISTINCT FROM OLD.attempts OR OLD.status<>'running' OR (OLD.lease_expires_at>clock_timestamp()) IS DISTINCT FROM true
      OR NEW.claim_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.attempts<>OLD.attempts
      OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code OR NEW.cancellation_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_cad_success_v2_release_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cad_success_v2_job_guard BEFORE UPDATE ON app.neighborhood_custom_cohort_capture_jobs
  FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cad_success_v2_job();
COMMENT ON TABLE app.neighborhood_custom_cohort_cad_success_v2_jobs IS
  'Inactive independent CAD success lane after native neutral DONE. Real whole-original/current-CAD owner, native head and same-transaction release, fresh claims, preserved five-failure history and saved lease deadline at COMMIT. Separate EMPTY/DONE excludes recovery and gates immutable first-stock adoption. No source grant, default worker, publication or pin transfer.';

-- Composed native overrides: original bodies retained except the explicit CAD bridge clauses.
CREATE OR REPLACE FUNCTION app.check_neighborhood_cad_cache_v2_binding(h app.neighborhood_custom_cohort_cad_cache_v2_heads)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  neutral app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
  cad app.neighborhood_frozen_cad_improvement_generations%ROWTYPE;
  original app.neighborhood_frozen_source_generations%ROWTYPE;
  cache app.neighborhood_frozen_typed_cad_generations%ROWTYPE;
  receipt jsonb; neutral_receipt jsonb; metadata jsonb; allowed_claim boolean;
BEGIN
  SELECT * INTO job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO neutral FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  allowed_claim:=job.request_payload->>'execution_mode' IS NULL
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=h.operation_id)
    AND job.status='running' AND job.lease_expires_at>clock_timestamp();
  IF job.request_payload->>'execution_mode'='frozen-originals-v2' THEN
    SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e
      WHERE e.operation_id=h.operation_id AND e.organization_id=h.organization_id AND e.cache_reference=h.neutral_reference
        AND app.neighborhood_cad_success_v2_parent_matches(e.operation_id,e.organization_id,e.cache_sequence,e.cache_reference)
        AND (job.status='running' AND job.lease_expires_at>clock_timestamp()
          AND e.consumed_claim_token=job.claim_token AND e.consumed_attempts=job.attempts AND h.sequence=e.sequence+1
          AND app.neighborhood_cad_success_v2_matches(e.operation_id,e.organization_id,job.claim_token,job.attempts)
        OR job.status='retry' AND job.claim_token IS NULL AND job.lease_expires_at IS NULL AND e.consumed_claim_token IS NULL
          AND e.sequence=h.sequence AND e.receipt_reference=h.receipt_reference AND e.issued_attempts=job.attempts
          AND e.issued_transaction_id=txid_current() AND e.issued_lease_expires_at>clock_timestamp())) INTO allowed_claim;
  END IF;
  IF job.organization_id<>h.organization_id OR allowed_claim IS DISTINCT FROM true
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR stock.organization_id<>h.organization_id OR stock.status<>'complete'
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM h.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM h.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM h.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM h.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM h.identity_reference
    OR neutral.organization_id<>h.organization_id OR neutral.source_reference<>h.source_reference
    OR neutral.root_reference<>h.root_reference OR neutral.graph_reference<>h.graph_reference
    OR neutral.geographic_reference<>h.geographic_reference OR neutral.identity_reference<>h.identity_reference
    OR neutral.stock_reference<>h.stock_reference OR neutral.receipt_reference<>h.neutral_reference
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prepared_generation_pins p
      JOIN app.neighborhood_group_generations g USING(generation_id)
      WHERE p.operation_id=h.operation_id AND p.generation_id=stock.generation_id
        AND g.status='complete' AND g.retirement_started_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_graph_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.receipt_reference=h.graph_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_geo_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.graph_reference=h.graph_reference AND a.stock_reference=h.stock_reference AND a.receipt_reference=h.geographic_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_identity_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.graph_reference=h.graph_reference AND a.geographic_reference=h.geographic_reference
      AND a.stock_reference=h.stock_reference AND a.receipt_reference=h.identity_reference) THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO neutral_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=h.organization_id AND content_sha256=h.neutral_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.neutral_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NOT FOUND OR neutral_receipt->>'format' IS DISTINCT FROM 'cohort_neutral_cache_receipt_v2'
    OR neutral_receipt->>'sequence' IS DISTINCT FROM neutral.sequence::text
    OR neutral_receipt->'after'->>'kind_index' IS DISTINCT FROM '7' THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_unfinished_neutral' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=h.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NOT FOUND OR receipt->>'format' IS DISTINCT FROM 'cohort_CAD_cache_coverage_receipt_v2'
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>19
    OR receipt->'binding' IS DISTINCT FROM neutral_receipt->'binding'
    OR receipt->'source_reference' IS DISTINCT FROM h.source_reference OR receipt->'root_reference' IS DISTINCT FROM h.root_reference
    OR receipt->'graph_reference' IS DISTINCT FROM h.graph_reference OR receipt->'geographic_reference' IS DISTINCT FROM h.geographic_reference
    OR receipt->'identity_reference' IS DISTINCT FROM h.identity_reference OR receipt->'stock_reference' IS DISTINCT FROM h.stock_reference
    OR receipt->'neutral_reference' IS DISTINCT FROM h.neutral_reference
    OR receipt->>'sequence' IS DISTINCT FROM h.sequence::text OR receipt->>'stock_account_count' IS DISTINCT FROM stock.account_count::text
    OR receipt->'cad_purpose'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'cad_purpose'->>'acquisition_scope' IS DISTINCT FROM 'retained_generation_only_no_current_core_or_provider_reads'
    OR (receipt->'cad_decision'->>'policy_revision' ~ '^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$') IS DISTINCT FROM true
    OR coalesce(length(receipt->'cad_decision'->>'decision_id'),0)=0 THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO cad FROM app.neighborhood_frozen_cad_improvement_generations WHERE generation_id=stock.generation_id;
  IF NOT FOUND OR cad.status<>'complete' THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO original FROM app.neighborhood_frozen_source_generations WHERE generation_id=stock.generation_id;
  IF NOT FOUND OR original.status<>'complete' OR original.source_snapshot<>cad.source_snapshot
    OR original.source_transaction_started_at<>cad.source_transaction_started_at THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
  metadata:=jsonb_build_object('generation_id',cad.generation_id::text,'format_version',cad.format_version,'status',cad.status,
    'source_snapshot',cad.source_snapshot,'started_at',to_char(cad.source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completed_at',to_char(cad.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source_profile_sha256',cad.profile_sha256,'source_definition_json',cad.definition_json,
    'layer_counts',cad.layer_counts,'row_count',cad.row_count::text,'payload_utf8_bytes',cad.payload_utf8_bytes::text);
  SELECT * INTO cache FROM app.neighborhood_frozen_typed_cad_generations
    WHERE generation_id=stock.generation_id AND profile_sha256=receipt->'typed_profile_reference'->>'content_sha256';
  IF NOT FOUND OR cache.status NOT IN ('building','complete') OR cache.source_metadata IS DISTINCT FROM metadata
    OR receipt->'cad_source_metadata' IS DISTINCT FROM metadata
    OR receipt->'cad_purpose'->'source_projection'->>'content_sha256' IS DISTINCT FROM cad.profile_sha256
    OR encode(sha256(convert_to(cache.definition_json,'UTF8')),'hex') IS DISTINCT FROM cache.profile_sha256
    OR octet_length(cache.definition_json)::text IS DISTINCT FROM receipt->'typed_profile_reference'->>'canonical_utf8_bytes' THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app.check_neighborhood_cad_cache_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_cad_cache_v2_heads%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e WHERE e.operation_id=NEW.operation_id) THEN
    PERFORM app.assert_neighborhood_cad_success_v2_commit(NEW.operation_id);
    PERFORM app.check_neighborhood_cad_cache_v2_binding(h);RETURN NEW;
  END IF;
  IF h.issued_transaction_id<>txid_current() OR job.claim_token IS DISTINCT FROM h.issued_claim_token OR job.attempts<>h.issued_attempts THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  PERFORM app.check_neighborhood_cad_cache_v2_binding(h);RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation_job() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF OLD.status='retry' AND NEW.status IN ('retry','cancelled') AND NEW.cancellation_requested_at IS NOT NULL
      AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000';
  END IF;
  IF OLD.status='retry' AND OLD.claim_token IS NULL AND NEW.status='running' AND NEW.attempts=OLD.attempts THEN
    IF (NEW.claim_token IS DISTINCT FROM c.consumed_claim_token AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
          AND e.organization_id=NEW.organization_id AND e.report_file_id=NEW.report_file_id AND e.assignment_file_id=NEW.assignment_file_id
          AND e.account_id=NEW.account_id AND e.actor_user_id=NEW.actor_user_id AND e.request_sha256=NEW.request_sha256
          AND c.phase='frozen_identity_refs_v2' AND c.sequence=e.parent_sequence AND c.progress_reference=e.identity_reference
          AND c.consumed_claim_token=e.initial_claim_token AND OLD.checkpoint->>'phase'='frozen_identity_refs_v2'
          AND OLD.checkpoint->'evidence_refs'->5=e.identity_reference
          AND e.consumed_claim_token=NEW.claim_token AND e.consumed_attempts=NEW.attempts AND e.consumed_transaction_id=txid_current()) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b WHERE b.operation_id=NEW.operation_id
          AND b.organization_id=NEW.organization_id AND b.claim_transaction_id=txid_current()
          AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,NEW.claim_token,NEW.attempts)) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
          AND e.organization_id=NEW.organization_id AND e.consumed_transaction_id=txid_current()
          AND app.neighborhood_cad_success_v2_matches(e.operation_id,e.organization_id,NEW.claim_token,NEW.attempts)))
      OR NEW.claim_token=c.issued_claim_token OR NEW.lease_expires_at<=clock_timestamp() OR NEW.cancellation_requested_at IS NOT NULL
      OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_neutral_success_v2_job_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=OLD.operation_id)
    AND (NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.attempts<OLD.attempts) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF OLD.checkpoint->>'phase'='frozen_identity_refs_v2' AND NEW.status='running'
    AND NEW.context_sha256 IS NULL AND NEW.checkpoint IS NOT DISTINCT FROM OLD.checkpoint
    AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code AND NEW.cancellation_requested_at IS NULL
    AND NEW.lease_expires_at>clock_timestamp() AND NEW.claim_token IS DISTINCT FROM OLD.claim_token
    AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
      AND e.organization_id=NEW.organization_id AND e.consumed_transaction_id=txid_current()
      AND app.neighborhood_cad_success_v2_matches(e.operation_id,e.organization_id,NEW.claim_token,NEW.attempts)) THEN RETURN NEW; END IF;
  IF OLD.checkpoint->>'phase'='frozen_identity_refs_v2' AND NEW.status='running'
    AND NEW.context_sha256 IS NULL AND NEW.checkpoint IS NOT DISTINCT FROM OLD.checkpoint AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
    AND NEW.cancellation_requested_at IS NULL AND NEW.lease_expires_at>clock_timestamp()
    AND NEW.claim_token IS DISTINCT FROM OLD.claim_token AND EXISTS(
      SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b WHERE b.operation_id=NEW.operation_id
        AND b.organization_id=NEW.organization_id AND b.claim_transaction_id=txid_current()
        AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,NEW.claim_token,NEW.attempts)) THEN RETURN NEW; END IF;
  IF OLD.checkpoint->>'phase'='frozen_identity_refs_v2' AND NEW.status='running'
    AND (OLD.status<>'running' OR OLD.lease_expires_at<=clock_timestamp() OR NEW.claim_token IS DISTINCT FROM OLD.claim_token)
    AND (EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=OLD.operation_id)
      OR OLD.request_payload->>'execution_mode'='frozen-originals-v2' AND EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_identity_v2_anchors a JOIN app.neighborhood_cohort_evidence_blobs b
          ON b.organization_id=a.organization_id AND b.content_sha256=a.receipt_reference->>'content_sha256'
            AND b.canonical_utf8_bytes::text=a.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
        WHERE a.operation_id=OLD.operation_id AND a.organization_id=OLD.organization_id
          AND a.receipt_reference=OLD.checkpoint->'evidence_refs'->5 AND b.canonical_utf8::jsonb->'after'->>'kind_index'='7'))
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
      AND e.organization_id=NEW.organization_id AND e.consumed_claim_token=NEW.claim_token AND e.consumed_attempts=NEW.attempts
      AND e.consumed_transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cache_stock_v2_bridge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  e app.neighborhood_custom_cohort_neutral_success_v2_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
  h app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
  stock app.neighborhood_custom_cohort_stock_traversal_v2_anchors%ROWTYPE; receipt jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_cache_stock_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT e FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT * INTO stock FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=h.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NEW.organization_id<>job.organization_id OR NEW.report_file_id<>job.report_file_id OR NEW.assignment_file_id<>job.assignment_file_id
    OR NEW.account_id<>job.account_id OR NEW.actor_user_id<>job.actor_user_id OR NEW.request_sha256<>job.request_sha256
    OR e.organization_id<>job.organization_id OR e.report_file_id<>job.report_file_id OR e.assignment_file_id<>job.assignment_file_id
    OR e.account_id<>job.account_id OR e.actor_user_id<>job.actor_user_id OR e.request_sha256<>job.request_sha256
    OR job.request_payload->>'execution_mode' IS DISTINCT FROM 'frozen-originals-v2'
    OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
    OR e.parent_sequence<>NEW.parent_sequence OR e.identity_reference IS DISTINCT FROM NEW.identity_reference
    OR e.sequence<>NEW.cache_sequence OR e.receipt_reference IS DISTINCT FROM NEW.cache_reference OR e.consumed_claim_token IS NOT NULL
    OR h.organization_id<>NEW.organization_id OR h.sequence<>NEW.cache_sequence OR h.receipt_reference IS DISTINCT FROM NEW.cache_reference
    OR h.identity_reference IS DISTINCT FROM NEW.identity_reference
    OR h.stock_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->1 OR h.source_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->2
    OR h.graph_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->3 OR h.geographic_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->4
    OR h.identity_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->5
    OR receipt->>'format' IS DISTINCT FROM 'cohort_neutral_cache_receipt_v2'
    OR receipt->'after'->>'kind_index' IS DISTINCT FROM '7' OR receipt->'after'->'position' IS DISTINCT FROM 'null'::jsonb
    OR NEW.claim_token=e.initial_claim_token OR NEW.claim_token=e.issued_claim_token THEN
    RAISE EXCEPTION 'neighborhood_cache_stock_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  -- Generated FK keys are recomputed AFTER this BEFORE trigger. Compare their
  -- immutable source references, not provisional NEW generated-column values.
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['claim_token','attempts','claim_transaction_id','completed_reference','completed_transaction_id','cache_sha256','completed_sha256','cad_sha256'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['claim_token','attempts','claim_transaction_id','completed_reference','completed_transaction_id','cache_sha256','completed_sha256','cad_sha256']) THEN
    RAISE EXCEPTION 'neighborhood_cache_stock_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.completed_reference IS NULL THEN
    IF stock.operation_id IS NOT NULL OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6 OR c.organization_id<>NEW.organization_id
      OR c.phase<>'frozen_identity_refs_v2' OR c.sequence<>NEW.parent_sequence OR c.progress_reference IS DISTINCT FROM NEW.identity_reference
      OR c.consumed_claim_token IS DISTINCT FROM e.initial_claim_token OR NEW.completed_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_cache_stock_v2_parent_conflict' USING ERRCODE='55000'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.claim_transaction_id IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
        OR job.run_after>clock_timestamp() OR NEW.attempts<>job.attempts OR job.attempts IS DISTINCT FROM
          (SELECT issued_attempts FROM app.neighborhood_custom_cohort_cad_success_v2_jobs d WHERE d.operation_id=NEW.operation_id) THEN
        RAISE EXCEPTION 'neighborhood_cache_stock_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    ELSE
      IF OLD.completed_reference IS NOT NULL OR NEW.claim_token=OLD.claim_token OR NEW.claim_transaction_id<>OLD.claim_transaction_id
        OR job.attempts>=5 OR job.attempts<>OLD.attempts OR NEW.attempts<>job.attempts+1
        OR NOT(job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()) THEN
        RAISE EXCEPTION 'neighborhood_cache_stock_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    END IF;
    NEW.claim_transaction_id:=txid_current();RETURN NEW;
  END IF;
  IF TG_OP<>'UPDATE' OR OLD.completed_reference IS NOT NULL OR NEW.claim_token<>OLD.claim_token OR NEW.attempts<>OLD.attempts
    OR NEW.claim_transaction_id<>OLD.claim_transaction_id OR NEW.completed_transaction_id IS NOT NULL
    OR stock.operation_id IS NULL OR stock.organization_id<>NEW.organization_id OR stock.sequence<>1
    OR stock.issued_transaction_id IS DISTINCT FROM txid_current() OR stock.receipt_reference IS DISTINCT FROM NEW.completed_reference
    OR c.phase<>'frozen_stock_traversal_refs_v2' OR c.sequence<>NEW.parent_sequence+1
    OR c.progress_reference IS DISTINCT FROM NEW.completed_reference OR c.issued_claim_token<>NEW.claim_token OR c.issued_attempts<>NEW.attempts
    OR c.consumed_claim_token IS NOT NULL OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_traversal_refs_v2'
    OR jsonb_array_length(job.checkpoint->'evidence_refs')<>7 OR job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM NEW.completed_reference
    OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.attempts<>NEW.attempts THEN
    RAISE EXCEPTION 'neighborhood_cache_stock_v2_completion_conflict' USING ERRCODE='55000'; END IF;
  NEW.completed_transaction_id:=txid_current();RETURN NEW;
END $$;
