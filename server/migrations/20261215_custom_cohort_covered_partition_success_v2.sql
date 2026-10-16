-- Dormant successor to the actual native cache/first-stock bridge. No registry,
-- source permission, route, schedule, publication or retention-pin activation.
-- Legacy manual partitions have no neutral-success enrollment and are unchanged.
CREATE FUNCTION app.check_neighborhood_covered_partition_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e
    WHERE e.operation_id=NEW.operation_id AND e.organization_id=NEW.organization_id) THEN RETURN NEW; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_covered_partition_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  -- The unchanged native partition guard already issued this exact next head,
  -- whole entry/ordinal and checkpoint under the actual live owner claim. Its
  -- new reference cannot be an earlier continuation: the same-TX yield must
  -- match it and release the lease. Rolling back only yield cannot strand it.
  IF job.organization_id<>NEW.organization_id OR job.request_payload->>'execution_mode' IS DISTINCT FROM 'frozen-originals-v2'
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2'
    OR jsonb_array_length(job.checkpoint->'evidence_refs')<>8
    OR job.checkpoint->'evidence_refs'->7 IS DISTINCT FROM NEW.receipt_reference
    OR c.organization_id<>job.organization_id OR c.phase<>'frozen_recorded_partition_refs_v2'
    OR c.progress_reference IS DISTINCT FROM NEW.receipt_reference OR c.issued_attempts<>job.attempts
    OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry' OR job.claim_token IS NOT NULL
    OR job.lease_expires_at IS NOT NULL OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b
      JOIN app.neighborhood_custom_cohort_neutral_success_v2_jobs e
        USING(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,request_sha256)
      JOIN app.neighborhood_custom_cohort_neutral_cache_v2_heads cache
        ON cache.operation_id=e.operation_id AND cache.organization_id=e.organization_id
      JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors stock
        ON stock.operation_id=e.operation_id AND stock.organization_id=e.organization_id
      WHERE b.operation_id=job.operation_id AND b.organization_id=job.organization_id AND b.report_file_id=job.report_file_id
        AND b.assignment_file_id=job.assignment_file_id AND b.account_id=job.account_id AND b.actor_user_id=job.actor_user_id
        AND b.request_sha256=job.request_sha256 AND b.completed_reference IS NOT NULL
        AND e.sequence=b.cache_sequence AND e.receipt_reference=b.cache_reference AND e.consumed_claim_token IS NULL
        AND cache.sequence=e.sequence AND cache.receipt_reference=e.receipt_reference AND cache.identity_reference=e.identity_reference
        AND stock.receipt_reference=NEW.traversal_reference AND stock.receipt_reference=job.checkpoint->'evidence_refs'->6
        AND stock.identity_reference=e.identity_reference AND stock.stock_reference=NEW.stock_reference
        AND cache.root_reference=NEW.root_reference AND cache.source_reference=NEW.source_reference
        AND cache.graph_reference=NEW.graph_reference AND cache.geographic_reference=NEW.geographic_reference
        AND cache.identity_reference=NEW.identity_reference AND cache.stock_reference=NEW.stock_reference) THEN
    RAISE EXCEPTION 'neighborhood_covered_partition_v2_commit_conflict' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_covered_partition_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_recorded_partition_v2_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_covered_partition_v2_commit();
COMMENT ON FUNCTION app.check_neighborhood_covered_partition_v2_commit() IS
  'Native completed-cache jobs must pair each actual original-backed partition head/checkpoint with its exact fresh-token continuation and lease release in the same transaction. Independent original/graph/geography/identity/stock/cache parents remain mandatory. Manual unenrolled jobs unchanged. Dormant; not selected-union/source/publication authority or pin transfer.';
