-- Unregistered first-stock bridge. Cache success and main continuation
-- sequences/ceilings remain separate and unchanged. No worker activation.
CREATE TABLE app.neighborhood_custom_cohort_cache_stock_v2_bridges (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_neutral_success_v2_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL,report_file_id uuid NOT NULL,assignment_file_id bigint NOT NULL,account_id text NOT NULL,
  actor_user_id uuid NOT NULL,request_sha256 text NOT NULL,
  parent_sequence integer NOT NULL CHECK(parent_sequence BETWEEN 1 AND 600000),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  cache_sequence integer NOT NULL CHECK(cache_sequence BETWEEN 1 AND 200000),
  cache_reference jsonb NOT NULL CHECK(octet_length(cache_reference::text) BETWEEN 100 AND 256),
  claim_token uuid NOT NULL,attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 5),
  claim_transaction_id bigint NOT NULL CHECK(claim_transaction_id>0),
  completed_reference jsonb CHECK(completed_reference IS NULL OR octet_length(completed_reference::text) BETWEEN 100 AND 256),
  completed_transaction_id bigint CHECK(completed_transaction_id>0),
  CHECK((completed_reference IS NULL)=(completed_transaction_id IS NULL)),
  cache_sha256 text GENERATED ALWAYS AS(cache_reference->>'content_sha256') STORED,
  completed_sha256 text GENERATED ALWAYS AS(completed_reference->>'content_sha256') STORED,
  FOREIGN KEY(organization_id,cache_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(organization_id,completed_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- These joins establish native lineage only. Every consumer still performs
-- actual original/entire-cache replay and fresh current/ending authorization.
CREATE FUNCTION app.neighborhood_cache_stock_v2_matches(operation uuid,organization uuid,token uuid,attempt integer)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b
    JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=b.operation_id AND c.organization_id=b.organization_id
    JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads h ON h.operation_id=b.operation_id AND h.organization_id=b.organization_id
    JOIN app.neighborhood_cohort_evidence_blobs receipt ON receipt.organization_id=b.organization_id
      AND receipt.content_sha256=h.receipt_reference->>'content_sha256'
      AND receipt.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND receipt.canonical_utf8_bytes<=16000
    WHERE b.operation_id=operation AND b.organization_id=organization AND b.claim_token=token AND b.attempts=attempt
      AND b.completed_reference IS NULL AND b.claim_transaction_id>0
      AND job.request_payload->>'execution_mode'='frozen-originals-v2' AND job.context_sha256 IS NULL AND job.cancellation_requested_at IS NULL
      AND c.phase='frozen_identity_refs_v2' AND c.sequence=b.parent_sequence AND c.sequence=e.parent_sequence
      AND c.progress_reference=b.identity_reference AND c.progress_reference=e.identity_reference AND c.consumed_claim_token=e.initial_claim_token
      AND e.consumed_claim_token IS NULL AND e.sequence=b.cache_sequence AND e.receipt_reference=b.cache_reference
      AND h.sequence=b.cache_sequence AND h.receipt_reference=b.cache_reference AND h.identity_reference=b.identity_reference
      AND h.stock_reference=job.checkpoint->'evidence_refs'->1 AND h.source_reference=job.checkpoint->'evidence_refs'->2
      AND h.graph_reference=job.checkpoint->'evidence_refs'->3 AND h.geographic_reference=job.checkpoint->'evidence_refs'->4
      AND h.identity_reference=job.checkpoint->'evidence_refs'->5
      AND receipt.canonical_utf8::jsonb->>'format'='cohort_neutral_cache_receipt_v2'
      AND receipt.canonical_utf8::jsonb->'after'->>'kind_index'='7'
      AND receipt.canonical_utf8::jsonb->'after'->'position'='null'::jsonb)
$$;

ALTER TABLE app.neighborhood_custom_cohort_stock_traversal_v2_anchors ADD COLUMN issued_transaction_id bigint CHECK(issued_transaction_id>0);
CREATE FUNCTION app.stamp_neighborhood_stock_bridge_v2_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.issued_transaction_id:=txid_current();RETURN NEW;END $$;
-- Stamp AFTER the unchanged original parent/edge/CAS BEFORE guard.
CREATE TRIGGER zz_neighborhood_stock_bridge_v2_issuance BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_stock_traversal_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.stamp_neighborhood_stock_bridge_v2_issuance();

CREATE FUNCTION app.guard_neighborhood_cache_stock_v2_bridge() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['claim_token','attempts','claim_transaction_id','completed_reference','completed_transaction_id','completed_sha256'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['claim_token','attempts','claim_transaction_id','completed_reference','completed_transaction_id','completed_sha256']) THEN
    RAISE EXCEPTION 'neighborhood_cache_stock_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.completed_reference IS NULL THEN
    IF stock.operation_id IS NOT NULL OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6 OR c.organization_id<>NEW.organization_id
      OR c.phase<>'frozen_identity_refs_v2' OR c.sequence<>NEW.parent_sequence OR c.progress_reference IS DISTINCT FROM NEW.identity_reference
      OR c.consumed_claim_token IS DISTINCT FROM e.initial_claim_token OR NEW.completed_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_cache_stock_v2_parent_conflict' USING ERRCODE='55000'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.claim_transaction_id IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
        OR job.run_after>clock_timestamp() OR NEW.attempts<>job.attempts OR job.attempts<>e.issued_attempts THEN
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
CREATE TRIGGER neighborhood_cache_stock_v2_bridge_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_cache_stock_v2_bridges FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cache_stock_v2_bridge();
CREATE TRIGGER neighborhood_cache_stock_v2_bridge_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_cache_stock_v2_bridges FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_cache_stock_v2_bridges FROM PUBLIC;

CREATE FUNCTION app.assert_neighborhood_cache_stock_v2_commit(operation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b app.neighborhood_custom_cohort_cache_stock_v2_bridges%ROWTYPE;
  job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
  h app.neighborhood_custom_cohort_stock_traversal_v2_anchors%ROWTYPE;
BEGIN
  SELECT * INTO STRICT b FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges WHERE operation_id=operation;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=operation;
  IF b.completed_reference IS NULL THEN
    IF b.claim_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running' OR job.claim_token IS DISTINCT FROM b.claim_token
      OR job.attempts<>b.attempts OR job.lease_expires_at<=clock_timestamp() OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
      OR NOT app.neighborhood_cache_stock_v2_matches(operation,b.organization_id,b.claim_token,b.attempts) THEN
      RAISE EXCEPTION 'neighborhood_cache_stock_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=operation;
    SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=operation;
    IF b.completed_transaction_id IS DISTINCT FROM txid_current() OR h.issued_transaction_id IS DISTINCT FROM txid_current()
      OR h.sequence<>1 OR h.receipt_reference IS DISTINCT FROM b.completed_reference
      OR c.phase<>'frozen_stock_traversal_refs_v2' OR c.sequence<>b.parent_sequence+1 OR c.progress_reference IS DISTINCT FROM b.completed_reference
      OR c.issued_claim_token<>b.claim_token OR c.issued_attempts<>b.attempts OR c.consumed_claim_token IS NOT NULL
      OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.attempts<>b.attempts
      OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_traversal_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>7
      OR job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM b.completed_reference THEN
      RAISE EXCEPTION 'neighborhood_cache_stock_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  END IF;
END $$;
CREATE FUNCTION app.check_neighborhood_cache_stock_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM app.assert_neighborhood_cache_stock_v2_commit(NEW.operation_id);RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER neighborhood_cache_stock_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_cache_stock_v2_bridges DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_cache_stock_v2_commit();
CREATE FUNCTION app.check_neighborhood_first_stock_bridge_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sequence=1 AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id) THEN
    PERFORM app.assert_neighborhood_cache_stock_v2_commit(NEW.operation_id);
    IF NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b WHERE b.operation_id=NEW.operation_id
      AND b.completed_reference=NEW.receipt_reference AND b.completed_transaction_id=txid_current()) THEN
      RAISE EXCEPTION 'neighborhood_cache_stock_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  END IF;RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_first_stock_bridge_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_stock_traversal_v2_anchors DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_first_stock_bridge_v2_commit();

-- Compose the actual installed guards; every earlier phase/ceiling remains.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; actual_reference jsonb; actual_sequence integer; first_union_bridge boolean:=false; first_cache_stock_bridge boolean:=false; early_issued_tx bigint; early_receipt jsonb;
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
    -- A completed-cache job MUST use its independently issued fresh bridge
    -- token even after genuine failed attempts. Earlier identity tokens and
    -- the legacy different-attempt exception cannot stand in for this parent.
    IF OLD.phase='frozen_identity_refs_v2' AND NEW.phase='frozen_stock_traversal_refs_v2'
      AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id) THEN
      SELECT actual_sequence=1 AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b
        JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors h ON h.operation_id=b.operation_id AND h.organization_id=b.organization_id
        WHERE b.operation_id=NEW.operation_id AND b.organization_id=NEW.organization_id AND b.parent_sequence=OLD.sequence
          AND b.identity_reference=OLD.progress_reference AND b.claim_token=NEW.issued_claim_token AND b.attempts=NEW.issued_attempts
          AND b.completed_reference IS NULL AND h.sequence=1 AND h.receipt_reference=NEW.progress_reference
          AND h.issued_transaction_id=txid_current()
          AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,b.claim_token,b.attempts)) INTO first_cache_stock_bridge;
      IF NOT first_cache_stock_bridge THEN RAISE EXCEPTION 'neighborhood_cache_stock_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    END IF;
    -- ONLY the first actual union head may bridge the fresh authenticated human
    -- resume token at the same attempt; all later consumed-token rules remain.
    IF OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase='frozen_selected_union_refs_v2' AND actual_sequence=1 THEN
      SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents command
        WHERE command.operation_id=NEW.operation_id AND command.organization_id=NEW.organization_id
          AND command.resume_claim_token=NEW.issued_claim_token AND command.issued_attempts=NEW.issued_attempts
          AND command.checkpoint->'evidence_refs'->8=OLD.progress_reference) INTO first_union_bridge;
    END IF;
    IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.sequence<>OLD.sequence+1
      OR OLD.consumed_claim_token IS NULL OR (NEW.issued_attempts=OLD.issued_attempts AND NEW.issued_claim_token<>OLD.consumed_claim_token AND NOT first_union_bridge AND NOT first_cache_stock_bridge)
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
          AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,NEW.claim_token,NEW.attempts)))
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
