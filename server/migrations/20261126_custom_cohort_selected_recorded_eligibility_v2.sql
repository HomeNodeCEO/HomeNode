-- INACTIVE fifth pass. Three recorded-comparison bits/counts, never values,
-- economic/historical/report eligibility or original/source authority.
CREATE TABLE app.neighborhood_custom_cohort_selected_eligibility_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  union_reference jsonb NOT NULL CHECK(octet_length(union_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);

-- The ten original roots remain exact. Old readers are NOT widened.
CREATE FUNCTION app.neighborhood_selected_eligibility_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads h
    JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u USING(operation_id,organization_id)
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=u.organization_id
      AND b.content_sha256=u.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE h.operation_id=op AND h.organization_id=org AND h.command_id=u.command_id AND h.union_reference=u.receipt_reference
      AND cp->>'phase'='frozen_selected_eligibility_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=11
      AND (cp-'phase'-'evidence_refs')='{}'::jsonb AND cp->'evidence_refs'->10=h.receipt_reference
      AND app.neighborhood_selected_union_v2_checkpoint_matches(op,org,
        jsonb_build_object('phase','frozen_selected_union_refs_v2','evidence_refs',(cp->'evidence_refs')-10))
      AND b.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2'
      AND b.canonical_utf8::jsonb->>'sequence'=u.sequence::text
      AND b.canonical_utf8::jsonb->'after'->>'done'='true'),false)
$$;

CREATE FUNCTION app.guard_neighborhood_selected_eligibility_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
  u app.neighborhood_custom_cohort_selected_union_v2_heads%ROWTYPE;
  member app.neighborhood_custom_cohort_selected_union_v2_rows%ROWTYPE;
  body jsonb; prior jsonb; union_body jsonb; before_state jsonb; before_counts jsonb;
  after_state jsonb; actual_entry jsonb; actual_counts jsonb:='{}'; metric text; eligible boolean; n integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT command FROM app.neighborhood_custom_cohort_v2_selection_intents
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT u FROM app.neighborhood_custom_cohort_selected_union_v2_heads
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.request_sha256<>command.request_sha256 OR NEW.command_id<>command.command_id OR u.command_id<>command.command_id
    OR NEW.union_reference IS DISTINCT FROM u.receipt_reference THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT union_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=u.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF union_body->>'format' IS DISTINCT FROM 'cohort_selected_union_receipt_v2'
    OR union_body->>'sequence' IS DISTINCT FROM u.sequence::text OR union_body->'after'->>'done' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_unfinished_union' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT app.neighborhood_selected_union_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    before_state:=jsonb_build_object('selected_ordinal',0,'done',false);
    before_counts:=jsonb_build_object('reported_year_built',0,'reported_residential_area',0,'reported_site_area',0);
  ELSE
    IF NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
      OR (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF prior->>'format' IS DISTINCT FROM 'cohort_selected_recorded_eligibility_receipt_v2'
      OR prior->>'sequence' IS DISTINCT FROM OLD.sequence::text OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
    before_state:=prior->'after';before_counts:=prior->'after_counts';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF body->>'format' IS DISTINCT FROM 'cohort_selected_recorded_eligibility_receipt_v2'
    OR (SELECT count(*) FROM jsonb_object_keys(body))<>13
    OR (body-ARRAY['format','union_reference','command_id','selected_stock_count','subject_housing','sequence','previous',
      'before','after','selected_entry','eligible','before_counts','after_counts'])<>'{}'::jsonb
    OR body->'union_reference' IS DISTINCT FROM NEW.union_reference OR body->>'command_id' IS DISTINCT FROM NEW.command_id::text
    OR body->'selected_stock_count' IS DISTINCT FROM union_body->'after_selected_count'
    OR body->>'sequence' IS DISTINCT FROM NEW.sequence::text OR NEW.sequence<>(before_state->>'selected_ordinal')::integer+1
    OR body->'before' IS DISTINCT FROM before_state OR body->'before_counts' IS DISTINCT FROM before_counts
    OR (TG_OP='INSERT' AND (NEW.sequence<>1 OR body->'previous' IS DISTINCT FROM 'null'::jsonb))
    OR (TG_OP='UPDATE' AND (body->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR body->'subject_housing' IS DISTINCT FROM prior->'subject_housing')) THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  IF jsonb_typeof(body->'subject_housing') IS DISTINCT FROM 'object'
    OR ((body->'subject_housing')-ARRAY['state','category'])<>'{}'::jsonb
    OR (SELECT count(*) FROM jsonb_object_keys(body->'subject_housing'))<>2
    OR body->'subject_housing'->>'state' IS NULL
    OR body->'subject_housing'->>'state' NOT IN ('observed','missing','unknown','partial','conflicting')
    OR (body->'subject_housing'->>'state'='observed' AND (body->'subject_housing'->>'category' IS NULL
      OR body->'subject_housing'->>'category' NOT IN ('detached_single_family','townhouse','condominium','duplex','apartment','mobile_home','manufactured_home')))
    OR (body->'subject_housing'->>'state'<>'observed' AND body->'subject_housing'->'category' IS DISTINCT FROM 'null'::jsonb) THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_subject_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO member FROM app.neighborhood_custom_cohort_selected_union_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  after_state:=jsonb_build_object('selected_ordinal',(before_state->>'selected_ordinal')::integer
    +CASE WHEN member.account_id IS NULL THEN 0 ELSE 1 END,'done',member.account_id IS NULL);
  IF member.account_id IS NULL THEN
    IF body->'selected_entry' IS DISTINCT FROM 'null'::jsonb OR body->'eligible' IS DISTINCT FROM 'null'::jsonb
      OR body->'after_counts' IS DISTINCT FROM before_counts
      OR after_state->>'selected_ordinal' IS DISTINCT FROM union_body->>'after_selected_count'
      OR (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_union_v2_rows
        WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id)<>(union_body->>'after_selected_count')::integer THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_complete_union_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    actual_entry:=jsonb_build_object('account_id',member.account_id,'ordinal',member.ordinal,
      'partition_ordinal',member.partition_ordinal,'entry_reference',member.entry_reference);
    IF body->'selected_entry' IS DISTINCT FROM actual_entry OR NOT EXISTS(
      SELECT 1 FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows p WHERE p.operation_id=NEW.operation_id
        AND p.organization_id=NEW.organization_id AND p.account_id=member.account_id AND p.ordinal=member.partition_ordinal
        AND p.entry_reference=member.entry_reference) OR jsonb_typeof(body->'eligible') IS DISTINCT FROM 'object'
      OR ((body->'eligible')-ARRAY['reported_year_built','reported_residential_area','reported_site_area'])<>'{}'::jsonb
      OR (SELECT count(*) FROM jsonb_object_keys(body->'eligible'))<>3 THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_member_conflict' USING ERRCODE='55000'; END IF;
    FOREACH metric IN ARRAY ARRAY['reported_year_built','reported_residential_area','reported_site_area'] LOOP
      IF jsonb_typeof(body->'eligible'->metric) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_counts_conflict' USING ERRCODE='55000'; END IF;
      eligible:=(body->'eligible'->>metric)::boolean;
      IF eligible AND body->'subject_housing'->>'state'<>'observed' THEN
        RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_counts_conflict' USING ERRCODE='55000'; END IF;
      n:=(before_counts->>metric)::integer+CASE WHEN eligible THEN 1 ELSE 0 END;
      actual_counts:=actual_counts||jsonb_build_object(metric,n);
    END LOOP;
    IF body->'after_counts' IS DISTINCT FROM actual_counts THEN
      RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_counts_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  IF body->'after' IS DISTINCT FROM after_state THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_eligibility_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_eligibility_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_eligibility_v2_head();
CREATE TRIGGER neighborhood_selected_eligibility_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_eligibility_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE FUNCTION app.check_neighborhood_selected_eligibility_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_selected_eligibility_v2_heads%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR c.phase<>'frozen_selected_eligibility_refs_v2' OR c.progress_reference<>head.receipt_reference
    OR c.issued_attempts<>job.attempts OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry'
    OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_selected_eligibility_v2_orphan_progress' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_eligibility_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_eligibility_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_eligibility_v2_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_eligibility_v2_heads IS
  'INACTIVE original-backed selected-ordinal recorded comparison progress only. Each step must reopen EVERY selected and required subject original, ENTIRE neutral cache, complete issued graph/partition/catalog/immutable selection/current-ending rights in the actual bounded owner. Receipt retains three bits/counts and native entry reference only: never values, typed/original/decision copies, report eligibility or statistics authority. Later semantic consumers MUST reopen originals independently. No HTTP/worker/production activation.';

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2')) THEN
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
        AND NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))
      OR (OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_eligibility_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_eligibility_refs_v2')
      OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2') THEN
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

ALTER TABLE app.neighborhood_custom_cohort_v2_continuations
  DROP CONSTRAINT neighborhood_custom_cohort_v2_continuations_sequence_check,
  DROP CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check,
  ADD CONSTRAINT neighborhood_custom_cohort_v2_continuations_sequence_check
    CHECK(sequence BETWEEN 1 AND 10000005),
  ADD CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check
    CHECK(phase IN ('frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'));

CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_continuation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; actual_reference jsonb; actual_sequence integer; first_union_bridge boolean:=false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_v2_continuation_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF NEW.organization_id<>job.organization_id THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_binding_conflict' USING ERRCODE='55000';
  END IF;
  IF NEW.phase='frozen_stock_traversal_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_stock_traversal_v2_anchors WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>7 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_recorded_partition_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>8 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_recorded_catalog_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF jsonb_array_length(job.checkpoint->'evidence_refs')<>9 THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_union_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_union_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_eligibility_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_eligibility_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSE RAISE EXCEPTION 'neighborhood_v2_continuation_phase_conflict' USING ERRCODE='55000'; END IF;
  IF job.checkpoint->>'phase' IS DISTINCT FROM NEW.phase
    OR job.checkpoint->'evidence_refs'->-1 IS DISTINCT FROM actual_reference OR NEW.progress_reference IS DISTINCT FROM actual_reference THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.operation_id=OLD.operation_id AND NEW.organization_id=OLD.organization_id
    AND NEW.sequence=OLD.sequence AND NEW.phase=OLD.phase AND NEW.progress_reference=OLD.progress_reference
    AND NEW.issued_claim_token=OLD.issued_claim_token AND NEW.issued_attempts=OLD.issued_attempts
    AND OLD.consumed_claim_token IS NULL AND NEW.consumed_claim_token IS NOT NULL THEN
    IF job.status<>'retry' OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
      OR job.attempts<>NEW.issued_attempts OR job.cancellation_requested_at IS NOT NULL THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token
    OR job.attempts<>NEW.issued_attempts OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR NEW.consumed_claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_v2_continuation_claim_conflict' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    -- BEFORE INSERT also fires for the provisional row of INSERT ... ON
    -- CONFLICT DO UPDATE. A union may never create a free continuation, but
    -- its already-existing native continuation must reach the UPDATE guard
    -- below. That guard still enforces the exact old head, next sequence,
    -- consumed token and first-human bridge; this is not a new-row admission.
    IF NEW.sequence<>1 OR (NEW.phase IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2') AND NOT EXISTS(
      SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations existing
      WHERE existing.operation_id=NEW.operation_id AND existing.organization_id=NEW.organization_id)) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    -- ONLY the first actual union head may bridge the fresh authenticated human
    -- resume token at the same attempt; all later consumed-token rules remain.
    IF OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase='frozen_selected_union_refs_v2' AND actual_sequence=1 THEN
      SELECT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents command
        WHERE command.operation_id=NEW.operation_id AND command.organization_id=NEW.organization_id
          AND command.resume_claim_token=NEW.issued_claim_token AND command.issued_attempts=NEW.issued_attempts
          AND command.checkpoint->'evidence_refs'->8=OLD.progress_reference) INTO first_union_bridge;
    END IF;
    IF NEW.operation_id<>OLD.operation_id OR NEW.organization_id<>OLD.organization_id OR NEW.sequence<>OLD.sequence+1
      OR OLD.consumed_claim_token IS NULL OR (NEW.issued_attempts=OLD.issued_attempts AND NEW.issued_claim_token<>OLD.consumed_claim_token AND NOT first_union_bridge)
      OR NEW.issued_attempts<OLD.issued_attempts OR NEW.progress_reference=OLD.progress_reference
      OR (OLD.phase='frozen_recorded_partition_refs_v2' AND NEW.phase='frozen_stock_traversal_refs_v2')
      OR (OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase NOT IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'))
      OR (NEW.phase='frozen_selected_union_refs_v2' AND OLD.phase NOT IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'))
      OR (OLD.phase='frozen_recorded_catalog_refs_v2' AND NEW.phase='frozen_selected_union_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents command
          WHERE command.operation_id=NEW.operation_id AND command.organization_id=NEW.organization_id
            AND command.checkpoint->'evidence_refs'->8=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (NEW.phase='frozen_selected_eligibility_refs_v2' AND OLD.phase NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase='frozen_selected_eligibility_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_eligibility_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.union_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase<>'frozen_selected_eligibility_refs_v2') THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
