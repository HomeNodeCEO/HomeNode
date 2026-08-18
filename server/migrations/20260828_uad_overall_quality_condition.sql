-- URAR Section 15: Overall Quality and Condition.
-- This migration is additive. It stores the three editable values once and
-- models Section 8/10 report redisplays separately so ratings cannot drift.

CREATE TABLE IF NOT EXISTS uad_ref.field_report_locations (
  release_key text NOT NULL,
  uid text NOT NULL,
  property_context text NOT NULL,
  report_field_id text NOT NULL,
  section_number integer NOT NULL,
  section_name text NOT NULL,
  location_role text NOT NULL DEFAULT 'primary',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (release_key, uid, property_context, report_field_id),
  FOREIGN KEY (release_key, uid, property_context)
    REFERENCES uad_ref.fields(release_key, uid, property_context)
    ON DELETE CASCADE,
  CHECK (location_role IN ('primary', 'redisplay'))
);

CREATE INDEX IF NOT EXISTS uad_field_report_locations_report_idx
  ON uad_ref.field_report_locations (release_key, report_field_id);

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1600.0007","rfid":"15.000","context":"subject","name":"OverallQualityRatingCode","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Q1","Q2","Q3","Q4","Q5","Q6"],"maxLength":null},
    {"uid":"1600.0006","rfid":"15.005","context":"subject","name":"OverallConditionRatingCode","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["C1","C2","C3","C4","C5","C6"],"maxLength":null},
    {"uid":"1600.0008","rfid":"15.010","context":"overall_quality_condition_commentary","name":"ValuationCommentText","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":5000}
  ]
  $catalog$::jsonb) AS row(
    uid text,
    rfid text,
    context text,
    name text,
    type text,
    requirement text,
    cardinality text,
    options jsonb,
    "maxLength" integer
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 15, 'Overall Quality and Condition',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 12,
    'options', options,
    'max_length', "maxLength",
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
SELECT
  field.release_key,
  field.uid,
  field.property_context,
  option.value,
  option.value,
  option.ordinality,
  '{"phase":12,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 15
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, location_role, metadata) AS (
  VALUES
    ('1600.0007','subject','15.000','primary','{"label":"Overall Quality"}'::jsonb),
    ('1600.0006','subject','15.005','primary','{"label":"Overall Condition"}'::jsonb),
    ('1600.0008','overall_quality_condition_commentary','15.010','primary','{"label":"Reconciliation of Overall Quality and Condition"}'::jsonb),
    ('0300.0101','dwelling','15.001','redisplay','{"label":"Structure Identifier","source_report_field_id":"8.000"}'::jsonb),
    ('1600.0005','dwelling','15.002','redisplay','{"label":"Exterior Quality","source_report_field_id":"8.022"}'::jsonb),
    ('0700.0114','unit','15.003','redisplay','{"label":"Unit Identifier","source_report_field_id":"10.002","exclude_accessory_dwelling_units":true}'::jsonb),
    ('0700.0067','unit','15.004','redisplay','{"label":"Interior Quality","source_report_field_id":"10.034","exclude_accessory_dwelling_units":true}'::jsonb),
    ('0300.0101','dwelling','15.006','redisplay','{"label":"Structure Identifier","source_report_field_id":"8.000"}'::jsonb),
    ('1600.0004','dwelling','15.007','redisplay','{"label":"Exterior Condition","source_report_field_id":"8.023"}'::jsonb),
    ('0700.0114','unit','15.008','redisplay','{"label":"Unit Identifier","source_report_field_id":"10.002","exclude_accessory_dwelling_units":true}'::jsonb),
    ('0700.0066','unit','15.009','redisplay','{"label":"Interior Condition","source_report_field_id":"10.035","exclude_accessory_dwelling_units":true}'::jsonb)
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  15, 'Overall Quality and Condition', location_role,
  metadata || '{"phase":12,"source":"Appendix C-1 v1.3 and Appendix F-1 v1.4"}'::jsonb
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1384','fatal','subject','Provide Overall Condition.','OverallConditionRatingCode is required.',ARRAY['15.005'],'{"phase":12,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1385','fatal','subject','Provide Overall Quality.','OverallQualityRatingCode is required.',ARRAY['15.000'],'{"phase":12,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1387','warning','overall_quality_condition_commentary','Provide Reconciliation of Overall Quality and Condition.','ValuationCommentText is required for OverallQualityAndCondition commentary.',ARRAY['15.010'],'{"phase":12,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OVERALL-QC-001','fatal','subject','Complete the exterior-maintenance responsibility before reconciling overall quality and condition.','HomeownerResponsibleForExteriorMaintenanceIndicator determines whether exterior ratings redisplay.',ARRAY['3.016','15.002','15.007'],'{"phase":12,"source":"Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OVERALL-QC-002','fatal','dwelling','Complete exterior quality and condition for every applicable dwelling.','When the homeowner maintains the exterior, each dwelling supplies Section 8 ratings to Section 15.',ARRAY['8.022','8.023','15.002','15.007'],'{"phase":12,"source":"Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OVERALL-QC-003','fatal','unit','Complete interior quality and condition for every non-ADU living unit.','Each unit must identify ADU status; non-ADU units supply Section 10 ratings to Section 15.',ARRAY['10.011','10.034','10.035','15.004','15.009'],'{"phase":12,"source":"Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
