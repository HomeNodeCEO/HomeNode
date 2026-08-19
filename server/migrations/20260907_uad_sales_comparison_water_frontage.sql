-- URAR Section 22D: Water Frontage with Private Access.
-- Additive UAD-only migration. Bodies of water remain children of the existing
-- comparable Site Influence and do not alter Custom Appraisal or Tax Protest data.

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
    'sales_comparable_site_environmental', 'sales_comparable_site_view'
  ));

-- Complete the source Section 4 reference entries used by the Site editor and
-- the subject redisplays in Section 22D. Section 22 only redisplays these facts.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1500.0072","rfid":"4.035","context":"site_influence","name":"BodyOfWaterName","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0075","rfid":"Does Not Display","context":"site_influence","name":"PrivateAccessIndicator","type":"Boolean","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1500.0197","rfid":"4.037","context":"site_influence","name":"WaterAccessDepthType","type":"Enumerated","options":["DeepWater","NonNavigable","Other","ShallowWater"],"maxLength":null,"format":null},
    {"uid":"1500.0198","rfid":"4.037","context":"site_influence","name":"WaterAccessDepthTypeOtherDescription","type":"String","options":null,"maxLength":21,"format":"21"},
    {"uid":"1500.0079","rfid":"4.036","context":"site_influence","name":"WaterAccessRightType","type":"Enumerated","options":["Deeded","Other","Permitted","PrivatelyOwned"],"maxLength":null,"format":null},
    {"uid":"1500.0080","rfid":"4.036","context":"site_influence","name":"WaterAccessRightTypeOtherDescription","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0082","rfid":"4.032","context":"site_influence","name":"WaterfrontFeatureType","type":"Enumerated","options":["Beach","BoatLift","BoatRamp","BoatSlip","Dock","None","Other","Pier","Riprap","SeawallOrBulkhead"],"maxLength":null,"format":null},
    {"uid":"1500.0083","rfid":"4.032","context":"site_influence","name":"WaterfrontFeatureTypeOtherDescription","type":"String","options":null,"maxLength":33,"format":"33"},
    {"uid":"1500.0092","rfid":"4.033","context":"site_influence","name":"WaterfrontDevelopmentRightsIndicator","type":"Boolean","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1500.0091","rfid":"4.031","context":"site_influence","name":"WaterFrontageTotalLengthLinearMeasure","type":"Numeric","options":["Feet","Meters"],"maxLength":null,"format":"+6.0"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text,
    options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 4, 'Site', context, name, type,
       'Conditional', '0:unbounded',
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 21, 'subphase', '22D-subject-redisplay-reference',
         'options', options, 'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    metadata = EXCLUDED.metadata;

-- Comparable Body of Water values use the existing influence context and are
-- distinguished by their child entity IDs. Waterfront features repeat below a
-- body of water, preserving the official MISMO relationship for future XML.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0279","rfid":"Does Not Display","context":"sales_comparable_site_influence","name":"PrivateAccessIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0227","rfid":"22.04.06","context":"sales_comparable_site_influence","name":"BodyOfWaterName","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0321","rfid":"22.04.06","context":"sales_comparable_site_influence","name":"WaterAccessDepthType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["DeepWater","NonNavigable","Other","ShallowWater"],"maxLength":null,"format":null},
    {"uid":"1800.0322","rfid":"22.04.06","context":"sales_comparable_site_influence","name":"WaterAccessDepthTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":21,"format":"21"},
    {"uid":"1800.0230","rfid":"22.04.07","context":"sales_comparable_waterfront_feature","name":"WaterfrontFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Beach","BoatLift","BoatRamp","BoatSlip","Dock","None","Other","Pier","Riprap","SeawallOrBulkhead"],"maxLength":null,"format":null},
    {"uid":"1800.0231","rfid":"22.04.07","context":"sales_comparable_waterfront_feature","name":"WaterfrontFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0238","rfid":"22.04.08","context":"sales_comparable_site_influence","name":"WaterfrontDevelopmentRightsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0237","rfid":"22.04.09","context":"sales_comparable_site_influence","name":"WaterFrontageTotalLengthLinearMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["Feet","Meters"],"maxLength":null,"format":"+6.0"}
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
         'phase', 21, 'subphase', '22D-water-frontage', 'options', options,
         'max_length', "maxLength", 'format', format,
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
  SELECT * FROM (VALUES
    ('1800.0317','22.04.05','sales_comparable_adjustment_water_frontage','ComparableAdjustmentAmount','Amount','0:1',NULL::jsonb,'±9.0'),
    ('1800.0318','Does Not Display','sales_comparable_adjustment_water_frontage','ComparableAdjustmentType','Enumerated','1:1','["WaterFrontage"]'::jsonb,NULL)
  ) AS row(uid, rfid, context, name, type, cardinality, options, format)
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, 'Conditional', cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 21, 'subphase', '22D-water-frontage', 'options', options,
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
       '{"phase":21,"subphase":"22D-water-frontage","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22D-subject-redisplay-reference', '22D-water-frontage')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label, location_role) AS (
  VALUES
    ('1500.0072','site_influence','22.04.01','Subject Body of Water Name','redisplay'),
    ('1500.0073','site_influence','22.04.01','Subject Body of Water','redisplay'),
    ('1500.0074','site_influence','22.04.01','Subject Other Body of Water','redisplay'),
    ('1500.0197','site_influence','22.04.01','Subject Water Access Depth','redisplay'),
    ('1500.0198','site_influence','22.04.01','Subject Other Water Access Depth','redisplay'),
    ('1500.0082','site_influence','22.04.02','Subject Permanent Waterfront Feature','redisplay'),
    ('1500.0083','site_influence','22.04.02','Subject Other Permanent Waterfront Feature','redisplay'),
    ('1500.0092','site_influence','22.04.03','Subject Right to Build Waterfront Features','redisplay'),
    ('1500.0091','site_influence','22.04.04','Subject Total Private Water Frontage','redisplay'),
    ('1800.0317','sales_comparable_adjustment_water_frontage','22.04.05','Water Frontage with Private Access Adjustment','primary'),
    ('1800.0227','sales_comparable_site_influence','22.04.06','Comparable Body of Water Name','primary'),
    ('1800.0228','sales_comparable_site_influence','22.04.06','Comparable Body of Water','primary'),
    ('1800.0229','sales_comparable_site_influence','22.04.06','Comparable Other Body of Water','primary'),
    ('1800.0321','sales_comparable_site_influence','22.04.06','Comparable Water Access Depth','primary'),
    ('1800.0322','sales_comparable_site_influence','22.04.06','Comparable Other Water Access Depth','primary'),
    ('1800.0230','sales_comparable_waterfront_feature','22.04.07','Comparable Permanent Waterfront Feature','primary'),
    ('1800.0231','sales_comparable_waterfront_feature','22.04.07','Comparable Other Permanent Waterfront Feature','primary'),
    ('1800.0238','sales_comparable_site_influence','22.04.08','Comparable Right to Build Waterfront Features','primary'),
    ('1800.0237','sales_comparable_site_influence','22.04.09','Comparable Total Private Water Frontage','primary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 21, 'subphase', '22D-water-frontage',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1278','fatal','site_influence','Provide a photo of the water frontage.','A verified WaterFrontage image is required when any subject BODY_OF_WATER has PrivateAccessIndicator true.',ARRAY['4.112'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1333','warning','site_influence','Provide the Waterfront Access Rights.','WaterAccessRightType should be provided when the subject has private access to a body of water.',ARRAY['4.036'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1335','warning','site_influence','Provide the Permanent Waterfront Feature.','At least one WaterfrontFeatureType should be provided when the subject has private water access.',ARRAY['4.032'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1336','fatal','site_influence','Provide a description when Permanent Waterfront Feature is Other.','WaterfrontFeatureTypeOtherDescription is required when WaterfrontFeatureType is Other.',ARRAY['4.032'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1337','warning','site_influence','Provide the Water Frontage Access Depth.','WaterAccessDepthType should be provided when the subject has private access to a body of water.',ARRAY['4.037'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1338','fatal','site_influence','Provide a description when Water Frontage Access Depth is Other.','WaterAccessDepthTypeOtherDescription is required when WaterAccessDepthType is Other.',ARRAY['4.037'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1339','fatal','site_influence','Provide Total Linear Measurement for waterfront.','WaterFrontageTotalLengthLinearMeasure is required when any subject body of water has private access.',ARRAY['4.031'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1340','warning','site_influence','Indicate whether the property has rights to develop waterfront features.','WaterfrontDevelopmentRightsIndicator should be provided when WaterfrontFeatureType is None.',ARRAY['4.033'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1462','fatal','sales_comparable_site_influence','Provide a description when water access depth is Other.','WaterAccessDepthTypeOtherDescription is required when WaterAccessDepthType is Other for a sales-comparable BODY_OF_WATER.',ARRAY['22.04.06'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-WATER-001','fatal','sales_comparable_body_of_water','Bodies of water and permanent waterfront features must retain their parent relationships.','Each body belongs to a BodyOfWater influence; each feature belongs to a body.',ARRAY['22.04.06','22.04.07'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-WATER-002','fatal','sales_comparable_body_of_water','Indicate private access for every body of water and provide access depth when private access is Yes.','Private-access dependent values are required and stale values are rejected.',ARRAY['22.04.06'],'{"phase":21,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-WATER-003','fatal','sales_comparable_waterfront_feature','Permanent waterfront feature selections are unique and None is exclusive.','Duplicate features and mixed None selections are rejected per body of water.',ARRAY['22.04.07'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-WATER-004','fatal','sales_comparable_site_influence','Right to Build is required only when Permanent Waterfront Feature is None; waterfront details require private access.','Conditional waterfront values and aggregate frontage must agree with their controlling answers.',ARRAY['22.04.06','22.04.07','22.04.08','22.04.09'],'{"phase":21,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-WATER-005','warning','sales_comparable_adjustment_water_frontage','The water-frontage adjustment retains a typed context for deterministic MISMO generation.','ComparableAdjustmentType is derived as WaterFrontage.',ARRAY['22.04.05'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"derived_xml_value"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
