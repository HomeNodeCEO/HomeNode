-- A job may retain one completed prepared-data generation across worker
-- attempts. This is NOT an original-source/evidence/geometry/rights receipt.
ALTER TABLE app.neighborhood_group_generations
  ADD COLUMN retirement_started_at timestamptz;
ALTER TABLE app.neighborhood_custom_cohort_capture_jobs
  ADD CONSTRAINT neighborhood_custom_cohort_capture_jobs_pin_scope_key
  UNIQUE(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id);

CREATE TABLE app.neighborhood_custom_cohort_prepared_generation_pins (
  operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  actor_user_id uuid NOT NULL,
  generation_id uuid NOT NULL REFERENCES app.neighborhood_group_generations(generation_id) ON DELETE RESTRICT,
  pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id)
    REFERENCES app.neighborhood_custom_cohort_capture_jobs
      (operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX neighborhood_custom_cohort_prepared_generation_pins_generation_idx
  ON app.neighborhood_custom_cohort_prepared_generation_pins(generation_id);
CREATE TRIGGER neighborhood_custom_cohort_prepared_generation_pins_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_prepared_generation_pins
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_prepared_generation_pins FROM PUBLIC;
COMMENT ON TABLE app.neighborhood_custom_cohort_prepared_generation_pins IS
  'Internal exact-job prepared generation pin. Current owner still authorizes actor, assignment, subject and original source purposes. Not full source acquisition or report evidence. No automatic pin creation.';

-- Guard whole statements with transition tables, not one extra lookup per fact
-- row in the nightly writer. A failed statement rolls back its entire mutation.
CREATE FUNCTION app.reject_pinned_neighborhood_group_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    PERFORM 1 FROM app.neighborhood_group_generations ORDER BY generation_id FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM app.neighborhood_custom_cohort_prepared_generation_pins) THEN
      RAISE EXCEPTION 'neighborhood_prepared_generation_pinned' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='INSERT' THEN
    PERFORM 1 FROM app.neighborhood_group_generations generation
      JOIN (SELECT DISTINCT generation_id FROM new_rows) changed USING(generation_id)
      ORDER BY generation.generation_id FOR UPDATE OF generation NOWAIT;
    IF EXISTS (SELECT 1 FROM new_rows changed
      JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin USING(generation_id)) THEN
      RAISE EXCEPTION 'neighborhood_prepared_generation_pinned' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    PERFORM 1 FROM app.neighborhood_group_generations generation
      JOIN (SELECT DISTINCT generation_id FROM old_rows) changed USING(generation_id)
      ORDER BY generation.generation_id FOR UPDATE OF generation NOWAIT;
    IF EXISTS (SELECT 1 FROM old_rows changed
      JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin USING(generation_id)) THEN
      RAISE EXCEPTION 'neighborhood_prepared_generation_pinned' USING ERRCODE='55000';
    END IF;
  ELSE
    PERFORM 1 FROM app.neighborhood_group_generations generation
      JOIN (SELECT generation_id FROM old_rows UNION SELECT generation_id FROM new_rows) changed USING(generation_id)
      ORDER BY generation.generation_id FOR UPDATE OF generation NOWAIT;
    IF EXISTS (SELECT 1 FROM (SELECT generation_id FROM old_rows
      UNION SELECT generation_id FROM new_rows) changed
      JOIN app.neighborhood_custom_cohort_prepared_generation_pins pin USING(generation_id)) THEN
      RAISE EXCEPTION 'neighborhood_prepared_generation_pinned' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- Every prepared fact collection and its generation metadata is fenced. The
-- active pointer may advance to a NEW generation without modifying the old one.
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['neighborhood_group_generations','neighborhood_group_parcel_facts',
    'neighborhood_group_sale_facts','neighborhood_group_summary'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON app.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()', relation||'_pin_insert', relation);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON app.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()', relation||'_pin_update', relation);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON app.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()', relation||'_pin_delete', relation);
    EXECUTE format('CREATE TRIGGER %I AFTER TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_pinned_neighborhood_group_mutation()', relation||'_pin_truncate', relation);
  END LOOP;
END;
$$;
