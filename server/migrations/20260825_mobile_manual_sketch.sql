CREATE TABLE IF NOT EXISTS app.inspection_sketches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES app_auth.organizations(id) ON DELETE RESTRICT,
  client_sketch_id uuid NOT NULL,
  workflow_type text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  measurement_standard text NOT NULL DEFAULT 'ansi_z765_2021',
  measurement_method text NOT NULL,
  review_status text NOT NULL DEFAULT 'draft',
  document jsonb NOT NULL,
  summary jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  confirmed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  updated_by_user_id uuid NOT NULL REFERENCES app_auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id),
  UNIQUE (inspection_session_id, client_sketch_id),
  CHECK (workflow_type IN ('custom_appraisal', 'uad_3_6', 'property_tax_protest')),
  CHECK (source = 'manual'),
  CHECK (measurement_standard IN ('ansi_z765_2021', 'jurisdiction_required_other')),
  CHECK (measurement_method IN ('exterior', 'interior_perimeter', 'plans', 'mixed')),
  CHECK (review_status IN ('draft', 'appraiser_confirmed')),
  CHECK (revision >= 1),
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (
    review_status <> 'appraiser_confirmed'
    OR (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS inspection_sketches_report_file_idx
  ON app.inspection_sketches (report_file_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS app.inspection_sketch_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sketch_id uuid NOT NULL REFERENCES app.inspection_sketches(id) ON DELETE RESTRICT,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  client_room_id uuid NOT NULL,
  room_ref text NOT NULL,
  area_ref uuid NOT NULL,
  label text NOT NULL,
  room_type text NOT NULL,
  level_label text NOT NULL,
  anchor jsonb NOT NULL,
  position integer NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sketch_id, client_room_id),
  UNIQUE (inspection_session_id, room_ref),
  CHECK (room_ref ~ '^sketch-room:[0-9a-f-]{36}$'),
  CHECK (char_length(trim(label)) BETWEEN 1 AND 80),
  CHECK (room_type IN (
    'living_room', 'family_room', 'dining_room', 'kitchen', 'bedroom',
    'bathroom', 'utility', 'office', 'foyer', 'hall', 'closet',
    'garage', 'storage', 'other'
  )),
  CHECK (char_length(trim(level_label)) BETWEEN 1 AND 80),
  CHECK (jsonb_typeof(anchor) = 'object'),
  CHECK (position BETWEEN 1 AND 100),
  CHECK (revision >= 1)
);

CREATE INDEX IF NOT EXISTS inspection_sketch_rooms_active_idx
  ON app.inspection_sketch_rooms (inspection_session_id, position, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app.inspection_sketch_history (
  id bigserial PRIMARY KEY,
  sketch_id uuid NOT NULL REFERENCES app.inspection_sketches(id) ON DELETE RESTRICT,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  summary jsonb NOT NULL,
  rooms jsonb NOT NULL,
  review_status text NOT NULL,
  changed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  client_operation_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sketch_id, revision),
  CHECK (revision >= 1),
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (jsonb_typeof(summary) = 'object'),
  CHECK (jsonb_typeof(rooms) = 'array'),
  CHECK (review_status IN ('draft', 'appraiser_confirmed'))
);

CREATE TABLE IF NOT EXISTS app.inspection_sketch_operations (
  id bigserial PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  base_sketch_revision integer NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id, client_operation_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (base_sketch_revision >= 0),
  CHECK (status = 'applied'),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE TABLE IF NOT EXISTS app.inspection_sketch_events (
  id bigserial PRIMARY KEY,
  sketch_id uuid NOT NULL REFERENCES app.inspection_sketches(id) ON DELETE RESTRICT,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  client_operation_id uuid,
  event_type text NOT NULL,
  prior_revision integer,
  next_revision integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN ('sketch.created', 'sketch.updated', 'sketch.appraiser_confirmed')),
  CHECK (prior_revision IS NULL OR prior_revision >= 1),
  CHECK (next_revision IS NULL OR next_revision >= 1),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS inspection_sketch_events_session_time_idx
  ON app.inspection_sketch_events (inspection_session_id, occurred_at DESC, id DESC);
