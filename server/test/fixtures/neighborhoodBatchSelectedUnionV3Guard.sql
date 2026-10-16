-- DEVELOPMENT fixture ONLY; unregistered/inactive. Exact single-account union
-- over independently issued complete V3 stock/partition/catalog and explicit command.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_selected_union_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; before_body jsonb; command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
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
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF catalog_body->>'format'='cohort_recorded_catalog_batch_receipt_v3' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(catalog_body))<>22
      OR catalog_body->'accounts' IS DISTINCT FROM '[]'::jsonb OR catalog_body->'entries' IS DISTINCT FROM '[]'::jsonb
      OR catalog_body->'original_count' IS DISTINCT FROM '0'::jsonb
      OR catalog_body->'before'->>'done' IS DISTINCT FROM 'false'
      OR catalog_body->'after' IS DISTINCT FROM jsonb_set(catalog_body->'before','{done}','true'::jsonb)
      OR catalog_body->'after_counts' IS DISTINCT FROM catalog_body->'before_counts'
      OR catalog_body->'partition_reference' IS DISTINCT FROM catalog.partition_reference
      OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_recorded_partition_v2_heads p
        JOIN app.neighborhood_custom_cohort_stock_traversal_v2_anchors t ON t.operation_id=p.operation_id AND t.organization_id=p.organization_id
        JOIN app.neighborhood_cohort_evidence_blobs pb ON pb.organization_id=p.organization_id
          AND pb.content_sha256=p.receipt_reference->>'content_sha256'
          AND pb.canonical_utf8_bytes::text=p.receipt_reference->>'canonical_utf8_bytes' AND pb.canonical_utf8_bytes<=16000
        JOIN app.neighborhood_cohort_evidence_blobs tb ON tb.organization_id=t.organization_id
          AND tb.content_sha256=t.receipt_reference->>'content_sha256'
          AND tb.canonical_utf8_bytes::text=t.receipt_reference->>'canonical_utf8_bytes' AND tb.canonical_utf8_bytes<=16000
        WHERE p.operation_id=job.operation_id AND p.organization_id=job.organization_id
          AND p.receipt_reference=catalog.partition_reference AND t.receipt_reference=catalog.traversal_reference
          AND p.traversal_reference=t.receipt_reference AND p.profile_reference=catalog.profile_reference
          AND p.source_reference=catalog.source_reference AND p.root_reference=catalog.root_reference
          AND p.graph_reference=catalog.graph_reference AND p.geographic_reference=catalog.geographic_reference
          AND p.identity_reference=catalog.identity_reference AND p.stock_reference=catalog.stock_reference
          AND pb.canonical_utf8::jsonb->>'format'='cohort_recorded_group_partition_batch_receipt_v3'
          AND pb.canonical_utf8::jsonb->'after'->>'done'='true'
          AND tb.canonical_utf8::jsonb->>'format'='cohort_stock_traversal_batch_receipt_v3'
          AND tb.canonical_utf8::jsonb->'after'->>'done'='true') THEN
      RAISE EXCEPTION 'neighborhood_batch_selected_union_v3_catalog_conflict' USING ERRCODE='55000'; END IF;
  ELSIF catalog_body->>'format' NOT IN ('cohort_recorded_catalog_receipt_v2','cohort_recorded_catalog_batch_receipt_v3') THEN
    RAISE EXCEPTION 'neighborhood_v2_selection_intent_catalog_conflict' USING ERRCODE='55000'; END IF;
  IF NEW.command_id<>command.command_id OR catalog.receipt_reference IS DISTINCT FROM command.checkpoint->'evidence_refs'->8
    OR catalog_body->>'format' NOT IN ('cohort_recorded_catalog_receipt_v2','cohort_recorded_catalog_batch_receipt_v3') OR catalog_body->'after'->>'done' IS DISTINCT FROM 'true'
    OR body->>'format' IS DISTINCT FROM 'cohort_selected_union_receipt_v2' OR (SELECT count(*) FROM jsonb_object_keys(body))<>24
    OR body->>'command_id' IS DISTINCT FROM command.command_id::text OR body->'catalog_reference' IS DISTINCT FROM catalog.receipt_reference
    OR body->>'sequence' IS DISTINCT FROM NEW.sequence::text
    OR (body-ARRAY['format','sequence','previous','before','after','entry_reference','before_counts','after_counts',
      'catalog_reference','command_id','before_selected_count','after_selected_count'])
      IS DISTINCT FROM (catalog_body-ARRAY['format','sequence','previous','before','after','entry_reference','before_counts','after_counts','accounts','entries','original_count'])
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

