-- URAR Section 22K: Overall Quality and Condition.
-- Additive UAD-only migration. Subject Q/C ratings remain canonical Section
-- 15 values; each comparable stores its overall ratings and two aggregated,
-- typed adjustments on the existing sales-comparable record.

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0197","rfid":"22.11.03","context":"sales_comparable_property","name":"OverallQualityRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Q1","Q2","Q3","Q4","Q5","Q6"],"format":null},
    {"uid":"1800.0196","rfid":"22.11.05","context":"sales_comparable_property","name":"OverallConditionRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["C1","C2","C3","C4","C5","C6"],"format":null},
    {"uid":"1800.0317","rfid":"22.11.04","context":"sales_comparable_adjustment_overall_quality","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_overall_quality","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OverallQualityRating"],"format":null},
    {"uid":"1800.0317","rfid":"22.11.06","context":"sales_comparable_adjustment_overall_condition","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_overall_condition","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OverallConditionRating"],"format":null}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22K-overall-quality-condition',
         'options', options, 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4',
         'implementation', CASE
           WHEN name = 'ComparableAdjustmentType' THEN 'derived_from_typed_context'
           ELSE NULL
         END
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
       '{"phase":22,"subphase":"22K-overall-quality-condition","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' = '22K-overall-quality-condition'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, location_role, label) AS (
  VALUES
    ('1600.0007','subject','22.11.01','redisplay','Subject Overall Quality Rating'),
    ('1600.0006','subject','22.11.02','redisplay','Subject Overall Condition Rating'),
    ('1800.0197','sales_comparable_property','22.11.03','primary','Comparable Overall Quality Rating'),
    ('1800.0317','sales_comparable_adjustment_overall_quality','22.11.04','primary','Comparable Overall Quality Adjustment'),
    ('1800.0196','sales_comparable_property','22.11.05','primary','Comparable Overall Condition Rating'),
    ('1800.0317','sales_comparable_adjustment_overall_condition','22.11.06','primary','Comparable Overall Condition Adjustment')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22K-overall-quality-condition',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4',
         'adjustment_scope', CASE
           WHEN property_context LIKE 'sales_comparable_adjustment_%'
             THEN 'aggregate_exterior_primary_unit_and_adu'
           ELSE NULL
         END
       )
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
  ('uad-3.6-2026-08-13-h1.5','UAD1434','fatal','sales_comparable_property','Provide the overall condition rating for the sales comparable.','OverallConditionRatingCode is required for every sales comparable.',ARRAY['22.11.05'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1435','fatal','sales_comparable_property','Provide the overall quality rating for the sales comparable.','OverallQualityRatingCode is required for every sales comparable.',ARRAY['22.11.03'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OVERALL-QC-001','fatal','subject','Complete the subject overall quality and condition conclusions.','Section 15 OverallQualityRatingCode and OverallConditionRatingCode are required before Section 22 can be completed.',ARRAY['22.11.01','22.11.02'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OVERALL-QC-002','fatal','sales_comparable_property','Complete each comparable overall quality and condition conclusion.','Every sales comparable requires one Q1-Q6 rating and one C1-C6 rating.',ARRAY['22.11.03','22.11.05'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OVERALL-QC-003','fatal','sales_comparable_adjustment_overall_quality','Keep quality and condition adjustments aggregated and typed.','OverallQualityRating and OverallConditionRating adjustments are stored once per comparable and include all exterior, primary-unit, and ADU analysis.',ARRAY['22.11.04','22.11.06'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"typed_context"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
