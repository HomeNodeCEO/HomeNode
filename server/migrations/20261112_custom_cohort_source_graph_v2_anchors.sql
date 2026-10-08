-- Independent owner-issued head, not progress entrusted to checkpoint JSON.
-- One small indexed row per job; immutable transition receipts remain blobs.
CREATE TABLE app.neighborhood_custom_cohort_graph_v2_anchors (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000),
  FOREIGN KEY(organization_id) REFERENCES app_auth.organizations(id) ON DELETE RESTRICT
);

CREATE FUNCTION app.guard_neighborhood_cohort_graph_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  receipt jsonb; old_receipt jsonb; source_body jsonb; root_body jsonb; node_body jsonb;
  before_state jsonb; after_state jsonb; layer jsonb; expected_next jsonb; expected_after jsonb;
  kinds text[] := ARRAY['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
  kind_index integer; pages bigint; rows_count bigint; bytes_count bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_immutable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_job_conflict' USING ERRCODE='55000';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT source_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.source_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.source_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT root_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.root_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.root_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF source_body->>'source_stage_version' IS DISTINCT FROM '2'
    OR source_body->>'usage' IS DISTINCT FROM 'frozen_source_reference_prefix_only'
    OR source_body->'root' IS DISTINCT FROM NEW.root_reference
    OR root_body->>'format' IS DISTINCT FROM 'cohort_original_source_references_v2'
    OR receipt->>'format' IS DISTINCT FROM 'cohort_original_source_graph_receipt_v2'
    OR receipt->'binding' IS DISTINCT FROM root_body->'binding'
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference
    OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text
    OR receipt->'binding'->>'operation_id' IS DISTINCT FROM NEW.operation_id::text
    OR receipt->'binding'->>'organization_id' IS DISTINCT FROM NEW.organization_id::text
    OR receipt->'binding'->>'report_file_id' IS DISTINCT FROM job.report_file_id::text
    OR receipt->'binding'->>'assignment_file_id' IS DISTINCT FROM job.assignment_file_id::text
    OR receipt->'binding'->>'account_id' IS DISTINCT FROM job.account_id
    OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE root_body->'layers'->kind->>'ended' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  before_state:=receipt->'before'; after_state:=receipt->'after';
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>1 OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_source_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>3 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb
      OR before_state IS DISTINCT FROM '{"kind_index":0,"position":null,"page_count":0,"row_count":0,"original_utf8_bytes":0}'::jsonb THEN
      RAISE EXCEPTION 'neighborhood_graph_v2_anchor_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_verify_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>4
      OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_graph_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes';
    IF before_state IS DISTINCT FROM old_receipt->'after' THEN
      RAISE EXCEPTION 'neighborhood_graph_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  kind_index:=(before_state->>'kind_index')::integer;
  IF kind_index NOT BETWEEN 0 AND 6 OR receipt->>'kind' IS DISTINCT FROM kinds[kind_index+1] THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_transition_conflict' USING ERRCODE='55000';
  END IF;
  layer:=root_body->'layers'->(receipt->>'kind');
  IF receipt->'consumed_node' IS DISTINCT FROM (CASE WHEN before_state->'position'='null'::jsonb
    THEN layer->'head' ELSE before_state->'position'->'node' END) THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_detached_node' USING ERRCODE='55000';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT node_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=receipt->'consumed_node'->>'content_sha256'
      AND canonical_utf8_bytes::text=receipt->'consumed_node'->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4000;
  IF node_body->>'format' IS DISTINCT FROM 'cohort_original_source_references_v2'
    OR node_body->>'plan' IS DISTINCT FROM 'neighborhood_frozen_job_closure_v1'
    OR node_body->>'kind' IS DISTINCT FROM receipt->>'kind'
    OR (node_body->>'index')::bigint IS DISTINCT FROM (layer->>'page_count')::bigint-1-(before_state->>'page_count')::bigint
    OR node_body->>'next_cursor' IS DISTINCT FROM (CASE WHEN before_state->'position'='null'::jsonb
      THEN layer->>'cursor' ELSE before_state->'position'->>'next_cursor' END) THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_detached_node' USING ERRCODE='55000';
  END IF;
  expected_next:=CASE WHEN node_body->'previous'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object(
    'node',node_body->'previous','index',(node_body->>'index')::integer-1,'next_cursor',node_body->>'after') END;
  pages:=(before_state->>'page_count')::bigint+1;
  rows_count:=(before_state->>'row_count')::bigint+(node_body->>'row_count')::bigint;
  bytes_count:=(before_state->>'original_utf8_bytes')::bigint+(node_body->>'original_utf8_bytes')::bigint;
  IF receipt->'next_position' IS DISTINCT FROM expected_next OR pages>(layer->>'page_count')::bigint
    OR rows_count>(layer->>'row_count')::bigint OR bytes_count>(layer->>'original_utf8_bytes')::bigint THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_count_conflict' USING ERRCODE='55000';
  END IF;
  IF expected_next='null'::jsonb THEN
    IF pages IS DISTINCT FROM (layer->>'page_count')::bigint OR rows_count IS DISTINCT FROM (layer->>'row_count')::bigint
      OR bytes_count IS DISTINCT FROM (layer->>'original_utf8_bytes')::bigint THEN
      RAISE EXCEPTION 'neighborhood_graph_v2_anchor_count_conflict' USING ERRCODE='55000';
    END IF;
    expected_after:=jsonb_build_object('kind_index',kind_index+1,'position',NULL,'page_count',0,'row_count',0,'original_utf8_bytes',0);
  ELSE
    expected_after:=jsonb_build_object('kind_index',kind_index,'position',expected_next,'page_count',pages,
      'row_count',rows_count,'original_utf8_bytes',bytes_count);
  END IF;
  IF after_state IS DISTINCT FROM expected_after THEN
    RAISE EXCEPTION 'neighborhood_graph_v2_anchor_count_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_graph_v2_anchor_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_graph_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_graph_v2_anchor();
CREATE TRIGGER neighborhood_cohort_graph_v2_anchor_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_graph_v2_anchors FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_graph_v2_anchors FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_graph_v2_anchors IS
  'Independent monotonic owner-issued V2 graph head. Checkpoint/blob existence or digest alone is not issuance. Current actor/source rights and exact original-query validation remain mandatory in the transaction owner. No worker, route, source grant or Apply activation.';
