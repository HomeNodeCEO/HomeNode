-- INACTIVE eighth pass: original-derived contribution states, NOT statistics.
-- Source rights and original/ENTIRE-cache reconciliation belong to the bounded
-- current-authorized owner. These native guards establish structural retention
-- only; a later semantic consumer MUST reopen originals again.
CREATE TABLE app.neighborhood_custom_cohort_selected_statistics_v2_rows (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  partition_ordinal integer NOT NULL CHECK(partition_ordinal BETWEEN 1 AND 2000000),
  entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
  metric_row_reference jsonb NOT NULL CHECK(octet_length(metric_row_reference::text) BETWEEN 100 AND 256),
  row_reference jsonb NOT NULL CHECK(octet_length(row_reference::text) BETWEEN 100 AND 256),
  PRIMARY KEY(operation_id,ordinal), UNIQUE(operation_id,account_id),
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_metrics_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_statistics_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  union_reference jsonb NOT NULL CHECK(octet_length(union_reference::text) BETWEEN 100 AND 256),
  eligibility_reference jsonb NOT NULL CHECK(octet_length(eligibility_reference::text) BETWEEN 100 AND 256),
  evidence_reference jsonb NOT NULL CHECK(octet_length(evidence_reference::text) BETWEEN 100 AND 256),
  metrics_reference jsonb NOT NULL CHECK(octet_length(metrics_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);
CREATE FUNCTION app.neighborhood_selected_statistics_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads h
    JOIN app.neighborhood_custom_cohort_selected_metrics_v2_heads seventh USING(operation_id,organization_id)
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=seventh.organization_id
      AND b.content_sha256=seventh.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=seventh.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE h.operation_id=op AND h.organization_id=org AND h.command_id=seventh.command_id
      AND h.union_reference=seventh.union_reference AND h.eligibility_reference=seventh.eligibility_reference
      AND h.evidence_reference=seventh.evidence_reference AND h.metrics_reference=seventh.receipt_reference
      AND cp->>'phase'='frozen_selected_statistics_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=14
      AND (cp-'phase'-'evidence_refs')='{}'::jsonb AND cp->'evidence_refs'->13=h.receipt_reference
      AND app.neighborhood_selected_metrics_v2_checkpoint_matches(op,org,
        jsonb_build_object('phase','frozen_selected_metrics_refs_v2','evidence_refs',(cp->'evidence_refs')-13))
      AND b.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
      AND b.canonical_utf8::jsonb->>'sequence'=seventh.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'),false)
$$;
-- Separate exact13 initial / exact14 progressed grammar; NEVER widen old readers.
CREATE FUNCTION app.neighborhood_selected_statistics_v2_admission_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads seventh
    JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=seventh.organization_id
      AND b.content_sha256=seventh.receipt_reference->>'content_sha256'
      AND b.canonical_utf8_bytes::text=seventh.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=16000
    WHERE seventh.operation_id=op AND seventh.organization_id=org
      AND b.canonical_utf8::jsonb->>'format'='cohort_selected_metrics_receipt_v2'
      AND b.canonical_utf8::jsonb->>'sequence'=seventh.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'
      AND ((app.neighborhood_selected_metrics_v2_checkpoint_matches(op,org,cp) AND NOT EXISTS(
        SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads h WHERE h.operation_id=op))
        OR app.neighborhood_selected_statistics_v2_checkpoint_matches(op,org,cp))),false)
$$;
-- Bounded closed counter DATA. Each reason is a separate overlapping exclusion;
-- source-part totals NEVER become account denominators or numerical values.
CREATE FUNCTION app.neighborhood_selected_statistics_v2_next_counts(prior jsonb,cells jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb:='{}'; cell jsonb; c jsonb; key text; state text; part text; reason text; source_total integer; total integer; n integer;
  states text[]:=ARRAY['observed','missing','invalid','conflicting','unsupported'];
  parts text[]:=ARRAY['observed','missing','invalid','unsupported'];
  reasons text[]:=ARRAY['subject_housing_missing','subject_housing_unknown','subject_housing_partial','subject_housing_conflicting',
    'account_housing_missing','account_housing_unknown','account_housing_partial','account_housing_conflicting',
    'different_recorded_housing_category','recorded_value_missing','recorded_value_invalid','recorded_value_conflicting',
    'recorded_value_unsupported','missing_parts','invalid_parts','unsupported_parts','currency_not_established'];
BEGIN
  FOREACH key IN ARRAY ARRAY['reported_year_built','reported_residential_area','reported_site_area','reported_market_value'] LOOP
    IF prior IS NULL THEN
      c:=jsonb_build_object('value_states','{}'::jsonb,'complete_observed_count',0,'eligible_count',0,'excluded_count',0,
        'source_part_counts','{}'::jsonb,'exclusion_reason_counts','{}'::jsonb);
      FOREACH state IN ARRAY states LOOP c:=jsonb_set(c,ARRAY['value_states',state],'0'::jsonb); END LOOP;
      FOREACH part IN ARRAY parts LOOP c:=jsonb_set(c,ARRAY['source_part_counts',part],'0'::jsonb); END LOOP;
      FOREACH reason IN ARRAY reasons LOOP c:=jsonb_set(c,ARRAY['exclusion_reason_counts',reason],'0'::jsonb); END LOOP;
    ELSE c:=prior->key; END IF;
    IF cells IS NOT NULL THEN
      cell:=cells->key;
      IF jsonb_typeof(cell) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(cell))<>8
        OR (cell-ARRAY['reported_value_state','complete_observed_parts','recorded_comparison_eligible',
          'contribution_exact_value','contribution_unit','exclusion_reasons','source_part_count','part_counts'])<>'{}'::jsonb
        OR cell->>'reported_value_state' IS NULL OR NOT (cell->>'reported_value_state'=ANY(states))
        OR jsonb_typeof(cell->'complete_observed_parts') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(cell->'recorded_comparison_eligible') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(cell->'source_part_count') IS DISTINCT FROM 'number'
        OR cell->>'source_part_count' !~ '^[1-9][0-9]{0,2}$'
        OR (cell->>'source_part_count')::integer>250
        OR jsonb_typeof(cell->'part_counts') IS DISTINCT FROM 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(cell->'part_counts'))<>4
        OR ((cell->'part_counts')-parts)<>'{}'::jsonb
        OR jsonb_typeof(cell->'exclusion_reasons') IS DISTINCT FROM 'array'
        OR jsonb_array_length(cell->'exclusion_reasons')>17
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(cell->'exclusion_reasons') r(v)
          WHERE jsonb_typeof(v)<>'string' OR NOT ((v#>>'{}')=ANY(reasons)))
        OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(cell->'exclusion_reasons') r(v))<>jsonb_array_length(cell->'exclusion_reasons')
        OR ((cell->>'recorded_comparison_eligible')::boolean AND jsonb_array_length(cell->'exclusion_reasons')<>0)
        OR (NOT (cell->>'recorded_comparison_eligible')::boolean AND jsonb_array_length(cell->'exclusion_reasons')=0) THEN
        RAISE EXCEPTION 'neighborhood_selected_statistics_v2_cell_conflict' USING ERRCODE='55000'; END IF;
      total:=0;
      FOREACH part IN ARRAY parts LOOP
        IF jsonb_typeof(cell->'part_counts'->part) IS DISTINCT FROM 'number' OR cell->'part_counts'->>part !~ '^(0|[1-9][0-9]{0,2})$' THEN
          RAISE EXCEPTION 'neighborhood_selected_statistics_v2_parts_conflict' USING ERRCODE='55000'; END IF;
        n:=(cell->'part_counts'->>part)::integer;total:=total+n;
        IF n>250 THEN RAISE EXCEPTION 'neighborhood_selected_statistics_v2_parts_conflict' USING ERRCODE='55000'; END IF;
        c:=jsonb_set(c,ARRAY['source_part_counts',part],to_jsonb((c->'source_part_counts'->>part)::integer+n));
      END LOOP;
      IF total<>(cell->>'source_part_count')::integer OR (source_total IS NOT NULL AND source_total<>total)
        OR cell->'complete_observed_parts' IS DISTINCT FROM to_jsonb(cell->>'reported_value_state'='observed'
          AND cell->'part_counts'->>'observed'=cell->>'source_part_count' AND key<>'reported_market_value')
        OR (cell->>'recorded_comparison_eligible'='true' AND cell->>'complete_observed_parts'<>'true')
        OR (cell->>'reported_value_state'='observed' AND (cell->'part_counts'->>'observed')::integer=0)
        OR (cell->>'reported_value_state'='missing' AND (cell->'part_counts'->>'missing')::integer<>total)
        OR (cell->>'reported_value_state'='invalid' AND ((cell->'part_counts'->>'invalid')::integer=0
          OR (cell->'part_counts'->>'observed')::integer<>0 OR (cell->'part_counts'->>'unsupported')::integer<>0))
        OR (cell->>'reported_value_state'='unsupported' AND ((cell->'part_counts'->>'unsupported')::integer=0
          OR (cell->'part_counts'->>'observed')::integer<>0))
        OR (cell->>'reported_value_state'='conflicting' AND (cell->'part_counts'->>'observed')::integer<2) THEN
        RAISE EXCEPTION 'neighborhood_selected_statistics_v2_parts_conflict' USING ERRCODE='55000'; END IF;
      source_total:=total;
      FOREACH state IN ARRAY states LOOP
        IF state<>'observed' AND (cell->'exclusion_reasons' ? ('recorded_value_'||state)) IS DISTINCT FROM (cell->>'reported_value_state'=state) THEN
          RAISE EXCEPTION 'neighborhood_selected_statistics_v2_reason_conflict' USING ERRCODE='55000'; END IF;
        c:=jsonb_set(c,ARRAY['value_states',state],to_jsonb((c->'value_states'->>state)::integer+CASE WHEN cell->>'reported_value_state'=state THEN 1 ELSE 0 END));
      END LOOP;
      FOREACH part IN ARRAY parts LOOP
        IF part<>'observed' AND (cell->'exclusion_reasons' ? (part||'_parts')) IS DISTINCT FROM ((cell->'part_counts'->>part)::integer>0) THEN
          RAISE EXCEPTION 'neighborhood_selected_statistics_v2_reason_conflict' USING ERRCODE='55000'; END IF;
      END LOOP;
      IF (cell->'exclusion_reasons' ? 'currency_not_established') IS DISTINCT FROM (key='reported_market_value') THEN
        RAISE EXCEPTION 'neighborhood_selected_statistics_v2_reason_conflict' USING ERRCODE='55000'; END IF;
      c:=jsonb_set(c,ARRAY['complete_observed_count'],to_jsonb((c->>'complete_observed_count')::integer+CASE WHEN cell->>'complete_observed_parts'='true' THEN 1 ELSE 0 END));
      c:=jsonb_set(c,ARRAY['eligible_count'],to_jsonb((c->>'eligible_count')::integer+CASE WHEN cell->>'recorded_comparison_eligible'='true' THEN 1 ELSE 0 END));
      c:=jsonb_set(c,ARRAY['excluded_count'],to_jsonb((c->>'excluded_count')::integer+CASE WHEN cell->>'recorded_comparison_eligible'='true' THEN 0 ELSE 1 END));
      FOREACH reason IN ARRAY reasons LOOP
        c:=jsonb_set(c,ARRAY['exclusion_reason_counts',reason],to_jsonb((c->'exclusion_reason_counts'->>reason)::integer+CASE WHEN cell->'exclusion_reasons' ? reason THEN 1 ELSE 0 END));
      END LOOP;
    END IF;
    result:=jsonb_set(result,ARRAY[key],c);
  END LOOP;
  RETURN result;
END $$;
CREATE FUNCTION app.guard_neighborhood_selected_statistics_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; seventh app.neighborhood_custom_cohort_selected_metrics_v2_heads%ROWTYPE;
  member app.neighborhood_custom_cohort_selected_metrics_v2_rows%ROWTYPE; stored_row app.neighborhood_custom_cohort_selected_statistics_v2_rows%ROWTYPE;
  parent jsonb; body jsonb; prior jsonb; row_body jsonb; metric_body jsonb; before_state jsonb; after_state jsonb;
  before_counts jsonb; after_counts jsonb; actual_entry jsonb; cell jsonb; old_cell jsonb; key text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_statistics_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT seventh FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR NEW.command_id<>seventh.command_id OR NEW.union_reference IS DISTINCT FROM seventh.union_reference
    OR NEW.eligibility_reference IS DISTINCT FROM seventh.eligibility_reference OR NEW.evidence_reference IS DISTINCT FROM seventh.evidence_reference
    OR NEW.metrics_reference IS DISTINCT FROM seventh.receipt_reference
    OR NOT app.neighborhood_selected_statistics_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT parent FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
    AND content_sha256=seventh.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=seventh.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF TG_OP='INSERT' THEN
    IF NOT app.neighborhood_selected_metrics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    before_state:=jsonb_build_object('selected_ordinal',0,'done',false);
    before_counts:=app.neighborhood_selected_statistics_v2_next_counts(NULL,NULL);
  ELSE
    IF NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
      OR (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
      OR NEW.sequence<>OLD.sequence+1 THEN RAISE EXCEPTION 'neighborhood_selected_statistics_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
      AND content_sha256=OLD.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF prior->>'format' IS DISTINCT FROM 'cohort_selected_statistics_receipt_v2'
      OR prior->>'sequence' IS DISTINCT FROM OLD.sequence::text OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
    before_state:=prior->'after';before_counts:=prior->'after_counts';
  END IF;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
    AND content_sha256=NEW.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF body->>'format' IS DISTINCT FROM 'cohort_selected_statistics_receipt_v2'
    OR body->>'policy' IS DISTINCT FROM 'current_reported_complete_matching_recorded_housing_one_selected_account_v2'
    OR (SELECT count(*) FROM jsonb_object_keys(body))<>16
    OR (body-ARRAY['format','policy','union_reference','eligibility_reference','evidence_reference','metrics_reference','command_id','selected_stock_count',
      'sequence','previous','before','after','selected_entry','row_reference','before_counts','after_counts'])<>'{}'::jsonb
    OR body->>'command_id' IS DISTINCT FROM NEW.command_id::text OR body->'union_reference' IS DISTINCT FROM NEW.union_reference
    OR body->'eligibility_reference' IS DISTINCT FROM NEW.eligibility_reference OR body->'evidence_reference' IS DISTINCT FROM NEW.evidence_reference
    OR body->'metrics_reference' IS DISTINCT FROM NEW.metrics_reference OR body->'selected_stock_count' IS DISTINCT FROM parent->'selected_stock_count'
    OR body->>'sequence' IS DISTINCT FROM NEW.sequence::text OR NEW.sequence<>(before_state->>'selected_ordinal')::integer+1
    OR body->'before' IS DISTINCT FROM before_state OR body->'before_counts' IS DISTINCT FROM before_counts
    OR (TG_OP='INSERT' AND (NEW.sequence<>1 OR body->'previous' IS DISTINCT FROM 'null'::jsonb))
    OR (TG_OP='UPDATE' AND body->'previous' IS DISTINCT FROM OLD.receipt_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO member FROM app.neighborhood_custom_cohort_selected_metrics_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  after_state:=jsonb_build_object('selected_ordinal',(before_state->>'selected_ordinal')::integer+CASE WHEN member.account_id IS NULL THEN 0 ELSE 1 END,'done',member.account_id IS NULL);
  after_counts:=before_counts;
  IF member.account_id IS NULL THEN
    IF body->'selected_entry' IS DISTINCT FROM 'null'::jsonb OR body->'row_reference' IS DISTINCT FROM 'null'::jsonb
      OR after_state->'selected_ordinal' IS DISTINCT FROM parent->'selected_stock_count'
      OR (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id)<>(parent->>'selected_stock_count')::integer THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_complete_union_conflict' USING ERRCODE='55000'; END IF;
    FOREACH key IN ARRAY ARRAY['reported_year_built','reported_residential_area','reported_site_area'] LOOP
      IF before_counts->key->'eligible_count' IS DISTINCT FROM parent->'after_counts'->key THEN
        RAISE EXCEPTION 'neighborhood_selected_statistics_v2_eligibility_conflict' USING ERRCODE='55000'; END IF;
    END LOOP;
  ELSE
    actual_entry:=jsonb_build_object('account_id',member.account_id,'ordinal',member.ordinal,'partition_ordinal',member.partition_ordinal,'entry_reference',member.entry_reference);
    SELECT * INTO STRICT stored_row FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
    IF stored_row.account_id<>member.account_id OR stored_row.partition_ordinal<>member.partition_ordinal OR stored_row.entry_reference IS DISTINCT FROM member.entry_reference
      OR stored_row.metric_row_reference IS DISTINCT FROM member.row_reference OR stored_row.row_reference IS DISTINCT FROM body->'row_reference'
      OR body->'selected_entry' IS DISTINCT FROM actual_entry THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_member_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT row_body FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
      AND content_sha256=stored_row.row_reference->>'content_sha256' AND canonical_utf8_bytes::text=stored_row.row_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
    SELECT canonical_utf8::jsonb INTO STRICT metric_body FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
      AND content_sha256=member.row_reference->>'content_sha256' AND canonical_utf8_bytes::text=member.row_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
    IF row_body->>'format' IS DISTINCT FROM 'cohort_selected_statistics_contribution_v2' OR (SELECT count(*) FROM jsonb_object_keys(row_body))<>17
      OR row_body->>'policy' IS DISTINCT FROM body->>'policy' OR row_body->'metrics_reference' IS DISTINCT FROM NEW.metrics_reference
      OR row_body->'metric_row_reference' IS DISTINCT FROM member.row_reference
      OR (row_body-ARRAY['format','policy','metrics_reference','metric_row_reference','metrics','count_basis','statistics','publication'])
        IS DISTINCT FROM (metric_body-ARRAY['format','metrics','basis'])
      OR row_body->>'count_basis' IS DISTINCT FROM 'one_native_selected_account_per_metric_not_parts_or_overlapping_reasons'
      OR row_body->>'statistics' IS DISTINCT FROM 'not_established' OR row_body->>'publication' IS DISTINCT FROM 'not_established'
      OR jsonb_typeof(row_body->'metrics') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(row_body->'metrics'))<>4
      OR ((row_body->'metrics')-ARRAY['reported_year_built','reported_residential_area','reported_site_area','reported_market_value'])<>'{}'::jsonb THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_row_conflict' USING ERRCODE='55000'; END IF;
    FOREACH key IN ARRAY ARRAY['reported_year_built','reported_residential_area','reported_site_area','reported_market_value'] LOOP
      cell:=row_body->'metrics'->key;old_cell:=metric_body->'metrics'->key;
      IF cell->'recorded_comparison_eligible' IS DISTINCT FROM old_cell->'recorded_comparison_eligible'
        OR cell->'complete_observed_parts' IS DISTINCT FROM old_cell->'complete_observed_parts'
        OR cell->'contribution_exact_value' IS DISTINCT FROM (CASE WHEN old_cell->>'recorded_comparison_eligible'='true' THEN old_cell->'exact_value' ELSE 'null'::jsonb END)
        OR cell->'contribution_unit' IS DISTINCT FROM (CASE WHEN old_cell->>'recorded_comparison_eligible'='true' THEN old_cell->'unit' ELSE 'null'::jsonb END) THEN
        RAISE EXCEPTION 'neighborhood_selected_statistics_v2_cell_conflict' USING ERRCODE='55000'; END IF;
    END LOOP;
    after_counts:=app.neighborhood_selected_statistics_v2_next_counts(before_counts,row_body->'metrics');
  END IF;
  IF body->'after' IS DISTINCT FROM after_state OR body->'after_counts' IS DISTINCT FROM after_counts THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_prefix_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_statistics_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_statistics_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_statistics_v2_head();
CREATE TRIGGER neighborhood_selected_statistics_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_statistics_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.check_neighborhood_selected_statistics_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR c.phase<>'frozen_selected_statistics_refs_v2' OR c.progress_reference<>head.receipt_reference
    OR c.issued_attempts<>job.attempts OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry'
    OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_orphan_progress' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_statistics_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_statistics_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_statistics_v2_commit();

CREATE FUNCTION app.guard_neighborhood_selected_statistics_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; h app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE; prior jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_selected_statistics_v2_row_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR NEW.ordinal<>coalesce(h.sequence,0)+1
    OR NOT app.neighborhood_selected_statistics_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_metrics_v2_rows u
      WHERE u.operation_id=NEW.operation_id AND u.organization_id=NEW.organization_id AND u.ordinal=NEW.ordinal
        AND u.account_id=NEW.account_id AND u.partition_ordinal=NEW.partition_ordinal AND u.entry_reference=NEW.entry_reference
        AND u.row_reference=NEW.metric_row_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_row_conflict' USING ERRCODE='55000'; END IF;
  IF h.operation_id IS NOT NULL THEN
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_statistics_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_statistics_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_statistics_v2_rows FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_statistics_v2_row();
CREATE TRIGGER neighborhood_selected_statistics_v2_row_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_statistics_v2_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE FUNCTION app.check_neighborhood_selected_statistics_v2_row_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF h.sequence<>NEW.ordinal OR body->'row_reference' IS DISTINCT FROM NEW.row_reference THEN
    RAISE EXCEPTION 'neighborhood_selected_statistics_v2_orphan_row' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_statistics_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_statistics_v2_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_statistics_v2_row_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_statistics_v2_rows IS
  'INACTIVE bounded original-reconciled contribution states/counts only; no original/typed/diagnostic copies. Native ordinal/closed row/parent/date/subject/eligibility/head/checkpoint/continuation guards are structural, NOT source authority. Actual bounded current-authorized owner must independently reopen EVERY whole original/ENTIRE cache/full issued graph with both-end rights before each atomic write. No frequency/distribution is established. Later exact-statistics owner must independently reopen originals again; no license/live/speed/GLA/currency/publication authority.';


-- Add only monotonic thirteen-to-fourteen and fourteen-to-fourteen transitions.
CREATE OR REPLACE FUNCTION app.guard_neighborhood_cohort_v2_selection_wait() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_recorded_catalog_v2_heads%ROWTYPE; receipt jsonb;
  command app.neighborhood_custom_cohort_v2_selection_intents%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.status='awaiting_selection' OR (OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2')) THEN
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
        AND NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(OLD.operation_id,OLD.organization_id,NEW.checkpoint))
      OR (OLD.checkpoint->>'phase'='frozen_selected_union_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_eligibility_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_evidence_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_metrics_refs_v2' AND NEW.checkpoint->>'phase' NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (OLD.checkpoint->>'phase'='frozen_selected_statistics_refs_v2' AND NEW.checkpoint->>'phase'<>'frozen_selected_statistics_refs_v2')
      OR NEW.attempts<OLD.attempts
      OR NEW.context_sha256 IS NOT NULL OR NEW.status IN ('succeeded','awaiting_selection') THEN
      RAISE EXCEPTION 'neighborhood_v2_selection_intent_job_conflict' USING ERRCODE='55000'; END IF;
    IF OLD.status='awaiting_selection' AND NEW.status='running' AND NEW.claim_token=command.resume_claim_token
      AND NEW.attempts=command.issued_attempts AND NEW.lease_expires_at>clock_timestamp()
      AND NEW.lease_expires_at<=clock_timestamp()+interval '120 seconds' AND NEW.cancellation_requested_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['status','claim_token','lease_expires_at','updated_at'])
        IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','claim_token','lease_expires_at','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF OLD.status='cancelled' AND OLD.checkpoint->>'phase' IN ('frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2') THEN
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
    CHECK(sequence BETWEEN 1 AND 16000008),
  ADD CONSTRAINT neighborhood_custom_cohort_v2_continuations_phase_check
    CHECK(phase IN ('frozen_stock_traversal_refs_v2','frozen_recorded_partition_refs_v2','frozen_recorded_catalog_refs_v2','frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'));

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
  ELSIF NEW.phase='frozen_selected_evidence_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_evidence_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_metrics_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_metrics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  ELSIF NEW.phase='frozen_selected_statistics_refs_v2' THEN
    SELECT receipt_reference,sequence INTO STRICT actual_reference,actual_sequence
      FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF NOT app.neighborhood_selected_statistics_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
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
    IF NEW.sequence<>1 OR (NEW.phase IN ('frozen_selected_union_refs_v2','frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2') AND NOT EXISTS(
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
      OR (OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (NEW.phase='frozen_selected_evidence_refs_v2' AND OLD.phase NOT IN ('frozen_selected_eligibility_refs_v2','frozen_selected_evidence_refs_v2'))
      OR (OLD.phase='frozen_selected_eligibility_refs_v2' AND NEW.phase='frozen_selected_evidence_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_evidence_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.eligibility_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (NEW.phase='frozen_selected_metrics_refs_v2' AND OLD.phase NOT IN ('frozen_selected_evidence_refs_v2','frozen_selected_metrics_refs_v2'))
      OR (OLD.phase='frozen_selected_evidence_refs_v2' AND NEW.phase='frozen_selected_metrics_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_metrics_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.evidence_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (NEW.phase='frozen_selected_statistics_refs_v2' AND OLD.phase NOT IN ('frozen_selected_metrics_refs_v2','frozen_selected_statistics_refs_v2'))
      OR (OLD.phase='frozen_selected_metrics_refs_v2' AND NEW.phase='frozen_selected_statistics_refs_v2'
        AND (actual_sequence<>1 OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads h
          WHERE h.operation_id=NEW.operation_id AND h.organization_id=NEW.organization_id AND h.metrics_reference=OLD.progress_reference)))
      OR (OLD.phase='frozen_selected_statistics_refs_v2' AND NEW.phase<>'frozen_selected_statistics_refs_v2') THEN
      RAISE EXCEPTION 'neighborhood_v2_continuation_transition_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
