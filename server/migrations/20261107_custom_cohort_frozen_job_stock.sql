-- Exact whole-parcel stock is computed once, then reused by the new capture
-- owner. Membership references the pinned immutable original geometry/facts;
-- account-associated parcel parts outside the circle are NOT spatial members.
ALTER TABLE app.neighborhood_custom_cohort_prepared_generation_pins
  ADD CONSTRAINT neighborhood_cohort_pin_version_key UNIQUE(operation_id,generation_id);
CREATE TABLE app.neighborhood_custom_cohort_job_stocks (
  operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  actor_user_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  subject_intent_sha256 text NOT NULL CHECK(subject_intent_sha256 ~ '^[a-f0-9]{64}$'),
  subject_intent_utf8_bytes bigint NOT NULL CHECK(subject_intent_utf8_bytes BETWEEN 1 AND 1500000),
  definition_sha256 text NOT NULL CHECK(definition_sha256 ~ '^[a-f0-9]{64}$'),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=4096),
  source_original_sha256 text NOT NULL CHECK(source_original_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete')),
  parcel_count bigint NOT NULL DEFAULT 0 CHECK(parcel_count BETWEEN 0 AND 2000000),
  account_count bigint NOT NULL DEFAULT 0 CHECK(account_count BETWEEN 0 AND parcel_count),
  unassociated_parcel_count bigint NOT NULL DEFAULT 0 CHECK(unassociated_parcel_count BETWEEN 0 AND parcel_count),
  unlocatable_global_parcels bigint NOT NULL CHECK(unlocatable_global_parcels BETWEEN 0 AND 2000000),
  completed_at timestamptz,
  CHECK((status='complete')=(completed_at IS NOT NULL)),
  UNIQUE(operation_id,generation_id),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_prepared_generation_pins(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id)
    REFERENCES app.neighborhood_custom_cohort_capture_jobs(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_stock_parcels (
  operation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  object_id bigint NOT NULL CHECK(object_id>=0),
  kind text GENERATED ALWAYS AS ('parcels'::text) STORED,
  row_key text COLLATE "C" GENERATED ALWAYS AS (object_id::text) STORED,
  account_id text COLLATE "C",
  PRIMARY KEY(operation_id,object_id),
  FOREIGN KEY(operation_id,generation_id) REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(generation_id,kind,row_key) REFERENCES app.neighborhood_frozen_source_rows(generation_id,kind,row_key) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_cohort_stock_parcels_account_idx
  ON app.neighborhood_custom_cohort_stock_parcels(operation_id,account_id,object_id) WHERE account_id IS NOT NULL;
-- Old unpinned original generations retire in row batches. RESTRICT checks
-- must use this generation-leading index, not scan every retained job's stock.
CREATE INDEX neighborhood_cohort_stock_parcels_original_idx
  ON app.neighborhood_custom_cohort_stock_parcels(generation_id,kind,row_key);
CREATE TABLE app.neighborhood_custom_cohort_stock_accounts (
  operation_id uuid NOT NULL REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  account_id text COLLATE "C" NOT NULL,
  parcel_count bigint NOT NULL CHECK(parcel_count BETWEEN 1 AND 2000000),
  PRIMARY KEY(operation_id,account_id)
);
CREATE FUNCTION app.guard_neighborhood_cohort_stock_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' OR NEW.parcel_count<>0 OR NEW.account_count<>0 OR NEW.unassociated_parcel_count<>0 THEN
      RAISE EXCEPTION 'neighborhood_stock_initial_state_required' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.status<>'building' OR NEW.status<>'complete'
      OR (to_jsonb(NEW)-ARRAY['status','parcel_count','account_count','unassociated_parcel_count','completed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','parcel_count','account_count','unassociated_parcel_count','completed_at']) THEN
      RAISE EXCEPTION 'neighborhood_stock_immutable' USING ERRCODE='55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'neighborhood_stock_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_stock_header_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_job_stocks FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_stock_header();
CREATE FUNCTION app.guard_neighborhood_cohort_stock_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Statement-level locks avoid 60,001 extra queries and fence publication.
  PERFORM 1 FROM app.neighborhood_custom_cohort_job_stocks stock
    JOIN (SELECT DISTINCT operation_id FROM new_rows) changed USING(operation_id)
    ORDER BY stock.operation_id FOR SHARE OF stock NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_custom_cohort_job_stocks stock USING(operation_id)
    WHERE stock.status<>'building') THEN
    RAISE EXCEPTION 'neighborhood_stock_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['neighborhood_custom_cohort_stock_parcels','neighborhood_custom_cohort_stock_accounts'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON app.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_cohort_stock_insert()',relation||'_insert_guard',relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation()',relation||'_immutable',relation);
  END LOOP;
END $$;
CREATE TRIGGER neighborhood_cohort_stock_header_truncate BEFORE TRUNCATE ON app.neighborhood_custom_cohort_job_stocks
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_stock_parcels,app.neighborhood_custom_cohort_stock_accounts FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_job_stocks FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_job_stocks IS
  'Internal exact pinned stock membership, not a source license, completed source acquisition, historical stock or report result. No worker/HTTP activation. Terminal verified-original transfer/retirement remains a separate owner.';
