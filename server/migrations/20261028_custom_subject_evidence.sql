-- Server-owned receipts accompany reviewed Subject application. This adds a
-- storage key only; report-manual-values must not accept this key from clients.
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
    'report.appraisal_values',
    'report.subject_evidence'
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
    'report.appraisal_values',
    'report.subject_evidence'
  ));
