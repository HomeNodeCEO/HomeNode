ALTER TABLE app.inspection_field_edits
  ADD COLUMN IF NOT EXISTS client_operation_id uuid,
  ADD COLUMN IF NOT EXISTS is_tombstone boolean NOT NULL DEFAULT false;

ALTER TABLE app.mobile_sync_operations
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by_user_id uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolution text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'inspection_field_edits_client_operation_fk'
       AND conrelid = 'app.inspection_field_edits'::regclass
  ) THEN
    ALTER TABLE app.inspection_field_edits
      ADD CONSTRAINT inspection_field_edits_client_operation_fk
      FOREIGN KEY (client_operation_id)
      REFERENCES app.mobile_sync_operations(id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mobile_sync_operations_resolution_check'
       AND conrelid = 'app.mobile_sync_operations'::regclass
  ) THEN
    ALTER TABLE app.mobile_sync_operations
      ADD CONSTRAINT mobile_sync_operations_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('accept_server', 'apply_mobile'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS inspection_field_edits_client_operation_uidx
  ON app.inspection_field_edits (client_operation_id)
  WHERE client_operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mobile_sync_operations_unresolved_conflict_idx
  ON app.mobile_sync_operations (inspection_session_id, received_at, id)
  WHERE status = 'conflict' AND resolved_at IS NULL;

