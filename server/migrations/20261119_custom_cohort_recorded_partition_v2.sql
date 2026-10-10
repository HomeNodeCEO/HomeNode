-- Dormant original-backed recorded-label partition, not selected-union authority.
CREATE TABLE app.neighborhood_custom_cohort_recorded_partition_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  traversal_reference jsonb NOT NULL CHECK(octet_length(traversal_reference::text) BETWEEN 100 AND 256),
  profile_reference jsonb NOT NULL CHECK(octet_length(profile_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);
CREATE TABLE app.neighborhood_custom_cohort_recorded_partition_v2_rows (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
  state text NOT NULL CHECK(state IN ('assigned','unassigned')),
  assigned_group_id text COLLATE "C",
  PRIMARY KEY(operation_id,account_id), UNIQUE(operation_id,ordinal),
  CHECK((state='assigned' AND assigned_group_id IS NOT NULL AND assigned_group_id ~ '^recorded-cad:[a-f0-9]{64}$')
    OR (state='unassigned' AND assigned_group_id IS NULL))
);
CREATE INDEX neighborhood_recorded_partition_v2_group_members
  ON app.neighborhood_custom_cohort_recorded_partition_v2_rows(operation_id,assigned_group_id,account_id)
  WHERE state='assigned';

CREATE FUNCTION app.guard_neighborhood_recorded_partition_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_partition_v2_heads%ROWTYPE;
  previous jsonb; before_state jsonb; next_account text; entry jsonb;
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
  SELECT account_id INTO next_account FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
    ORDER BY account_id LIMIT 1;
  SELECT canonical_utf8::jsonb INTO STRICT entry FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.entry_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.entry_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=1000000;
  IF before_state->>'done' IS DISTINCT FROM 'false' OR NEW.account_id IS DISTINCT FROM next_account
    OR NEW.ordinal<>(before_state->>'account_count')::integer+1
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
CREATE TRIGGER neighborhood_recorded_partition_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_rows FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_recorded_partition_v2_row();

CREATE FUNCTION app.guard_neighborhood_recorded_partition_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  traversal app.neighborhood_custom_cohort_stock_traversal_v2_anchors%ROWTYPE;
  traversal_receipt jsonb; subject_intent jsonb; receipt jsonb; old_receipt jsonb; entry jsonb;
  before_state jsonb; expected_before jsonb; expected_after jsonb; next_account text;
  row_entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
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
  IF traversal_receipt->>'format' IS DISTINCT FROM 'cohort_stock_traversal_receipt_v2'
    OR traversal_receipt->'after'->>'done' IS DISTINCT FROM 'true'
    OR traversal_receipt->>'sequence' IS DISTINCT FROM traversal.sequence::text
    OR receipt->>'format' IS DISTINCT FROM 'cohort_recorded_group_partition_receipt_v2'
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
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>17 THEN
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
    expected_before:=old_receipt->'after';
  END IF;
  IF before_state IS DISTINCT FROM expected_before OR before_state->>'done' IS DISTINCT FROM 'false'
    OR NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_recorded_partition_v2_transition_conflict' USING ERRCODE='55000';
  END IF;
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_recorded_partition_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_recorded_partition_v2_head();

-- A row cannot be committed without the matching newly issued head AND root
-- checkpoint. Successful one-account steps never leave an orphan derived row.
CREATE FUNCTION app.check_neighborhood_recorded_partition_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF head.sequence<>NEW.ordinal OR receipt->'entry_reference' IS DISTINCT FROM NEW.entry_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_partition_v2_commit_conflict' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER neighborhood_recorded_partition_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_recorded_partition_v2_rows DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_recorded_partition_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_recorded_partition_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_recorded_partition_v2_commit();
CREATE TRIGGER neighborhood_recorded_partition_v2_row_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_recorded_partition_v2_head_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_heads FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_recorded_partition_v2_rows FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_recorded_partition_v2_heads FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_recorded_partition_v2_rows IS
  'Original-backed recorded-label per-account partition, including unassigned/conflicting denominator rows. Trusted current-authorized owner replays EVERY original/ENTIRE neutral cache before same-TX row/receipt/head/checkpoint. Native guards issue exact next stock key/ordinal and fresh empty terminal probe. Derived labels only, no original payload copies. Every later semantic consumer must reopen/reconcile entire original result; count/hash/DONE/row alone is NOT selection/statistics/source-rights authority. Inactive; no report update or terminal pin transfer.';
