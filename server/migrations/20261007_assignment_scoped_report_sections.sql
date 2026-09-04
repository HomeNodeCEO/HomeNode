ALTER TABLE app.custom_appraisal_sections
  DROP CONSTRAINT IF EXISTS custom_appraisal_sections_section_key_check;

ALTER TABLE app.custom_appraisal_sections
  ADD CONSTRAINT custom_appraisal_sections_section_key_check
  CHECK (section_key IN (
    'report.subject_identification',
    'report.exemptions',
    'report.sales_history',
    'report.property_characteristics',
    'report.land_details',
    'report.appraisal_values'
  ));

ALTER TABLE app.custom_appraisal_section_history
  DROP CONSTRAINT IF EXISTS custom_appraisal_section_history_section_key_check;

ALTER TABLE app.custom_appraisal_section_history
  ADD CONSTRAINT custom_appraisal_section_history_section_key_check
  CHECK (section_key IN (
    'report.subject_identification',
    'report.exemptions',
    'report.sales_history',
    'report.property_characteristics',
    'report.land_details',
    'report.appraisal_values'
  ));

ALTER TABLE app.custom_appraisal_section_history
  ALTER COLUMN inspection_session_id DROP NOT NULL;

COMMENT ON COLUMN app.custom_appraisal_section_history.inspection_session_id IS
  'Mobile inspection session that produced the revision; null for authenticated desktop edits.';
