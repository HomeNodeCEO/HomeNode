-- Dormant job-owned typed read-model. No scheduler/HTTP/Apply activation.
-- Retained original strings and their pinned generation remain authoritative
-- evidence; this versioned interpretation does not turn them into verified facts.
CREATE TABLE app.neighborhood_custom_cohort_typed_originals (
  operation_id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
  profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  effective_date date NOT NULL,
  expected_counts jsonb NOT NULL CHECK(jsonb_typeof(expected_counts)='object' AND octet_length(expected_counts::text)<=1024),
  progress jsonb NOT NULL CHECK(jsonb_typeof(progress)='object' AND octet_length(progress::text)<=2048),
  status text NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete')),
  completed_at timestamptz,
  CHECK((status='complete')=(completed_at IS NOT NULL)),
  UNIQUE(operation_id,generation_id),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_typed_original_rows (
  operation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  kind text NOT NULL,
  row_key text COLLATE "C" NOT NULL,
  account_id text COLLATE "C",
  source_record_id bigint,
  original_payload_sha256 text NOT NULL CHECK(original_payload_sha256 ~ '^[a-f0-9]{64}$'),
  typed jsonb NOT NULL CHECK(jsonb_typeof(typed)='object' AND octet_length(typed::text)<=131072),
  CHECK(coalesce(typed->>'typed_original_version'='1' AND typed->'original'->>'kind'=kind
    AND typed->'original'->>'row_key'=row_key AND typed->'original'->>'payload_sha256'=original_payload_sha256
    AND (typed->>'account_id') IS NOT DISTINCT FROM account_id
    AND (typed->>'source_record_id') IS NOT DISTINCT FROM source_record_id::text,false)),
  PRIMARY KEY(operation_id,kind,row_key),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_typed_originals(operation_id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(generation_id,kind,row_key) REFERENCES app.neighborhood_frozen_source_rows(generation_id,kind,row_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_cohort_typed_original_account_idx
  ON app.neighborhood_custom_cohort_typed_original_rows(operation_id,kind,account_id,row_key) WHERE account_id IS NOT NULL;
CREATE INDEX neighborhood_cohort_typed_original_source_idx
  ON app.neighborhood_custom_cohort_typed_original_rows(operation_id,kind,source_record_id,row_key) WHERE source_record_id IS NOT NULL;
CREATE INDEX neighborhood_cohort_typed_original_retirement_idx
  ON app.neighborhood_custom_cohort_typed_original_rows(generation_id,kind,row_key);
CREATE FUNCTION app.guard_neighborhood_cohort_typed_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' THEN
      RAISE EXCEPTION 'neighborhood_typed_initial_state_required' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.status<>'building' OR (to_jsonb(NEW)-ARRAY['status','progress','completed_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','progress','completed_at']) THEN
      RAISE EXCEPTION 'neighborhood_typed_immutable' USING ERRCODE='55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'neighborhood_typed_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_typed_header_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_typed_originals FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_typed_header();
CREATE FUNCTION app.guard_neighborhood_cohort_typed_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.neighborhood_custom_cohort_typed_originals header
    JOIN (SELECT DISTINCT operation_id FROM new_rows) changed USING(operation_id)
    ORDER BY header.operation_id FOR SHARE OF header NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_custom_cohort_typed_originals header USING(operation_id)
    WHERE header.status<>'building' OR changed.typed->'interpretation_profile_ref'->>'content_sha256' IS DISTINCT FROM header.profile_sha256
      OR changed.typed->>'effective_date' IS DISTINCT FROM to_char(header.effective_date,'YYYY-MM-DD')) THEN
    RAISE EXCEPTION 'neighborhood_typed_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER neighborhood_cohort_typed_row_insert_guard AFTER INSERT
  ON app.neighborhood_custom_cohort_typed_original_rows REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_cohort_typed_insert();
CREATE TRIGGER neighborhood_cohort_typed_row_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app.neighborhood_custom_cohort_typed_original_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_cohort_typed_header_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_typed_originals FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_typed_original_rows FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_typed_originals FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_typed_originals IS
  'Internal versioned exact-string row interpretation, not complete numerical property/transaction observations, a source grant, acquisition receipt, statistics or report result. No worker/HTTP activation. Verified-original transfer and terminal retirement remain separate work.';
