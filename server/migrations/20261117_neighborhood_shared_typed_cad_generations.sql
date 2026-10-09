-- Dormant separate date-neutral CAD companion syntax cache. One exact generation/profile is
-- prepared once, not once per report. This is never a source or report grant.
CREATE TABLE app.neighborhood_frozen_typed_cad_generations (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_frozen_cad_improvement_generations(generation_id) ON DELETE RESTRICT,
  profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
  source_metadata jsonb NOT NULL CHECK(jsonb_typeof(source_metadata)='object' AND octet_length(source_metadata::text)<=8192),
  definition_json text NOT NULL CHECK(octet_length(definition_json) BETWEEN 1 AND 65536),
  CHECK(profile_sha256=encode(sha256(convert_to(definition_json,'UTF8')),'hex')),
  progress jsonb NOT NULL CHECK(jsonb_typeof(progress)='object' AND octet_length(progress::text)<=2048),
  status text NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete')),
  completed_at timestamptz,
  CHECK((status='complete')=(completed_at IS NOT NULL)),
  PRIMARY KEY(generation_id,profile_sha256)
);
CREATE TABLE app.neighborhood_frozen_typed_cad_rows (
  generation_id uuid NOT NULL,
  profile_sha256 text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('primary','secondary')),
  row_key text COLLATE "C" NOT NULL,
  account_id text COLLATE "C" NOT NULL,
  original_payload_sha256 text NOT NULL CHECK(original_payload_sha256 ~ '^[a-f0-9]{64}$'),
  typed jsonb NOT NULL CHECK(jsonb_typeof(typed)='object' AND octet_length(typed::text)<=32768),
  typed_utf8_bytes integer GENERATED ALWAYS AS (octet_length(typed::text)) STORED,
  CHECK(coalesce(typed->>'typed_CAD_improvement_version'='1' AND typed->'original'->>'kind'=kind
    AND typed->'original'->>'row_key'=row_key AND typed->'original'->>'payload_sha256'=original_payload_sha256
    AND typed->'interpretation_profile_ref'->>'content_sha256'=profile_sha256
    AND typed->>'temporal_basis'='date_neutral_original_syntax' AND NOT (typed ? 'effective_date')
    AND (typed->>'account_id') IS NOT DISTINCT FROM account_id,false)),
  PRIMARY KEY(generation_id,profile_sha256,kind,row_key),
  FOREIGN KEY(generation_id,profile_sha256)
    REFERENCES app.neighborhood_frozen_typed_cad_generations(generation_id,profile_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY(generation_id,kind,row_key)
    REFERENCES app.neighborhood_frozen_cad_improvement_rows(generation_id,kind,row_key) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_shared_typed_cad_account_idx
  ON app.neighborhood_frozen_typed_cad_rows(generation_id,profile_sha256,kind,account_id,row_key) WHERE account_id IS NOT NULL;
-- Also backs original-row FK checks during bounded retirement, without scanning
-- every cached profile for every deleted original.
CREATE INDEX neighborhood_shared_typed_cad_original_idx
  ON app.neighborhood_frozen_typed_cad_rows(generation_id,kind,row_key);

-- Exact INSERT-transition totals, not caller-supplied progress. Two small
-- rows per cache keep final verification bounded even at the logical ceiling.
CREATE TABLE app.neighborhood_frozen_typed_cad_totals (
  generation_id uuid NOT NULL,
  profile_sha256 text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('primary','secondary')),
  row_count bigint NOT NULL CHECK(row_count BETWEEN 1 AND 2000000),
  typed_utf8_bytes bigint NOT NULL CHECK(typed_utf8_bytes BETWEEN row_count AND 8000000000),
  PRIMARY KEY(generation_id,profile_sha256,kind),
  FOREIGN KEY(generation_id,profile_sha256)
    REFERENCES app.neighborhood_frozen_typed_cad_generations(generation_id,profile_sha256) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE FUNCTION app.guard_neighborhood_shared_typed_cad_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The cache-row AFTER INSERT statement trigger is the only DML producer.
  -- Direct application writes, session flags and caller progress cannot change
  -- totals. Privileged database-owner DDL is outside this storage contract.
  IF pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_totals_derived_only' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_shared_typed_cad_totals_derived BEFORE INSERT OR UPDATE
  ON app.neighborhood_frozen_typed_cad_totals FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_shared_typed_cad_totals();

CREATE FUNCTION app.guard_neighborhood_shared_typed_cad_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE totals jsonb; actual_rows bigint; actual_bytes bigint; originals jsonb;
  source app.neighborhood_frozen_cad_improvement_generations;
BEGIN
  IF TG_OP='DELETE' THEN
    RETURN OLD; -- Separate statement guards require exclusive retirement and no pins.
  END IF;
  PERFORM 1 FROM app.neighborhood_group_generations
    WHERE generation_id=NEW.generation_id AND status='complete' AND retirement_started_at IS NULL FOR SHARE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_source_unavailable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO source FROM app.neighborhood_frozen_cad_improvement_generations WHERE generation_id=NEW.generation_id;
  IF source.status IS DISTINCT FROM 'complete' OR source.format_version IS DISTINCT FROM 1
    OR NEW.source_metadata->>'status' IS DISTINCT FROM 'complete' OR NEW.source_metadata->>'format_version' IS DISTINCT FROM '1'
    OR NEW.progress->>'format' IS DISTINCT FROM 'shared_frozen_typed_CAD_progress_v1'
    OR NEW.source_metadata->>'generation_id' IS DISTINCT FROM NEW.generation_id::text
    OR NEW.source_metadata->>'source_profile_sha256' IS DISTINCT FROM source.profile_sha256
    OR NEW.source_metadata->>'source_definition_json' IS DISTINCT FROM source.definition_json
    OR NEW.source_metadata->>'source_snapshot' IS DISTINCT FROM source.source_snapshot
    OR NEW.source_metadata->'layer_counts' IS DISTINCT FROM source.layer_counts
    OR NEW.source_metadata->>'row_count' IS DISTINCT FROM source.row_count::text
    OR NEW.source_metadata->>'payload_utf8_bytes' IS DISTINCT FROM source.payload_utf8_bytes::text
    OR NEW.source_metadata->>'started_at' IS DISTINCT FROM to_char(source.source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR NEW.source_metadata->>'completed_at' IS DISTINCT FROM to_char(source.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_source_metadata_mismatch' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' OR NOT EXISTS(SELECT 1 FROM app.neighborhood_frozen_cad_improvement_generations
      WHERE generation_id=NEW.generation_id AND status='complete' AND format_version=1) THEN
      RAISE EXCEPTION 'neighborhood_shared_typed_cad_initial_state_required' USING ERRCODE='55000';
    END IF;
  ELSIF OLD.status<>'building' OR (to_jsonb(NEW)-ARRAY['status','progress','completed_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','progress','completed_at']) THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='complete' THEN
    SELECT jsonb_object_agg(kind,row_count),coalesce(sum(row_count),0),coalesce(sum(typed_utf8_bytes),0)
      INTO totals,actual_rows,actual_bytes FROM app.neighborhood_frozen_typed_cad_totals
      WHERE generation_id=NEW.generation_id AND profile_sha256=NEW.profile_sha256;
    SELECT layer_counts INTO originals FROM app.neighborhood_frozen_cad_improvement_generations WHERE generation_id=NEW.generation_id;
    IF EXISTS(SELECT 1 FROM jsonb_each(originals) layer
        WHERE coalesce(totals->>layer.key,'0') IS DISTINCT FROM layer.value->>'row_count')
      OR NEW.progress->>'kind_index' IS DISTINCT FROM '2'
      OR NEW.progress->>'after' IS DISTINCT FROM '' OR NEW.progress->>'layer_rows' IS DISTINCT FROM '0'
      OR NEW.progress->>'typed_rows' IS DISTINCT FROM actual_rows::text
      OR NEW.progress->>'typed_utf8_bytes' IS DISTINCT FROM actual_bytes::text THEN
      RAISE EXCEPTION 'neighborhood_shared_typed_cad_population_incomplete' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_shared_typed_cad_header_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_frozen_typed_cad_generations FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_shared_typed_cad_header();
CREATE FUNCTION app.guard_neighborhood_shared_typed_cad_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.neighborhood_group_generations generation
    JOIN (SELECT DISTINCT generation_id FROM new_rows) changed USING(generation_id)
    ORDER BY generation.generation_id FOR SHARE OF generation NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
    WHERE generation.status<>'complete' OR generation.retirement_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_source_unavailable' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM app.neighborhood_frozen_typed_cad_generations header
    JOIN (SELECT DISTINCT generation_id,profile_sha256 FROM new_rows) changed
      USING(generation_id,profile_sha256)
    ORDER BY header.generation_id,header.profile_sha256 FOR SHARE OF header NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_frozen_typed_cad_generations header
    USING(generation_id,profile_sha256) WHERE header.status<>'building') THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_immutable' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM new_rows changed
    JOIN app.neighborhood_frozen_cad_improvement_rows original USING(generation_id,kind,row_key)
    JOIN app.neighborhood_frozen_cad_improvement_generations source USING(generation_id)
    JOIN app.neighborhood_frozen_typed_cad_generations header ON header.generation_id=changed.generation_id AND header.profile_sha256=changed.profile_sha256
    WHERE changed.original_payload_sha256<>original.payload_sha256 OR changed.account_id<>original.account_id
      OR changed.typed->'original'->>'payload_utf8_bytes' IS DISTINCT FROM original.payload_utf8_bytes::text
      OR changed.typed->'original'->'original_profile_ref' IS DISTINCT FROM jsonb_build_object('id',source.definition_json::jsonb->>'id',
        'revision',source.definition_json::jsonb->>'revision','content_sha256',source.profile_sha256)
      OR changed.typed->'interpretation_profile_ref' IS DISTINCT FROM jsonb_build_object('id',header.definition_json::jsonb->>'id',
        'revision',header.definition_json::jsonb->>'revision','content_sha256',header.profile_sha256)) THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_original_mismatch' USING ERRCODE='55000';
  END IF;
  INSERT INTO app.neighborhood_frozen_typed_cad_totals AS totals
    (generation_id,profile_sha256,kind,row_count,typed_utf8_bytes)
    SELECT generation_id,profile_sha256,kind,count(*),sum(typed_utf8_bytes)
      FROM new_rows GROUP BY generation_id,profile_sha256,kind
      ORDER BY generation_id,profile_sha256,kind
    ON CONFLICT(generation_id,profile_sha256,kind) DO UPDATE
      SET row_count=totals.row_count+EXCLUDED.row_count,
          typed_utf8_bytes=totals.typed_utf8_bytes+EXCLUDED.typed_utf8_bytes;
  RETURN NULL;
END;
$$;
CREATE TRIGGER neighborhood_shared_typed_cad_row_insert_guard AFTER INSERT
  ON app.neighborhood_frozen_typed_cad_rows REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_shared_typed_cad_rows();
CREATE TRIGGER neighborhood_shared_typed_cad_row_update BEFORE UPDATE
  ON app.neighborhood_frozen_typed_cad_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE FUNCTION app.guard_neighborhood_shared_typed_cad_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM old_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
    WHERE generation.retirement_started_at IS NULL) THEN
    RAISE EXCEPTION 'neighborhood_shared_typed_cad_retirement_required' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['neighborhood_frozen_typed_cad_generations','neighborhood_frozen_typed_cad_rows','neighborhood_frozen_typed_cad_totals'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()',relation||'_pin_delete',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_shared_typed_cad_retirement()',relation||'_retire_delete',relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation()',relation||'_truncate',relation);
  END LOOP;
END;
$$;
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_frozen_typed_cad_rows FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_frozen_typed_cad_generations FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.neighborhood_frozen_typed_cad_totals FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_frozen_typed_cad_generations IS
  'Reusable immutable whole-generation date-neutral CAD individual-row syntax, separate exact CAD profile. Consumers must apply retained effective-year and period rules before account resolution or statistics. Not acquisition, current rights, historical stock, selected statistics or report evidence. No schedule, worker, job or HTTP activation.';
