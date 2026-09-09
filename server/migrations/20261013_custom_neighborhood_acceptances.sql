-- Custom-only acceptance links. Keep the shared UAD acceptance writer/guard unchanged.
-- Run after the existing Custom workfile/history, attachment and cohort-context migrations.
CREATE TABLE IF NOT EXISTS app.custom_neighborhood_acceptances (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  attachment_id uuid NOT NULL,
  attachment_revision integer NOT NULL,
  application_identity_sha256 text NOT NULL CHECK (application_identity_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  section_key text NOT NULL CHECK (section_key = 'neighborhood_assessment'),
  section_history_id bigint NOT NULL REFERENCES app.custom_appraisal_workfile_section_history(id) ON DELETE RESTRICT,
  accepted_editor_revision integer NOT NULL CHECK (accepted_editor_revision >= 1),
  section_bytes_sha256 text NOT NULL CHECK (section_bytes_sha256 ~ '^[a-f0-9]{64}$'),
  section_json_utf8 text NOT NULL CHECK (octet_length(section_json_utf8) BETWEEN 1 AND 1500000),
  decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object' AND octet_length(decision::text) <= 2000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, report_file_id, assignment_file_id, account_id)
    REFERENCES app.report_files (organization_id, id, custom_assignment_file_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (attachment_id, attachment_revision, report_file_id, application_identity_sha256)
    REFERENCES app.neighborhood_assessment_attachments
      (attachment_id, attachment_revision, report_file_id, application_identity_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_file_id, section_key, accepted_editor_revision)
    REFERENCES app.custom_appraisal_workfile_section_history (assignment_file_id, section_key, revision) ON DELETE RESTRICT,
  UNIQUE (report_file_id, operation_id),
  UNIQUE (report_file_id, application_identity_sha256),
  CHECK (current_setting('server_encoding') = 'UTF8'),
  CHECK (encode(sha256(convert_to(section_json_utf8, 'UTF8')), 'hex') = section_bytes_sha256),
  CHECK (jsonb_typeof(section_json_utf8::jsonb) = 'object'
    AND octet_length((section_json_utf8::jsonb)::text) <= 2000000)
);

COMMENT ON TABLE app.custom_neighborhood_acceptances IS
  'Immutable Custom coherent-group acceptance linked to the exact saved section history. Not authorization or signing authority. The workflow owner writes the section and acceptance inside one authorized transaction.';

CREATE OR REPLACE FUNCTION app.custom_neighborhood_reject_acceptance_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  RAISE EXCEPTION 'custom_neighborhood_acceptance_immutable';
END $$;
CREATE TRIGGER custom_neighborhood_acceptance_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.custom_neighborhood_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION app.custom_neighborhood_reject_acceptance_mutation();

CREATE OR REPLACE FUNCTION app.custom_neighborhood_guard_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
DECLARE attachment_row app.neighborhood_assessment_attachments%ROWTYPE;
  target_row record; history_row app.custom_appraisal_workfile_section_history%ROWTYPE;
  current_row app.custom_appraisal_workfile_sections%ROWTYPE;
  section_body jsonb; values_map jsonb; partitions jsonb; expected_values jsonb; expected_membership jsonb;
BEGIN
  -- Match the application's UUID version/variant domain before any row can
  -- become immutable. PostgreSQL's uuid type alone also permits nil/invalid
  -- version identifiers which the exact-operation reader cannot reopen.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.id, NEW.organization_id, NEW.report_file_id,
      NEW.attachment_id, NEW.operation_id, NEW.actor_user_id]) AS identifiers(value)
    WHERE value::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_invalid_identifier';
  END IF;
  SELECT f.organization_id, f.account_id, w.status, w.signed_at INTO STRICT target_row
    FROM app.assignment_files f JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=f.id
    WHERE f.id=NEW.assignment_file_id FOR SHARE OF f, w;
  IF target_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR target_row.account_id IS DISTINCT FROM NEW.account_id
    OR target_row.status IS DISTINCT FROM 'draft' OR target_row.signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_target_not_editable';
  END IF;
  SELECT * INTO STRICT current_row FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=NEW.assignment_file_id AND section_key=NEW.section_key FOR SHARE;
  SELECT * INTO STRICT history_row FROM app.custom_appraisal_workfile_section_history
    WHERE id=NEW.section_history_id FOR SHARE;
  IF history_row.assignment_file_id IS DISTINCT FROM NEW.assignment_file_id
    OR history_row.section_key IS DISTINCT FROM NEW.section_key
    OR history_row.revision IS DISTINCT FROM NEW.accepted_editor_revision
    OR history_row.event_type IS DISTINCT FROM 'manual_save'
    OR current_row.revision IS DISTINCT FROM NEW.accepted_editor_revision
    OR current_row.section_value IS DISTINCT FROM history_row.section_value THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_history_mismatch';
  END IF;
  SELECT * INTO STRICT attachment_row FROM app.neighborhood_assessment_attachments
    WHERE attachment_id=NEW.attachment_id AND attachment_revision=NEW.attachment_revision FOR SHARE;
  IF attachment_row.workflow_type IS DISTINCT FROM 'custom_appraisal' OR attachment_row.uad_workfile_id IS NOT NULL
    OR attachment_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR attachment_row.report_file_id IS DISTINCT FROM NEW.report_file_id
    OR attachment_row.custom_assignment_file_id IS DISTINCT FROM NEW.assignment_file_id
    OR attachment_row.application_identity_sha256 IS DISTINCT FROM NEW.application_identity_sha256 THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_attachment_mismatch';
  END IF;
  section_body := NEW.section_json_utf8::jsonb;
  PERFORM 1 FROM app.neighborhood_assessment_revisions
    WHERE assessment_id=attachment_row.assessment_id AND revision=attachment_row.assessment_revision
      AND publication_status='published' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom_neighborhood_acceptance_unpublished_assessment'; END IF;
  values_map := section_body->'mapped_values';
  IF section_body IS DISTINCT FROM history_row.section_value
    OR section_body IS DISTINCT FROM jsonb_build_object('schema_version',1,'operation_id',NEW.operation_id,
      'actor_user_id',NEW.actor_user_id,'attachment_id',NEW.attachment_id,'attachment_revision',NEW.attachment_revision,
      'application_identity_sha256',NEW.application_identity_sha256,'accepted_editor_revision',NEW.accepted_editor_revision,
      'decision',NEW.decision,'mapped_values',values_map)
    OR (attachment_row.attachment->>'editor_revision')::bigint + 1 IS DISTINCT FROM NEW.accepted_editor_revision::bigint
    OR NEW.decision IS DISTINCT FROM jsonb_build_object('applied',NEW.decision->'applied','reused',NEW.decision->'reused') THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_snapshot_mismatch';
  END IF;
  IF jsonb_typeof(values_map) IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.decision->'applied') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW.decision->'reused') IS DISTINCT FROM 'object'
    OR jsonb_typeof(attachment_row.mapped_suggestions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_invalid_group';
  END IF;
  -- Decisions store sets, not order-sensitive arrays or application-generated
  -- digest claims. The unchanged shared engine reconstructs its receipt on read.
  IF jsonb_array_length(attachment_row.mapped_suggestions) NOT BETWEEN 1 AND 1000
    OR NEW.decision->'applied' = '{}'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.decision->'applied') k WHERE NEW.decision->'reused' ? k)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(attachment_row.mapped_suggestions) v
      WHERE jsonb_typeof(v->'id') IS DISTINCT FROM 'string' OR v->>'id'='')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(attachment_row.mapped_suggestions) v GROUP BY v->>'id' HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_incomplete_group';
  END IF;
  SELECT jsonb_object_agg(s->>'id',jsonb_build_object('target_key',s->'target_key','value',s->'value')),
    jsonb_object_agg(s->>'id','true'::jsonb) INTO expected_values,expected_membership
    FROM jsonb_array_elements(attachment_row.mapped_suggestions) s;
  partitions := (NEW.decision->'applied') || (NEW.decision->'reused');
  IF values_map IS DISTINCT FROM expected_values OR partitions IS DISTINCT FROM expected_membership THEN
    RAISE EXCEPTION 'custom_neighborhood_acceptance_changed_group';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custom_neighborhood_acceptance_guard
  BEFORE INSERT ON app.custom_neighborhood_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.custom_neighborhood_guard_acceptance();

-- Dedicated neighborhood history is append-only from insertion, even before its
-- acceptance is written. Do not look up acceptance here: an older REPEATABLE READ
-- snapshot can miss a subsequently committed acceptance. Inspecting OLD also
-- prevents renaming the section to evade this guard. Unrelated history is unchanged.
CREATE OR REPLACE FUNCTION app.custom_neighborhood_guard_accepted_history()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.section_key = 'neighborhood_assessment' THEN
    RAISE EXCEPTION 'custom_neighborhood_accepted_history_immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER custom_neighborhood_accepted_history_guard
  BEFORE UPDATE OR DELETE ON app.custom_appraisal_workfile_section_history
  FOR EACH ROW EXECUTE FUNCTION app.custom_neighborhood_guard_accepted_history();
