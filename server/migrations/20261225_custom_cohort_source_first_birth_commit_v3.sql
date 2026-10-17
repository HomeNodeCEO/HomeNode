-- UNREGISTERED. Admit only the complete actual FIRST birth transaction. This
-- does not admit a fresh18 claim, recovery, NEXT, EMPTY or any default worker.
-- Keep all six existing deferred triggers and every immediate/immutable guard.
-- A row, hash, count or projected18 is never a substitute for the retained
-- ENTIRE actual17 job and independently reopened native FIRST/member/edge.
CREATE FUNCTION app.assert_neighborhood_source_resolution_v3_first_birth(op uuid,org uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual app.neighborhood_custom_cohort_source_resolution_v3_parents%ROWTYPE;
BEGIN
 SELECT p.* INTO actual
 FROM app.neighborhood_source_resolution_v3_retained_first_after_handoff(op,org) first_row
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p USING(operation_id,organization_id)
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_handoffs handoff USING(operation_id,organization_id)
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,handoff.birth_job) birth
 WHERE p.issued_transaction_id=txid_current() AND handoff.issued_transaction_id=txid_current()
  AND birth.status='running' AND birth.lease_expires_at>clock_timestamp()
  AND birth.cancellation_requested_at IS NULL AND birth.context_sha256 IS NULL;
 IF actual.operation_id IS NULL THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_first_birth_conflict' USING ERRCODE='55000';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_neighborhood_source_resolution_v3_first_birth(uuid,uuid) FROM PUBLIC;

-- Four parent/FIRST/row/head triggers already share this function. The other
-- two check the actual job update and immutable handoff. None is dropped,
-- disabled or forced; EVERY queued event independently repeats the assertion.
CREATE OR REPLACE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app.assert_neighborhood_source_resolution_v3_first_birth(NEW.operation_id,NEW.organization_id);
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.reject_neighborhood_source_resolution_v3_first_checkpoint_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app.assert_neighborhood_source_resolution_v3_first_birth(NEW.operation_id,NEW.organization_id);
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.reject_neighborhood_source_resolution_v3_first_handoff_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app.assert_neighborhood_source_resolution_v3_first_birth(NEW.operation_id,NEW.organization_id);
 RETURN NULL;
END $$;
