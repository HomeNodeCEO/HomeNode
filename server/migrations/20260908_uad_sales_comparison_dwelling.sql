-- URAR Section 22E: Dwelling(s).
-- Additive UAD-only migration. Comparable dwellings and their repeatable
-- systems remain isolated from Custom Appraisal and Property Tax Protest data.

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
    'sales_comparable_functional_issue', 'sales_comparable_disaster_mitigation'
  ));

-- Subject aggregate facts are calculated from canonical Dwelling Exterior and
-- Unit Interior records. They are reference entries for Section 22 redisplay,
-- not a second editable copy of the subject data.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0184","rfid":"22.05.04","context":"sales_comparison_subject_dwelling_summary","name":"TotalFinishedAreaOfAllLivingUnitsIncludingADUAreaMeasure","type":"Numeric","options":["SquareFeet"],"format":"+6.0"},
    {"uid":"1800.0350","rfid":"22.05.12","context":"sales_comparison_subject_dwelling_summary","name":"TotalOfAllDwellingsVolumeMeasure","type":"Numeric","options":["CubicFeet"],"format":"+6.0"},
    {"uid":"1800.0343","rfid":"22.05.13","context":"sales_comparison_subject_dwelling_summary","name":"TotalWindowSurfaceAreaOfAllDwellingsAreaMeasure","type":"Numeric","options":["SquareFeet"],"format":"+6.0"}
  ] $catalog$::jsonb) AS row(uid text, rfid text, context text, name text, type text, options jsonb, format text)
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, 'Conditional', '0:1',
       jsonb_build_object(
         'phase', 22, 'subphase', '22E-subject-summary', 'options', options,
         'format', format, 'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       )
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

-- Comparable details preserve a property -> dwelling -> system hierarchy.
-- Construction, heating, and cooling records repeat beneath their dwelling;
-- property-wide functional/disaster facts repeat beneath the comparable.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0368","rfid":"Does Not Display","context":"sales_comparable_dwelling","name":"LivingUnitCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0128","rfid":"22.05.21","context":"sales_comparable_dwelling","name":"PropertyStructureBuiltYear","type":"Date","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"YYYY"},
    {"uid":"1800.0129","rfid":"22.05.21","context":"sales_comparable_dwelling","name":"PropertyStructureBuiltYearEstimatedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0169","rfid":"22.05.23","context":"sales_comparable_dwelling","name":"StructuralDesignType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Highrise","Lowrise","Midrise","Other","RowhouseTownhouse","SemiDetached"],"maxLength":null,"format":null},
    {"uid":"1800.0170","rfid":"22.05.23","context":"sales_comparable_dwelling","name":"StructuralDesignTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0373","rfid":"22.05.27","context":"sales_comparable_dwelling","name":"StructureNonContinuousFinishedAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0182","rfid":"22.05.29","context":"sales_comparable_dwelling","name":"RowhouseTownhouseEndUnitIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0188","rfid":"22.05.31","context":"sales_comparable_dwelling","name":"RowhouseTownhouseBackToBackIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0382","rfid":"22.05.33","context":"sales_comparable_dwelling","name":"RowhouseTownhouseStackedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0187","rfid":"22.05.33","context":"sales_comparable_dwelling","name":"RowhouseTownhouseLocationType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["BottomUnit","MiddleUnit","TopUnit"],"maxLength":null,"format":null},
    {"uid":"1800.0167","rfid":"22.05.39","context":"sales_comparable_dwelling","name":"ArchitecturalDesignCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["AFrame","Barn","BiLevel","Bungalow","CapeCod","Chalet","Colonial","Contemporary","Cottage","Craftsman","EarthBerm","Farmhouse","GeodesicDome","Georgian","Log","Mediterranean","Modern","NeoEclectic","Other","RaisedRanch","Rambler","Ranch","Southwest","Spanish","SplitFoyerOrEntry","SplitLevel","Stilt","Traditional","Tudor","Victorian"],"maxLength":null,"format":null},
    {"uid":"1800.0168","rfid":"22.05.39","context":"sales_comparable_dwelling","name":"ArchitecturalDesignCategoryTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0123","rfid":"22.05.51","context":"sales_comparable_dwelling","name":"CoolingSystemExistsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0171","rfid":"22.05.35","context":"sales_comparable_construction_method","name":"ConstructionMethodType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Container","Manufactured","Modular","OnFrameModular","Other","SiteBuilt","ThreeDimensionalPrintingTechnology"],"maxLength":null,"format":null},
    {"uid":"1800.0172","rfid":"22.05.35","context":"sales_comparable_construction_method","name":"ConstructionMethodTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0379","rfid":"22.05.37","context":"sales_comparable_manufactured_home","name":"ManufacturedHomeWidthType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["MultiWide","SingleWide"],"maxLength":null,"format":null},
    {"uid":"1800.0165","rfid":"22.05.49","context":"sales_comparable_heating_system","name":"HeatingSystemType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Baseboard","Fireplace","ForcedWarmAir","GravityAir","MiniSplit","None","Other","PassiveSolar","Radiant","Radiators","Stove"],"maxLength":null,"format":null},
    {"uid":"1800.0166","rfid":"22.05.49","context":"sales_comparable_heating_system","name":"HeatingSystemTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":19,"format":"19"},
    {"uid":"1800.0163","rfid":"22.05.49","context":"sales_comparable_heating_system","name":"HeatingFuelType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Coal","Electric","Geothermal","NaturalGas","Oil","Other","Propane","Solar","Wood"],"maxLength":null,"format":null},
    {"uid":"1800.0164","rfid":"22.05.49","context":"sales_comparable_heating_system","name":"HeatingFuelTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":31,"format":"31"},
    {"uid":"1800.0161","rfid":"22.05.51","context":"sales_comparable_cooling_system","name":"CoolingSystemType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Centralized","Individual","Other"],"maxLength":null,"format":null},
    {"uid":"1800.0162","rfid":"22.05.51","context":"sales_comparable_cooling_system","name":"CoolingSystemTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":19,"format":"19"},
    {"uid":"1800.0121","rfid":"22.05.45","context":"sales_comparable_functional_issue","name":"FunctionalIssueType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["CeilingHeight","FloorPlan","NonConformity","None","Other","Overimprovement","Underimprovement"],"maxLength":null,"format":null},
    {"uid":"1800.0122","rfid":"22.05.45","context":"sales_comparable_functional_issue","name":"FunctionalIssueTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0104","rfid":"22.05.47","context":"sales_comparable_disaster_mitigation","name":"DisasterMitigationFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["EnclosedSoffits","FireResistantDecking","FireResistantExteriorWalls","FloodVents","FortifiedRoof","FramingAnchorageOrBracing","ImpactResistantGlass","ImpactResistantShingles","NoncombustiblePerimeter","None","Other","StormShelter","StormShutters","WaterHeaterStrapping"],"maxLength":null,"format":null},
    {"uid":"1800.0105","rfid":"22.05.47","context":"sales_comparable_disaster_mitigation","name":"DisasterMitigationFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0345","rfid":"22.05.25","context":"sales_comparable_dwelling_summary","name":"TotalFinishedAreaOfAllLivingUnitsIncludingADUAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0280","rfid":"22.05.41","context":"sales_comparable_dwelling_summary","name":"TotalOfAllDwellingsVolumeMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["CubicFeet"],"maxLength":null,"format":"+6.0"},
    {"uid":"1800.0281","rfid":"22.05.43","context":"sales_comparable_dwelling_summary","name":"TotalWindowSurfaceAreaOfAllDwellingsAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["SquareFeet"],"maxLength":null,"format":"+6.0"}
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
         'phase', 22, 'subphase', '22E-dwellings', 'options', options,
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

-- One typed adjustment context per official Dwelling(s) adjustment row.
WITH adjustment(context, rfid, adjustment_type) AS (
  VALUES
    ('sales_comparable_adjustment_year_built','22.05.22','YearBuilt'),
    ('sales_comparable_adjustment_structure_design','22.05.24','StructureDesign'),
    ('sales_comparable_adjustment_gross_finished_area','22.05.26','GrossBuildingFinishedArea'),
    ('sales_comparable_adjustment_noncontinuous_area','22.05.28','NonContinuousFinishedArea'),
    ('sales_comparable_adjustment_townhouse_end','22.05.30','RowhouseTownhouseEndUnit'),
    ('sales_comparable_adjustment_townhouse_back','22.05.32','RowhouseTownhouseBackToBack'),
    ('sales_comparable_adjustment_townhouse_location','22.05.34','RowhouseTownhouseLocation'),
    ('sales_comparable_adjustment_construction_method','22.05.36','ConstructionMethod'),
    ('sales_comparable_adjustment_manufactured_width','22.05.38','ManufacturedHomeWidth'),
    ('sales_comparable_adjustment_dwelling_style','22.05.40','DwellingStyle'),
    ('sales_comparable_adjustment_dwelling_volume','22.05.42','TotalDwellingVolume'),
    ('sales_comparable_adjustment_window_area','22.05.44','WindowSurfaceArea'),
    ('sales_comparable_adjustment_functional_issues','22.05.46','FunctionalIssues'),
    ('sales_comparable_adjustment_disaster_mitigation','22.05.48','DisasterMitigationFeatures'),
    ('sales_comparable_adjustment_heating','22.05.50','HeatingSystem'),
    ('sales_comparable_adjustment_cooling','22.05.52','CoolingSystem')
), catalog AS (
  SELECT context, rfid, '1800.0317'::text AS uid, 'ComparableAdjustmentAmount'::text AS name,
         'Amount'::text AS type, '0:1'::text AS cardinality, NULL::jsonb AS options, '±9.0'::text AS format
    FROM adjustment
  UNION ALL
  SELECT context, 'Does Not Display', '1800.0318', 'ComparableAdjustmentType',
         'Enumerated', '1:1', jsonb_build_array(adjustment_type), NULL
    FROM adjustment
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, 'Conditional', cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22E-dwelling-adjustments', 'options', options,
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
       '{"phase":22,"subphase":"22E-dwellings","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22E-subject-summary', '22E-dwellings', '22E-dwelling-adjustments')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label, location_role) AS (
  VALUES
    ('0300.0011','dwelling','22.05.02','Subject Year Built','redisplay'),
    ('0300.0012','dwelling','22.05.02','Subject Year Built Estimated','redisplay'),
    ('0300.0032','dwelling','22.05.03','Subject Structure Design','redisplay'),
    ('0300.0033','dwelling','22.05.03','Subject Other Structure Design','redisplay'),
    ('1800.0184','sales_comparison_subject_dwelling_summary','22.05.04','Subject Gross Building Finished Area','redisplay'),
    ('0300.0115','dwelling','22.05.05','Subject Noncontinuous Finished Area','redisplay'),
    ('0300.0059','dwelling','22.05.06','Subject Townhouse End Unit','redisplay'),
    ('0300.0070','dwelling','22.05.07','Subject Townhouse Back to Back','redisplay'),
    ('0300.0069','dwelling','22.05.08','Subject Units Above or Below','redisplay'),
    ('0300.0067','dwelling','22.05.08','Subject Townhouse Location','redisplay'),
    ('0300.0034','dwelling','22.05.09','Subject Construction Method','redisplay'),
    ('0300.0035','dwelling','22.05.09','Subject Other Construction Method','redisplay'),
    ('0500.0044','manufactured_home','22.05.10','Subject Manufactured Home Width','redisplay'),
    ('0300.0030','dwelling','22.05.11','Subject Dwelling Style','redisplay'),
    ('0300.0031','dwelling','22.05.11','Subject Other Dwelling Style','redisplay'),
    ('1800.0350','sales_comparison_subject_dwelling_summary','22.05.12','Subject Total Dwelling Volume','redisplay'),
    ('1800.0343','sales_comparison_subject_dwelling_summary','22.05.13','Subject Window Surface Area','redisplay'),
    ('3600.0002','functional_obsolescence','22.05.14','Subject Functional Issues','redisplay'),
    ('3600.0003','functional_obsolescence','22.05.14','Subject Other Functional Issue','redisplay'),
    ('3700.0002','disaster_mitigation','22.05.15','Subject Disaster Mitigation','redisplay'),
    ('3700.0003','disaster_mitigation','22.05.15','Subject Other Disaster Mitigation','redisplay'),
    ('0300.0088','dwelling','22.05.16','Subject Heating System','redisplay'),
    ('0300.0089','dwelling','22.05.16','Subject Other Heating System','redisplay'),
    ('0300.0086','dwelling','22.05.16','Subject Heating Fuel','redisplay'),
    ('0300.0087','dwelling','22.05.16','Subject Other Heating Fuel','redisplay'),
    ('0300.0022','dwelling','22.05.17','Subject Cooling Exists','redisplay'),
    ('0300.0084','dwelling','22.05.17','Subject Cooling System','redisplay'),
    ('0300.0085','dwelling','22.05.17','Subject Other Cooling System','redisplay'),
    ('1800.0128','sales_comparable_dwelling','22.05.21','Comparable Year Built','primary'),
    ('1800.0129','sales_comparable_dwelling','22.05.21','Comparable Year Built Estimated','primary'),
    ('1800.0169','sales_comparable_dwelling','22.05.23','Comparable Structure Design','primary'),
    ('1800.0170','sales_comparable_dwelling','22.05.23','Comparable Other Structure Design','primary'),
    ('1800.0345','sales_comparable_dwelling_summary','22.05.25','Comparable Gross Building Finished Area','primary'),
    ('1800.0373','sales_comparable_dwelling','22.05.27','Comparable Noncontinuous Finished Area','primary'),
    ('1800.0182','sales_comparable_dwelling','22.05.29','Comparable Townhouse End Unit','primary'),
    ('1800.0188','sales_comparable_dwelling','22.05.31','Comparable Townhouse Back to Back','primary'),
    ('1800.0382','sales_comparable_dwelling','22.05.33','Comparable Units Above or Below','primary'),
    ('1800.0187','sales_comparable_dwelling','22.05.33','Comparable Townhouse Location','primary'),
    ('1800.0171','sales_comparable_construction_method','22.05.35','Comparable Construction Method','primary'),
    ('1800.0172','sales_comparable_construction_method','22.05.35','Comparable Other Construction Method','primary'),
    ('1800.0379','sales_comparable_manufactured_home','22.05.37','Comparable Manufactured Home Width','primary'),
    ('1800.0167','sales_comparable_dwelling','22.05.39','Comparable Dwelling Style','primary'),
    ('1800.0168','sales_comparable_dwelling','22.05.39','Comparable Other Dwelling Style','primary'),
    ('1800.0280','sales_comparable_dwelling_summary','22.05.41','Comparable Total Dwelling Volume','primary'),
    ('1800.0281','sales_comparable_dwelling_summary','22.05.43','Comparable Window Surface Area','primary'),
    ('1800.0121','sales_comparable_functional_issue','22.05.45','Comparable Functional Issues','primary'),
    ('1800.0122','sales_comparable_functional_issue','22.05.45','Comparable Other Functional Issue','primary'),
    ('1800.0104','sales_comparable_disaster_mitigation','22.05.47','Comparable Disaster Mitigation','primary'),
    ('1800.0105','sales_comparable_disaster_mitigation','22.05.47','Comparable Other Disaster Mitigation','primary'),
    ('1800.0165','sales_comparable_heating_system','22.05.49','Comparable Heating System','primary'),
    ('1800.0166','sales_comparable_heating_system','22.05.49','Comparable Other Heating System','primary'),
    ('1800.0163','sales_comparable_heating_system','22.05.49','Comparable Heating Fuel','primary'),
    ('1800.0164','sales_comparable_heating_system','22.05.49','Comparable Other Heating Fuel','primary'),
    ('1800.0123','sales_comparable_dwelling','22.05.51','Comparable Cooling Exists','primary'),
    ('1800.0161','sales_comparable_cooling_system','22.05.51','Comparable Cooling System','primary'),
    ('1800.0162','sales_comparable_cooling_system','22.05.51','Comparable Other Cooling System','primary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22E-dwellings',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH adjustment(context, rfid, label) AS (
  VALUES
    ('sales_comparable_adjustment_year_built','22.05.22','Year Built Adjustment'),
    ('sales_comparable_adjustment_structure_design','22.05.24','Structure Design Adjustment'),
    ('sales_comparable_adjustment_gross_finished_area','22.05.26','Gross Building Finished Area Adjustment'),
    ('sales_comparable_adjustment_noncontinuous_area','22.05.28','Noncontinuous Finished Area Adjustment'),
    ('sales_comparable_adjustment_townhouse_end','22.05.30','Townhouse End Unit Adjustment'),
    ('sales_comparable_adjustment_townhouse_back','22.05.32','Townhouse Back to Back Adjustment'),
    ('sales_comparable_adjustment_townhouse_location','22.05.34','Townhouse Location Adjustment'),
    ('sales_comparable_adjustment_construction_method','22.05.36','Construction Method Adjustment'),
    ('sales_comparable_adjustment_manufactured_width','22.05.38','Manufactured Home Width Adjustment'),
    ('sales_comparable_adjustment_dwelling_style','22.05.40','Dwelling Style Adjustment'),
    ('sales_comparable_adjustment_dwelling_volume','22.05.42','Total Dwelling Volume Adjustment'),
    ('sales_comparable_adjustment_window_area','22.05.44','Window Surface Area Adjustment'),
    ('sales_comparable_adjustment_functional_issues','22.05.46','Functional Issues Adjustment'),
    ('sales_comparable_adjustment_disaster_mitigation','22.05.48','Disaster Mitigation Adjustment'),
    ('sales_comparable_adjustment_heating','22.05.50','Heating Adjustment'),
    ('sales_comparable_adjustment_cooling','22.05.52','Cooling Adjustment')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', '1800.0317', context, rfid,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22E-dwelling-adjustments',
         'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
       )
FROM adjustment
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1097','fatal','dwelling','Indicate whether the dwelling has any non-continuous finished area.','NonContinuousFinishedAreaIndicator is required for a one-unit subject dwelling.',ARRAY['22.05.05'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1416','fatal','sales_comparable_dwelling','Provide the calendar year in which construction of the structure was completed.','PropertyStructureBuiltYear is required for every sales-comparable dwelling.',ARRAY['22.05.21'],'{"phase":22,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1418','warning','sales_comparable_dwelling','The Year Built is prior to 1800. Please check for accuracy.','PropertyStructureBuiltYear less than 1800 triggers an accuracy warning.',ARRAY['22.05.21'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1421','fatal','sales_comparable_heating_system','Provide the heating system type. Select None if there is no heating system.','At least one HeatingSystemType is required for every sales-comparable dwelling.',ARRAY['22.05.49'],'{"phase":22,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1422','fatal','sales_comparable_heating_system','Provide a description when heating system type is Other.','HeatingSystemTypeOtherDescription is required when HeatingSystemType is Other.',ARRAY['22.05.49'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1423','fatal','sales_comparable_dwelling','Provide Structural Design.','StructuralDesignType is required for an attached sales-comparable dwelling.',ARRAY['22.05.23'],'{"phase":22,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1424','fatal','sales_comparable_dwelling','Provide a description when Structure Design is Other.','StructuralDesignTypeOtherDescription is required when StructuralDesignType is Other.',ARRAY['22.05.23'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1425','fatal','sales_comparison_subject_dwelling_summary','Provide the Gross Building Finished Area.','Subject GBFA is required when the Sales Comparison Approach is developed and the subject has more than one non-ADU unit.',ARRAY['22.05.04'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1467','fatal','sales_comparable_dwelling_summary','Provide the Gross Building Finished Area.','Comparable GBFA is required when the corresponding multiunit subject row displays.',ARRAY['22.05.25'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1774','fatal','sales_comparable_construction_method','Provide Construction Method for each dwelling of the sales comparable.','A ConstructionMethodType is required for detached dwellings and applicable attached dwelling designs.',ARRAY['22.05.35'],'{"phase":22,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1775','fatal','sales_comparable_manufactured_home','Provide the Manufactured Home Width for the sales comparable.','ManufacturedHomeWidthType is required for every Manufactured construction-method record.',ARRAY['22.05.37'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-001','fatal','sales_comparable_dwelling','Comparable dwelling records must retain their parent relationships.','Every dwelling belongs to a sales comparable; construction, heating, and cooling records belong to a dwelling.',ARRAY['22.05.21','22.05.35','22.05.49','22.05.51'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-002','fatal','sales_comparable_dwelling','Add at least one dwelling and one heating system for each sales comparable.','The Dwelling(s) subsection always displays and HeatingSystemType is always required.',ARRAY['22.05.21','22.05.49'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-003','fatal','sales_comparable_construction_method','Construction Method and Manufactured Home Width must follow attachment and construction controls.','Required construction methods, Other descriptions, and manufactured widths are enforced without stale dependent values.',ARRAY['22.05.23','22.05.35','22.05.37'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-004','fatal','sales_comparable_cooling_system','Cooling-system records must agree with Permanent Cooling Exists.','Cooling records require Yes; Yes requires at least one cooling system; No rejects stale records.',ARRAY['22.05.51'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-005','fatal','sales_comparable_functional_issue','Repeatable Dwelling(s) selections must be unique and None must be exclusive.','Functional issues, disaster features, construction methods, heating systems, and cooling systems are de-duplicated within their owning record.',ARRAY['22.05.35','22.05.45','22.05.47','22.05.49','22.05.51'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-DWELLING-006','warning','sales_comparable_adjustment_year_built','Dwelling adjustments retain typed contexts for deterministic MISMO generation.','Each adjustment context derives one official ComparableAdjustmentType.',ARRAY['22.05.22','22.05.24','22.05.26','22.05.28','22.05.30','22.05.32','22.05.34','22.05.36','22.05.38','22.05.40','22.05.42','22.05.44','22.05.46','22.05.48','22.05.50','22.05.52'],'{"phase":22,"source":"Appendix A-1 v1.4","implementation":"derived_xml_value"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
