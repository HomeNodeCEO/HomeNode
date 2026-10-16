-- Dormant bounded recorded-label catalog. Counts are not source/selection authority.
CREATE TABLE app.neighborhood_custom_cohort_recorded_catalog_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  traversal_reference jsonb NOT NULL CHECK(octet_length(traversal_reference::text) BETWEEN 100 AND 256),
  profile_reference jsonb NOT NULL CHECK(octet_length(profile_reference::text) BETWEEN 100 AND 256),
  partition_reference jsonb NOT NULL CHECK(octet_length(partition_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);
CREATE TABLE app.neighborhood_custom_cohort_recorded_catalog_v2_groups (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  group_id text COLLATE "C" NOT NULL,
  normalized_county text,
  normalized_label text,
  member_count integer NOT NULL CHECK(member_count BETWEEN 1 AND 2000000),
  last_ordinal integer NOT NULL CHECK(last_ordinal BETWEEN 1 AND 2000000),
  PRIMARY KEY(operation_id,group_id),
  CHECK((group_id='discovery:unassigned' AND normalized_county IS NULL AND normalized_label IS NULL)
    OR (group_id ~ '^recorded-cad:[a-f0-9]{64}$' AND normalized_county IS NOT NULL AND normalized_label IS NOT NULL
      AND octet_length(normalized_county) BETWEEN 1 AND 512 AND octet_length(normalized_label) BETWEEN 1 AND 512))
);

CREATE FUNCTION app.guard_neighborhood_recorded_catalog_v2_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE;
  entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  previous jsonb; body jsonb; next_ordinal integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF head.operation_id IS NULL THEN
    next_ordinal:=1;
    IF job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>8 THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_initial_head_required' USING ERRCODE='55000'; END IF;
  ELSE
    SELECT canonical_utf8::jsonb INTO STRICT previous FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF previous->'after'->>'done' IS DISTINCT FROM 'false'
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>9 OR job.checkpoint->'evidence_refs'->8 IS DISTINCT FROM head.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    next_ordinal:=(previous->'after'->>'account_count')::integer+1;
  END IF;
  SELECT * INTO STRICT entry FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=next_ordinal;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=entry.entry_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=entry.entry_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=1000000;
  IF NEW.last_ordinal<>next_ordinal OR NEW.group_id IS DISTINCT FROM coalesce(entry.assigned_group_id,'discovery:unassigned')
    OR body->'recorded_group'->>'state' IS DISTINCT FROM entry.state
    OR (entry.state='assigned' AND (jsonb_array_length(body->'recorded_group'->'candidate_groups')<>1
      OR body->'recorded_group'->'candidate_groups'->0->>'id' IS DISTINCT FROM NEW.group_id
      OR body->'recorded_group'->'candidate_groups'->0->>'normalized_county' IS DISTINCT FROM NEW.normalized_county
      OR body->'recorded_group'->'candidate_groups'->0->>'normalized_label' IS DISTINCT FROM NEW.normalized_label)) THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.member_count<>1 OR NEW.group_id<>'discovery:unassigned' AND
      NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=NEW.operation_id AND group_id=NEW.group_id) AND
      (SELECT count(*) FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=NEW.operation_id AND group_id<>'discovery:unassigned')>=2048 THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_group_limit' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['member_count','last_ordinal']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['member_count','last_ordinal'])
      OR NEW.member_count<>OLD.member_count+1 OR NEW.last_ordinal<=OLD.last_ordinal THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_recorded_catalog_v2_group_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_groups FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_recorded_catalog_v2_group();

CREATE FUNCTION app.guard_neighborhood_recorded_catalog_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  partition app.neighborhood_custom_cohort_recorded_partition_v2_heads%ROWTYPE;
  entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  partition_body jsonb; receipt jsonb; previous jsonb; before_state jsonb; before_counts jsonb; after_state jsonb; actual_counts jsonb;
  key text; next_account text; assigned integer; unassigned integer; groups integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT partition FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR partition.organization_id<>NEW.organization_id OR job.status<>'running'
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL
    OR partition.receipt_reference<>NEW.partition_reference OR job.checkpoint->'evidence_refs'->7 IS DISTINCT FROM NEW.partition_reference THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  FOREACH key IN ARRAY ARRAY['source_reference','root_reference','graph_reference','geographic_reference','identity_reference',
    'stock_reference','traversal_reference','profile_reference'] LOOP
    IF to_jsonb(NEW)->key IS DISTINCT FROM to_jsonb(partition)->key THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM NEW.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM NEW.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM NEW.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM NEW.identity_reference
    OR job.checkpoint->'evidence_refs'->6 IS DISTINCT FROM NEW.traversal_reference THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT partition_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.partition_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.partition_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF partition_body->>'format' IS DISTINCT FROM 'cohort_recorded_group_partition_receipt_v2'
    OR partition_body->'after'->>'done' IS DISTINCT FROM 'true' OR partition_body->>'sequence' IS DISTINCT FROM partition.sequence::text
    OR receipt->>'format' IS DISTINCT FROM 'cohort_recorded_catalog_receipt_v2'
    OR receipt->'partition_reference' IS DISTINCT FROM NEW.partition_reference
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>20
    OR (receipt-ARRAY['format','sequence','previous','before','after','entry_reference','partition_reference','before_counts','after_counts'])
      IS DISTINCT FROM (partition_body-ARRAY['format','sequence','previous','before','after','entry_reference']) THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    before_state:='{"after_account":"","account_count":0,"done":false}'::jsonb;
    before_counts:='{"assigned_accounts":0,"unassigned_accounts":0,"assigned_groups":0}'::jsonb;
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_partition_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>8 THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_initial_head_required' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>9
      OR job.checkpoint->'evidence_refs'->8 IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT previous FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    before_state:=previous->'after'; before_counts:=previous->'after_counts';
  END IF;
  IF receipt->'before' IS DISTINCT FROM before_state OR receipt->'before_counts' IS DISTINCT FROM before_counts
    OR before_state->>'done' IS DISTINCT FROM 'false' OR NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO entry FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  next_account:=entry.account_id;
  after_state:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
    'account_count',(before_state->>'account_count')::integer+CASE WHEN next_account IS NULL THEN 0 ELSE 1 END,'done',next_account IS NULL);
  SELECT coalesce(sum(member_count) FILTER(WHERE group_id<>'discovery:unassigned'),0)::integer,
    coalesce(sum(member_count) FILTER(WHERE group_id='discovery:unassigned'),0)::integer,
    count(*) FILTER(WHERE group_id<>'discovery:unassigned')::integer INTO assigned,unassigned,groups
    FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  actual_counts:=jsonb_build_object('assigned_accounts',assigned,'unassigned_accounts',unassigned,'assigned_groups',groups);
  IF receipt->'after' IS DISTINCT FROM after_state OR receipt->'after_counts' IS DISTINCT FROM actual_counts
    OR assigned+unassigned<>(after_state->>'account_count')::integer OR groups>2048
    OR (next_account IS NULL AND ((after_state->>'account_count') IS DISTINCT FROM partition_body->>'stock_account_count'
      OR receipt->'entry_reference' IS DISTINCT FROM 'null'::jsonb OR actual_counts IS DISTINCT FROM before_counts))
    OR (next_account IS NOT NULL AND (receipt->'entry_reference' IS DISTINCT FROM entry.entry_reference
      OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups
        WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id
          AND group_id=coalesce(entry.assigned_group_id,'discovery:unassigned') AND last_ordinal=NEW.sequence))) THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_recorded_catalog_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_recorded_catalog_v2_head();

CREATE FUNCTION app.check_neighborhood_recorded_catalog_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; checkpoint jsonb;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT job.checkpoint INTO STRICT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs job WHERE operation_id=NEW.operation_id;
  IF checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2' OR jsonb_array_length(checkpoint->'evidence_refs')<>9
    OR checkpoint->'evidence_refs'->8 IS DISTINCT FROM head.receipt_reference THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='neighborhood_custom_cohort_recorded_catalog_v2_groups' THEN
    IF head.sequence<>NEW.last_ordinal THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_recorded_catalog_v2_group_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_groups DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_recorded_catalog_v2_commit();
CREATE CONSTRAINT TRIGGER neighborhood_recorded_catalog_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_recorded_catalog_v2_commit();
CREATE TRIGGER neighborhood_recorded_catalog_v2_group_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_groups FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_recorded_catalog_v2_head_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_recorded_catalog_v2_heads FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
COMMENT ON TABLE app.neighborhood_custom_cohort_recorded_catalog_v2_groups IS
  'Dormant original-reconciled catalog counts only. Exactly one next partition account per bounded actual-owner transaction; all unassigned accounts remain explicit, no conflicting candidate promoted. At most2048 assigned groups; overflow refuses the whole step, never truncates. Original/raw variants remain in complete original/partition lineage, not duplicated here. Native prefix/head/checkpoint guards are not source rights or selection authority. Future semantic consumers reopen originals; no dense roster, selection, statistic, publication, report or pin transfer.';
