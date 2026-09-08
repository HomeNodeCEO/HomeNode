-- Header retention only; no selected head, issuer authority, or workflow changes.
-- The complete existing target tuple prevents a context from referencing a report
-- in another organization or silently changing assignment/account identity.
CREATE UNIQUE INDEX IF NOT EXISTS report_files_cohort_context_target_uidx
  ON app.report_files (organization_id, id, custom_assignment_file_id, account_id);

CREATE TABLE IF NOT EXISTS app.neighborhood_custom_cohort_contexts (
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  context_id uuid NOT NULL,
  context_revision smallint NOT NULL CHECK (context_revision = 1),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  header_content_sha256 text NOT NULL,
  header_canonical_utf8_bytes integer NOT NULL CHECK (header_canonical_utf8_bytes BETWEEN 1 AND 128000),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, context_id),
  FOREIGN KEY (organization_id, report_file_id, assignment_file_id, account_id)
    REFERENCES app.report_files (organization_id, id, custom_assignment_file_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, header_content_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id, content_sha256) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS neighborhood_custom_cohort_contexts_file_idx
  ON app.neighborhood_custom_cohort_contexts (organization_id, report_file_id, context_id);

CREATE OR REPLACE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'custom_cohort_context_immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS neighborhood_custom_cohort_contexts_immutable ON app.neighborhood_custom_cohort_contexts;
CREATE TRIGGER neighborhood_custom_cohort_contexts_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_contexts
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_context_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.neighborhood_custom_cohort_contexts FROM PUBLIC;
