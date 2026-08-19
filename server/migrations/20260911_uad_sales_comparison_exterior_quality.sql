-- URAR Section 22H: Exterior Quality and Condition.
-- Additive UAD-only migration. Canonical subject exterior facts remain in
-- Section 8; Section 22 stores only comparison-specific summaries and the
-- comparable dwelling/component facts required for MISMO delivery.

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
    'sales_comparison_subject_exterior_quality_summary'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0364","rfid":"Does Not Display","context":"sales_comparable_property","name":"HomeownerResponsibleForExteriorMaintenanceIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0186","rfid":"22.08.17","context":"sales_comparable_dwelling","name":"ExteriorQualityRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Q1","Q2","Q3","Q4","Q5","Q6"],"maxLength":null,"format":null},
    {"uid":"1800.0185","rfid":"22.08.23","context":"sales_comparable_dwelling","name":"ExteriorConditionRatingCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["C1","C2","C3","C4","C5","C6"],"maxLength":null,"format":null},
    {"uid":"1800.0180","rfid":"Does Not Display","context":"sales_comparable_exterior_component","name":"ImprovementComponentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["ExteriorWallsAndTrim","Foundation","Other","Roof","Windows"],"maxLength":null,"format":null},
    {"uid":"1800.0181","rfid":"22.08.07","context":"sales_comparable_exterior_component","name":"ImprovementComponentTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":36,"format":"36"},
    {"uid":"0300.0042","rfid":"22.08.18","context":"sales_comparable_exterior_component","name":"WallMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded","options":["Adobe","Aluminum","Asbestos","Brick","CementBoard","ConcreteBlock","EngineeredWood","Glass","Log","Other","PouredConcrete","Steel","Stone","Stucco","SyntheticStone","SyntheticStucco","Vinyl","Wood"],"maxLength":null,"format":null},
    {"uid":"0300.0043","rfid":"22.08.18","context":"sales_comparable_exterior_component","name":"WallMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":36,"format":"36"},
    {"uid":"1800.0173","rfid":"22.08.19","context":"sales_comparable_exterior_component","name":"FoundationType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded","options":["Basement","CrawlSpace","Other","PostAndPier","Runner","Slab"],"maxLength":null,"format":null},
    {"uid":"1800.0174","rfid":"22.08.19","context":"sales_comparable_exterior_component","name":"FoundationTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":36,"format":"36"},
    {"uid":"1800.0175","rfid":"22.08.20","context":"sales_comparable_exterior_component","name":"RoofMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded","options":["Asbestos","Asphalt","CeramicTile","Clay","Composition","Concrete","Copper","Metal","Other","Rubber","Slate","SolarShingles","Synthetic","TarAndGravel","Wood"],"maxLength":null,"format":null},
    {"uid":"1800.0176","rfid":"22.08.20","context":"sales_comparable_exterior_component","name":"RoofMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":36,"format":"36"},
    {"uid":"1800.0297","rfid":"22.08.21","context":"sales_comparable_exterior_component","name":"ImprovementComponentQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":70,"format":"70"},
    {"uid":"1800.0386","rfid":"22.08.26","context":"sales_comparable_exterior_component","name":"RoofObservableIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0179","rfid":"22.08.24","context":"sales_comparable_exterior_component","name":"ImprovementComponentConditionStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["DamagedAndFunctional","DamagedAndNonfunctional","NewOrLikeNew","TypicalWearAndTear"],"maxLength":null,"format":null},
    {"uid":"1800.0295","rfid":"22.08.06","context":"sales_comparison_subject_exterior_quality_summary","name":"ImprovementComponentQualitySummaryDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":70,"format":"70"}
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
         'phase', 22, 'subphase', '22H-exterior-quality-condition',
         'options', options, 'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4',
         'xml_parent_entity_type', CASE
           WHEN context = 'sales_comparison_subject_exterior_quality_summary'
             THEN 'dwelling_exterior_feature'
           WHEN context = 'sales_comparable_exterior_component'
             THEN 'sales_comparable_dwelling'
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
       '{"phase":22,"subphase":"22H-exterior-quality-condition","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' = '22H-exterior-quality-condition'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Canonical subject Section 8 facts redisplay in the subject column. The
-- Windows/Other quality summary is the only new subject input in Section 22H.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0101','dwelling','22.08.01','Subject Structure Identifier'),
    ('1600.0005','dwelling','22.08.02','Subject Exterior Quality Rating'),
    ('0300.0098','dwelling_exterior_feature','22.08.03','Subject Exterior Wall Material'),
    ('0300.0099','dwelling_exterior_feature','22.08.03','Subject Other Exterior Wall Material'),
    ('0300.0046','dwelling_exterior_feature','22.08.04','Subject Foundation Type'),
    ('0300.0047','dwelling_exterior_feature','22.08.04','Subject Other Foundation Type'),
    ('0300.0050','dwelling_exterior_feature','22.08.05','Subject Roof Material'),
    ('0300.0051','dwelling_exterior_feature','22.08.05','Subject Other Roof Material'),
    ('0300.0056','dwelling_exterior_feature','22.08.07','Subject Other Exterior Feature Label (Quality)'),
    ('0300.0056','dwelling_exterior_feature','22.08.14','Subject Other Exterior Feature Label (Condition)'),
    ('1600.0004','dwelling','22.08.09','Subject Exterior Condition Rating'),
    ('0300.0054','dwelling_exterior_feature','22.08.10','Subject Exterior Walls Condition'),
    ('0300.0054','dwelling_exterior_feature','22.08.11','Subject Foundation Condition'),
    ('0300.0054','dwelling_exterior_feature','22.08.12','Subject Roof Condition'),
    ('0300.0049','dwelling_exterior_feature','22.08.12','Subject Roof Observable'),
    ('0300.0054','dwelling_exterior_feature','22.08.13','Subject Windows Condition'),
    ('0300.0054','dwelling_exterior_feature','22.08.15','Subject Other Exterior Feature Condition')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22H-subject-redisplay',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(report_field_id, label) AS (
  VALUES
    ('22.08.06','Subject Windows Quality Summary'),
    ('22.08.08','Subject Other Exterior Feature Quality Summary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', '1800.0295',
       'sales_comparison_subject_exterior_quality_summary', report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22H-subject-input',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4',
         'implementation', 'merged_into_parent_dwelling_exterior_feature_for_xml'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0065','sales_comparable_dwelling','22.08.16','Comparable Structure Identifier'),
    ('1800.0186','sales_comparable_dwelling','22.08.17','Comparable Exterior Quality Rating'),
    ('0300.0042','sales_comparable_exterior_component','22.08.18','Comparable Exterior Wall Material'),
    ('0300.0043','sales_comparable_exterior_component','22.08.18','Comparable Other Exterior Wall Material'),
    ('1800.0173','sales_comparable_exterior_component','22.08.19','Comparable Foundation Type'),
    ('1800.0174','sales_comparable_exterior_component','22.08.19','Comparable Other Foundation Type'),
    ('1800.0175','sales_comparable_exterior_component','22.08.20','Comparable Roof Material'),
    ('1800.0176','sales_comparable_exterior_component','22.08.20','Comparable Other Roof Material'),
    ('1800.0297','sales_comparable_exterior_component','22.08.21','Comparable Windows Quality Summary'),
    ('1800.0297','sales_comparable_exterior_component','22.08.22','Comparable Other Exterior Feature Quality Summary'),
    ('1800.0181','sales_comparable_exterior_component','22.08.07','Other Exterior Feature Label (Quality)'),
    ('1800.0181','sales_comparable_exterior_component','22.08.14','Other Exterior Feature Label (Condition)'),
    ('1800.0185','sales_comparable_dwelling','22.08.23','Comparable Exterior Condition Rating'),
    ('1800.0179','sales_comparable_exterior_component','22.08.24','Comparable Exterior Walls Condition'),
    ('1800.0179','sales_comparable_exterior_component','22.08.25','Comparable Foundation Condition'),
    ('1800.0179','sales_comparable_exterior_component','22.08.26','Comparable Roof Condition'),
    ('1800.0386','sales_comparable_exterior_component','22.08.26','Comparable Roof Observable'),
    ('1800.0179','sales_comparable_exterior_component','22.08.27','Comparable Windows Condition'),
    ('1800.0179','sales_comparable_exterior_component','22.08.28','Comparable Other Exterior Feature Condition')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22H-exterior-quality-condition',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
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
  ('uad-3.6-2026-08-13-h1.5','UAD1426','fatal','sales_comparable_dwelling','Provide the exterior condition rating.','ExteriorConditionRatingCode is required for each applicable sales-comparable dwelling.',ARRAY['22.08.23'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1427','fatal','sales_comparable_dwelling','Provide the exterior quality rating.','ExteriorQualityRatingCode is required for each applicable sales-comparable dwelling.',ARRAY['22.08.17'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1473','fatal','sales_comparable_property','Indicate whether the homeowner is responsible for the exterior maintenance.','HomeownerResponsibleForExteriorMaintenanceIndicator is required for every sales comparable.',ARRAY[]::text[],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-001','fatal','sales_comparable_exterior_component','Exterior comparison records must retain their hierarchy.','Comparable components belong to comparable dwellings; subject summaries belong to the exact Section 8 Windows or Other feature.',ARRAY['22.08.06','22.08.08','22.08.18','22.08.19','22.08.20','22.08.21'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-002','fatal','sales_comparable_property','Exterior Quality and Condition applies only when both maintenance indicators are true.','Reject ratings, components, or subject summaries outside the official subsection condition.',ARRAY['22.08.02','22.08.17','22.08.09','22.08.23'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-003','fatal','sales_comparable_dwelling','Every applicable comparable dwelling requires ratings and the four core exterior rows.','Require Q/C ratings plus Exterior Walls and Trim, Foundation, Roof, and Windows components exactly once.',ARRAY['22.08.17','22.08.18','22.08.19','22.08.20','22.08.21','22.08.23'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-004','fatal','sales_comparable_exterior_component','Exterior details must agree with their component type.','Enforce type-specific material, summary, observability, condition, and Other-description conditions.',ARRAY['22.08.18','22.08.19','22.08.20','22.08.21','22.08.24','22.08.25','22.08.26','22.08.27'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-005','fatal','sales_comparison_subject_exterior_quality_summary','Provide one subject quality summary for Windows and each subject-defined Other exterior feature.','Comparison-only subject summaries are stored separately and merge into their canonical Section 8 parent component during XML generation.',ARRAY['22.08.06','22.08.08'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-EXTERIOR-006','fatal','sales_comparable_exterior_component','Other exterior feature labels must match the subject.','Comparable Other components use the exact subject row label; unrelated comparable features remain in the Dwelling(s) additional row.',ARRAY['22.08.07','22.08.14','22.08.22','22.08.28'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
