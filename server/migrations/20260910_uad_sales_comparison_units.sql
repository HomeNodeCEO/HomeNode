-- URAR Section 22G: Unit(s).
-- Additive UAD-only migration. Subject facts remain canonical Section 10 data;
-- comparable structures and units are separate appraisal-workfile records.

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
    'sales_comparable_unit_accessibility_feature'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"0300.0009","rfid":"22.07.02","context":"sales_comparison_subject_improvement","name":"ImprovementType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Dwelling","Outbuilding"],"maxLength":null,"format":null},
    {"uid":"1800.0365","rfid":"Does Not Display","context":"sales_comparable_property","name":"LivingUnitExcludingADUCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+1.0"},
    {"uid":"1800.0363","rfid":"Does Not Display","context":"sales_comparable_property","name":"DwellingCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+1.0"},
    {"uid":"1800.0125","rfid":"22.07.18","context":"sales_comparable_dwelling","name":"ImprovementType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Dwelling"],"maxLength":null,"format":null},
    {"uid":"0300.0065","rfid":"22.07.17","context":"sales_comparable_dwelling","name":"StructureIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":30,"format":"30"},
    {"uid":"1800.0125","rfid":"22.07.18","context":"sales_comparable_outbuilding","name":"ImprovementType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Outbuilding"],"maxLength":null,"format":null},
    {"uid":"1800.0366","rfid":"Does Not Display","context":"sales_comparable_outbuilding","name":"OutbuildingRealPropertyIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0126","rfid":"22.07.18","context":"sales_comparable_outbuilding","name":"OutbuildingType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Barn","Boathouse","Bunkhouse","EnclosedKennel","Greenhouse","GuestHouse","IndoorRidingArena","ManufacturedHome","Office","Other","PoolHouse","Shed","Silo","Stable","StandaloneADU","Studio","Workshop"],"maxLength":null,"format":null},
    {"uid":"1800.0127","rfid":"22.07.18","context":"sales_comparable_outbuilding","name":"OutbuildingTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":21,"format":"21"},
    {"uid":"1800.0287","rfid":"Does Not Display","context":"sales_comparable_unit","name":"AccessoryDwellingUnitIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0159","rfid":"22.07.17","context":"sales_comparable_unit","name":"UnitIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":25,"format":"25"},
    {"uid":"1800.0154","rfid":"22.07.20","context":"sales_comparable_unit","name":"FloorIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":3,"format":"3"},
    {"uid":"1800.0153","rfid":"22.07.22","context":"sales_comparable_unit","name":"CornerUnitIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0156","rfid":"22.07.24","context":"sales_comparable_unit","name":"UnitLevelCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0330","rfid":"22.07.26","context":"sales_comparable_unit","name":"BedroomCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0331","rfid":"22.07.28","context":"sales_comparable_unit","name":"FullBathroomCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0332","rfid":"22.07.28","context":"sales_comparable_unit","name":"HalfBathroomCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0390","rfid":"22.07.30","context":"sales_comparable_unit","name":"UnitStandardAboveGradeFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0391","rfid":"22.07.32","context":"sales_comparable_unit","name":"UnitNonStandardAboveGradeFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0392","rfid":"22.07.34","context":"sales_comparable_unit","name":"UnitAboveGradeUnfinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0393","rfid":"22.07.36","context":"sales_comparable_unit","name":"UnitStandardBelowGradeFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0399","rfid":"22.07.38","context":"sales_comparable_unit","name":"UnitNonStandardBelowGradeFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0394","rfid":"22.07.40","context":"sales_comparable_unit","name":"UnitBelowGradeUnfinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0134","rfid":"22.07.42","context":"sales_comparable_unit_accessibility_feature","name":"AccessibilityFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Appliances","Auditory","Bathtub","Cabinets","Counters","Doorways","ElectricalSwitches","GrabBars","Handrails","Hardware","Lighting","None","Other","Ramps","Shower","Sink","Toilet"],"maxLength":null,"format":null},
    {"uid":"1800.0135","rfid":"22.07.42","context":"sales_comparable_unit_accessibility_feature","name":"AccessibilityFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"}
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
         'phase', 22, 'subphase', '22G-units', 'options', options,
         'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4',
         'implementation', CASE WHEN context = 'sales_comparison_subject_improvement'
           THEN 'derived_from_subject_entity_type' ELSE NULL END
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

WITH adjustment(context, rfid, adjustment_type) AS (
  VALUES
    ('sales_comparable_adjustment_adu_location','22.07.19','AccessoryDwellingUnitLocation'),
    ('sales_comparable_adjustment_unit_floor','22.07.21','LivingUnitFloorNumber'),
    ('sales_comparable_adjustment_corner_unit','22.07.23','CornerUnit'),
    ('sales_comparable_adjustment_unit_levels','22.07.25','LivingUnitLevelCount'),
    ('sales_comparable_adjustment_bedrooms','22.07.27','LivingUnitBedroomCount'),
    ('sales_comparable_adjustment_bathrooms','22.07.29','LivingUnitBathroomCount'),
    ('sales_comparable_adjustment_standard_above','22.07.31','LivingUnitStandardFinishedAreaAboveGrade'),
    ('sales_comparable_adjustment_nonstandard_above','22.07.33','LivingUnitNonStandardFinishedAreaAboveGrade'),
    ('sales_comparable_adjustment_unfinished_above','22.07.35','LivingUnitUnfinishedAreaAboveGrade'),
    ('sales_comparable_adjustment_standard_below','22.07.37','LivingUnitStandardFinishedAreaBelowGrade'),
    ('sales_comparable_adjustment_nonstandard_below','22.07.39','LivingUnitNonStandardFinishedAreaBelowGrade'),
    ('sales_comparable_adjustment_unfinished_below','22.07.41','LivingUnitUnfinishedAreaBelowGrade'),
    ('sales_comparable_adjustment_accessibility','22.07.43','LivingUnitFeaturesForIndividualsWithDisabilities')
), catalog AS (
  SELECT '1800.0317'::text AS uid, rfid, context,
         'ComparableAdjustmentAmount'::text AS name, 'Amount'::text AS type,
         'Conditional'::text AS requirement, '0:1'::text AS cardinality,
         NULL::jsonb AS options, '±9.0'::text AS format
    FROM adjustment
  UNION ALL
  SELECT '1800.0318', 'Does Not Display', context,
         'ComparableAdjustmentType', 'Enumerated', 'Conditional', '1:1',
         jsonb_build_array(adjustment_type), NULL
    FROM adjustment
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22G-unit-adjustments', 'options', options,
         'format', format, 'source', 'Appendix A-1 URAR Delivery Specification 1.4'
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
       '{"phase":22,"subphase":"22G-units","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22G-units', '22G-unit-adjustments')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Canonical Section 10 values are redisplayed in the subject column. No
-- duplicate subject Unit(s) values are created or migrated.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0101','dwelling','22.07.01','Subject Structure Identifier'),
    ('0700.0114','unit','22.07.01','Subject Unit Identifier'),
    ('0300.0009','sales_comparison_subject_improvement','22.07.02','Subject Improvement Type'),
    ('0300.0025','outbuilding','22.07.02','Subject Outbuilding Type'),
    ('0300.0026','outbuilding','22.07.02','Subject Other Outbuilding Type'),
    ('0700.0060','unit','22.07.03','Subject Floor Number'),
    ('0700.0058','unit','22.07.04','Subject Corner Unit'),
    ('0700.0063','unit','22.07.05','Subject Unit Levels'),
    ('0700.0118','unit','22.07.06','Subject Bedrooms'),
    ('0700.0119','unit','22.07.07','Subject Full Bathrooms'),
    ('0700.0120','unit','22.07.07','Subject Half Bathrooms'),
    ('0700.0140','unit','22.07.08','Subject Standard Finished Area Above Grade'),
    ('0700.0141','unit','22.07.09','Subject Nonstandard Finished Area Above Grade'),
    ('0700.0142','unit','22.07.10','Subject Unfinished Area Above Grade'),
    ('0700.0143','unit','22.07.11','Subject Standard Finished Area Below Grade'),
    ('1800.0398','unit','22.07.12','Subject Nonstandard Finished Area Below Grade'),
    ('0700.0144','unit','22.07.13','Subject Unfinished Area Below Grade'),
    ('0700.0005','unit_accessibility','22.07.14','Subject Accessibility Feature'),
    ('0700.0006','unit_accessibility','22.07.14','Subject Other Accessibility Feature')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22G-subject-redisplay',
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
    ('1800.0125','sales_comparable_dwelling','22.07.18','Comparable Dwelling Improvement Type'),
    ('0300.0065','sales_comparable_dwelling','22.07.17','Comparable Dwelling Structure Identifier'),
    ('1800.0125','sales_comparable_outbuilding','22.07.18','Comparable Outbuilding Improvement Type'),
    ('1800.0126','sales_comparable_outbuilding','22.07.18','Comparable Outbuilding Type'),
    ('1800.0127','sales_comparable_outbuilding','22.07.18','Comparable Other Outbuilding Type'),
    ('1800.0159','sales_comparable_unit','22.07.17','Comparable Unit Identifier'),
    ('1800.0154','sales_comparable_unit','22.07.20','Comparable Floor Number'),
    ('1800.0153','sales_comparable_unit','22.07.22','Comparable Corner Unit'),
    ('1800.0156','sales_comparable_unit','22.07.24','Comparable Unit Levels'),
    ('1800.0330','sales_comparable_unit','22.07.26','Comparable Bedrooms'),
    ('1800.0331','sales_comparable_unit','22.07.28','Comparable Full Bathrooms'),
    ('1800.0332','sales_comparable_unit','22.07.28','Comparable Half Bathrooms'),
    ('1800.0390','sales_comparable_unit','22.07.30','Comparable Standard Finished Area Above Grade'),
    ('1800.0391','sales_comparable_unit','22.07.32','Comparable Nonstandard Finished Area Above Grade'),
    ('1800.0392','sales_comparable_unit','22.07.34','Comparable Unfinished Area Above Grade'),
    ('1800.0393','sales_comparable_unit','22.07.36','Comparable Standard Finished Area Below Grade'),
    ('1800.0399','sales_comparable_unit','22.07.38','Comparable Nonstandard Finished Area Below Grade'),
    ('1800.0394','sales_comparable_unit','22.07.40','Comparable Unfinished Area Below Grade'),
    ('1800.0134','sales_comparable_unit_accessibility_feature','22.07.42','Comparable Accessibility Feature'),
    ('1800.0135','sales_comparable_unit_accessibility_feature','22.07.42','Comparable Other Accessibility Feature')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22G-units',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(property_context, report_field_id, label) AS (
  VALUES
    ('sales_comparable_adjustment_adu_location','22.07.19','ADU Location Adjustment'),
    ('sales_comparable_adjustment_unit_floor','22.07.21','Floor Number Adjustment'),
    ('sales_comparable_adjustment_corner_unit','22.07.23','Corner Unit Adjustment'),
    ('sales_comparable_adjustment_unit_levels','22.07.25','Unit Levels Adjustment'),
    ('sales_comparable_adjustment_bedrooms','22.07.27','Bedrooms Adjustment'),
    ('sales_comparable_adjustment_bathrooms','22.07.29','Bathrooms Adjustment'),
    ('sales_comparable_adjustment_standard_above','22.07.31','Standard Finished Area Above Grade Adjustment'),
    ('sales_comparable_adjustment_nonstandard_above','22.07.33','Nonstandard Finished Area Above Grade Adjustment'),
    ('sales_comparable_adjustment_unfinished_above','22.07.35','Unfinished Area Above Grade Adjustment'),
    ('sales_comparable_adjustment_standard_below','22.07.37','Standard Finished Area Below Grade Adjustment'),
    ('sales_comparable_adjustment_nonstandard_below','22.07.39','Nonstandard Finished Area Below Grade Adjustment'),
    ('sales_comparable_adjustment_unfinished_below','22.07.41','Unfinished Area Below Grade Adjustment'),
    ('sales_comparable_adjustment_accessibility','22.07.43','Accessibility Feature Adjustment')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', '1800.0317', property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22G-unit-adjustments',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1463','fatal','sales_comparable_unit','Provide the number of bedrooms in the living unit, even if the value is 0.','BedroomCount is required for every comparable unit.',ARRAY['22.07.26'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1464','fatal','sales_comparable_unit','Provide the number of full bathrooms in the living unit, even if the value is 0.','FullBathroomCount is required for every comparable unit.',ARRAY['22.07.28'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1465','fatal','sales_comparable_unit','Provide the number of half bathrooms in the living unit, even if the value is 0.','HalfBathroomCount is required for every comparable unit.',ARRAY['22.07.28'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1482','fatal','sales_comparable_unit','Provide the Finished Above Grade Area, even if the value is 0.','UnitStandardAboveGradeFinishedAreaMeasure is required for every comparable unit.',ARRAY['22.07.30'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1483','fatal','sales_comparable_unit','Provide the Finished Below Grade Area, even if the value is 0.','UnitStandardBelowGradeFinishedAreaMeasure is required for every comparable unit.',ARRAY['22.07.36'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1772','fatal','sales_comparable_unit','Provide Floor Number for the sales comparable.','FloorIdentifier is required for an attached low-rise, mid-rise, or high-rise comparable dwelling unit.',ARRAY['22.07.20'],'{"phase":22,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1776','fatal','sales_comparable_unit','Provide the Unfinished Area Below Grade for the sales comparable, even if the value is 0.','UnitBelowGradeUnfinishedAreaMeasure is required for every comparable unit.',ARRAY['22.07.40'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1777','warning','sales_comparable_unit','Provide the Finished Area Below Grade (Nonstandard) for the sales comparable, even if the value is 0.','Required when the corresponding subject unit has nonstandard below-grade finished area greater than zero.',ARRAY['22.07.38'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1778','warning','sales_comparable_unit','Provide the Unfinished Area Above Grade for the sales comparable, even if the value is 0.','Required when the corresponding subject unit has unfinished above-grade area greater than zero.',ARRAY['22.07.34'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1779','warning','sales_comparable_unit','Provide the Finished Area Above Grade (Nonstandard) for the sales comparable, even if the value is 0.','Required when the corresponding subject unit has nonstandard above-grade finished area greater than zero.',ARRAY['22.07.32'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-001','fatal','sales_comparable_unit','Comparable Unit(s) records must retain their hierarchy.','Outbuildings belong to comparables; units belong to dwellings or outbuildings; accessibility features belong to units.',ARRAY['22.07.17','22.07.18','22.07.42'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-002','fatal','sales_comparable_unit','Add at least one primary unit for each comparable dwelling.','Unit(s) always displays and each dwelling contains at least one non-ADU unit.',ARRAY['22.07.17'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-003','fatal','sales_comparable_property','Comparable unit, ADU, and dwelling counts must agree with the saved hierarchy.','LivingUnitExcludingADUCount, AccessoryDwellingUnitTotalCount, DwellingCount, and per-dwelling LivingUnitCount are reconciled.',ARRAY['22.07.17','22.07.18'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-004','fatal','sales_comparable_unit','Structure and unit identifiers are required when needed to distinguish comparison rows.','Dwelling structure identifiers are required for multiple primary units; unit identifiers are required for multiple primary units or any ADU; all delivered identifiers must be unique.',ARRAY['22.07.17'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-005','fatal','sales_comparable_outbuilding','Only real-property outbuildings containing ADUs belong in the Unit(s) subsection.','OutbuildingRealPropertyIndicator is true and every contained unit is an ADU.',ARRAY['22.07.18'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-006','fatal','sales_comparable_unit_accessibility_feature','Accessibility values must be unambiguous.','Feature types are unique, None is exclusive, and Other requires a description.',ARRAY['22.07.42'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-UNIT-007','warning','sales_comparable_unit','Unit adjustments retain typed contexts for deterministic MISMO generation.','Each adjustment context derives the applicable ComparableAdjustmentType.',ARRAY['22.07.19','22.07.21','22.07.23','22.07.25','22.07.27','22.07.29','22.07.31','22.07.33','22.07.35','22.07.37','22.07.39','22.07.41','22.07.43'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"derived_xml_value"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
