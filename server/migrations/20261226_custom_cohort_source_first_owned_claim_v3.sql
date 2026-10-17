-- UNREGISTERED initial single-consume FIRST18 success claim. No original
-- authority, recovery, renewal, NEXT/EMPTY, activation or terminal pin transfer.
-- The immutable actual17 birth is NEVER rebound to this new token/transaction.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_claims (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_handoffs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 preclaim_job jsonb NOT NULL CHECK(octet_length(preclaim_job::text) BETWEEN 100 AND 32768),
 claim_token uuid NOT NULL,
 attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 5),
 issued_at timestamptz NOT NULL,
 lease_seconds integer NOT NULL CHECK(lease_seconds BETWEEN 15 AND 900),
 lease_expires_at timestamptz NOT NULL,
 birth_transaction_id bigint NOT NULL CHECK(birth_transaction_id>0),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0),
 CHECK(issued_transaction_id<>birth_transaction_id),
 CHECK(lease_expires_at=issued_at+(lease_seconds*interval '1 second'))
);

-- The actual retained reader locks/reopens the immutable17/FIRST graph BEFORE
-- issuing. No caller JSON, reconstructed17, source callback or count is proof.
CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_first_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
 h app.neighborhood_custom_cohort_source_resolution_v3_handoffs%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_claim_immutable' USING ERRCODE='55000'; END IF;
 SELECT job.* INTO actual
 FROM app.neighborhood_source_resolution_v3_retained_first_after_handoff(NEW.operation_id,NEW.organization_id) first_row
 JOIN app.neighborhood_custom_cohort_capture_jobs job USING(operation_id,organization_id);
 SELECT * INTO h FROM app.neighborhood_custom_cohort_source_resolution_v3_handoffs
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 IF actual.operation_id IS NULL OR h.operation_id IS NULL
  OR NEW.preclaim_job IS DISTINCT FROM to_jsonb(actual) OR NEW.attempts<>actual.attempts
  OR NEW.birth_transaction_id<>h.issued_transaction_id OR NEW.issued_transaction_id<>txid_current()
  OR NEW.issued_transaction_id=h.issued_transaction_id OR NEW.claim_token=h.issued_claim_token
  OR NEW.issued_at NOT BETWEEN transaction_timestamp() AND clock_timestamp()
  OR NEW.lease_expires_at<=clock_timestamp() OR NEW.lease_expires_at>clock_timestamp()+interval '900 seconds'
  OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c
    JOIN app.neighborhood_custom_cohort_v2_selection_intents command USING(operation_id,organization_id)
    WHERE c.operation_id=NEW.operation_id AND (NEW.claim_token=c.issued_claim_token
      OR NEW.claim_token=c.consumed_claim_token OR NEW.claim_token=command.resume_claim_token)) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_first_claim_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_first_claim_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_claims FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_first_claim();
CREATE TRIGGER neighborhood_source_resolution_v3_first_claim_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_claims FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

-- Reopen the ENTIRE native birth, independent index/stock/pin/command/original
-- continuation, candidate/head/blob and immutable actual preclaim18. Compare
-- EVERY actual owned-job field except the four exact initial claim changes.
-- This is structural metadata ONLY, never source or actor authorization.
CREATE FUNCTION app.neighborhood_source_resolution_v3_owned_first_parent(op uuid,org uuid,token uuid,attempt integer)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_parents
LANGUAGE sql VOLATILE AS $$
 SELECT p.*
 FROM app.neighborhood_custom_cohort_source_resolution_v3_handoffs handoff
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,handoff.birth_job) birth
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_claims issued
  ON issued.operation_id=handoff.operation_id AND issued.organization_id=handoff.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,issued.preclaim_job) preclaim
 JOIN app.neighborhood_custom_cohort_capture_jobs owned
  ON owned.operation_id=issued.operation_id AND owned.organization_id=issued.organization_id
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_parents p
  ON p.operation_id=birth.operation_id AND p.organization_id=birth.organization_id
  AND p.report_file_id=birth.report_file_id AND p.assignment_file_id=birth.assignment_file_id
  AND p.account_id=birth.account_id AND p.actor_user_id=birth.actor_user_id AND p.request_sha256=birth.request_sha256
  AND p.parent_checkpoint=birth.checkpoint AND p.issued_claim_token=birth.claim_token AND p.issued_attempts=birth.attempts
  AND p.issued_transaction_id=handoff.issued_transaction_id
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads index_head
  ON index_head.operation_id=p.operation_id AND index_head.organization_id=p.organization_id
  AND index_head.command_id=p.command_id AND index_head.generation_id=p.generation_id
  AND index_head.receipt_reference=p.index_reference AND index_head.sequence=p.index_sequence
 JOIN app.neighborhood_cohort_evidence_blobs index_body ON index_body.organization_id=p.organization_id
  AND index_body.content_sha256=p.index_reference->>'content_sha256'
  AND index_body.canonical_utf8_bytes::text=p.index_reference->>'canonical_utf8_bytes' AND index_body.canonical_utf8_bytes<=4096
 JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=p.operation_id
  AND stock.organization_id=p.organization_id AND stock.generation_id=p.generation_id
  AND stock.report_file_id=p.report_file_id AND stock.assignment_file_id=p.assignment_file_id
  AND stock.account_id=p.account_id AND stock.actor_user_id=p.actor_user_id AND stock.status='complete'
 JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id
  AND pin.organization_id=stock.organization_id AND pin.generation_id=stock.generation_id
  AND pin.report_file_id=stock.report_file_id AND pin.assignment_file_id=stock.assignment_file_id
  AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
 JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
  AND generation.status='complete' AND generation.retirement_started_at IS NULL
 JOIN app.neighborhood_custom_cohort_v2_selection_intents command ON command.operation_id=p.operation_id
  AND command.organization_id=p.organization_id AND command.command_id=p.command_id AND command.request_sha256=p.request_sha256
 JOIN app.neighborhood_custom_cohort_v2_continuations continuation ON continuation.operation_id=p.operation_id
  AND continuation.organization_id=p.organization_id AND continuation.phase=birth.checkpoint->>'phase'
  AND continuation.progress_reference=p.index_reference AND continuation.consumed_claim_token IS NOT NULL
  AND continuation.issued_attempts>=command.issued_attempts
  AND ((birth.attempts=continuation.issued_attempts AND birth.claim_token=continuation.consumed_claim_token)
   OR (birth.attempts>continuation.issued_attempts AND birth.claim_token<>continuation.issued_claim_token
    AND birth.claim_token<>continuation.consumed_claim_token AND birth.claim_token<>command.resume_claim_token))
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_rows candidate
  ON candidate.operation_id=p.operation_id AND candidate.organization_id=p.organization_id
  AND candidate.sequence=1 AND candidate.issued_transaction_id=p.issued_transaction_id
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_heads source_head
  ON source_head.operation_id=candidate.operation_id AND to_jsonb(source_head)=to_jsonb(candidate)
 JOIN app.neighborhood_cohort_evidence_blobs candidate_body ON candidate_body.organization_id=p.organization_id
  AND candidate.candidate_reference=jsonb_build_object('content_sha256',candidate_body.content_sha256,
   'canonical_utf8_bytes',candidate_body.canonical_utf8_bytes::text) AND candidate_body.canonical_utf8_bytes<=12000
 WHERE handoff.operation_id=op AND handoff.organization_id=org AND handoff.sequence=1
  AND to_jsonb(birth)=handoff.birth_job
  AND birth.status='running' AND birth.claim_token=handoff.issued_claim_token AND birth.attempts=handoff.issued_attempts
  AND birth.lease_expires_at IS NOT NULL AND birth.cancellation_requested_at IS NULL AND birth.context_sha256 IS NULL
  AND birth.request_payload->>'execution_mode'='frozen-originals-v2'
  AND app.neighborhood_selected_transaction_index_v2_checkpoint_matches(op,org,birth.checkpoint)
  AND index_body.canonical_utf8::jsonb->>'format'='cohort_selected_transaction_index_receipt_v2'
  AND index_body.canonical_utf8::jsonb->>'sequence'=p.index_sequence::text
  AND index_body.canonical_utf8::jsonb->'after'->>'done'='true'
  AND index_body.canonical_utf8::jsonb->>'selected_stock_count'=(p.index_sequence-1)::text
  AND preclaim.status='retry' AND preclaim.claim_token IS NULL AND preclaim.lease_expires_at IS NULL
  AND preclaim.cancellation_requested_at IS NULL AND preclaim.context_sha256 IS NULL
  AND preclaim.checkpoint=handoff.checkpoint
  AND handoff.checkpoint=jsonb_build_object('phase','frozen_selected_source_resolution_refs_v3',
   'evidence_refs',(p.parent_checkpoint->'evidence_refs')||jsonb_build_array(candidate.candidate_reference))
  AND (to_jsonb(preclaim)-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])
   =(handoff.birth_job-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])
  AND preclaim.run_after>=birth.updated_at AND preclaim.run_after<=clock_timestamp()
  AND preclaim.updated_at>=birth.updated_at AND preclaim.updated_at<=clock_timestamp()
  AND to_jsonb(preclaim)=issued.preclaim_job AND preclaim.operation_id=handoff.operation_id
  AND preclaim.organization_id=handoff.organization_id
  AND issued.birth_transaction_id=handoff.issued_transaction_id
  AND issued.issued_transaction_id<>handoff.issued_transaction_id
  AND issued.attempts=preclaim.attempts AND issued.claim_token<>handoff.issued_claim_token
  AND owned.status='running' AND owned.claim_token=issued.claim_token AND owned.claim_token=token
  AND owned.attempts=issued.attempts AND owned.attempts=attempt
  AND owned.lease_expires_at=issued.lease_expires_at AND owned.lease_expires_at>clock_timestamp()
  AND owned.updated_at=issued.issued_at
  AND (to_jsonb(owned)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
   =(issued.preclaim_job-ARRAY['status','claim_token','lease_expires_at','updated_at'])
 FOR UPDATE OF owned NOWAIT
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_owned_first_parent(uuid,uuid,uuid,integer) FROM PUBLIC;

-- Independently select the actual FIRST key/first-seen member again from the
-- immutable native index. A stored FIRST row or reference alone is not proof.
CREATE FUNCTION app.neighborhood_source_resolution_v3_owned_first(op uuid,org uuid,token uuid,attempt integer)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_first
LANGUAGE sql VOLATILE AS $$
 WITH actual AS (
 SELECT p.operation_id,p.organization_id,p.generation_id,p.command_id,p.index_reference,p.index_sequence,
  k.kind,k.native_key,k.first_selected_ordinal,m.account_id AS selected_account_id,m.partition_ordinal,
  m.entry_reference,m.metric_row_reference,m.contribution_row_reference,p.issued_transaction_id
 FROM app.neighborhood_source_resolution_v3_owned_first_parent(op,org,token,attempt) p
 CROSS JOIN LATERAL (
  (SELECT 'source_record'::text AS kind,source_record_id::text AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys
   WHERE operation_id=p.operation_id AND organization_id=p.organization_id AND generation_id=p.generation_id
   ORDER BY source_record_id LIMIT 1)
  UNION ALL
  (SELECT 'legacy_sale'::text AS kind,legacy_sale_key AS native_key,first_selected_ordinal
   FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys
   WHERE operation_id=p.operation_id AND organization_id=p.organization_id AND generation_id=p.generation_id
    AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys existing
     WHERE existing.operation_id=p.operation_id LIMIT 1)
   ORDER BY legacy_sale_key COLLATE "C" LIMIT 1)
 ) k
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_rows m
  ON m.operation_id=p.operation_id AND m.organization_id=p.organization_id AND m.generation_id=p.generation_id
  AND m.ordinal=k.first_selected_ordinal
 JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_edges edge
  ON edge.operation_id=m.operation_id AND edge.organization_id=m.organization_id AND edge.generation_id=m.generation_id
  AND edge.ordinal=m.ordinal AND edge.account_id=m.account_id AND edge.kind=k.kind AND edge.native_key=k.native_key
 ) SELECT actual.* FROM actual
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_first retained
  ON retained.operation_id=actual.operation_id AND to_jsonb(retained)=to_jsonb(actual)
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_owned_first(uuid,uuid,uuid,integer) FROM PUBLIC;

-- These are actual OLD/NEW trigger rows. The issued preclaim snapshot must
-- equal ENTIRE OLD, not merely share its checkpoint, hash or attempt count.
CREATE FUNCTION app.neighborhood_source_resolution_v3_first_claim_transition_matches(
 old_job app.neighborhood_custom_cohort_capture_jobs,new_job app.neighborhood_custom_cohort_capture_jobs)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(EXISTS(SELECT 1
 FROM app.neighborhood_custom_cohort_source_resolution_v3_claims issued
 JOIN app.neighborhood_custom_cohort_capture_jobs actual USING(operation_id,organization_id)
 JOIN LATERAL app.neighborhood_source_resolution_v3_retained_first_after_handoff(actual.operation_id,actual.organization_id) native ON true
 WHERE actual.operation_id=old_job.operation_id AND to_jsonb(actual)=to_jsonb(old_job)
  AND issued.preclaim_job=to_jsonb(old_job) AND issued.issued_transaction_id=txid_current()
  AND new_job.status='running' AND new_job.claim_token=issued.claim_token
  AND new_job.attempts=issued.attempts AND new_job.lease_expires_at=issued.lease_expires_at
  AND new_job.lease_expires_at>clock_timestamp() AND new_job.updated_at=issued.issued_at
  AND (to_jsonb(new_job)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
   =(to_jsonb(old_job)-ARRAY['status','claim_token','lease_expires_at','updated_at'])),false)
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_first_claim_transition_matches(
 app.neighborhood_custom_cohort_capture_jobs,app.neighborhood_custom_cohort_capture_jobs) FROM PUBLIC;

-- Keep the two complete previous guards. Add only the closed native initial
-- claim branch; all later18 changes still refuse. Initial9 is untouched.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_source_resolution_v3_first_checkpoint_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_first_claim_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
   RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
   RAISE EXCEPTION 'neighborhood_source_resolution_v3_provisional_checkpoint_immutable' USING ERRCODE='55000'; END IF;
  RETURN OLD;
 END IF;
 IF OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3' THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_provisional_checkpoint_immutable' USING ERRCODE='55000'; END IF;
 IF NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND NOT (app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW)
      OR app.neighborhood_source_resolution_v3_first_handoff_transition_matches(OLD,NEW)) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_first_claim_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
  -- Only the actual original owner's same-TX native17/FIRST/row/head can
  -- save18. A second mutation or any tuple/lease/attempt/schedule change fails.
  -- This branch still cannot COMMIT or release/consume a continuation.
  IF TG_OP='UPDATE' AND (OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
    OR NEW.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3') THEN
    IF NOT (app.neighborhood_source_resolution_v3_first_checkpoint_transition_matches(OLD,NEW)
      OR app.neighborhood_source_resolution_v3_first_handoff_transition_matches(OLD,NEW)) THEN
      RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_checkpoint_transition_required' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2')) THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status='awaiting_selection' THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_live_claim_required' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO command FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=OLD.operation_id;
  IF FOUND THEN
    -- Intent and its issued nine roots are not a completed context. This slice
    -- cannot alter roots, erase failure history, issue success or wait again.
    IF NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
      OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
      OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
      OR (NEW.checkpoint IS DISTINCT FROM command.checkpoint
        AND NOT app.neighborhood_selected_union_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_evidence_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_metrics_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint)
        AND NOT app.neighborhood_selected_transaction_index_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))
      OR (OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_eligibility_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_evidence_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_metrics_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_statistics_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_numeric_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_semantic_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_transaction_index_refs_v2')
      OR (NEW.checkpoint->>'phase'='frozen_selected_transaction_index_refs_v2' AND NEW.checkpoint IS DISTINCT FROM OLD.checkpoint
        AND NOT app.neighborhood_transaction_index_v2_checkpoint_transition_matches(OLD.operation_id,OLD.organization_id,OLD.checkpoint,NEW.checkpoint))
      OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2','frozen_selected_numeric_refs_v2','frozen_selected_semantic_refs_v2','frozen_selected_transaction_index_refs_v2') THEN
    IF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='awaiting_selection' THEN
    IF NEW.status<>'cancelled' OR NEW.cancellation_requested_at IS NULL
      OR (to_jsonb(NEW)-ARRAY['status','cancellation_requested_at','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancellation_requested_at','updated_at']) THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_wait_immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status<>'awaiting_selection' THEN RETURN NEW; END IF;
  IF OLD.status<>'running' OR OLD.claim_token IS NULL OR OLD.lease_expires_at IS NULL
    OR OLD.lease_expires_at<=clock_timestamp() OR OLD.cancellation_requested_at IS NOT NULL
    OR OLD.context_sha256 IS NOT NULL OR NEW.claim_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_live_claim_required' USING ERRCODE='55000'; END IF;
  IF OLD.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'
    OR jsonb_array_length(OLD.checkpoint->'evidence_refs') IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads
    WHERE operation_id=OLD.operation_id AND organization_id=OLD.organization_id;
  IF head.stock_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->1
    OR head.source_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->2
    OR head.graph_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->3
    OR head.geographic_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->4
    OR head.identity_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->5
    OR head.traversal_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->6
    OR head.partition_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->7
    OR head.receipt_reference IS DISTINCT FROM OLD.checkpoint->'evidence_refs'->8 THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=OLD.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'
    OR receipt->>'sequence' IS DISTINCT FROM head.sequence::text OR receipt->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_wait_issued_catalog_required' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- Preserve the independent continuation guard as well; its original token
-- cannot stand in for the newly issued FIRST18 claim. All other paths retain
-- the complete previous binding/history/continuation body unchanged.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_first_claim_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
  SELECT * INTO c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=OLD.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.report_file_id<>OLD.report_file_id
    OR NEW.assignment_file_id<>OLD.assignment_file_id OR NEW.account_id<>OLD.account_id OR NEW.actor_user_id<>OLD.actor_user_id
    OR NEW.request_sha256<>OLD.request_sha256 OR NEW.request_payload IS DISTINCT FROM OLD.request_payload THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.attempts<OLD.attempts THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_attempt_history_conflict' USING ERRCODE='55000'; END IF;
  IF c.consumed_claim_token IS NULL THEN
    IF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.attempts<>OLD.attempts OR NEW.context_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='running' AND OLD.claim_token=c.issued_claim_token AND OLD.attempts=c.issued_attempts
      AND OLD.lease_expires_at>clock_timestamp() AND OLD.cancellation_requested_at IS NULL
      AND NEW.status='retry' AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL
      AND NEW.cancellation_requested_at IS NULL AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code THEN RETURN NEW; END IF;
    IF OLD.status='retry' AND NEW.status IN ('retry','cancelled') AND NEW.cancellation_requested_at IS NOT NULL
      AND NEW.claim_token IS NULL AND NEW.lease_expires_at IS NULL THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000';
  END IF;
  IF OLD.status='retry' AND OLD.claim_token IS NULL AND NEW.status='running' AND NEW.attempts=OLD.attempts THEN
    IF (NEW.claim_token IS DISTINCT FROM c.consumed_claim_token AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_neutral_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
          AND e.organization_id=NEW.organization_id AND e.report_file_id=NEW.report_file_id AND e.assignment_file_id=NEW.assignment_file_id
          AND e.account_id=NEW.account_id AND e.actor_user_id=NEW.actor_user_id AND e.request_sha256=NEW.request_sha256
          AND c.phase='frozen_identity_refs_v2' AND c.sequence=e.parent_sequence AND c.progress_reference=e.identity_reference
          AND c.consumed_claim_token=e.initial_claim_token AND OLD.checkpoint->>'phase'='frozen_identity_refs_v2'
          AND OLD.checkpoint->'evidence_refs'->5=e.identity_reference
          AND e.consumed_claim_token=NEW.claim_token AND e.consumed_attempts=NEW.attempts AND e.consumed_transaction_id=txid_current()) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_cache_stock_v2_bridges b WHERE b.operation_id=NEW.operation_id
          AND b.organization_id=NEW.organization_id AND b.claim_transaction_id=txid_current()
          AND app.neighborhood_cache_stock_v2_matches(b.operation_id,b.organization_id,NEW.claim_token,NEW.attempts)) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_cad_success_v2_jobs e WHERE e.operation_id=NEW.operation_id
          AND e.organization_id=NEW.organization_id AND e.consumed_transaction_id=txid_current()
          AND app.neighborhood_cad_success_v2_matches(e.operation_id,e.organization_id,NEW.claim_token,NEW.attempts)))
      OR NEW.claim_token=c.issued_claim_token OR NEW.lease_expires_at<=clock_timestamp() OR NEW.cancellation_requested_at IS NOT NULL
      OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_job_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- A claim record alone cannot commit. Each newly queued claim/job event
-- independently requires the exact owned18 and full retained native FIRST.
CREATE FUNCTION app.assert_neighborhood_source_resolution_v3_first_claim(op uuid,org uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual app.neighborhood_custom_cohort_source_resolution_v3_claims%ROWTYPE;
BEGIN
 SELECT issued.* INTO actual
 FROM app.neighborhood_custom_cohort_source_resolution_v3_claims issued
 JOIN LATERAL app.neighborhood_source_resolution_v3_owned_first(op,org,issued.claim_token,issued.attempts) native ON true
 WHERE issued.operation_id=op AND issued.organization_id=org AND issued.issued_transaction_id=txid_current();
 IF actual.operation_id IS NULL THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_first_claim_conflict' USING ERRCODE='55000'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_neighborhood_source_resolution_v3_first_claim(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION app.check_neighborhood_source_resolution_v3_first_claim_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app.assert_neighborhood_source_resolution_v3_first_claim(NEW.operation_id,NEW.organization_id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_first_claim_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION app.check_neighborhood_source_resolution_v3_first_claim_commit();

-- Preserve all six birth events. Only the job event also admits its exact
-- later, independently committed initial claim. The other five birth checks
-- retain their same-birth-TX and original live-lease assertion unchanged.
CREATE OR REPLACE FUNCTION app.reject_neighborhood_source_resolution_v3_first_checkpoint_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_claims issued
  WHERE issued.operation_id=NEW.operation_id AND issued.organization_id=NEW.organization_id
   AND issued.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_first_claim(NEW.operation_id,NEW.organization_id);
 ELSE
  PERFORM app.assert_neighborhood_source_resolution_v3_first_birth(NEW.operation_id,NEW.organization_id);
 END IF;
 RETURN NULL;
END $$;
