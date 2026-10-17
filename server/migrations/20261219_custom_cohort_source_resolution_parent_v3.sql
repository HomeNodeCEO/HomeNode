-- UNREGISTERED native parent groundwork. This is not exact18 admission or a
-- source owner. The ACTUAL issued exact17 checkpoint is captured while the job
-- still has it; a later owner must never reconstruct17 from a caller's18.
-- No grants, activation, cursor, source facts, report writes or pin transfer.
-- Every durable COMMIT deliberately refuses until coherent issuance exists.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_parents (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
 report_file_id uuid NOT NULL,
 assignment_file_id bigint NOT NULL CHECK(assignment_file_id>0),
 account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
 actor_user_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 generation_id uuid NOT NULL,
 index_reference jsonb NOT NULL CHECK(octet_length(index_reference::text) BETWEEN 100 AND 256),
 index_sequence integer NOT NULL CHECK(index_sequence BETWEEN 1 AND 2000001),
 parent_checkpoint jsonb NOT NULL CHECK(octet_length(parent_checkpoint::text) BETWEEN 100 AND 4096),
 issued_claim_token uuid NOT NULL,
 issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0),
 FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Only operation/organization select the native job. No caller checkpoint,
-- reference, generation, claim, attempt, source key, cursor or DONE is accepted.
-- This structural read is NOT current actor/assignment/source-purpose authority.
CREATE FUNCTION app.neighborhood_source_resolution_v3_native_parent(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_parents
LANGUAGE sql VOLATILE AS $$
 SELECT job.operation_id,job.organization_id,job.report_file_id,job.assignment_file_id,
  job.account_id,job.actor_user_id,job.request_sha256,h.command_id,h.generation_id,
  h.receipt_reference,h.sequence,job.checkpoint,job.claim_token,job.attempts,txid_current()
 FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h USING(operation_id,organization_id)
 JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=h.organization_id
  AND b.content_sha256=h.receipt_reference->>'content_sha256'
  AND b.canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
 JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id
  AND stock.organization_id=job.organization_id AND stock.generation_id=h.generation_id
  AND stock.report_file_id=job.report_file_id AND stock.assignment_file_id=job.assignment_file_id
  AND stock.account_id=job.account_id AND stock.actor_user_id=job.actor_user_id AND stock.status='complete'
 JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id
  AND pin.organization_id=stock.organization_id AND pin.generation_id=stock.generation_id
  AND pin.report_file_id=stock.report_file_id AND pin.assignment_file_id=stock.assignment_file_id
  AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
 JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
  AND generation.status='complete' AND generation.retirement_started_at IS NULL
 JOIN app.neighborhood_custom_cohort_v2_selection_intents command ON command.operation_id=job.operation_id
  AND command.organization_id=job.organization_id AND command.command_id=h.command_id
  AND command.request_sha256=job.request_sha256
 JOIN app.neighborhood_custom_cohort_v2_continuations continuation ON continuation.operation_id=job.operation_id
  AND continuation.organization_id=job.organization_id AND continuation.phase=job.checkpoint->>'phase'
  AND continuation.progress_reference=h.receipt_reference AND continuation.consumed_claim_token IS NOT NULL
  AND continuation.issued_attempts>=command.issued_attempts
  AND ((job.attempts=continuation.issued_attempts AND job.claim_token=continuation.consumed_claim_token)
   OR (job.attempts>continuation.issued_attempts AND job.claim_token<>continuation.issued_claim_token
    AND job.claim_token<>continuation.consumed_claim_token AND job.claim_token<>command.resume_claim_token))
 WHERE job.operation_id=op AND job.organization_id=org AND job.status='running'
  AND job.request_payload->>'execution_mode'='frozen-originals-v2'
  AND job.claim_token IS NOT NULL AND job.lease_expires_at>clock_timestamp()
  AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
  AND app.neighborhood_selected_transaction_index_v2_checkpoint_matches(op,org,job.checkpoint)
  AND b.canonical_utf8::jsonb->>'format'='cohort_selected_transaction_index_receipt_v2'
  AND b.canonical_utf8::jsonb->>'sequence'=h.sequence::text
  AND b.canonical_utf8::jsonb->'after'->>'done'='true'
  AND b.canonical_utf8::jsonb->>'selected_stock_count'=(h.sequence-1)::text
 FOR UPDATE OF job NOWAIT
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_native_parent(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected app.neighborhood_custom_cohort_source_resolution_v3_parents%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_source_resolution_v3_parent_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO expected FROM app.neighborhood_source_resolution_v3_native_parent(NEW.operation_id,NEW.organization_id);
 IF NOT FOUND OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(expected) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_parent_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_parent_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_parents FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_parent();
CREATE TRIGGER neighborhood_source_resolution_v3_parent_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_parents FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_source_resolution_v3_owner_unintegrated' USING ERRCODE='55000'; END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_parent_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_parents DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_source_resolution_v3_unintegrated();
