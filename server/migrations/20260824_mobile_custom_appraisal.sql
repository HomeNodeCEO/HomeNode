CREATE TABLE IF NOT EXISTS app.custom_appraisal_sections (
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  section_key text NOT NULL,
  section_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  last_applied_session_id uuid REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  last_applied_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_file_id, section_key),
  CHECK (section_key IN ('report.property_characteristics')),
  CHECK (jsonb_typeof(section_value) = 'object'),
  CHECK (revision >= 1)
);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_section_history (
  id bigserial PRIMARY KEY,
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  section_key text NOT NULL,
  section_value jsonb NOT NULL,
  revision integer NOT NULL,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  proposal_id uuid,
  changed_path text[] NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (section_key IN ('report.property_characteristics')),
  CHECK (jsonb_typeof(section_value) = 'object'),
  CHECK (revision >= 1),
  CHECK (cardinality(changed_path) BETWEEN 1 AND 12)
);

CREATE INDEX IF NOT EXISTS custom_appraisal_section_history_file_idx
  ON app.custom_appraisal_section_history (assignment_file_id, section_key, revision DESC, id DESC);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  field_edit_id uuid NOT NULL REFERENCES app.inspection_field_edits(id) ON DELETE RESTRICT,
  field_path text NOT NULL,
  target_kind text NOT NULL,
  section_key text NOT NULL,
  target_path text[] NOT NULL,
  base_target_revision integer NOT NULL,
  base_exists boolean NOT NULL,
  base_value jsonb,
  proposed_exists boolean NOT NULL,
  proposed_value jsonb,
  source_type text NOT NULL,
  appraiser_confirmed boolean NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reviewed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  applied_target_revision integer,
  conflict jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (field_edit_id),
  CHECK (char_length(trim(field_path)) BETWEEN 1 AND 500),
  CHECK (target_kind IN ('assignment_details', 'report_section')),
  CHECK (section_key IN ('report.assignment_details', 'report.property_characteristics')),
  CHECK (cardinality(target_path) BETWEEN 1 AND 12),
  CHECK (base_target_revision >= 0),
  CHECK (source_type IN ('appraiser', 'measurement', 'device', 'imported', 'suggested')),
  CHECK (status IN ('pending', 'accepted', 'rejected', 'conflict', 'superseded')),
  CHECK (applied_target_revision IS NULL OR applied_target_revision >= 1),
  CHECK (conflict IS NULL OR jsonb_typeof(conflict) = 'object')
);

CREATE INDEX IF NOT EXISTS custom_appraisal_proposals_session_status_idx
  ON app.custom_appraisal_proposals (inspection_session_id, status, created_at, id);

CREATE INDEX IF NOT EXISTS custom_appraisal_proposals_assignment_idx
  ON app.custom_appraisal_proposals (assignment_file_id, section_key, created_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'custom_appraisal_section_history_proposal_fk'
       AND conrelid = 'app.custom_appraisal_section_history'::regclass
  ) THEN
    ALTER TABLE app.custom_appraisal_section_history
      ADD CONSTRAINT custom_appraisal_section_history_proposal_fk
      FOREIGN KEY (proposal_id) REFERENCES app.custom_appraisal_proposals(id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS app.custom_appraisal_review_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  proposal_id uuid NOT NULL REFERENCES app.custom_appraisal_proposals(id) ON DELETE RESTRICT,
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

CREATE INDEX IF NOT EXISTS custom_appraisal_review_operations_proposal_idx
  ON app.custom_appraisal_review_operations (proposal_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS app.custom_appraisal_adapter_events (
  id bigserial PRIMARY KEY,
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  assignment_file_id bigint NOT NULL REFERENCES app.assignment_files(id) ON DELETE RESTRICT,
  proposal_id uuid REFERENCES app.custom_appraisal_proposals(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN (
    'custom_adapter.proposal_created', 'custom_adapter.proposal_superseded',
    'custom_adapter.proposal_accepted', 'custom_adapter.proposal_rejected',
    'custom_adapter.proposal_conflict'
  )),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS custom_appraisal_adapter_events_session_idx
  ON app.custom_appraisal_adapter_events (inspection_session_id, occurred_at DESC, id DESC);
