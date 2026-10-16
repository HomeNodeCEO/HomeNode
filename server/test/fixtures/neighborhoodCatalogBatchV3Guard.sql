-- DEVELOPMENT fixture ONLY; unregistered and inactive.
-- Legacy V2 branches retain exact single-account rules. V3 guards native prefix/group DML/checkpoint consistency;
-- actual owner still reopens EVERY whole original, ENTIRE neutral cache and ENTIRE partition entry at both authority fences.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_recorded_catalog_v2_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE;
  entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  previous jsonb; body jsonb; partition_body jsonb; next_ordinal integer; before_count integer; is_batch boolean;
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
  before_count:=next_ordinal-1;
  IF head.operation_id IS NULL THEN
    SELECT canonical_utf8::jsonb INTO STRICT partition_body FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=job.checkpoint->'evidence_refs'->7->>'content_sha256'
        AND canonical_utf8_bytes::text=job.checkpoint->'evidence_refs'->7->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    is_batch:=partition_body->>'format' IS NOT DISTINCT FROM 'cohort_recorded_group_partition_batch_receipt_v3';
    IF is_batch AND partition_body->'after'->>'done' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_partition_required' USING ERRCODE='55000'; END IF;
  ELSE is_batch:=previous->>'format' IS NOT DISTINCT FROM 'cohort_recorded_catalog_batch_receipt_v3'; END IF;
  IF is_batch THEN
    IF NEW.last_ordinal<=before_count OR NEW.last_ordinal>before_count+8 THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    next_ordinal:=NEW.last_ordinal;
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

CREATE OR REPLACE FUNCTION app.guard_neighborhood_recorded_catalog_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  partition app.neighborhood_custom_cohort_recorded_partition_v2_heads%ROWTYPE;
  entry app.neighborhood_custom_cohort_recorded_partition_v2_rows%ROWTYPE;
  partition_body jsonb; receipt jsonb; previous jsonb; before_state jsonb; before_counts jsonb; after_state jsonb; actual_counts jsonb;
  key text; next_account text; assigned integer; unassigned integer; groups integer;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  is_batch boolean; batch_count integer; batch_originals integer; native_accounts jsonb; native_entries jsonb;
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
  is_batch:=receipt->>'format' IS NOT DISTINCT FROM 'cohort_recorded_catalog_batch_receipt_v3';
  IF partition_body->>'format' IS DISTINCT FROM (CASE WHEN is_batch THEN 'cohort_recorded_group_partition_batch_receipt_v3' ELSE 'cohort_recorded_group_partition_receipt_v2' END)
    OR partition_body->'after'->>'done' IS DISTINCT FROM 'true' OR partition_body->>'sequence' IS DISTINCT FROM partition.sequence::text
    OR NOT (is_batch OR receipt->>'format' IS NOT DISTINCT FROM 'cohort_recorded_catalog_receipt_v2')
    OR receipt->'partition_reference' IS DISTINCT FROM NEW.partition_reference
    OR receipt->>'sequence' IS DISTINCT FROM NEW.sequence::text OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>(CASE WHEN is_batch THEN 22 ELSE 20 END)
    OR (receipt-CASE WHEN is_batch THEN ARRAY['format','sequence','previous','before','after','accounts','original_count','entries','partition_reference','before_counts','after_counts']
      ELSE ARRAY['format','sequence','previous','before','after','entry_reference','partition_reference','before_counts','after_counts'] END)
      IS DISTINCT FROM (partition_body-CASE WHEN is_batch THEN ARRAY['format','sequence','previous','before','after','accounts','original_count','entries']
      ELSE ARRAY['format','sequence','previous','before','after','entry_reference'] END) THEN
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
    IF previous->>'format' IS DISTINCT FROM receipt->>'format' THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_format_conflict' USING ERRCODE='55000'; END IF;
    before_state:=previous->'after'; before_counts:=previous->'after_counts';
  END IF;
  IF receipt->'before' IS DISTINCT FROM before_state OR receipt->'before_counts' IS DISTINCT FROM before_counts
    OR before_state->>'done' IS DISTINCT FROM 'false' OR NOT is_batch AND NEW.sequence<>(before_state->>'account_count')::integer+1 THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  IF is_batch THEN
    SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
    IF stock.organization_id<>NEW.organization_id OR stock.status<>'complete'
      OR stock.account_count::text IS DISTINCT FROM partition_body->>'stock_account_count'
      OR stock.generation_id::text IS DISTINCT FROM partition_body->'binding'->>'generation_id' THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_binding_conflict' USING ERRCODE='55000'; END IF;
    IF jsonb_typeof(receipt->'accounts') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'entries') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    batch_count:=jsonb_array_length(receipt->'accounts');
    IF batch_count>8 OR jsonb_array_length(receipt->'entries')<>batch_count THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    WITH next_accounts AS MATERIALIZED (
      SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
      WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C"
      ORDER BY account_id LIMIT batch_count
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',a.account_id,'geographic_parcel_count',a.parcel_count::text,
      'original_counts',jsonb_build_object('parcels',(SELECT count(*)::integer FROM (
        SELECT 1 FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=stock.generation_id AND o.kind='parcels'
          AND o.account_id=a.account_id LIMIT 251) p),'accounts',(SELECT count(*)::integer FROM (
        SELECT 1 FROM app.neighborhood_frozen_source_rows o WHERE o.generation_id=stock.generation_id AND o.kind='accounts'
          AND o.account_id=a.account_id LIMIT 251) c))) ORDER BY a.account_id COLLATE "C"),'[]'::jsonb)
      INTO native_accounts FROM next_accounts a;
    IF jsonb_array_length(native_accounts)<>batch_count OR receipt->'accounts' IS DISTINCT FROM native_accounts THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
    SELECT coalesce(sum((a.value->'original_counts'->>'parcels')::integer+(a.value->'original_counts'->>'accounts')::integer),0)::integer
      INTO batch_originals FROM jsonb_array_elements(native_accounts) a;
    IF batch_originals>250 OR receipt->'original_count' IS DISTINCT FROM to_jsonb(batch_originals)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(native_accounts) a WHERE (a.value->'original_counts'->>'accounts')::integer>1
        OR (a.value->'original_counts'->>'parcels')::integer<(a.value->>'geographic_parcel_count')::bigint) THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_original_bound_conflict' USING ERRCODE='55000'; END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',r.account_id,'ordinal',r.ordinal,
      'entry_reference',r.entry_reference,'state',r.state,'assigned_group_id',r.assigned_group_id) ORDER BY a.ord),'[]'::jsonb)
      INTO native_entries FROM jsonb_array_elements(native_accounts) WITH ORDINALITY a(value,ord)
      JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows r ON r.operation_id=NEW.operation_id
        AND r.organization_id=NEW.organization_id AND r.account_id=a.value->>'account_id'
        AND r.ordinal=(before_state->>'account_count')::integer+a.ord;
    IF jsonb_array_length(native_entries)<>batch_count OR receipt->'entries' IS DISTINCT FROM native_entries THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_entry_conflict' USING ERRCODE='55000'; END IF;
    IF batch_count=0 THEN
      IF EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts
        WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C" LIMIT 1)
        OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_partition_v2_rows
          WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id
            AND ordinal>(before_state->>'account_count')::integer LIMIT 1) THEN
        RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
      next_account:=NULL;
    ELSE next_account:=native_accounts->(batch_count-1)->>'account_id'; END IF;
    after_state:=jsonb_build_object('after_account',coalesce(next_account,before_state->>'after_account'),
      'account_count',(before_state->>'account_count')::integer+batch_count,'done',batch_count=0);
    SELECT coalesce(sum(member_count) FILTER(WHERE group_id<>'discovery:unassigned'),0)::integer,
      coalesce(sum(member_count) FILTER(WHERE group_id='discovery:unassigned'),0)::integer,
      count(*) FILTER(WHERE group_id<>'discovery:unassigned')::integer INTO assigned,unassigned,groups FROM (
        SELECT group_id,member_count FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups
          WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id ORDER BY group_id LIMIT 2049) bounded;
    actual_counts:=jsonb_build_object('assigned_accounts',assigned,'unassigned_accounts',unassigned,'assigned_groups',groups);
    IF receipt->'after' IS DISTINCT FROM after_state OR receipt->'after_counts' IS DISTINCT FROM actual_counts
      OR assigned+unassigned<>(after_state->>'account_count')::integer OR groups>2048
      OR (after_state->>'account_count')::integer>stock.account_count
      OR (batch_count=0 AND ((after_state->>'account_count')::integer<>stock.account_count OR actual_counts IS DISTINCT FROM before_counts))
      OR assigned-(before_counts->>'assigned_accounts')::integer<>(SELECT count(*) FROM jsonb_array_elements(native_entries) e WHERE e.value->>'state'='assigned')
      OR unassigned-(before_counts->>'unassigned_accounts')::integer<>(SELECT count(*) FROM jsonb_array_elements(native_entries) e WHERE e.value->>'state'<>'assigned')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(native_entries) e WHERE NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups g
          WHERE g.operation_id=NEW.operation_id AND g.organization_id=NEW.organization_id
            AND g.group_id=coalesce(e.value->>'assigned_group_id','discovery:unassigned')
            AND g.last_ordinal>=(e.value->>'ordinal')::integer AND g.last_ordinal<=(after_state->>'account_count')::integer))
      OR EXISTS(SELECT 1 FROM (SELECT last_ordinal FROM app.neighborhood_custom_cohort_recorded_catalog_v2_groups
          WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id ORDER BY group_id LIMIT 2049) g
          WHERE g.last_ordinal>(after_state->>'account_count')::integer) THEN
      RAISE EXCEPTION 'neighborhood_catalog_batch_v3_prefix_conflict' USING ERRCODE='55000'; END IF;
  ELSE
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
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.check_neighborhood_recorded_catalog_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; checkpoint jsonb; receipt jsonb;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_recorded_catalog_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT job.checkpoint INTO STRICT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs job WHERE operation_id=NEW.operation_id;
  IF checkpoint->>'phase' IS DISTINCT FROM 'frozen_recorded_catalog_refs_v2' OR jsonb_array_length(checkpoint->'evidence_refs')<>9
    OR checkpoint->'evidence_refs'->8 IS DISTINCT FROM head.receipt_reference THEN
    RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='neighborhood_custom_cohort_recorded_catalog_v2_groups' THEN
    SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=head.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF receipt->>'format'='cohort_recorded_catalog_batch_receipt_v3' THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipt->'entries') e WHERE
        e.value->>'ordinal'=NEW.last_ordinal::text AND coalesce(e.value->>'assigned_group_id','discovery:unassigned')=NEW.group_id) THEN
        RAISE EXCEPTION 'neighborhood_catalog_batch_v3_commit_conflict' USING ERRCODE='55000'; END IF;
    ELSIF head.sequence<>NEW.last_ordinal THEN
      RAISE EXCEPTION 'neighborhood_recorded_catalog_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NULL;
END $$;
