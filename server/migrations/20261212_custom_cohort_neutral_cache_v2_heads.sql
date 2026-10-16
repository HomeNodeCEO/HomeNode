-- Dormant manual original-owner lane. Automatic enrollment/success handoff is
-- deliberately not admitted until its separate native claim protocol exists.
CREATE TABLE app.neighborhood_custom_cohort_neutral_cache_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000),
  issued_transaction_id bigint NOT NULL DEFAULT txid_current(),
  issued_claim_token uuid NOT NULL,issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  receipt_sha256 text GENERATED ALWAYS AS (receipt_reference->>'content_sha256') STORED,
  root_sha256 text GENERATED ALWAYS AS (root_reference->>'content_sha256') STORED,
  FOREIGN KEY(organization_id,receipt_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(organization_id,root_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE FUNCTION app.guard_neighborhood_neutral_cache_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR job.request_payload->>'execution_mode' IS NOT NULL
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id)
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
  NEW.issued_transaction_id:=txid_current();NEW.issued_claim_token:=job.claim_token;NEW.issued_attempts:=job.attempts;RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_neutral_cache_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_neutral_cache_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_neutral_cache_v2_head();
CREATE TRIGGER neighborhood_neutral_cache_v2_head_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_neutral_cache_v2_heads FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_neutral_cache_v2_heads FROM PUBLIC;
CREATE FUNCTION app.check_neighborhood_neutral_cache_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=NEW.operation_id;
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
CREATE CONSTRAINT TRIGGER neighborhood_neutral_cache_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_neutral_cache_v2_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_neutral_cache_v2_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_neutral_cache_v2_heads IS
  'Inactive manual current-authorized original owner coverage. Independent issued graph/geography/identity and exact backwards source-node edges; actual original reads and entire cache reconciliation remain trusted-owner duties. Receipt/root FK retention, bounded progress metadata, no source grant, global completeness, automatic lease success, publication or pin retirement.';
