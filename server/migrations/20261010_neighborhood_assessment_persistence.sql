-- Additive neighborhood persistence, registered with application/mobile migrations.
-- Run only through the migration owner, never implicitly on report reads.
-- No optional GIS/provider schema, parent-table alteration, or live backfill.
-- Scope checks protect this subsystem, not authorization: owning workflow guards
-- must authorize every lookup/apply and recheck parent scope after later edits.
DO $$
DECLARE dependency text;
BEGIN
  FOREACH dependency IN ARRAY ARRAY[
    'app_auth.organizations', 'app_auth.users', 'core.accounts',
    'app.appraisal_cases', 'app.appraisal_subject_snapshots', 'app.report_files',
    'app.assignment_files', 'appraisal.uad_workfiles',
    'appraisal.uad_revisions', 'appraisal.uad_audit_events'
  ] LOOP
    IF to_regclass(dependency) IS NULL THEN
      RAISE EXCEPTION 'neighborhood_identity_prerequisite_missing:%', dependency;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS app.neighborhood_assessments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  appraisal_case_id uuid NOT NULL REFERENCES app.appraisal_cases(id) ON DELETE RESTRICT,
  subject_snapshot_id uuid NOT NULL REFERENCES app.appraisal_subject_snapshots(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE RESTRICT,
  next_revision integer NOT NULL DEFAULT 1 CHECK (next_revision >= 1),
  request_generation integer NOT NULL DEFAULT 0 CHECK (request_generation >= 0),
  requested_job_id uuid,
  current_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, appraisal_case_id, subject_snapshot_id, account_id)
);

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_revisions (
  assessment_id uuid NOT NULL REFERENCES app.neighborhood_assessments(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  input_signature_sha256 text NOT NULL CHECK (input_signature_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_digest_sha256 text NOT NULL CHECK (evidence_digest_sha256 ~ '^[a-f0-9]{64}$'),
  assessment jsonb NOT NULL CHECK (jsonb_typeof(assessment) = 'object' AND octet_length(assessment::text) <= 1500000),
  publication_status text NOT NULL DEFAULT 'staging' CHECK (publication_status IN ('staging', 'published')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assessment_id, revision),
  UNIQUE (assessment_id, input_signature_sha256),
  CHECK ((publication_status = 'published') = (published_at IS NOT NULL)),
  CHECK (jsonb_typeof(assessment->'populations') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_typeof(assessment->'source_snapshots') IS NOT DISTINCT FROM 'array'),
  CHECK (jsonb_typeof(assessment->'statistics') IS NOT DISTINCT FROM 'array')
);

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_jobs (
  id uuid PRIMARY KEY,
  assessment_id uuid NOT NULL REFERENCES app.neighborhood_assessments(id) ON DELETE RESTRICT,
  input_signature_sha256 text NOT NULL CHECK (input_signature_sha256 ~ '^[a-f0-9]{64}$'),
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object' AND octet_length(request_payload::text) <= 1500000),
  effective_date date NOT NULL,
  data_cutoff date NOT NULL CHECK (data_cutoff <= effective_date),
  request_generation integer NOT NULL CHECK (request_generation >= 1),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  run_after timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 1500000),
  last_error_code text CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 200),
  result_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, id),
  UNIQUE (assessment_id, input_signature_sha256),
  UNIQUE (assessment_id, request_generation),
  FOREIGN KEY (assessment_id, result_revision)
    REFERENCES app.neighborhood_assessment_revisions(assessment_id, revision) ON DELETE RESTRICT,
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'running' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts >= 1)
    OR (status <> 'running' AND claim_token IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status = 'succeeded') = (result_revision IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS neighborhood_assessment_jobs_due_idx
  ON app.neighborhood_assessment_jobs (run_after, created_at, id)
  WHERE status IN ('queued', 'retry');
CREATE INDEX IF NOT EXISTS neighborhood_assessment_jobs_lease_idx
  ON app.neighborhood_assessment_jobs (lease_expires_at, id) WHERE status = 'running';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'neighborhood_requested_job_fk'
    AND conrelid = 'app.neighborhood_assessments'::regclass) THEN
    ALTER TABLE app.neighborhood_assessments ADD CONSTRAINT neighborhood_requested_job_fk
      FOREIGN KEY (id, requested_job_id) REFERENCES app.neighborhood_assessment_jobs(assessment_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'neighborhood_current_revision_fk'
    AND conrelid = 'app.neighborhood_assessments'::regclass) THEN
    ALTER TABLE app.neighborhood_assessments ADD CONSTRAINT neighborhood_current_revision_fk
      FOREIGN KEY (id, current_revision) REFERENCES app.neighborhood_assessment_revisions(assessment_id, revision) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_populations (
  assessment_id uuid NOT NULL,
  revision integer NOT NULL,
  population_id text NOT NULL CHECK (char_length(population_id) BETWEEN 1 AND 200),
  member_unit text NOT NULL CHECK (member_unit IN ('property', 'canonical_transaction', 'allocated_property_sale', 'listing')),
  member_count bigint CHECK (member_count BETWEEN 0 AND 9007199254740991),
  unique_property_count bigint CHECK (unique_property_count BETWEEN 0 AND 9007199254740991),
  property_link_count bigint CHECK (property_link_count BETWEEN 0 AND 9007199254740991),
  completeness text NOT NULL CHECK (completeness IN ('complete', 'incomplete', 'unknown')),
  member_set_sha256 text CHECK (member_set_sha256 IS NULL OR member_set_sha256 ~ '^[a-f0-9]{64}$'),
  population jsonb NOT NULL CHECK (jsonb_typeof(population) = 'object'),
  PRIMARY KEY (assessment_id, revision, population_id),
  UNIQUE (assessment_id, revision, population_id, member_unit),
  FOREIGN KEY (assessment_id, revision) REFERENCES app.neighborhood_assessment_revisions(assessment_id, revision) ON DELETE RESTRICT,
  CHECK (completeness <> 'complete' OR (member_count IS NOT NULL AND unique_property_count IS NOT NULL
    AND property_link_count IS NOT NULL AND member_set_sha256 IS NOT NULL)),
  CHECK (unique_property_count <= property_link_count),
  CHECK (member_unit <> 'property' OR unique_property_count = member_count),
  CHECK ((member_unit = 'canonical_transaction' AND property_link_count >= member_count)
    OR (member_unit <> 'canonical_transaction' AND property_link_count = member_count)),
  CHECK (((population->>'kind' IN ('geographic_stock', 'competitive_stock') AND member_unit = 'property')
    OR (population->>'kind' = 'transactions' AND member_unit IN ('canonical_transaction', 'allocated_property_sale'))
    OR (population->>'kind' = 'listings' AND member_unit = 'listing')) IS TRUE),
  CHECK (population->>'id' IS NOT DISTINCT FROM population_id),
  CHECK (population->>'member_unit' IS NOT DISTINCT FROM member_unit),
  CHECK (population->>'completeness' IS NOT DISTINCT FROM completeness),
  CHECK (population->>'member_set_sha256' IS NOT DISTINCT FROM member_set_sha256),
  CHECK (population->'member_count' IS NOT DISTINCT FROM COALESCE(to_jsonb(member_count), 'null'::jsonb)),
  CHECK (population->'unique_property_count' IS NOT DISTINCT FROM COALESCE(to_jsonb(unique_property_count), 'null'::jsonb)),
  CHECK (population->'property_link_count' IS NOT DISTINCT FROM COALESCE(to_jsonb(property_link_count), 'null'::jsonb))
);

CREATE OR REPLACE FUNCTION app.neighborhood_valid_member_accounts(ids text[], unit text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN ids IS NULL OR array_ndims(ids) IS DISTINCT FROM 1 OR array_lower(ids, 1) <> 1
    OR cardinality(ids) NOT BETWEEN 1 AND 1000 OR (unit <> 'canonical_transaction' AND cardinality(ids) <> 1)
  THEN false ELSE (
    SELECT count(*) = count(DISTINCT account_id) AND bool_and(account_id IS NOT NULL
      AND account_id = btrim(account_id) AND char_length(account_id) BETWEEN 1 AND 100
      AND account_id !~ '[[:cntrl:]]') FROM unnest(ids) AS accounts(account_id)
  ) END
$$;

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_members (
  assessment_id uuid NOT NULL,
  revision integer NOT NULL,
  population_id text NOT NULL,
  member_id text NOT NULL CHECK (char_length(member_id) BETWEEN 1 AND 300),
  member_unit text NOT NULL,
  account_ids text[] NOT NULL,
  member_data jsonb NOT NULL CHECK (jsonb_typeof(member_data) = 'object' AND octet_length(member_data::text) <= 1500000),
  PRIMARY KEY (assessment_id, revision, population_id, member_id),
  FOREIGN KEY (assessment_id, revision, population_id, member_unit)
    REFERENCES app.neighborhood_assessment_populations(assessment_id, revision, population_id, member_unit) ON DELETE RESTRICT,
  CHECK (app.neighborhood_valid_member_accounts(account_ids, member_unit))
);
CREATE UNIQUE INDEX IF NOT EXISTS neighborhood_property_member_unique_idx
  ON app.neighborhood_assessment_members (assessment_id, revision, population_id, ((account_ids)[1]))
  WHERE member_unit = 'property';

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_sources (
  assessment_id uuid NOT NULL,
  revision integer NOT NULL,
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  source_revision text NOT NULL CHECK (char_length(source_revision) BETWEEN 1 AND 200),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object' AND octet_length(source_payload::text) <= 1500000),
  PRIMARY KEY (assessment_id, revision, source_id),
  FOREIGN KEY (assessment_id, revision) REFERENCES app.neighborhood_assessment_revisions(assessment_id, revision) ON DELETE RESTRICT,
  CHECK (source_snapshot->>'id' IS NOT DISTINCT FROM source_id),
  CHECK (source_snapshot->>'revision' IS NOT DISTINCT FROM source_revision),
  CHECK (source_snapshot->>'content_sha256' IS NOT DISTINCT FROM content_sha256),
  CHECK ((source_snapshot->>'visibility' IN ('public', 'organization', 'assignment')) IS TRUE)
);

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_attachments (
  attachment_id uuid NOT NULL,
  attachment_revision integer NOT NULL CHECK (attachment_revision >= 1),
  assessment_id uuid NOT NULL,
  assessment_revision integer NOT NULL,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  workflow_type text NOT NULL CHECK (workflow_type IN ('custom_appraisal', 'uad_3_6')),
  custom_assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  uad_workfile_id uuid REFERENCES appraisal.uad_workfiles(id) ON DELETE RESTRICT,
  application_identity_sha256 text NOT NULL CHECK (application_identity_sha256 ~ '^[a-f0-9]{64}$'),
  binding_digest_sha256 text NOT NULL CHECK (binding_digest_sha256 ~ '^[a-f0-9]{64}$'),
  mapped_suggestions jsonb NOT NULL CHECK (jsonb_typeof(mapped_suggestions) = 'array' AND octet_length(mapped_suggestions::text) <= 1500000),
  attachment jsonb NOT NULL CHECK (jsonb_typeof(attachment) = 'object' AND octet_length(attachment::text) <= 1500000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attachment_id, attachment_revision),
  UNIQUE (attachment_id, attachment_revision, report_file_id, application_identity_sha256),
  FOREIGN KEY (assessment_id, assessment_revision) REFERENCES app.neighborhood_assessment_revisions(assessment_id, revision) ON DELETE RESTRICT,
  CHECK ((workflow_type = 'custom_appraisal' AND custom_assignment_file_id IS NOT NULL AND uad_workfile_id IS NULL)
    OR (workflow_type = 'uad_3_6' AND custom_assignment_file_id IS NULL AND uad_workfile_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS neighborhood_attachments_report_idx
  ON app.neighborhood_assessment_attachments (report_file_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.neighborhood_assessment_applications (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL,
  attachment_revision integer NOT NULL,
  report_file_id uuid NOT NULL,
  application_identity_sha256 text NOT NULL CHECK (application_identity_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  request_digest_sha256 text NOT NULL CHECK (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_editor_revision integer NOT NULL CHECK (accepted_editor_revision >= 1),
  uad_revision_id uuid REFERENCES appraisal.uad_revisions(id) ON DELETE RESTRICT,
  uad_audit_event_id bigint REFERENCES appraisal.uad_audit_events(id) ON DELETE RESTRICT,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 1500000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attachment_id, attachment_revision, report_file_id, application_identity_sha256)
    REFERENCES app.neighborhood_assessment_attachments(attachment_id, attachment_revision, report_file_id, application_identity_sha256) ON DELETE RESTRICT,
  UNIQUE (report_file_id, operation_id),
  UNIQUE (report_file_id, application_identity_sha256)
);

CREATE OR REPLACE FUNCTION app.neighborhood_assert_scope(
  organization uuid, appraisal_case uuid, subject_snapshot uuid, account text, effective date DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE canonical record; resolved_effective date;
BEGIN
  SELECT c.organization_id, c.account_id, c.effective_date AS case_date, s.effective_date AS snapshot_date
    INTO canonical FROM app.appraisal_cases c JOIN app.appraisal_subject_snapshots s ON s.appraisal_case_id = c.id
    WHERE c.id = appraisal_case AND s.id = subject_snapshot FOR SHARE OF c, s;
  IF NOT FOUND OR canonical.organization_id IS DISTINCT FROM organization OR canonical.account_id IS DISTINCT FROM account THEN
    RAISE EXCEPTION 'neighborhood_scope_mismatch';
  END IF;
  IF effective IS NOT NULL THEN
    resolved_effective := COALESCE(canonical.snapshot_date, canonical.case_date);
    IF resolved_effective IS NULL THEN RAISE EXCEPTION 'neighborhood_unresolved_effective_date'; END IF;
    IF (canonical.snapshot_date IS NOT NULL AND canonical.case_date IS NOT NULL AND canonical.snapshot_date <> canonical.case_date)
      OR resolved_effective <> effective THEN RAISE EXCEPTION 'neighborhood_effective_date_mismatch'; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.neighborhood_guard_head()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.organization_id, NEW.appraisal_case_id, NEW.subject_snapshot_id, NEW.account_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.appraisal_case_id, OLD.subject_snapshot_id, OLD.account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'neighborhood_scope_immutable';
  END IF;
  PERFORM app.neighborhood_assert_scope(NEW.organization_id, NEW.appraisal_case_id, NEW.subject_snapshot_id, NEW.account_id);
  IF NEW.current_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.neighborhood_assessment_revisions r
    WHERE r.assessment_id = NEW.id AND r.revision = NEW.current_revision AND r.publication_status = 'published') THEN
    RAISE EXCEPTION 'neighborhood_current_revision_not_published';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.neighborhood_guard_job()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE head app.neighborhood_assessments%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.assessment_id, NEW.input_signature_sha256, NEW.request_digest_sha256,
    NEW.request_payload, NEW.effective_date, NEW.data_cutoff, NEW.request_generation, NEW.max_attempts, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.assessment_id, OLD.input_signature_sha256, OLD.request_digest_sha256,
    OLD.request_payload, OLD.effective_date, OLD.data_cutoff, OLD.request_generation, OLD.max_attempts, OLD.created_at) THEN
    RAISE EXCEPTION 'neighborhood_job_input_immutable';
  END IF;
  -- Claim UPDATE already owns the job row. Do not lock head here: publication
  -- takes head then job. Head scope is immutable; canonical parents lock below.
  SELECT * INTO STRICT head FROM app.neighborhood_assessments WHERE id = NEW.assessment_id;
  PERFORM app.neighborhood_assert_scope(head.organization_id, head.appraisal_case_id, head.subject_snapshot_id, head.account_id, NEW.effective_date);
  IF NEW.result_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.neighborhood_assessment_revisions r
    WHERE r.assessment_id = NEW.assessment_id AND r.revision = NEW.result_revision AND r.publication_status = 'published'
      AND r.input_signature_sha256 = NEW.input_signature_sha256) THEN
    RAISE EXCEPTION 'neighborhood_job_result_mismatch';
  END IF;
  -- Token/generation/clock_timestamp fences are mandatory in repository UPDATE
  -- predicates; a worker name or this shape trigger alone is NOT a claim check.
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.neighborhood_guard_revision_child()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE parent_status text; head app.neighborhood_assessments%ROWTYPE; snapshot_scope jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.assessment_id, NEW.revision) IS DISTINCT FROM ROW(OLD.assessment_id, OLD.revision) THEN
    RAISE EXCEPTION 'neighborhood_child_revision_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT publication_status INTO parent_status FROM app.neighborhood_assessment_revisions
      WHERE assessment_id = OLD.assessment_id AND revision = OLD.revision FOR SHARE;
  ELSE
    SELECT publication_status INTO parent_status FROM app.neighborhood_assessment_revisions
      WHERE assessment_id = NEW.assessment_id AND revision = NEW.revision FOR SHARE;
  END IF;
  IF parent_status IS DISTINCT FROM 'staging' THEN RAISE EXCEPTION 'neighborhood_published_child_immutable'; END IF;
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
    OR (to_jsonb(NEW) - 'publication_status' - 'published_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'publication_status' - 'published_at')) THEN
    RAISE EXCEPTION 'neighborhood_revision_immutable';
  END IF;
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
  END LOOP;
  -- Contract/member hashes are recomputed by the pure repository validators;
  -- jsonb::text is not the JS canonicalization and a SHA is not authorization.
  NEW.published_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.neighborhood_guard_attachment()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE head app.neighborhood_assessments%ROWTYPE; report app.report_files%ROWTYPE;
  revision_row app.neighborhood_assessment_revisions%ROWTYPE; target_organization uuid; target_account text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'neighborhood_attachment_immutable'; END IF;
  SELECT * INTO STRICT head FROM app.neighborhood_assessments WHERE id = NEW.assessment_id FOR SHARE;
  SELECT * INTO STRICT revision_row FROM app.neighborhood_assessment_revisions
    WHERE assessment_id = NEW.assessment_id AND revision = NEW.assessment_revision FOR SHARE;
  PERFORM app.neighborhood_assert_scope(head.organization_id, head.appraisal_case_id, head.subject_snapshot_id,
    head.account_id, (revision_row.assessment->>'effective_date')::date);
  SELECT * INTO STRICT report FROM app.report_files WHERE id = NEW.report_file_id FOR SHARE;
  IF revision_row.publication_status <> 'published' OR NEW.organization_id IS DISTINCT FROM head.organization_id
    OR report.organization_id IS DISTINCT FROM head.organization_id OR report.account_id IS DISTINCT FROM head.account_id
    OR report.appraisal_case_id IS DISTINCT FROM head.appraisal_case_id OR report.subject_snapshot_id IS DISTINCT FROM head.subject_snapshot_id
    OR ROW(report.workflow_type, report.custom_assignment_file_id, report.uad_workfile_id)
      IS DISTINCT FROM ROW(NEW.workflow_type, NEW.custom_assignment_file_id, NEW.uad_workfile_id) THEN
    RAISE EXCEPTION 'neighborhood_attachment_target_mismatch';
  END IF;
  IF NEW.workflow_type = 'custom_appraisal' THEN
    SELECT organization_id, account_id INTO STRICT target_organization, target_account FROM app.assignment_files
      WHERE id = NEW.custom_assignment_file_id FOR SHARE;
  ELSE
    SELECT organization_id, account_id INTO STRICT target_organization, target_account FROM appraisal.uad_workfiles
      WHERE id = NEW.uad_workfile_id FOR SHARE;
  END IF;
  IF target_organization IS DISTINCT FROM head.organization_id OR target_account IS DISTINCT FROM head.account_id THEN
    RAISE EXCEPTION 'neighborhood_attachment_target_scope_mismatch';
  END IF;
  IF NOT (NEW.attachment @> jsonb_build_object('attachment_id', NEW.attachment_id, 'attachment_revision', NEW.attachment_revision,
    'assessment_id', NEW.assessment_id, 'assessment_revision', NEW.assessment_revision, 'report_file_id', NEW.report_file_id,
    'workflow_type', NEW.workflow_type, 'custom_assignment_file_id', NEW.custom_assignment_file_id, 'uad_workfile_id', NEW.uad_workfile_id,
    'application_identity_sha256', NEW.application_identity_sha256, 'binding_digest_sha256', NEW.binding_digest_sha256,
    'scope', revision_row.assessment->'scope', 'effective_date', revision_row.assessment->'effective_date',
    'data_cutoff', revision_row.assessment->'data_cutoff', 'evidence_digest_sha256', revision_row.evidence_digest_sha256)) THEN
    RAISE EXCEPTION 'neighborhood_attachment_manifest_mismatch';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.neighborhood_guard_application()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE attachment_row app.neighborhood_assessment_attachments%ROWTYPE; manifest jsonb; base_revision integer;
  uad_revision appraisal.uad_revisions%ROWTYPE; uad_event appraisal.uad_audit_events%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'neighborhood_application_immutable'; END IF;
  SELECT * INTO STRICT attachment_row FROM app.neighborhood_assessment_attachments
    WHERE attachment_id = NEW.attachment_id AND attachment_revision = NEW.attachment_revision FOR SHARE;
  IF attachment_row.workflow_type = 'uad_3_6' THEN
    IF NEW.uad_revision_id IS NULL OR NEW.uad_audit_event_id IS NULL THEN
      RAISE EXCEPTION 'neighborhood_uad_acceptance_identity_required';
    END IF;
    SELECT * INTO STRICT uad_revision FROM appraisal.uad_revisions WHERE id = NEW.uad_revision_id FOR SHARE;
    SELECT * INTO STRICT uad_event FROM appraisal.uad_audit_events WHERE id = NEW.uad_audit_event_id FOR SHARE;
    IF uad_revision.workfile_id IS DISTINCT FROM attachment_row.uad_workfile_id
      OR uad_revision.revision_number IS DISTINCT FROM NEW.accepted_editor_revision
      OR uad_revision.created_by_user_id IS DISTINCT FROM NEW.actor_user_id
      OR uad_event.workfile_id IS DISTINCT FROM attachment_row.uad_workfile_id
      OR uad_event.actor_user_id IS DISTINCT FROM NEW.actor_user_id THEN
      RAISE EXCEPTION 'neighborhood_uad_acceptance_identity_mismatch';
    END IF;
  ELSIF NEW.uad_revision_id IS NOT NULL OR NEW.uad_audit_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'neighborhood_custom_uad_identity_forbidden';
  END IF;
  manifest := NEW.receipt->'acceptance_manifest';
  base_revision := (manifest->>'base_editor_revision')::integer;
  IF NEW.receipt->'receipt_version' IS DISTINCT FROM '1'::jsonb
    OR NEW.receipt->'accepted_editor_revision' IS DISTINCT FROM to_jsonb(NEW.accepted_editor_revision)
    OR (NEW.receipt->>'receipt_digest_sha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR base_revision IS NULL OR base_revision < CASE WHEN attachment_row.workflow_type = 'uad_3_6' THEN 1 ELSE 0 END
    OR NEW.accepted_editor_revision <= base_revision
    OR NOT COALESCE(manifest @> jsonb_build_object('attachment_id', NEW.attachment_id, 'attachment_revision', NEW.attachment_revision,
      'application_identity_sha256', NEW.application_identity_sha256, 'binding_digest_sha256', attachment_row.binding_digest_sha256), false)
    OR NOT COALESCE(manifest->'provenance' @> jsonb_build_object('report_file_id', NEW.report_file_id,
      'workflow_type', attachment_row.workflow_type, 'custom_assignment_file_id', attachment_row.custom_assignment_file_id,
      'uad_workfile_id', attachment_row.uad_workfile_id), false) THEN
    RAISE EXCEPTION 'neighborhood_application_receipt_mismatch';
  END IF;
  -- Owner must lock/revalidate the actual content revision and signed state in
  -- the same transaction. report_files.registry_revision is NOT that counter.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neighborhood_head_guard ON app.neighborhood_assessments;
CREATE TRIGGER neighborhood_head_guard BEFORE INSERT OR UPDATE ON app.neighborhood_assessments
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_head();
DROP TRIGGER IF EXISTS neighborhood_job_guard ON app.neighborhood_assessment_jobs;
CREATE TRIGGER neighborhood_job_guard BEFORE INSERT OR UPDATE ON app.neighborhood_assessment_jobs
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_job();
DROP TRIGGER IF EXISTS neighborhood_revision_guard ON app.neighborhood_assessment_revisions;
CREATE TRIGGER neighborhood_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_revisions
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_revision();
DROP TRIGGER IF EXISTS neighborhood_population_guard ON app.neighborhood_assessment_populations;
CREATE TRIGGER neighborhood_population_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_populations
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_revision_child();
DROP TRIGGER IF EXISTS neighborhood_member_guard ON app.neighborhood_assessment_members;
CREATE TRIGGER neighborhood_member_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_members
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_revision_child();
DROP TRIGGER IF EXISTS neighborhood_source_guard ON app.neighborhood_assessment_sources;
CREATE TRIGGER neighborhood_source_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_sources
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_revision_child();
DROP TRIGGER IF EXISTS neighborhood_attachment_guard ON app.neighborhood_assessment_attachments;
CREATE TRIGGER neighborhood_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_attachments
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_attachment();
DROP TRIGGER IF EXISTS neighborhood_application_guard ON app.neighborhood_assessment_applications;
CREATE TRIGGER neighborhood_application_guard BEFORE INSERT OR UPDATE OR DELETE ON app.neighborhood_assessment_applications
  FOR EACH ROW EXECUTE FUNCTION app.neighborhood_guard_application();
