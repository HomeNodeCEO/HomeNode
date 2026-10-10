-- Durable ORIGINAL-backed stock traversal, not selected-union/statistical authority.
CREATE TABLE app.neighborhood_custom_cohort_stock_traversal_v2_anchors (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);
CREATE FUNCTION app.guard_neighborhood_cohort_stock_traversal_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  graph_anchor app.neighborhood_custom_cohort_graph_v2_anchors%ROWTYPE;
  geo_anchor app.neighborhood_custom_cohort_geo_v2_anchors%ROWTYPE;
  identity_anchor app.neighborhood_custom_cohort_identity_v2_anchors%ROWTYPE;
  receipt jsonb; old_receipt jsonb; identity_receipt jsonb; subject_intent jsonb;
  before_state jsonb; expected_before jsonb; expected_after jsonb; next_account text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT graph_anchor FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT geo_anchor FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT identity_anchor FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR stock.status<>'complete' OR stock.organization_id<>NEW.organization_id
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM NEW.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM NEW.identity_reference
    OR graph_anchor.organization_id<>NEW.organization_id OR graph_anchor.source_reference<>NEW.source_reference
    OR graph_anchor.root_reference<>NEW.root_reference OR graph_anchor.receipt_reference<>NEW.graph_reference
    OR geo_anchor.organization_id<>NEW.organization_id OR geo_anchor.source_reference<>NEW.source_reference
    OR geo_anchor.root_reference<>NEW.root_reference OR geo_anchor.graph_reference<>NEW.graph_reference
    OR geo_anchor.stock_reference<>NEW.stock_reference OR geo_anchor.receipt_reference<>NEW.geographic_reference
    OR identity_anchor.organization_id<>NEW.organization_id OR identity_anchor.source_reference<>NEW.source_reference
    OR identity_anchor.root_reference<>NEW.root_reference OR identity_anchor.graph_reference<>NEW.graph_reference
    OR identity_anchor.geographic_reference<>NEW.geographic_reference OR identity_anchor.stock_reference<>NEW.stock_reference
    OR identity_anchor.receipt_reference<>NEW.identity_reference THEN
    RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  -- The independently guarded identity head already binds the issued DONE
  -- graph/geography and exact original stock. A free complete receipt cannot
  -- substitute for these actual database heads.
  SELECT canonical_utf8::jsonb INTO STRICT identity_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.identity_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.identity_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT subject_intent FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=job.checkpoint->'evidence_refs'->0->>'content_sha256'
      AND canonical_utf8_bytes::text=job.checkpoint->'evidence_refs'->0->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF identity_receipt->>'format' IS DISTINCT FROM 'cohort_source_identity_receipt_v2'
    OR identity_receipt->>'sequence' IS DISTINCT FROM identity_anchor.sequence::text
    OR identity_receipt->'after'->>'kind_index' IS DISTINCT FROM '7'
    OR receipt->>'format' IS DISTINCT FROM 'cohort_stock_traversal_receipt_v2'
    OR receipt->'binding' IS DISTINCT FROM identity_receipt->'binding'
    OR receipt->'binding'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'binding'->>'spatial_definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR receipt->'binding'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->'graph_verification_reference' IS DISTINCT FROM NEW.graph_reference
    OR receipt->'stock_verification_reference' IS DISTINCT FROM NEW.geographic_reference
    OR receipt->'identity_verification_reference' IS DISTINCT FROM NEW.identity_reference
    OR receipt->'stock_reference' IS DISTINCT FROM NEW.stock_reference
    OR receipt->>'effective_date' IS NULL OR receipt->>'effective_date' IS DISTINCT FROM subject_intent->>'effective_date'
    OR subject_intent->>'operation_id' IS DISTINCT FROM NEW.operation_id::text
    OR receipt->>'stock_account_count' IS DISTINCT FROM stock.account_count::text
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>14 THEN
    RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  before_state:=receipt->'before';
  IF TG_OP='INSERT' THEN
    expected_before:='{"after_account":"","account_count":0,"done":false}'::jsonb;
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6 THEN
      RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_traversal_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>7
      OR job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    expected_before:=old_receipt->'after';
  END IF;
  IF before_state IS DISTINCT FROM expected_before OR before_state->>'done' IS DISTINCT FROM 'false'
    OR (before_state->>'account_count')::integer<0 OR (before_state->>'account_count')::integer>stock.account_count
    OR NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_transition_conflict' USING ERRCODE='55000';
  END IF;
  -- One exact indexed native key. Neither a caller-supplied key nor a count
  -- can skip a stock account or claim completion without an empty probe.
  SELECT account_id INTO next_account FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
    ORDER BY account_id LIMIT 1;
  expected_after:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
    'account_count',(before_state->>'account_count')::integer+CASE WHEN next_account IS NULL THEN 0 ELSE 1 END,
    'done',next_account IS NULL);
  IF receipt->'after' IS DISTINCT FROM expected_after
    OR (expected_after->>'account_count')::integer>stock.account_count
    OR next_account IS NULL AND (expected_after->>'account_count')::integer<>stock.account_count THEN
    RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_prefix_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_stock_traversal_v2_anchor_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_stock_traversal_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_stock_traversal_v2_anchor();
CREATE TRIGGER neighborhood_cohort_stock_traversal_v2_anchor_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_stock_traversal_v2_anchors FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_stock_traversal_v2_anchors FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_stock_traversal_v2_anchors IS
  'Independent durable original-stock traversal head. Guard checks exact next native stock key/empty terminal probe and actual issued DONE identity/graph/geography, date and retention-root checkpoint. Trusted owner replays every original/entire neutral cache under both-end current rights before same-TX receipt/head/checkpoint commit. Metadata only, no selected-union/statistics/source-rights/publication authority. No worker activation or terminal pin deletion.';
