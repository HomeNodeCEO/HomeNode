-- Opt-in nightly source materialization. No report/current-user rights or
-- historical coverage are established by a saved mirror generation.
CREATE TABLE app.neighborhood_frozen_source_generations (
  generation_id uuid PRIMARY KEY REFERENCES app.neighborhood_group_generations(generation_id) ON DELETE RESTRICT,
  format_version integer NOT NULL CHECK (format_version=1),
  status text NOT NULL CHECK (status IN ('building','complete')),
  source_snapshot text NOT NULL CHECK (octet_length(source_snapshot)<=65536),
  source_transaction_started_at timestamptz NOT NULL,
  completed_at timestamptz,
  layer_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(layer_counts)='object'),
  row_count bigint NOT NULL DEFAULT 0 CHECK (row_count BETWEEN 0 AND 14000000),
  payload_utf8_bytes bigint NOT NULL DEFAULT 0 CHECK (payload_utf8_bytes BETWEEN 0 AND 8000000000),
  CHECK ((status='complete')=(completed_at IS NOT NULL))
);
CREATE TABLE app.neighborhood_frozen_source_rows (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_frozen_source_generations(generation_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs')),
  row_key text COLLATE "C" NOT NULL CHECK (octet_length(row_key) BETWEEN 1 AND 256),
  account_id text,
  source_record_id bigint,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1000000),
  geom geometry(MultiPolygon,4326),
  PRIMARY KEY(generation_id,kind,row_key),
  CHECK (kind='parcels' OR geom IS NULL)
);
CREATE INDEX neighborhood_frozen_source_rows_account_idx
  ON app.neighborhood_frozen_source_rows(generation_id,kind,account_id,row_key COLLATE "C") WHERE account_id IS NOT NULL;
CREATE INDEX neighborhood_frozen_source_rows_source_idx
  ON app.neighborhood_frozen_source_rows(generation_id,kind,source_record_id,row_key COLLATE "C") WHERE source_record_id IS NOT NULL;
CREATE INDEX neighborhood_frozen_source_rows_geometry_idx
  ON app.neighborhood_frozen_source_rows USING gist(geom) WHERE kind='parcels';
CREATE INDEX neighborhood_frozen_source_rows_numeric_key_idx
  ON app.neighborhood_frozen_source_rows(generation_id,kind,(row_key::bigint))
  WHERE kind IN ('parcels','source_records','sales','sale_links');
CREATE INDEX neighborhood_frozen_source_rows_uuid_key_idx
  ON app.neighborhood_frozen_source_rows(generation_id,(row_key::uuid)) WHERE kind='sync_runs';

-- The published mirror is immutable, even before a job pins it. Deletion is
-- allowed only after the existing exclusive retirement claim, and the pin
-- guard independently prevents deletion while any job retains that version.
CREATE FUNCTION app.reject_published_neighborhood_frozen_source_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'neighborhood_frozen_source_truncate_refused' USING ERRCODE='55000';
  ELSIF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM old_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
      WHERE generation.retirement_started_at IS NULL) THEN
      RAISE EXCEPTION 'neighborhood_frozen_source_retirement_required' USING ERRCODE='55000';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM new_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
      WHERE generation.status<>'building') THEN
      RAISE EXCEPTION 'neighborhood_frozen_source_published' USING ERRCODE='55000';
    END IF;
    -- INSERT has no old_rows transition relation. Keep this a separate branch:
    -- PostgreSQL resolves query relations before evaluating a boolean AND.
    IF TG_OP='UPDATE' THEN
      IF EXISTS (SELECT 1 FROM old_rows changed
        JOIN app.neighborhood_group_generations generation USING(generation_id) WHERE generation.status<>'building') THEN
        RAISE EXCEPTION 'neighborhood_frozen_source_published' USING ERRCODE='55000';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['neighborhood_frozen_source_generations','neighborhood_frozen_source_rows'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON app.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()',relation||'_pin_insert',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON app.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()',relation||'_pin_update',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()',relation||'_pin_delete',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON app.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_published_neighborhood_frozen_source_mutation()',relation||'_published_insert',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON app.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_published_neighborhood_frozen_source_mutation()',relation||'_published_update',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_published_neighborhood_frozen_source_mutation()',relation||'_published_delete',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_published_neighborhood_frozen_source_mutation()',relation||'_published_truncate',relation);
  END LOOP;
END;
$$;
REVOKE TRUNCATE ON app.neighborhood_frozen_source_generations,app.neighborhood_frozen_source_rows FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_frozen_source_rows IS
  'Fixed allowlisted original mirror fields in one nightly source snapshot. No arbitrary raw MLS payload, document content, current source grant, historical-stock assertion or report publication. Writer opt-in remains disabled.';
