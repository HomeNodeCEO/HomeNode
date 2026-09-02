ALTER TABLE app.assignment_documents
  ADD COLUMN IF NOT EXISTS tax_protest_file_id uuid;

DO $$
BEGIN
  ALTER TABLE app.assignment_documents
    DROP CONSTRAINT IF EXISTS assignment_documents_document_type_check;
  ALTER TABLE app.assignment_documents
    ADD CONSTRAINT assignment_documents_document_type_check
    CHECK (document_type IN (
      'zoning_map', 'zoning_ordinance', 'purchase_contract',
      'engagement_letter', 'mls_sheet', 'district_evidence', 'map', 'other'
    ));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'assignment_documents_tax_protest_file_fk'
       AND conrelid = 'app.assignment_documents'::regclass
  ) THEN
    ALTER TABLE app.assignment_documents
      ADD CONSTRAINT assignment_documents_tax_protest_file_fk
      FOREIGN KEY (tax_protest_file_id)
      REFERENCES app.tax_protest_files(id) ON DELETE RESTRICT;
  END IF;

  ALTER TABLE app.assignment_documents
    DROP CONSTRAINT IF EXISTS assignment_documents_single_workflow_check;
  ALTER TABLE app.assignment_documents
    ADD CONSTRAINT assignment_documents_single_workflow_check
    CHECK (num_nonnulls(assignment_file_id, uad_workfile_id, tax_protest_file_id) <= 1);
END
$$;

DROP INDEX IF EXISTS app.assignment_documents_scope_checksum_uidx;
DROP INDEX IF EXISTS app.assignment_documents_workflow_checksum_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS assignment_documents_v2_workflow_checksum_uidx
  ON app.assignment_documents (
    account_id,
    COALESCE(assignment_file_id, 0),
    COALESCE(uad_workfile_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(tax_protest_file_id, '00000000-0000-0000-0000-000000000000'::uuid),
    checksum_sha256
  );

CREATE INDEX IF NOT EXISTS assignment_documents_tax_protest_file_idx
  ON app.assignment_documents (tax_protest_file_id, uploaded_at DESC)
  WHERE tax_protest_file_id IS NOT NULL;
