CREATE TABLE IF NOT EXISTS app.mobile_uad_entity_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  uad_workfile_id uuid NOT NULL REFERENCES appraisal.uad_workfiles(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  parent_entity_id uuid,
  target_entity_id uuid,
  label text,
  entity_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_target_revision integer NOT NULL,
  base_entity jsonb,
  status text NOT NULL DEFAULT 'pending',
  conflict jsonb,
  reviewed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  applied_entity_id uuid,
  applied_target_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id, client_operation_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (action IN ('create', 'delete')),
  CHECK (char_length(trim(entity_type)) BETWEEN 1 AND 100),
  CHECK (label IS NULL OR char_length(trim(label)) BETWEEN 1 AND 120),
  CHECK (jsonb_typeof(entity_data) = 'object'),
  CHECK (base_target_revision >= 1),
  CHECK (base_entity IS NULL OR jsonb_typeof(base_entity) = 'object'),
  CHECK (status IN ('pending', 'accepted', 'rejected', 'conflict')),
  CHECK (conflict IS NULL OR jsonb_typeof(conflict) = 'object'),
  CHECK (applied_target_revision IS NULL OR applied_target_revision >= 1),
  CHECK (
    (action = 'create' AND target_entity_id IS NULL AND base_entity IS NULL)
    OR
    (action = 'delete' AND target_entity_id IS NOT NULL AND base_entity IS NOT NULL
      AND parent_entity_id IS NULL AND label IS NULL AND entity_data = '{}'::jsonb)
  )
);

CREATE INDEX IF NOT EXISTS mobile_uad_entity_proposals_session_idx
  ON app.mobile_uad_entity_proposals (inspection_session_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS mobile_uad_entity_proposals_target_idx
  ON app.mobile_uad_entity_proposals (target_entity_id, status)
  WHERE target_entity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.mobile_uad_entity_review_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL REFERENCES app.mobile_uad_entity_proposals(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  decision text NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id, client_operation_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (decision IN ('accept', 'reject')),
  CHECK (status IN ('applied', 'conflict')),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS mobile_uad_entity_review_operations_proposal_idx
  ON app.mobile_uad_entity_review_operations (proposal_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS app.mobile_uad_entity_events (
  id bigserial PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  proposal_id uuid REFERENCES app.mobile_uad_entity_proposals(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN (
    'uad_entity.proposal_created', 'uad_entity.proposal_accepted',
    'uad_entity.proposal_rejected', 'uad_entity.proposal_conflict'
  )),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS mobile_uad_entity_events_session_idx
  ON app.mobile_uad_entity_events (inspection_session_id, occurred_at DESC, id DESC);
