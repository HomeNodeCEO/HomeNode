-- Independent identity issuance, never authority derived from a free DONE blob.
CREATE TABLE app.neighborhood_custom_cohort_identity_v2_anchors (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000)
);
CREATE FUNCTION app.guard_neighborhood_cohort_identity_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  graph_anchor app.neighborhood_custom_cohort_graph_v2_anchors%ROWTYPE;
  geo_anchor app.neighborhood_custom_cohort_geo_v2_anchors%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  receipt jsonb; old_receipt jsonb; graph_receipt jsonb; geo_receipt jsonb;
  source_body jsonb; root_body jsonb; stock_body jsonb; counts jsonb;
  before_state jsonb; after_state jsonb; expected_before jsonb; expected_after jsonb;
  kinds text[] := ARRAY['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
  kind_index integer; next_index integer; kind_key text; query_order text; query_cursor text; query_filter text;
  delta integer; actual_count integer; actual_unknown integer; candidates_count integer;
  last_key text; completed boolean; missing_count integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_identity_v2_anchor_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT graph_anchor FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT geo_anchor FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM NEW.geographic_reference
    OR graph_anchor.organization_id<>NEW.organization_id OR graph_anchor.source_reference<>NEW.source_reference
    OR graph_anchor.root_reference<>NEW.root_reference OR graph_anchor.receipt_reference<>NEW.graph_reference
    OR geo_anchor.organization_id<>NEW.organization_id OR geo_anchor.source_reference<>NEW.source_reference
    OR geo_anchor.root_reference<>NEW.root_reference OR geo_anchor.graph_reference<>NEW.graph_reference
    OR geo_anchor.stock_reference<>NEW.stock_reference OR geo_anchor.receipt_reference<>NEW.geographic_reference
    OR stock.status<>'complete' OR stock.organization_id<>NEW.organization_id THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT source_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.source_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.source_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT root_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.root_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.root_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT stock_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.stock_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.stock_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT graph_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.graph_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.graph_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT geo_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.geographic_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.geographic_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT jsonb_object_agg(kind,root_body->'layers'->kind->'row_count') INTO counts FROM unnest(kinds) kind;
  IF source_body->>'source_stage_version' IS DISTINCT FROM '2'
    OR source_body->>'usage' IS DISTINCT FROM 'frozen_source_reference_prefix_only'
    OR source_body->'root' IS DISTINCT FROM NEW.root_reference
    OR source_body->'selection'->'stock_reference' IS DISTINCT FROM NEW.stock_reference
    OR root_body->>'format' IS DISTINCT FROM 'cohort_original_source_references_v2'
    OR EXISTS(SELECT 1 FROM unnest(kinds) kind WHERE root_body->'layers'->kind->>'ended' IS DISTINCT FROM 'true')
    OR stock_body->'stock'->>'operation_id' IS DISTINCT FROM NEW.operation_id::text
    OR stock_body->'stock'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR stock_body->'stock'->>'definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR stock_body->'stock'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR graph_receipt->>'format' IS DISTINCT FROM 'cohort_original_source_graph_receipt_v2'
    OR graph_receipt->>'sequence' IS DISTINCT FROM graph_anchor.sequence::text
    OR graph_receipt->'after' IS DISTINCT FROM '{"kind_index":7,"position":null,"page_count":0,"row_count":0,"original_utf8_bytes":0}'::jsonb
    OR geo_receipt->>'format' IS DISTINCT FROM 'cohort_geographic_original_receipt_v2'
    OR geo_receipt->>'sequence' IS DISTINCT FROM geo_anchor.sequence::text
    OR geo_receipt->'after'->>'done' IS DISTINCT FROM 'true'
    OR geo_receipt->'after'->>'verified_parcels' IS DISTINCT FROM stock.parcel_count::text
    OR geo_receipt->'after'->>'verified_unassociated' IS DISTINCT FROM stock.unassociated_parcel_count::text
    OR receipt->>'format' IS DISTINCT FROM 'cohort_source_identity_receipt_v2'
    OR receipt->'binding' IS DISTINCT FROM root_body->'binding'
    OR receipt->'binding' IS DISTINCT FROM graph_receipt->'binding'
    OR receipt->'binding' IS DISTINCT FROM geo_receipt->'binding'
    OR receipt->'binding'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'binding'->>'spatial_definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR receipt->'binding'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->'graph_verification_reference' IS DISTINCT FROM NEW.graph_reference
    OR receipt->'stock_verification_reference' IS DISTINCT FROM NEW.geographic_reference
    OR receipt->'stock_reference' IS DISTINCT FROM NEW.stock_reference OR receipt->'layer_counts' IS DISTINCT FROM counts
    OR receipt->>'stock_account_count' IS DISTINCT FROM stock.account_count::text
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_binding_conflict' USING ERRCODE='55000';
  END IF;
  before_state:=receipt->'before'; after_state:=receipt->'after';
  kind_index:=(before_state->>'kind_index')::integer; next_index:=(after_state->>'kind_index')::integer;
  IF before_state->>'format' IS DISTINCT FROM 'frozen_job_source_identity_progress_v1'
    OR before_state->>'binding_sha256' IS NULL OR before_state->>'binding_sha256' !~ '^[a-f0-9]{64}$'
    OR before_state->'missing_account_count' IS DISTINCT FROM 'null'::jsonb
    OR kind_index IS NULL OR kind_index NOT BETWEEN 0 AND 6
    OR next_index IS NULL OR next_index NOT IN (kind_index,kind_index+1) THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_transition_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    expected_before:=jsonb_build_object('format','frozen_job_source_identity_progress_v1',
      'binding_sha256',before_state->>'binding_sha256','kind_index',0,'after','','layer_rows',0,
      'unknown_parcel_origins',0,'missing_account_count',NULL);
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb OR before_state IS DISTINCT FROM expected_before
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_geo_verify_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>5 THEN
      RAISE EXCEPTION 'neighborhood_identity_v2_anchor_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
      OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_identity_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF before_state IS DISTINCT FROM old_receipt->'after' THEN
      RAISE EXCEPTION 'neighborhood_identity_v2_anchor_transition_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  kind_key:=kinds[kind_index+1];
  delta:=CASE WHEN next_index=kind_index+1 THEN (counts->>kind_key)::integer-(before_state->>'layer_rows')::integer
    ELSE (after_state->>'layer_rows')::integer-(before_state->>'layer_rows')::integer END;
  IF delta IS NULL OR delta NOT BETWEEN 0 AND 250 THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_prefix_conflict' USING ERRCODE='55000';
  END IF;
  -- Independently inspect at most 251 next native keys in the same all-date
  -- one-hop scope. Only parcel NULL-origin metadata is inspected, not geometry
  -- or numerical payloads. This is not a replay of full identity validation.
  -- Seven fixed internal plans, not caller SQL. Keep native indexed ORDER BY
  -- literal per kind: a generic CASE ordering can become a full sort when
  -- PostgreSQL reuses a generic prepared plan for a large population.
  query_order:=CASE WHEN kind_key IN ('parcels','source_records','sales','sale_links') THEN 'original.row_key::bigint'
    WHEN kind_key='sync_runs' THEN 'original.row_key::uuid' ELSE 'original.row_key COLLATE "C"' END;
  query_cursor:=CASE WHEN kind_key IN ('parcels','source_records','sales','sale_links') THEN 'NULLIF($3,'''')::bigint'
    WHEN kind_key='sync_runs' THEN 'NULLIF($3,'''')::uuid' ELSE 'NULLIF($3,'''') COLLATE "C"' END;
  query_filter:=CASE kind_key
    WHEN 'parcels' THEN 'EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)'
    WHEN 'accounts' THEN 'EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)'
    WHEN 'source_records' THEN 'EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)'
    WHEN 'sale_links' THEN 'EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)'
    WHEN 'sales' THEN 'EXISTS(SELECT 1 FROM seeds WHERE seeds.source_record_id=original.source_record_id)
      OR original.source_record_id IS NULL AND EXISTS(SELECT 1 FROM selected_accounts selected WHERE selected.account_id=original.account_id)'
    WHEN 'sync_state' THEN 'original.row_key=''dcad_parcels'''
    WHEN 'sync_runs' THEN 'EXISTS(SELECT 1 FROM app.neighborhood_frozen_source_rows state
      WHERE state.generation_id=$1 AND state.kind=''sync_state'' AND state.row_key=''dcad_parcels''
        AND state.payload->>''last_run_id''=original.row_key)
      OR EXISTS(SELECT 1 FROM app.neighborhood_frozen_source_rows parcel
        JOIN selected_accounts selected ON selected.account_id=parcel.account_id
        WHERE parcel.generation_id=$1 AND parcel.kind=''parcels'' AND parcel.payload->>''sync_run_id''=original.row_key)'
  END;
  EXECUTE format($plan$WITH selected_accounts AS NOT MATERIALIZED (
    SELECT account_id FROM app.neighborhood_custom_cohort_stock_accounts WHERE operation_id=$2
  ), seeds AS NOT MATERIALIZED (
    SELECT DISTINCT original.source_record_id FROM selected_accounts selected
    JOIN app.neighborhood_frozen_source_rows original ON original.account_id=selected.account_id
    WHERE original.generation_id=$1 AND original.kind IN ('source_records','sales','sale_links')
      AND original.source_record_id IS NOT NULL
  ), candidates AS MATERIALIZED (
    SELECT original.row_key,CASE WHEN %L='parcels' THEN original.payload->>'sync_run_id' IS NULL ELSE false END AS origin_unknown
    FROM app.neighborhood_frozen_source_rows original
    WHERE original.generation_id=$1 AND original.kind=%L AND (%s)
      AND ($3='' OR %s>%s) ORDER BY %s LIMIT $4+1
  ), numbered AS (
    SELECT original.*,row_number() OVER(ORDER BY %s) AS rn FROM candidates original
  ) SELECT count(*) FILTER(WHERE rn<=$4)::integer,count(*) FILTER(WHERE rn<=$4 AND origin_unknown)::integer,
      count(*)::integer,max(row_key) FILTER(WHERE rn=$4) FROM numbered$plan$,
    kind_key,kind_key,query_filter,query_order,query_cursor,query_order,query_order)
    INTO actual_count,actual_unknown,candidates_count,last_key
    USING stock.generation_id,NEW.operation_id,before_state->>'after',delta;
  last_key:=coalesce(last_key,before_state->>'after');
  completed:=candidates_count=delta AND delta<250;
  IF actual_count<>delta OR delta=0 AND NOT completed THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_prefix_conflict' USING ERRCODE='55000';
  END IF;
  IF completed AND kind_index=6 THEN
    SELECT count(*)::integer INTO missing_count FROM app.neighborhood_custom_cohort_stock_accounts selected
    WHERE selected.operation_id=NEW.operation_id AND NOT EXISTS(SELECT 1 FROM app.neighborhood_frozen_source_rows original
      WHERE original.generation_id=stock.generation_id AND original.kind='accounts'
        AND original.row_key=selected.account_id AND original.account_id=selected.account_id);
  END IF;
  expected_after:=jsonb_build_object('format',before_state->>'format','binding_sha256',before_state->>'binding_sha256',
    'kind_index',kind_index+CASE WHEN completed THEN 1 ELSE 0 END,'after',CASE WHEN completed THEN '' ELSE last_key END,
    'layer_rows',CASE WHEN completed THEN 0 ELSE (before_state->>'layer_rows')::integer+delta END,
    'unknown_parcel_origins',(before_state->>'unknown_parcel_origins')::integer+actual_unknown,'missing_account_count',missing_count);
  IF after_state IS DISTINCT FROM expected_after
    OR (before_state->>'layer_rows')::integer+delta>(counts->>kind_key)::integer
    OR completed AND (before_state->>'layer_rows')::integer+delta<>(counts->>kind_key)::integer
    OR (after_state->>'unknown_parcel_origins')::integer>(counts->>'parcels')::integer
    OR missing_count>stock.account_count THEN
    RAISE EXCEPTION 'neighborhood_identity_v2_anchor_count_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_identity_v2_anchor_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_identity_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_identity_v2_anchor();
CREATE TRIGGER neighborhood_cohort_identity_v2_anchor_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_identity_v2_anchors FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_identity_v2_anchors FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_identity_v2_anchors IS
  'Independent identity issued head binds actual completed graph/geography, root layer counts and stock. Guards exact next one-hop native keys/origin deltas/terminal missing-account coverage, not full payload identities or current rights. Trusted owner verifies real stock/graph digest and originals with both-end authorization in the receipt/anchor/checkpoint transaction. No worker, route, source grant, Apply or pin release.';
