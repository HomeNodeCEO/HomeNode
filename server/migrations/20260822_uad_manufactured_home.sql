ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used',
    'site_parcel', 'site_influence', 'site_view', 'site_encumbrance',
    'site_feature', 'site_utility', 'site_defect',
    'renewable_energy_component', 'green_building_certification',
    'green_efficiency_rating', 'dwelling_exterior_feature',
    'dwelling_noncontinuous_room', 'dwelling_exterior_defect',
    'manufactured_home_skirting_material', 'manufactured_home_modification',
    'manufactured_home_hud_label', 'manufactured_home_financing_program'
  ));

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
[
  {"uid":"0500.0017","rfid":"9.000","context":"manufactured_home","name":"ManufacturedHomeManufacturerName","type":"String","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0011","rfid":"9.001","context":"manufactured_home","name":"ManufacturedHomeInstalledDate","type":"Date","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0041","rfid":"9.001","context":"manufactured_home","name":"ManufacturedHomeInstalledDateEstimatedIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0021","rfid":"9.002","context":"manufactured_home","name":"ManufacturedHomeMovedAfterOriginalInstallationIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0007","rfid":"9.003","context":"manufactured_home","name":"ManufacturedHomeAttachedToFoundationIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0008","rfid":"9.004","context":"manufactured_home","name":"ManufacturedHomeHitchWheelsAxlesRemovedIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0044","rfid":"9.005","context":"manufactured_home","name":"ManufacturedHomeWidthType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["MultiWide","SingleWide"]},
  {"uid":"0500.0030","rfid":"9.006","context":"manufactured_home","name":"SkirtingExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0039","rfid":"9.006","context":"manufactured_home_skirting_material","name":"SkirtingMaterialType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Asbestos","Brick","CementBoard","ConcreteBlock","EngineeredWood","Fiberglass","Log","Metal","Other","PouredConcrete","Vinyl","Wood"]},
  {"uid":"0500.0040","rfid":"9.006","context":"manufactured_home_skirting_material","name":"SkirtingMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0020","rfid":"9.007","context":"manufactured_home","name":"ManufacturedHomeModificationIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0035","rfid":"9.008","context":"manufactured_home_modification","name":"ManufacturedHomeModificationType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["Carport","Deck","Garage","LivingArea","Other","Porch","Sunroom"]},
  {"uid":"0500.0036","rfid":"9.008","context":"manufactured_home_modification","name":"ManufacturedHomeModificationTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0019","rfid":"9.009","context":"manufactured_home","name":"ManufacturedHomeModificationsDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0010","rfid":"9.010","context":"manufactured_home","name":"ManufacturedHomeHUDDataPlateAttachedIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0016","rfid":"9.011","context":"manufactured_home","name":"ManufacturedHomeManufactureDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0027","rfid":"9.012","context":"manufactured_home","name":"ManufacturedHomeSerialNumberIdentifier","type":"String","requirement":"Conditional","cardinality":"0:unbounded","options":null},
  {"uid":"0500.0033","rfid":"9.013","context":"manufactured_home","name":"WindZoneCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["ZoneI","ZoneII","ZoneIII"]},
  {"uid":"0500.0031","rfid":"9.014","context":"manufactured_home","name":"ThermalZoneCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Zone1","Zone2","Zone3"]},
  {"uid":"0500.0028","rfid":"9.015","context":"manufactured_home","name":"RoofLoadZoneCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Middle","North","South"]},
  {"uid":"0500.0009","rfid":"9.016","context":"manufactured_home","name":"ManufacturedHomeHUDCertificateLabelIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0037","rfid":"9.017","context":"manufactured_home_hud_label","name":"ManufacturedHomeHUDCertificationLabelIdentifier","type":"String","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0005","rfid":"9.018","context":"manufactured_home_financing_program","name":"ManufacturedHomeFinancingProgramEligibilityType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["FannieMaeMHAdvantage","FreddieMacCHOICEHome","Other"]},
  {"uid":"0500.0006","rfid":"9.018","context":"manufactured_home_financing_program","name":"ManufacturedHomeFinancingProgramEligibilityTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0004","rfid":"9.019","context":"manufactured_home_financing_program","name":"ManufacturedHomeFinancingProgramEligibilityIdentifier","type":"String","requirement":"Required","cardinality":"1:1","options":null},
  {"uid":"0500.0022","rfid":"9.020","context":"manufactured_home","name":"ManufacturedHomePurchasedFromRetailerIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0025","rfid":"9.021","context":"manufactured_home","name":"ManufacturedHomeRetailerName","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0023","rfid":"9.022","context":"manufactured_home","name":"ManufacturedHomeRetailerInvoiceReviewedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0014","rfid":"9.023","context":"manufactured_home","name":"ManufacturedHomeInvoiceReviewedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0013","rfid":"9.024","context":"manufactured_home","name":"ManufacturedHomeInvoiceReasonableIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0012","rfid":"9.025","context":"manufactured_home","name":"ManufacturedHomeInvoiceNotReasonableDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null},
  {"uid":"0500.0042","rfid":"9.026","context":"manufactured_home","name":"ManufacturedHomeValuationCommentText","type":"String","requirement":"Optional","cardinality":"0:1","options":null}
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
    options jsonb
  )
), asset_catalog(uid, rfid, context, name, type, requirement, cardinality, options) AS (
  VALUES
    ('1400.0638','9.027.1','manufactured_home_asset','ImageCategoryType','Enumerated','Optional','0:unbounded','["ManufacturedHomeExhibit"]'::jsonb),
    ('1400.0640','9.027.2','manufactured_home_asset','ImageCaptionCommentDescription','String','Conditional','0:1',NULL::jsonb),
    ('1400.0644','Does Not Display','manufactured_home_asset','ImageFileLocationIdentifier','String','Conditional','0:1',NULL::jsonb),
    ('1400.0889','Does Not Display','manufactured_home_asset','MIMETypeIdentifier','String','Conditional','0:1',NULL::jsonb),
    ('1400.0975','9.010.1','manufactured_home_asset','ImageCategoryType','Enumerated','Conditional','0:1','["ManufacturedHomeHUDDataPlate"]'::jsonb),
    ('1400.0974','9.010.2','manufactured_home_asset','ImageCaptionCommentDescription','String','Conditional','0:1',NULL::jsonb),
    ('1400.0967','9.017.1','manufactured_home_hud_label_asset','ImageCategoryType','Enumerated','Conditional','0:1','["ManufacturedHomeHUDCertificationLabel"]'::jsonb),
    ('1400.0966','9.017.2','manufactured_home_hud_label_asset','ImageCaptionCommentDescription','String','Conditional','0:1',NULL::jsonb),
    ('1400.0959','9.018.1','manufactured_home_program_asset','ImageCategoryType','Enumerated','Conditional','0:1','["ManufacturedHomeFinancingProgramEligibilityCertification"]'::jsonb),
    ('1400.0958','9.018.2','manufactured_home_program_asset','ImageCaptionCommentDescription','String','Conditional','0:1',NULL::jsonb)
), combined AS (
  SELECT * FROM catalog
  UNION ALL
  SELECT * FROM asset_catalog
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 9, 'Manufactured Home',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 6,
    'entity_type', CASE WHEN context IN (
      'manufactured_home_skirting_material',
      'manufactured_home_modification',
      'manufactured_home_hud_label',
      'manufactured_home_financing_program'
    ) THEN context ELSE NULL END,
    'options', options,
    'source', 'Appendix A-1 URAR Delivery Specification 1.4'
  ))
FROM combined
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
  '{"phase":6,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 9
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1100','warning','manufactured_home_financing_program','Provide the certification program name when its identifier is provided.','identifier implies certification type',ARRAY['9.018','9.019'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1101','warning','manufactured_home_financing_program','Provide the certification identifier when its program name is provided.','certification type implies identifier',ARRAY['9.018','9.019'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1102','fatal','manufactured_home_financing_program','Describe a certification program reported as Other.','Other certification requires description',ARRAY['9.018'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1104','fatal','manufactured_home','Indicate whether the towing hitch, wheels, and axles were removed.','required for each manufactured home',ARRAY['9.004'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1105','fatal','manufactured_home','Indicate whether a HUD certification label is present for every section.','required for each manufactured home',ARRAY['9.016'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1106','fatal','manufactured_home','Indicate whether the HUD data plate is attached.','required for each manufactured home',ARRAY['9.010'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1107','warning','manufactured_home','Provide the manufactured home installation year.','year installed is provided',ARRAY['9.001'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1108','warning','manufactured_home','Indicate whether reviewed invoice content appears reasonable.','reviewed invoice implies reasonableness indicator',ARRAY['9.024'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1109','fatal','manufactured_home','Indicate whether the manufacturer invoice was reviewed for new construction.','new construction implies manufacturer invoice review indicator',ARRAY['9.023'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1110','fatal','manufactured_home','Provide the manufacture date when the HUD data plate is attached.','attached plate implies manufacture date',ARRAY['9.011'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1111','warning','manufactured_home','Check a manufacture date before 1976 for accuracy.','manufacture year is before 1976',ARRAY['9.011'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1113','fatal','manufactured_home','Indicate whether modifications, attachments, or additions altered or rely on the structure.','modification indicator is provided',ARRAY['9.007'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1114','fatal','manufactured_home','Indicate whether the home moved after its original installation.','moved indicator is provided',ARRAY['9.002'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1115','fatal','manufactured_home','Indicate whether a new manufactured home was purchased from a retailer.','new construction implies retailer purchase indicator',ARRAY['9.020'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1116','fatal','manufactured_home','Indicate whether the retailer invoice was reviewed when purchased from a retailer.','retailer purchase implies invoice review indicator',ARRAY['9.022'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1117','warning','manufactured_home','Provide the HUD roof load zone when the data plate is attached.','attached plate implies roof load zone',ARRAY['9.015'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1118','fatal','manufactured_home','Indicate whether skirting exists.','skirting indicator is provided',ARRAY['9.006'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1119','warning','manufactured_home','Provide the HUD thermal zone when the data plate is attached.','attached plate implies thermal zone',ARRAY['9.014'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1120','warning','manufactured_home','Provide the HUD wind zone when the data plate is attached.','attached plate implies wind zone',ARRAY['9.013'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1121','fatal','manufactured_home_modification','Provide each modification, attachment, or addition type.','modification indicator implies at least one typed record',ARRAY['9.008'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1122','fatal','manufactured_home_modification','Describe a modification reported as Other.','Other modification requires description',ARRAY['9.008'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1123','fatal','manufactured_home_skirting_material','Provide at least one skirting material when skirting exists.','skirting implies material record',ARRAY['9.006'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1124','fatal','manufactured_home_skirting_material','Describe skirting material reported as Other.','Other skirting material requires description',ARRAY['9.006'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1125','warning','manufactured_home','Indicate whether the installation year was estimated.','installed date estimate indicator is provided',ARRAY['9.001'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1126','fatal','manufactured_home','Provide the manufactured home width.','width type is provided',ARRAY['9.005'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1284','fatal','manufactured_home_hud_label_asset','Provide an image of every HUD certification label.','label record has verified image',ARRAY['9.017.1'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1285','fatal','manufactured_home_asset','Provide an image of the HUD data plate when attached.','attached plate has verified image',ARRAY['9.010.1'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1721','fatal','manufactured_home','The manufacture date must use year, month, and day.','date uses YYYY-MM-DD',ARRAY['9.011'],'{"phase":6,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-001','fatal','manufactured_home','Section 9 applies only to dwellings whose Construction Method is Manufactured.','each Section 9 record belongs to a manufactured dwelling',ARRAY['8.011','9.000'],'{"phase":6,"source":"Appendix B-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-002','fatal','manufactured_home_skirting_material','Skirting material records must agree with the skirting indicator.','indicator equals existence of material records',ARRAY['9.006'],'{"phase":6,"implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-003','fatal','manufactured_home_modification','Modification records must agree with the modification indicator.','indicator equals existence of modification records',ARRAY['9.007','9.008'],'{"phase":6,"implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-004','fatal','manufactured_home_hud_label_asset','Each recorded HUD certification label requires a verified image.','each label record has verified linked image',ARRAY['9.017','9.017.1'],'{"phase":6,"implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-005','fatal','manufactured_home_program_asset','Each financing-program record requires its certification image.','each program record has verified linked image',ARRAY['9.018','9.018.1'],'{"phase":6,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-MH-006','fatal','manufactured_home','The Date of Manufacture year must match Dwelling Exterior Year Built.','manufacture year equals structure built year',ARRAY['8.010','9.011'],'{"phase":6,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
