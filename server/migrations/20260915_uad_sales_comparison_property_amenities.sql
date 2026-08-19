-- URAR Section 22L: Property Amenities.
-- Additive UAD-only migration. Subject amenities remain the canonical Section
-- 14 records; comparable amenities are isolated children of a sales comparable.

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
    'sales_comparison_subject_interior_condition_summary',
    'sales_comparable_amenity'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0199","rfid":"Does Not Display","context":"sales_comparable_property","name":"PropertyAmenityExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null,"category":null},
    {"uid":"1800.0253","rfid":"Does Not Display","context":"sales_comparable_amenity_outdoor_accessories","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OutdoorAccessories"],"maxLength":null,"format":null,"category":"OutdoorAccessories"},
    {"uid":"1800.0254","rfid":"22.12.06","context":"sales_comparable_amenity_outdoor_accessories","name":"AmenityCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","category":"OutdoorAccessories"},
    {"uid":"1800.0255","rfid":"22.12.06","context":"sales_comparable_amenity_outdoor_accessories","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Fence","IrrigationSystem","OutdoorFireplace","OutdoorKitchen","OutdoorRidingRing","SportsCourt"],"maxLength":null,"format":null,"category":"OutdoorAccessories"},
    {"uid":"1800.0256","rfid":"Does Not Display","context":"sales_comparable_amenity_outdoor_living","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OutdoorLiving"],"maxLength":null,"format":null,"category":"OutdoorLiving"},
    {"uid":"1800.0257","rfid":"22.12.08","context":"sales_comparable_amenity_outdoor_living","name":"AmenityCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","category":"OutdoorLiving"},
    {"uid":"1800.0258","rfid":"22.12.08","context":"sales_comparable_amenity_outdoor_living","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Balcony","Deck","Gazebo","Patio","Porch","Portico"],"maxLength":null,"format":null,"category":"OutdoorLiving"},
    {"uid":"1800.0259","rfid":"Does Not Display","context":"sales_comparable_amenity_water_features","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["WaterFeatures"],"maxLength":null,"format":null,"category":"WaterFeatures"},
    {"uid":"1800.0260","rfid":"22.12.10","context":"sales_comparable_amenity_water_features","name":"AmenityCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","category":"WaterFeatures"},
    {"uid":"1800.0261","rfid":"22.12.10","context":"sales_comparable_amenity_water_features","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["IngroundPool","IngroundSpa","OutdoorShower","Sauna"],"maxLength":null,"format":null,"category":"WaterFeatures"},
    {"uid":"1800.0401","rfid":"22.12.10","context":"sales_comparable_amenity_water_features","name":"SwimmingPoolFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"0:M","options":["Caged","Heated","Indoor","Other"],"maxLength":null,"format":null,"category":"WaterFeatures"},
    {"uid":"1800.0402","rfid":"22.12.10","context":"sales_comparable_amenity_water_features","name":"SwimmingPoolFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45","category":"WaterFeatures"},
    {"uid":"1800.0262","rfid":"Does Not Display","context":"sales_comparable_amenity_whole_home","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["WholeHome"],"maxLength":null,"format":null,"category":"WholeHome"},
    {"uid":"1800.0263","rfid":"22.12.12","context":"sales_comparable_amenity_whole_home","name":"AmenityCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","category":"WholeHome"},
    {"uid":"1800.0264","rfid":"22.12.12","context":"sales_comparable_amenity_whole_home","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["ElectricVehicleChargingStation","Elevator","FireSuppressionSystem","IndoorFireplace","MultipleZoneHeatingVentilationAndAirConditioning","SmartHomeSystem","WholeHouseVentilation","WoodStove"],"maxLength":null,"format":null,"category":"WholeHome"},
    {"uid":"1800.0265","rfid":"Does Not Display","context":"sales_comparable_amenity_miscellaneous","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Miscellaneous"],"maxLength":null,"format":null,"category":"Miscellaneous"},
    {"uid":"1800.0266","rfid":"22.12.14","context":"sales_comparable_amenity_miscellaneous","name":"AmenityCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","category":"Miscellaneous"},
    {"uid":"1800.0267","rfid":"22.12.14","context":"sales_comparable_amenity_miscellaneous","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Airstrip","ClubMembership","Other","SharedLaundryFacilities"],"maxLength":null,"format":null,"category":"Miscellaneous"},
    {"uid":"1800.0268","rfid":"22.12.14","context":"sales_comparable_amenity_miscellaneous","name":"AmenityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33","category":"Miscellaneous"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text, category text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22L-property-amenities', 'options', options,
         'max_length', "maxLength", 'format', format, 'amenity_category', category,
         'parent_entity_type', CASE WHEN category IS NOT NULL THEN 'sales_comparable' ELSE NULL END,
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

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0317","rfid":"22.12.07","context":"sales_comparable_adjustment_outdoor_accessory_amenity","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0","adjustmentType":"OutdoorAccessoryAmenity"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_outdoor_accessory_amenity","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OutdoorAccessoryAmenity"],"format":null,"adjustmentType":"OutdoorAccessoryAmenity"},
    {"uid":"1800.0317","rfid":"22.12.09","context":"sales_comparable_adjustment_outdoor_living_amenity","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0","adjustmentType":"OutdoorLivingAmenity"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_outdoor_living_amenity","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OutdoorLivingAmenity"],"format":null,"adjustmentType":"OutdoorLivingAmenity"},
    {"uid":"1800.0317","rfid":"22.12.11","context":"sales_comparable_adjustment_water_features_amenity","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0","adjustmentType":"WaterFeaturesAmenity"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_water_features_amenity","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["WaterFeaturesAmenity"],"format":null,"adjustmentType":"WaterFeaturesAmenity"},
    {"uid":"1800.0317","rfid":"22.12.13","context":"sales_comparable_adjustment_whole_home_amenity","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0","adjustmentType":"WholeHomeAmenity"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_whole_home_amenity","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["WholeHomeAmenity"],"format":null,"adjustmentType":"WholeHomeAmenity"},
    {"uid":"1800.0317","rfid":"22.12.15","context":"sales_comparable_adjustment_miscellaneous_amenity","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0","adjustmentType":"MiscellaneousAmenity"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_miscellaneous_amenity","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["MiscellaneousAmenity"],"format":null,"adjustmentType":"MiscellaneousAmenity"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, format text, "adjustmentType" text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22L-property-amenity-adjustments',
         'options', options, 'format', format, 'adjustment_type', "adjustmentType",
         'implementation', CASE WHEN name = 'ComparableAdjustmentType' THEN 'derived_from_typed_context' ELSE NULL END,
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
       regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
       option.ordinality,
       jsonb_build_object('phase', 22, 'subphase', field.metadata->>'subphase', 'source', 'Appendix A-1 URAR Delivery Specification 1.4')
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22L-property-amenities', '22L-property-amenity-adjustments')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Canonical Section 14 subject records are redisplayed; no second editable
-- subject copy is created in Section 22.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0200.0007','amenity_outdoor_accessories','22.12.01','Subject Outdoor Accessory'),
    ('0200.0004','amenity_outdoor_accessories','22.12.01','Subject Outdoor Accessory Count'),
    ('0200.0023','amenity_outdoor_living','22.12.02','Subject Outdoor Living Amenity'),
    ('0200.0032','amenity_water_features','22.12.03','Subject Water Feature'),
    ('0200.0029','amenity_water_features','22.12.03','Subject Water Feature Count'),
    ('0200.0012','amenity_water_features','22.12.03','Subject Water Feature Details'),
    ('0200.0013','amenity_water_features','22.12.03','Subject Other Water Feature Detail'),
    ('0200.0039','amenity_whole_home','22.12.04','Subject Whole Home Amenity'),
    ('0200.0036','amenity_whole_home','22.12.04','Subject Whole Home Amenity Count'),
    ('0200.0046','amenity_miscellaneous','22.12.05','Subject Miscellaneous Amenity'),
    ('0200.0043','amenity_miscellaneous','22.12.05','Subject Miscellaneous Amenity Count'),
    ('0200.0047','amenity_miscellaneous','22.12.05','Subject Other Miscellaneous Amenity')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22L-subject-amenity-redisplay',
         'canonical_section', 14, 'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0254','sales_comparable_amenity_outdoor_accessories','22.12.06','Comparable Outdoor Accessory Count'),
    ('1800.0255','sales_comparable_amenity_outdoor_accessories','22.12.06','Comparable Outdoor Accessory'),
    ('1800.0257','sales_comparable_amenity_outdoor_living','22.12.08','Comparable Outdoor Living Amenity Count'),
    ('1800.0258','sales_comparable_amenity_outdoor_living','22.12.08','Comparable Outdoor Living Amenity'),
    ('1800.0260','sales_comparable_amenity_water_features','22.12.10','Comparable Water Feature Count'),
    ('1800.0261','sales_comparable_amenity_water_features','22.12.10','Comparable Water Feature'),
    ('1800.0401','sales_comparable_amenity_water_features','22.12.10','Comparable Water Feature Details'),
    ('1800.0402','sales_comparable_amenity_water_features','22.12.10','Comparable Other Water Feature Detail'),
    ('1800.0263','sales_comparable_amenity_whole_home','22.12.12','Comparable Whole Home Amenity Count'),
    ('1800.0264','sales_comparable_amenity_whole_home','22.12.12','Comparable Whole Home Amenity'),
    ('1800.0266','sales_comparable_amenity_miscellaneous','22.12.14','Comparable Miscellaneous Amenity Count'),
    ('1800.0267','sales_comparable_amenity_miscellaneous','22.12.14','Comparable Miscellaneous Amenity'),
    ('1800.0268','sales_comparable_amenity_miscellaneous','22.12.14','Comparable Other Miscellaneous Amenity'),
    ('1800.0317','sales_comparable_adjustment_outdoor_accessory_amenity','22.12.07','Outdoor Accessories Adjustment'),
    ('1800.0317','sales_comparable_adjustment_outdoor_living_amenity','22.12.09','Outdoor Living Adjustment'),
    ('1800.0317','sales_comparable_adjustment_water_features_amenity','22.12.11','Water Features Adjustment'),
    ('1800.0317','sales_comparable_adjustment_whole_home_amenity','22.12.13','Whole Home Adjustment'),
    ('1800.0317','sales_comparable_adjustment_miscellaneous_amenity','22.12.15','Miscellaneous Amenities Adjustment')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22L-property-amenities',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

-- Appendix H-1 v1.5 contains the subject PropertyAmenityExistsIndicator rule
-- (UAD1045), already seeded with Section 14. These rules cover the comparable
-- hierarchy and the five nonrepeating adjustment types in Appendix H.
INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-AMENITIES-001','fatal','sales_comparable_property','Indicate whether each sales comparable has property amenities.','PropertyAmenityExistsIndicator is required for each sales comparable; Yes requires at least one linked amenity and No rejects stale amenity records.',ARRAY['22.12.06','22.12.08','22.12.10','22.12.12','22.12.14'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-AMENITIES-002','fatal','sales_comparable_amenity','Comparable amenity records must retain their parent and category relationships.','Every amenity belongs to one sales comparable and one of the five UAD categories.',ARRAY['22.12.06','22.12.08','22.12.10','22.12.12','22.12.14'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-AMENITIES-003','fatal','sales_comparable_amenity','Comparable amenity details must agree with their type.','Use AmenityCount instead of duplicate type rows; Other and swimming-pool details are conditional on their controlling enumeration.',ARRAY['22.12.06','22.12.08','22.12.10','22.12.12','22.12.14'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-AMENITIES-004','fatal','sales_comparable_adjustment','Property amenity adjustment types cannot repeat for one sales comparable.','The five typed adjustment contexts derive OutdoorAccessoryAmenity, OutdoorLivingAmenity, WaterFeaturesAmenity, WholeHomeAmenity, and MiscellaneousAmenity exactly once.',ARRAY['22.12.07','22.12.09','22.12.11','22.12.13','22.12.15'],'{"phase":22,"source":"Appendix H-1 v1.5 Adjustments Cardinality","implementation":"typed_context"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
