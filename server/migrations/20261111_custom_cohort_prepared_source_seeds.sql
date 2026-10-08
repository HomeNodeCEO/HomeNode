-- One indexed all-date, one-hop seed set for an exact completed job stock.
-- This cache is DATA only. The current licensed capture owner is still required
-- before preparation/use and before commit; no linked account becomes stock.
CREATE TABLE app.neighborhood_custom_cohort_seed_indexes (
  operation_id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  binding_sha256 text NOT NULL CHECK(binding_sha256 ~ '^[a-f0-9]{64}$'),
  definition_sha256 text NOT NULL CHECK(definition_sha256 ~ '^[a-f0-9]{64}$'),
  definition_json text NOT NULL CHECK(octet_length(definition_json) BETWEEN 2 AND 8192),
  status text NOT NULL DEFAULT 'building' CHECK(status IN ('building','complete')),
  seed_count bigint NOT NULL DEFAULT 0 CHECK(seed_count BETWEEN 0 AND 6000000),
  completed_at timestamptz,
  CHECK((status='complete')=(completed_at IS NOT NULL)),
  UNIQUE(operation_id,generation_id),
  FOREIGN KEY(operation_id,generation_id)
    REFERENCES app.neighborhood_custom_cohort_job_stocks(operation_id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE app.neighborhood_custom_cohort_source_seeds (
  operation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  source_record_id bigint NOT NULL,
  PRIMARY KEY(operation_id,source_record_id),
  FOREIGN KEY(operation_id,generation_id)
    REFERENCES app.neighborhood_custom_cohort_seed_indexes(operation_id,generation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- No FK to the target source record: a dangling seeded link must be retained,
-- then explicitly refused by identity verification, never silently omitted.
CREATE FUNCTION app.guard_neighborhood_cohort_seed_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_count bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'building' OR NEW.seed_count<>0 OR NOT EXISTS(
      SELECT 1 FROM app.neighborhood_custom_cohort_job_stocks stock
      WHERE stock.operation_id=NEW.operation_id AND stock.generation_id=NEW.generation_id AND stock.status='complete') THEN
      RAISE EXCEPTION 'neighborhood_seed_initial_state_required' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF OLD.status<>'building' OR NEW.status<>'complete'
      OR (to_jsonb(NEW)-ARRAY['status','seed_count','completed_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','seed_count','completed_at']) THEN
      RAISE EXCEPTION 'neighborhood_seed_index_immutable' USING ERRCODE='55000';
    END IF;
    SELECT count(*) INTO actual_count FROM app.neighborhood_custom_cohort_source_seeds
      WHERE operation_id=NEW.operation_id AND generation_id=NEW.generation_id;
    IF actual_count<>NEW.seed_count OR EXISTS(
      WITH expected AS MATERIALIZED (
        SELECT DISTINCT original.source_record_id
        FROM app.neighborhood_custom_cohort_stock_accounts stock
        JOIN app.neighborhood_frozen_source_rows original ON original.account_id=stock.account_id
        WHERE stock.operation_id=NEW.operation_id AND original.generation_id=NEW.generation_id
          AND original.kind IN ('source_records','sales','sale_links') AND original.source_record_id IS NOT NULL
      ), actual AS MATERIALIZED (
        SELECT source_record_id FROM app.neighborhood_custom_cohort_source_seeds
        WHERE operation_id=NEW.operation_id AND generation_id=NEW.generation_id
      ) SELECT 1 FROM ((SELECT source_record_id FROM expected EXCEPT SELECT source_record_id FROM actual)
        UNION ALL (SELECT source_record_id FROM actual EXCEPT SELECT source_record_id FROM expected)) different
    ) THEN
      RAISE EXCEPTION 'neighborhood_seed_index_incomplete' USING ERRCODE='55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'neighborhood_seed_index_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER neighborhood_cohort_seed_header_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_seed_indexes FOR EACH ROW EXECUTE FUNCTION app.guard_neighborhood_cohort_seed_header();
CREATE FUNCTION app.guard_neighborhood_cohort_seed_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.neighborhood_custom_cohort_seed_indexes header
    JOIN (SELECT DISTINCT operation_id FROM new_rows) changed USING(operation_id)
    ORDER BY header.operation_id FOR SHARE OF header NOWAIT;
  IF EXISTS(SELECT 1 FROM new_rows changed JOIN app.neighborhood_custom_cohort_seed_indexes header USING(operation_id)
    WHERE header.status<>'building') THEN
    RAISE EXCEPTION 'neighborhood_seed_index_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER neighborhood_cohort_source_seed_insert_guard AFTER INSERT
  ON app.neighborhood_custom_cohort_source_seeds REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_neighborhood_cohort_seed_insert();
CREATE TRIGGER neighborhood_cohort_source_seed_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON app.neighborhood_custom_cohort_source_seeds FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
CREATE TRIGGER neighborhood_cohort_seed_header_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_seed_indexes FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_source_seeds FROM PUBLIC;
REVOKE DELETE,TRUNCATE ON app.neighborhood_custom_cohort_seed_indexes FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_seed_indexes IS
  'Exact job-stock seeded transaction lookup only, not a source license, complete acquisition or report result. No routes, workers or schedules activated. Terminal transfer/retirement remains a separate owner.';
