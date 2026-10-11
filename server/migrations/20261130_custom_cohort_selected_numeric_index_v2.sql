-- INACTIVE numeric index of ORIGINAL-RECONCILED eighth-pass contributions.
-- This is a child of each contribution, not another source grant or population.
-- No historical backfill: pre-index operations cannot acquire numeric authority
-- from old hashes/counts. Every later semantic pass must reopen originals AGAIN.
CREATE FUNCTION app.neighborhood_selected_numeric_index_v2_decimal(value text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  -- Validate BEFORE the unbounded-exact numeric cast. No numeric(p,s) rounding,
  -- float, exponent, negative, whitespace, NaN/Infinity or noncanonical zero.
  IF length(value)>31 OR value !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
    OR length(replace(value,'.',''))>30
    OR length(split_part(value,'.',2))>12 THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_decimal_invalid' USING ERRCODE='55000';
  END IF;
  RETURN value::numeric;
END $$;

CREATE FUNCTION app.neighborhood_selected_numeric_index_v2_cell(cell jsonb,metric text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE value numeric; unit text;
BEGIN
  IF metric NOT IN ('reported_year_built','reported_residential_area','reported_site_area') OR metric IS NULL
    OR jsonb_typeof(cell) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(cell))<>8
    OR (cell-ARRAY['reported_value_state','complete_observed_parts','recorded_comparison_eligible','contribution_exact_value',
      'contribution_unit','exclusion_reasons','source_part_count','part_counts'])<>'{}'::jsonb
    OR cell->>'reported_value_state' IS NULL
    OR cell->>'reported_value_state' NOT IN ('observed','missing','invalid','conflicting','unsupported')
    OR jsonb_typeof(cell->'recorded_comparison_eligible') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_cell_invalid' USING ERRCODE='55000'; END IF;
  IF cell->>'recorded_comparison_eligible'='false' THEN
    IF cell->'contribution_exact_value' IS DISTINCT FROM 'null'::jsonb OR cell->'contribution_unit' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_cell_invalid' USING ERRCODE='55000'; END IF;
    RETURN NULL;
  END IF;
  unit:=CASE WHEN metric='reported_year_built' THEN 'year' ELSE 'reported_sqft' END;
  IF cell->>'reported_value_state' IS DISTINCT FROM 'observed' OR cell->'complete_observed_parts' IS DISTINCT FROM 'true'::jsonb
    OR cell->>'contribution_unit' IS DISTINCT FROM unit
    OR jsonb_typeof(cell->'contribution_exact_value') IS DISTINCT FROM 'string'
    OR cell->'exclusion_reasons' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_cell_invalid' USING ERRCODE='55000'; END IF;
  value:=app.neighborhood_selected_numeric_index_v2_decimal(cell->>'contribution_exact_value');
  IF (metric='reported_year_built' AND (cell->>'contribution_exact_value' !~ '^[1-9][0-9]{3}$' OR value<1600))
    OR (metric='reported_residential_area' AND value=0) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_cell_invalid' USING ERRCODE='55000'; END IF;
  RETURN value;
END $$;

CREATE TABLE app.neighborhood_custom_cohort_selected_numeric_index_v2_rows (
  operation_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2000000),
  account_id text COLLATE "C" NOT NULL CHECK(octet_length(account_id) BETWEEN 1 AND 256),
  contribution_row_reference jsonb NOT NULL CHECK(octet_length(contribution_row_reference::text) BETWEEN 100 AND 256),
  reported_year_built numeric,
  reported_residential_area numeric,
  reported_site_area numeric,
  PRIMARY KEY(operation_id,ordinal), UNIQUE(operation_id,account_id),
  FOREIGN KEY(operation_id,ordinal) REFERENCES app.neighborhood_custom_cohort_selected_statistics_v2_rows(operation_id,ordinal)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- One native selected ACCOUNT per observation, equal values retain multiplicity.
-- Exact native ordering and a stable ordinal tie-breaker; no floating conversion,
-- OFFSET scan, averaged page median, full-population JSON or callback authority.
CREATE INDEX neighborhood_selected_numeric_year_v2_idx
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows(operation_id,reported_year_built,ordinal)
  INCLUDE(account_id) WHERE reported_year_built IS NOT NULL;
CREATE INDEX neighborhood_selected_numeric_residential_v2_idx
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows(operation_id,reported_residential_area,ordinal)
  INCLUDE(account_id) WHERE reported_residential_area IS NOT NULL;
CREATE INDEX neighborhood_selected_numeric_site_v2_idx
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows(operation_id,reported_site_area,ordinal)
  INCLUDE(account_id) WHERE reported_site_area IS NOT NULL;

CREATE FUNCTION app.guard_neighborhood_selected_numeric_index_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job app.neighborhood_custom_cohort_capture_jobs%ROWTYPE;
  head app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE;
  member app.neighborhood_custom_cohort_selected_statistics_v2_rows%ROWTYPE; body jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO STRICT job FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=NEW.operation_id;
  SELECT * INTO head FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT * INTO STRICT member FROM app.neighborhood_custom_cohort_selected_statistics_v2_rows
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.ordinal;
  IF job.organization_id<>NEW.organization_id OR job.status<>'running' OR job.claim_token IS NULL
    OR job.lease_expires_at<=clock_timestamp() OR job.cancellation_requested_at IS NOT NULL OR job.context_sha256 IS NOT NULL
    OR NEW.ordinal<>coalesce(head.sequence,0)+1 OR NEW.account_id<>member.account_id
    OR NEW.contribution_row_reference IS DISTINCT FROM member.row_reference
    OR NOT app.neighborhood_selected_statistics_v2_admission_matches(NEW.operation_id,NEW.organization_id,job.checkpoint) THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_binding_conflict' USING ERRCODE='55000'; END IF;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=member.row_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=member.row_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  IF body->>'format' IS DISTINCT FROM 'cohort_selected_statistics_contribution_v2'
    OR NEW.reported_year_built IS DISTINCT FROM app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_year_built','reported_year_built')
    OR NEW.reported_residential_area IS DISTINCT FROM app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_residential_area','reported_residential_area')
    OR NEW.reported_site_area IS DISTINCT FROM app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_site_area','reported_site_area') THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_value_conflict' USING ERRCODE='55000'; END IF;
  -- The existing eighth head checks EVERY closed contribution/metric field,
  -- parent, date, subject and reason. Its deferred commit requires the atomic
  -- job exact14 checkpoint + single-use continuation. This child cannot mint it.
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_numeric_index_v2_row_guard BEFORE INSERT OR UPDATE OR DELETE
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows FOR EACH ROW
  EXECUTE FUNCTION app.guard_neighborhood_selected_numeric_index_v2_row();
CREATE TRIGGER neighborhood_selected_numeric_index_v2_row_truncate BEFORE TRUNCATE
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();

CREATE FUNCTION app.insert_neighborhood_selected_numeric_index_v2_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body jsonb;
BEGIN
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.row_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.row_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=4096;
  INSERT INTO app.neighborhood_custom_cohort_selected_numeric_index_v2_rows
    (operation_id,organization_id,ordinal,account_id,contribution_row_reference,reported_year_built,reported_residential_area,reported_site_area)
  VALUES(NEW.operation_id,NEW.organization_id,NEW.ordinal,NEW.account_id,NEW.row_reference,
    app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_year_built','reported_year_built'),
    app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_residential_area','reported_residential_area'),
    app.neighborhood_selected_numeric_index_v2_cell(body->'metrics'->'reported_site_area','reported_site_area'));
  RETURN NEW;
END $$;
-- No caller projection write API: the existing ACTUAL bounded owner reaches
-- this hook only after fresh whole originals/ENTIRE caches, EVERY seventh field,
-- fresh policy and ALL ending source/actor/assignment/draft/subject/claim fences.
CREATE TRIGGER neighborhood_selected_numeric_index_v2_from_contribution AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_statistics_v2_rows FOR EACH ROW
  EXECUTE FUNCTION app.insert_neighborhood_selected_numeric_index_v2_row();

CREATE FUNCTION app.check_neighborhood_selected_numeric_index_v2_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head app.neighborhood_custom_cohort_selected_statistics_v2_heads%ROWTYPE; body jsonb;
BEGIN
  SELECT * INTO STRICT head FROM app.neighborhood_custom_cohort_selected_statistics_v2_heads
    WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=head.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=head.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF head.sequence<>NEW.ordinal OR body->'row_reference' IS DISTINCT FROM NEW.contribution_row_reference
    OR body->'selected_entry'->>'account_id' IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_orphan_row' USING ERRCODE='55000'; END IF;
  -- Also run the existing head's actual exact14 + continuation commit fence.
  -- Its independently deferred trigger executes in the SAME real COMMIT.
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER neighborhood_selected_numeric_index_v2_row_commit AFTER INSERT
  ON app.neighborhood_custom_cohort_selected_numeric_index_v2_rows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION app.check_neighborhood_selected_numeric_index_v2_commit();

CREATE FUNCTION app.guard_neighborhood_selected_numeric_index_v2_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE body jsonb; row_count bigint; year_count bigint; residential_count bigint; site_count bigint;
BEGIN
  SELECT canonical_utf8::jsonb INTO STRICT body FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=NEW.organization_id AND content_sha256=NEW.receipt_reference->>'content_sha256'
      AND canonical_utf8_bytes::text=NEW.receipt_reference->>'canonical_utf8_bytes' AND canonical_utf8_bytes<=16000;
  IF body->'after'->>'done'='true' THEN
    -- One terminal aggregate over native indexed observations, NEVER an array.
    -- Structural completeness ONLY, not source rights or median/COD authority.
    SELECT count(*),count(reported_year_built),count(reported_residential_area),count(reported_site_area)
      INTO row_count,year_count,residential_count,site_count
      FROM app.neighborhood_custom_cohort_selected_numeric_index_v2_rows
      WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id;
    IF row_count IS DISTINCT FROM (body->>'selected_stock_count')::bigint
      OR year_count IS DISTINCT FROM (body->'after_counts'->'reported_year_built'->>'eligible_count')::bigint
      OR residential_count IS DISTINCT FROM (body->'after_counts'->'reported_residential_area'->>'eligible_count')::bigint
      OR site_count IS DISTINCT FROM (body->'after_counts'->'reported_site_area'->>'eligible_count')::bigint THEN
      RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_incomplete' USING ERRCODE='55000'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_selected_numeric_index_v2_rows
      WHERE operation_id=NEW.operation_id AND organization_id=NEW.organization_id AND ordinal=NEW.sequence
        AND contribution_row_reference=body->'row_reference' AND account_id=body->'selected_entry'->>'account_id') THEN
    RAISE EXCEPTION 'neighborhood_selected_numeric_index_v2_missing_row' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER neighborhood_selected_numeric_index_v2_head_guard BEFORE INSERT OR UPDATE
  ON app.neighborhood_custom_cohort_selected_statistics_v2_heads FOR EACH ROW
  EXECUTE FUNCTION app.guard_neighborhood_selected_numeric_index_v2_head();

COMMENT ON TABLE app.neighborhood_custom_cohort_selected_numeric_index_v2_rows IS
  'INACTIVE exact numeric observation index, one native selected account per contribution with ties preserved. Created ONLY as a child of the existing original-reconciled eighth transaction after current and ending authorization. Canonical nonnegative <=30 digit / <=12 fractional decimal, no numeric typmod rounding. Three supported current reported metrics only, no market/currency inference. Native head/count/commit checks are structural, NOT enduring original-source or selected-union authority. No old-operation backfill. Every later rank/deviation/statistics semantic pass MUST freshly reopen the complete original graph, EVERY original and ENTIRE cache under current and ending source/database authority. No median/COD/quarter/publication/license/live-speed acceptance.';
