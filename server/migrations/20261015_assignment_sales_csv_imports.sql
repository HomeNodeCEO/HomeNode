-- Assignment-private intake receipts only. These rows are not shared sales,
-- account matches, selected analysis members, or signed appraisal evidence.
CREATE TABLE IF NOT EXISTS app.assignment_sales_import_batches (
  batch_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  file_name text NOT NULL,
  source_bytes bytea NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_length integer NOT NULL,
  preparation_profile text NOT NULL CHECK (preparation_profile = 'private_sales_csv_preparation_v1'),
  preparation_version integer NOT NULL CHECK (preparation_version = 1),
  preparation_sha256 text NOT NULL CHECK (preparation_sha256 ~ '^[a-f0-9]{64}$'),
  preparation_header jsonb NOT NULL,
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, report_file_id, operation_id),
  FOREIGN KEY (organization_id, report_file_id, assignment_file_id, account_id)
    REFERENCES app.report_files (organization_id, id, custom_assignment_file_id, account_id) ON DELETE RESTRICT,
  CHECK (char_length(file_name) <= 255 AND file_name !~ U&'[\0001-\001F\007F-\009F]'),
  CHECK (source_byte_length BETWEEN 1 AND 8388608),
  CHECK (source_byte_length = pg_catalog.octet_length(source_bytes)),
  CHECK (source_sha256 = pg_catalog.encode(pg_catalog.sha256(source_bytes), 'hex')),
  CHECK (pg_catalog.jsonb_typeof(preparation_header) = 'object'),
  CHECK (pg_catalog.octet_length(pg_catalog.convert_to(preparation_header::text, 'UTF8')) <= 2097152)
);

CREATE INDEX IF NOT EXISTS assignment_sales_import_batches_file_idx
  ON app.assignment_sales_import_batches (organization_id, report_file_id, stored_at DESC, batch_id);

CREATE TABLE IF NOT EXISTS app.assignment_sales_import_rows (
  batch_id uuid NOT NULL REFERENCES app.assignment_sales_import_batches(batch_id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  source_row_number integer NOT NULL CHECK (source_row_number BETWEEN 2 AND 10001),
  record_data jsonb NOT NULL,
  PRIMARY KEY (batch_id, source_row_number),
  CHECK (pg_catalog.jsonb_typeof(record_data) = 'object'),
  CHECK (pg_catalog.octet_length(pg_catalog.convert_to(record_data::text, 'UTF8')) <= 2097152),
  CHECK ((record_data->'source_row_number') IS NOT DISTINCT FROM pg_catalog.to_jsonb(source_row_number))
);

CREATE OR REPLACE FUNCTION app.reject_assignment_sales_import_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  RAISE EXCEPTION 'assignment_sales_import_immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER assignment_sales_import_batches_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.assignment_sales_import_batches
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_assignment_sales_import_mutation();
CREATE TRIGGER assignment_sales_import_rows_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.assignment_sales_import_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_assignment_sales_import_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.assignment_sales_import_batches FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON app.assignment_sales_import_rows FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.guard_assignment_sales_import_row_range()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE expected_rows integer;
BEGIN
  -- The parent must be visible in this transaction; its declared count is
  -- immutable. A committed batch already occupies every permitted ordinal.
  SELECT row_count INTO expected_rows FROM app.assignment_sales_import_batches
    WHERE batch_id = NEW.batch_id;
  IF NOT FOUND OR NEW.source_row_number IS NULL
      OR NEW.source_row_number < 2 OR NEW.source_row_number > expected_rows + 1 THEN
    RAISE EXCEPTION 'assignment_sales_import_row_out_of_range' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignment_sales_import_row_range
  BEFORE INSERT ON app.assignment_sales_import_rows
  FOR EACH ROW EXECUTE FUNCTION app.guard_assignment_sales_import_row_range();

CREATE OR REPLACE FUNCTION app.check_assignment_sales_import_batch_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE actual_rows bigint; first_row integer; last_row integer;
BEGIN
  SELECT count(*), min(source_row_number), max(source_row_number)
    INTO actual_rows, first_row, last_row
    FROM app.assignment_sales_import_rows WHERE batch_id = NEW.batch_id;
  IF actual_rows <> NEW.row_count
      OR (NEW.row_count = 0 AND (first_row IS NOT NULL OR last_row IS NOT NULL))
      OR (NEW.row_count > 0 AND (first_row IS DISTINCT FROM 2
          OR last_row IS DISTINCT FROM NEW.row_count + 1)) THEN
    RAISE EXCEPTION 'assignment_sales_import_batch_incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Check once per batch, not once per row: 10,000 row receipts require one
-- bounded aggregate, not 10,000 full-batch scans. The PK and immediate range
-- guard plus this deferred exact count establish contiguous logical ordinals.
-- Later appends cannot change a sealed batch: every permitted key exists, and
-- out-of-range keys are rejected. Batch and all receipts must commit together.
CREATE CONSTRAINT TRIGGER assignment_sales_import_batch_complete
  AFTER INSERT ON app.assignment_sales_import_batches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_assignment_sales_import_batch_complete();

COMMENT ON TABLE app.assignment_sales_import_batches IS
  'Immutable assignment-private CSV bytes and complete committed intake receipts. Storage does not establish source rights, account matching, neighborhood inclusion, or signed evidence. No automatic expiration.';
COMMENT ON TABLE app.assignment_sales_import_rows IS
  'Immutable prepared rows with exact logical CSV ordinals. Ownership is inherited exclusively through batch_id; no shared core sales publication or independent row reassignment.';
