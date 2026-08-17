CREATE SCHEMA IF NOT EXISTS app_auth;
CREATE SCHEMA IF NOT EXISTS uad_ref;
CREATE SCHEMA IF NOT EXISTS appraisal;

CREATE TABLE IF NOT EXISTS app_auth.organizations (
  id uuid PRIMARY KEY,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  dba_name text,
  contact_email text,
  contact_phone text,
  address_line_1 text,
  address_line_2 text,
  city text,
  state_code text,
  postal_code text,
  country_code text NOT NULL DEFAULT 'US',
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(legal_name)) > 0),
  CHECK (char_length(trim(display_name)) > 0)
);

CREATE TABLE IF NOT EXISTS app_auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  phone text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(email)) > 3),
  CHECK (char_length(trim(display_name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_auth_users_email_ci_uidx
  ON app_auth.users (lower(email));

CREATE TABLE IF NOT EXISTS app_auth.roles (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_auth.roles (code, display_name, description)
VALUES
  ('appraiser', 'Appraiser', 'Creates, signs, and revises appraisal reports.'),
  ('supervisory_appraiser', 'Supervisory appraiser', 'Supervises and co-signs applicable appraisal assignments.'),
  ('reviewer', 'Reviewer', 'Reviews appraisal data and validation findings without signing as the appraiser.'),
  ('organization_admin', 'Organization administrator', 'Manages an organization, memberships, and configuration.'),
  ('homenode_admin', 'HomeNode administrator', 'Operates HomeNode platform configuration and support workflows.')
ON CONFLICT (code) DO UPDATE
SET display_name = EXCLUDED.display_name,
    description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS app_auth.organization_memberships (
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  CHECK (status IN ('invited', 'active', 'suspended', 'inactive'))
);

CREATE TABLE IF NOT EXISTS app_auth.membership_roles (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_code text NOT NULL REFERENCES app_auth.roles(code) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (organization_id, user_id, role_code),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES app_auth.organization_memberships(organization_id, user_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_auth.appraiser_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_auth.users(id) ON DELETE CASCADE,
  default_organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE SET NULL,
  signature_policy text NOT NULL DEFAULT 'session',
  profile_status text NOT NULL DEFAULT 'draft',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (signature_policy IN ('session', 'reauthentication')),
  CHECK (profile_status IN ('draft', 'active', 'inactive'))
);

CREATE TABLE IF NOT EXISTS app_auth.appraiser_licenses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE CASCADE,
  jurisdiction text NOT NULL,
  license_number text NOT NULL,
  license_type text NOT NULL,
  issued_on date,
  expires_on date,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, jurisdiction, license_number),
  CHECK (status IN ('active', 'expired', 'suspended', 'inactive')),
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);

CREATE TABLE IF NOT EXISTS app_auth.supervision_relationships (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE CASCADE,
  supervisor_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  appraiser_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  effective_on date NOT NULL,
  expires_on date,
  status text NOT NULL DEFAULT 'planned',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (supervisor_user_id <> appraiser_user_id),
  CHECK (status IN ('planned', 'active', 'ended')),
  CHECK (expires_on IS NULL OR expires_on >= effective_on)
);

CREATE TABLE IF NOT EXISTS uad_ref.specification_releases (
  release_key text PRIMARY KEY,
  uad_version text NOT NULL,
  released_on date NOT NULL,
  component_versions jsonb NOT NULL,
  source_manifest jsonb NOT NULL,
  source_manifest_sha256 text,
  status text NOT NULL DEFAULT 'draft',
  imported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft', 'current', 'superseded', 'retired'))
);

INSERT INTO uad_ref.specification_releases (
  release_key,
  uad_version,
  released_on,
  component_versions,
  source_manifest,
  status
)
VALUES (
  'uad-3.6-2026-08-13-h1.5',
  '3.6',
  DATE '2026-08-13',
  '{"appendix_a_1":"1.4","appendix_b_1":"1.4","appendix_c_1":"1.3","appendix_d_1":"1.3","appendix_e":"1.5","appendix_f_1":"1.4","appendix_h_1":"1.5","subschema":"1.3"}'::jsonb,
  '{}'::jsonb,
  'current'
)
ON CONFLICT (release_key) DO UPDATE
SET component_versions = EXCLUDED.component_versions,
    released_on = EXCLUDED.released_on;

CREATE TABLE IF NOT EXISTS uad_ref.fields (
  release_key text NOT NULL REFERENCES uad_ref.specification_releases(release_key) ON DELETE CASCADE,
  uid text NOT NULL,
  report_field_id text,
  section_number integer,
  section_name text,
  property_context text NOT NULL DEFAULT 'Subject',
  data_point_name text,
  attribute_name text,
  data_type text,
  requirement text,
  cardinality text,
  definition text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (release_key, uid, property_context)
);

CREATE INDEX IF NOT EXISTS uad_ref_fields_report_field_idx
  ON uad_ref.fields (release_key, report_field_id);

CREATE TABLE IF NOT EXISTS uad_ref.enumerations (
  release_key text NOT NULL REFERENCES uad_ref.specification_releases(release_key) ON DELETE CASCADE,
  uid text NOT NULL,
  property_context text NOT NULL DEFAULT 'Subject',
  value text NOT NULL,
  display_label text,
  definition text,
  sort_order integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (release_key, uid, property_context, value)
);

CREATE TABLE IF NOT EXISTS uad_ref.compliance_rules (
  release_key text NOT NULL REFERENCES uad_ref.specification_releases(release_key) ON DELETE CASCADE,
  rule_id text NOT NULL,
  severity text NOT NULL,
  property_context text,
  message text NOT NULL,
  expression text,
  report_field_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (release_key, rule_id),
  CHECK (severity IN ('fatal', 'warning'))
);

CREATE TABLE IF NOT EXISTS appraisal.uad_workfiles (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES core.accounts(account_id) ON DELETE RESTRICT,
  file_number text NOT NULL,
  specification_release_key text NOT NULL
    REFERENCES uad_ref.specification_releases(release_key) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft',
  property_type text NOT NULL DEFAULT 'traditional_single_family',
  inspection_method text NOT NULL DEFAULT 'traditional',
  assignment_purpose text,
  assigned_appraiser_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  supervisory_appraiser_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  signed_at timestamptz,
  exported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(trim(file_number)) > 0),
  CHECK (current_revision > 0),
  CHECK (status IN ('draft', 'validating', 'ready', 'signed', 'exported', 'submitted', 'revised', 'cancelled')),
  CHECK (property_type IN ('traditional_single_family', 'condominium', 'cooperative', 'manufactured_home', 'two_to_four_unit')),
  CHECK (inspection_method IN ('traditional', 'hybrid', 'desktop'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uad_workfiles_org_file_number_ci_uidx
  ON appraisal.uad_workfiles (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(file_number)
  );

CREATE INDEX IF NOT EXISTS uad_workfiles_account_updated_idx
  ON appraisal.uad_workfiles (account_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS uad_workfiles_status_updated_idx
  ON appraisal.uad_workfiles (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS appraisal.uad_subject_snapshots (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  snapshot_version integer NOT NULL,
  source_account_updated_at timestamptz,
  source_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject_data jsonb NOT NULL,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, snapshot_version),
  CHECK (snapshot_version > 0)
);

CREATE TABLE IF NOT EXISTS appraisal.uad_entities (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  parent_entity_id uuid REFERENCES appraisal.uad_entities(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_identifier text NOT NULL,
  ordinal integer NOT NULL DEFAULT 1,
  label text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, entity_type, entity_identifier),
  CHECK (ordinal > 0),
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used'
  ))
);

CREATE INDEX IF NOT EXISTS uad_entities_workfile_type_idx
  ON appraisal.uad_entities (workfile_id, entity_type, ordinal);

CREATE TABLE IF NOT EXISTS appraisal.uad_field_values (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES appraisal.uad_entities(id) ON DELETE CASCADE,
  uad_uid text NOT NULL,
  report_field_id text,
  value jsonb,
  source_type text NOT NULL DEFAULT 'appraiser',
  source_reference text,
  source_observed_at timestamptz,
  confidence numeric,
  is_appraiser_confirmed boolean NOT NULL DEFAULT false,
  is_override boolean NOT NULL DEFAULT false,
  override_reason text,
  updated_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, entity_id, uad_uid),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (source_type IN ('homenode', 'public_record', 'mls', 'document', 'measurement', 'calculated', 'appraiser', 'imported')),
  CHECK (NOT is_override OR override_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS uad_field_values_workfile_uid_idx
  ON appraisal.uad_field_values (workfile_id, uad_uid);

CREATE UNIQUE INDEX IF NOT EXISTS uad_field_values_entity_uidx
  ON appraisal.uad_field_values (
    workfile_id,
    COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    uad_uid
  );

CREATE TABLE IF NOT EXISTS appraisal.uad_revisions (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  specification_release_key text NOT NULL
    REFERENCES uad_ref.specification_releases(release_key) ON DELETE RESTRICT,
  document jsonb NOT NULL,
  change_summary text,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, revision_number),
  CHECK (revision_number > 0)
);

CREATE TABLE IF NOT EXISTS appraisal.uad_validation_runs (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  specification_release_key text NOT NULL
    REFERENCES uad_ref.specification_releases(release_key) ON DELETE RESTRICT,
  validator_type text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  fatal_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  requested_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (revision_number > 0),
  CHECK (validator_type IN ('local_schema', 'local_compliance', 'fannie_api', 'freddie_api', 'package')),
  CHECK (status IN ('running', 'passed', 'failed', 'error')),
  CHECK (fatal_count >= 0 AND warning_count >= 0)
);

CREATE INDEX IF NOT EXISTS uad_validation_runs_workfile_idx
  ON appraisal.uad_validation_runs (workfile_id, started_at DESC);

CREATE TABLE IF NOT EXISTS appraisal.uad_validation_findings (
  id uuid PRIMARY KEY,
  validation_run_id uuid NOT NULL REFERENCES appraisal.uad_validation_runs(id) ON DELETE CASCADE,
  rule_id text,
  severity text NOT NULL,
  uad_uid text,
  report_field_id text,
  entity_id uuid REFERENCES appraisal.uad_entities(id) ON DELETE SET NULL,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution_note text,
  resolved_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (severity IN ('fatal', 'warning')),
  CHECK (status IN ('open', 'resolved', 'accepted', 'superseded'))
);

CREATE INDEX IF NOT EXISTS uad_validation_findings_run_status_idx
  ON appraisal.uad_validation_findings (validation_run_id, status, severity);

CREATE TABLE IF NOT EXISTS appraisal.uad_assets (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES appraisal.uad_entities(id) ON DELETE SET NULL,
  asset_kind text NOT NULL,
  section_number integer,
  caption_type text,
  caption text,
  storage_provider text NOT NULL,
  storage_bucket text,
  object_key text NOT NULL,
  original_file_name text,
  content_type text NOT NULL,
  byte_size bigint,
  checksum_sha256 text,
  status text NOT NULL DEFAULT 'pending_upload',
  capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  upload_expires_at timestamptz,
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_provider, storage_bucket, object_key),
  CHECK (asset_kind IN ('photo', 'image', 'sketch', 'floor_plan', 'measurement_source', 'supporting_document', 'signature')),
  CHECK (storage_provider IN ('r2', 's3', 'external', 'postgres')),
  CHECK (status IN ('pending_upload', 'uploaded', 'verified', 'rejected', 'deleted')),
  CHECK (byte_size IS NULL OR byte_size >= 0)
);

CREATE INDEX IF NOT EXISTS uad_assets_workfile_section_idx
  ON appraisal.uad_assets (workfile_id, section_number, asset_kind, created_at);

CREATE TABLE IF NOT EXISTS appraisal.uad_sketches (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES appraisal.uad_entities(id) ON DELETE SET NULL,
  schema_version text NOT NULL DEFAULT '1.0',
  geometry jsonb NOT NULL DEFAULT '{}'::jsonb,
  measurements jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_areas jsonb NOT NULL DEFAULT '{}'::jsonb,
  area_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  rendered_asset_id uuid REFERENCES appraisal.uad_assets(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'homenode',
  created_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source IN ('homenode', 'mobile', 'imported', 'third_party'))
);

CREATE INDEX IF NOT EXISTS uad_sketches_workfile_idx
  ON appraisal.uad_sketches (workfile_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS appraisal.uad_generated_artifacts (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  artifact_type text NOT NULL,
  storage_provider text NOT NULL,
  storage_bucket text,
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint,
  checksum_sha256 text,
  generation_status text NOT NULL DEFAULT 'pending',
  generated_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, revision_number, artifact_type),
  CHECK (revision_number > 0),
  CHECK (artifact_type IN ('xml', 'pdf', 'images_manifest', 'submission_package')),
  CHECK (storage_provider IN ('r2', 's3', 'external', 'postgres')),
  CHECK (generation_status IN ('pending', 'generating', 'ready', 'failed', 'superseded')),
  CHECK (byte_size IS NULL OR byte_size >= 0)
);

CREATE TABLE IF NOT EXISTS appraisal.uad_signatures (
  id uuid PRIMARY KEY,
  workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  signer_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  signer_role text NOT NULL,
  signature_asset_id uuid REFERENCES appraisal.uad_assets(id) ON DELETE SET NULL,
  credential_snapshot jsonb NOT NULL,
  authentication_method text NOT NULL DEFAULT 'session',
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workfile_id, revision_number, signer_user_id, signer_role),
  CHECK (signer_role IN ('appraiser', 'supervisory_appraiser')),
  CHECK (authentication_method IN ('session', 'reauthentication'))
);

CREATE TABLE IF NOT EXISTS appraisal.uad_audit_events (
  id bigserial PRIMARY KEY,
  workfile_id uuid REFERENCES appraisal.uad_workfiles(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS uad_audit_events_workfile_time_idx
  ON appraisal.uad_audit_events (workfile_id, occurred_at DESC, id DESC);
