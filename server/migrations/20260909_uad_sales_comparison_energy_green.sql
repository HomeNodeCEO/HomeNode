-- URAR Section 22F: Energy Efficient and Green Features.
-- Additive UAD-only migration. Subject facts are redisplayed from canonical
-- Section 6 records; comparable facts remain isolated from legacy appraisals.

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
    'sales_comparable_green_certification', 'sales_comparable_efficiency_rating'
  ));

-- Comparable energy/green detail mirrors the MISMO property hierarchy. The
-- three indicators are optional because Appendix F displays each grid row only
-- when relevant; an entered indicator is required for every included row.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0108","rfid":"22.06.05","context":"sales_comparable_energy_green","name":"RenewableEnergyComponentExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0107","rfid":"22.06.06","context":"sales_comparable_energy_green","name":"GreenCertificationExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0106","rfid":"22.06.07","context":"sales_comparable_energy_green","name":"EfficiencyRatingExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0113","rfid":"22.06.05","context":"sales_comparable_renewable_energy_component","name":"RenewableEnergyComponentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Geothermal","Other","Solar","WindTurbine"],"maxLength":null,"format":null},
    {"uid":"1800.0114","rfid":"22.06.05","context":"sales_comparable_renewable_energy_component","name":"RenewableEnergyComponentTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":60,"format":"60"},
    {"uid":"1800.0110","rfid":"22.06.06","context":"sales_comparable_green_certification","name":"GreenCertificationName","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":30,"format":"30"},
    {"uid":"1800.0109","rfid":"22.06.06","context":"sales_comparable_green_certification","name":"GreenCertificationLevelName","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":10,"format":"10"},
    {"uid":"1800.0111","rfid":"22.06.07","context":"sales_comparable_efficiency_rating","name":"EfficiencyRatingName","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":30,"format":"30"},
    {"uid":"1800.0112","rfid":"22.06.07","context":"sales_comparable_efficiency_rating","name":"EfficiencyRatingScoreValue","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":10,"format":"10"}
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
         'phase', 22, 'subphase', '22F-energy-green', 'options', options,
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

-- The editor stores the amount in a typed context. ComparableAdjustmentType is
-- deterministic and is emitted as EnergyEfficientAndGreenFeatures in MISMO.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0317","rfid":"22.06.04","context":"sales_comparable_adjustment_energy_green","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_energy_green","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["EnergyEfficientAndGreenFeatures"],"format":null}
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
         'phase', 22, 'subphase', '22F-energy-green-adjustment',
         'options', options, 'format', format,
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
       '{"phase":22,"subphase":"22F-energy-green","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22F-energy-green', '22F-energy-green-adjustment')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Subject values stay in Section 6 and are redisplayed into the grid. There is
-- no duplicate editable copy and no migration of existing property data.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('2600.0005','energy_green','22.06.01','Subject Known Renewable Energy Components'),
    ('2600.0019','renewable_energy_component','22.06.01','Subject Renewable Energy Component'),
    ('2600.0020','renewable_energy_component','22.06.01','Subject Other Renewable Energy Component'),
    ('2600.0004','energy_green','22.06.02','Subject Known Building Certifications'),
    ('2600.0009','green_building_certification','22.06.02','Subject Building Certification'),
    ('2600.0008','green_building_certification','22.06.02','Subject Building Certification Rating'),
    ('2600.0003','energy_green','22.06.03','Subject Known Efficiency Ratings'),
    ('2600.0012','green_efficiency_rating','22.06.03','Subject Efficiency Rating'),
    ('2600.0014','green_efficiency_rating','22.06.03','Subject Efficiency Rating Score')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22F-subject-redisplay',
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
    ('1800.0108','sales_comparable_energy_green','22.06.05','Comparable Known Renewable Energy Components'),
    ('1800.0113','sales_comparable_renewable_energy_component','22.06.05','Comparable Renewable Energy Component'),
    ('1800.0114','sales_comparable_renewable_energy_component','22.06.05','Comparable Other Renewable Energy Component'),
    ('1800.0107','sales_comparable_energy_green','22.06.06','Comparable Known Building Certifications'),
    ('1800.0110','sales_comparable_green_certification','22.06.06','Comparable Building Certification'),
    ('1800.0109','sales_comparable_green_certification','22.06.06','Comparable Building Certification Rating'),
    ('1800.0106','sales_comparable_energy_green','22.06.07','Comparable Known Efficiency Ratings'),
    ('1800.0111','sales_comparable_efficiency_rating','22.06.07','Comparable Efficiency Rating'),
    ('1800.0112','sales_comparable_efficiency_rating','22.06.07','Comparable Efficiency Rating Score')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22F-energy-green',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
) VALUES (
  'uad-3.6-2026-08-13-h1.5', '1800.0317',
  'sales_comparable_adjustment_energy_green', '22.06.04',
  22, 'Sales Comparison Approach', 'primary',
  '{"label":"Energy Efficient and Green Features Adjustment","phase":22,"subphase":"22F-energy-green-adjustment","source":"Appendix C-1 v1.3 and Appendix F-1 v1.4"}'::jsonb
)
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

-- Appendix H-1's seven Energy Efficient and Green rules apply to the subject
-- and were already seeded with Section 6. These implementation rules cover the
-- comparable-only hierarchy and conditionality specified by Appendices A/F.
INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ENERGY-GREEN-001','fatal','sales_comparable_energy_green','Comparable energy and green records must retain their parent relationships.','Every renewable component, certification, and efficiency rating belongs to one sales comparable.',ARRAY['22.06.05','22.06.06','22.06.07'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ENERGY-GREEN-002','fatal','sales_comparable_energy_green','Known-feature indicators and repeatable records must agree.','Yes requires at least one corresponding record; No or an omitted row rejects stale child records.',ARRAY['22.06.05','22.06.06','22.06.07'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ENERGY-GREEN-003','fatal','sales_comparable_renewable_energy_component','Comparable energy and green child records require their identifying values.','Renewable types are unique and Other requires a description; certifications require a name; efficiency ratings require a name and score.',ARRAY['22.06.05','22.06.06','22.06.07'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ENERGY-GREEN-004','warning','sales_comparable_adjustment_energy_green','The Energy Efficient and Green Features adjustment retains a typed context for deterministic MISMO generation.','The adjustment context derives ComparableAdjustmentType EnergyEfficientAndGreenFeatures.',ARRAY['22.06.04'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"derived_xml_value"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
