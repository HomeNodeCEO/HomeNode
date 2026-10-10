-- INACTIVE fourth pass. No source cells, housing eligibility or statistic copies.
CREATE TABLE app.neighborhood_custom_cohort_selected_union_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);
CREATE TABLE app.neighborhood_custom_cohort_selected_union_v2_groups (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  group_id text COLLATE "C" NOT NULL CHECK(group_id ~ '^(recorded-cad:[a-f0-9]{64}|discovery:unassigned)$'),
  member_count integer NOT NULL CHECK(member_count BETWEEN 1 AND 2000000),
  last_ordinal integer NOT NULL CHECK(last_ordinal BETWEEN 1 AND 2000000),
  PRIMARY KEY(operation_id,group_id)
);
CREATE TABLE app.neighborhood_custom_cohort_selected_union_v2_rows (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  partition_ordinal integer NOT NULL CHECK(partition_ordinal BETWEEN 1 AND 2000000),
  entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
  PRIMARY KEY(operation_id,account_id), UNIQUE(operation_id,ordinal), UNIQUE(operation_id,partition_ordinal)
);

-- Only the immutable command's nine EXACT roots plus the actual issued tenth
-- head are admitted. This structural predicate is NOT original/source authority.
CREATE FUNCTION app.neighborhood_selected_union_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_selection_intents c
    JOIN app.neighborhood_custom_cohort_selected_union_v2_heads h USING(operation_id,organization_id)
    WHERE c.operation_id=op AND c.organization_id=org AND h.command_id=c.command_id
      AND cp->>'phase'='frozen_selected_union_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=10
      AND (cp-'phase'-'evidence_refs')='{}'::jsonb
      AND ((cp->'evidence_refs')-9)=c.checkpoint->'evidence_refs'
      AND cp->'evidence_refs'->9=h.receipt_reference),false)
$$;

-- Current native progress, not a caller-supplied cursor. Immutable catalog and
-- partition stay read-only throughout this independent semantic replay pass.
CREATE FUNCTION app.neighborhood_selected_union_v2_before(op uuid,org uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
  head app.neighborhood_custom_cohort_selected_union_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=op;
  SELECT * INTO STRICT command FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=op AND organization_id=org;
  IF job.organization_id<>org OR job.status<>'running' OR job.claim_token IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR job.request_sha256<>command.request_sha256 THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_claim_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO head FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=op AND organization_id=org;
  IF NOT FOUND THEN
    IF job.checkpoint IS DISTINCT FROM command.checkpoint THEN
      RAISE EXCEPTION 'neighborhood_selected_union_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    RETURN jsonb_build_object('after',jsonb_build_object('after_account','','account_count',0,'done',false),
      'after_counts',jsonb_build_object('assigned_accounts',0,'unassigned_accounts',0,'assigned_groups',0),'after_selected_count',0);
  END IF;
  IF NOT app.neighborhood_selected_union_v2_checkpoint_matches(op,org,job.checkpoint) THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=org AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF body->>'format' IS DISTINCT FROM 'cohort_selected_union_receipt_v2' OR body->>'sequence' IS DISTINCT FROM head.sequence::text
    OR body->'after'->>'done' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  RETURN body;
END $$;

CREATE FUNCTION app.guard_neighborhood_selected_union_v2_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_body jsonb; entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  catalog app.neighborhood_custom_cohort_recorded_catalog_v2_groups%ROWTYPE; selected boolean; next_ordinal integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_union_v2_immutable' USING ERRCODE='55000'; END IF;
  before_body:=app.neighborhood_selected_union_v2_before(NEW.operation_id,NEW.organization_id);
  next_ordinal:=(before_body->'after'->>'account_count')::integer+1;
  SELECT * INTO STRICT entry FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=next_ordinal;
  IF TG_TABLE_NAME='neighborhood_custom_cohort_selected_union_v2_groups' THEN
    SELECT * INTO STRICT catalog FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups
      WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND group_id=NEW.group_id;
    IF NEW.group_id IS DISTINCT FROM coalesce(entry.assigned_group_id,'discovery:unassigned') OR NEW.last_ordinal<>next_ordinal
      OR NEW.member_count>catalog.member_count OR NEW.last_ordinal>catalog.last_ordinal THEN
      RAISE EXCEPTION 'neighborhood_selected_union_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.member_count<>1 OR (NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_union_v2_groups
        WHERE operation_id=NEW.operation_id AND group_id=NEW.group_id)
        AND (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=NEW.operation_id)>=2049) THEN
        RAISE EXCEPTION 'neighborhood_selected_union_v2_group_conflict' USING ERRCODE='55000'; END IF;
    ELSIF (to_jsonb(NEW)-ARRAY['member_count','last_ordinal']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['member_count','last_ordinal'])
      OR NEW.member_count<>OLD.member_count+1 OR NEW.last_ordinal<=OLD.last_ordinal THEN
      RAISE EXCEPTION 'neighborhood_selected_union_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  ELSE
    SELECT included_group_ids ? coalesce(entry.assigned_group_id,'discovery:unassigned') INTO STRICT selected
      FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF TG_OP<>'INSERT' OR NOT selected OR NEW.account_id<>entry.account_id OR NEW.partition_ordinal<>next_ordinal
      OR NEW.ordinal<>(before_body->>'after_selected_count')::integer+1 OR NEW.entry_reference IS DISTINCT FROM entry.entry_reference THEN
      RAISE EXCEPTION 'neighborhood_selected_union_v2_member_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_union_v2_group_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_union_v2_groups FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_union_v2_member();
CREATE TRIGGER neighborhood_selected_union_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_union_v2_rows FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_union_v2_member();

CREATE FUNCTION app.guard_neighborhood_selected_union_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_body jsonb; command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
  catalog app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE;
  entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  body jsonb; catalog_body jsonb; actual_counts jsonb; after_state jsonb; selected boolean; selected_count integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_union_v2_immutable' USING ERRCODE='55000'; END IF;
  before_body:=app.neighborhood_selected_union_v2_before(NEW.operation_id,NEW.organization_id);
  SELECT * INTO STRICT command FROM app.neighborhood_custom_cohort_v2_selection_intents WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT catalog FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT canonical_utf8::jsonb INTO STRICT catalog_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=catalog.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=catalog.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NEW.command_id<>command.command_id OR catalog.receipt_reference IS DISTINCT FROM command.checkpoint->'evidence_refs'->8
    OR catalog_body->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2' OR catalog_body->'after'->>'done' IS DISTINCT FROM 'true'
    OR body->>'format' IS DISTINCT FROM 'cohort_selected_union_receipt_v2' OR (SELECT count(*) FROM jsonb_object_keys(body))<>24
    OR body->>'command_id' IS DISTINCT FROM command.command_id::text OR body->'catalog_reference' IS DISTINCT FROM catalog.receipt_reference
    OR body->>'sequence' IS DISTINCT FROM NEW.sequence::text
    OR (body-ARRAY['format','sequence','previous','before','after','entry_reference','before_counts','after_counts',
      'catalog_reference','command_id','before_selected_count','after_selected_count'])
      IS DISTINCT FROM (catalog_body-ARRAY['format','sequence','previous','before','after','entry_reference','before_counts','after_counts'])
    OR body->'before' IS DISTINCT FROM before_body->'after' OR body->'before_counts' IS DISTINCT FROM before_body->'after_counts'
    OR body->'before_selected_count' IS DISTINCT FROM before_body->'after_selected_count'
    OR NEW.sequence<>(before_body->'after'->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>1 OR body->'previous' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'neighborhood_selected_union_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
    OR NEW.sequence<>OLD.sequence+1 OR body->'previous' IS DISTINCT FROM OLD.receipt_reference THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO entry FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  selected:=entry.account_id IS NOT NULL AND command.included_group_ids ? coalesce(entry.assigned_group_id,'discovery:unassigned');
  after_state:=jsonb_build_object('after_account',coalesce(entry.account_id,before_body->'after'->>'after_account'),
    'account_count',(before_body->'after'->>'account_count')::integer+CASE WHEN entry.account_id IS NULL THEN 0 ELSE 1 END,
    'done',entry.account_id IS NULL);
  SELECT jsonb_build_object('assigned_accounts',coalesce(sum(member_count) FILTER(WHERE group_id<>'discovery:unassigned'),0)::integer,
    'unassigned_accounts',coalesce(sum(member_count) FILTER(WHERE group_id='discovery:unassigned'),0)::integer,
    'assigned_groups',count(*) FILTER(WHERE group_id<>'discovery:unassigned')::integer) INTO actual_counts
    FROM app.neighborhood_custom_cohort_selected_union_v2_groups WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  selected_count:=(before_body->>'after_selected_count')::integer+CASE WHEN selected THEN 1 ELSE 0 END;
  IF body->'after' IS DISTINCT FROM after_state OR body->'after_counts' IS DISTINCT FROM actual_counts
    OR body->>'after_selected_count' IS DISTINCT FROM selected_count::text
    OR (actual_counts->>'assigned_accounts')::integer+(actual_counts->>'unassigned_accounts')::integer<>(after_state->>'account_count')::integer
    OR (entry.account_id IS NOT NULL AND (body->'entry_reference' IS DISTINCT FROM entry.entry_reference
      OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_union_v2_groups g WHERE g.operation_id=NEW.operation_id
        AND g.organization_id=NEW.organization_id AND g.group_id=coalesce(entry.assigned_group_id,'discovery:unassigned') AND g.last_ordinal=NEW.sequence)))
    OR selected IS DISTINCT FROM EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_union_v2_rows r
      WHERE r.operation_id=NEW.operation_id AND r.organization_id=NEW.organization_id AND r.partition_ordinal=NEW.sequence
        AND r.account_id=entry.account_id AND r.ordinal=selected_count AND r.entry_reference=entry.entry_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  IF entry.account_id IS NULL AND (body->'entry_reference' IS DISTINCT FROM 'null'::jsonb
    OR body->'after_counts' IS DISTINCT FROM before_body->'after_counts'
    OR after_state->>'account_count' IS DISTINCT FROM catalog_body->>'stock_account_count'
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
      FULL JOIN app.neighborhood_custom_cohort_selected_union_v2_groups r USING(operation_id,organization_id,group_id)
      WHERE coalesce(g.operation_id,r.operation_id)=NEW.operation_id AND (g.member_count IS DISTINCT FROM r.member_count
        OR g.last_ordinal IS DISTINCT FROM r.last_ordinal))
    OR (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_union_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id)<>selected_count) THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_complete_catalog_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_union_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_union_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_union_v2_head();

CREATE FUNCTION app.check_neighborhood_selected_union_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_selected_union_v2_heads%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_selected_union_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT app.neighborhood_selected_union_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR c.phase<>'frozen_selected_union_refs_v2' OR c.progress_reference<>head.receipt_reference
    OR c.issued_attempts<>job.attempts OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry'
    OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR (TG_TABLE_NAME='neighborhood_custom_cohort_selected_union_v2_groups' AND head.sequence<>(to_jsonb(NEW)->>'last_ordinal')::integer)
    OR (TG_TABLE_NAME='neighborhood_custom_cohort_selected_union_v2_rows' AND head.sequence<>(to_jsonb(NEW)->>'partition_ordinal')::integer) THEN
    RAISE EXCEPTION 'neighborhood_selected_union_v2_orphan_progress' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_union_v2_group_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_union_v2_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_selected_union_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_selected_union_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_union_v2_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_selected_union_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_selected_union_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_union_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_selected_union_v2_commit();
CREATE TRIGGER neighborhood_selected_union_v2_group_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_union_v2_groups
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_selected_union_v2_row_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_union_v2_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_selected_union_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_union_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_union_v2_rows IS
  'INACTIVE distinct explicitly chosen STOCK membership only, not housing/metric eligibility, statistics, publication or source rights. Actual bounded owner independently replays every whole original/all outside parts/full labels/retained-date states and entire neutral cache/partition; all groups reconcile at a fresh empty probe. Stores only account identity and native ordinals/entry reference, no source/typed copies. Frozen nine roots remain exact; fourth derived head and continuation commit atomically. No worker or HTTP activation.';


-- Preserve the previous guards; only actual native fourth-phase roots and the
-- exact first-human-token bridge are new. Four passes are NOT a whole-RUN SLA.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2')) THEN
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
        AND NOT app.neighborhood_selected_union_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))
      OR (OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_union_refs_v2')
      OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2') THEN
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
    CHECK(sequence BETWEEN 1 AND 8000004),
  ADD CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check
    CHECK(phase IN ('frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2'));

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
    IF NEW.sequence<>1 OR NEW.phase='frozen_selected_union_refs_v2' THEN RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
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
      OR (OLD.phase='frozen_selected_union_refs_v2' AND NEW.phase<>'frozen_selected_union_refs_v2') THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
