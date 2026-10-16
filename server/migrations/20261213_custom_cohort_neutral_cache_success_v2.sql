-- Unregistered native cache-success lane. Its sequence never spends/widens
-- the existing graph/geographic/identity or later continuation ceilings.
CREATE TABLE app.neighborhood_custom_cohort_neutral_success_v2_jobs (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL,report_file_id uuid NOT NULL,assignment_file_id bigint NOT NULL,account_id text NOT NULL,
  actor_user_id uuid NOT NULL,request_sha256 text NOT NULL,
  parent_sequence integer NOT NULL CHECK(parent_sequence BETWEEN 1 AND 600000),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  initial_claim_token uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 200000),
  receipt_reference jsonb CHECK(receipt_reference IS NULL OR octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  issued_claim_token uuid,issued_attempts integer CHECK(issued_attempts BETWEEN 1 AND 5),issued_transaction_id bigint CHECK(issued_transaction_id>0),
  consumed_claim_token uuid,consumed_attempts integer CHECK(consumed_attempts BETWEEN 1 AND 5),consumed_transaction_id bigint CHECK(consumed_transaction_id>0),
  CHECK((sequence=0)=(receipt_reference IS NULL)),CHECK((sequence=0)=(issued_claim_token IS NULL)),
  CHECK((sequence=0)=(issued_attempts IS NULL)),CHECK((sequence=0)=(issued_transaction_id IS NULL)),
  CHECK((consumed_claim_token IS NULL)=(consumed_attempts IS NULL)),
  CHECK((consumed_claim_token IS NULL)=(consumed_transaction_id IS NULL)),
  CHECK(consumed_claim_token IS NULL OR consumed_claim_token IS DISTINCT FROM issued_claim_token)
);
CREATE FUNCTION app.guard_neighborhood_neutral_success_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  parent app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
  h app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE; identity_body jsonb; progress_body jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_neutral_success_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT parent FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id OR NEW.report_file_id<>job.report_file_id OR NEW.assignment_file_id<>job.assignment_file_id
    OR NEW.account_id<>job.account_id OR NEW.actor_user_id<>job.actor_user_id OR NEW.request_sha256<>job.request_sha256
    OR job.request_payload->>'execution_mode' IS DISTINCT FROM 'frozen-originals-v2'
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM NEW.identity_reference
    OR parent.organization_id<>job.organization_id OR parent.phase<>'frozen_identity_refs_v2'
    OR parent.sequence<>NEW.parent_sequence OR parent.progress_reference IS DISTINCT FROM NEW.identity_reference
    OR job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT b.canonical_utf8::jsonb INTO STRICT identity_body FROM app.neighborhood_custom_cohort_identity_v2_anchors a
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=a.organization_id
      AND b.content_sha256=a.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=a.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE a.operation_id=NEW.operation_id AND a.organization_id=NEW.organization_id AND a.receipt_reference=NEW.identity_reference
      AND a.stock_reference=job.checkpoint->'evidence_refs'->1 AND a.source_reference=job.checkpoint->'evidence_refs'->2
      AND a.graph_reference=job.checkpoint->'evidence_refs'->3 AND a.geographic_reference=job.checkpoint->'evidence_refs'->4;
  IF identity_body->>'format' IS DISTINCT FROM 'cohort_source_identity_receipt_v2'
    OR identity_body->'after'->>'kind_index' IS DISTINCT FROM '7' THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_parent_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>0 OR h.operation_id IS NOT NULL OR parent.consumed_claim_token IS NOT NULL
      OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.run_after>clock_timestamp() OR job.attempts<>parent.issued_attempts OR job.attempts NOT BETWEEN 1 AND 5
      OR NEW.initial_claim_token IS DISTINCT FROM NEW.consumed_claim_token
      OR NEW.consumed_claim_token=parent.issued_claim_token OR NEW.consumed_attempts IS DISTINCT FROM job.attempts
      OR NEW.consumed_transaction_id IS NOT NULL OR NEW.receipt_reference IS NOT NULL OR NEW.issued_claim_token IS NOT NULL
      OR NEW.issued_attempts IS NOT NULL OR NEW.issued_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_neutral_success_v2_initial_claim_conflict' USING ERRCODE='55000'; END IF;
    NEW.consumed_transaction_id:=txid_current();RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['sequence','receipt_reference','issued_claim_token','issued_attempts','issued_transaction_id',
      'consumed_claim_token','consumed_attempts','consumed_transaction_id'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['sequence','receipt_reference','issued_claim_token','issued_attempts','issued_transaction_id',
      'consumed_claim_token','consumed_attempts','consumed_transaction_id'])
    OR parent.consumed_claim_token IS DISTINCT FROM NEW.initial_claim_token THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.sequence=OLD.sequence AND NEW.receipt_reference IS NOT DISTINCT FROM OLD.receipt_reference
    AND NEW.issued_claim_token IS NOT DISTINCT FROM OLD.issued_claim_token AND NEW.issued_attempts IS NOT DISTINCT FROM OLD.issued_attempts
    AND NEW.issued_transaction_id IS NOT DISTINCT FROM OLD.issued_transaction_id
    AND NEW.consumed_claim_token IS NOT NULL AND NEW.consumed_claim_token IS DISTINCT FROM OLD.consumed_claim_token
    AND NEW.consumed_claim_token<>NEW.initial_claim_token THEN
    IF NEW.sequence>0 THEN
      SELECT canonical_utf8::jsonb INTO STRICT progress_body FROM app.neighborhood_cohort_evidence_blobs
        WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
          AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
      IF h.sequence<>NEW.sequence OR h.receipt_reference IS DISTINCT FROM NEW.receipt_reference
        OR progress_body->'after'->>'kind_index'='7' THEN
        RAISE EXCEPTION 'neighborhood_neutral_success_v2_next_owner_excluded' USING ERRCODE='55000'; END IF;
    ELSIF h.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_neutral_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.consumed_claim_token IS NULL THEN
      IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
        OR job.run_after>clock_timestamp() OR job.attempts<>OLD.issued_attempts OR NEW.consumed_attempts IS DISTINCT FROM job.attempts THEN
        RAISE EXCEPTION 'neighborhood_neutral_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    ELSIF job.attempts>=5 OR job.attempts IS DISTINCT FROM OLD.consumed_attempts
      OR NEW.consumed_attempts IS DISTINCT FROM job.attempts+1
      OR NOT (job.status='retry' AND job.run_after<=clock_timestamp() OR job.status='running' AND job.lease_expires_at<=clock_timestamp()) THEN
      RAISE EXCEPTION 'neighborhood_neutral_success_v2_claim_conflict' USING ERRCODE='55000'; END IF;
    NEW.consumed_transaction_id:=txid_current();RETURN NEW;
  END IF;
  IF NEW.sequence<>OLD.sequence+1 OR h.sequence<>NEW.sequence OR h.receipt_reference IS DISTINCT FROM NEW.receipt_reference
    OR h.issued_transaction_id IS DISTINCT FROM txid_current() OR h.issued_claim_token IS DISTINCT FROM job.claim_token
    OR h.issued_attempts<>job.attempts OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR NEW.issued_claim_token IS DISTINCT FROM job.claim_token OR NEW.issued_attempts IS DISTINCT FROM job.attempts
    OR OLD.consumed_claim_token IS DISTINCT FROM job.claim_token OR OLD.consumed_attempts IS DISTINCT FROM job.attempts
    OR NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id
    OR NEW.consumed_claim_token IS NOT NULL OR NEW.consumed_attempts IS NOT NULL OR NEW.consumed_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_issuance_conflict' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_neutral_success_v2_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_neutral_success_v2_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_neutral_success_v2();
CREATE TRIGGER neighborhood_neutral_success_v2_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_neutral_success_v2_jobs FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_neutral_success_v2_jobs FROM PUBLIC;

CREATE FUNCTION app.neighborhood_neutral_v2_claim_matches(operation uuid,organization uuid,token uuid,attempt integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e
    JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
    JOIN app.neighborhood_custom_cohort_v2_continuations c ON c.operation_id=e.operation_id AND c.organization_id=e.organization_id
    WHERE e.operation_id=operation AND e.organization_id=organization AND e.consumed_claim_token=token AND e.consumed_attempts=attempt
      AND e.consumed_transaction_id IS NOT NULL AND c.sequence=e.parent_sequence AND c.phase='frozen_identity_refs_v2'
      AND c.progress_reference=e.identity_reference AND c.consumed_claim_token=e.initial_claim_token
      AND job.status='running' AND job.claim_token=token AND job.attempts=attempt AND job.lease_expires_at>clock_timestamp()
      AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
      AND job.checkpoint->>'phase'='frozen_identity_refs_v2' AND jsonb_array_length(job.checkpoint->'evidence_refs')=6
      AND job.checkpoint->'evidence_refs'->5=e.identity_reference)
$$;
CREATE FUNCTION app.assert_neighborhood_neutral_success_v2_commit(operation uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  e app.neighborhood_custom_cohort_neutral_success_v2_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=operation;
  SELECT * INTO STRICT e FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs WHERE operation_id=operation;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=operation;
  IF job.context_sha256 IS NOT NULL OR job.cancellation_requested_at IS NOT NULL
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM e.identity_reference
    OR e.sequence=0 AND h.operation_id IS NOT NULL
    OR e.sequence>0 AND (h.operation_id IS NULL OR h.sequence<>e.sequence OR h.receipt_reference IS DISTINCT FROM e.receipt_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c WHERE c.operation_id=operation
      AND c.organization_id=e.organization_id AND c.phase='frozen_identity_refs_v2' AND c.sequence=e.parent_sequence
      AND c.progress_reference=e.identity_reference AND c.consumed_claim_token=e.initial_claim_token) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF e.consumed_claim_token IS NULL THEN
    IF e.sequence=0 OR e.issued_transaction_id IS DISTINCT FROM txid_current() OR h.issued_transaction_id IS DISTINCT FROM txid_current()
      OR job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.attempts IS DISTINCT FROM e.issued_attempts OR h.issued_claim_token IS DISTINCT FROM e.issued_claim_token THEN
      RAISE EXCEPTION 'neighborhood_neutral_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  ELSIF e.consumed_transaction_id IS DISTINCT FROM txid_current()
    OR NOT app.neighborhood_neutral_v2_claim_matches(operation,e.organization_id,e.consumed_claim_token,e.consumed_attempts) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_commit_conflict' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION app.check_neighborhood_neutral_success_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM app.assert_neighborhood_neutral_success_v2_commit(NEW.operation_id);RETURN NEW;END $$;
CREATE CONSTRAINT TRIGGER neighborhood_neutral_success_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_neutral_success_v2_jobs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_neutral_success_v2_commit();

CREATE FUNCTION app.guard_neighborhood_neutral_success_v2_job_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=OLD.operation_id)
    AND (NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload OR NEW.attempts<OLD.attempts) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_binding_conflict' USING ERRCODE='55000'; END IF;
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
CREATE TRIGGER neighborhood_neutral_success_v2_job_claim BEFORE UPDATE
  ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_neutral_success_v2_job_claim();

-- Preserve every manual native parent/edge guard; add only the independently guarded cache-success lane.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_neutral_cache_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  identity_head app.neighborhood_custom_cohort_identity_v2_anchors%ROWTYPE;
  receipt jsonb; old_receipt jsonb; identity_receipt jsonb; root jsonb; node jsonb; layer jsonb;
  before_state jsonb; expected_before jsonb; expected_position jsonb; expected_after jsonb; next_position jsonb;
  kind text; kind_index integer; profile text; next_typed_bytes bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_neutral_cache_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT identity_head FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR NOT ((job.request_payload->>'execution_mode' IS NULL
      AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id))
      OR app.neighborhood_neutral_v2_claim_matches(NEW.operation_id,NEW.organization_id,job.claim_token,job.attempts))
    OR stock.organization_id<>NEW.organization_id OR stock.status<>'complete'
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM NEW.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM NEW.identity_reference
    OR identity_head.organization_id<>NEW.organization_id OR identity_head.source_reference<>NEW.source_reference
    OR identity_head.root_reference<>NEW.root_reference OR identity_head.graph_reference<>NEW.graph_reference
    OR identity_head.geographic_reference<>NEW.geographic_reference OR identity_head.stock_reference<>NEW.stock_reference
    OR identity_head.receipt_reference<>NEW.identity_reference
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_graph_v2_anchors g
      WHERE g.operation_id=NEW.operation_id AND g.organization_id=NEW.organization_id
        AND g.source_reference=NEW.source_reference AND g.root_reference=NEW.root_reference AND g.receipt_reference=NEW.graph_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_geo_v2_anchors g
      WHERE g.operation_id=NEW.operation_id AND g.organization_id=NEW.organization_id AND g.source_reference=NEW.source_reference
        AND g.root_reference=NEW.root_reference AND g.graph_reference=NEW.graph_reference
        AND g.stock_reference=NEW.stock_reference AND g.receipt_reference=NEW.geographic_reference) THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT identity_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.identity_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.identity_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT root FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.root_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.root_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  profile:=receipt->'profile_reference'->>'content_sha256';
  IF identity_receipt->>'sequence' IS DISTINCT FROM identity_head.sequence::text
    OR identity_receipt->'after'->>'kind_index' IS DISTINCT FROM '7'
    OR receipt->>'format' IS DISTINCT FROM 'cohort_neutral_cache_receipt_v2'
    OR receipt->'binding' IS DISTINCT FROM identity_receipt->'binding' OR root->'binding' IS DISTINCT FROM receipt->'binding'
    OR receipt->'binding'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->'graph_reference' IS DISTINCT FROM NEW.graph_reference OR receipt->'geographic_reference' IS DISTINCT FROM NEW.geographic_reference
    OR receipt->'identity_reference' IS DISTINCT FROM NEW.identity_reference OR receipt->'stock_reference' IS DISTINCT FROM NEW.stock_reference
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>13
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_frozen_typed_v2_generations h WHERE h.generation_id=stock.generation_id
      AND h.profile_sha256=profile AND h.status IN ('building','complete')
      AND octet_length(h.definition_json)::text=receipt->'profile_reference'->>'canonical_utf8_bytes') THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    expected_before:='{"kind_index":0,"position":null,"page_count":0,"row_count":0,"original_utf8_bytes":0,"typed_utf8_bytes":"0"}'::jsonb;
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb
      OR NEW.issued_transaction_id<>txid_current() THEN
      RAISE EXCEPTION 'neighborhood_neutral_cache_v2_initial_head_required' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence','issued_transaction_id','receipt_sha256','root_sha256'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence','issued_transaction_id','receipt_sha256','root_sha256'])
      OR NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_neutral_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    expected_before:=old_receipt->'after';
    IF receipt->'profile_reference' IS DISTINCT FROM old_receipt->'profile_reference' THEN
      RAISE EXCEPTION 'neighborhood_neutral_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  before_state:=receipt->'before';kind_index:=(before_state->>'kind_index')::integer;
  IF before_state IS DISTINCT FROM expected_before OR kind_index NOT BETWEEN 0 AND 6
    OR NEW.sequence<>(before_state->>'page_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  kind:=(ARRAY['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'])[kind_index+1];
  layer:=root->'layers'->kind;
  IF layer->>'ended' IS DISTINCT FROM 'true' OR layer->'head'='null'::jsonb THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_unfinished_source' USING ERRCODE='55000'; END IF;
  expected_position:=CASE WHEN before_state->'position'='null'::jsonb
    THEN jsonb_build_object('node',layer->'head','index',(layer->>'page_count')::integer-1,'next_cursor',layer->>'cursor')
    ELSE before_state->'position' END;
  SELECT canonical_utf8::jsonb INTO STRICT node FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=expected_position->'node'->>'content_sha256'
      AND canonical_utf8_bytes::text=expected_position->'node'->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF node->>'kind' IS DISTINCT FROM kind OR node->>'index' IS DISTINCT FROM expected_position->>'index'
    OR node->>'next_cursor' IS DISTINCT FROM expected_position->>'next_cursor'
    OR (node->>'row_count')::integer NOT BETWEEN 0 AND 250 THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  next_position:=CASE WHEN node->'previous'='null'::jsonb THEN 'null'::jsonb
    ELSE jsonb_build_object('node',node->'previous','index',(node->>'index')::integer-1,'next_cursor',node->>'after') END;
  next_typed_bytes:=(receipt->'after'->>'typed_utf8_bytes')::bigint;
  expected_after:=jsonb_build_object('kind_index',kind_index+CASE WHEN next_position='null'::jsonb THEN 1 ELSE 0 END,
    'position',next_position,'page_count',NEW.sequence,'row_count',(before_state->>'row_count')::integer+(node->>'row_count')::integer,
    'original_utf8_bytes',(before_state->>'original_utf8_bytes')::bigint+(node->>'original_utf8_bytes')::bigint,
    'typed_utf8_bytes',next_typed_bytes::text);
  IF receipt->'after' IS DISTINCT FROM expected_after OR (expected_after->>'row_count')::integer>14000000
    OR (expected_after->>'original_utf8_bytes')::bigint>8000000000
    OR next_typed_bytes<(before_state->>'typed_utf8_bytes')::bigint+(node->>'row_count')::integer
    OR next_typed_bytes-(before_state->>'typed_utf8_bytes')::bigint>32000000
    OR (node->>'row_count')::integer=0 AND next_typed_bytes<>(before_state->>'typed_utf8_bytes')::bigint
    OR next_typed_bytes>8000000000 THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id)
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
      AND e.organization_id=NEW.organization_id AND e.sequence+1=NEW.sequence
      AND e.consumed_claim_token=job.claim_token AND e.consumed_attempts=job.attempts) THEN
    RAISE EXCEPTION 'neighborhood_neutral_success_v2_issuance_conflict' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();NEW.issued_claim_token:=job.claim_token;NEW.issued_attempts:=job.attempts;RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_neighborhood_neutral_cache_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=NEW.operation_id;
  IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id) THEN
    PERFORM app.assert_neighborhood_neutral_success_v2_commit(NEW.operation_id);RETURN NEW;
  END IF;
  IF h.issued_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running'
    OR job.claim_token IS DISTINCT FROM h.issued_claim_token OR job.attempts<>h.issued_attempts
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM h.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM h.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM h.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM h.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM h.identity_reference THEN
    RAISE EXCEPTION 'neighborhood_neutral_cache_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
