-- URAR Section 22B: Sales Comparison Approach project information.
-- This additive migration extends the isolated UAD schemas only. Comparable
-- project records remain children of the canonical Section 22 comparable.

ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used', 'site_parcel',
    'site_influence', 'site_view', 'site_encumbrance', 'site_feature',
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
    'sales_comparable_right_not_included', 'sales_comparable_project_amenity'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0383","rfid":"Does Not Display","context":"sales_comparable_project","name":"PUDIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0378","rfid":"Does Not Display","context":"sales_comparable_project","name":"PropertyInProjectIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0377","rfid":"Does Not Display","context":"sales_comparable_project","name":"ProjectLegalStructureType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Condominium","Condop","Cooperative"],"maxLength":null,"format":null},
    {"uid":"1800.0194","rfid":"22.02.06","context":"sales_comparable_project","name":"ProjectName","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0083","rfid":"22.02.06","context":"sales_comparable_project","name":"SameProjectAsSubjectIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0353","rfid":"22.02.07","context":"sales_comparable_project","name":"AssociationChargeAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0352","rfid":"Does Not Display","context":"sales_comparable_project_dues_xml","name":"AssociationChargeType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssociationDues"],"maxLength":null,"format":null},
    {"uid":"1800.0354","rfid":"Does Not Display","context":"sales_comparable_project_dues_xml","name":"AssociationChargePeriodType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Monthly"],"maxLength":null,"format":null},
    {"uid":"1800.0371","rfid":"22.02.09","context":"sales_comparable_project","name":"AssociationSpecialAssessmentStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Existing","None","Proposed"],"maxLength":null,"format":null},
    {"uid":"1800.0355","rfid":"Does Not Display","context":"sales_comparable_project_assessment_xml","name":"AssociationChargeType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssociationSpecialAssessment"],"maxLength":null,"format":null},
    {"uid":"1800.0056","rfid":"22.02.08","context":"sales_comparable_project_amenity","name":"AmenityType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Airstrip","Beach","BoatRamp","BoatSlip","BuildingMaintenance","BuiltInPool","BusinessCenter","CaregiverServices","Clubhouse","ClubMembership","CommunityPier","ConciergeServiceCoordination","Cooling","Deck","DoorAttendant","ElectricVehicleChargingStation","Elevator","FitnessArea","GatedCommunity","GroundsMaintenance","Heating","IngroundPool","IngroundSpa","Lobby","None","OngoingCleaningServices","Other","OutdoorRidingRing","OutdoorShower","Patio","Playground","RecreationArea","RegistrationServices","Sauna","SharedLaundryFacilities","ShortTermRentalServices","SportsCourt","TelevisionOrInternetServices","TrashRemoval","UnitStorage","WaterAccess","WaterFrontage"],"maxLength":null,"format":null},
    {"uid":"1800.0057","rfid":"22.02.08","context":"sales_comparable_project_amenity","name":"AmenityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0317","rfid":"22.02.05","context":"sales_comparable_adjustment_project","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_project","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["ProjectInformation"],"maxLength":null,"format":null}
  ]
  $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 20, 'subphase', '22B-project-information', 'options', options,
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

INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT field.release_key, field.uid, field.property_context, option.value,
       regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
       option.ordinality,
       '{"phase":20,"subphase":"22B-project-information","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' = '22B-project-information'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label, location_role) AS (
  VALUES
    ('2500.0065','project_information','22.02.01','Subject Project Name','redisplay'),
    ('2500.0007','project_association_dues','22.02.02','Subject Monthly Fee','redisplay'),
    ('2500.0004','project_amenity','22.02.03','Subject Common Amenity or Service','redisplay'),
    ('2500.0005','project_amenity','22.02.03','Subject Other Common Amenity or Service','redisplay'),
    ('2500.0163','project_special_assessment','22.02.04','Subject Special Assessment Status','redisplay'),
    ('1800.0317','sales_comparable_adjustment_project','22.02.05','Project Information Adjustment','primary'),
    ('1800.0194','sales_comparable_project','22.02.06','Comparable Project Name','primary'),
    ('1800.0083','sales_comparable_project','22.02.06','Same Project as Subject','primary'),
    ('1800.0353','sales_comparable_project','22.02.07','Comparable Monthly Fee','primary'),
    ('1800.0056','sales_comparable_project_amenity','22.02.08','Comparable Common Amenity or Service','primary'),
    ('1800.0057','sales_comparable_project_amenity','22.02.08','Comparable Other Common Amenity or Service','primary'),
    ('1800.0371','sales_comparable_project','22.02.09','Comparable Special Assessment Status','primary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 20, 'subphase', '22B-project-information',
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
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-PROJECT-001','fatal','sales_comparable_project','Comparable PUD and project classifications are mutually exclusive.','PUDIndicator and PropertyInProjectIndicator cannot both be true.',ARRAY['Does Not Display'],'{"phase":20,"source":"Appendix A-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-PROJECT-002','fatal','sales_comparable_project','Project identity is conditional on the comparable and subject project classifications.','Legal structure and project name require PropertyInProjectIndicator; SameProjectAsSubjectIndicator requires both properties in a project.',ARRAY['22.02.01','22.02.06'],'{"phase":20,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-PROJECT-003','fatal','sales_comparable_project_amenity','Project or PUD comparables require a parent-linked common amenity or service; selections must be unique and None is exclusive.','Validate comparable ownership, presence, uniqueness, and the None enumeration.',ARRAY['22.02.08'],'{"phase":20,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-PROJECT-004','fatal','sales_comparable_project','Project financial fields and adjustments require a project or PUD comparable.','Monthly fees, special assessment status, amenities, and project adjustment must agree with comparable classification.',ARRAY['22.02.05','22.02.07','22.02.08','22.02.09'],'{"phase":20,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
