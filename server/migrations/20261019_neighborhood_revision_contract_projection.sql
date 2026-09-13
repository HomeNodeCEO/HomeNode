-- Derived storage only: retained assessment JSONB and evidence hashes are unchanged.
-- The normal migration runner encloses this file in BEGIN/COMMIT. Local timeout
-- settings restore on COMMIT/ROLLBACK and never lengthen a stricter caller limit.
-- ADD COLUMN STORED can rewrite populated revisions under ACCESS EXCLUSIVE.
-- Fail within bounded lock/statement budgets; no automatic retry or lock bypass.
SELECT set_config('lock_timeout',
    least(CASE WHEN current_setting('lock_timeout')::interval = interval '0'
      THEN 1000 ELSE extract(epoch FROM current_setting('lock_timeout')::interval) * 1000 END, 1000)::text || 'ms', true),
  set_config('statement_timeout',
    least(CASE WHEN current_setting('statement_timeout')::interval = interval '0'
      THEN 30000 ELSE extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 END, 30000)::text || 'ms', true);

ALTER TABLE app.neighborhood_assessment_revisions
  ADD COLUMN IF NOT EXISTS contract_version_jsonb jsonb
    GENERATED ALWAYS AS (assessment->'contract_version') STORED;

-- IF NOT EXISTS is not permission to trust an unrelated preexisting field.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='app.neighborhood_assessment_revisions'::regclass
      AND a.attname='contract_version_jsonb' AND NOT a.attisdropped
      AND a.atttypid='jsonb'::regtype AND a.attgenerated='s' AND a.attidentity='' AND NOT a.attnotnull
      AND pg_get_expr(d.adbin,d.adrelid) = '(assessment -> ''contract_version''::text)'
  ) THEN RAISE EXCEPTION 'neighborhood_revision_contract_projection_mismatch'; END IF;
END $$;

-- The generated JSONB preserves numeric/type/NULL behavior without coercion.
-- Every existing row guard, FOR SHARE lock and rejection remains unchanged.
CREATE OR REPLACE FUNCTION app.neighborhood_guard_revision_child()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE parent_status text; parent_contract_version jsonb; head app.neighborhood_assessments%ROWTYPE; snapshot_scope jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.assessment_id, NEW.revision) IS DISTINCT FROM ROW(OLD.assessment_id, OLD.revision) THEN
    RAISE EXCEPTION 'neighborhood_child_revision_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT publication_status, contract_version_jsonb INTO parent_status, parent_contract_version FROM app.neighborhood_assessment_revisions
      WHERE assessment_id = OLD.assessment_id AND revision = OLD.revision FOR SHARE;
  ELSE
    SELECT publication_status, contract_version_jsonb INTO parent_status, parent_contract_version FROM app.neighborhood_assessment_revisions
      WHERE assessment_id = NEW.assessment_id AND revision = NEW.revision FOR SHARE;
  END IF;
  IF parent_status IS DISTINCT FROM 'staging' THEN RAISE EXCEPTION 'neighborhood_published_child_immutable'; END IF;
  -- V2-only observation units cannot be smuggled under a legacy revision.
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME IN ('neighborhood_assessment_populations', 'neighborhood_assessment_members') THEN
    IF (parent_contract_version = '2'::jsonb) IS DISTINCT FROM
        (NEW.member_unit IN ('account', 'source_record')) THEN
      RAISE EXCEPTION 'neighborhood_member_contract_version_mismatch';
    END IF;
    IF TG_TABLE_NAME = 'neighborhood_assessment_members' THEN
      IF NEW.member_unit = 'account' AND NEW.account_ids IS DISTINCT FROM ARRAY[NEW.member_id] THEN
        RAISE EXCEPTION 'neighborhood_account_member_identity_mismatch';
      END IF;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'neighborhood_assessment_sources' THEN
    SELECT * INTO STRICT head FROM app.neighborhood_assessments WHERE id = NEW.assessment_id;
    snapshot_scope := NEW.source_snapshot->'scope';
    IF (NEW.source_snapshot->>'visibility' = 'public' AND snapshot_scope IS DISTINCT FROM 'null'::jsonb)
      OR (NEW.source_snapshot->>'visibility' IN ('organization', 'assignment')
        AND snapshot_scope->>'organization_id' IS DISTINCT FROM head.organization_id::text)
      OR (NEW.source_snapshot->>'visibility' = 'assignment' AND snapshot_scope IS DISTINCT FROM jsonb_build_object(
        'organization_id', head.organization_id, 'appraisal_case_id', head.appraisal_case_id,
        'subject_snapshot_id', head.subject_snapshot_id, 'account_id', head.account_id)) THEN
      RAISE EXCEPTION 'neighborhood_private_source_scope_mismatch';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers see the new generated field before its value is computed.
-- Exclude only that new non-writable field; compare every original column.
CREATE OR REPLACE FUNCTION app.neighborhood_guard_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE head app.neighborhood_assessments%ROWTYPE; actual jsonb; expected jsonb; population_row record;
  members bigint; links bigint; properties bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.publication_status = 'published' THEN RAISE EXCEPTION 'neighborhood_published_revision_immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.publication_status <> 'staging' OR NEW.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'neighborhood_revision_must_stage';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.publication_status <> 'staging' OR NEW.publication_status <> 'published'
    OR (to_jsonb(NEW) - 'publication_status' - 'published_at' - 'contract_version_jsonb') IS DISTINCT FROM
       (to_jsonb(OLD) - 'publication_status' - 'published_at' - 'contract_version_jsonb')) THEN
    RAISE EXCEPTION 'neighborhood_revision_immutable';
  END IF;
  IF (NEW.assessment->'contract_version' IN ('1'::jsonb, '2'::jsonb)) IS NOT TRUE THEN
    RAISE EXCEPTION 'neighborhood_contract_version_unsupported';
  END IF;
  IF NEW.assessment->'contract_version' = '2'::jsonb AND (
    NEW.assessment#>>'{methodology,version}' IS DISTINCT FROM 'reported-observations-v2'
    OR NEW.assessment#>>'{methodology,geometry_version}' IS DISTINCT FROM 'appraiser-defined-observation-boundary-v1'
    OR NEW.assessment#>>'{methodology,configuration,profile_id}' IS DISTINCT FROM 'custom-reported-observations-v2'
    OR NEW.assessment#>'{methodology,configuration,profile_revision}' IS DISTINCT FROM '1'::jsonb
    OR NEW.assessment#>>'{methodology,configuration,report_basis}' IS DISTINCT FROM 'reported_observations_not_verified_market_facts'
  ) THEN RAISE EXCEPTION 'neighborhood_observation_profile_mismatch'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_assessments WHERE id = NEW.assessment_id FOR SHARE;
  IF NEW.assessment->>'id' IS DISTINCT FROM NEW.assessment_id::text
    OR NEW.assessment->'revision' IS DISTINCT FROM to_jsonb(NEW.revision)
    OR NEW.assessment->>'input_signature_sha256' IS DISTINCT FROM NEW.input_signature_sha256
    OR NEW.assessment->>'evidence_digest_sha256' IS DISTINCT FROM NEW.evidence_digest_sha256
    OR NEW.assessment->'scope' IS DISTINCT FROM jsonb_build_object('organization_id', head.organization_id,
      'appraisal_case_id', head.appraisal_case_id, 'subject_snapshot_id', head.subject_snapshot_id, 'account_id', head.account_id) THEN
    RAISE EXCEPTION 'neighborhood_revision_identity_mismatch';
  END IF;
  IF NEW.assessment->>'effective_date' IS NULL OR NEW.assessment->>'data_cutoff' IS NULL
    OR (NEW.assessment->>'data_cutoff')::date > (NEW.assessment->>'effective_date')::date THEN
    RAISE EXCEPTION 'neighborhood_revision_date_mismatch';
  END IF;
  PERFORM app.neighborhood_assert_scope(head.organization_id, head.appraisal_case_id, head.subject_snapshot_id,
    head.account_id, (NEW.assessment->>'effective_date')::date);
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  SELECT COALESCE(jsonb_agg(p.population ORDER BY p.population_id), '[]'::jsonb) INTO actual
    FROM app.neighborhood_assessment_populations p WHERE p.assessment_id = NEW.assessment_id AND p.revision = NEW.revision;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'id'), '[]'::jsonb) INTO expected
    FROM jsonb_array_elements(NEW.assessment->'populations');
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'neighborhood_population_manifest_mismatch'; END IF;
  SELECT COALESCE(jsonb_agg(s.source_snapshot ORDER BY s.source_id), '[]'::jsonb) INTO actual
    FROM app.neighborhood_assessment_sources s WHERE s.assessment_id = NEW.assessment_id AND s.revision = NEW.revision;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'id'), '[]'::jsonb) INTO expected
    FROM jsonb_array_elements(NEW.assessment->'source_snapshots');
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'neighborhood_source_manifest_mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_path_query(NEW.assessment, '$.**.source_refs[*]') AS refs(value)
    WHERE jsonb_typeof(value) <> 'string' OR NOT EXISTS (SELECT 1 FROM app.neighborhood_assessment_sources s
      WHERE s.assessment_id = NEW.assessment_id AND s.revision = NEW.revision AND s.source_id = value #>> '{}')) THEN
    RAISE EXCEPTION 'neighborhood_source_reference_missing';
  END IF;
  FOR population_row IN SELECT * FROM app.neighborhood_assessment_populations
    WHERE assessment_id = NEW.assessment_id AND revision = NEW.revision LOOP
    SELECT count(*), COALESCE(sum(cardinality(account_ids)), 0) INTO members, links
      FROM app.neighborhood_assessment_members WHERE assessment_id = NEW.assessment_id AND revision = NEW.revision
        AND population_id = population_row.population_id;
    SELECT count(DISTINCT account_id) INTO properties FROM app.neighborhood_assessment_members m
      CROSS JOIN LATERAL unnest(m.account_ids) accounts(account_id)
      WHERE m.assessment_id = NEW.assessment_id AND m.revision = NEW.revision AND m.population_id = population_row.population_id;
    IF (population_row.member_count IS NOT NULL AND population_row.member_count <> members)
      OR (population_row.property_link_count IS NOT NULL AND population_row.property_link_count <> links)
      OR (population_row.unique_property_count IS NOT NULL AND population_row.unique_property_count <> properties) THEN
      RAISE EXCEPTION 'neighborhood_exact_member_counts_mismatch:%', population_row.population_id;
    END IF;
    IF NEW.assessment->'contract_version' = '2'::jsonb THEN
      IF population_row.member_unit NOT IN ('account', 'source_record')
        OR population_row.unique_property_count IS NOT NULL OR population_row.property_link_count IS NOT NULL
        OR (population_row.population->'unique_account_count' <> 'null'::jsonb
          AND (population_row.population->>'unique_account_count')::bigint IS DISTINCT FROM properties)
        OR (population_row.population->'account_link_count' <> 'null'::jsonb
          AND (population_row.population->>'account_link_count')::bigint IS DISTINCT FROM links) THEN
        RAISE EXCEPTION 'neighborhood_exact_account_counts_mismatch:%', population_row.population_id;
      END IF;
    ELSIF population_row.member_unit IN ('account', 'source_record') THEN
      RAISE EXCEPTION 'neighborhood_member_contract_version_mismatch';
    END IF;
  END LOOP;
  -- Contract/member hashes are recomputed by the pure repository validators;
  -- jsonb::text is not the JS canonicalization and a SHA is not authorization.
  NEW.published_at := clock_timestamp();
  RETURN NEW;
END $$;
