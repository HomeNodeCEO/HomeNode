ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property',
    'dwelling',
    'manufactured_home',
    'unit',
    'adu',
    'outbuilding',
    'vehicle_storage',
    'amenity',
    'sales_comparable',
    'rental_comparable',
    'grm_comparable',
    'land_comparable',
    'analyzed_not_used',
    'site_parcel',
    'site_influence',
    'site_view',
    'site_encumbrance',
    'site_feature',
    'site_utility',
    'site_defect',
    'renewable_energy_component',
    'green_building_certification',
    'green_efficiency_rating',
    'dwelling_exterior_feature',
    'dwelling_noncontinuous_room',
    'dwelling_exterior_defect',
    'manufactured_home_skirting_material',
    'manufactured_home_modification',
    'manufactured_home_hud_label',
    'manufactured_home_financing_program',
    'unit_area_data_source',
    'unit_adu_data_source',
    'unit_level',
    'unit_room',
    'unit_interior_feature',
    'unit_interior_defect',
    'outbuilding_room',
    'outbuilding_defect',
    'vehicle_storage_defect'
  ));

INSERT INTO appraisal.uad_entities (
  id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label
)
SELECT
  gen_random_uuid(), workfile.id, NULL, 'vehicle_storage', 'vehicle-storage-1', 1, 'Vehicle Storage 1'
FROM appraisal.uad_workfiles workfile
WHERE NOT EXISTS (
  SELECT 1
  FROM appraisal.uad_entities entity
  WHERE entity.workfile_id = workfile.id
    AND entity.entity_type = 'vehicle_storage'
)
ON CONFLICT DO NOTHING;

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
[
  {"uid":"3200.0006","rfid":"13.000 / 13.001","context":"vehicle_storage","name":"CarStorageType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Carport","CommonCarport","Driveway","Garage","None","OpenLot","Other","ParkingGarage","SharedDriveway"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0007","rfid":"13.000 / 13.001","context":"vehicle_storage","name":"CarStorageTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0011","rfid":"13.002","context":"vehicle_storage","name":"TenOrMoreParkingSpacesIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0010","rfid":"13.002","context":"vehicle_storage","name":"ParkingSpacesCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":99,"units":null},
  {"uid":"3200.0012","rfid":"13.002","context":"vehicle_storage","name":"ProjectParkingSpaceAssignmentType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Assigned","Owned","Unassigned"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0005","rfid":"13.003","context":"vehicle_storage","name":"CarStorageAttachmentType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Attached","BuiltIn","Detached"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0004","rfid":"13.003","context":"vehicle_storage","name":"CarStorageAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":99999,"units":["SquareFeet"]},
  {"uid":"3200.0008","rfid":"13.003","context":"vehicle_storage","name":"ImprovedSurfaceMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Cobblestone","Concrete","Dirt","Gravel","Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0009","rfid":"13.003","context":"vehicle_storage","name":"ImprovedSurfaceMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0021","rfid":"13.004","context":"vehicle_storage","name":"VehicleStorageDefectsExistIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0183","rfid":"Does Not Display","context":"vehicle_storage_defect","name":"DefectItemLocationType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0184","rfid":"13.006","context":"vehicle_storage_defect","name":"DefectItemLocationTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":31,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0181","rfid":"13.007","context":"vehicle_storage_defect","name":"DefectItemDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":520,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0180","rfid":"13.008","context":"vehicle_storage_defect","name":"DefectItemAffectsSoundnessStructuralIntegrityIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0185","rfid":"13.009","context":"vehicle_storage_defect","name":"DefectItemRecommendedActionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Completion","Inspection","None","Repair"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3200.0018","rfid":"13.010","context":"vehicle_storage_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0738","rfid":"13.001.2","context":"vehicle_storage_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0187","rfid":"13.005.2","context":"vehicle_storage_defect_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null}
]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    context text,
    name text,
    type text,
    requirement text,
    cardinality text,
    options jsonb,
    "maxLength" integer,
    minimum numeric,
    maximum numeric,
    units jsonb
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 13, 'Vehicle Storage',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 10,
    'options', options,
    'max_length', "maxLength",
    'minimum', minimum,
    'maximum', maximum,
    'units', units,
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
  '{"phase":10,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 13
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1664','warning','vehicle_storage','Provide the area of the ''Carport'' or ''Garage''.','CarStorageAreaMeasure is required when CarStorageType is Carport or Garage.',ARRAY['13.003'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1665','warning','vehicle_storage','Provide the attachment type for the ''Carport'' or ''Garage''.','CarStorageAttachmentType is required when CarStorageType is Carport or Garage.',ARRAY['13.003'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1667','fatal','vehicle_storage','The type of vehicle storage must be included. Select ''None'' if there is no vehicle storage.','At least one CAR_STORAGE_DETAIL exists and every instance includes CarStorageType.',ARRAY['13.000','13.001'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1668','fatal','vehicle_storage','Provide a description when vehicle storage type = ''Other''.','CarStorageTypeOtherDescription is required when CarStorageType = Other.',ARRAY['13.000','13.001'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1669','warning','vehicle_storage','Provide the material used for the ''Driveway'' or ''Shared Driveway''.','ImprovedSurfaceMaterialType is required for driveway storage types.',ARRAY['13.003'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1670','fatal','vehicle_storage','Provide a description when surface material = ''Other''.','ImprovedSurfaceMaterialTypeOtherDescription is required when surface material is Other.',ARRAY['13.003'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1671','fatal','vehicle_storage','Provide the number of parking spaces.','ParkingSpacesCount is required for each applicable vehicle storage.',ARRAY['13.002'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1672','warning','vehicle_storage','Indicate whether the ''Driveway'' or ''Shared Driveway'' has ten or more parking spaces.','TenOrMoreParkingSpacesIndicator is required for driveway storage types.',ARRAY['13.002'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1673','fatal','vehicle_storage','Provide the parking space assignment for ''Common Carport'', ''Open Lot'', or ''Parking Garage''.','ProjectParkingSpaceAssignmentType is required for shared project parking.',ARRAY['13.002'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1675','fatal','vehicle_storage','Indicate whether any vehicle storage has defects.','VehicleStorageDefectsExistIndicator is required when CarStorageType is not None.',ARRAY['13.004'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1686','fatal','vehicle_storage_defect','Provide at least one defect when the Appraiser identified a defect, damage or deficiency with one or more vehicle storages.','Every DEFECT is linked to its CAR_STORAGE using the required MISMO relationship.',ARRAY['13.004','13.005'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1736','fatal','vehicle_storage_asset','Provide the file name and location of the vehicle storage image within the submission ZIP file.','Every delivered vehicle storage IMAGE includes ImageFileLocationIdentifier.',ARRAY['13.001.1','13.005.1'],'{"phase":10,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-001','fatal','vehicle_storage','Select ''None'' as the only vehicle storage record.','None cannot coexist with another CAR_STORAGE_DETAIL.',ARRAY['13.000','13.001'],'{"phase":10,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-002','fatal','vehicle_storage_defect','The vehicle storage defects indicator must match saved defect records.','VehicleStorageDefectsExistIndicator reconciles to child DEFECT records.',ARRAY['13.004','13.005'],'{"phase":10,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-003','fatal','vehicle_storage_defect_asset','Each reported physical vehicle storage defect requires a verified photo.','Every vehicle storage defect has a verified Section 13 image.',ARRAY['13.005.1'],'{"phase":10,"source":"UAD 3.6 Photo and Image Requirements v1.0","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-004','fatal','vehicle_storage_defect','Every vehicle storage defect must identify its parent storage record.','Each DEFECT relationship points to a CAR_STORAGE in the workfile.',ARRAY['13.005'],'{"phase":10,"source":"Appendix F-1 v1.4","implementation":"server_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-005','fatal','vehicle_storage','A driveway with fewer than ten spaces must report a count from 1 through 9.','ParkingSpacesCount reconciles with TenOrMoreParkingSpacesIndicator.',ARRAY['13.002'],'{"phase":10,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-VEHICLE-STORAGE-006','fatal','vehicle_storage_commentary','Explain a reported shared driveway in Vehicle Storage Commentary.','SharedDriveway requires ValuationCommentText.',ARRAY['13.001','13.010'],'{"phase":10,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
