-- INACTIVE tenth durable semantic pass. Reference-only members and bounded derived
-- aggregates; the actual complete-original owner remains mandatory. No activation,
-- grants, source/payload copies, backfill, attempt reset, or old-reader widening.
CREATE TABLE app.neighborhood_custom_cohort_selected_semantic_v2_rows (
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
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_numeric_index_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_numeric_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_semantic_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  union_reference jsonb NOT NULL CHECK(octet_length(union_reference::text) BETWEEN 100 AND 256),
  eligibility_reference jsonb NOT NULL CHECK(octet_length(eligibility_reference::text) BETWEEN 100 AND 256),
  evidence_reference jsonb NOT NULL CHECK(octet_length(evidence_reference::text) BETWEEN 100 AND 256),
  metrics_reference jsonb NOT NULL CHECK(octet_length(metrics_reference::text) BETWEEN 100 AND 256),
  statistics_reference jsonb NOT NULL CHECK(octet_length(statistics_reference::text) BETWEEN 100 AND 256),
  numeric_reference jsonb NOT NULL CHECK(octet_length(numeric_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001)
);

-- Exact16 recursively retains the complete exact15 graph and immutable ninth
-- fresh EMPTY. Older checkpoint functions remain byte-for-byte untouched.
CREATE FUNCTION app.neighborhood_selected_semantic_v2_checkpoint_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads h
 JOIN app.neighborhood_custom_cohort_selected_numeric_v2_heads n USING(operation_id,organization_id)
 JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=n.organization_id
  AND b.content_sha256=n.receipt_reference->>'content_sha256' AND b.canonical_utf8_bytes::text=n.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
 WHERE h.operation_id=op AND h.organization_id=org AND h.command_id=n.command_id
  AND h.union_reference=n.union_reference AND h.eligibility_reference=n.eligibility_reference AND h.evidence_reference=n.evidence_reference
  AND h.metrics_reference=n.metrics_reference AND h.statistics_reference=n.statistics_reference AND h.numeric_reference=n.receipt_reference
  AND cp->>'phase'='frozen_selected_semantic_refs_v2' AND jsonb_array_length(cp->'evidence_refs')=16
  AND (cp-'phase'-'evidence_refs')='{}'::jsonb AND cp->'evidence_refs'->15=h.receipt_reference
  AND app.neighborhood_selected_numeric_v2_checkpoint_matches(op,org,jsonb_build_object('phase','frozen_selected_numeric_refs_v2','evidence_refs',(cp->'evidence_refs')-15))
  AND b.canonical_utf8::jsonb->>'format'='cohort_selected_numeric_receipt_v2'
  AND b.canonical_utf8::jsonb->>'sequence'=n.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'),false)
$$;
CREATE FUNCTION app.neighborhood_selected_semantic_v2_admission_matches(op uuid,org uuid,cp jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads n
 JOIN app.neighborhood_cohort_evidence_blobs b ON b.organization_id=n.organization_id
  AND b.content_sha256=n.receipt_reference->>'content_sha256' AND b.canonical_utf8_bytes::text=n.receipt_reference->>'canonical_utf8_bytes' AND b.canonical_utf8_bytes<=4096
 WHERE n.operation_id=op AND n.organization_id=org
  AND b.canonical_utf8::jsonb->>'format'='cohort_selected_numeric_receipt_v2'
  AND b.canonical_utf8::jsonb->>'sequence'=n.sequence::text AND b.canonical_utf8::jsonb->'after'->>'done'='true'
  AND ((app.neighborhood_selected_numeric_v2_checkpoint_matches(op,org,cp) AND NOT EXISTS(
   SELECT 1 FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads h WHERE h.operation_id=op))
   OR app.neighborhood_selected_semantic_v2_checkpoint_matches(op,org,cp))),false)
$$;

-- Only three bounded provisional rank rows; computed ONCE at the initial tenth
-- head, never reranked per account. Each later original replay validates the
-- complete ninth/index membership independently. Native structure is NOT rights.
CREATE FUNCTION app.neighborhood_selected_semantic_v2_initial_ranks(op uuid,org uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH members AS MATERIALIZED (
  SELECT n.ordinal,i.reported_year_built,i.reported_residential_area,i.reported_site_area
  FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows n
  JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i USING(operation_id,organization_id,ordinal,account_id)
  WHERE n.operation_id=op AND n.organization_id=org AND i.contribution_row_reference=n.contribution_row_reference
 ), totals AS (SELECT count(*) AS selected_count,count(reported_year_built) AS a,count(reported_residential_area) AS b,count(reported_site_area) AS c FROM members), ranked AS (
  SELECT 'reported_year_built' AS metric,0 AS metric_order,reported_year_built AS value,row_number() OVER(ORDER BY reported_year_built,ordinal) AS rank FROM members WHERE reported_year_built IS NOT NULL
 UNION ALL
 SELECT 'reported_residential_area' AS metric,1 AS metric_order,reported_residential_area AS value,row_number() OVER(ORDER BY reported_residential_area,ordinal) AS rank FROM members WHERE reported_residential_area IS NOT NULL
 UNION ALL
 SELECT 'reported_site_area' AS metric,2 AS metric_order,reported_site_area AS value,row_number() OVER(ORDER BY reported_site_area,ordinal) AS rank FROM members WHERE reported_site_area IS NOT NULL
 ), names AS (SELECT metric,metric_order,t.selected_count,CASE metric_order WHEN 0 THEN t.a WHEN 1 THEN t.b ELSE t.c END AS observed_count
 FROM totals t CROSS JOIN (VALUES ('reported_year_built',0),('reported_residential_area',1),('reported_site_area',2)) AS n(metric,metric_order)), result AS (
 SELECT names.metric_order,names.metric,names.selected_count::text,names.observed_count::text,
 min(r.value)::text AS low,max(r.value)::text AS high,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*1/4)::text AS q1_lower,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*1/4+CASE WHEN ((names.observed_count-1)*1)%4=0 THEN 0 ELSE 1 END)::text AS q1_upper,
 CASE WHEN names.observed_count=0 THEN 0 ELSE ((names.observed_count-1)*1)%4 END::integer AS q1_remainder,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*2/4)::text AS median_lower,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*2/4+CASE WHEN ((names.observed_count-1)*2)%4=0 THEN 0 ELSE 1 END)::text AS median_upper,
 CASE WHEN names.observed_count=0 THEN 0 ELSE ((names.observed_count-1)*2)%4 END::integer AS median_remainder,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*3/4)::text AS q3_lower,
 max(r.value) FILTER(WHERE r.rank=1+(names.observed_count-1)*3/4+CASE WHEN ((names.observed_count-1)*3)%4=0 THEN 0 ELSE 1 END)::text AS q3_upper,
 CASE WHEN names.observed_count=0 THEN 0 ELSE ((names.observed_count-1)*3)%4 END::integer AS q3_remainder
 FROM names LEFT JOIN ranked r ON r.metric=names.metric AND r.metric_order=names.metric_order
 GROUP BY names.metric,names.metric_order,names.selected_count,names.observed_count)
 SELECT jsonb_agg(to_jsonb(result)-'metric_order' ORDER BY metric_order) FROM result
$$;

CREATE FUNCTION app.guard_neighborhood_selected_semantic_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_selected_semantic_v2_heads%ROWTYPE; prior jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_selected_semantic_v2_row_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO h FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR NEW.ordinal<>coalesce(h.sequence,0)+1
    OR NOT app.neighborhood_selected_semantic_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows m
      JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
        AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal
        AND n.entry_reference=m.entry_reference AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
      JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i ON i.operation_id=m.operation_id AND i.organization_id=m.organization_id
        AND i.ordinal=m.ordinal AND i.account_id=m.account_id
      WHERE m.operation_id=NEW.operation_id AND m.organization_id=NEW.organization_id AND m.ordinal=NEW.ordinal
        AND m.account_id=NEW.account_id AND m.partition_ordinal=NEW.partition_ordinal AND m.entry_reference=NEW.entry_reference
        AND m.metric_row_reference=NEW.metric_row_reference AND m.row_reference=NEW.contribution_row_reference
        AND i.contribution_row_reference=m.row_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_semantic_v2_row_conflict' USING ERRCODE='55000'; END IF;
  IF h.operation_id IS NOT NULL THEN
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
    IF prior->>'format' IS DISTINCT FROM 'cohort_selected_semantic_receipt_v2' OR prior->>'sequence' IS DISTINCT FROM h.sequence::text
      OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'neighborhood_selected_semantic_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_semantic_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_semantic_v2_rows FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_semantic_v2_row();
CREATE TRIGGER neighborhood_selected_semantic_v2_row_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_semantic_v2_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.guard_neighborhood_selected_semantic_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
 n app.neighborhood_custom_cohort_selected_numeric_v2_heads%ROWTYPE;
 m app.neighborhood_custom_cohort_selected_numeric_v2_rows%ROWTYPE;
 retained app.neighborhood_custom_cohort_selected_semantic_v2_rows%ROWTYPE;
 body jsonb; prior jsonb; summary jsonb; previous_summary jsonb; parent jsonb; contribution jsonb;
 before_state jsonb; after_state jsonb; before_counts jsonb; after_counts jsonb; actual_entry jsonb;
 expected_ranks jsonb; expected_totals jsonb:='{}'::jsonb; t jsonb; r jsonb; key text; idx integer:=0;
 value numeric; median numeric; old_sum numeric; old_deviation numeric; observations integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_selected_semantic_v2_immutable' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
 SELECT * INTO STRICT n FROM app.neighborhood_custom_cohort_selected_numeric_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
 IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL OR job.lease_expires_at<=clock_timestamp()
  OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL OR NEW.command_id<>n.command_id
  OR NEW.union_reference IS DISTINCT FROM n.union_reference OR NEW.eligibility_reference IS DISTINCT FROM n.eligibility_reference
  OR NEW.evidence_reference IS DISTINCT FROM n.evidence_reference OR NEW.metrics_reference IS DISTINCT FROM n.metrics_reference
  OR NEW.statistics_reference IS DISTINCT FROM n.statistics_reference OR NEW.numeric_reference IS DISTINCT FROM n.receipt_reference
  OR NOT app.neighborhood_selected_semantic_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
  RAISE EXCEPTION 'neighborhood_selected_semantic_v2_binding_conflict' USING ERRCODE='55000'; END IF;
 SELECT canonical_utf8::jsonb INTO STRICT parent FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
  AND content_sha256=n.statistics_reference->>'content_sha256' AND canonical_utf8_bytes::text=n.statistics_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
 IF TG_OP='INSERT' THEN
  IF NEW.sequence<>1 OR NOT app.neighborhood_selected_numeric_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
   RAISE EXCEPTION 'neighborhood_selected_semantic_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  before_state:=jsonb_build_object('selected_ordinal',0,'done',false);
  before_counts:=app.neighborhood_selected_statistics_v2_next_counts(NULL,NULL);
  expected_ranks:=app.neighborhood_selected_semantic_v2_initial_ranks(NEW.operation_id,NEW.organization_id);
 ELSE
  IF NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
   OR (to_jsonb(NEW)-ARRAY['receipt_reference','sequence']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence'])
   OR NEW.sequence<>OLD.sequence+1 THEN RAISE EXCEPTION 'neighborhood_selected_semantic_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
   AND content_sha256=OLD.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=OLD.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF prior->>'format' IS DISTINCT FROM 'cohort_selected_semantic_receipt_v2' OR prior->>'sequence' IS DISTINCT FROM OLD.sequence::text
   OR prior->'after'->>'done' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'neighborhood_selected_semantic_v2_finished_or_corrupt' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT previous_summary FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
   AND content_sha256=prior->'after_summary_reference'->>'content_sha256'
   AND canonical_utf8_bytes::text=prior->'after_summary_reference'->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  before_state:=prior->'after';before_counts:=previous_summary->'counts';expected_ranks:=previous_summary->'ranks';
 END IF;
 SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
  AND content_sha256=NEW.receipt_reference->>'content_sha256' AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
 IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR body->>'format' IS DISTINCT FROM 'cohort_selected_semantic_receipt_v2'
  OR (SELECT count(*) FROM jsonb_object_keys(body))<>17
  OR (body-ARRAY['format','union_reference','eligibility_reference','evidence_reference','metrics_reference','statistics_reference','numeric_reference',
    'command_id','selected_stock_count','sequence','previous','before','after','selected_entry','contribution_row_reference','before_summary_reference','after_summary_reference'])<>'{}'::jsonb
  OR body->>'command_id' IS DISTINCT FROM NEW.command_id::text OR body->'union_reference' IS DISTINCT FROM NEW.union_reference
  OR body->'eligibility_reference' IS DISTINCT FROM NEW.eligibility_reference OR body->'evidence_reference' IS DISTINCT FROM NEW.evidence_reference
  OR body->'metrics_reference' IS DISTINCT FROM NEW.metrics_reference OR body->'statistics_reference' IS DISTINCT FROM NEW.statistics_reference
  OR body->'numeric_reference' IS DISTINCT FROM NEW.numeric_reference OR body->'selected_stock_count' IS DISTINCT FROM parent->'selected_stock_count'
  OR body->'sequence' IS DISTINCT FROM to_jsonb(NEW.sequence) OR NEW.sequence<>(before_state->>'selected_ordinal')::integer+1
  OR body->'before' IS DISTINCT FROM before_state
  OR (TG_OP='INSERT' AND (body->'previous' IS DISTINCT FROM 'null'::jsonb OR body->'before_summary_reference' IS DISTINCT FROM 'null'::jsonb))
  OR (TG_OP='UPDATE' AND (body->'previous' IS DISTINCT FROM OLD.receipt_reference OR body->'before_summary_reference' IS DISTINCT FROM prior->'after_summary_reference')) THEN
  RAISE EXCEPTION 'neighborhood_selected_semantic_v2_transition_conflict' USING ERRCODE='55000'; END IF;
 SELECT canonical_utf8::jsonb INTO STRICT summary FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
  AND content_sha256=body->'after_summary_reference'->>'content_sha256'
  AND canonical_utf8_bytes::text=body->'after_summary_reference'->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
 IF summary->>'format' IS DISTINCT FROM 'cohort_selected_semantic_summary_v2' OR jsonb_typeof(summary) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(summary))<>4 OR (summary-ARRAY['format','ranks','counts','totals'])<>'{}'::jsonb
  OR summary->'ranks' IS DISTINCT FROM expected_ranks THEN
  RAISE EXCEPTION 'neighborhood_selected_semantic_v2_summary_conflict' USING ERRCODE='55000'; END IF;
 SELECT * INTO m FROM app.neighborhood_custom_cohort_selected_numeric_v2_rows
  WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
 after_state:=jsonb_build_object('selected_ordinal',(before_state->>'selected_ordinal')::integer+CASE WHEN m.account_id IS NULL THEN 0 ELSE 1 END,'done',m.account_id IS NULL);
 IF m.account_id IS NULL THEN
  IF body->'selected_entry' IS DISTINCT FROM 'null'::jsonb OR body->'contribution_row_reference' IS DISTINCT FROM 'null'::jsonb
   OR after_state->'selected_ordinal' IS DISTINCT FROM parent->'selected_stock_count'
   OR (SELECT count(*) FROM app.neighborhood_custom_cohort_selected_semantic_v2_rows WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id)<>(parent->>'selected_stock_count')::integer
   OR before_counts IS DISTINCT FROM parent->'after_counts' THEN
   RAISE EXCEPTION 'neighborhood_selected_semantic_v2_complete_union_conflict' USING ERRCODE='55000'; END IF;
  after_counts:=before_counts;
 ELSE
  actual_entry:=jsonb_build_object('account_id',m.account_id,'ordinal',m.ordinal,'partition_ordinal',m.partition_ordinal,'entry_reference',m.entry_reference);
  SELECT * INTO STRICT retained FROM app.neighborhood_custom_cohort_selected_semantic_v2_rows
   WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence;
  IF retained.account_id<>m.account_id OR retained.partition_ordinal<>m.partition_ordinal OR retained.entry_reference IS DISTINCT FROM m.entry_reference
   OR retained.metric_row_reference IS DISTINCT FROM m.metric_row_reference OR retained.contribution_row_reference IS DISTINCT FROM m.contribution_row_reference
   OR body->'contribution_row_reference' IS DISTINCT FROM m.contribution_row_reference OR body->'selected_entry' IS DISTINCT FROM actual_entry THEN
   RAISE EXCEPTION 'neighborhood_selected_semantic_v2_member_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT contribution FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=NEW.organization_id
   AND content_sha256=m.contribution_row_reference->>'content_sha256'
   AND canonical_utf8_bytes::text=m.contribution_row_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  after_counts:=app.neighborhood_selected_statistics_v2_next_counts(before_counts,contribution->'metrics');
 END IF;
 FOREACH key IN ARRAY ARRAY['reported_year_built','reported_residential_area','reported_site_area'] LOOP
  r:=expected_ranks->idx;t:=previous_summary->'totals'->key;
  observations:=coalesce((t->>'observed_count')::integer,0);old_sum:=coalesce((t->>'sum_scaled14')::numeric,0);
  old_deviation:=coalesce((t->>'absolute_deviation_scaled14')::numeric,0);
  value:=(contribution->'metrics'->key->>'contribution_exact_value')::numeric;
  IF value IS NOT NULL THEN
   median:=(r->>'median_lower')::numeric*100000000000000+( (r->>'median_upper')::numeric-(r->>'median_lower')::numeric)*100000000000000*(r->>'median_remainder')::integer/4;
   IF median IS NULL THEN RAISE EXCEPTION 'neighborhood_selected_semantic_v2_rank_conflict' USING ERRCODE='55000'; END IF;
   observations:=observations+1;old_sum:=old_sum+value*100000000000000;
   old_deviation:=old_deviation+abs(value*100000000000000-median);
  END IF;
  IF observations<>(after_counts->key->>'eligible_count')::integer OR observations>(r->>'observed_count')::integer
   OR (m.account_id IS NULL AND observations<>(r->>'observed_count')::integer) THEN
   RAISE EXCEPTION 'neighborhood_selected_semantic_v2_count_conflict' USING ERRCODE='55000'; END IF;
  expected_totals:=expected_totals||jsonb_build_object(key,jsonb_build_object('observed_count',observations,
   'sum_scaled14',trunc(old_sum)::text,'absolute_deviation_scaled14',trunc(old_deviation)::text));idx:=idx+1;
 END LOOP;
 IF body->'after' IS DISTINCT FROM after_state OR summary->'counts' IS DISTINCT FROM after_counts OR summary->'totals' IS DISTINCT FROM expected_totals THEN
  RAISE EXCEPTION 'neighborhood_selected_semantic_v2_aggregate_conflict' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_semantic_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_semantic_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_semantic_v2_head();
CREATE TRIGGER neighborhood_selected_semantic_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_selected_semantic_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.check_neighborhood_selected_semantic_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_semantic_v2_heads%ROWTYPE;
  job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; c app.neighborhood_custom_cohort_v2_continuations%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT c FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=NEW.operation_id;
  IF NOT app.neighborhood_selected_semantic_v2_checkpoint_matches(NEW.operation_id,NEW.organization_id,job.checkpoint)
    OR c.phase<>'frozen_selected_semantic_refs_v2' OR c.progress_reference<>h.receipt_reference
    OR c.issued_attempts<>job.attempts OR c.consumed_claim_token IS NOT NULL OR job.status<>'retry'
    OR job.claim_token IS NOT NULL OR job.lease_expires_at IS NOT NULL OR job.context_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_selected_semantic_v2_orphan_progress' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_semantic_v2_head_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_semantic_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_semantic_v2_commit();
CREATE FUNCTION app.check_neighborhood_selected_semantic_v2_row_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_selected_semantic_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_selected_semantic_v2_heads WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF h.sequence<>NEW.ordinal OR body->'contribution_row_reference' IS DISTINCT FROM NEW.contribution_row_reference
    OR body->'selected_entry' IS DISTINCT FROM jsonb_build_object('account_id',NEW.account_id,'ordinal',NEW.ordinal,
      'partition_ordinal',NEW.partition_ordinal,'entry_reference',NEW.entry_reference) THEN
    RAISE EXCEPTION 'neighborhood_selected_semantic_v2_orphan_row' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_semantic_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_semantic_v2_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_semantic_v2_row_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_selected_semantic_v2_rows IS
 'INACTIVE tenth reference-only full semantic reconciliation ledger. Exact16 complete graph; fixed native next ordinal; fresh originals and current+ending authority mandatory; bounded derived exact ranks/sums/deviations and independent all-state counters. Native structure alone is not source authority, coherent publication, licensed acquisition or production-speed acceptance.';

