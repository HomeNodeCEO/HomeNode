-- URAR Section 29: Certifications and Scope of Work.
-- Additive UAD-only migration. Existing Custom Appraisal, property-search, and
-- Property Tax Protest records are not changed. Credential snapshots remain
-- immutable per workfile revision so later profile changes cannot alter a
-- signed appraisal.

ALTER TABLE appraisal.uad_signatures
  ADD COLUMN IF NOT EXISTS execution_date date,
  ADD COLUMN IF NOT EXISTS workfile_input_digest_sha256 text,
  ADD COLUMN IF NOT EXISTS credential_snapshot_sha256 text,
  ADD COLUMN IF NOT EXISTS attestation jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE appraisal.uad_signatures
  DROP CONSTRAINT IF EXISTS uad_signatures_input_digest_check,
  DROP CONSTRAINT IF EXISTS uad_signatures_credential_digest_check;

ALTER TABLE appraisal.uad_signatures
  ADD CONSTRAINT uad_signatures_input_digest_check
    CHECK (workfile_input_digest_sha256 IS NULL OR workfile_input_digest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT uad_signatures_credential_digest_check
    CHECK (credential_snapshot_sha256 IS NULL OR credential_snapshot_sha256 ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS uad_signatures_workfile_revision_idx
  ON appraisal.uad_signatures (workfile_id, revision_number, signer_role);

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1000.0028","rfid":"Does Not Display","context":"certification_scope","name":"GovernmentAgencyAppraisalIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"2200.0037","rfid":"Does Not Display","context":"certification_intended_user","name":"ValuationAdditionalIntendedUserIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"2200.0062","rfid":"Does Not Display","context":"certification_scope","name":"ValuationAdditionalScopeOfWorkIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"2200.0003","rfid":"29.003","context":"certification_scope","name":"ValuationScopeOfWorkDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2500,"format":"2500"},
    {"uid":"2200.0005","rfid":"29.007","context":"certification_intended_use","name":"ValuationIntendedUseDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2500,"format":"2500"},
    {"uid":"2200.0087","rfid":"29.053","context":"certification_appraiser","name":"ValuationAdditionalCertificationText","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":360,"format":"360"},
    {"uid":"2200.0013","rfid":"29.062","context":"certification_supervisor","name":"ValuationAdditionalCertificationText","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":360,"format":"360"},
    {"uid":"2200.0004","rfid":"29.011","context":"certification_intended_user","name":"ValuationAdditionalIntendedUserDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":180,"format":"180"},
    {"uid":"2200.0034","rfid":"Does Not Display","context":"certification_report","name":"AppraiserAdditionalCertificationIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"2200.0016","rfid":"29.051","context":"certification_report","name":"AppraiserPriorServicesPerformedDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":1250,"format":"1250"},
    {"uid":"2200.0017","rfid":"29.050","context":"certification_report","name":"AppraiserPriorServicesPerformedIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"2200.0035","rfid":"Does Not Display","context":"certification_supervisor","name":"AppraiserSupervisorAdditionalCertificationIndicator","type":"Boolean","requirement":"Conditional Required","cardinality":"0:1","options":["true"],"maxLength":null,"format":null},
    {"uid":"2200.0038","rfid":"29.030","context":"certification_report","name":"ValuationReportInspectionCertificationType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Exterior","InteriorAndExterior","NoPhysicalInspection"],"maxLength":null,"format":null},
    {"uid":"2200.0001","rfid":"Does Not Display","context":"appraiser_signature","name":"SignatoryLabel","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["SIGNATORY_n"],"maxLength":null,"format":null},
    {"uid":"2400.0056","rfid":"29.063","context":"appraiser_signature","name":"PartyRoleType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Appraiser"],"maxLength":null,"format":null},
    {"uid":"1400.0342","rfid":"Does Not Display","context":"appraiser_signature_relationship","name":"SignatoryRoleArcrole","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/SIGNATORY_IsAssociatedWith_ROLE"],"maxLength":null,"format":null},
    {"uid":"1400.0343","rfid":"Does Not Display","context":"appraiser_signature_relationship","name":"SignatoryRoleFrom","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["SIGNATORY_n"],"maxLength":null,"format":null},
    {"uid":"1400.0344","rfid":"Does Not Display","context":"appraiser_signature_relationship","name":"SignatoryRoleTo","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["ROLE_n"],"maxLength":null,"format":null},
    {"uid":"2200.0153","rfid":"Does Not Display","context":"supervisory_appraiser_signature","name":"SignatoryLabel","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["SIGNATORY_n"],"maxLength":null,"format":null},
    {"uid":"2200.0085","rfid":"29.063","context":"supervisory_appraiser_signature","name":"PartyRoleType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:1","options":["AppraiserSupervisor"],"maxLength":null,"format":null},
    {"uid":"2200.0092","rfid":"Does Not Display","context":"supervisory_appraiser_signature_relationship","name":"SignatoryRoleArcrole","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/SIGNATORY_IsAssociatedWith_ROLE"],"maxLength":null,"format":null},
    {"uid":"2200.0093","rfid":"Does Not Display","context":"supervisory_appraiser_signature_relationship","name":"SignatoryRoleFrom","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["SIGNATORY_n"],"maxLength":null,"format":null},
    {"uid":"2200.0094","rfid":"Does Not Display","context":"supervisory_appraiser_signature_relationship","name":"SignatoryRoleTo","type":"Attribute","requirement":"Conditional Required","cardinality":"0:1","options":["ROLE_n"],"maxLength":null,"format":null},
    {"uid":"2200.0002","rfid":"29.066","context":"appraiser_signature","name":"ExecutionDate","type":"Date","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"2200.0154","rfid":"29.066","context":"supervisory_appraiser_signature","name":"ExecutionDate","type":"Date","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 29, 'Certifications and Scope of Work',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 29, 'options', options, 'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
    cardinality = EXCLUDED.cardinality,
    metadata = EXCLUDED.metadata;

-- The signer identity and credential values are maintained in app_auth rather
-- than edited in the workfile. Catalog them under their primary Assignment
-- Information context because the signed PARTY structures and Section 29
-- redisplays are generated from the immutable credential snapshot.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"2400.0041","context":"appraiser_party","name":"FirstName","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2400.0042","context":"appraiser_party","name":"LastName","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2400.0043","context":"appraiser_party","name":"MiddleName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":30,"format":"30"},
    {"uid":"2400.0044","context":"appraiser_party","name":"SuffixName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":4,"format":"4"},
    {"uid":"2400.0033","context":"appraiser_party","name":"AddressLineText","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2400.0034","context":"appraiser_party","name":"CityName","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":50,"format":"50"},
    {"uid":"2400.0035","context":"appraiser_party","name":"PostalCode","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":10,"format":"10"},
    {"uid":"2400.0036","context":"appraiser_party","name":"StateCode","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":2,"format":"2"},
    {"uid":"2400.0047","context":"appraiser_party","name":"AppraiserCompanyName","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2400.0051","context":"appraiser_party","name":"AppraiserLicenseType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["CertifiedGeneral","CertifiedResidential","LicensedResidentialAppraiser","None","Other","TraineeAppraiser"],"maxLength":null,"format":null},
    {"uid":"2400.0052","context":"appraiser_party","name":"AppraiserLicenseTypeOtherDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"2400.0053","context":"appraiser_party","name":"LicenseExpirationDate","type":"Date","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"2400.0054","context":"appraiser_party","name":"LicenseIdentifier","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"2400.0055","context":"appraiser_party","name":"LicenseIssuingAuthorityStateCode","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2,"format":"2"},
    {"uid":"2200.0075","context":"supervisory_appraiser_party","name":"FirstName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2200.0076","context":"supervisory_appraiser_party","name":"LastName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2200.0077","context":"supervisory_appraiser_party","name":"MiddleName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":30,"format":"30"},
    {"uid":"2200.0078","context":"supervisory_appraiser_party","name":"SuffixName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":4,"format":"4"},
    {"uid":"2400.0423","context":"supervisory_appraiser_party","name":"AddressLineText","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2400.0424","context":"supervisory_appraiser_party","name":"CityName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":50,"format":"50"},
    {"uid":"2400.0425","context":"supervisory_appraiser_party","name":"PostalCode","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":10,"format":"10"},
    {"uid":"2400.0426","context":"supervisory_appraiser_party","name":"StateCode","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2,"format":"2"},
    {"uid":"2400.0428","context":"supervisory_appraiser_party","name":"AppraiserCompanyName","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"2200.0080","context":"supervisory_appraiser_party","name":"AppraiserLicenseType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:1","options":["CertifiedGeneral","CertifiedResidential","LicensedResidentialAppraiser","Other"],"maxLength":null,"format":null},
    {"uid":"2200.0081","context":"supervisory_appraiser_party","name":"AppraiserLicenseTypeOtherDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"2200.0082","context":"supervisory_appraiser_party","name":"LicenseExpirationDate","type":"Date","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"2200.0083","context":"supervisory_appraiser_party","name":"LicenseIdentifier","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"2200.0084","context":"supervisory_appraiser_party","name":"LicenseIssuingAuthorityStateCode","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2,"format":"2"}
  ] $catalog$::jsonb) AS row(
    uid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, 'System Profile', 2, 'Assignment Information',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 29, 'options', options, 'max_length', "maxLength", 'format', format,
         'system_owned', true, 'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
    cardinality = EXCLUDED.cardinality,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT field.release_key, field.uid, field.property_context, option.value,
       regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
       option.ordinality,
       '{"phase":29,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND (field.section_number = 29 OR field.property_context IN ('appraiser_party', 'supervisory_appraiser_party'))
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1000.0028','certification_scope','Does Not Display','Federal Agency Appraisal Indicator'),
    ('2200.0037','certification_intended_user','Does Not Display','Additional Intended User Indicator'),
    ('2200.0062','certification_scope','Does Not Display','Additional Scope of Work Indicator'),
    ('2200.0003','certification_scope','29.003','Additional Scope of Work'),
    ('2200.0005','certification_intended_use','29.007','Additional Intended Use'),
    ('2200.0004','certification_intended_user','29.011','Additional Intended User'),
    ('2200.0038','certification_report','29.030','Inspection Certification'),
    ('2200.0017','certification_report','29.050','Prior Services Indicator'),
    ('2200.0016','certification_report','29.051','Description of Prior Services'),
    ('2200.0034','certification_report','Does Not Display','Additional Appraiser Certification Indicator'),
    ('2200.0087','certification_appraiser','29.053','Additional Appraiser Certification'),
    ('2200.0035','certification_supervisor','Does Not Display','Additional Supervisory Certification Indicator'),
    ('2200.0013','certification_supervisor','29.062','Additional Supervisory Appraiser Certification'),
    ('2200.0001','appraiser_signature','Does Not Display','Appraiser Signatory Label'),
    ('2400.0056','appraiser_signature','29.063','Appraiser Signature Role'),
    ('1400.0342','appraiser_signature_relationship','Does Not Display','Appraiser Signatory Relationship Arcrole'),
    ('1400.0343','appraiser_signature_relationship','Does Not Display','Appraiser Signatory Relationship From'),
    ('1400.0344','appraiser_signature_relationship','Does Not Display','Appraiser Signatory Relationship To'),
    ('2200.0153','supervisory_appraiser_signature','Does Not Display','Supervisory Appraiser Signatory Label'),
    ('2200.0085','supervisory_appraiser_signature','29.063','Supervisory Appraiser Signature Role'),
    ('2200.0092','supervisory_appraiser_signature_relationship','Does Not Display','Supervisory Signatory Relationship Arcrole'),
    ('2200.0093','supervisory_appraiser_signature_relationship','Does Not Display','Supervisory Signatory Relationship From'),
    ('2200.0094','supervisory_appraiser_signature_relationship','Does Not Display','Supervisory Signatory Relationship To'),
    ('2200.0002','appraiser_signature','29.066','Appraiser Signature Date'),
    ('2200.0154','supervisory_appraiser_signature','29.066','Supervisory Appraiser Signature Date')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       29, 'Certifications and Scope of Work', 'primary',
       jsonb_build_object('label', label, 'phase', 29,
         'source', 'Appendix A-1 v1.4 and Appendix F-1 URAR Reference Guide v1.4')
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, section_number, location_role, label) AS (
  VALUES
    ('2400.0041','appraiser_party','2.017',2,'primary','Appraiser First Name'),
    ('2400.0041','appraiser_party','1.011',1,'redisplay','Appraiser First Name'),
    ('2400.0041','appraiser_party','29.065',29,'redisplay','Appraiser First Name'),
    ('2400.0042','appraiser_party','2.017',2,'primary','Appraiser Last Name'),
    ('2400.0042','appraiser_party','1.011',1,'redisplay','Appraiser Last Name'),
    ('2400.0042','appraiser_party','29.065',29,'redisplay','Appraiser Last Name'),
    ('2400.0043','appraiser_party','2.017',2,'primary','Appraiser Middle Name'),
    ('2400.0043','appraiser_party','1.011',1,'redisplay','Appraiser Middle Name'),
    ('2400.0043','appraiser_party','29.065',29,'redisplay','Appraiser Middle Name'),
    ('2400.0044','appraiser_party','2.017',2,'primary','Appraiser Name Suffix'),
    ('2400.0044','appraiser_party','1.011',1,'redisplay','Appraiser Name Suffix'),
    ('2400.0044','appraiser_party','29.065',29,'redisplay','Appraiser Name Suffix'),
    ('2400.0033','appraiser_party','2.020',2,'primary','Appraiser Company Address'),
    ('2400.0034','appraiser_party','2.020',2,'primary','Appraiser Company City'),
    ('2400.0035','appraiser_party','2.020',2,'primary','Appraiser Company Postal Code'),
    ('2400.0036','appraiser_party','2.020',2,'primary','Appraiser Company State'),
    ('2400.0047','appraiser_party','2.019',2,'primary','Appraiser Company Name'),
    ('2400.0051','appraiser_party','2.024',2,'primary','Appraiser License Level'),
    ('2400.0051','appraiser_party','29.067',29,'redisplay','Appraiser License Level'),
    ('2400.0052','appraiser_party','2.024',2,'primary','Other Appraiser License Level'),
    ('2400.0052','appraiser_party','29.067',29,'redisplay','Other Appraiser License Level'),
    ('2400.0053','appraiser_party','2.027',2,'primary','Appraiser License Expiration'),
    ('2400.0053','appraiser_party','29.070',29,'redisplay','Appraiser License Expiration'),
    ('2400.0054','appraiser_party','2.025',2,'primary','Appraiser License Identifier'),
    ('2400.0054','appraiser_party','29.068',29,'redisplay','Appraiser License Identifier'),
    ('2400.0055','appraiser_party','2.026',2,'primary','Appraiser License State'),
    ('2400.0055','appraiser_party','29.069',29,'redisplay','Appraiser License State'),
    ('2200.0075','supervisory_appraiser_party','2.032',2,'primary','Supervisory Appraiser First Name'),
    ('2200.0075','supervisory_appraiser_party','29.065',29,'redisplay','Supervisory Appraiser First Name'),
    ('2200.0076','supervisory_appraiser_party','2.032',2,'primary','Supervisory Appraiser Last Name'),
    ('2200.0076','supervisory_appraiser_party','29.065',29,'redisplay','Supervisory Appraiser Last Name'),
    ('2200.0077','supervisory_appraiser_party','2.032',2,'primary','Supervisory Appraiser Middle Name'),
    ('2200.0077','supervisory_appraiser_party','29.065',29,'redisplay','Supervisory Appraiser Middle Name'),
    ('2200.0078','supervisory_appraiser_party','2.032',2,'primary','Supervisory Appraiser Name Suffix'),
    ('2200.0078','supervisory_appraiser_party','29.065',29,'redisplay','Supervisory Appraiser Name Suffix'),
    ('2400.0423','supervisory_appraiser_party','2.035',2,'primary','Supervisory Appraiser Company Address'),
    ('2400.0424','supervisory_appraiser_party','2.035',2,'primary','Supervisory Appraiser Company City'),
    ('2400.0425','supervisory_appraiser_party','2.035',2,'primary','Supervisory Appraiser Company Postal Code'),
    ('2400.0426','supervisory_appraiser_party','2.035',2,'primary','Supervisory Appraiser Company State'),
    ('2400.0428','supervisory_appraiser_party','2.034',2,'primary','Supervisory Appraiser Company Name'),
    ('2200.0080','supervisory_appraiser_party','2.039',2,'primary','Supervisory Appraiser License Level'),
    ('2200.0080','supervisory_appraiser_party','29.067',29,'redisplay','Supervisory Appraiser License Level'),
    ('2200.0081','supervisory_appraiser_party','2.039',2,'primary','Other Supervisory Appraiser License Level'),
    ('2200.0081','supervisory_appraiser_party','29.067',29,'redisplay','Other Supervisory Appraiser License Level'),
    ('2200.0082','supervisory_appraiser_party','2.042',2,'primary','Supervisory Appraiser License Expiration'),
    ('2200.0082','supervisory_appraiser_party','29.070',29,'redisplay','Supervisory Appraiser License Expiration'),
    ('2200.0083','supervisory_appraiser_party','2.040',2,'primary','Supervisory Appraiser License Identifier'),
    ('2200.0083','supervisory_appraiser_party','29.068',29,'redisplay','Supervisory Appraiser License Identifier'),
    ('2200.0084','supervisory_appraiser_party','2.041',2,'primary','Supervisory Appraiser License State'),
    ('2200.0084','supervisory_appraiser_party','29.069',29,'redisplay','Supervisory Appraiser License State')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       section_number,
       CASE section_number WHEN 1 THEN 'Summary' WHEN 2 THEN 'Assignment Information'
                           ELSE 'Certifications and Scope of Work' END,
       location_role,
       jsonb_build_object('label', label, 'phase', 29, 'system_owned', true,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4')
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1505','warning','appraiser_signature','Appraiser signature date is after the submission date.','ExecutionDate > current submission date.',ARRAY['29.066'],'{"phase":29,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1506','warning','appraiser_signature','Appraiser signature date is more than 367 days before submission.','ExecutionDate < submission date - 367 days.',ARRAY['29.066'],'{"phase":29,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1507','fatal','appraiser_signature','A complete appraiser signature date is required.','ExecutionDate must contain year, month, and day.',ARRAY['29.066'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"authenticated_signing_service"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1508','fatal','certification_report','The prior-services indicator is required.','AppraiserPriorServicesPerformedIndicator must exist.',ARRAY['29.050'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"server_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1509','warning','certification_report','The additional appraiser certification indicator is required.','AppraiserAdditionalCertificationIndicator must exist.',ARRAY['29.053'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"server_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1510','warning','certification_intended_user','The additional intended-user indicator is required.','ValuationAdditionalIntendedUserIndicator must exist.',ARRAY['29.011'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"server_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1511','fatal','certification_report','The inspection certification is required.','ValuationReportInspectionCertificationType must exist.',ARRAY['29.030'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"server_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1512','warning','certification_report','Traditional appraisals should certify interior and exterior inspection.','TraditionalAppraisal => InteriorAndExterior.',ARRAY['2.004','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"local_warning"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1513','warning','certification_report','Exterior appraisals should certify exterior inspection.','ExteriorAppraisal => Exterior.',ARRAY['2.004','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"local_warning"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1514','warning','certification_report','Desktop appraisals should certify no physical inspection.','DesktopAppraisal => NoPhysicalInspection.',ARRAY['2.004','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"local_warning"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1515','warning','certification_report','Hybrid appraisals should certify no physical inspection.','HybridAppraisal => NoPhysicalInspection.',ARRAY['2.004','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"local_warning"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1516','warning','certification_report','Physical interior and exterior inspection methods should certify interior and exterior inspection.','ExteriorInspectionMethod=Physical AND InteriorInspectionMethod=Physical => InteriorAndExterior.',ARRAY['2.021','2.022','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1517','warning','certification_report','Virtual or no-inspection methods should certify no physical inspection.','Exterior and interior methods are Virtual or NoInspection => NoPhysicalInspection.',ARRAY['2.021','2.022','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1518','warning','certification_report','Physical exterior-only inspection should certify exterior inspection.','ExteriorInspectionMethod=Physical AND InteriorInspectionMethod in (Virtual,NoInspection) => Exterior.',ARRAY['2.021','2.022','29.030'],'{"phase":29,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1523','warning','certification_scope','The additional scope-of-work indicator is required.','ValuationAdditionalScopeOfWorkIndicator must exist.',ARRAY['29.003'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"server_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1535','fatal','appraiser_signature','Exactly one signature date is required for each appraiser and supervisory appraiser.','Each required signer has one ExecutionDate.',ARRAY['29.066'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"authenticated_signing_service"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1536','fatal','appraiser_signature','The signature date cannot precede the appraisal effective date.','ExecutionDate >= AppraisalReportEffectiveDate.',ARRAY['26.011','29.066'],'{"phase":29,"source":"Appendix H-1 v1.5","implementation":"authenticated_signing_service"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
