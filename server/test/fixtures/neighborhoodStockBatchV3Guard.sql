-- DEVELOPMENT native fixture only; deliberately NOT a registered production
-- migration. Do not activate until the whole original owner, atomic checkpoint,
-- continuation, isolated worker and coherent partition/catalog paths are proven.
-- The legacy V2 branch retains its exact original next-key/sequence semantics.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_stock_traversal_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  graph_anchor app.neighborhood_custom_cohort_graph_v2_anchors%ROWTYPE;
  geo_anchor app.neighborhood_custom_cohort_geo_v2_anchors%ROWTYPE;
  identity_anchor app.neighborhood_custom_cohort_identity_v2_anchors%ROWTYPE;
  receipt jsonb; old_receipt jsonb; identity_receipt jsonb; subject_intent jsonb;
  before_state jsonb; expected_before jsonb; expected_after jsonb; next_account text;
  is_batch boolean; native_accounts jsonb; batch_count integer; batch_originals integer;
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
  is_batch:=receipt->>'format' IS NOT DISTINCT FROM 'cohort_stock_traversal_batch_receipt_v3';
  IF identity_receipt->>'format' IS DISTINCT FROM 'cohort_source_identity_receipt_v2'
    OR identity_receipt->>'sequence' IS DISTINCT FROM identity_anchor.sequence::text
    OR identity_receipt->'after'->>'kind_index' IS DISTINCT FROM '7'
    OR NOT(is_batch OR receipt->>'format' IS NOT DISTINCT FROM 'cohort_stock_traversal_receipt_v2')
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
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>(CASE WHEN is_batch THEN 16 ELSE 14 END) THEN
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
    IF old_receipt->>'format' IS DISTINCT FROM receipt->>'format' THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_format_conflict' USING ERRCODE='55000'; END IF;
    expected_before:=old_receipt->'after';
  END IF;
  IF before_state IS DISTINCT FROM expected_before OR before_state->>'done' IS DISTINCT FROM 'false'
    OR (before_state->>'account_count')::integer<0 OR (before_state->>'account_count')::integer>stock.account_count
    OR NOT is_batch AND NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_stock_traversal_v2_anchor_transition_conflict' USING ERRCODE='55000';
  END IF;
  IF is_batch THEN
    -- A separate immutable grammar, never a reinterpretation of old V2 jobs.
    -- Independently admit EVERY consecutive native key and original resource
    -- count. These metadata probes never substitute for the actual owner's
    -- whole original/ENTIRE cache replay or current and ending source rights.
    IF jsonb_typeof(receipt->'accounts') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    batch_count:=jsonb_array_length(receipt->'accounts');
    IF batch_count>8 THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    WITH next_accounts AS MATERIALIZED (
      SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
      WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
      ORDER BY account_id LIMIT batch_count
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'geographic_parcel_count',a.parcel_count::text,
      'original_counts',jsonb_build_object('parcels',(SELECT count(*)::integer FROM (
        SELECT 1 FROM app.neighborhood_frozen_source_rows o
        WHERE o.generation_id=stock.generation_id AND o.kind='parcels' AND o.account_id=a.account_id LIMIT 251) p),
        'accounts',(SELECT count(*)::integer FROM (SELECT 1 FROM app.neighborhood_frozen_source_rows o
        WHERE o.generation_id=stock.generation_id AND o.kind='accounts' AND o.account_id=a.account_id LIMIT 251) c)))
      ORDER BY a.account_id COLLATE "C"),'[]'::jsonb) INTO native_accounts FROM next_accounts a;
    IF jsonb_array_length(native_accounts)<>batch_count OR receipt->'accounts' IS DISTINCT FROM native_accounts THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    SELECT coalesce(sum((a.value->'original_counts'->>'parcels')::integer+(a.value->'original_counts'->>'accounts')::integer),0)::integer
      INTO batch_originals FROM jsonb_array_elements(native_accounts) a;
    IF batch_originals>250 OR receipt->'original_count' IS DISTINCT FROM to_jsonb(batch_originals)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(native_accounts) a WHERE (a.value->'original_counts'->>'accounts')::integer>1
        OR (a.value->'original_counts'->>'parcels')::integer<(a.value->>'geographic_parcel_count')::bigint) THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_original_bound_conflict' USING ERRCODE='55000'; END IF;
    IF batch_count=0 THEN
      -- An explicit indexed EMPTY probe is required even when the last receipt
      -- happened to reach the stock count. No free terminal count conversion.
      IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts
        WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C" LIMIT 1) THEN
        RAISE EXCEPTION 'neighborhood_stock_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
      next_account:=NULL;
    ELSE next_account:=native_accounts->(batch_count-1)->>'account_id'; END IF;
    expected_after:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
      'account_count',(before_state->>'account_count')::integer+batch_count,'done',batch_count=0);
    IF receipt->'after' IS DISTINCT FROM expected_after
      OR (expected_after->>'account_count')::integer>stock.account_count
      OR batch_count=0 AND (expected_after->>'account_count')::integer<>stock.account_count THEN
      RAISE EXCEPTION 'neighborhood_stock_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
  ELSE
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
  END IF;
  RETURN NEW;
END;
$$;
