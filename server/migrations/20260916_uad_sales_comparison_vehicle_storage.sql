-- URAR Section 22M: Vehicle Storage.
-- Additive UAD-only migration. Section 13 remains the canonical subject source;
-- comparable storage records remain isolated children of a sales comparable.

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
    'sales_comparable_amenity', 'sales_comparable_vehicle_storage'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0397","rfid":"22.13.05","name":"CarStorageAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+5.0","unit":"SquareFeet"},
    {"uid":"1800.0094","rfid":"22.13.05","name":"CarStorageAttachmentType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Attached","BuiltIn","Detached"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0095","rfid":"22.13.05","name":"CarStorageType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Carport","CommonCarport","Driveway","Garage","None","OpenLot","Other","ParkingGarage","SharedDriveway"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0096","rfid":"22.13.05","name":"CarStorageTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45","unit":null},
    {"uid":"1800.0097","rfid":"22.13.05","name":"ImprovedSurfaceMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Cobblestone","Concrete","Dirt","Gravel","Other"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0098","rfid":"22.13.05","name":"ImprovedSurfaceMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"format":"12","unit":null},
    {"uid":"1800.0099","rfid":"22.13.05","name":"ParkingSpacesCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+2.0","unit":null},
    {"uid":"1800.0100","rfid":"22.13.05","name":"ProjectParkingSpaceAssignmentType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Assigned","Owned","Unassigned"],"maxLength":null,"format":null,"unit":null},
    {"uid":"1800.0103","rfid":"22.13.05","name":"TenOrMoreParkingSpacesIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null,"unit":null}
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
       'sales_comparable_vehicle_storage', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22M-vehicle-storage', 'options', options,
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
    {"uid":"1800.0317","rfid":"22.13.04","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["VehicleStorage"],"format":null}
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
       'sales_comparable_adjustment_vehicle_storage', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22M-vehicle-storage-adjustment',
         'options', options, 'format', format, 'adjustment_type', 'VehicleStorage',
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
  AND field.metadata->>'subphase' IN ('22M-vehicle-storage', '22M-vehicle-storage-adjustment')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Canonical Section 13 subject records redisplay in Section 22; no duplicate
-- editable subject copy is introduced.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('3200.0004','vehicle_storage','22.13.01','Subject Vehicle Storage Area'),
    ('3200.0005','vehicle_storage','22.13.01','Subject Vehicle Storage Attachment Type'),
    ('3200.0006','vehicle_storage','22.13.01','Subject Vehicle Storage Type'),
    ('3200.0007','vehicle_storage','22.13.01','Subject Other Vehicle Storage Type'),
    ('3200.0008','vehicle_storage','22.13.01','Subject Driveway Surface Material'),
    ('3200.0009','vehicle_storage','22.13.01','Subject Other Driveway Surface Material'),
    ('3200.0010','vehicle_storage','22.13.01','Subject Dedicated Parking Spaces'),
    ('3200.0012','vehicle_storage','22.13.01','Subject Parking Space Assignment'),
    ('3200.0011','vehicle_storage','22.13.01','Subject Ten or More Parking Spaces')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22M-subject-vehicle-storage-redisplay',
         'canonical_section', 13, 'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0397','sales_comparable_vehicle_storage','22.13.05','Comparable Vehicle Storage Area'),
    ('1800.0094','sales_comparable_vehicle_storage','22.13.05','Comparable Vehicle Storage Attachment Type'),
    ('1800.0095','sales_comparable_vehicle_storage','22.13.05','Comparable Vehicle Storage Type'),
    ('1800.0096','sales_comparable_vehicle_storage','22.13.05','Comparable Other Vehicle Storage Type'),
    ('1800.0097','sales_comparable_vehicle_storage','22.13.05','Comparable Driveway Surface Material'),
    ('1800.0098','sales_comparable_vehicle_storage','22.13.05','Comparable Other Driveway Surface Material'),
    ('1800.0099','sales_comparable_vehicle_storage','22.13.05','Comparable Dedicated Parking Spaces'),
    ('1800.0100','sales_comparable_vehicle_storage','22.13.05','Comparable Parking Space Assignment'),
    ('1800.0103','sales_comparable_vehicle_storage','22.13.05','Comparable Ten or More Parking Spaces'),
    ('1800.0317','sales_comparable_adjustment_vehicle_storage','22.13.04','Vehicle Storage Adjustment')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22M-vehicle-storage',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

-- Current official Appendix H-1 v1.5 rules for sales-comparable vehicle storage.
INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1405','fatal','sales_comparable_vehicle_storage','Provide the type of vehicle storage. Select None if there is no vehicle storage.','If ValuationUseType is SalesComparable and at least one CAR_STORAGE_DETAIL is not provided, or CarStorageType is missing in a provided detail.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1407','fatal','sales_comparable_vehicle_storage','Provide a description when vehicle storage type is Other.','If CarStorageType is Other and CarStorageTypeOtherDescription is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1408','warning','sales_comparable_vehicle_storage','Provide the attachment type for the Carport or Garage.','If CarStorageType is Carport or Garage and CarStorageAttachmentType is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1409','warning','sales_comparable_vehicle_storage','Provide the material used for the Driveway or Shared Driveway.','If CarStorageType is Driveway or SharedDriveway and ImprovedSurfaceMaterialType is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1410','fatal','sales_comparable_vehicle_storage','Provide a description when driveway surface material is Other.','If ImprovedSurfaceMaterialType is Other and ImprovedSurfaceMaterialTypeOtherDescription is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1411','fatal','sales_comparable_vehicle_storage','Provide the number of parking spaces.','ParkingSpacesCount is required for applicable storage types and for driveways with fewer than ten spaces.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1412','fatal','sales_comparable_vehicle_storage','Provide the parking-space assignment type.','If CarStorageType is CommonCarport, OpenLot, or ParkingGarage and ProjectParkingSpaceAssignmentType is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1414','warning','sales_comparable_vehicle_storage','Indicate whether the Driveway or Shared Driveway has ten or more parking spaces.','If CarStorageType is Driveway or SharedDriveway and TenOrMoreParkingSpacesIndicator is not provided.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"required_when"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-VEHICLE-STORAGE-001','fatal','sales_comparable_vehicle_storage','Every sales comparable must have vehicle-storage information.','Each comparable has at least one linked storage record with CarStorageType; use None as the sole record when no storage exists.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-VEHICLE-STORAGE-002','fatal','sales_comparable_vehicle_storage','Vehicle storage type None cannot coexist with another storage record or stale details.','None is the only record when selected and contains no attachment, area, parking, or driveway details.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-VEHICLE-STORAGE-003','fatal','sales_comparable_vehicle_storage','Vehicle-storage details must agree with their controlling type.','Attachment and area apply to garages or carports; driveway, assignment, Other, and parking-count details remain conditional on their official types.',ARRAY['22.13.05'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-VEHICLE-STORAGE-004','fatal','sales_comparable_adjustment_vehicle_storage','Vehicle Storage adjustment is delivered once for each comparable.','The typed adjustment context derives ComparableAdjustmentType VehicleStorage and prevents a repeated adjustment type.',ARRAY['22.13.04'],'{"phase":22,"source":"Appendix H-1 v1.5 Adjustments Cardinality","implementation":"typed_context"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
