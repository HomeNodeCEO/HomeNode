ALTER TABLE app.inspection_field_edits
  ADD COLUMN IF NOT EXISTS target_base jsonb,
  ADD COLUMN IF NOT EXISTS target_base_revision integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inspection_field_edits_target_base_check'
       AND conrelid = 'app.inspection_field_edits'::regclass
  ) THEN
    ALTER TABLE app.inspection_field_edits
      ADD CONSTRAINT inspection_field_edits_target_base_check
      CHECK (
        target_base IS NULL
        OR (
          jsonb_typeof(target_base) = 'object'
          AND target_base ? 'exists'
          AND jsonb_typeof(target_base -> 'exists') = 'boolean'
          AND ((target_base ->> 'exists')::boolean = (target_base ? 'value'))
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inspection_field_edits_target_base_revision_check'
       AND conrelid = 'app.inspection_field_edits'::regclass
  ) THEN
    ALTER TABLE app.inspection_field_edits
      ADD CONSTRAINT inspection_field_edits_target_base_revision_check
      CHECK ((target_base IS NULL) = (target_base_revision IS NULL)
        AND (target_base_revision IS NULL OR target_base_revision >= 1));
  END IF;
END
$$;
CREATE TABLE IF NOT EXISTS app.mobile_target_field_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  field_edit_id uuid NOT NULL REFERENCES app.inspection_field_edits(id) ON DELETE RESTRICT,
  workflow_type text NOT NULL,
  field_path text NOT NULL,
  target_reference jsonb NOT NULL,
  base_target_revision integer NOT NULL,
  base_exists boolean NOT NULL,
  base_value jsonb,
  proposed_exists boolean NOT NULL,
  proposed_value jsonb,
  source_type text NOT NULL,
  appraiser_confirmed boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending',
  conflict jsonb,
  reviewed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  applied_target_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (field_edit_id),
  CHECK (workflow_type IN ('uad_3_6', 'property_tax_protest')),
  CHECK (char_length(trim(field_path)) BETWEEN 1 AND 500),
  CHECK (jsonb_typeof(target_reference) = 'object'),
  CHECK (base_target_revision >= 1),
  CHECK (source_type IN ('appraiser', 'measurement', 'device', 'imported', 'suggested')),
  CHECK (status IN ('pending', 'accepted', 'rejected', 'conflict', 'superseded')),
  CHECK (applied_target_revision IS NULL OR applied_target_revision >= 1),
  CHECK (base_exists OR base_value IS NULL),
  CHECK (proposed_exists OR proposed_value IS NULL)
);

CREATE INDEX IF NOT EXISTS mobile_target_field_proposals_session_idx
  ON app.mobile_target_field_proposals (inspection_session_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS mobile_target_field_proposals_pending_path_uidx
  ON app.mobile_target_field_proposals (inspection_session_id, field_path)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS app.mobile_target_review_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL REFERENCES app.mobile_target_field_proposals(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS mobile_target_review_operations_proposal_idx
  ON app.mobile_target_review_operations (proposal_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS app.mobile_target_adapter_events (
  id bigserial PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  proposal_id uuid REFERENCES app.mobile_target_field_proposals(id) ON DELETE RESTRICT,
  workflow_type text NOT NULL,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workflow_type IN ('uad_3_6', 'property_tax_protest')),
  CHECK (event_type IN (
    'target_adapter.proposal_created', 'target_adapter.proposal_superseded',
    'target_adapter.proposal_accepted', 'target_adapter.proposal_rejected',
    'target_adapter.proposal_conflict'
  )),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS mobile_target_adapter_events_session_idx
  ON app.mobile_target_adapter_events (inspection_session_id, occurred_at DESC, id DESC);
