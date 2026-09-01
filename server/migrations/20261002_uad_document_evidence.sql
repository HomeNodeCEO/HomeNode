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

WITH catalog(uid, rfid, context, name, type, required, options) AS (
  VALUES
    ('1000.0103', '2.001', 'borrower', 'PartyRoleType', 'Enumerated', false, '["Borrower"]'::jsonb),
    ('1000.0105', '2.001', 'borrower', 'PartyRoleType', 'Enumerated', false, '["Borrower"]'::jsonb),
    ('1000.0021', '2.002', 'seller', 'PartyRoleType', 'Enumerated', false, '["PropertySeller"]'::jsonb),
    ('1000.0116', '2.002', 'seller', 'PartyRoleType', 'Enumerated', false, '["PropertySeller"]'::jsonb),
    ('2400.0018', '2.010', 'assignment_client_primary_role', 'PartyRoleType', 'Enumerated', true, '["Client"]'::jsonb),
    ('2400.0017', '2.011', 'assignment_client_type_role', 'PartyRoleType', 'Enumerated', true, '["Attorney","Investor","Lender","ManagementCompany","Other"]'::jsonb),
    ('2400.0077', '2.011', 'assignment_client_type_role', 'PartyRoleTypeOtherDescription', 'String', false, NULL::jsonb),
    ('2400.0013', '2.012', 'assignment_client_name', 'FullName', 'String', true, NULL::jsonb),
    ('2400.0001', '2.013', 'assignment_client_address', 'AddressLineText', 'String', true, NULL::jsonb),
    ('2400.0002', '2.013', 'assignment_client_address', 'CityName', 'String', true, NULL::jsonb),
    ('2400.0004', '2.013', 'assignment_client_address', 'StateCode', 'String', true, NULL::jsonb),
    ('2400.0003', '2.013', 'assignment_client_address', 'PostalCode', 'String', true, NULL::jsonb)
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 2, 'Assignment Information',
  context, name, type, CASE WHEN required THEN 'Required' ELSE 'Conditional' END,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 'document_evidence',
    'options', options,
    'official_source', 'Appendix B-1 URAR Implementation Guide v1.4'
  ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT
  field.release_key,
  field.uid,
  field.property_context,
  option.value,
  regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
  option.ordinality,
  '{"phase":"document_evidence"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.uid IN ('1000.0103', '1000.0105', '1000.0021', '1000.0116', '2400.0018', '2400.0017')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;
