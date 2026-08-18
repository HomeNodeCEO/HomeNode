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
    'vehicle_storage_defect',
    'amenity_defect'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
[
  {"uid":"0200.0015","rfid":"14.000","context":"subject_property_amenities","name":"PropertyAmenityExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},

  {"uid":"0200.0016","rfid":"14.001","context":"amenity_outdoor_accessories","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["OutdoorAccessories"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0007","rfid":"14.002 / 14.006","context":"amenity_outdoor_accessories","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Fence","IrrigationSystem","OutdoorFireplace","OutdoorKitchen","OutdoorRidingRing","SportsCourt"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0005","rfid":"14.003","context":"amenity_outdoor_accessories","name":"AmenityMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Composite","Concrete","Fiberglass","Metal","NaturalStone","Other","Pavers","Vinyl","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0006","rfid":"14.003","context":"amenity_outdoor_accessories","name":"AmenityMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0054","rfid":"14.004","context":"amenity_outdoor_accessories","name":"AmenityAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":999999,"units":["SquareFeet"]},
  {"uid":"0200.0004","rfid":"14.004","context":"amenity_outdoor_accessories","name":"AmenityCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":1,"maximum":99,"units":null},

  {"uid":"0200.0017","rfid":"14.001","context":"amenity_outdoor_living","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["OutdoorLiving"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0023","rfid":"14.002 / 14.006","context":"amenity_outdoor_living","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Balcony","Deck","Gazebo","Patio","Porch","Portico"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0021","rfid":"14.003","context":"amenity_outdoor_living","name":"AmenityMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Composite","Concrete","Fiberglass","Metal","NaturalStone","Other","Pavers","Vinyl","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0022","rfid":"14.003","context":"amenity_outdoor_living","name":"AmenityMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0025","rfid":"14.004","context":"amenity_outdoor_living","name":"AmenityAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":999999,"units":["SquareFeet"]},
  {"uid":"0200.0019","rfid":"14.004","context":"amenity_outdoor_living","name":"AmenityAttachedToManufacturedHomeIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},

  {"uid":"0200.0027","rfid":"14.001","context":"amenity_water_features","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["WaterFeatures"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0032","rfid":"14.002 / 14.006","context":"amenity_water_features","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["IngroundPool","IngroundSpa","OutdoorShower","Sauna"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0030","rfid":"14.003","context":"amenity_water_features","name":"AmenityMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Composite","Concrete","Fiberglass","Metal","NaturalStone","Other","Pavers","Vinyl","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0031","rfid":"14.003","context":"amenity_water_features","name":"AmenityMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0056","rfid":"14.004","context":"amenity_water_features","name":"AmenityAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":999999,"units":["SquareFeet"]},
  {"uid":"0200.0029","rfid":"14.004","context":"amenity_water_features","name":"AmenityCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":1,"maximum":99,"units":null},
  {"uid":"0200.0012","rfid":"14.004","context":"amenity_water_features","name":"SwimmingPoolFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"0:8","options":["Caged","Heated","Indoor","Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0013","rfid":"14.004","context":"amenity_water_features","name":"SwimmingPoolFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},

  {"uid":"0200.0034","rfid":"14.001","context":"amenity_whole_home","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["WholeHome"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0039","rfid":"14.002 / 14.006","context":"amenity_whole_home","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["ElectricVehicleChargingStation","Elevator","FireSuppressionSystem","IndoorFireplace","MultipleZoneHeatingVentilationAndAirConditioning","SmartHomeSystem","WholeHouseVentilation","WoodStove"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0037","rfid":"14.003","context":"amenity_whole_home","name":"AmenityMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Composite","Concrete","Fiberglass","Metal","NaturalStone","Other","Pavers","Vinyl","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0038","rfid":"14.003","context":"amenity_whole_home","name":"AmenityMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0058","rfid":"14.004","context":"amenity_whole_home","name":"AmenityAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":999999,"units":["SquareFeet"]},
  {"uid":"0200.0036","rfid":"14.004","context":"amenity_whole_home","name":"AmenityCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":1,"maximum":99,"units":null},

  {"uid":"0200.0041","rfid":"14.001","context":"amenity_miscellaneous","name":"AmenityCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Miscellaneous"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0046","rfid":"14.002 / 14.006","context":"amenity_miscellaneous","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Airstrip","ClubMembership","Other","SharedLaundryFacilities"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0047","rfid":"14.002 / 14.006","context":"amenity_miscellaneous","name":"AmenityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0044","rfid":"14.003","context":"amenity_miscellaneous","name":"AmenityMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Asphalt","Brick","Composite","Concrete","Fiberglass","Metal","NaturalStone","Other","Pavers","Vinyl","Wood"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0045","rfid":"14.003","context":"amenity_miscellaneous","name":"AmenityMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0060","rfid":"14.004","context":"amenity_miscellaneous","name":"AmenityAreaMeasure","type":"Measurement","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":0,"maximum":999999,"units":["SquareFeet"]},
  {"uid":"0200.0043","rfid":"14.004","context":"amenity_miscellaneous","name":"AmenityCount","type":"Integer","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":1,"maximum":99,"units":null},

  {"uid":"0200.0053","rfid":"14.005","context":"subject_property_amenities","name":"SubjectPropertyAmenitiesDefectsExistIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0141","rfid":"Does Not Display","context":"subject_property_amenity_defect","name":"DefectItemLocationType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Other"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0161","rfid":"14.007","context":"subject_property_amenity_defect","name":"DefectItemLocationTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":31,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0139","rfid":"14.008","context":"subject_property_amenity_defect","name":"DefectItemDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":520,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0138","rfid":"14.009","context":"subject_property_amenity_defect","name":"DefectItemAffectsSoundnessStructuralIntegrityIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"3900.0142","rfid":"14.010","context":"subject_property_amenity_defect","name":"DefectItemRecommendedActionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Completion","Inspection","None","Repair"],"maxLength":null,"minimum":null,"maximum":null,"units":null},
  {"uid":"0200.0063","rfid":"14.011","context":"subject_property_amenities_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000,"minimum":null,"maximum":null,"units":null},

  {"uid":"1400.0640","rfid":"14.012.2","context":"subject_property_amenities_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0744","rfid":"14.002.2","context":"amenity_outdoor_accessories_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0750","rfid":"14.002.2","context":"amenity_outdoor_living_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0756","rfid":"14.002.2","context":"amenity_water_features_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0762","rfid":"14.002.2","context":"amenity_whole_home_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0768","rfid":"14.002.2","context":"amenity_miscellaneous_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null},
  {"uid":"1400.0936","rfid":"14.006.2","context":"subject_property_amenity_defect_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"minimum":null,"maximum":null,"units":null}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 14, 'Subject Property Amenities',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 11,
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
  '{"phase":11,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 14
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1045','fatal','subject_property_amenities','Indicate whether the property has any amenities.','PropertyAmenityExistsIndicator is required.',ARRAY['14.000'],'{"phase":11,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1046','fatal','subject_property_amenities','Indicate whether the subject property amenities have any defects, damages, or deficiencies.','SubjectPropertyAmenitiesDefectsExistIndicator is required when PropertyAmenityExistsIndicator is true.',ARRAY['14.005'],'{"phase":11,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1685','fatal','subject_property_amenity_defect','Provide at least one defect when the Appraiser identified a defect, damage or deficiency with one or more amenities.','Every DEFECT is linked to its AMENITY using the required MISMO relationship.',ARRAY['14.005','14.006'],'{"phase":11,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1739','fatal','subject_property_amenities_asset','Provide the file name and location of the amenity image within the submission ZIP file.','Every delivered amenity IMAGE includes ImageFileLocationIdentifier.',ARRAY['14.002.1','14.006.1'],'{"phase":11,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-001','fatal','subject_property_amenities','Property Amenities Exist must reconcile to the saved amenity records.','At least one AMENITY is required for Yes; no AMENITY may exist for No.',ARRAY['14.000','14.001','14.002'],'{"phase":11,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-002','fatal','amenity','Amenity records must remain within the category-specific UAD cardinalities.','Outdoor Accessories and Outdoor Living allow six each, Water Features four, Whole Home eight, and Miscellaneous eight.',ARRAY['14.001','14.002'],'{"phase":11,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-003','fatal','amenity','Every amenity must use the category and amenity type from the same official UAD category.','AmenityCategoryType is reconciled to category-specific AmenityType enumerations.',ARRAY['14.001','14.002'],'{"phase":11,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-004','fatal','amenity','Provide required material, area, count, and manufactured-home attachment details for the selected amenity.','Conditional Detail fields follow Appendix A-1 and Appendix F-1.',ARRAY['14.003','14.004'],'{"phase":11,"source":"Appendix F-1 v1.4","implementation":"server_conditional"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-005','fatal','subject_property_amenity_defect','The amenities defects indicator must match the saved linked defect records.','SubjectPropertyAmenitiesDefectsExistIndicator reconciles to child DEFECT records.',ARRAY['14.005','14.006'],'{"phase":11,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-006','fatal','subject_property_amenity_defect','Every amenity defect must identify its parent amenity record.','Each DEFECT relationship points to an AMENITY in the workfile.',ARRAY['14.006'],'{"phase":11,"source":"Appendix A-1 v1.4","implementation":"server_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-007','fatal','subject_property_amenity_defect_asset','Each reported physical amenity defect requires a verified photo.','Every amenity defect has a verified Section 14 image.',ARRAY['14.006.1'],'{"phase":11,"source":"Appendix F-1 v1.4","implementation":"server_asset"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-AMENITIES-008','fatal','subject_property_amenities_asset','Section 14 images must remain within UAD cardinality limits.','Each amenity allows two images and each defect allows four images.',ARRAY['14.002.1','14.006.1'],'{"phase":11,"source":"Appendix A-1 v1.4","implementation":"server_asset"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
