-- A free checkpoint cursor/count/done blob is DATA, not owner-issued proof.
CREATE TABLE app.neighborhood_custom_cohort_geo_v2_anchors (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000)
);
CREATE FUNCTION app.guard_neighborhood_cohort_geo_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  graph_anchor app.neighborhood_custom_cohort_graph_v2_anchors%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  receipt jsonb; old_receipt jsonb; graph_receipt jsonb; source_body jsonb; stock_body jsonb;
  before_state jsonb; after_state jsonb; expected_before jsonb; expected_after jsonb;
  delta integer; null_delta integer; actual_count integer; actual_nulls integer; last_key text;
  old_key bigint; remaining boolean; completed boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_geo_v2_anchor_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT graph_anchor FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR graph_anchor.organization_id<>NEW.organization_id OR graph_anchor.source_reference<>NEW.source_reference
    OR graph_anchor.root_reference<>NEW.root_reference OR graph_anchor.receipt_reference<>NEW.graph_reference
    OR stock.status<>'complete' OR stock.organization_id<>NEW.organization_id THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT source_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.source_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.source_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT stock_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.stock_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.stock_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT graph_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.graph_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.graph_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF source_body->>'source_stage_version' IS DISTINCT FROM '2'
    OR source_body->>'usage' IS DISTINCT FROM 'frozen_source_reference_prefix_only'
    OR source_body->'root' IS DISTINCT FROM NEW.root_reference
    OR source_body->'selection'->'stock_reference' IS DISTINCT FROM NEW.stock_reference
    OR stock_body->'stock'->>'operation_id' IS DISTINCT FROM NEW.operation_id::text
    OR stock_body->'stock'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR stock_body->'stock'->>'definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR stock_body->'stock'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR graph_receipt->>'format' IS DISTINCT FROM 'cohort_original_source_graph_receipt_v2'
    OR graph_receipt->>'sequence' IS DISTINCT FROM graph_anchor.sequence::text
    OR graph_receipt->'after' IS DISTINCT FROM '{"kind_index":7,"position":null,"page_count":0,"row_count":0,"original_utf8_bytes":0}'::jsonb
    OR receipt->>'format' IS DISTINCT FROM 'cohort_geographic_original_receipt_v2'
    OR receipt->'binding' IS DISTINCT FROM graph_receipt->'binding'
    OR receipt->'binding'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'binding'->>'spatial_definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR receipt->'binding'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->'graph_verification_reference' IS DISTINCT FROM NEW.graph_reference
    OR receipt->'stock_reference' IS DISTINCT FROM NEW.stock_reference
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  before_state:=receipt->'before'; after_state:=receipt->'after';
  IF before_state->>'format' IS DISTINCT FROM 'frozen_job_stock_original_progress_v1'
    OR before_state->>'stock_sha256' IS NULL OR before_state->>'stock_sha256' !~ '^[a-f0-9]{64}$'
    OR before_state->>'done' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_transition_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    expected_before:=jsonb_build_object('format','frozen_job_stock_original_progress_v1','stock_sha256',before_state->>'stock_sha256',
      'after_object_id',NULL,'verified_parcels',0,'verified_unassociated',0,'done',false);
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb OR before_state IS DISTINCT FROM expected_before
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_verify_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>4 THEN
      RAISE EXCEPTION 'neighborhood_geo_v2_anchor_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_geo_verify_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>5
      OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_geo_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF before_state IS DISTINCT FROM old_receipt->'after' THEN
      RAISE EXCEPTION 'neighborhood_geo_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  delta:=(after_state->>'verified_parcels')::integer-(before_state->>'verified_parcels')::integer;
  null_delta:=(after_state->>'verified_unassociated')::integer-(before_state->>'verified_unassociated')::integer;
  old_key:=(before_state->>'after_object_id')::bigint;
  IF delta IS NULL OR delta NOT BETWEEN 0 AND 250 OR null_delta IS NULL OR null_delta NOT BETWEEN 0 AND delta THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_prefix_conflict' USING ERRCODE='55000';
  END IF;
  -- Only the next delta indexed STOCK keys. Do not repeat original payload or
  -- EWKB validation. Short pages are valid under the owner's 8-MB admission.
  SELECT count(*)::integer,count(*) FILTER(WHERE account_id IS NULL)::integer,max(object_id)::text
    INTO actual_count,actual_nulls,last_key FROM (
      SELECT object_id,account_id FROM app.neighborhood_custom_cohort_stock_parcels
      WHERE operation_id=NEW.operation_id AND generation_id=stock.generation_id AND (old_key IS NULL OR object_id>old_key)
      ORDER BY object_id LIMIT delta
    ) next_keys;
  last_key:=coalesce(last_key,before_state->>'after_object_id');
  IF actual_count<>delta OR actual_nulls<>null_delta OR after_state->>'after_object_id' IS DISTINCT FROM last_key THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_prefix_conflict' USING ERRCODE='55000';
  END IF;
  remaining:=EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_parcels
    WHERE operation_id=NEW.operation_id AND generation_id=stock.generation_id AND (last_key IS NULL OR object_id>last_key::bigint));
  -- Exactly 250 admitted last rows intentionally require an empty terminal
  -- query. Do not reject that legitimate non-done/full-tail continuation.
  completed:=NOT remaining AND delta<250;
  expected_after:=jsonb_build_object('format',before_state->>'format','stock_sha256',before_state->>'stock_sha256',
    'after_object_id',last_key,'verified_parcels',(before_state->>'verified_parcels')::integer+delta,
    'verified_unassociated',(before_state->>'verified_unassociated')::integer+null_delta,'done',completed);
  IF after_state IS DISTINCT FROM expected_after OR delta=0 AND NOT completed
    OR (after_state->>'verified_parcels')::bigint>stock.parcel_count
    OR (after_state->>'verified_unassociated')::bigint>stock.unassociated_parcel_count
    OR completed AND ((after_state->>'verified_parcels')::bigint<>stock.parcel_count
      OR (after_state->>'verified_unassociated')::bigint<>stock.unassociated_parcel_count) THEN
    RAISE EXCEPTION 'neighborhood_geo_v2_anchor_count_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_geo_v2_anchor_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_geo_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_geo_v2_anchor();
CREATE TRIGGER neighborhood_cohort_geo_v2_anchor_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_geo_v2_anchors FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_geo_v2_anchors FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_geo_v2_anchors IS
  'Independent monotonic geographic issued head bound to the actual completed V2 graph and exact pinned stock. DB guards next stock keys/counts, not EWKB or current source rights. Trusted current-authorized owner validates originals and commits receipt/anchor/checkpoint atomically. No worker, route, source grant, Apply or pin release.';
