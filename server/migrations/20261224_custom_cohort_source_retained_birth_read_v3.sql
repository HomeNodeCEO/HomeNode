-- UNREGISTERED structural read of the actual retained17 birth AFTER the real
-- atomic18 handoff. This admits no fresh18 claim and removes no COMMIT refusal.
-- Read the ENTIRE immutable native birth_job; never remove a projected18 root
-- or replace the birth transaction, token, attempt, lease or failure history.
-- PostgreSQL performs the typed JSON conversion, preserving native bigint and
-- timestamp representations without a JavaScript numeric/date round trip.
-- https://www.postgresql.org/docs/current/functions-json.html
CREATE FUNCTION app.neighborhood_source_resolution_v3_retained_parent_after_handoff(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_parents
LANGUAGE sql VOLATILE AS $$
 SELECT p.*
 FROM app.neighborhood_custom_cohort_source_resolution_v3_handoffs handoff
 CROSS JOIN LATERAL jsonb_populate_record(NULL::app.neighborhood_custom_cohort_capture_jobs,handoff.birth_job) birth
 JOIN app.neighborhood_custom_cohort_capture_jobs current_job
  ON current_job.operation_id=handoff.operation_id AND current_job.organization_id=handoff.organization_id
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
  AND current_job.status='retry' AND current_job.claim_token IS NULL AND current_job.lease_expires_at IS NULL
  AND current_job.cancellation_requested_at IS NULL AND current_job.context_sha256 IS NULL
  AND current_job.checkpoint=handoff.checkpoint
  AND handoff.checkpoint=jsonb_build_object('phase','frozen_selected_source_resolution_refs_v3',
   'evidence_refs',(p.parent_checkpoint->'evidence_refs')||jsonb_build_array(candidate.candidate_reference))
  AND (to_jsonb(current_job)-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])
   =(handoff.birth_job-ARRAY['checkpoint','status','claim_token','lease_expires_at','run_after','updated_at'])
  AND current_job.run_after>=birth.updated_at AND current_job.run_after<=clock_timestamp()
  AND current_job.updated_at>=birth.updated_at AND current_job.updated_at<=clock_timestamp()
 FOR UPDATE OF current_job NOWAIT
$$;
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_retained_parent_after_handoff(uuid,uuid) FROM PUBLIC;

-- Independently select the actual FIRST key/first-seen member again from the
-- immutable native index. A stored FIRST row or reference alone is not proof.
CREATE FUNCTION app.neighborhood_source_resolution_v3_retained_first_after_handoff(op uuid,org uuid)
RETURNS SETOF app.neighborhood_custom_cohort_source_resolution_v3_first
LANGUAGE sql VOLATILE AS $$
 WITH actual AS (
 SELECT p.operation_id,p.organization_id,p.generation_id,p.command_id,p.index_reference,p.index_sequence,
  k.kind,k.native_key,k.first_selected_ordinal,m.account_id,m.partition_ordinal,
  m.entry_reference,m.metric_row_reference,m.contribution_row_reference,p.issued_transaction_id
 FROM app.neighborhood_source_resolution_v3_retained_parent_after_handoff(op,org) p
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
REVOKE ALL ON FUNCTION app.neighborhood_source_resolution_v3_retained_first_after_handoff(uuid,uuid) FROM PUBLIC;
