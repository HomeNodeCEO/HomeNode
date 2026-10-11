-- INACTIVE ninth reference-only population reconciliation. No backfill or
-- numeric copies. This foundation is NOT wired to job/continuation grammar or
-- the original owner yet: until that separate integration, no ninth transition
-- can COMMIT. Native structure NEVER substitutes for current source authority.
CREATE TABLE app.neighborhood_custom_cohort_selected_numeric_v2_rows (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  partition_ordinal integer NOT NULL CHECK(partition_ordinal BETWEEN 1 AND 2000000),
  entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
  metric_row_reference jsonb NOT NULL CHECK(octet_length(metric_row_reference::text) BETWEEN 100 AND 256),
  contribution_row_reference jsonb NOT NULL CHECK(octet_length(contribution_row_reference::text) BETWEEN 100 AND 256),
  PRIMARY KEY(operation_id,ordinal), UNIQUE(operation_id,account_id),
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_statistics_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_numeric_index_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_numeric_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  union_reference jsonb NOT NULL CHECK(octet_length(union_reference::text) BETWEEN 100 AND 256),
  eligibility_reference jsonb NOT NULL CHECK(octet_length(eligibility_reference::text) BETWEEN 100 AND 256),
  evidence_reference jsonb NOT NULL CHECK(octet_length(evidence_reference::text) BETWEEN 100 AND 256),
  metrics_reference jsonb NOT NULL CHECK(octet_length(metrics_reference::text) BETWEEN 100 AND 256),
  statistics_reference jsonb NOT NULL CHECK(octet_length(statistics_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);

-- Keep every old checkpoint reader strict. Exact15 recursively verifies the
-- whole exact14 parent graph, not merely its last hash or DONE/count fields.
CREATE FUNCTION app.neighborhood_selected_numeric_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads h
    JOIN app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth USING(operation_id,organization_id)
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=eighth.organization_id
      AND b.content_sha256=eighth.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE h.operation_id=op AND h.organization_id=org AND h.command_id=eighth.command_id
      AND h.union_reference=eighth.union_reference AND h.eligibility_reference=eighth.eligibility_reference
      AND h.evidence_reference=eighth.evidence_reference AND h.metrics_reference=eighth.metrics_reference
      AND h.statistics_reference=eighth.receipt_reference
      AND cp->>'phase'='frozen_selected_numeric_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=15
      AND (cp-'phase'-'evidence_refs')='{}'::jsonb AND cp->'evidence_refs'->14=h.receipt_reference
      AND app.neighborhood_selected_statistics_v2_checkpoint_matches(op,org,
        jsonb_build_object('phase','frozen_selected_statistics_refs_v2','evidence_refs',(cp->'evidence_refs')-14))
      AND b.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
      AND b.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'),false)
$$;
CREATE FUNCTION app.neighborhood_selected_numeric_v2_admission_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads eighth
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=eighth.organization_id
      AND b.content_sha256=eighth.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE eighth.operation_id=op AND eighth.organization_id=org
      AND b.canonical_utf8::jsonb->>'format'='cohort_selected_statistics_receipt_v2'
      AND b.canonical_utf8::jsonb->>'sequence'=eighth.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'
      AND ((app.neighborhood_selected_statistics_v2_checkpoint_matches(op,org,cp) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads h WHERE h.operation_id=op))
        OR app.neighborhood_selected_numeric_v2_checkpoint_matches(op,org,cp))),false)
$$;

CREATE FUNCTION app.guard_neighborhood_selected_numeric_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_selected_numeric_v2_heads%ROWTYPE; prior jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_selected_numeric_v2_row_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR NEW.ordinal<>coalesce(h.sequence,0)+1
    OR NOT app.neighborhood_selected_numeric_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows m
      JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i USING(operation_id,organization_id,ordinal,account_id)
      WHERE m.operation_id=NEW.operation_id AND m.organization_id=NEW.organization_id AND m.ordinal=NEW.ordinal
        AND m.account_id=NEW.account_id AND m.partition_ordinal=NEW.partition_ordinal AND m.entry_reference=NEW.entry_reference
        AND m.metric_row_reference=NEW.metric_row_reference AND m.row_reference=NEW.contribution_row_reference
        AND i.contribution_row_reference=m.row_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_v2_row_conflict' USING ERRCODE='55000'; END IF;
  IF h.operation_id IS NOT NULL THEN
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
    IF prior->>'format' IS DISTINCT FROM 'cohort_selected_numeric_receipt_v2' OR prior->>'sequence' IS DISTINCT FROM h.sequence::text
      OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_numeric_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_numeric_v2_rows FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_numeric_v2_row();
CREATE TRIGGER neighborhood_selected_numeric_v2_row_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_numeric_v2_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.guard_neighborhood_selected_numeric_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  eighth app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE;
  member app.neighborhood_custom_cohort_selected_statistics_v2_rows%ROWTYPE;
  retained app.neighborhood_custom_cohort_selected_numeric_v2_rows%ROWTYPE;
  parent jsonb; prior jsonb; body jsonb; before_state jsonb; after_state jsonb; actual_entry jsonb;
  row_count bigint; year_count bigint; residential_count bigint; site_count bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_numeric_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT eighth FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR NEW.command_id<>eighth.command_id OR NEW.union_reference IS DISTINCT FROM eighth.union_reference
    OR NEW.eligibility_reference IS DISTINCT FROM eighth.eligibility_reference OR NEW.evidence_reference IS DISTINCT FROM eighth.evidence_reference
    OR NEW.metrics_reference IS DISTINCT FROM eighth.metrics_reference OR NEW.statistics_reference IS DISTINCT FROM eighth.receipt_reference
    OR NOT app.neighborhood_selected_numeric_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT parent FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
    AND content_sha256=eighth.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=eighth.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF TG_OP='INSERT' THEN
    IF NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    before_state:=jsonb_build_object('selected_ordinal',0,'done',false);
  ELSE
    IF NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
      OR (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 THEN RAISE EXCEPTION 'neighborhood_selected_numeric_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
      AND content_sha256=OLD.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
    IF prior->>'format' IS DISTINCT FROM 'cohort_selected_numeric_receipt_v2'
      OR prior->>'sequence' IS DISTINCT FROM OLD.sequence::text OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
    before_state:=prior->'after';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
    AND content_sha256=NEW.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body->>'format' IS DISTINCT FROM 'cohort_selected_numeric_receipt_v2'
    OR (SELECT count(*) FROM jsonb_object_keys(body))<>14
    OR (body-ARRAY['format','union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','command_id',
      'selected_stock_count','sequence','previous','before','after','selected_entry','contribution_row_reference'])<>'{}'::jsonb
    OR body->>'command_id' IS DISTINCT FROM NEW.command_id::text OR body->'union_reference' IS DISTINCT FROM NEW.union_reference
    OR body->'eligibility_reference' IS DISTINCT FROM NEW.eligibility_reference OR body->'evidence_reference' IS DISTINCT FROM NEW.evidence_reference
    OR body->'metrics_reference' IS DISTINCT FROM NEW.metrics_reference OR body->'statistics_reference' IS DISTINCT FROM NEW.statistics_reference
    OR body->'selected_stock_count' IS DISTINCT FROM parent->'selected_stock_count'
    OR body->'sequence' IS DISTINCT FROM to_jsonb(NEW.sequence) OR NEW.sequence<>(before_state->>'selected_ordinal')::integer+1
    OR body->'before' IS DISTINCT FROM before_state
    OR (TG_OP='INSERT' AND (NEW.sequence<>1 OR body->'previous' IS DISTINCT FROM 'null'::jsonb))
    OR (TG_OP='UPDATE' AND body->'previous' IS DISTINCT FROM OLD.receipt_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO member FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  after_state:=jsonb_build_object('selected_ordinal',(before_state->>'selected_ordinal')::integer+CASE WHEN member.account_id IS NULL THEN 0 ELSE 1 END,'done',member.account_id IS NULL);
  IF member.account_id IS NULL THEN
    IF body->'selected_entry' IS DISTINCT FROM 'null'::jsonb OR body->'contribution_row_reference' IS DISTINCT FROM 'null'::jsonb
      OR after_state->'selected_ordinal' IS DISTINCT FROM parent->'selected_stock_count'
      OR (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id)<>(parent->>'selected_stock_count')::integer THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_complete_union_conflict' USING ERRCODE='55000'; END IF;
    -- Fresh EMPTY, actual native complete population and all three eligible
    -- totals. Structural check only: count/DONE never grants source authority.
    SELECT count(*),count(reported_year_built),count(reported_residential_area),count(reported_site_area)
      INTO row_count,year_count,residential_count,site_count FROM app.neighborhood_custom_cohort_selected_numeric_index_v2_rows
      WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF row_count IS DISTINCT FROM (parent->>'selected_stock_count')::bigint
      OR year_count IS DISTINCT FROM (parent->'after_counts'->'reported_year_built'->>'eligible_count')::bigint
      OR residential_count IS DISTINCT FROM (parent->'after_counts'->'reported_residential_area'->>'eligible_count')::bigint
      OR site_count IS DISTINCT FROM (parent->'after_counts'->'reported_site_area'->>'eligible_count')::bigint THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_index_incomplete' USING ERRCODE='55000'; END IF;
  ELSE
    actual_entry:=jsonb_build_object('account_id',member.account_id,'ordinal',member.ordinal,'partition_ordinal',member.partition_ordinal,'entry_reference',member.entry_reference);
    SELECT * INTO STRICT retained FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows
      WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
    IF retained.account_id<>member.account_id OR retained.partition_ordinal<>member.partition_ordinal OR retained.entry_reference IS DISTINCT FROM member.entry_reference
      OR retained.metric_row_reference IS DISTINCT FROM member.metric_row_reference OR retained.contribution_row_reference IS DISTINCT FROM member.row_reference
      OR body->'contribution_row_reference' IS DISTINCT FROM member.row_reference OR body->'selected_entry' IS DISTINCT FROM actual_entry THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_v2_member_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  IF body->'after' IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'neighborhood_selected_numeric_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_numeric_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_numeric_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_numeric_v2_head();
CREATE TRIGGER neighborhood_selected_numeric_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_numeric_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.check_neighborhood_selected_numeric_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_numeric_v2_heads%ROWTYPE;
  job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR c.phase<>'frozen_selected_numeric_refs_v2' OR c.progress_reference<>h.receipt_reference
    OR c.issued_attempts<>job.attempts OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry'
    OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_v2_orphan_progress' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_numeric_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_numeric_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_numeric_v2_commit();
CREATE FUNCTION app.check_neighborhood_selected_numeric_v2_row_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_numeric_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF h.sequence<>NEW.ordinal OR body->'contribution_row_reference' IS DISTINCT FROM NEW.contribution_row_reference
    OR body->'selected_entry' IS DISTINCT FROM jsonb_build_object('account_id',NEW.account_id,'ordinal',NEW.ordinal,
      'partition_ordinal',NEW.partition_ordinal,'entry_reference',NEW.entry_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_v2_orphan_row' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_numeric_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_numeric_v2_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_numeric_v2_row_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_numeric_v2_rows IS
  'INACTIVE ninth reference-only reconciliation ledger. Native next ordinal, exact15 full parent graph and deferred atomic head/job/single-use continuation; no numeric/original/typed copies or backfill. Not integrated with actual original owner/job grammar yet and therefore cannot commit. Current and ending source/database/assignment/draft/subject authority and fresh whole originals/ENTIRE caches are mandatory for future owner integration and AGAIN for every later semantic statistics pass. No medians/COD/quarters/publication/license/live-speed acceptance.';
