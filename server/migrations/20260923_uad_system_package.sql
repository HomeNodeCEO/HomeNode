-- System-owned UAD 3.6 document and package metadata.
-- These values are generated from the locked HomeNode software profile and
-- workfile revision; they are never editable appraisal facts. This migration
-- is additive and does not touch Custom Appraisal or Property Tax records.

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"2100.0045","name":"ValuationReportContentIdentifier","type":"String","requirement":"Required","format":"65","options":["URAR Delivery Specification v1.4"]},
    {"uid":"2100.0036","name":"ValuationSoftwareProductIdentifier","type":"String","requirement":"Required","format":"50","options":null},
    {"uid":"2100.0033","name":"ValuationSoftwareProductName","type":"String","requirement":"Required","format":"100","options":null},
    {"uid":"2100.0001","name":"ValuationSoftwareProductVersionIdentifier","type":"String","requirement":"Required","format":"50","options":null},
    {"uid":"2100.0002","name":"ValuationSoftwareVendorName","type":"String","requirement":"Required","format":"100","options":null},
    {"uid":"1000.0198","name":"ServiceType","type":"Enumerated","requirement":"Required","format":null,"options":["Valuation"]},
    {"uid":"1400.0383","name":"ObjectURL","type":"String","requirement":"Required","format":"150","options":null},
    {"uid":"1400.0384","name":"MIMETypeIdentifier","type":"String","requirement":"Required","format":"30","options":["application/pdf"]},
    {"uid":"2100.0010","name":"AboutVersionIdentifier","type":"Integer","requirement":"Required","format":"2","minimum":1,"maximum":99,"options":null},
    {"uid":"1000.0039","name":"DocumentType","type":"Enumerated","requirement":"Required","format":null,"options":["AppraisalReport"]},
    {"uid":"2100.0048","name":"DocumentFormIssuingEntityNameType","type":"Enumerated","requirement":"Required","format":null,"options":["FNM_FRE"]},
    {"uid":"2100.0049","name":"DocumentFormIssuingEntityVersionIdentifier","type":"String","requirement":"Required","format":"14","options":["September 2024"]}
  ] $catalog$::jsonb) AS row(
    uid text, name text, type text, requirement text, format text,
    minimum integer, maximum integer, options jsonb
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, 'System Generated', 0,
       'System and Package Metadata', 'system_package', name, type,
       requirement, '1:1',
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 30, 'format', format, 'minimum', minimum,
         'maximum', maximum, 'options', options,
         'system_owned', true,
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

INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT field.release_key, field.uid, field.property_context, option.value,
       option.value, option.ordinality,
       '{"phase":30,"system_owned":true,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.property_context = 'system_package'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, report_field_id, label) AS (
  VALUES
    ('2100.0045','Does Not Display','URAR Delivery Specification Identifier'),
    ('2100.0036','Does Not Display','Valuation Software Product Identifier'),
    ('2100.0033','Does Not Display','Valuation Software Product Name'),
    ('2100.0001','Does Not Display','Valuation Software Product Version'),
    ('2100.0002','Does Not Display','Valuation Software Vendor Name'),
    ('1000.0198','Does Not Display','Appraisal Report Service Type'),
    ('1400.0383','Does Not Display','Embedded Report PDF Object URL'),
    ('1400.0384','Does Not Display','Embedded Report PDF MIME Type'),
    ('2100.0010','HF.002','Appraisal Version Number'),
    ('1000.0039','HF.001','Appraisal Report Document Type'),
    ('2100.0048','HF.003','Document Form Issuing Entity'),
    ('2100.0049','HF.004','Document Form Version')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, 'system_package', report_field_id,
       0, 'System and Package Metadata', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 30, 'system_owned', true,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;
