-- Portal-neutral delivery records for UAD 3.6 work products. This migration
-- records destinations, immutable package identity, attempts, and receipts.
-- Portal credentials and authentication secrets are intentionally excluded.

CREATE TABLE IF NOT EXISTS appraisal.delivery_destinations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  platform_key text NOT NULL,
  tenant_key text NOT NULL,
  display_name text NOT NULL,
  base_url text NOT NULL,
  delivery_mode text NOT NULL DEFAULT 'guided_manual',
  direct_integration text NOT NULL DEFAULT 'not_configured',
  enabled boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform_key, tenant_key),
  CHECK (platform_key ~ '^[a-z0-9_]{2,80}$'),
  CHECK (tenant_key ~ '^[a-z0-9_.-]{1,120}$'),
  CHECK (char_length(display_name) BETWEEN 1 AND 160),
  CHECK (base_url ~ '^https://[^[:space:]]+$'),
  CHECK (delivery_mode IN ('guided_manual', 'api', 'sftp', 'secure_email')),
  CHECK (direct_integration IN (
    'not_configured', 'partner_documentation_required',
    'partner_credentials_required', 'configured'
  )),
  CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE INDEX IF NOT EXISTS delivery_destinations_organization_idx
  ON appraisal.delivery_destinations (organization_id, enabled, display_name);

CREATE TABLE IF NOT EXISTS appraisal.delivery_attempts (
  id uuid PRIMARY KEY,
  destination_id uuid NOT NULL
    REFERENCES appraisal.delivery_destinations(id) ON DELETE RESTRICT,
  workfile_id uuid NOT NULL
    REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  artifact_id uuid NOT NULL
    REFERENCES appraisal.uad_generated_artifacts(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  delivery_mode text NOT NULL DEFAULT 'guided_manual',
  status text NOT NULL DEFAULT 'prepared',
  external_order_id text,
  external_delivery_id text,
  receipt_reference text,
  package_byte_size bigint NOT NULL,
  package_checksum_sha256 text NOT NULL,
  failure_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  completed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination_id, idempotency_key),
  CHECK (revision_number > 0),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 160),
  CHECK (delivery_mode IN ('guided_manual', 'api', 'sftp', 'secure_email')),
  CHECK (status IN ('prepared', 'delivered', 'failed', 'cancelled')),
  CHECK (external_order_id IS NULL OR char_length(external_order_id) <= 200),
  CHECK (external_delivery_id IS NULL OR char_length(external_delivery_id) <= 200),
  CHECK (receipt_reference IS NULL OR char_length(receipt_reference) <= 500),
  CHECK (package_byte_size > 0 AND package_byte_size <= 62914560),
  CHECK (package_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_.-]{1,120}$'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL),
  CHECK (status <> 'failed' OR (failed_at IS NOT NULL AND failure_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS delivery_attempts_workfile_idx
  ON appraisal.delivery_attempts (workfile_id, prepared_at DESC);

CREATE INDEX IF NOT EXISTS delivery_attempts_destination_status_idx
  ON appraisal.delivery_attempts (destination_id, status, prepared_at DESC);
