ALTER TABLE app.inspection_sessions
  ADD COLUMN IF NOT EXISTS completed_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS completion_summary jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inspection_sessions_completion_summary_check'
       AND conrelid = 'app.inspection_sessions'::regclass
  ) THEN
    ALTER TABLE app.inspection_sessions
      ADD CONSTRAINT inspection_sessions_completion_summary_check
      CHECK (completion_summary IS NULL OR jsonb_typeof(completion_summary) = 'object');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS app.inspection_completion_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_session_id uuid NOT NULL REFERENCES app.inspection_sessions(id) ON DELETE RESTRICT,
  report_file_id uuid NOT NULL REFERENCES app.report_files(id) ON DELETE RESTRICT,
  client_operation_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  base_session_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'applied',
  result jsonb NOT NULL,
  actor_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_session_id),
  UNIQUE (inspection_session_id, client_operation_id),
  CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (base_session_revision >= 1),
  CHECK (status = 'applied'),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS inspection_completion_operations_report_idx
  ON app.inspection_completion_operations (report_file_id, created_at DESC, id);
