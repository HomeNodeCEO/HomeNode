-- Storage prerequisite only. No HTTP activation, accepted-report update, source
-- grant or automatic default selection. The caller owns authorization and commit.
CREATE UNIQUE INDEX IF NOT EXISTS neighborhood_custom_cohort_contexts_selection_target_uidx
  ON app.neighborhood_custom_cohort_contexts
    (organization_id,context_id,report_file_id,assignment_file_id,account_id,context_revision,context_sha256);

CREATE TABLE IF NOT EXISTS app.neighborhood_custom_cohort_group_selections (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  context_revision smallint NOT NULL CHECK (context_revision=1),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  selection_revision integer NOT NULL CHECK (selection_revision BETWEEN 1 AND 2147483647),
  operation_id uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  selection_sha256 text NOT NULL CHECK (selection_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_content_sha256 text NOT NULL,
  manifest_canonical_utf8_bytes integer NOT NULL CHECK (manifest_canonical_utf8_bytes BETWEEN 1 AND 750000),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,context_id,selection_revision),
  UNIQUE (organization_id,operation_id),
  FOREIGN KEY (organization_id,context_id,report_file_id,assignment_file_id,account_id,context_revision,context_sha256)
    REFERENCES app.neighborhood_custom_cohort_contexts
      (organization_id,context_id,report_file_id,assignment_file_id,account_id,context_revision,context_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,manifest_content_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS app.neighborhood_custom_cohort_group_selection_heads (
  organization_id uuid NOT NULL,
  context_id uuid NOT NULL,
  selection_revision integer NOT NULL,
  PRIMARY KEY (organization_id,context_id),
  FOREIGN KEY (organization_id,context_id,selection_revision)
    REFERENCES app.neighborhood_custom_cohort_group_selections
      (organization_id,context_id,selection_revision) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION app.reject_neighborhood_custom_cohort_group_selection_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'custom_cohort_group_selection_immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS neighborhood_custom_cohort_group_selections_immutable
  ON app.neighborhood_custom_cohort_group_selections;
CREATE TRIGGER neighborhood_custom_cohort_group_selections_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.neighborhood_custom_cohort_group_selections
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_neighborhood_custom_cohort_group_selection_mutation();
REVOKE UPDATE,DELETE,TRUNCATE ON app.neighborhood_custom_cohort_group_selections FROM PUBLIC;
