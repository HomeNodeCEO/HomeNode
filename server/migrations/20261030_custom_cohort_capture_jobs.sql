-- A queued Custom Appraisal capture is only an operation request. It is not
-- source authorization, an accepted neighborhood, or a report publication.
CREATE TABLE IF NOT EXISTS app.neighborhood_custom_cohort_capture_jobs (
  operation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  report_file_id uuid NOT NULL,
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (length(account_id) BETWEEN 1 AND 64),
  actor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'
    AND octet_length(request_payload::text) <= 8192),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retry', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  run_after timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 65536),
  cancellation_requested_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,99}$'),
  context_sha256 text CHECK (context_sha256 IS NULL OR context_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, report_file_id, assignment_file_id, account_id)
    REFERENCES app.report_files (organization_id, id, custom_assignment_file_id, account_id)
    ON DELETE RESTRICT,
  CHECK ((status = 'running' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempts > 0)
    OR (status <> 'running' AND claim_token IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status = 'succeeded') = (context_sha256 IS NOT NULL)),
  CHECK (status <> 'succeeded' OR cancellation_requested_at IS NULL)
);

CREATE INDEX IF NOT EXISTS neighborhood_custom_cohort_capture_jobs_due_idx
  ON app.neighborhood_custom_cohort_capture_jobs (run_after, operation_id)
  WHERE status IN ('queued', 'retry');
CREATE INDEX IF NOT EXISTS neighborhood_custom_cohort_capture_jobs_lease_idx
  ON app.neighborhood_custom_cohort_capture_jobs (lease_expires_at, operation_id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS neighborhood_custom_cohort_capture_jobs_scope_idx
  ON app.neighborhood_custom_cohort_capture_jobs
    (organization_id, assignment_file_id, account_id, created_at DESC);
