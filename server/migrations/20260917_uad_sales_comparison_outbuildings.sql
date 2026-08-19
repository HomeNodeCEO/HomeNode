-- URAR Section 22N: Outbuilding.
-- Additive UAD-only migration. Section 12 remains the canonical subject source;
-- comparable outbuildings and their room summaries remain isolated children of
-- the owning sales comparable.

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
    'sales_comparable_outbuilding', 'sales_comparable_outbuilding_room',
    'sales_comparable_unit', 'sales_comparable_unit_accessibility_feature',
    'sales_comparable_exterior_component',
    'sales_comparison_subject_exterior_quality_summary',
    'sales_comparable_kitchen', 'sales_comparable_interior_component',
    'sales_comparison_subject_unit_interior_summary',
    'sales_comparison_subject_kitchen_summary',
    'sales_comparison_subject_interior_quality_summary',
    'sales_comparison_subject_interior_condition_summary',
    'sales_comparable_amenity', 'sales_comparable_vehicle_storage'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0126","rfid":"22.14.14","name":"OutbuildingType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Barn","Boathouse","Bunkhouse","EnclosedKennel","Greenhouse","GuestHouse","IndoorRidingArena","ManufacturedHome","Office","Other","PoolHouse","Shed","Silo","Stable","StandaloneADU","Studio","Workshop"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0127","rfid":"22.14.14","name":"OutbuildingTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":["ADUGarage"],"maxLength":21,"format":"21","unit":null},
    {"uid":"1800.0368","rfid":"Does Not Display","name":"LivingUnitCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0","unit":null},
    {"uid":"1800.0387","rfid":"22.14.16","name":"StructureAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+6.0","unit":"SquareFeet"},
    {"uid":"1800.0344","rfid":"22.14.17","name":"StructureExcludingVehicleStorageAndADUFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+6.0","unit":"SquareFeet"},
    {"uid":"1800.0380","rfid":"22.14.18","name":"StructureExcludingVehicleStorageAndADUUnfinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+6.0","unit":"SquareFeet"},
    {"uid":"1800.0351","rfid":"22.14.19","name":"StructureVolumeMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0","unit":"CubicFeet"},
    {"uid":"1800.0124","rfid":"22.14.23","name":"HeatingSystemExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0123","rfid":"22.14.24","name":"CoolingSystemExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0132","rfid":"22.14.25","name":"UtilityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:6","options":["Electricity","Gas","None","Other","SanitarySewer","Water"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0133","rfid":"22.14.25","name":"UtilityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":28,"format":"28","unit":null}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text, unit text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       'sales_comparable_outbuilding', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22N-outbuilding', 'options', options,
         'max_length', "maxLength", 'format', format, 'unit', unit,
         'parent_entity_type', 'sales_comparable',
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
    {"uid":"1800.0388","rfid":"22.14.20 / 22.14.21 / 22.14.22","name":"RoomType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["FullBathroom","HalfBathroom","Kitchen"],"format":null},
    {"uid":"1800.0389","rfid":"22.14.20 / 22.14.21 / 22.14.22","name":"TotalRoomCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"format":"+2.0"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, name text, type text, requirement text,
    cardinality text, options jsonb, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       'sales_comparable_outbuilding_room', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22N-outbuilding-room', 'options', options,
         'format', format, 'parent_entity_type', 'sales_comparable_outbuilding',
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
    {"uid":"1800.0317","rfid":"22.14.15","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Outbuilding"],"format":null}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, name text, type text, requirement text,
    cardinality text, options jsonb, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       'sales_comparable_adjustment_outbuilding', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22N-outbuilding-adjustment',
         'options', options, 'format', format, 'adjustment_type', 'Outbuilding',
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
  AND field.metadata->>'subphase' IN ('22N-outbuilding', '22N-outbuilding-room', '22N-outbuilding-adjustment')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Canonical Section 12 subject records redisplay in Section 22; no duplicate
-- editable subject copy is introduced. Room summaries are routed to the three
-- official comparison rows according to RoomType.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0025','outbuilding','22.14.01','Subject Outbuilding Type'),
    ('0300.0026','outbuilding','22.14.01','Subject Other Outbuilding Type'),
    ('0300.0060','outbuilding','22.14.02','Subject Gross Building Area'),
    ('0300.0112','outbuilding','22.14.03','Subject Finished Area'),
    ('0300.0113','outbuilding','22.14.04','Subject Unfinished Area'),
    ('0300.0073','outbuilding','22.14.05','Subject Structure Volume'),
    ('0300.0018','outbuilding_room','22.14.06','Subject Full Bathroom Row Type'),
    ('0300.0020','outbuilding_room','22.14.06','Subject Full Bathroom Count'),
    ('0300.0018','outbuilding_room','22.14.07','Subject Half Bathroom Row Type'),
    ('0300.0020','outbuilding_room','22.14.07','Subject Half Bathroom Count'),
    ('0300.0018','outbuilding_room','22.14.08','Subject Kitchen Row Type'),
    ('0300.0020','outbuilding_room','22.14.08','Subject Kitchen Count'),
    ('0300.0023','outbuilding','22.14.09','Subject Heating Exists'),
    ('0300.0088','outbuilding','22.14.09','Subject Heating Types'),
    ('0300.0022','outbuilding','22.14.10','Subject Cooling Exists'),
    ('0300.0084','outbuilding','22.14.10','Subject Cooling Types'),
    ('0300.0028','outbuilding','22.14.11','Subject Utilities'),
    ('0300.0029','outbuilding','22.14.11','Subject Other Utility')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22N-subject-outbuilding-redisplay',
         'canonical_section', 12, 'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0126','sales_comparable_outbuilding','22.14.14','Comparable Outbuilding Type'),
    ('1800.0127','sales_comparable_outbuilding','22.14.14','Comparable Other Outbuilding Type'),
    ('1800.0317','sales_comparable_adjustment_outbuilding','22.14.15','Outbuilding Adjustment'),
    ('1800.0387','sales_comparable_outbuilding','22.14.16','Comparable Gross Building Area'),
    ('1800.0344','sales_comparable_outbuilding','22.14.17','Comparable Finished Area'),
    ('1800.0380','sales_comparable_outbuilding','22.14.18','Comparable Unfinished Area'),
    ('1800.0351','sales_comparable_outbuilding','22.14.19','Comparable Structure Volume'),
    ('1800.0388','sales_comparable_outbuilding_room','22.14.20','Comparable Full Bathroom Row Type'),
    ('1800.0389','sales_comparable_outbuilding_room','22.14.20','Comparable Full Bathroom Count'),
    ('1800.0388','sales_comparable_outbuilding_room','22.14.21','Comparable Half Bathroom Row Type'),
    ('1800.0389','sales_comparable_outbuilding_room','22.14.21','Comparable Half Bathroom Count'),
    ('1800.0388','sales_comparable_outbuilding_room','22.14.22','Comparable Kitchen Row Type'),
    ('1800.0389','sales_comparable_outbuilding_room','22.14.22','Comparable Kitchen Count'),
    ('1800.0124','sales_comparable_outbuilding','22.14.23','Comparable Heating Exists'),
    ('1800.0123','sales_comparable_outbuilding','22.14.24','Comparable Cooling Exists'),
    ('1800.0132','sales_comparable_outbuilding','22.14.25','Comparable Utilities'),
    ('1800.0133','sales_comparable_outbuilding','22.14.25','Comparable Other Utility')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22N-outbuilding',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1758','warning','sales_comparable_adjustment','Only one line-item adjustment is allowed for this Adjustment Type.','A sales comparable cannot contain more than one adjustment with a single-use ComparableAdjustmentType such as Outbuilding.',ARRAY['22.14.15'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"typed_context"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-001','fatal','sales_comparable_outbuilding','Comparable outbuildings must be classified as real-property Outbuilding improvements.','ImprovementType is Outbuilding, OutbuildingRealPropertyIndicator is true, and LivingUnitCount equals linked ADU records.',ARRAY['22.14.14'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-002','fatal','sales_comparable_outbuilding','Standalone ADUs and ADU/Garage structures cannot be duplicated in the Outbuilding comparison rows.','ADU-only structures are reported in Unit(s), ADU Interior, and Vehicle Storage; Section 22N detail fields remain empty.',ARRAY['22.14.14'],'{"phase":22,"source":"Appendix F-1 URAR Reference Guide v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-003','fatal','sales_comparable_outbuilding_room','Outbuilding bathroom and kitchen summaries must be linked and unique by type.','Each room summary belongs to an outbuilding and FullBathroom, HalfBathroom, and Kitchen occur at most once per outbuilding.',ARRAY['22.14.20','22.14.21','22.14.22'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-004','fatal','sales_comparable_outbuilding','Outbuilding utilities must use None exclusively and describe Other.','None cannot coexist with another UtilityType; UtilityTypeOtherDescription is present only when Other is selected.',ARRAY['22.14.25'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-005','fatal','sales_comparable_outbuilding','Detailed outbuilding areas cannot exceed gross building area.','Finished and unfinished areas excluding vehicle storage and ADUs sum to no more than StructureAreaMeasure.',ARRAY['22.14.16','22.14.17','22.14.18'],'{"phase":22,"source":"Appendix F-1 URAR Reference Guide v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-OUTBUILDING-006','fatal','sales_comparable_adjustment_outbuilding','Outbuilding adjustment is delivered once for each comparable.','The typed adjustment context derives ComparableAdjustmentType Outbuilding and prevents a repeated adjustment type.',ARRAY['22.14.15'],'{"phase":22,"source":"Appendix H-1 v1.5 Adjustments Cardinality","implementation":"typed_context"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
