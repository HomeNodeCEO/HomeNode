-- DEVELOPMENT fixture ONLY; not a registered production migration.
-- V2 native grammar/row/head/deferred guards remain intact in their legacy branches.
-- V3 adds a bounded native consecutive prefix; every original/cache/entry is still replayed by the actual owner.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_recorded_partition_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_partition_v2_heads%ROWTYPE;
  previous jsonb; before_state jsonb; next_account text; entry jsonb; traversal_receipt jsonb; is_batch boolean; native_offset integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_recorded_partition_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO head FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_binding_conflict' USING ERRCODE='55000';
  END IF;
  IF head.operation_id IS NULL THEN
    before_state:='{"after_account":"","account_count":0,"done":false}'::jsonb;
    IF job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_traversal_refs_v2' THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    SELECT canonical_utf8::jsonb INTO STRICT previous FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    before_state:=previous->'after';
    IF job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2'
      OR job.checkpoint->'evidence_refs'->7 IS DISTINCT FROM head.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_transition_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  IF head.operation_id IS NULL THEN
    SELECT canonical_utf8::jsonb INTO STRICT traversal_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=job.checkpoint->'evidence_refs'->6->>'content_sha256'
        AND canonical_utf8_bytes::text=job.checkpoint->'evidence_refs'->6->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    is_batch:=traversal_receipt->>'format' IS NOT DISTINCT FROM 'cohort_stock_traversal_batch_receipt_v3';
  ELSE is_batch:=previous->>'format' IS NOT DISTINCT FROM 'cohort_recorded_group_partition_batch_receipt_v3'; END IF;
  native_offset:=NEW.ordinal-(before_state->>'account_count')::integer-1;
  IF is_batch THEN
    IF native_offset<0 OR native_offset>=8 THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    SELECT account_id INTO next_account FROM app.neighborhood_custom_cohort_stock_accounts
      WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
      ORDER BY account_id OFFSET native_offset LIMIT 1;
  ELSE
  SELECT account_id INTO next_account FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
    ORDER BY account_id LIMIT 1;
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT entry FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.entry_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.entry_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=1000000;
  IF before_state->>'done' IS DISTINCT FROM 'false' OR NEW.account_id IS DISTINCT FROM next_account
    OR NOT is_batch AND NEW.ordinal<>(before_state->>'account_count')::integer+1
    OR entry->>'format' IS DISTINCT FROM 'cohort_recorded_group_partition_entry_v2'
    OR entry->>'account_id' IS DISTINCT FROM NEW.account_id OR entry->>'ordinal' IS DISTINCT FROM NEW.ordinal::text
    OR (SELECT count(*) FROM jsonb_object_keys(entry))<>4
    OR entry->'recorded_group'->>'account_id' IS DISTINCT FROM NEW.account_id
    OR entry->'recorded_group'->>'state' IS DISTINCT FROM NEW.state
    OR entry->'recorded_group'->'assigned_group_id' IS DISTINCT FROM coalesce(to_jsonb(NEW.assigned_group_id),'null'::jsonb) THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_prefix_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_recorded_partition_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  traversal app.neighborhood_custom_cohort_stock_traversal_v2_anchors%ROWTYPE;
  traversal_receipt jsonb; subject_intent jsonb; receipt jsonb; old_receipt jsonb; entry jsonb;
  before_state jsonb; expected_before jsonb; expected_after jsonb; next_account text;
  row_entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  is_batch boolean; batch_count integer; batch_originals integer; native_accounts jsonb; native_entries jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_recorded_partition_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT traversal FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR stock.status<>'complete' OR stock.organization_id<>NEW.organization_id
    OR traversal.organization_id<>NEW.organization_id OR traversal.receipt_reference<>NEW.traversal_reference
    OR traversal.source_reference<>NEW.source_reference OR traversal.root_reference<>NEW.root_reference
    OR traversal.graph_reference<>NEW.graph_reference OR traversal.geographic_reference<>NEW.geographic_reference
    OR traversal.identity_reference<>NEW.identity_reference OR traversal.stock_reference<>NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM NEW.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM NEW.identity_reference
    OR job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM NEW.traversal_reference
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_graph_v2_anchors WHERE operation_id=NEW.operation_id
      AND receipt_reference=NEW.graph_reference AND root_reference=NEW.root_reference AND source_reference=NEW.source_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_geo_v2_anchors WHERE operation_id=NEW.operation_id
      AND receipt_reference=NEW.geographic_reference AND graph_reference=NEW.graph_reference AND stock_reference=NEW.stock_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_identity_v2_anchors WHERE operation_id=NEW.operation_id
      AND receipt_reference=NEW.identity_reference AND geographic_reference=NEW.geographic_reference AND stock_reference=NEW.stock_reference) THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_binding_conflict' USING ERRCODE='55000';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT traversal_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.traversal_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.traversal_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT subject_intent FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=job.checkpoint->'evidence_refs'->0->>'content_sha256'
      AND canonical_utf8_bytes::text=job.checkpoint->'evidence_refs'->0->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  is_batch:=receipt->>'format' IS NOT DISTINCT FROM 'cohort_recorded_group_partition_batch_receipt_v3';
  IF traversal_receipt->>'format' IS DISTINCT FROM (CASE WHEN is_batch THEN 'cohort_stock_traversal_batch_receipt_v3' ELSE 'cohort_stock_traversal_receipt_v2' END)
    OR traversal_receipt->'after'->>'done' IS DISTINCT FROM 'true'
    OR traversal_receipt->>'sequence' IS DISTINCT FROM traversal.sequence::text
    OR NOT (is_batch OR receipt->>'format' IS NOT DISTINCT FROM 'cohort_recorded_group_partition_receipt_v2')
    OR receipt->'binding' IS DISTINCT FROM traversal_receipt->'binding'
    OR receipt->'binding'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'binding'->>'spatial_definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR receipt->'binding'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR receipt->'source_reference' IS DISTINCT FROM NEW.source_reference OR receipt->'root' IS DISTINCT FROM NEW.root_reference
    OR receipt->'graph_verification_reference' IS DISTINCT FROM NEW.graph_reference
    OR receipt->'stock_verification_reference' IS DISTINCT FROM NEW.geographic_reference
    OR receipt->'identity_verification_reference' IS DISTINCT FROM NEW.identity_reference
    OR receipt->'stock_reference' IS DISTINCT FROM NEW.stock_reference OR receipt->'traversal_reference' IS DISTINCT FROM NEW.traversal_reference
    OR receipt->'profile_reference' IS DISTINCT FROM NEW.profile_reference
    OR receipt->>'effective_date' IS NULL OR receipt->>'effective_date' IS DISTINCT FROM subject_intent->>'effective_date'
    OR subject_intent->>'operation_id' IS DISTINCT FROM NEW.operation_id::text
    OR receipt->>'stock_account_count' IS DISTINCT FROM stock.account_count::text
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>(CASE WHEN is_batch THEN 19 ELSE 17 END) THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_binding_conflict' USING ERRCODE='55000';
  END IF;
  before_state:=receipt->'before';
  IF TG_OP='INSERT' THEN
    expected_before:='{"after_account":"","account_count":0,"done":false}'::jsonb;
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_traversal_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>7 THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_initial_head_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.receipt_reference=OLD.receipt_reference
      OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>8
      OR job.checkpoint->'evidence_refs'->7 IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_transition_conflict' USING ERRCODE='55000';
    END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF old_receipt->>'format' IS DISTINCT FROM receipt->>'format' THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_format_conflict' USING ERRCODE='55000'; END IF;
    expected_before:=old_receipt->'after';
  END IF;
  IF before_state IS DISTINCT FROM expected_before OR before_state->>'done' IS DISTINCT FROM 'false'
    OR NOT is_batch AND NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_transition_conflict' USING ERRCODE='55000';
  END IF;
  IF is_batch THEN
    IF jsonb_typeof(receipt->'accounts') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'entries') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    batch_count:=jsonb_array_length(receipt->'accounts');
    IF batch_count>8 OR jsonb_array_length(receipt->'entries')<>batch_count THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    WITH next_accounts AS MATERIALIZED (
      SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
      WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
      ORDER BY account_id LIMIT batch_count
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'geographic_parcel_count',a.parcel_count::text,
      'original_counts',jsonb_build_object('parcels',(SELECT count(*)::integer FROM (
        SELECT 1 FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=stock.generation_id AND o.kind='parcels'
          AND o.account_id=a.account_id LIMIT 251) p),'accounts',(SELECT count(*)::integer FROM (
        SELECT 1 FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=stock.generation_id AND o.kind='accounts'
          AND o.account_id=a.account_id LIMIT 251) c))) ORDER BY a.account_id COLLATE "C"),'[]'::jsonb)
      INTO native_accounts FROM next_accounts a;
    IF jsonb_array_length(native_accounts)<>batch_count OR receipt->'accounts' IS DISTINCT FROM native_accounts THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    SELECT coalesce(sum((a.value->'original_counts'->>'parcels')::integer+(a.value->'original_counts'->>'accounts')::integer),0)::integer
      INTO batch_originals FROM jsonb_array_elements(native_accounts) a;
    IF batch_originals>250 OR receipt->'original_count' IS DISTINCT FROM to_jsonb(batch_originals)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(native_accounts) a WHERE (a.value->'original_counts'->>'accounts')::integer>1
        OR (a.value->'original_counts'->>'parcels')::integer<(a.value->>'geographic_parcel_count')::bigint) THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_original_bound_conflict' USING ERRCODE='55000'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',r.account_id,'ordinal',r.ordinal,
      'entry_reference',r.entry_reference,'state',r.state,'assigned_group_id',r.assigned_group_id) ORDER BY a.ord),'[]'::jsonb)
      INTO native_entries FROM jsonb_array_elements(native_accounts) WITH ORDINALITY a(value,ord)
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows r ON r.operation_id=NEW.operation_id
        AND r.organization_id=NEW.organization_id AND r.account_id=a.value->>'account_id'
        AND r.ordinal=(before_state->>'account_count')::integer+a.ord;
    IF jsonb_array_length(native_entries)<>batch_count OR receipt->'entries' IS DISTINCT FROM native_entries THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_entry_conflict' USING ERRCODE='55000'; END IF;
    FOR row_entry IN SELECT r.* FROM jsonb_array_elements(native_entries) a
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows r ON r.operation_id=NEW.operation_id
        AND r.organization_id=NEW.organization_id AND r.account_id=a.value->>'account_id'
    LOOP
      SELECT canonical_utf8::jsonb INTO STRICT entry FROM app.neighborhood_cohort_evidence_blobs
        WHERE organization_id=NEW.organization_id AND content_sha256=row_entry.entry_reference->>'content_sha256'
          AND canonical_utf8_bytes::text=row_entry.entry_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=1000000;
      IF entry->'recorded_group'->'profile'->'definition_blob'->'ref' IS DISTINCT FROM NEW.profile_reference THEN
        RAISE EXCEPTION 'neighborhood_partition_batch_v3_entry_conflict' USING ERRCODE='55000'; END IF;
    END LOOP;
    IF batch_count=0 THEN
      IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts
        WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C" LIMIT 1) THEN
        RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
      next_account:=NULL;
    ELSE next_account:=native_accounts->(batch_count-1)->>'account_id'; END IF;
    expected_after:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
      'account_count',(before_state->>'account_count')::integer+batch_count,'done',batch_count=0);
    IF receipt->'after' IS DISTINCT FROM expected_after OR (expected_after->>'account_count')::integer>stock.account_count
      OR batch_count=0 AND (expected_after->>'account_count')::integer<>stock.account_count THEN
      RAISE EXCEPTION 'neighborhood_partition_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
  ELSE
  SELECT account_id INTO next_account FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
    ORDER BY account_id LIMIT 1;
  expected_after:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
    'account_count',(before_state->>'account_count')::integer+CASE WHEN next_account IS NULL THEN 0 ELSE 1 END,'done',next_account IS NULL);
  IF receipt->'after' IS DISTINCT FROM expected_after OR (expected_after->>'account_count')::integer>stock.account_count
    OR next_account IS NULL AND ((expected_after->>'account_count')::integer<>stock.account_count OR receipt->'entry_reference' IS DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_prefix_conflict' USING ERRCODE='55000';
  END IF;
  IF next_account IS NOT NULL THEN
    SELECT * INTO STRICT row_entry FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
      WHERE operation_id=NEW.operation_id AND account_id=next_account AND ordinal=NEW.sequence;
    SELECT canonical_utf8::jsonb INTO STRICT entry FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=row_entry.entry_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=row_entry.entry_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=1000000;
    IF row_entry.organization_id<>NEW.organization_id OR receipt->'entry_reference' IS DISTINCT FROM row_entry.entry_reference
      OR entry->'recorded_group'->'profile'->'definition_blob'->'ref' IS DISTINCT FROM NEW.profile_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_entry_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.check_neighborhood_recorded_partition_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_partition_v2_heads%ROWTYPE; checkpoint jsonb; receipt jsonb;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT job.checkpoint INTO STRICT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs job WHERE operation_id=NEW.operation_id;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=head.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2' OR jsonb_array_length(checkpoint->'evidence_refs')<>8
    OR checkpoint->'evidence_refs'->7 IS DISTINCT FROM head.receipt_reference THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_commit_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='neighborhood_custom_cohort_recorded_partition_v2_rows' THEN
    IF receipt->>'format'='cohort_recorded_group_partition_batch_receipt_v3' THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipt->'entries') e WHERE
        e.value=jsonb_build_object('account_id',NEW.account_id,'ordinal',NEW.ordinal,'entry_reference',NEW.entry_reference,
          'state',NEW.state,'assigned_group_id',NEW.assigned_group_id)) THEN
        RAISE EXCEPTION 'neighborhood_partition_batch_v3_commit_conflict' USING ERRCODE='55000'; END IF;
    ELSIF head.sequence<>NEW.ordinal OR receipt->'entry_reference' IS DISTINCT FROM NEW.entry_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_commit_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
