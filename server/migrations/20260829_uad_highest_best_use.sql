-- URAR Section 16: Highest and Best Use.
-- This migration is additive. It adds the appraiser-controlled four-test
-- analysis, present-use conclusion, conditional commentary, optional exhibits,
-- and the Summary redisplay without altering any existing appraisal data.

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"3100.0004","rfid":"16.000","context":"highest_best_use","name":"LegallyPermissibleIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null},
    {"uid":"3100.0006","rfid":"16.001","context":"highest_best_use","name":"PhysicallyPossibleIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null},
    {"uid":"3100.0003","rfid":"16.002","context":"highest_best_use","name":"FinanciallyFeasibleIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null},
    {"uid":"3100.0005","rfid":"16.003","context":"highest_best_use","name":"MaximallyProductiveIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null},
    {"uid":"3100.0007","rfid":"16.004","context":"highest_best_use","name":"SiteHighestBestUseIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null},
    {"uid":"3100.0010","rfid":"16.005","context":"highest_best_use_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000},
    {"uid":"1400.0638","rfid":"16.006.1","context":"highest_best_use_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:unbounded","options":["HighestAndBestUseExhibit"],"maxLength":null},
    {"uid":"1400.0640","rfid":"16.006.2","context":"highest_best_use_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 16, 'Highest and Best Use',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 13,
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
  regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
  option.ordinality,
  '{"phase":13,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 16
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(
  uid, property_context, report_field_id, section_number,
  section_name, location_role, metadata
) AS (
  VALUES
    ('3100.0004','highest_best_use','16.000',16,'Highest and Best Use','primary','{"label":"Legally Permissible"}'::jsonb),
    ('3100.0006','highest_best_use','16.001',16,'Highest and Best Use','primary','{"label":"Physically Possible"}'::jsonb),
    ('3100.0003','highest_best_use','16.002',16,'Highest and Best Use','primary','{"label":"Financially Feasible"}'::jsonb),
    ('3100.0005','highest_best_use','16.003',16,'Highest and Best Use','primary','{"label":"Maximally Productive"}'::jsonb),
    ('3100.0007','highest_best_use','16.004',16,'Highest and Best Use','primary','{"label":"Present Use Is Highest and Best Use"}'::jsonb),
    ('3100.0010','highest_best_use_commentary','16.005',16,'Highest and Best Use','primary','{"label":"Highest and Best Use Commentary"}'::jsonb),
    ('1400.0638','highest_best_use_asset','16.006.1',16,'Highest and Best Use','primary','{"label":"Highest and Best Use Exhibit"}'::jsonb),
    ('1400.0640','highest_best_use_asset','16.006.2',16,'Highest and Best Use','primary','{"label":"Exhibit Caption"}'::jsonb),
    ('3100.0007','highest_best_use','1.024',1,'Summary','redisplay','{"label":"Highest and Best Use Is Present Use","source_report_field_id":"16.004"}'::jsonb)
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  section_number, section_name, location_role,
  metadata || '{"phase":13,"source":"Appendix C-1 v1.3 and Appendix F-1 v1.4"}'::jsonb
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
  ('uad-3.6-2026-08-13-h1.5','UAD1659','fatal','highest_best_use','Indicate whether the highest and best use of the property is financially feasible.','FinanciallyFeasibleIndicator is required.',ARRAY['16.002'],'{"phase":13,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1660','fatal','highest_best_use','Indicate whether the highest and best use of the property is legally permissible.','LegallyPermissibleIndicator is required.',ARRAY['16.000'],'{"phase":13,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1661','fatal','highest_best_use','Indicate whether the highest and best use of the property is maximally productive.','MaximallyProductiveIndicator is required.',ARRAY['16.003'],'{"phase":13,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1662','fatal','highest_best_use','Indicate whether the highest and best use of the property is physically possible.','PhysicallyPossibleIndicator is required.',ARRAY['16.001'],'{"phase":13,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1663','fatal','highest_best_use','Indicate whether the present or proposed use is the highest and best.','SiteHighestBestUseIndicator is required.',ARRAY['16.004'],'{"phase":13,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-HIGHEST-BEST-USE-001','fatal','highest_best_use_commentary','Explain the evidence and support whenever a Highest and Best Use answer is No.','ValuationCommentText is required when any Section 16 answer is false.',ARRAY['16.000','16.001','16.002','16.003','16.004','16.005'],'{"phase":13,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_conditional"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-HIGHEST-BEST-USE-002','fatal','highest_best_use','The present or proposed use cannot be highest and best when it fails one of the four tests.','SiteHighestBestUseIndicator cannot be true when any four-test indicator is false.',ARRAY['16.000','16.001','16.002','16.003','16.004'],'{"phase":13,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
