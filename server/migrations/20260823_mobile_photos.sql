CREATE TABLE IF NOT EXISTS app.inspection_photos (
  id uuid PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  captured_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  client_photo_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  workflow_type text NOT NULL,
  category text NOT NULL,
  category_source text NOT NULL,
  room_ref text,
  room_label text,
  caption text,
  caption_source text NOT NULL,
  source text NOT NULL,
  position integer NOT NULL,
  captured_at timestamptz,
  capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending_upload',
  revision integer NOT NULL DEFAULT 1,
  required_retention_years integer NOT NULL DEFAULT 5,
  retention_starts_at timestamptz,
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  excluded_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id, client_photo_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (workflow_type IN ('custom_appraisal', 'uad_3_6', 'property_tax_protest')),
  CHECK (char_length(trim(category)) BETWEEN 1 AND 80),
  CHECK (category_source IN ('custom_catalog', 'uad_catalog', 'sketch_room', 'manual')),
  CHECK (room_ref IS NULL OR char_length(trim(room_ref)) BETWEEN 1 AND 120),
  CHECK (room_label IS NULL OR char_length(trim(room_label)) BETWEEN 1 AND 80),
  CHECK (caption IS NULL OR char_length(caption) <= 200),
  CHECK (caption_source IN ('category', 'room_auto', 'manual')),
  CHECK (source IN ('camera', 'library')),
  CHECK (position BETWEEN 1 AND 100),
  CHECK (status IN ('pending_upload', 'verifying', 'verified', 'failed', 'excluded', 'deleted')),
  CHECK (revision >= 1),
  CHECK (required_retention_years = 5),
  CHECK (retention_until IS NULL OR retention_starts_at IS NOT NULL),
  CHECK (
    status NOT IN ('verified', 'excluded')
    OR (
      verified_at IS NOT NULL
      AND retention_starts_at IS NOT NULL
      AND retention_until >= retention_starts_at + interval '5 years'
    )
  )
);

CREATE INDEX IF NOT EXISTS inspection_photos_active_position_idx
  ON app.inspection_photos (inspection_session_id, position)
  WHERE status NOT IN ('excluded', 'deleted');

CREATE INDEX IF NOT EXISTS inspection_photos_report_file_idx
  ON app.inspection_photos (report_file_id, status, position, created_at);

CREATE INDEX IF NOT EXISTS inspection_photos_retention_idx
  ON app.inspection_photos (retention_until, legal_hold)
  WHERE status IN ('verified', 'excluded');

CREATE TABLE IF NOT EXISTS app.inspection_photo_objects (
  id uuid PRIMARY KEY,
  photo_id uuid NOT NULL REFERENCES app.inspection_photos(id) ON DELETE RESTRICT,
  client_object_id uuid NOT NULL,
  variant text NOT NULL,
  storage_provider text NOT NULL DEFAULT 'r2',
  storage_bucket text NOT NULL,
  object_key text NOT NULL,
  original_file_name text NOT NULL,
  content_type text NOT NULL,
  expected_byte_size bigint NOT NULL,
  byte_size bigint,
  pixel_width integer,
  pixel_height integer,
  status text NOT NULL DEFAULT 'pending_upload',
  upload_expires_at timestamptz,
  storage_etag text,
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, variant),
  UNIQUE (photo_id, client_object_id),
  UNIQUE (storage_provider, storage_bucket, object_key),
  CHECK (variant IN ('original', 'display')),
  CHECK (char_length(trim(original_file_name)) BETWEEN 1 AND 255),
  CHECK (content_type IN (
    'image/avif', 'image/bmp', 'image/heic', 'image/heif', 'image/jpeg',
    'image/png', 'image/tiff', 'image/webp'
  )),
  CHECK (expected_byte_size BETWEEN 1 AND 52428800),
  CHECK (byte_size IS NULL OR byte_size BETWEEN 1 AND 52428800),
  CHECK (pixel_width IS NULL OR pixel_width > 0),
  CHECK (pixel_height IS NULL OR pixel_height > 0),
  CHECK (status IN ('pending_upload', 'verified', 'rejected'))
);

CREATE INDEX IF NOT EXISTS inspection_photo_objects_photo_idx
  ON app.inspection_photo_objects (photo_id, variant);

CREATE TABLE IF NOT EXISTS app.inspection_photo_events (
  id bigserial PRIMARY KEY,
  photo_id uuid NOT NULL REFERENCES app.inspection_photos(id) ON DELETE RESTRICT,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  client_operation_id uuid,
  request_sha256 text,
  event_type text NOT NULL,
  prior_revision integer,
  next_revision integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (photo_id, client_operation_id),
  CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (event_type IN (
    'photo.created', 'photo.verified', 'photo.verification_failed',
    'photo.metadata_updated', 'photo.excluded', 'photo.placeholder_deleted'
  )),
  CHECK (prior_revision IS NULL OR prior_revision >= 1),
  CHECK (next_revision IS NULL OR next_revision >= 1)
);

CREATE INDEX IF NOT EXISTS inspection_photo_events_session_time_idx
  ON app.inspection_photo_events (inspection_session_id, occurred_at DESC, id DESC);
