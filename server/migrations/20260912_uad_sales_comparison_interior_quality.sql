-- URAR Section 22I: Interior Quality and Condition.
-- Additive UAD-only migration. Canonical subject unit facts remain in
-- Section 10; Section 22 stores only comparison-specific summaries and
-- comparable unit child records required for MISMO delivery.

ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used', 'site_parcel',
    'site_influence', 'site_body_of_water', 'site_waterfront_feature',
    'site_view', 'site_encumbrance', 'site_feature',
    'site_utility', 'site_defect', 'renewable_energy_component',
    'green_building_certification', 'green_efficiency_rating',
    'dwelling_exterior_feature', 'dwelling_noncontinuous_room',
    'dwelling_exterior_defect', 'manufactured_home_skirting_material',
    'manufactured_home_modification', 'manufactured_home_hud_label',
    'manufactured_home_financing_program', 'unit_area_data_source',
    'unit_adu_data_source', 'unit_level', 'unit_room', 'unit_interior_feature',
    'unit_interior_defect', 'outbuilding_room', 'outbuilding_defect',
    'vehicle_storage_defect', 'amenity_defect', 'market_price_trend_source',
    'project_data_source', 'project_utility', 'project_amenity',
    'project_incomplete_component', 'project_blanket_financing',
    'subject_listing_data_source', 'subject_listing', 'subject_prior_transfer',
    'subject_no_prior_transfer_data_source', 'subject_prior_transfer_data_source',
    'comparable_prior_transfer', 'comparable_no_prior_transfer_data_source',
    'comparable_prior_transfer_data_source', 'sales_comparable_data_source',
    'sales_comparable_right_not_included', 'sales_comparable_project_amenity',
    'sales_comparable_site_hazard', 'sales_comparable_site_street',
    'sales_comparable_site_restriction', 'sales_comparable_site_easement',
    'sales_comparable_site_feature', 'sales_comparable_site_influence',
    'sales_comparable_body_of_water', 'sales_comparable_waterfront_feature',
    'sales_comparable_site_environmental', 'sales_comparable_site_view',
    'sales_comparable_dwelling', 'sales_comparable_construction_method',
    'sales_comparable_heating_system', 'sales_comparable_cooling_system',
    'sales_comparable_functional_issue', 'sales_comparable_disaster_mitigation',
    'sales_comparable_renewable_energy_component',
    'sales_comparable_green_certification', 'sales_comparable_efficiency_rating',
    'sales_comparable_outbuilding', 'sales_comparable_unit',
    'sales_comparable_unit_accessibility_feature',
    'sales_comparable_exterior_component',
    'sales_comparison_subject_exterior_quality_summary',
    'sales_comparable_kitchen', 'sales_comparable_interior_component',
    'sales_comparison_subject_unit_interior_summary',
    'sales_comparison_subject_kitchen_summary',
    'sales_comparison_subject_interior_quality_summary',
    'sales_comparison_subject_interior_condition_summary'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0158","rfid":"22.09.19","context":"sales_comparable_unit","name":"InteriorQualityRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Q1","Q2","Q3","Q4","Q5","Q6"],"maxLength":null,"format":null},
    {"uid":"1800.0157","rfid":"22.09.25","context":"sales_comparable_unit","name":"InteriorConditionRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["C1","C2","C3","C4","C5","C6"],"maxLength":null,"format":null},
    {"uid":"1800.0329","rfid":"22.09.21","context":"sales_comparable_unit","name":"OverallBathroomsQualityDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0328","rfid":"22.09.27","context":"sales_comparable_unit","name":"OverallBathroomsUpdateStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["FullyUpdated","ModeratelyUpdated","NotUpdated","SignificantlyUpdated"],"maxLength":null,"format":null},
    {"uid":"1800.0325","rfid":"Does Not Display","context":"sales_comparable_kitchen","name":"RoomType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Kitchen"],"maxLength":null,"format":null},
    {"uid":"1800.0327","rfid":"22.09.20","context":"sales_comparable_kitchen","name":"RoomQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0326","rfid":"22.09.26","context":"sales_comparable_kitchen","name":"RoomUpdateStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["FullyUpdated","NotUpdated","PartiallyUpdated"],"maxLength":null,"format":null},
    {"uid":"1800.0147","rfid":"Does Not Display","context":"sales_comparable_interior_component","name":"ImprovementComponentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Flooring","Other","WallsAndCeiling"],"maxLength":null,"format":null},
    {"uid":"1800.0148","rfid":"22.09.08","context":"sales_comparable_interior_component","name":"ImprovementComponentTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":36,"format":"36"},
    {"uid":"1800.0146","rfid":"22.09.22","context":"sales_comparable_interior_component","name":"ImprovementComponentQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0296","rfid":"22.09.29","context":"sales_comparable_interior_component","name":"ImprovementComponentConditionSummaryDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0336","rfid":"22.09.28","context":"sales_comparable_interior_component","name":"OverallFlooringUpdateStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["FullyUpdated","ModeratelyUpdated","NotUpdated","SignificantlyUpdated"],"maxLength":null,"format":null},
    {"uid":"1800.0294","rfid":"22.09.05","context":"sales_comparison_subject_unit_interior_summary","name":"OverallBathroomsQualityDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0323","rfid":"22.09.04","context":"sales_comparison_subject_kitchen_summary","name":"RoomQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0293","rfid":"22.09.06","context":"sales_comparison_subject_interior_quality_summary","name":"ImprovementComponentQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0292","rfid":"22.09.14","context":"sales_comparison_subject_interior_condition_summary","name":"ImprovementComponentConditionSummaryDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":70,"format":"70"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22I-interior-quality-condition',
         'options', options, 'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4',
         'xml_parent_entity_type', CASE
           WHEN context = 'sales_comparable_kitchen' THEN 'sales_comparable_unit'
           WHEN context = 'sales_comparable_interior_component' THEN 'sales_comparable_unit'
           WHEN context = 'sales_comparison_subject_unit_interior_summary' THEN 'unit'
           WHEN context = 'sales_comparison_subject_kitchen_summary' THEN 'unit_room'
           WHEN context IN ('sales_comparison_subject_interior_quality_summary', 'sales_comparison_subject_interior_condition_summary') THEN 'unit_interior_feature'
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
       '{"phase":22,"subphase":"22I-interior-quality-condition","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' = '22I-interior-quality-condition'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Existing subject Section 10 facts and comparable Section 22G identifiers
-- redisplay in Section 22I without creating duplicate values.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0101','dwelling','22.09.02','Subject Structure Identifier'),
    ('0700.0114','unit','22.09.02','Subject Unit Identifier'),
    ('0700.0067','unit','22.09.03','Subject Interior Quality Rating'),
    ('0700.0047','unit_interior_feature','22.09.08','Subject Other Interior Feature Label (Quality)'),
    ('0700.0066','unit','22.09.10','Subject Interior Condition Rating'),
    ('0700.0036','unit_room','22.09.11','Subject Kitchen Update Status'),
    ('0700.0117','unit','22.09.12','Subject Overall Bathrooms Update Status'),
    ('0700.0122','unit','22.09.13','Subject Overall Flooring Update Status'),
    ('0700.0047','unit_interior_feature','22.09.15','Subject Other Interior Feature Label (Condition)'),
    ('0300.0065','sales_comparable_dwelling','22.09.18','Comparable Structure Identifier'),
    ('1800.0159','sales_comparable_unit','22.09.18','Comparable Unit Identifier')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22I-redisplay',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0323','sales_comparison_subject_kitchen_summary','22.09.04','Subject Kitchen Quality Summary'),
    ('1800.0294','sales_comparison_subject_unit_interior_summary','22.09.05','Subject Overall Bathrooms Quality Summary'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.09.06','Subject Overall Flooring Quality Summary'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.09.07','Subject Walls and Ceiling Quality Summary'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.09.09','Subject Other Interior Feature Quality Summary'),
    ('1800.0292','sales_comparison_subject_interior_condition_summary','22.09.14','Subject Walls and Ceiling Condition Summary'),
    ('1800.0292','sales_comparison_subject_interior_condition_summary','22.09.16','Subject Other Interior Feature Condition Summary'),
    ('1800.0158','sales_comparable_unit','22.09.19','Comparable Interior Quality Rating'),
    ('1800.0327','sales_comparable_kitchen','22.09.20','Comparable Kitchen Quality Summary'),
    ('1800.0329','sales_comparable_unit','22.09.21','Comparable Overall Bathrooms Quality Summary'),
    ('1800.0146','sales_comparable_interior_component','22.09.22','Comparable Overall Flooring Quality Summary'),
    ('1800.0146','sales_comparable_interior_component','22.09.23','Comparable Walls and Ceiling Quality Summary'),
    ('1800.0146','sales_comparable_interior_component','22.09.24','Comparable Other Interior Feature Quality Summary'),
    ('1800.0148','sales_comparable_interior_component','22.09.08','Other Interior Feature Label (Quality)'),
    ('1800.0157','sales_comparable_unit','22.09.25','Comparable Interior Condition Rating'),
    ('1800.0326','sales_comparable_kitchen','22.09.26','Comparable Kitchen Update Status'),
    ('1800.0328','sales_comparable_unit','22.09.27','Comparable Overall Bathrooms Update Status'),
    ('1800.0336','sales_comparable_interior_component','22.09.28','Comparable Overall Flooring Update Status'),
    ('1800.0296','sales_comparable_interior_component','22.09.29','Comparable Walls and Ceiling Condition Summary'),
    ('1800.0296','sales_comparable_interior_component','22.09.30','Comparable Other Interior Feature Condition Summary'),
    ('1800.0148','sales_comparable_interior_component','22.09.15','Other Interior Feature Label (Condition)')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22I-interior-quality-condition',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4',
         'implementation', CASE WHEN property_context LIKE 'sales_comparison_subject_%' THEN 'merged_into_canonical_section_10_parent_for_xml' ELSE 'canonical_comparable_child' END
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
  ('uad-3.6-2026-08-13-h1.5','UAD1419','fatal','sales_comparable_unit','Provide the interior condition rating.','InteriorConditionRatingCode is required for every applicable sales-comparable unit.',ARRAY['22.09.25'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1420','fatal','sales_comparable_unit','Provide the interior quality rating.','InteriorQualityRatingCode is required for every applicable sales-comparable unit.',ARRAY['22.09.19'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-001','fatal','sales_comparable_unit','Interior comparison records must retain their unit hierarchy.','Comparable kitchens and components belong to comparable units; subject summaries belong to exact Section 10 parents.',ARRAY['22.09.04','22.09.05','22.09.06','22.09.14','22.09.20','22.09.22'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-002','fatal','sales_comparable_unit','Interior Quality and Condition repeats only for non-ADU units.','Require Q/C ratings and the core comparison rows for non-ADU units; reserve ADU rows for Section 22J.',ARRAY['22.09.19','22.09.25'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-003','fatal','sales_comparable_unit','Every non-ADU comparable unit requires ratings and core interior rows.','Require Q/C ratings, a kitchen row, Flooring, and Walls and Ceiling exactly once.',ARRAY['22.09.19','22.09.20','22.09.22','22.09.23','22.09.25'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-004','fatal','sales_comparable_unit','Bathroom comparison details must agree with the unit bathroom count.','Require the bathrooms quality summary and update status when the comparable unit contains a bathroom.',ARRAY['22.09.21','22.09.27'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-005','fatal','sales_comparable_interior_component','Interior details must agree with their component type and subject row labels.','Enforce type-specific summaries and exact subject labels for Other rows.',ARRAY['22.09.08','22.09.15','22.09.22','22.09.23','22.09.24','22.09.28','22.09.29','22.09.30'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-INTERIOR-006','fatal','sales_comparison_subject_unit_interior_summary','Provide the subject comparison-only summaries for every applicable non-ADU unit.','Attach bathroom, kitchen, component quality, and component condition summaries to the canonical Section 10 parent records.',ARRAY['22.09.04','22.09.05','22.09.06','22.09.07','22.09.09','22.09.14','22.09.16'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
