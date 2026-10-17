-- UNREGISTERED normal failure of ACTUAL normal fourth4 only.
-- Preserve original17/birth18/owned1/failure1/second2/failure2/third3/failure3/fourth4/FIRST/member history.
-- No attempt refund, fresh5 claim, renewal, source authority or activation.
CREATE TABLE app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries (
 operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_source_resolution_v3_fourth_claims(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 organization_id uuid NOT NULL,
 claimed_job jsonb NOT NULL CHECK(octet_length(claimed_job::text) BETWEEN 100 AND 32768),
 failure_code text NOT NULL CHECK(failure_code IN ('access_revoked','capture_failed')),
 issued_at timestamptz NOT NULL,
 retry_seconds integer NOT NULL CHECK(retry_seconds BETWEEN 1 AND 900),
 run_after timestamptz NOT NULL,
 claim_transaction_id bigint NOT NULL CHECK(claim_transaction_id>0),
 issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0),
 CHECK(claim_transaction_id<>issued_transaction_id),
 CHECK(run_after=issued_at+(retry_seconds*interval '1 second'))
);
CREATE FUNCTION app.guard_neighborhood_source_resolution_v3_fourth_retry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
 issued app.neighborhood_custom_cohort_source_resolution_v3_fourth_claims%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_fourth_retry_immutable' USING ERRCODE='55000'; END IF;
 SELECT job.* INTO actual FROM app.neighborhood_custom_cohort_capture_jobs job
 JOIN app.neighborhood_source_resolution_v3_fourth_first(NEW.operation_id,NEW.organization_id,job.claim_token,job.attempts) native
  USING(operation_id,organization_id) WHERE job.operation_id=NEW.operation_id AND job.organization_id=NEW.organization_id;
 SELECT * INTO issued FROM app.neighborhood_custom_cohort_source_resolution_v3_fourth_claims
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 IF actual.operation_id IS NULL OR issued.operation_id IS NULL OR actual.attempts<>4
  OR NEW.claimed_job IS DISTINCT FROM to_jsonb(actual)
  OR NEW.claim_transaction_id<>issued.issued_transaction_id OR NEW.issued_transaction_id<>txid_current()
  OR NEW.issued_transaction_id=issued.issued_transaction_id
  OR NEW.issued_at NOT BETWEEN transaction_timestamp() AND clock_timestamp()
  OR NEW.retry_seconds NOT BETWEEN 1 AND 900
  OR NEW.run_after IS DISTINCT FROM NEW.issued_at+(NEW.retry_seconds*interval '1 second') THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_actual_fourth_retry_required' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_resolution_v3_fourth_retry_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries FOR EACH ROW
 EXECUTE FUNCTION app.guard_neighborhood_source_resolution_v3_fourth_retry();
CREATE TRIGGER neighborhood_source_resolution_v3_fourth_retry_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries FOR EACH STATEMENT
 EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

-- Reopen the ENTIRE fourth3 claim AND every actual independent predecessor.
CREATE FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_parent(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_parents
LANGUAGE sql VOLATILE AS $$
 SELECT p.*
 FROM app.neighborhood_custom_cohort_source_resolution_v3_handoffs handoff
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,handoff.birth_job) birth
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_claims issued
  ON issued.operation_id=handoff.operation_id AND issued.organization_id=handoff.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,issued.preclaim_job) preclaim
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_initial_retries failure
  ON failure.operation_id=issued.operation_id AND failure.organization_id=issued.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,failure.claimed_job) owned
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_second_claims recovery
  ON recovery.operation_id=failure.operation_id AND recovery.organization_id=failure.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,recovery.preclaim_job) retried
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_second_retries failure2
  ON failure2.operation_id=recovery.operation_id AND failure2.organization_id=recovery.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,failure2.claimed_job) recovered
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_third_claims third
  ON third.operation_id=failure2.operation_id AND third.organization_id=failure2.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,third.preclaim_job) retried2
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_third_retries failure3
  ON failure3.operation_id=third.operation_id AND failure3.organization_id=third.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,failure3.claimed_job) owned3
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_fourth_claims fourth
  ON fourth.operation_id=failure3.operation_id AND fourth.organization_id=failure3.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,fourth.preclaim_job) retried3
 JOIN app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries failure4
  ON failure4.operation_id=fourth.operation_id AND failure4.organization_id=fourth.organization_id
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,failure4.claimed_job) owned4
 JOIN app.neighborhood_custom_cohort_capture_jobs retried4
  ON retried4.operation_id=failure4.operation_id AND retried4.organization_id=failure4.organization_id
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
  AND owned.status='running' AND owned.claim_token=issued.claim_token
  AND owned.attempts=issued.attempts
  AND owned.lease_expires_at=issued.lease_expires_at AND owned.lease_expires_at>failure.issued_at
  AND owned.updated_at=issued.issued_at
  AND (to_jsonb(owned)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
   =(issued.preclaim_job-ARRAY['status','claim_token','lease_expires_at','updated_at'])
  AND to_jsonb(owned)=failure.claimed_job AND owned.operation_id=retried.operation_id
  AND owned.organization_id=retried.organization_id AND owned.attempts=1 AND owned.last_error_code IS NULL
  AND failure.claim_transaction_id=issued.issued_transaction_id AND failure.issued_transaction_id=recovery.retry_transaction_id AND failure.issued_transaction_id<>recovery.issued_transaction_id
  AND failure.issued_transaction_id<>issued.issued_transaction_id
  AND retried.status='retry' AND retried.claim_token IS NULL AND retried.lease_expires_at IS NULL
  AND retried.last_error_code=failure.failure_code AND retried.updated_at=failure.issued_at
  AND retried.run_after=failure.run_after AND failure.retry_seconds BETWEEN 1 AND 900
  AND failure.run_after=failure.issued_at+(failure.retry_seconds*interval '1 second')
  AND (to_jsonb(retried)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
   =(failure.claimed_job-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
  AND to_jsonb(retried)=recovery.preclaim_job
  AND recovery.issued_transaction_id<>recovery.retry_transaction_id
  AND recovery.attempts=2 AND recovery.attempts=retried.attempts+1
  AND recovery.claim_token<>issued.claim_token AND recovery.claim_token<>handoff.issued_claim_token
  AND recovery.claim_token<>birth.claim_token AND recovery.claim_token<>continuation.issued_claim_token
  AND recovery.claim_token<>continuation.consumed_claim_token AND recovery.claim_token<>command.resume_claim_token
  AND recovery.issued_at>=retried.run_after AND recovery.issued_at<=clock_timestamp()
  AND recovery.lease_seconds BETWEEN 15 AND 900
  AND recovery.lease_expires_at=recovery.issued_at+(recovery.lease_seconds*interval '1 second')
  AND recovered.status='running' AND recovered.claim_token=recovery.claim_token
  AND recovered.attempts=2 AND recovered.lease_expires_at=recovery.lease_expires_at
  AND recovered.lease_expires_at>failure2.issued_at AND recovered.updated_at=recovery.issued_at
  AND recovered.cancellation_requested_at IS NULL AND recovered.context_sha256 IS NULL
  AND (to_jsonb(recovered)-ARRAY['status','claim_token','lease_expires_at','updated_at','attempts'])
   =(recovery.preclaim_job-ARRAY['status','claim_token','lease_expires_at','updated_at','attempts'])
  AND to_jsonb(recovered)=failure2.claimed_job
  AND failure2.claim_transaction_id=recovery.issued_transaction_id AND failure2.issued_transaction_id=third.retry_transaction_id AND failure2.issued_transaction_id<>third.issued_transaction_id
  AND failure2.issued_transaction_id<>recovery.issued_transaction_id
  AND failure2.issued_at<=clock_timestamp()
  AND retried2.status='retry' AND retried2.claim_token IS NULL AND retried2.lease_expires_at IS NULL
  AND retried2.last_error_code=failure2.failure_code AND retried2.updated_at=failure2.issued_at
  AND retried2.run_after=failure2.run_after AND failure2.retry_seconds BETWEEN 1 AND 900
  AND failure2.run_after=failure2.issued_at+(failure2.retry_seconds*interval '1 second')
  AND (to_jsonb(retried2)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
   =(failure2.claimed_job-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
  AND to_jsonb(retried2)=third.preclaim_job
  AND third.attempts=3 AND third.attempts=retried2.attempts+1
  AND third.issued_transaction_id<>third.retry_transaction_id
  AND third.claim_token<>recovery.claim_token AND third.claim_token<>issued.claim_token
  AND third.claim_token<>handoff.issued_claim_token AND third.claim_token<>birth.claim_token
  AND third.claim_token<>continuation.issued_claim_token AND third.claim_token<>continuation.consumed_claim_token
  AND third.claim_token<>command.resume_claim_token
  AND third.issued_at>=retried2.run_after AND third.issued_at<=clock_timestamp()
  AND third.lease_seconds BETWEEN 15 AND 900
  AND third.lease_expires_at=third.issued_at+(third.lease_seconds*interval '1 second')
  AND owned3.status='running' AND owned3.claim_token=third.claim_token
  AND owned3.attempts=3 AND owned3.lease_expires_at=third.lease_expires_at
  AND owned3.lease_expires_at>failure3.issued_at AND owned3.updated_at=third.issued_at
  AND owned3.cancellation_requested_at IS NULL AND owned3.context_sha256 IS NULL
  AND (to_jsonb(owned3)-ARRAY['status','claim_token','attempts','lease_expires_at','updated_at'])
   =(third.preclaim_job-ARRAY['status','claim_token','attempts','lease_expires_at','updated_at'])
  AND to_jsonb(owned3)=failure3.claimed_job
  AND failure3.claim_transaction_id=third.issued_transaction_id AND failure3.issued_transaction_id=fourth.retry_transaction_id AND failure3.issued_transaction_id<>fourth.issued_transaction_id
  AND failure3.issued_transaction_id<>third.issued_transaction_id
  AND failure3.issued_at<=clock_timestamp()
  AND retried3.status='retry' AND retried3.claim_token IS NULL AND retried3.lease_expires_at IS NULL
  AND retried3.last_error_code=failure3.failure_code AND retried3.updated_at=failure3.issued_at
  AND retried3.run_after=failure3.run_after AND failure3.retry_seconds BETWEEN 1 AND 900
  AND failure3.run_after=failure3.issued_at+(failure3.retry_seconds*interval '1 second')
  AND (to_jsonb(retried3)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
   =(failure3.claimed_job-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
  AND to_jsonb(retried3)=fourth.preclaim_job
  AND fourth.attempts=4 AND fourth.attempts=retried3.attempts+1
  AND fourth.issued_transaction_id<>fourth.retry_transaction_id
  AND fourth.claim_token<>third.claim_token AND fourth.claim_token<>recovery.claim_token AND fourth.claim_token<>issued.claim_token
  AND fourth.claim_token<>handoff.issued_claim_token AND fourth.claim_token<>birth.claim_token
  AND fourth.claim_token<>continuation.issued_claim_token AND fourth.claim_token<>continuation.consumed_claim_token
  AND fourth.claim_token<>command.resume_claim_token
  AND fourth.issued_at>=retried3.run_after AND fourth.issued_at<=clock_timestamp()
  AND fourth.lease_seconds BETWEEN 15 AND 900
  AND fourth.lease_expires_at=fourth.issued_at+(fourth.lease_seconds*interval '1 second')
  AND owned4.status='running' AND owned4.claim_token=fourth.claim_token
  AND owned4.attempts=4 AND owned4.lease_expires_at=fourth.lease_expires_at
  AND owned4.lease_expires_at>clock_timestamp() AND owned4.updated_at=fourth.issued_at
  AND owned4.cancellation_requested_at IS NULL AND owned4.context_sha256 IS NULL
  AND (to_jsonb(owned4)-ARRAY['status','claim_token','attempts','lease_expires_at','updated_at'])
   =(fourth.preclaim_job-ARRAY['status','claim_token','attempts','lease_expires_at','updated_at'])
  AND to_jsonb(owned4)=failure4.claimed_job
  AND failure4.claim_transaction_id=fourth.issued_transaction_id AND failure4.issued_transaction_id=txid_current()
  AND failure4.issued_transaction_id<>fourth.issued_transaction_id
  AND failure4.issued_at BETWEEN transaction_timestamp() AND clock_timestamp()
  AND retried4.status='retry' AND retried4.claim_token IS NULL AND retried4.lease_expires_at IS NULL
  AND retried4.last_error_code=failure4.failure_code AND retried4.updated_at=failure4.issued_at
  AND retried4.run_after=failure4.run_after AND failure4.retry_seconds BETWEEN 1 AND 900
  AND failure4.run_after=failure4.issued_at+(failure4.retry_seconds*interval '1 second')
  AND (to_jsonb(retried4)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
   =(failure4.claimed_job-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
 FOR UPDATE OF retried4 NOWAIT
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_parent(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_first(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_first
LANGUAGE sql VOLATILE AS $$
 WITH actual AS (
 SELECT p.operation_id,p.organization_id,p.generation_id,p.command_id,p.index_reference,p.index_sequence,
  k.kind,k.native_key,k.first_selected_ordinal,m.account_id AS selected_account_id,m.partition_ordinal,
  m.entry_reference,m.metric_row_reference,m.contribution_row_reference,p.issued_transaction_id
 FROM app.neighborhood_source_resolution_v3_fourth_retry_parent(op,org) p
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
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_first(uuid,uuid) FROM PUBLIC;


CREATE FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_matches(
 old_job app.neighborhood_custom_cohort_capture_jobs,new_job app.neighborhood_custom_cohort_capture_jobs)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT coalesce(EXISTS(SELECT 1
 FROM app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries failure
 JOIN app.neighborhood_custom_cohort_capture_jobs actual USING(operation_id,organization_id)
 JOIN LATERAL app.neighborhood_source_resolution_v3_fourth_first(actual.operation_id,actual.organization_id,actual.claim_token,actual.attempts) native ON true
 WHERE actual.operation_id=old_job.operation_id AND to_jsonb(actual)=to_jsonb(old_job)
  AND failure.claimed_job=to_jsonb(old_job) AND failure.issued_transaction_id=txid_current() AND old_job.attempts=4
  AND new_job.status='retry' AND new_job.claim_token IS NULL AND new_job.lease_expires_at IS NULL
  AND new_job.last_error_code=failure.failure_code AND new_job.updated_at=failure.issued_at
  AND new_job.run_after=failure.run_after AND failure.retry_seconds BETWEEN 1 AND 900
  AND failure.run_after=failure.issued_at+(failure.retry_seconds*interval '1 second')
  AND (to_jsonb(new_job)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])
   =(to_jsonb(old_job)-ARRAY['status','claim_token','lease_expires_at','last_error_code','updated_at','run_after'])),false)
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_fourth_retry_matches(
 app.neighborhood_custom_cohort_capture_jobs,app.neighborhood_custom_cohort_capture_jobs) FROM PUBLIC;

CREATE FUNCTION app.assert_neighborhood_source_resolution_v3_fourth_retry(op uuid,org uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.neighborhood_source_resolution_v3_fourth_retry_first(op,org)) THEN
  RAISE EXCEPTION 'neighborhood_source_resolution_v3_fourth_retry_conflict' USING ERRCODE='55000'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.assert_neighborhood_source_resolution_v3_fourth_retry(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION app.check_neighborhood_source_resolution_v3_fourth_retry_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM app.assert_neighborhood_source_resolution_v3_fourth_retry(NEW.operation_id,NEW.organization_id);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_resolution_v3_fourth_retry_commit AFTER INSERT
 ON app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION app.check_neighborhood_source_resolution_v3_fourth_retry_commit();





-- ENTIRE latest native guards retained after the new closed fourth3 failure branch.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_source_resolution_v3_first_checkpoint_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_initial_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_expired_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovered_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovery_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_last_retry_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_terminal_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
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


-- ENTIRE latest native guards retained after the new closed fourth3 failure branch.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_initial_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_expired_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovered_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovery_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_last_retry_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_terminal_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
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


-- ENTIRE latest native guards retained after the new closed fourth3 failure branch.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_fourth_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_third_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_second_claim_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_initial_retry_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_expired_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovered_final_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_recovery_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_last_retry_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.checkpoint->>'phase'='frozen_selected_source_resolution_refs_v3'
  AND app.neighborhood_source_resolution_v3_terminal_transition_matches(OLD,NEW) THEN RETURN NEW; END IF;
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


-- ENTIRE latest native guards retained after the new closed fourth3 failure branch.
CREATE OR REPLACE FUNCTION app.reject_neighborhood_source_resolution_v3_first_checkpoint_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_fourth_retries failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_fourth_retry(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_fourth_claims issued
  WHERE issued.operation_id=NEW.operation_id AND issued.organization_id=NEW.organization_id
   AND issued.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_fourth_claim(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_third_retries failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_third_retry(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_third_claims issued
  WHERE issued.operation_id=NEW.operation_id AND issued.organization_id=NEW.organization_id
   AND issued.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_third_claim(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_second_retries failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_second_retry(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_second_claims issued
  WHERE issued.operation_id=NEW.operation_id AND issued.organization_id=NEW.organization_id
   AND issued.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_second_claim(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_initial_retries failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_initial_retry(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_expired_ends failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_expired_final(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_recovered_ends failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_recovered_final(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_recoveries recovery
  WHERE recovery.operation_id=NEW.operation_id AND recovery.organization_id=NEW.organization_id
   AND recovery.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_recovery(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_last_retries failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_last_retry(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_final_failures failure
  WHERE failure.operation_id=NEW.operation_id AND failure.organization_id=NEW.organization_id
   AND failure.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_terminal_failure(NEW.operation_id,NEW.organization_id);
  RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_source_resolution_v3_claims issued
  WHERE issued.operation_id=NEW.operation_id AND issued.organization_id=NEW.organization_id
   AND issued.issued_transaction_id=txid_current()) THEN
  PERFORM app.assert_neighborhood_source_resolution_v3_first_claim(NEW.operation_id,NEW.organization_id);
 ELSE
  PERFORM app.assert_neighborhood_source_resolution_v3_first_birth(NEW.operation_id,NEW.organization_id);
 END IF;
 RETURN NULL;
END $$;
