ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS uad_workfile_id uuid;

ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS report_file_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignment_documents_uad_workfile_fk'
       AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_uad_workfile_fk
      FOREIGN KEY (uad_workfile_id)
      REFERENCES appraisal.uad_workfiles(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignment_documents_report_file_fk'
       AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_report_file_fk
      FOREIGN KEY (report_file_id)
      REFERENCES app.report_files(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignment_documents_single_workflow_check'
       AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_single_workflow_check
      CHECK (assignment_file_id IS NULL OR uad_workfile_id IS NULL);
  END IF;
END
$$;

DROP INDEX IF EXISTS app.assignment_documents_scope_checksum_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS assignment_documents_workflow_checksum_uidx
  ON app.assignment_documents (
    account_id,
    COALESCE(assignment_file_id, 0),
    COALESCE(uad_workfile_id, '00000000-0000-0000-0000-000000000000'::uuid),
    checksum_sha256
  );

CREATE INDEX IF NOT EXISTS assignment_documents_uad_workfile_idx
  ON app.assignment_documents (uad_workfile_id, uploaded_at DESC)
  WHERE uad_workfile_id IS NOT NULL;
