-- Inactive additive companion originals, captured only in the very same
-- snapshot/transaction as format-1 source originals. No legacy backfill.
-- Exact C-order keyset pages must not repeatedly sort a city-sized source.
CREATE INDEX IF NOT EXISTS neighborhood_cad_primary_original_key_idx ON core.primary_improvements(account_id COLLATE "C");
CREATE TABLE app.neighborhood_frozen_cad_improvement_generations (
  generation_id uuid PRIMARY KEY REFERENCES app.neighborhood_frozen_source_generations(generation_id) ON DELETE RESTRICT,
  format_version integer NOT NULL CHECK(format_version=1),
  status text NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete')),
  source_snapshot text NOT NULL CHECK(octet_length(source_snapshot) BETWEEN 1 AND 65536),
  source_transaction_started_at timestamptz NOT NULL,
  profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  definition_json text NOT NULL CHECK(octet_length(definition_json) BETWEEN 1 AND 65536),
  CHECK(profile_sha256=encode(sha256(convert_to(definition_json,'UTF8')),'hex')),
  expected_counts jsonb NOT NULL CHECK(jsonb_typeof(expected_counts)='object'
    AND expected_counts ?& ARRAY['primary','secondary'] AND (expected_counts-ARRAY['primary','secondary'])='{}'::jsonb
    AND jsonb_typeof(expected_counts->'primary')='string' AND jsonb_typeof(expected_counts->'secondary')='string'
    AND expected_counts->>'primary' ~ '^(0|[1-9][0-9]{0,6})$' AND expected_counts->>'secondary' ~ '^(0|[1-9][0-9]{0,6})$'
    AND octet_length(expected_counts::text)<=1024),
  layer_counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(layer_counts)='object' AND octet_length(layer_counts::text)<=2048),
  row_count bigint NOT NULL DEFAULT 0 CHECK(row_count BETWEEN 0 AND 4000000),
  payload_utf8_bytes bigint NOT NULL DEFAULT 0 CHECK(payload_utf8_bytes BETWEEN row_count AND 8000000000),
  completed_at timestamptz,
  CHECK((status='complete')=(completed_at IS NOT NULL))
);
CREATE TABLE app.neighborhood_frozen_cad_improvement_rows (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_frozen_cad_improvement_generations(generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('primary','secondary')),
  row_key text COLLATE "C" NOT NULL CHECK(octet_length(row_key) BETWEEN 1 AND 256),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 64),
  account_kind text NOT NULL DEFAULT 'accounts' CHECK(account_kind='accounts'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1000000),
  -- convert_to is STABLE, so PostgreSQL cannot use it in a generated column.
  -- Fixed INSERT SQL derives these values and native CHECKs acknowledge the
  -- actual JSONB bytes; caller-supplied values cannot relabel a payload.
  payload_utf8_bytes integer NOT NULL CHECK(payload_utf8_bytes=octet_length(payload::text)),
  payload_sha256 text NOT NULL CHECK(payload_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex')),
  CHECK(coalesce(payload->>'account_id'=account_id AND CASE WHEN kind='primary'
    THEN row_key=account_id AND payload ?& ARRAY['account_id','year_built','living_area_sqft','bedroom_count','bath_count','number_units','pool']
      AND (payload-ARRAY['account_id','year_built','living_area_sqft','bedroom_count','bath_count','number_units','pool'])='{}'::jsonb
    ELSE payload->>'id'=row_key AND row_key ~ '^[1-9][0-9]{0,18}$'
      AND payload ?& ARRAY['id','account_id','sec_imp_number','sec_imp_type','sec_imp_sqft']
      AND (payload-ARRAY['id','account_id','sec_imp_number','sec_imp_type','sec_imp_sqft'])='{}'::jsonb END,false)),
  CHECK(CASE WHEN kind='secondary' THEN CASE WHEN row_key ~ '^[1-9][0-9]{0,18}$'
    THEN row_key::numeric<=9223372036854775807 ELSE false END ELSE true END),
  PRIMARY KEY(generation_id,kind,row_key),
  FOREIGN KEY(generation_id,account_kind,account_id) REFERENCES app.neighborhood_frozen_source_rows(generation_id,kind,row_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_frozen_cad_account_idx ON app.neighborhood_frozen_cad_improvement_rows(generation_id,account_id,kind,row_key);
CREATE TABLE app.neighborhood_frozen_cad_improvement_totals (
  generation_id uuid NOT NULL REFERENCES app.neighborhood_frozen_cad_improvement_generations(generation_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('primary','secondary')),
  row_count bigint NOT NULL CHECK(row_count BETWEEN 1 AND 2000000),
  payload_utf8_bytes bigint NOT NULL CHECK(payload_utf8_bytes BETWEEN row_count AND 8000000000),
  PRIMARY KEY(generation_id,kind)
);
CREATE FUNCTION app.guard_neighborhood_frozen_cad_totals() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'neighborhood_frozen_cad_totals_derived_only' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_frozen_cad_totals_derived BEFORE INSERT OR UPDATE ON app.neighborhood_frozen_cad_improvement_totals
  FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_frozen_cad_totals();
CREATE FUNCTION app.guard_neighborhood_frozen_cad_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source app.neighborhood_frozen_source_generations; counts jsonb; actual_rows bigint; actual_bytes bigint;
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; -- Statement guards enforce retirement and pins.
  PERFORM 1 FROM app.neighborhood_group_generations WHERE generation_id=NEW.generation_id
    AND status='building' AND retirement_started_at IS NULL FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'neighborhood_frozen_cad_building_generation_required' USING ERRCODE='55000'; END IF;
  SELECT * INTO source FROM app.neighborhood_frozen_source_generations WHERE generation_id=NEW.generation_id;
  IF source.status IS DISTINCT FROM 'complete' OR source.format_version IS DISTINCT FROM 1
    OR source.source_snapshot IS DISTINCT FROM NEW.source_snapshot
    OR source.source_transaction_started_at IS DISTINCT FROM NEW.source_transaction_started_at
    OR NEW.source_snapshot IS DISTINCT FROM pg_current_snapshot()::text
    OR NEW.source_transaction_started_at IS DISTINCT FROM transaction_timestamp()
    OR current_setting('transaction_isolation')<>'repeatable read'
    OR current_setting('transaction_read_only')<>'off' OR current_setting('TimeZone')<>'UTC' THEN
    RAISE EXCEPTION 'neighborhood_frozen_cad_same_snapshot_required' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' OR NEW.row_count<>0 OR NEW.payload_utf8_bytes<>0 OR NEW.layer_counts<>'{}'::jsonb THEN
      RAISE EXCEPTION 'neighborhood_frozen_cad_initial_state_required' USING ERRCODE='55000'; END IF;
    -- Independent whole-source counts in this same stable snapshot. Caller
    -- metadata cannot declare an empty/prefix population and complete it.
    IF NEW.expected_counts->>'primary' IS DISTINCT FROM (SELECT count(*)::text FROM core.primary_improvements)
      OR NEW.expected_counts->>'secondary' IS DISTINCT FROM (SELECT count(*)::text FROM core.secondary_improvements) THEN
      RAISE EXCEPTION 'neighborhood_frozen_cad_source_counts_mismatch' USING ERRCODE='55000'; END IF;
  ELSIF OLD.status<>'building' OR (to_jsonb(NEW)-ARRAY['status','layer_counts','row_count','payload_utf8_bytes','completed_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','layer_counts','row_count','payload_utf8_bytes','completed_at']) THEN
    RAISE EXCEPTION 'neighborhood_frozen_cad_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status='complete' THEN
    SELECT coalesce(jsonb_object_agg(kind,jsonb_build_object('row_count',row_count::text,'payload_utf8_bytes',payload_utf8_bytes::text)), '{}'::jsonb),
      coalesce(sum(row_count),0),coalesce(sum(payload_utf8_bytes),0) INTO counts,actual_rows,actual_bytes
      FROM app.neighborhood_frozen_cad_improvement_totals WHERE generation_id=NEW.generation_id;
    counts=jsonb_build_object('primary',coalesce(counts->'primary','{"row_count":"0","payload_utf8_bytes":"0"}'::jsonb),
      'secondary',coalesce(counts->'secondary','{"row_count":"0","payload_utf8_bytes":"0"}'::jsonb));
    IF NEW.layer_counts IS DISTINCT FROM counts OR NEW.row_count<>actual_rows OR NEW.payload_utf8_bytes<>actual_bytes
      OR NEW.expected_counts->>'primary' IS DISTINCT FROM counts->'primary'->>'row_count'
      OR NEW.expected_counts->>'secondary' IS DISTINCT FROM counts->'secondary'->>'row_count' THEN
      RAISE EXCEPTION 'neighborhood_frozen_cad_population_incomplete' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_frozen_cad_header_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_frozen_cad_improvement_generations
  FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_frozen_cad_header();
CREATE FUNCTION app.guard_neighborhood_frozen_cad_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.neighborhood_group_generations generation JOIN (SELECT DISTINCT generation_id FROM new_rows) changed USING(generation_id)
    ORDER BY generation.generation_id FOR UPDATE OF generation NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
    JOIN app.neighborhood_frozen_cad_improvement_generations header USING(generation_id)
    WHERE generation.status<>'building' OR generation.retirement_started_at IS NOT NULL OR header.status<>'building'
      OR header.source_snapshot<>pg_current_snapshot()::text OR header.source_transaction_started_at<>transaction_timestamp()
      OR current_setting('transaction_isolation')<>'repeatable read' OR current_setting('TimeZone')<>'UTC') THEN
    RAISE EXCEPTION 'neighborhood_frozen_cad_same_building_snapshot_required' USING ERRCODE='55000'; END IF;
  -- Exact fixed-column source acknowledgement via native PK probes, not an
  -- inferred summary or a caller's hash. Retain NULLs and decimal text verbatim.
  IF EXISTS(SELECT 1 FROM new_rows changed LEFT JOIN core.primary_improvements p ON p.account_id=changed.row_key
    WHERE changed.kind='primary' AND (p.account_id IS NULL OR changed.payload IS DISTINCT FROM
      (SELECT to_jsonb(projected) FROM (SELECT p.account_id,p.year_built::text,p.living_area_sqft::text,
        p.bedroom_count::text,p.bath_count::text,p.number_units::text,p.pool) projected)))
    OR EXISTS(SELECT 1 FROM new_rows changed LEFT JOIN core.secondary_improvements s
      ON s.id=CASE WHEN changed.kind='secondary' THEN changed.row_key::bigint ELSE NULL END
      WHERE changed.kind='secondary' AND (s.id IS NULL OR changed.payload IS DISTINCT FROM
        (SELECT to_jsonb(projected) FROM (SELECT s.id::text,s.account_id,s.sec_imp_number::text,s.sec_imp_type,s.sec_imp_sqft::text) projected))) THEN
    RAISE EXCEPTION 'neighborhood_frozen_cad_original_mismatch' USING ERRCODE='55000'; END IF;
  INSERT INTO app.neighborhood_frozen_cad_improvement_totals AS totals(generation_id,kind,row_count,payload_utf8_bytes)
    SELECT generation_id,kind,count(*),sum(payload_utf8_bytes) FROM new_rows GROUP BY generation_id,kind ORDER BY generation_id,kind
    ON CONFLICT(generation_id,kind) DO UPDATE SET row_count=totals.row_count+EXCLUDED.row_count,
      payload_utf8_bytes=totals.payload_utf8_bytes+EXCLUDED.payload_utf8_bytes;
  RETURN NULL;
END;
$$;
CREATE TRIGGER neighborhood_frozen_cad_row_insert AFTER INSERT ON app.neighborhood_frozen_cad_improvement_rows REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_frozen_cad_insert();
CREATE TRIGGER neighborhood_frozen_cad_row_update BEFORE UPDATE ON app.neighborhood_frozen_cad_improvement_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE FUNCTION app.guard_neighborhood_frozen_cad_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM old_rows changed JOIN app.neighborhood_group_generations generation USING(generation_id)
    WHERE generation.retirement_started_at IS NULL) THEN RAISE EXCEPTION 'neighborhood_frozen_cad_retirement_required' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END;
$$;
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['neighborhood_frozen_cad_improvement_rows','neighborhood_frozen_cad_improvement_totals','neighborhood_frozen_cad_improvement_generations'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()',relation||'_pin_delete',relation);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_frozen_cad_retirement()',relation||'_retire_delete',relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation()',relation||'_truncate',relation);
  END LOOP;
END;
$$;
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_frozen_cad_improvement_rows FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_frozen_cad_improvement_generations FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.neighborhood_frozen_cad_improvement_totals FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_frozen_cad_improvement_generations IS
  'Same-snapshot immutable local CAD improvement originals. Not summaries, verified measurements, historical stock, source rights, job acquisition or report evidence. No default activation or backfill.';
