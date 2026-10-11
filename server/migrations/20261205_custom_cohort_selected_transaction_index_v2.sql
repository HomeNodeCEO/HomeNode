-- INACTIVE storage foundation, NOT an issued eleventh owner/phase. The native
-- cursor and original keys are provisional structural evidence, never source
-- rights or actor/assignment/draft/subject authority. Every durable COMMIT is
-- deliberately refused until a later coherent actual-owner/continuation change.
-- No grants, activation, backfill, source payloads, old-reader widening or reset.
CREATE TABLE app.neighborhood_custom_cohort_selected_transaction_index_v2_rows (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  partition_ordinal integer NOT NULL CHECK(partition_ordinal BETWEEN 1 AND 2000000),
  entry_reference jsonb NOT NULL CHECK(octet_length(entry_reference::text) BETWEEN 100 AND 256),
  metric_row_reference jsonb NOT NULL CHECK(octet_length(metric_row_reference::text) BETWEEN 100 AND 256),
  contribution_row_reference jsonb NOT NULL CHECK(octet_length(contribution_row_reference::text) BETWEEN 100 AND 256),
  PRIMARY KEY(operation_id,ordinal), UNIQUE(operation_id,account_id),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_semantic_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_transaction_source_v2_keys (
  operation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  source_record_id bigint NOT NULL CHECK(source_record_id>0),
  first_selected_ordinal integer NOT NULL CHECK(first_selected_ordinal BETWEEN 1 AND 2000000),
  PRIMARY KEY(operation_id,source_record_id),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,first_selected_ordinal) REFERENCES app.neighborhood_custom_cohort_selected_transaction_index_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
  -- No source-target FK: it must not silently omit a dangling original ID.
  -- The whole original recompiler must independently refuse dangling packages.
);
CREATE TABLE app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys (
  operation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  legacy_sale_key text COLLATE "C" NOT NULL CHECK(legacy_sale_key ~ '^[1-9][0-9]{0,18}$' AND legacy_sale_key::numeric<=9223372036854775807),
  first_selected_ordinal integer NOT NULL CHECK(first_selected_ordinal BETWEEN 1 AND 2000000),
  PRIMARY KEY(operation_id,legacy_sale_key),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,first_selected_ordinal) REFERENCES app.neighborhood_custom_cohort_selected_transaction_index_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_transaction_index_v2_edges (
  operation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  kind text COLLATE "C" NOT NULL CHECK(kind IN ('source_record','legacy_sale')),
  source_record_id bigint,
  legacy_sale_key text COLLATE "C",
  native_key text COLLATE "C" GENERATED ALWAYS AS (coalesce(source_record_id::text,legacy_sale_key)) STORED,
  CHECK((kind='source_record' AND source_record_id>0 AND legacy_sale_key IS NULL)
    OR (kind='legacy_sale' AND source_record_id IS NULL AND legacy_sale_key IS NOT NULL)),
  PRIMARY KEY(operation_id,ordinal,kind,native_key),
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_transaction_index_v2_rows(operation_id,ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,source_record_id) REFERENCES app.neighborhood_custom_cohort_selected_transaction_source_v2_keys(operation_id,source_record_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,legacy_sale_key) REFERENCES app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys(operation_id,legacy_sale_key) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_selected_transaction_index_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  generation_id uuid NOT NULL,
  command_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_v2_selection_intents(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  union_reference jsonb NOT NULL CHECK(octet_length(union_reference::text) BETWEEN 100 AND 256),
  eligibility_reference jsonb NOT NULL CHECK(octet_length(eligibility_reference::text) BETWEEN 100 AND 256),
  evidence_reference jsonb NOT NULL CHECK(octet_length(evidence_reference::text) BETWEEN 100 AND 256),
  metrics_reference jsonb NOT NULL CHECK(octet_length(metrics_reference::text) BETWEEN 100 AND 256),
  statistics_reference jsonb NOT NULL CHECK(octet_length(statistics_reference::text) BETWEEN 100 AND 256),
  numeric_reference jsonb NOT NULL CHECK(octet_length(numeric_reference::text) BETWEEN 100 AND 256),
  semantic_reference jsonb NOT NULL CHECK(octet_length(semantic_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001),
  issued_transaction_id bigint NOT NULL CHECK(issued_transaction_id>0),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_selected_transaction_source_v2_first_idx
  ON app.neighborhood_custom_cohort_selected_transaction_source_v2_keys(operation_id,first_selected_ordinal,source_record_id);
CREATE INDEX neighborhood_selected_transaction_legacy_v2_first_idx
  ON app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys(operation_id,first_selected_ordinal,legacy_sale_key COLLATE "C");

-- Only op/org are inputs. No caller ordinal, generation, keys, roster, counts,
-- callback or DONE flag. The future cursor is owned by the native index head;
-- this foundation cannot issue that head, so only the first step is reachable.
-- These are association anchors, NOT complete transaction payload packages.
CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_next_keys(op uuid,org uuid)
RETURNS TABLE(generation_id uuid,account_id text,ordinal integer,partition_ordinal integer,
  entry_reference jsonb,metric_row_reference jsonb,contribution_row_reference jsonb,
  anchor_count integer,kind text,native_key text)
LANGUAGE sql STABLE AS $$
 WITH selected_context AS MATERIALIZED (
  SELECT stock.generation_id,m.account_id,m.ordinal,m.partition_ordinal,m.entry_reference,m.metric_row_reference,m.row_reference AS contribution_row_reference
  FROM app.neighborhood_custom_cohort_capture_jobs job
  JOIN app.neighborhood_custom_cohort_selected_semantic_v2_heads s USING(operation_id,organization_id)
  JOIN app.neighborhood_cohort_evidence_blobs sb ON sb.organization_id=s.organization_id
   AND sb.content_sha256=s.receipt_reference->>'content_sha256' AND sb.canonical_utf8_bytes::text=s.receipt_reference->>'canonical_utf8_bytes' AND sb.canonical_utf8_bytes<=4096
  JOIN app.neighborhood_custom_cohort_selected_union_v2_heads u ON u.operation_id=job.operation_id AND u.organization_id=job.organization_id
  JOIN app.neighborhood_cohort_evidence_blobs ub ON ub.organization_id=u.organization_id
   AND ub.content_sha256=u.receipt_reference->>'content_sha256' AND ub.canonical_utf8_bytes::text=u.receipt_reference->>'canonical_utf8_bytes' AND ub.canonical_utf8_bytes<=16000
  JOIN app.neighborhood_custom_cohort_job_stocks stock ON stock.operation_id=job.operation_id AND stock.organization_id=job.organization_id
   AND stock.report_file_id=job.report_file_id AND stock.assignment_file_id=job.assignment_file_id AND stock.account_id=job.account_id
   AND stock.actor_user_id=job.actor_user_id AND stock.status='complete'
  JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin ON pin.operation_id=stock.operation_id AND pin.generation_id=stock.generation_id
   AND pin.organization_id=stock.organization_id AND pin.report_file_id=stock.report_file_id AND pin.assignment_file_id=stock.assignment_file_id
   AND pin.account_id=stock.account_id AND pin.actor_user_id=stock.actor_user_id
  JOIN app.neighborhood_group_generations generation ON generation.generation_id=pin.generation_id
   AND generation.status='complete' AND generation.retirement_started_at IS NULL
  LEFT JOIN app.neighborhood_custom_cohort_selected_transaction_index_v2_heads h ON h.operation_id=job.operation_id AND h.organization_id=job.organization_id
  LEFT JOIN app.neighborhood_custom_cohort_selected_statistics_v2_rows m ON m.operation_id=job.operation_id AND m.organization_id=job.organization_id AND m.ordinal=coalesce(h.sequence,0)+1
  LEFT JOIN app.neighborhood_custom_cohort_selected_semantic_v2_rows r ON r.operation_id=m.operation_id AND r.organization_id=m.organization_id
   AND r.ordinal=m.ordinal AND r.account_id=m.account_id AND r.partition_ordinal=m.partition_ordinal AND r.entry_reference=m.entry_reference
   AND r.metric_row_reference=m.metric_row_reference AND r.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_v2_rows n ON n.operation_id=m.operation_id AND n.organization_id=m.organization_id
   AND n.ordinal=m.ordinal AND n.account_id=m.account_id AND n.partition_ordinal=m.partition_ordinal AND n.entry_reference=m.entry_reference
   AND n.metric_row_reference=m.metric_row_reference AND n.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_numeric_index_v2_rows i ON i.operation_id=m.operation_id AND i.organization_id=m.organization_id
   AND i.ordinal=m.ordinal AND i.account_id=m.account_id AND i.contribution_row_reference=m.row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_metrics_v2_rows metric ON metric.operation_id=m.operation_id AND metric.organization_id=m.organization_id
   AND metric.ordinal=m.ordinal AND metric.account_id=m.account_id AND metric.partition_ordinal=m.partition_ordinal
   AND metric.entry_reference=m.entry_reference AND metric.row_reference=m.metric_row_reference
  LEFT JOIN app.neighborhood_custom_cohort_selected_union_v2_rows member ON member.operation_id=metric.operation_id AND member.organization_id=metric.organization_id
   AND member.ordinal=metric.ordinal AND member.account_id=metric.account_id AND member.partition_ordinal=metric.partition_ordinal AND member.entry_reference=metric.entry_reference
  LEFT JOIN app.neighborhood_custom_cohort_recorded_partition_v2_rows p ON p.operation_id=member.operation_id AND p.organization_id=member.organization_id
   AND p.account_id=member.account_id AND p.ordinal=member.partition_ordinal AND p.entry_reference=member.entry_reference
  WHERE job.operation_id=op AND job.organization_id=org AND job.status='running' AND job.claim_token IS NOT NULL
   AND job.lease_expires_at>clock_timestamp() AND job.cancellation_requested_at IS NULL AND job.context_sha256 IS NULL
   AND h.operation_id IS NULL -- no issued eleventh progress in this foundation
   AND app.neighborhood_selected_semantic_v2_checkpoint_matches(op,org,job.checkpoint)
   AND sb.canonical_utf8::jsonb->>'format'='cohort_selected_semantic_receipt_v2' AND sb.canonical_utf8::jsonb->>'sequence'=s.sequence::text
   AND sb.canonical_utf8::jsonb->'after'->>'done'='true'
   AND u.command_id=s.command_id AND u.receipt_reference=s.union_reference
   AND ub.canonical_utf8::jsonb->>'format'='cohort_selected_union_receipt_v2' AND ub.canonical_utf8::jsonb->>'sequence'=u.sequence::text
   AND ub.canonical_utf8::jsonb->'after'->>'done'='true'
   AND ub.canonical_utf8::jsonb->'after_selected_count'=sb.canonical_utf8::jsonb->'after'->'selected_ordinal'
   AND ((ub.canonical_utf8::jsonb->>'after_selected_count'='0' AND m.operation_id IS NULL)
     OR (ub.canonical_utf8::jsonb->>'after_selected_count'<>'0' AND r.ordinal=m.ordinal AND n.ordinal=m.ordinal
       AND i.ordinal=m.ordinal AND metric.ordinal=m.ordinal AND member.ordinal=m.ordinal AND p.account_id=m.account_id))
 ), anchors AS MATERIALIZED (
  SELECT original.kind,original.row_key,original.source_record_id FROM selected_context selected
  CROSS JOIN (VALUES ('source_records'),('sales'),('sale_links')) k(kind)
  CROSS JOIN LATERAL (SELECT o.kind,o.row_key,o.source_record_id FROM app.neighborhood_frozen_source_rows o
   WHERE o.generation_id=selected.generation_id AND o.kind=k.kind AND o.account_id=selected.account_id
   ORDER BY o.row_key COLLATE "C" LIMIT 251) original
 ), gate AS MATERIALIZED (
  SELECT selected.*,(SELECT count(*)::integer FROM anchors) AS anchor_count FROM selected_context selected
 ), packages AS MATERIALIZED (
  SELECT 'source_record'::text AS kind,source_record_id::text AS native_key FROM anchors
   WHERE source_record_id IS NOT NULL AND (SELECT anchor_count FROM gate)<=250 GROUP BY source_record_id
  UNION ALL
  SELECT 'legacy_sale',row_key FROM anchors WHERE kind='sales' AND source_record_id IS NULL AND (SELECT anchor_count FROM gate)<=250
 )
 SELECT gate.*,packages.kind,packages.native_key FROM gate LEFT JOIN packages ON gate.anchor_count<=250
 ORDER BY CASE packages.kind WHEN 'source_record' THEN 0 ELSE 1 END,
  CASE WHEN packages.kind='source_record' THEN packages.native_key::bigint END,
  CASE WHEN packages.kind='legacy_sale' THEN packages.native_key END COLLATE "C"
 LIMIT 251
$$;

-- Exact bidirectional comparison, not ON CONFLICT/count/hash completeness.
-- Current member/new-key deltas are bounded; no full selected-population scan.
CREATE FUNCTION app.neighborhood_selected_transaction_index_v2_next_edges_match(op uuid,org uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH expected AS MATERIALIZED (SELECT * FROM app.neighborhood_selected_transaction_index_v2_next_keys(op,org)),
 header AS MATERIALIZED (SELECT * FROM expected LIMIT 1), retained AS MATERIALIZED (
  SELECT e.* FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_edges e
  JOIN header h ON e.operation_id=op AND e.ordinal=h.ordinal
 )
 SELECT coalesce(EXISTS(SELECT 1 FROM header h WHERE h.anchor_count<=250
  AND ((h.account_id IS NULL AND h.ordinal IS NULL AND h.anchor_count=0 AND NOT EXISTS(
   SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_rows r WHERE r.operation_id=op))
   OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_rows r WHERE r.operation_id=op AND r.organization_id=org
    AND r.generation_id=h.generation_id AND r.ordinal=h.ordinal AND r.account_id=h.account_id AND r.partition_ordinal=h.partition_ordinal
    AND r.entry_reference=h.entry_reference AND r.metric_row_reference=h.metric_row_reference AND r.contribution_row_reference=h.contribution_row_reference))
  AND NOT EXISTS(SELECT 1 FROM expected x WHERE x.kind IS NOT NULL AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.kind=x.kind AND r.native_key=x.native_key))
  AND NOT EXISTS(SELECT 1 FROM retained r WHERE NOT EXISTS(SELECT 1 FROM expected x WHERE x.kind=r.kind AND x.native_key=r.native_key))
  AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.organization_id IS DISTINCT FROM org OR r.generation_id IS DISTINCT FROM h.generation_id OR r.account_id IS DISTINCT FROM h.account_id)
  AND NOT EXISTS(SELECT 1 FROM retained r JOIN app.neighborhood_custom_cohort_selected_transaction_source_v2_keys k
   ON k.operation_id=r.operation_id AND k.source_record_id=r.source_record_id WHERE k.organization_id IS DISTINCT FROM org
    OR k.generation_id IS DISTINCT FROM h.generation_id OR k.first_selected_ordinal>h.ordinal)
  AND NOT EXISTS(SELECT 1 FROM retained r JOIN app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys k
   ON k.operation_id=r.operation_id AND k.legacy_sale_key=r.legacy_sale_key WHERE k.organization_id IS DISTINCT FROM org
    OR k.generation_id IS DISTINCT FROM h.generation_id OR k.first_selected_ordinal>h.ordinal)
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_source_v2_keys k WHERE k.operation_id=op
   AND k.first_selected_ordinal=coalesce(h.ordinal,1) AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.kind='source_record' AND r.source_record_id=k.source_record_id))
  AND NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_transaction_legacy_v2_keys k WHERE k.operation_id=op
   AND k.first_selected_ordinal=coalesce(h.ordinal,1) AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.kind='legacy_sale' AND r.legacy_sale_key=k.legacy_sale_key))),false)
$$;

CREATE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected record; native_kind text; native_value text; member record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_immutable' USING ERRCODE='55000'; END IF;
 -- Serialize provisional inserts on the actual operation. Not authorization.
 PERFORM 1 FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id FOR UPDATE;
 SELECT * INTO expected FROM app.neighborhood_selected_transaction_index_v2_next_keys(NEW.operation_id,NEW.organization_id) LIMIT 1;
 IF NOT FOUND OR expected.account_id IS NULL OR expected.anchor_count>250 OR NEW.generation_id IS DISTINCT FROM expected.generation_id THEN
  RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_native_binding' USING ERRCODE='55000'; END IF;
 IF TG_TABLE_NAME='neighborhood_custom_cohort_selected_transaction_index_v2_rows' THEN
  IF NEW.ordinal IS DISTINCT FROM expected.ordinal OR NEW.account_id IS DISTINCT FROM expected.account_id
   OR NEW.partition_ordinal IS DISTINCT FROM expected.partition_ordinal OR NEW.entry_reference IS DISTINCT FROM expected.entry_reference
   OR NEW.metric_row_reference IS DISTINCT FROM expected.metric_row_reference OR NEW.contribution_row_reference IS DISTINCT FROM expected.contribution_row_reference THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_member_binding' USING ERRCODE='55000'; END IF;
 ELSE
  SELECT * INTO STRICT member FROM app.neighborhood_custom_cohort_selected_transaction_index_v2_rows
   WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND generation_id=NEW.generation_id AND ordinal=expected.ordinal;
  IF TG_TABLE_NAME='neighborhood_custom_cohort_selected_transaction_index_v2_edges' THEN
   IF NEW.ordinal IS DISTINCT FROM member.ordinal OR NEW.account_id IS DISTINCT FROM member.account_id THEN
    RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_edge_binding' USING ERRCODE='55000'; END IF;
   native_kind:=NEW.kind; native_value:=coalesce(NEW.source_record_id::text,NEW.legacy_sale_key);
  ELSE
   IF NEW.first_selected_ordinal IS DISTINCT FROM member.ordinal THEN
    RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_first_seen' USING ERRCODE='55000'; END IF;
   IF TG_TABLE_NAME='neighborhood_custom_cohort_selected_transaction_source_v2_keys' THEN
    native_kind:='source_record'; native_value:=NEW.source_record_id::text;
   ELSE native_kind:='legacy_sale'; native_value:=NEW.legacy_sale_key; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.neighborhood_selected_transaction_index_v2_next_keys(NEW.operation_id,NEW.organization_id) k
    WHERE k.kind=native_kind AND k.native_key=native_value) THEN
   RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_native_key' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Deliberately fail closed: a native key set is NOT full original reconciliation,
-- an exact17 checkpoint, a single-use continuation or current source authority.
-- No successful head or durable child can be issued by this additive migration.
CREATE FUNCTION app.reject_neighborhood_selected_transaction_index_v2_unintegrated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'neighborhood_selected_transaction_index_v2_owner_unintegrated' USING ERRCODE='55000'; END $$;
CREATE TRIGGER neighborhood_selected_transaction_index_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
 ON app.neighborhood_custom_cohort_selected_transaction_index_v2_heads FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_selected_transaction_index_v2_unintegrated();
CREATE TRIGGER neighborhood_selected_transaction_index_v2_head_truncate BEFORE TRUNCATE
 ON app.neighborhood_custom_cohort_selected_transaction_index_v2_heads FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE CONSTRAINT TRIGGER neighborhood_selected_transaction_index_v2_head_commit AFTER INSERT OR UPDATE
 ON app.neighborhood_custom_cohort_selected_transaction_index_v2_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_selected_transaction_index_v2_unintegrated();

DO $$ DECLARE target text; label text; BEGIN
 FOR target,label IN VALUES
  ('neighborhood_custom_cohort_selected_transaction_index_v2_rows','member'),
  ('neighborhood_custom_cohort_selected_transaction_source_v2_keys','source'),
  ('neighborhood_custom_cohort_selected_transaction_legacy_v2_keys','legacy'),
  ('neighborhood_custom_cohort_selected_transaction_index_v2_edges','edge') LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_selected_transaction_index_v2_child()',
   'neighborhood_selected_transaction_index_v2_'||label||'_guard',target);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation()',
   'neighborhood_selected_transaction_index_v2_'||label||'_truncate',target);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON app.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reject_neighborhood_selected_transaction_index_v2_unintegrated()',
   'neighborhood_selected_transaction_index_v2_'||label||'_commit',target);
 END LOOP;
END $$;
