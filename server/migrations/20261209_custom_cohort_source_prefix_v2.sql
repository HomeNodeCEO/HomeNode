-- Unregistered candidate. Native issuance of one actual prepared source page.
-- No source grants, schedules, initial dispatcher, cache handoff or activation.
CREATE TABLE app.neighborhood_custom_cohort_source_prefix_v2_heads (
  operation_id uuid PRIMARY KEY REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  subject_reference jsonb NOT NULL, stock_reference jsonb NOT NULL,
  source_reference jsonb NOT NULL, root_reference jsonb NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 200000),
  issued_claim_token uuid NOT NULL, issued_attempts integer NOT NULL CHECK(issued_attempts BETWEEN 1 AND 5),
  issued_transaction_id bigint NOT NULL DEFAULT txid_current() CHECK(issued_transaction_id>0)
);

CREATE FUNCTION app.guard_neighborhood_source_prefix_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  stock app.neighborhood_custom_cohort_job_stocks%ROWTYPE;
  source_body jsonb; root_body jsonb; old_source jsonb; old_root jsonb; stock_body jsonb; node jsonb;
  old_layer jsonb; new_layer jsonb; kind text; next_kind text;
  kinds text[]:=ARRAY['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
  empty_layer jsonb:='{"head":null,"page_count":0,"row_count":0,"original_utf8_bytes":0,"cursor":"","ended":false}';
  pages bigint:=0; rows_count bigint:=0; bytes_count bigint:=0;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'neighborhood_source_prefix_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF job.organization_id<>NEW.organization_id OR job.actor_user_id<>NEW.actor_user_id OR job.request_sha256<>NEW.request_sha256
    OR job.status<>'running' OR job.claim_token IS DISTINCT FROM NEW.issued_claim_token OR job.attempts<>NEW.issued_attempts
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint->'evidence_refs'->0 IS DISTINCT FROM NEW.subject_reference
    OR job.checkpoint->'evidence_refs'->1 IS DISTINCT FROM NEW.stock_reference THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_job_conflict' USING ERRCODE='55000'; END IF;
  IF (TG_OP='INSERT' AND NEW.issued_transaction_id<>txid_current())
    OR (TG_OP='UPDATE' AND NEW.issued_transaction_id IS DISTINCT FROM OLD.issued_transaction_id) THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_issuance_immutable' USING ERRCODE='55000'; END IF;
  NEW.issued_transaction_id:=txid_current();
  SELECT * INTO STRICT stock FROM app.neighborhood_custom_cohort_job_stocks
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND actor_user_id=NEW.actor_user_id
      AND report_file_id=job.report_file_id AND assignment_file_id=job.assignment_file_id AND account_id=job.account_id AND status='complete';
  SELECT canonical_utf8::jsonb INTO STRICT stock_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.stock_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.stock_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT source_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.source_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.source_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  SELECT canonical_utf8::jsonb INTO STRICT root_body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.root_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.root_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF stock.subject_intent_sha256 IS DISTINCT FROM NEW.subject_reference->>'content_sha256'
    OR stock.subject_intent_utf8_bytes::text IS DISTINCT FROM NEW.subject_reference->>'canonical_utf8_bytes'
    OR stock_body->>'stock_stage_version' IS DISTINCT FROM '1' OR stock_body->>'usage' IS DISTINCT FROM 'frozen_job_stock_only'
    OR stock_body->'subject_intent' IS DISTINCT FROM NEW.subject_reference
    OR stock_body->'stock'->>'generation_id' IS DISTINCT FROM stock.generation_id::text
    OR stock_body->'stock'->>'definition_sha256' IS DISTINCT FROM stock.definition_sha256
    OR stock_body->'stock'->>'source_original_sha256' IS DISTINCT FROM stock.source_original_sha256
    OR stock_body->'stock'->'population' IS DISTINCT FROM jsonb_build_object('parcel_count',stock.parcel_count::text,
      'account_count',stock.account_count::text,'unassociated_parcel_count',stock.unassociated_parcel_count::text,
      'unlocatable_global_parcels',stock.unlocatable_global_parcels::text,'invalid_geometries','0','subject_included',true)
    OR source_body->>'source_stage_version' IS DISTINCT FROM '2'
    OR source_body->>'usage' IS DISTINCT FROM 'frozen_source_reference_prefix_only'
    OR source_body->'root' IS DISTINCT FROM NEW.root_reference
    OR source_body->'selection' IS DISTINCT FROM jsonb_build_object('selection_version','frozen_job_stock_source_v1',
      'scope',jsonb_build_object('organization_id',job.organization_id::text,'report_file_id',job.report_file_id::text,
        'assignment_file_id',job.assignment_file_id::text,'account_id',job.account_id),
      'operation_id',job.operation_id::text,'subject_intent',NEW.subject_reference,'stock_reference',NEW.stock_reference,
      'generation_id',stock.generation_id::text,'spatial_definition_sha256',stock.definition_sha256,
      'source_original_sha256',stock.source_original_sha256,'stock_population',stock_body->'stock'->'population')
    OR root_body->>'format' IS DISTINCT FROM 'cohort_original_source_references_v2'
    OR root_body->'binding' IS DISTINCT FROM jsonb_build_object('organization_id',job.organization_id::text,
      'report_file_id',job.report_file_id::text,'assignment_file_id',job.assignment_file_id::text,'account_id',job.account_id,
      'operation_id',job.operation_id::text,'generation_id',stock.generation_id::text,
      'spatial_definition_sha256',stock.definition_sha256,'source_original_sha256',stock.source_original_sha256)
    OR jsonb_typeof(root_body->'layers') IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(root_body->'layers'))<>7 THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sequence<>1 OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_stock_v1'
      OR jsonb_array_length(job.checkpoint->'evidence_refs')<>2 THEN
      RAISE EXCEPTION 'neighborhood_source_prefix_v2_initial_stock_required' USING ERRCODE='55000'; END IF;
    old_root:=jsonb_build_object('layers',(SELECT jsonb_object_agg(k,empty_layer) FROM unnest(kinds) k));
  ELSE
    IF (to_jsonb(NEW)-ARRAY['source_reference','root_reference','sequence','issued_claim_token','issued_attempts','issued_transaction_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['source_reference','root_reference','sequence','issued_claim_token','issued_attempts','issued_transaction_id'])
      OR NEW.sequence<>OLD.sequence+1 OR NEW.source_reference=OLD.source_reference OR NEW.root_reference=OLD.root_reference
      OR job.checkpoint->>'phase' IS DISTINCT FROM 'frozen_source_refs_v2' OR jsonb_array_length(job.checkpoint->'evidence_refs')<>3
      OR job.checkpoint->'evidence_refs'->2 IS DISTINCT FROM OLD.source_reference THEN
      RAISE EXCEPTION 'neighborhood_source_prefix_v2_transition_conflict' USING ERRCODE='55000'; END IF;
    SELECT canonical_utf8::jsonb INTO STRICT old_root FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.root_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.root_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    SELECT canonical_utf8::jsonb INTO STRICT old_source FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=OLD.organization_id AND content_sha256=OLD.source_reference->>'content_sha256'
        AND canonical_utf8_bytes::text=OLD.source_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
    IF source_body-'root' IS DISTINCT FROM old_source-'root' THEN
      RAISE EXCEPTION 'neighborhood_source_prefix_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  END IF;
  FOREACH kind IN ARRAY kinds LOOP
    IF next_kind IS NULL AND old_root->'layers'->kind->>'ended'='false' THEN next_kind:=kind; END IF;
  END LOOP;
  IF next_kind IS NULL THEN RAISE EXCEPTION 'neighborhood_source_prefix_v2_done' USING ERRCODE='55000'; END IF;
  old_layer:=old_root->'layers'->next_kind; new_layer:=root_body->'layers'->next_kind;
  SELECT canonical_utf8::jsonb INTO STRICT node FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=new_layer->'head'->>'content_sha256'
      AND canonical_utf8_bytes::text=new_layer->'head'->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4000;
  IF node->>'format' IS DISTINCT FROM 'cohort_original_source_references_v2'
    OR node->>'plan' IS DISTINCT FROM 'neighborhood_frozen_job_closure_v1' OR node->>'kind' IS DISTINCT FROM next_kind
    OR node->>'index' IS DISTINCT FROM old_layer->>'page_count' OR node->'previous' IS DISTINCT FROM old_layer->'head'
    OR node->>'after' IS DISTINCT FROM old_layer->>'cursor' OR node->>'row_limit' IS DISTINCT FROM '250'
    OR jsonb_typeof(node->'end_of_layer') IS DISTINCT FROM 'boolean' OR jsonb_typeof(node->'next_cursor') IS DISTINCT FROM 'string'
    OR jsonb_typeof(node->'row_count') IS DISTINCT FROM 'number' OR jsonb_typeof(node->'original_utf8_bytes') IS DISTINCT FROM 'number'
    OR jsonb_typeof(node->'page_utf8_bytes') IS DISTINCT FROM 'number'
    OR node->>'row_count' !~ '^(0|[1-9][0-9]{0,2})$'
    OR node->>'original_utf8_bytes' !~ '^[1-9][0-9]{0,6}$' OR node->>'page_utf8_bytes' !~ '^[1-9][0-9]{0,6}$'
    OR node->>'original_sha256' IS NULL OR node->>'original_sha256' !~ '^[a-f0-9]{64}$'
    OR (node->>'row_count')::bigint NOT BETWEEN 0 AND 250 OR (node->>'original_utf8_bytes')::bigint NOT BETWEEN 1 AND 4000000
    OR (node->>'page_utf8_bytes')::bigint NOT BETWEEN 2 AND 2100000
    OR (node->>'row_count'='0' AND (node->>'end_of_layer'<>'true' OR node->>'next_cursor' IS DISTINCT FROM old_layer->>'cursor'))
    OR new_layer IS DISTINCT FROM jsonb_build_object('head',new_layer->'head','page_count',(old_layer->>'page_count')::bigint+1,
      'row_count',(old_layer->>'row_count')::bigint+(node->>'row_count')::bigint,
      'original_utf8_bytes',(old_layer->>'original_utf8_bytes')::bigint+(node->>'original_utf8_bytes')::bigint,
      'cursor',node->>'next_cursor','ended',node->'end_of_layer') THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_edge_conflict' USING ERRCODE='55000'; END IF;
  FOREACH kind IN ARRAY kinds LOOP
    IF kind<>next_kind AND root_body->'layers'->kind IS DISTINCT FROM old_root->'layers'->kind THEN
      RAISE EXCEPTION 'neighborhood_source_prefix_v2_edge_conflict' USING ERRCODE='55000'; END IF;
    pages:=pages+(root_body->'layers'->kind->>'page_count')::bigint;
    rows_count:=rows_count+(root_body->'layers'->kind->>'row_count')::bigint;
    bytes_count:=bytes_count+(root_body->'layers'->kind->>'original_utf8_bytes')::bigint;
    IF (root_body->'layers'->kind->>'row_count')::bigint>2000000 THEN
      RAISE EXCEPTION 'neighborhood_source_prefix_v2_limit' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF pages IS DISTINCT FROM NEW.sequence::bigint OR pages>200000 OR rows_count>14000000 OR bytes_count>8000000000 THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_limit' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_prefix_v2_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_source_prefix_v2_heads FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_source_prefix_v2();
CREATE TRIGGER neighborhood_source_prefix_v2_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_source_prefix_v2_heads FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_source_prefix_v2_heads FROM PUBLIC;

CREATE FUNCTION app.check_neighborhood_source_prefix_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO STRICT h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=NEW.operation_id;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  IF h.issued_transaction_id IS DISTINCT FROM txid_current() OR job.status<>'running'
    OR job.claim_token IS DISTINCT FROM h.issued_claim_token OR job.attempts<>h.issued_attempts
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR job.checkpoint IS DISTINCT FROM jsonb_build_object('phase','frozen_source_refs_v2',
      'evidence_refs',jsonb_build_array(h.subject_reference,h.stock_reference,h.source_reference)) THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_commit_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_source_prefix_v2_commit AFTER INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_source_prefix_v2_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_neighborhood_source_prefix_v2_commit();

-- Enrolled heads cannot be laundered through a free replacement checkpoint or
-- the pre-existing graph verifier. Other jobs keep their explicit old contract.
CREATE FUNCTION app.guard_neighborhood_source_prefix_v2_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=NEW.operation_id;
  IF FOUND AND (NEW.checkpoint->'evidence_refs'->0 IS DISTINCT FROM h.subject_reference
    OR NEW.checkpoint->'evidence_refs'->1 IS DISTINCT FROM h.stock_reference
    OR NEW.checkpoint->'evidence_refs'->2 IS DISTINCT FROM h.source_reference) THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_checkpoint_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_prefix_v2_checkpoint BEFORE UPDATE OF checkpoint
  ON app.neighborhood_custom_cohort_capture_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_source_prefix_v2_checkpoint();
CREATE FUNCTION app.guard_neighborhood_source_prefix_v2_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h app.neighborhood_custom_cohort_source_prefix_v2_heads%ROWTYPE;
BEGIN
  SELECT * INTO h FROM app.neighborhood_custom_cohort_source_prefix_v2_heads WHERE operation_id=NEW.operation_id;
  IF FOUND AND (NEW.source_reference IS DISTINCT FROM h.source_reference OR NEW.root_reference IS DISTINCT FROM h.root_reference) THEN
    RAISE EXCEPTION 'neighborhood_source_prefix_v2_graph_conflict' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_source_prefix_v2_graph BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_graph_v2_anchors FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_source_prefix_v2_graph();
