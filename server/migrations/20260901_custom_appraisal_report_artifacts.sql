CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.custom_appraisal_report_artifacts (
  assignment_file_id bigint PRIMARY KEY
    REFERENCES app.custom_appraisal_workfiles(assignment_file_id) ON DELETE RESTRICT,
  signed_snapshot_id uuid NOT NULL UNIQUE
    REFERENCES app.custom_appraisal_signed_snapshots(id) ON DELETE RESTRICT,
  canonical_file_name text NOT NULL UNIQUE,
  report_version integer NOT NULL DEFAULT 1,
  workfile_checksum_sha256 text NOT NULL,
  content_sha256 text NOT NULL,
  content bytea NOT NULL,
  byte_size bigint NOT NULL,
  page_count integer NOT NULL,
  generated_by text NOT NULL DEFAULT 'HomeNode report engine',
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (report_version >= 1),
  CHECK (workfile_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (octet_length(content) = byte_size),
  CHECK (byte_size > 0),
  CHECK (page_count > 0)
);

CREATE INDEX IF NOT EXISTS custom_appraisal_report_artifacts_generated_idx
  ON app.custom_appraisal_report_artifacts (generated_at DESC, assignment_file_id);
