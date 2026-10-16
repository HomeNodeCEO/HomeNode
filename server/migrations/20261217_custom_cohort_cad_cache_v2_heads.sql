-- Dormant manual CAD coverage. Deliberately UNREGISTERED until the complete
-- owner/consumer/automatic-success handoff is reviewed and release coherent.
CREATE TABLE app.neighborhood_custom_cohort_cad_cache_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  source_reference jsonb NOT NULL CHECK(octet_length(source_reference::text) BETWEEN 100 AND 256),
  root_reference jsonb NOT NULL CHECK(octet_length(root_reference::text) BETWEEN 100 AND 256),
  graph_reference jsonb NOT NULL CHECK(octet_length(graph_reference::text) BETWEEN 100 AND 256),
  geographic_reference jsonb NOT NULL CHECK(octet_length(geographic_reference::text) BETWEEN 100 AND 256),
  identity_reference jsonb NOT NULL CHECK(octet_length(identity_reference::text) BETWEEN 100 AND 256),
  stock_reference jsonb NOT NULL CHECK(octet_length(stock_reference::text) BETWEEN 100 AND 256),
  neutral_reference jsonb NOT NULL CHECK(octet_length(neutral_reference::text) BETWEEN 100 AND 256),
  receipt_reference jsonb NOT NULL CHECK(octet_length(receipt_reference::text) BETWEEN 100 AND 256),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 2000001),
  issued_transaction_id bigint NOT NULL DEFAULT txid_current(),
  issued_claim_token uuid NOT NULL,issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  receipt_sha256 text GENERATED ALWAYS AS (receipt_reference->>'content_sha256') STORED,
  root_sha256 text GENERATED ALWAYS AS (root_reference->>'content_sha256') STORED,
  neutral_sha256 text GENERATED ALWAYS AS (neutral_reference->>'content_sha256') STORED,
  FOREIGN KEY(organization_id,receipt_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(organization_id,root_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(organization_id,neutral_sha256) REFERENCES app.neighborhood_cohort_evidence_blobs(organization_id,content_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION app.check_neighborhood_cad_cache_v2_binding(h app.neighborhood_custom_cohort_cad_cache_v2_heads)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  neutral app.neighborhood_custom_cohort_neutral_cache_v2_heads%ROWTYPE;
  cad app.neighborhood_frozen_cad_improvement_generations%ROWTYPE;
  original app.neighborhood_frozen_source_generations%ROWTYPE;
  cache app.neighborhood_frozen_typed_cad_generations%ROWTYPE;
  receipt jsonb; neutral_receipt jsonb; metadata jsonb;
BEGIN
  SELECT * INTO job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO neutral FROM app.neighborhood_custom_cohort_neutral_cache_v2_heads WHERE operation_id=h.operation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF job.organization_id<>h.organization_id OR job.status IS DISTINCT FROM 'running'
    OR (job.lease_expires_at>clock_timestamp()) IS DISTINCT FROM true
    OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.request_payload->>'execution_mode' IS NOT NULL
    OR EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations WHERE operation_id=h.operation_id)
    OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_identity_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>6
    OR stock.organization_id<>h.organization_id OR stock.status<>'complete'
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM h.stock_reference
    OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM h.source_reference
    OR job.checkpoint->'evidence_refs'->3 IS DISTINCT FROM h.graph_reference
    OR job.checkpoint->'evidence_refs'->4 IS DISTINCT FROM h.geographic_reference
    OR job.checkpoint->'evidence_refs'->5 IS DISTINCT FROM h.identity_reference
    OR neutral.organization_id<>h.organization_id OR neutral.source_reference<>h.source_reference
    OR neutral.root_reference<>h.root_reference OR neutral.graph_reference<>h.graph_reference
    OR neutral.geographic_reference<>h.geographic_reference OR neutral.identity_reference<>h.identity_reference
    OR neutral.stock_reference<>h.stock_reference OR neutral.receipt_reference<>h.neutral_reference
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_prepared_generation_pins p
      JOIN app.neighborhood_group_generations g USING(generation_id)
      WHERE p.operation_id=h.operation_id AND p.generation_id=stock.generation_id
        AND g.status='complete' AND g.retirement_started_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_graph_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.receipt_reference=h.graph_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_geo_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.graph_reference=h.graph_reference AND a.stock_reference=h.stock_reference AND a.receipt_reference=h.geographic_reference)
    OR NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_identity_v2_anchors a WHERE a.operation_id=h.operation_id
      AND a.organization_id=h.organization_id AND a.source_reference=h.source_reference AND a.root_reference=h.root_reference
      AND a.graph_reference=h.graph_reference AND a.geographic_reference=h.geographic_reference
      AND a.stock_reference=h.stock_reference AND a.receipt_reference=h.identity_reference) THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO neutral_receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=h.organization_id AND content_sha256=h.neutral_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.neutral_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NOT FOUND OR neutral_receipt->>'format' IS DISTINCT FROM 'cohort_neutral_cache_receipt_v2'
    OR neutral_receipt->>'sequence' IS DISTINCT FROM neutral.sequence::text
    OR neutral_receipt->'after'->>'kind_index' IS DISTINCT FROM '7' THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_unfinished_neutral' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=h.organization_id AND content_sha256=h.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=h.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF NOT FOUND OR receipt->>'format' IS DISTINCT FROM 'cohort_CAD_cache_coverage_receipt_v2'
    OR (SELECT count(*) FROM jsonb_object_keys(receipt))<>19
    OR receipt->'binding' IS DISTINCT FROM neutral_receipt->'binding'
    OR receipt->'source_reference' IS DISTINCT FROM h.source_reference OR receipt->'root_reference' IS DISTINCT FROM h.root_reference
    OR receipt->'graph_reference' IS DISTINCT FROM h.graph_reference OR receipt->'geographic_reference' IS DISTINCT FROM h.geographic_reference
    OR receipt->'identity_reference' IS DISTINCT FROM h.identity_reference OR receipt->'stock_reference' IS DISTINCT FROM h.stock_reference
    OR receipt->'neutral_reference' IS DISTINCT FROM h.neutral_reference
    OR receipt->>'sequence' IS DISTINCT FROM h.sequence::text OR receipt->>'stock_account_count' IS DISTINCT FROM stock.account_count::text
    OR receipt->'cad_purpose'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR receipt->'cad_purpose'->>'acquisition_scope' IS DISTINCT FROM 'retained_generation_only_no_current_core_or_provider_reads'
    OR (receipt->'cad_decision'->>'policy_revision' ~ '^custom-neighborhood-cad-improvement-source-rights-v1:sha256:[a-f0-9]{64}$') IS DISTINCT FROM true
    OR coalesce(length(receipt->'cad_decision'->>'decision_id'),0)=0 THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO cad FROM app.neighborhood_frozen_cad_improvement_generations WHERE generation_id=stock.generation_id;
  IF NOT FOUND OR cad.status<>'complete' THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
  SELECT * INTO original FROM app.neighborhood_frozen_source_generations WHERE generation_id=stock.generation_id;
  IF NOT FOUND OR original.status<>'complete' OR original.source_snapshot<>cad.source_snapshot
    OR original.source_transaction_started_at<>cad.source_transaction_started_at THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
  metadata:=jsonb_build_object('generation_id',cad.generation_id::text,'format_version',cad.format_version,'status',cad.status,
    'source_snapshot',cad.source_snapshot,'started_at',to_char(cad.source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'completed_at',to_char(cad.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source_profile_sha256',cad.profile_sha256,'source_definition_json',cad.definition_json,
    'layer_counts',cad.layer_counts,'row_count',cad.row_count::text,'payload_utf8_bytes',cad.payload_utf8_bytes::text);
  SELECT * INTO cache FROM app.neighborhood_frozen_typed_cad_generations
    WHERE generation_id=stock.generation_id AND profile_sha256=receipt->'typed_profile_reference'->>'content_sha256';
  IF NOT FOUND OR cache.status NOT IN ('building','complete') OR cache.source_metadata IS DISTINCT FROM metadata
    OR receipt->'cad_source_metadata' IS DISTINCT FROM metadata
    OR receipt->'cad_purpose'->'source_projection'->>'content_sha256' IS DISTINCT FROM cad.profile_sha256
    OR encode(sha256(convert_to(cache.definition_json,'UTF8')),'hex') IS DISTINCT FROM cache.profile_sha256
    OR octet_length(cache.definition_json)::text IS DISTINCT FROM receipt->'typed_profile_reference'->>'canonical_utf8_bytes' THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_source_conflict' USING ERRCODE='55000'; END IF;
END $$;

CREATE FUNCTION app.guard_neighborhood_cad_cache_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE; stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  receipt jsonb; prior jsonb; before_state jsonb; expected_before jsonb; expected_after jsonb;
  next_account text; parcels bigint; primary_rows integer; secondary_rows integer; bytes bigint; delta bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_cad_cache_v2_immutable' USING ERRCODE='55000'; END IF;
  PERFORM app.check_neighborhood_cad_cache_v2_binding(NEW);
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks WHERE operation_id=NEW.operation_id;
  SELECT canonical_utf8::jsonb INTO STRICT receipt FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256';
  IF TG_OP='INSERT' THEN
    expected_before:='{"after_account":"","account_count":0,"original_count":0,"typed_utf8_bytes":"0","done":false}'::jsonb;
    IF NEW.sequence<>1 OR receipt->'previous' IS DISTINCT FROM 'null'::jsonb OR NEW.issued_transaction_id<>txid_current() THEN
      RAISE EXCEPTION 'neighborhood_cad_cache_v2_initial_head_required' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['receipt_reference','sequence','issued_transaction_id','receipt_sha256','root_sha256','neutral_sha256'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_reference','sequence','issued_transaction_id','receipt_sha256','root_sha256','neutral_sha256'])
      OR NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id OR NEW.sequence<>OLD.sequence+1
      OR NEW.receipt_reference=OLD.receipt_reference OR receipt->'previous' IS DISTINCT FROM OLD.receipt_reference THEN
      RAISE EXCEPTION 'neighborhood_cad_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT prior FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.receipt_reference->>'content_sha256';
    expected_before:=prior->'after';
    IF receipt->'typed_profile_reference' IS DISTINCT FROM prior->'typed_profile_reference'
      OR receipt->'cad_source_metadata' IS DISTINCT FROM prior->'cad_source_metadata'
      OR receipt->'cad_purpose' IS DISTINCT FROM prior->'cad_purpose' OR receipt->'cad_decision' IS DISTINCT FROM prior->'cad_decision' THEN
      RAISE EXCEPTION 'neighborhood_cad_cache_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  IF jsonb_typeof(receipt->'after'->'typed_utf8_bytes') IS DISTINCT FROM 'string'
    OR (receipt->'after'->>'typed_utf8_bytes' ~ '^(0|[1-9][0-9]{0,9})$') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  before_state:=receipt->'before';bytes:=(receipt->'after'->>'typed_utf8_bytes')::bigint;
  delta:=bytes-(before_state->>'typed_utf8_bytes')::bigint;
  IF before_state IS DISTINCT FROM expected_before OR before_state->>'done' IS DISTINCT FROM 'false'
    OR NEW.sequence<>(before_state->>'account_count')::integer+1 OR bytes NOT BETWEEN 0 AND 8000000000
    OR delta NOT BETWEEN 0 AND 32000000 THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  SELECT account_id,parcel_count INTO next_account,parcels FROM app.neighborhood_custom_cohort_stock_accounts
    WHERE operation_id=NEW.operation_id AND account_id>(before_state->>'after_account') COLLATE "C" ORDER BY account_id LIMIT 1;
  IF next_account IS NULL THEN
    IF receipt->'entry' IS DISTINCT FROM 'null'::jsonb OR (before_state->>'account_count')::bigint<>stock.account_count OR delta<>0 THEN
      RAISE EXCEPTION 'neighborhood_cad_cache_v2_fresh_empty_required' USING ERRCODE='55000'; END IF;
    expected_after:=before_state||'{"done":true}'::jsonb;
  ELSE
    SELECT count(*)::integer INTO primary_rows FROM (SELECT 1 FROM app.neighborhood_frozen_cad_improvement_rows
      WHERE generation_id=stock.generation_id AND account_id=next_account AND kind='primary' ORDER BY row_key LIMIT 251) bounded;
    SELECT count(*)::integer INTO secondary_rows FROM (SELECT 1 FROM app.neighborhood_frozen_cad_improvement_rows
      WHERE generation_id=stock.generation_id AND account_id=next_account AND kind='secondary' ORDER BY row_key LIMIT 251) bounded;
    IF primary_rows>1 OR primary_rows+secondary_rows>250 OR delta<primary_rows+secondary_rows
      OR primary_rows+secondary_rows=0 AND delta<>0
      OR receipt->'entry' IS DISTINCT FROM jsonb_build_object('account_id',next_account,'geographic_parcel_count',parcels::text,
        'primary_count',primary_rows,'secondary_count',secondary_rows) THEN
      RAISE EXCEPTION 'neighborhood_cad_cache_v2_account_conflict' USING ERRCODE='55000'; END IF;
    expected_after:=jsonb_build_object('after_account',next_account,'account_count',(before_state->>'account_count')::integer+1,
      'original_count',(before_state->>'original_count')::integer+primary_rows+secondary_rows,'typed_utf8_bytes',bytes::text,'done',false);
  END IF;
  IF receipt->'after' IS DISTINCT FROM expected_after OR (expected_after->>'account_count')::bigint>stock.account_count
    OR (expected_after->>'original_count')::bigint>4000000 THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_transition_conflict' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();NEW.issued_claim_token:=job.claim_token;NEW.issued_attempts:=job.attempts;RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_cad_cache_v2_head_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_cad_cache_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cad_cache_v2_head();
CREATE TRIGGER neighborhood_cad_cache_v2_head_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_cad_cache_v2_heads
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_cad_cache_v2_heads FROM PUBLIC;

CREATE FUNCTION app.check_neighborhood_cad_cache_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_cad_cache_v2_heads%ROWTYPE; job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_cad_cache_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF h.issued_transaction_id<>txid_current() OR job.claim_token IS DISTINCT FROM h.issued_claim_token OR job.attempts<>h.issued_attempts THEN
    RAISE EXCEPTION 'neighborhood_cad_cache_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  PERFORM app.check_neighborhood_cad_cache_v2_binding(h);RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_cad_cache_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_cad_cache_v2_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_cad_cache_v2_commit();
COMMENT ON TABLE app.neighborhood_custom_cohort_cad_cache_v2_heads IS
  'Inactive manual CAD coverage: independent E DONE and original parents, exact next stock account, bounded native improvement counters and separate terminal EMPTY. Real original/entire-cache reconciliation and both-end current CAD authorization remain trusted-owner duties. Receipt/root/E FK retention and deferred live-claim commit; no automatic success, consumer activation, source grant, publication or pin retirement.';
