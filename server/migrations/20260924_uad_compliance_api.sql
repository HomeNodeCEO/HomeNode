-- Durable, credential-free request/response history for the optional GSE UAD
-- Compliance APIs. No existing appraisal workflow or source data is changed.

CREATE TABLE IF NOT EXISTS appraisal.uad_compliance_exchanges (
  id uuid PRIMARY KEY,
  validation_run_id uuid NOT NULL UNIQUE
    REFERENCES appraisal.uad_validation_runs(id) ON DELETE CASCADE,
  workfile_id uuid NOT NULL
    REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  provider text NOT NULL,
  environment text NOT NULL,
  request_correlation_id uuid NOT NULL UNIQUE,
  request_artifact_id uuid NOT NULL
    REFERENCES appraisal.uad_generated_artifacts(id) ON DELETE RESTRICT,
  request_checksum_sha256 text NOT NULL,
  response_http_status integer,
  response_content_type text,
  response_checksum_sha256 text,
  response_payload text,
  provider_correlation_id text,
  exchange_status text NOT NULL DEFAULT 'running',
  error_code text,
  attempt_number integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (revision_number > 0),
  CHECK (provider IN ('fannie', 'freddie')),
  CHECK (char_length(environment) BETWEEN 1 AND 40),
  CHECK (request_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (response_http_status IS NULL OR response_http_status BETWEEN 100 AND 599),
  CHECK (response_checksum_sha256 IS NULL OR response_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (response_payload IS NULL OR octet_length(response_payload) <= 2097152),
  CHECK (provider_correlation_id IS NULL OR char_length(provider_correlation_id) <= 200),
  CHECK (exchange_status IN ('running', 'passed', 'failed', 'error')),
  CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,120}$'),
  CHECK (attempt_number > 0)
);

CREATE INDEX IF NOT EXISTS uad_compliance_exchanges_workfile_idx
  ON appraisal.uad_compliance_exchanges (workfile_id, provider, started_at DESC);

CREATE INDEX IF NOT EXISTS uad_compliance_exchanges_status_idx
  ON appraisal.uad_compliance_exchanges (exchange_status, started_at DESC);
