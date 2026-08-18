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
    'outbuilding_defect'
  ));

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
[
  {"uid":"0300.0025","rfid":"12.001","context":"outbuilding","name":"OutbuildingType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Barn","Boathouse","Bunkhouse","EnclosedKennel","Greenhouse","GuestHouse","IndoorRidingArena","ManufacturedHome","Office","Other","PoolHouse","Shed","Silo","Stable","StandaloneADU","Studio","Workshop"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0026","rfid":"12.001","context":"outbuilding","name":"OutbuildingTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":21,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0024","rfid":"12.002","context":"outbuilding","name":"OutbuildingRealPropertyIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0063","rfid":"12.003","context":"outbuilding","name":"LivingUnitCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":99,"units":null},
  {"uid":"0500.0007","rfid":"12.004","context":"outbuilding","name":"ManufacturedHomeAttachedToFoundationIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0073","rfid":"12.005","context":"outbuilding","name":"StructureVolumeMeasure","type":"Measurement","requirement":"Optional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":null,"units":["CubicFeet"]},
  {"uid":"0300.0060","rfid":"12.006","context":"outbuilding","name":"StructureAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":null,"units":["SquareFeet"]},
  {"uid":"0300.0023","rfid":"12.008","context":"outbuilding","name":"HeatingSystemExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0022","rfid":"12.009 / 12.016","context":"outbuilding","name":"CoolingSystemExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0028","rfid":"12.010","context":"outbuilding","name":"UtilityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:6","options":["Electricity","Gas","None","Other","SanitarySewer","Water"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0029","rfid":"12.010","context":"outbuilding","name":"UtilityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":28,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0112","rfid":"12.011","context":"outbuilding","name":"StructureExcludingVehicleStorageAndADUFinishedAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":null,"units":["SquareFeet"]},
  {"uid":"0300.0113","rfid":"12.013","context":"outbuilding","name":"StructureExcludingVehicleStorageAndADUUnfinishedAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":null,"units":["SquareFeet"]},
  {"uid":"0300.0088","rfid":"12.014","context":"outbuilding","name":"HeatingSystemType","type":"Enumerated","requirement":"Conditional","cardinality":"0:11","options":["Baseboard","Fireplace","ForcedWarmAir","GravityAir","MiniSplit","None","Other","PassiveSolar","Radiant","Radiators","Stove"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0089","rfid":"12.014","context":"outbuilding","name":"HeatingSystemTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":19,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0086","rfid":"12.015","context":"outbuilding","name":"HeatingFuelType","type":"Enumerated","requirement":"Conditional","cardinality":"0:9","options":["Coal","Electric","Geothermal","NaturalGas","Oil","Other","Propane","Solar","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0087","rfid":"12.015","context":"outbuilding","name":"HeatingFuelTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":31,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0083","rfid":"12.015","context":"outbuilding","name":"LackOfHeatingTypicalIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0084","rfid":"12.016","context":"outbuilding","name":"CoolingSystemType","type":"Enumerated","requirement":"Conditional","cardinality":"0:3","options":["Centralized","Individual","Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0085","rfid":"12.016","context":"outbuilding","name":"CoolingSystemTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":19,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0090","rfid":"12.017","context":"outbuilding","name":"OtherMechanicalSystemType","type":"Enumerated","requirement":"Optional","cardinality":"0:5","options":["Other","RadonMitigation","SumpPump","WaterHeater","WholeHouseWaterTreatment"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0091","rfid":"12.017","context":"outbuilding","name":"OtherMechanicalSystemTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0111","rfid":"12.019","context":"outbuilding","name":"OutbuildingDefectsExistIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0096","rfid":"12.025","context":"outbuilding","name":"OutbuildingCommentDescription","type":"String","requirement":"Optional","cardinality":"0:1","options":null,"maxLength":5000,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0018","rfid":"12.012","context":"outbuilding_room","name":"RoomType","type":"Enumerated","requirement":"Conditional","cardinality":"0:19","options":["Bedroom","BreakfastRoom","Den","DiningRoom","FamilyRoom","FullBathroom","HalfBathroom","Kitchen","LaundryRoom","LivingRoom","Loft","MediaRoom","Mudroom","Other","RecreationRoom","Sunroom","UtilityRoom","WalkInPantry","Workshop"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0019","rfid":"12.012","context":"outbuilding_room","name":"RoomTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"minimum":null,"maximum":null,"units":null},
  {"uid":"0300.0020","rfid":"12.012","context":"outbuilding_room","name":"RoomCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":1,"maximum":99,"units":null},
  {"uid":"3900.0164","rfid":"12.020","context":"outbuilding_defect","name":"DefectFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["ExteriorWallsAndTrim","Flooring","Foundation","MechanicalSystem","Other","Roof","WallsAndCeiling","Windows"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0165","rfid":"12.020","context":"outbuilding_defect","name":"DefectFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":62,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0169","rfid":"12.021","context":"outbuilding_defect","name":"DefectLocationType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["FullBathroom","HalfBathroom","Kitchen","Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0170","rfid":"12.021","context":"outbuilding_defect","name":"DefectLocationTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":31,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0167","rfid":"12.022","context":"outbuilding_defect","name":"DefectDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":520,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0166","rfid":"12.023","context":"outbuilding_defect","name":"DefectAffectsStructuralSoundnessOrLivabilityIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0171","rfid":"12.024","context":"outbuilding_defect","name":"DefectRequiredActionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Completion","Inspection","None","Repair"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0640","rfid":"12.007.2 / 12.026.2","context":"outbuilding_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0173","rfid":"12.020.2","context":"outbuilding_defect_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 12, 'Outbuilding',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 9,
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
  '{"phase":9,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 12
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1047','fatal','outbuilding','Indicate whether the structure is a ''Dwelling'' or ''Outbuilding''.','ImprovementType must be provided for every subject improvement.',ARRAY['12.001'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1055','warning','outbuilding','Indicate whether the structure has a permanent heating system.','Required for a real-property outbuilding when LivingUnitCount = 0.',ARRAY['12.008'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1056','fatal','outbuilding','Provide the intended functional design for each outbuilding (e.g., barn, standalone ADU, pool house).','OutbuildingType must be provided for every outbuilding.',ARRAY['12.001'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1057','fatal','outbuilding','Provide a description when ''Outbuilding Type'' = ''Other''.','OutbuildingTypeOtherDescription is required when OutbuildingType = Other.',ARRAY['12.001'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1058','warning','outbuilding','The type of utility(s) that exist in the outbuilding must be included. Select ''None'' if there are no utilities.','At least one UtilityType is required for every real-property outbuilding.',ARRAY['12.010'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1059','fatal','outbuilding','Provide a description when utility type = ''Other''.','UtilityTypeOtherDescription is required when UtilityType = Other.',ARRAY['12.010'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1083','fatal','outbuilding','Provide the ''Gross Building Area'' of the outbuilding.','StructureAreaMeasure is required for every real-property outbuilding.',ARRAY['12.006'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1084','fatal','outbuilding','Provide the number of living units in the structure.','LivingUnitCount is required for every real-property outbuilding.',ARRAY['12.003'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1089','fatal','outbuilding','Provide the heating system type. Select ''None'' if there is no heating system.','HeatingSystemType is required for a real-property outbuilding with LivingUnitCount > 0.',ARRAY['12.014'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1094','fatal','outbuilding','Indicate whether the outbuilding has any defects, damages, or deficiencies.','OutbuildingDefectsExistIndicator is required for every real-property outbuilding.',ARRAY['12.019'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1095','warning','outbuilding','Provide the finished area of the outbuilding, even if the value is 0.','Finished area excluding vehicle storage and ADU area is required for every real-property outbuilding.',ARRAY['12.011'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1096','warning','outbuilding','Provide the unfinished area of the outbuilding, even if the value is 0.','Unfinished area excluding vehicle storage and ADU area is required for every real-property outbuilding.',ARRAY['12.013'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1103','fatal','outbuilding','Indicate whether the manufactured home is attached to a permanent foundation.','Required when OutbuildingType = ManufacturedHome.',ARRAY['12.004'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1692','fatal','outbuilding_defect','Provide at least one defect when the Appraiser identified a defect, damage or deficiency in the outbuilding.','A DEFECT relationship must link at least one defect to each outbuilding with OutbuildingDefectsExistIndicator = true.',ARRAY['12.019','12.020'],'{"phase":9,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-001','fatal','outbuilding_asset','Every outbuilding requires verified exterior/front and interior photos.','Required Section 12 image captions exist for every outbuilding.',ARRAY['12.007.1'],'{"phase":9,"source":"UAD 3.6 Photo and Image Requirements v1.0","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-002','fatal','outbuilding','The number of units in an outbuilding must match its saved Unit Interior records.','LivingUnitCount equals child PROPERTY_UNIT records.',ARRAY['12.003','10.002'],'{"phase":9,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-003','fatal','outbuilding','Only real-property outbuildings may contain reportable unit, room, or defect details.','Non-real-property outbuildings use the abbreviated report path.',ARRAY['12.002'],'{"phase":9,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-004','fatal','outbuilding','Select ''None'' by itself for utilities or heating systems.','None is exclusive in applicable enumerated lists.',ARRAY['12.010','12.014'],'{"phase":9,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-005','fatal','outbuilding_room','Finished outbuilding area requires at least one room summary.','Finished area and ROOM records reconcile.',ARRAY['12.011','12.012'],'{"phase":9,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-006','fatal','outbuilding_defect','The defects indicator must match the saved outbuilding defect records.','Defects indicator and child DEFECT records reconcile.',ARRAY['12.019','12.020'],'{"phase":9,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-007','fatal','outbuilding_defect_asset','Each reported physical outbuilding defect requires a verified photo.','Every outbuilding defect has a verified Section 12 image.',ARRAY['12.020.1'],'{"phase":9,"source":"UAD 3.6 Photo and Image Requirements v1.0","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-OUTBUILDING-008','fatal','outbuilding','A standalone ADU must contain at least one living unit.','OutbuildingType StandaloneADU implies LivingUnitCount > 0.',ARRAY['12.001','12.003'],'{"phase":9,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
