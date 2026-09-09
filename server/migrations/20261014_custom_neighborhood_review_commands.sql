-- Retained reviewer commands, not a registry of certified appraisal facts.
-- Existing contexts and evidence bytes remain immutable and unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS neighborhood_custom_cohort_contexts_review_target_uidx
  ON app.neighborhood_custom_cohort_contexts
  (organization_id, report_file_id, assignment_file_id, account_id, context_id, context_revision, context_sha256);

CREATE TABLE IF NOT EXISTS app.custom_neighborhood_review_commands (
  organization_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL,
  account_id text NOT NULL,
  context_id uuid NOT NULL,
  context_revision smallint NOT NULL CHECK (context_revision = 1),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  fact_key_sha256 text NOT NULL CHECK (fact_key_sha256 ~ '^[a-f0-9]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  predecessor_operation_id uuid,
  predecessor_content_sha256 text,
  content_sha256 text NOT NULL,
  canonical_utf8_bytes integer NOT NULL CHECK (canonical_utf8_bytes BETWEEN 1 AND 128000),
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, operation_id),
  UNIQUE (organization_id, context_id, generation),
  UNIQUE (organization_id, context_id, fact_key_sha256, operation_id, content_sha256),
  CHECK ((predecessor_operation_id IS NULL) = (predecessor_content_sha256 IS NULL)),
  CHECK (predecessor_operation_id IS NULL OR predecessor_operation_id <> operation_id),
  FOREIGN KEY (organization_id, report_file_id, assignment_file_id, account_id, context_id, context_revision, context_sha256)
    REFERENCES app.neighborhood_custom_cohort_contexts
    (organization_id, report_file_id, assignment_file_id, account_id, context_id, context_revision, context_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, content_sha256)
    REFERENCES app.neighborhood_cohort_evidence_blobs (organization_id, content_sha256) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, context_id, fact_key_sha256, predecessor_operation_id, predecessor_content_sha256)
    REFERENCES app.custom_neighborhood_review_commands
    (organization_id, context_id, fact_key_sha256, operation_id, content_sha256) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS custom_neighborhood_review_commands_fact_idx
  ON app.custom_neighborhood_review_commands (organization_id, context_id, fact_key_sha256, generation DESC);

CREATE OR REPLACE FUNCTION app.reject_custom_neighborhood_review_command_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'custom_neighborhood_review_command_immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS custom_neighborhood_review_commands_immutable ON app.custom_neighborhood_review_commands;
CREATE TRIGGER custom_neighborhood_review_commands_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON app.custom_neighborhood_review_commands
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_custom_neighborhood_review_command_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON app.custom_neighborhood_review_commands FROM PUBLIC;
