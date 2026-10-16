-- DEVELOPMENT fixture ONLY; unregistered/inactive.
-- Retain the entire original intent grammar, current pending target, delayed known-ID lookup,
-- deferred real command/resume COMMIT guard and immutable 120s protocol. V3 adds only exact native terminal lineage.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb; workspace record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_v2_selection_intent_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'awaiting_selection' OR job.claim_token IS NOT NULL
    OR job.lease_expires_at IS NOT NULL OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.attempts<>NEW.issued_attempts OR job.request_sha256<>NEW.request_sha256 OR job.checkpoint IS DISTINCT FROM NEW.checkpoint
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'
    OR jsonb_array_length(job.checkpoint->'evidence_refs') IS DISTINCT FROM 9
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c WHERE c.operation_id=job.operation_id
      AND NEW.resume_claim_token IN (c.issued_claim_token,c.consumed_claim_token)) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_waiting_required' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads
    WHERE operation_id=job.operation_id AND organization_id=job.organization_id;
  IF head.stock_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->1
    OR head.source_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->2
    OR head.graph_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->3
    OR head.geographic_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->4
    OR head.identity_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->5
    OR head.traversal_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->6
    OR head.partition_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->7
    OR head.receipt_reference IS DISTINCT FROM job.checkpoint->'evidence_refs'->8
    OR head.profile_reference IS DISTINCT FROM NEW.profile_reference THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=job.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(receipt))<>22
      OR receipt->'accounts' IS DISTINCT FROM '[]'::jsonb OR receipt->'entries' IS DISTINCT FROM '[]'::jsonb
      OR receipt->'original_count' IS DISTINCT FROM '0'::jsonb
      OR receipt->'before'->>'done' IS DISTINCT FROM 'false'
      OR receipt->'after' IS DISTINCT FROM jsonb_set(receipt->'before','{done}','true'::jsonb)
      OR receipt->'after_counts' IS DISTINCT FROM receipt->'before_counts'
      OR receipt->'partition_reference' IS DISTINCT FROM head.partition_reference
      OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads p
        JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors t ON t.operation_id=p.operation_id AND t.organization_id=p.organization_id
        JOIN app.neighborhood_cohort_evidence_blobs pb ON pb.organization_id=p.organization_id
          AND pb.content_sha256=p.receipt_reference->>'content_sha256'
          AND pb.canonical_utf8_bytes::text=p.receipt_reference->>'canonical_utf8_bytes' AND pb.canonical_utf8_bytes<=16000
        JOIN app.neighborhood_cohort_evidence_blobs tb ON tb.organization_id=t.organization_id
          AND tb.content_sha256=t.receipt_reference->>'content_sha256'
          AND tb.canonical_utf8_bytes::text=t.receipt_reference->>'canonical_utf8_bytes' AND tb.canonical_utf8_bytes<=16000
        WHERE p.operation_id=job.operation_id AND p.organization_id=job.organization_id
          AND p.receipt_reference=head.partition_reference AND t.receipt_reference=head.traversal_reference
          AND p.traversal_reference=t.receipt_reference AND p.profile_reference=head.profile_reference
          AND p.source_reference=head.source_reference AND p.root_reference=head.root_reference
          AND p.graph_reference=head.graph_reference AND p.geographic_reference=head.geographic_reference
          AND p.identity_reference=head.identity_reference AND p.stock_reference=head.stock_reference
          AND pb.canonical_utf8::jsonb->>'format'='cohort_recorded_group_partition_batch_receipt_v3'
          AND pb.canonical_utf8::jsonb->'after'->>'done'='true'
          AND tb.canonical_utf8::jsonb->>'format'='cohort_stock_traversal_batch_receipt_v3'
          AND tb.canonical_utf8::jsonb->'after'->>'done'='true') THEN
      RAISE EXCEPTION 'neighborhood_batch_selection_intent_v3_catalog_conflict' USING ERRCODE='55000'; END IF;
  ELSIF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  IF receipt->>'format' NOT IN ('cohort_recorded_catalog_receipt_v2','cohort_recorded_catalog_batch_receipt_v3')
    OR receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  -- Pure ID shape only before current source policy. Known-ID lookup is
  -- deliberately deferred: a revoked license must not probe group existence
  -- through an early native error. The actual owner checks it after policy at
  -- both ends; the commit trigger is a second structural safeguard only.
  IF jsonb_array_length(NEW.included_group_ids)>2049
    OR (SELECT count(*) FROM jsonb_array_elements(NEW.included_group_ids) AS items(v) WHERE jsonb_typeof(v)<>'string')<>0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id)
      WHERE id !~ '^(recorded-cad:[a-f0-9]{64}|discovery:unassigned)$')
    OR (SELECT count(*) FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id) WHERE id<>'discovery:unassigned')>2048
    OR (SELECT count(*) FROM jsonb_array_elements_text(NEW.included_group_ids))
      <>(SELECT count(DISTINCT id) FROM jsonb_array_elements_text(NEW.included_group_ids) AS ids(id)) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_group_conflict' USING ERRCODE='55000'; END IF;
  SELECT revision,section_value INTO STRICT workspace FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=job.assignment_file_id AND section_key='neighborhood_workspace' FOR SHARE NOWAIT;
  IF workspace.revision<>NEW.workspace_revision OR workspace.section_value IS DISTINCT FROM NEW.workspace_checkpoint
    OR NEW.workspace_checkpoint->>'workspace_version' IS DISTINCT FROM '7'
    OR NEW.workspace_checkpoint->'pending_capture'->>'operation_id' IS DISTINCT FROM job.operation_id::text
    OR NEW.workspace_checkpoint->'pending_capture'->'observation_period' IS DISTINCT FROM job.request_payload->'observation_period'
    OR NEW.workspace_checkpoint->'pending_capture'->'discovery' IS DISTINCT FROM job.request_payload->'discovery'
    OR NEW.workspace_checkpoint->'pending_capture'->'private_sales_import' IS DISTINCT FROM job.request_payload->'private_sales_import'
    OR NEW.workspace_checkpoint->'active'->'context_ref'->>'context_id'=job.operation_id::text THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_workspace_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
