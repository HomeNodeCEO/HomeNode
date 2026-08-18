CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS app_auth;

CREATE TABLE IF NOT EXISTS app_auth.oidc_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  provider_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz,
  CHECK (char_length(trim(issuer)) BETWEEN 8 AND 500),
  CHECK (char_length(trim(subject)) BETWEEN 1 AND 500),
  UNIQUE (issuer, subject),
  UNIQUE (user_id, issuer)
);

CREATE INDEX IF NOT EXISTS oidc_identities_user_idx
  ON app_auth.oidc_identities (user_id);

CREATE TABLE IF NOT EXISTS app.tax_protest_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE RESTRICT,
  file_number text NOT NULL,
  previous_file_id uuid REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT,
  workfile_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  assigned_appraiser_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(file_number)) BETWEEN 1 AND 100),
  CHECK (status IN ('draft', 'in_progress', 'review_required', 'completed', 'archived', 'cancelled')),
  CHECK (revision >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS tax_protest_files_org_number_uidx
  ON app.tax_protest_files (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(file_number)
  );

CREATE INDEX IF NOT EXISTS tax_protest_files_account_updated_idx
  ON app.tax_protest_files (account_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app.tax_protest_file_history (
  id bigserial PRIMARY KEY,
  tax_protest_file_id uuid NOT NULL REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  workfile_data jsonb NOT NULL,
  status text NOT NULL,
  changed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  change_summary text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (revision >= 1),
  UNIQUE (tax_protest_file_id, revision)
);

CREATE TABLE IF NOT EXISTS app.report_file_number_counters (
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  workflow_type text NOT NULL,
  calendar_year integer NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, workflow_type, calendar_year),
  CHECK (workflow_type IN ('custom_appraisal', 'uad_3_6', 'property_tax_protest')),
  CHECK (calendar_year BETWEEN 2000 AND 2200),
  CHECK (next_value >= 1)
);

CREATE TABLE IF NOT EXISTS app.report_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE RESTRICT,
  workflow_type text NOT NULL,
  file_number text NOT NULL,
  sequence_number bigint,
  creation_request_id uuid,
  previous_report_file_id uuid REFERENCES app.report_files(id) ON DELETE RESTRICT,
  custom_assignment_file_id bigint REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  uad_workfile_id uuid REFERENCES appraisal.uad_workfiles(id) ON DELETE RESTRICT,
  tax_protest_file_id uuid REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT,
  is_current boolean NOT NULL DEFAULT true,
  registry_revision integer NOT NULL DEFAULT 1,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workflow_type IN ('custom_appraisal', 'uad_3_6', 'property_tax_protest')),
  CHECK (char_length(trim(file_number)) BETWEEN 1 AND 100),
  CHECK (sequence_number IS NULL OR sequence_number >= 1),
  CHECK (registry_revision >= 1),
  CHECK (
    (workflow_type = 'custom_appraisal'
      AND custom_assignment_file_id IS NOT NULL
      AND uad_workfile_id IS NULL
      AND tax_protest_file_id IS NULL)
    OR
    (workflow_type = 'uad_3_6'
      AND custom_assignment_file_id IS NULL
      AND uad_workfile_id IS NOT NULL
      AND tax_protest_file_id IS NULL)
    OR
    (workflow_type = 'property_tax_protest'
      AND custom_assignment_file_id IS NULL
      AND uad_workfile_id IS NULL
      AND tax_protest_file_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS report_files_custom_target_uidx
  ON app.report_files (custom_assignment_file_id)
  WHERE custom_assignment_file_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS report_files_uad_target_uidx
  ON app.report_files (uad_workfile_id)
  WHERE uad_workfile_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS report_files_tax_target_uidx
  ON app.report_files (tax_protest_file_id)
  WHERE tax_protest_file_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS report_files_creation_request_uidx
  ON app.report_files (organization_id, creation_request_id)
  WHERE organization_id IS NOT NULL AND creation_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS report_files_account_number_uidx
  ON app.report_files (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    workflow_type,
    account_id,
    lower(file_number)
  );

CREATE INDEX IF NOT EXISTS report_files_account_recent_idx
  ON app.report_files (account_id, workflow_type, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS report_files_organization_recent_idx
  ON app.report_files (organization_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app.report_file_events (
  id bigserial PRIMARY KEY,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  prior_registry_revision integer,
  next_registry_revision integer,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(event_type)) BETWEEN 1 AND 100),
  CHECK (prior_registry_revision IS NULL OR prior_registry_revision >= 1),
  CHECK (next_registry_revision IS NULL OR next_registry_revision >= 1)
);

CREATE INDEX IF NOT EXISTS report_file_events_file_time_idx
  ON app.report_file_events (report_file_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS app.report_file_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  archive_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  storage_provider text NOT NULL DEFAULT 'r2',
  storage_bucket text,
  object_key text,
  checksum_sha256 text,
  byte_size bigint,
  asset_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  retention_starts_at timestamptz,
  retention_until timestamptz,
  required_retention_years integer NOT NULL DEFAULT 5,
  legal_hold boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (archive_revision >= 1),
  CHECK (status IN ('pending', 'building', 'verified', 'failed', 'superseded')),
  CHECK (byte_size IS NULL OR byte_size > 0),
  CHECK (asset_count >= 0),
  CHECK (required_retention_years = 5),
  CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (retention_until IS NULL OR retention_starts_at IS NOT NULL),
  CHECK (
    status <> 'verified'
    OR (
      storage_bucket IS NOT NULL
      AND object_key IS NOT NULL
      AND checksum_sha256 IS NOT NULL
      AND byte_size IS NOT NULL
      AND completed_at IS NOT NULL
      AND verified_at IS NOT NULL
      AND retention_starts_at IS NOT NULL
      AND retention_until >= retention_starts_at + interval '5 years'
    )
  ),
  UNIQUE (report_file_id, archive_revision)
);

CREATE INDEX IF NOT EXISTS report_file_archives_retention_idx
  ON app.report_file_archives (retention_until, legal_hold)
  WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS app.report_retention_events (
  id bigserial PRIMARY KEY,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  archive_id uuid REFERENCES app.report_file_archives(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  storage_class text NOT NULL,
  object_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN ('archive_requested', 'archive_verified', 'working_copy_deleted', 'retention_extended', 'legal_hold_set', 'legal_hold_released')),
  CHECK (storage_class IN ('device_transient', 'working_object', 'appraisal_file_archive'))
);

CREATE TABLE IF NOT EXISTS app.mobile_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  client_device_id text NOT NULL,
  platform text NOT NULL,
  app_version text,
  device_name text,
  status text NOT NULL DEFAULT 'active',
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  CHECK (char_length(trim(client_device_id)) BETWEEN 8 AND 200),
  CHECK (platform IN ('ios', 'android')),
  CHECK (status IN ('active', 'revoked')),
  UNIQUE (organization_id, user_id, client_device_id)
);

CREATE TABLE IF NOT EXISTS app.inspection_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  appraiser_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  mobile_device_id uuid REFERENCES app.mobile_devices(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'not_started',
  revision integer NOT NULL DEFAULT 1,
  base_report_revision integer NOT NULL,
  started_at timestamptz,
  last_synced_at timestamptz,
  review_required_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('not_started', 'in_progress', 'sync_pending', 'synchronized', 'review_required', 'completed')),
  CHECK (revision >= 1),
  CHECK (base_report_revision >= 1)
);

CREATE INDEX IF NOT EXISTS inspection_sessions_file_recent_idx
  ON app.inspection_sessions (report_file_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS inspection_sessions_appraiser_recent_idx
  ON app.inspection_sessions (appraiser_user_id, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS inspection_sessions_active_appraiser_file_uidx
  ON app.inspection_sessions (report_file_id, appraiser_user_id)
  WHERE status <> 'completed';

CREATE TABLE IF NOT EXISTS app.inspection_session_events (
  id bigserial PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  prior_revision integer,
  next_revision integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(event_type)) BETWEEN 1 AND 100),
  CHECK (prior_revision IS NULL OR prior_revision >= 1),
  CHECK (next_revision IS NULL OR next_revision >= 1)
);

CREATE INDEX IF NOT EXISTS inspection_session_events_session_time_idx
  ON app.inspection_session_events (inspection_session_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS app.inspection_field_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  field_path text NOT NULL,
  base_value jsonb,
  entered_value jsonb,
  source_type text NOT NULL DEFAULT 'appraiser',
  appraiser_confirmed boolean NOT NULL DEFAULT true,
  sync_status text NOT NULL DEFAULT 'pending',
  session_revision integer NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (char_length(trim(field_path)) BETWEEN 1 AND 500),
  CHECK (source_type IN ('appraiser', 'measurement', 'device', 'imported', 'suggested')),
  CHECK (sync_status IN ('pending', 'applied', 'conflict', 'rejected')),
  CHECK (session_revision >= 1)
);

CREATE INDEX IF NOT EXISTS inspection_field_edits_session_path_idx
  ON app.inspection_field_edits (inspection_session_id, field_path, created_at DESC, id);

CREATE TABLE IF NOT EXISTS app.mobile_sync_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  operation_kind text NOT NULL,
  base_session_revision integer NOT NULL,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'received',
  result jsonb,
  conflict jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  CHECK (char_length(trim(operation_kind)) BETWEEN 1 AND 100),
  CHECK (base_session_revision >= 1),
  CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (status IN ('received', 'applied', 'conflict', 'rejected')),
  UNIQUE (inspection_session_id, client_operation_id)
);

INSERT INTO app.report_files (
  organization_id,
  account_id,
  workflow_type,
  file_number,
  custom_assignment_file_id,
  is_current,
  registry_revision,
  created_at,
  updated_at
)
SELECT
  NULL,
  f.account_id,
  'custom_appraisal',
  f.file_number,
  f.id,
  false,
  f.revision,
  f.created_at,
  f.updated_at
FROM app.assignment_files f
ON CONFLICT (custom_assignment_file_id) WHERE custom_assignment_file_id IS NOT NULL DO NOTHING;

INSERT INTO app.report_files (
  organization_id,
  account_id,
  workflow_type,
  file_number,
  uad_workfile_id,
  is_current,
  registry_revision,
  created_by_user_id,
  created_at,
  updated_at
)
SELECT
  w.organization_id,
  w.account_id,
  'uad_3_6',
  w.file_number,
  w.id,
  false,
  w.current_revision,
  w.created_by_user_id,
  w.created_at,
  w.updated_at
FROM appraisal.uad_workfiles w
ON CONFLICT (uad_workfile_id) WHERE uad_workfile_id IS NOT NULL DO NOTHING;

WITH parsed AS (
  SELECT report_file.organization_id,
         report_file.workflow_type,
         ((matches.parts)[2])::integer AS calendar_year,
         max(((matches.parts)[3])::bigint) + 1 AS next_value
    FROM app.report_files report_file
    CROSS JOIN LATERAL regexp_match(
      report_file.file_number,
      '^HN-(CA|UAD|PTP)-([0-9]{4})-([0-9]{6,9})$',
      'i'
    ) AS matches(parts)
   WHERE report_file.organization_id IS NOT NULL
     AND (
       (report_file.workflow_type = 'custom_appraisal' AND upper((matches.parts)[1]) = 'CA')
       OR (report_file.workflow_type = 'uad_3_6' AND upper((matches.parts)[1]) = 'UAD')
       OR (report_file.workflow_type = 'property_tax_protest' AND upper((matches.parts)[1]) = 'PTP')
     )
   GROUP BY report_file.organization_id, report_file.workflow_type, (matches.parts)[2]
)
INSERT INTO app.report_file_number_counters (
  organization_id, workflow_type, calendar_year, next_value
)
SELECT organization_id, workflow_type, calendar_year, next_value
  FROM parsed
ON CONFLICT (organization_id, workflow_type, calendar_year)
DO UPDATE SET next_value = greatest(
  app.report_file_number_counters.next_value,
  EXCLUDED.next_value
), updated_at = now();

UPDATE app.report_files child
   SET previous_report_file_id = parent.id
  FROM app.assignment_files assignment_file
  JOIN app.report_files parent
    ON parent.custom_assignment_file_id = assignment_file.inherited_from_file_id
 WHERE child.custom_assignment_file_id = assignment_file.id
   AND child.previous_report_file_id IS NULL;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        account_id, workflow_type
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS ordinal
    FROM app.report_files
)
UPDATE app.report_files report_file
   SET is_current = (ranked.ordinal = 1)
  FROM ranked
 WHERE report_file.id = ranked.id;
