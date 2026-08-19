-- URAR Section 22C: Sales Comparison Approach site grid.
-- Additive UAD-only migration; comparable site facts remain children of the
-- canonical Section 21/22 sales comparable and do not alter legacy forms.

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
    'sales_comparable_right_not_included', 'sales_comparable_project_amenity',
    'sales_comparable_site_hazard', 'sales_comparable_site_street',
    'sales_comparable_site_restriction', 'sales_comparable_site_easement',
    'sales_comparable_site_feature', 'sales_comparable_site_influence',
    'sales_comparable_site_environmental', 'sales_comparable_site_view'
  ));

-- Complete reference-only Section 4 fields needed for the official subject
-- redisplays. These do not add inputs to the current Section 4 UI.
WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1500.0042","rfid":"4.047","context":"site_hazard","name":"HazardZoneType","type":"Enumerated","options":["FEMASpecialFloodHazardArea","None","Other","USGSLavaFlowZone"],"maxLength":null,"format":null},
    {"uid":"1500.0043","rfid":"4.047","context":"site_hazard","name":"HazardZoneTypeOtherDescription","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0045","rfid":"4.047","context":"site_hazard","name":"LavaFlowZoneCode","type":"Enumerated","options":["Zone1","Zone2","Zone3","Zone4","Zone5","Zone6","Zone7","Zone8","Zone9"],"maxLength":null,"format":null},
    {"uid":"1500.0048","rfid":"4.021","context":"site_access","name":"ImprovedSurfaceMaterialTypeOtherDescription","type":"String","options":null,"maxLength":12,"format":"12"},
    {"uid":"1500.0050","rfid":"4.021","context":"site_access","name":"StreetAccessTypeOtherDescription","type":"String","options":null,"maxLength":12,"format":"12"},
    {"uid":"1500.0002","rfid":"4.051","context":"site_restriction","name":"RestrictionType","type":"Enumerated","options":["Age","HistoricPreservation","Income","LandUse","Other","Rental","SalePrice"],"maxLength":null,"format":null},
    {"uid":"1500.0003","rfid":"4.051","context":"site_restriction","name":"RestrictionTypeOtherDescription","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0004","rfid":"4.055","context":"site_easement","name":"EasementType","type":"Enumerated","options":["Conservation","Drainage","IngressOrEgress","Other","Utility"],"maxLength":null,"format":null},
    {"uid":"1500.0005","rfid":"4.055","context":"site_easement","name":"EasementTypeOtherDescription","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0065","rfid":"4.063","context":"site_feature","name":"TopographyType","type":"Enumerated","options":["Flat","Other","Rocky","Rolling","Sloping"],"maxLength":null,"format":null},
    {"uid":"1500.0066","rfid":"4.063","context":"site_feature","name":"TopographyTypeOtherDescription","type":"String","options":null,"maxLength":33,"format":"33"},
    {"uid":"1500.0060","rfid":"4.063","context":"site_feature","name":"SiteDrainageReasonType","type":"Enumerated","options":["EvidenceOfErosion","ImproperGrading","Other","StandingWater"],"maxLength":null,"format":null},
    {"uid":"1500.0061","rfid":"4.063","context":"site_feature","name":"SiteDrainageReasonTypeOtherDescription","type":"String","options":null,"maxLength":33,"format":"33"},
    {"uid":"1500.0073","rfid":"4.027","context":"site_influence","name":"BodyOfWaterType","type":"Enumerated","options":["Bay","Canal","Cove","Creek","Gulf","Lake","Marsh","Ocean","Other","Pond","Reservoir","River","Sound"],"maxLength":null,"format":null},
    {"uid":"1500.0074","rfid":"4.027","context":"site_influence","name":"BodyOfWaterTypeOtherDescription","type":"String","options":null,"maxLength":21,"format":"21"},
    {"uid":"1500.0016","rfid":"4.027","context":"site_environmental","name":"EnvironmentalConditionType","type":"Enumerated","options":["HazardousAboveGroundStorageTank","HazardousSubstances","Landfill","None","Other","Radon","SlushPit","SoilContamination","SuperfundSite","UndergroundStorageTank","WaterContamination"],"maxLength":null,"format":null},
    {"uid":"1500.0017","rfid":"4.027","context":"site_environmental","name":"EnvironmentalConditionTypeOtherDescription","type":"String","options":null,"maxLength":45,"format":"45"},
    {"uid":"1500.0119","rfid":"4.040","context":"site_view","name":"ViewRangeTypeOtherDescription","type":"String","options":null,"maxLength":9,"format":"9"}
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
         'phase', 21, 'subphase', '22C-subject-redisplay-reference',
         'options', options, 'max_length', "maxLength", 'format', format,
         'source', 'Appendix A-1 URAR Delivery Specification 1.4'
       ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    metadata = EXCLUDED.metadata;

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0277","rfid":"22.03.18","context":"sales_comparable_site","name":"LandOwnedInCommonIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0239","rfid":"22.03.20","context":"sales_comparable_site","name":"LotSizeAreaMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["Acres","Hectares","SquareFeet","SquareMeters"],"maxLength":null,"format":"+7.3"},
    {"uid":"1800.0193","rfid":"22.03.22","context":"sales_comparable_site","name":"NeighborhoodName","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"1800.0245","rfid":"22.03.24","context":"sales_comparable_site","name":"SiteZoningComplianceType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Illegal","Legal","LegalNonConforming","NoZoning"],"maxLength":null,"format":null},
    {"uid":"1800.0218","rfid":"22.03.28","context":"sales_comparable_site","name":"PropertyPrimaryEntryExitMethodType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Other","PedestrianOnlyAccess","PrivateAirstrip","PrivateStreet","PublicStreet","Waterway"],"maxLength":null,"format":null},
    {"uid":"1800.0219","rfid":"22.03.28","context":"sales_comparable_site","name":"PropertyPrimaryEntryExitMethodTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0212","rfid":"22.03.26","context":"sales_comparable_site_hazard","name":"HazardZoneType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["FEMASpecialFloodHazardArea","None","Other","USGSLavaFlowZone"],"maxLength":null,"format":null},
    {"uid":"1800.0213","rfid":"22.03.26","context":"sales_comparable_site_hazard","name":"HazardZoneTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0367","rfid":"22.03.26","context":"sales_comparable_site_hazard","name":"LavaFlowZoneCode","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Zone1","Zone2","Zone3","Zone4","Zone5","Zone6","Zone7","Zone8","Zone9"],"maxLength":null,"format":null},
    {"uid":"1800.0216","rfid":"22.03.30","context":"sales_comparable_site_street","name":"StreetAccessType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Alley","Arterial","Collector","CulDeSac","DeadEnd","Local","Other","Rural"],"maxLength":null,"format":null},
    {"uid":"1800.0217","rfid":"22.03.30","context":"sales_comparable_site_street","name":"StreetAccessTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"format":"12"},
    {"uid":"1800.0214","rfid":"22.03.30","context":"sales_comparable_site_street","name":"ImprovedSurfaceMaterialType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Asphalt","Brick","Cobblestone","Concrete","Dirt","Gravel","Other"],"maxLength":null,"format":null},
    {"uid":"1800.0215","rfid":"22.03.30","context":"sales_comparable_site_street","name":"ImprovedSurfaceMaterialTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"format":"12"},
    {"uid":"1800.0068","rfid":"22.03.32","context":"sales_comparable_site_restriction","name":"RestrictionType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Age","HistoricPreservation","Income","LandUse","Other","Rental","SalePrice"],"maxLength":null,"format":null},
    {"uid":"1800.0069","rfid":"22.03.32","context":"sales_comparable_site_restriction","name":"RestrictionTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0072","rfid":"Does Not Display","context":"sales_comparable_site_restriction_xml","name":"EncumbranceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["ConditionsCovenantsRestrictions"],"maxLength":null,"format":null},
    {"uid":"1800.0070","rfid":"22.03.34","context":"sales_comparable_site_easement","name":"EasementType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Conservation","Drainage","IngressOrEgress","Other","Utility"],"maxLength":null,"format":null},
    {"uid":"1800.0071","rfid":"22.03.34","context":"sales_comparable_site_easement","name":"EasementTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0072","rfid":"Does Not Display","context":"sales_comparable_site_easement_xml","name":"EncumbranceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Easement"],"maxLength":null,"format":null},
    {"uid":"1800.0222","rfid":"22.03.40","context":"sales_comparable_site_feature","name":"SiteFeatureType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["CoastalBarrierResourcesSystem","Drainage","ExcessLand","Landlocked","Landscaping","None","Other","RoadFrontage","Shape","SoilSuitability","SurplusLand","Topography","Wetlands","ZeroLotLine"],"maxLength":null,"format":null},
    {"uid":"1800.0223","rfid":"22.03.40","context":"sales_comparable_site_feature","name":"SiteFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0225","rfid":"22.03.36","context":"sales_comparable_site_feature","name":"TopographyType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Flat","Other","Rocky","Rolling","Sloping"],"maxLength":null,"format":null},
    {"uid":"1800.0226","rfid":"22.03.36","context":"sales_comparable_site_feature","name":"TopographyTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0220","rfid":"22.03.38","context":"sales_comparable_site_feature","name":"SiteDrainageReasonType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["EvidenceOfErosion","ImproperGrading","Other","StandingWater"],"maxLength":null,"format":null},
    {"uid":"1800.0221","rfid":"22.03.38","context":"sales_comparable_site_feature","name":"SiteDrainageReasonTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0233","rfid":"22.03.42","context":"sales_comparable_site_influence","name":"SiteInfluenceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Agricultural","Airport","BodyOfWater","BusyRoadway","CommercialArea","GolfCourse","GreenSpace","HighDensityResidential","HighPressureGasLine","HistoricDistrict","IndustrialArea","LocalDistributionLine","OilOrGasWell","Other","OverheadElectricPowerTransmissionLine","Park","PublicTransportationHub","RailLine","Residential","School","StormwaterRetention"],"maxLength":null,"format":null},
    {"uid":"1800.0234","rfid":"22.03.42","context":"sales_comparable_site_influence","name":"SiteInfluenceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0228","rfid":"22.03.42","context":"sales_comparable_site_influence","name":"BodyOfWaterType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Bay","Canal","Cove","Creek","Gulf","Lake","Marsh","Ocean","Other","Pond","Reservoir","River","Sound"],"maxLength":null,"format":null},
    {"uid":"1800.0229","rfid":"22.03.42","context":"sales_comparable_site_influence","name":"BodyOfWaterTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":21,"format":"21"},
    {"uid":"1800.0116","rfid":"22.03.44","context":"sales_comparable_site_environmental","name":"EnvironmentalConditionType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["HazardousAboveGroundStorageTank","HazardousSubstances","Landfill","None","Other","Radon","SlushPit","SoilContamination","SuperfundSite","UndergroundStorageTank","WaterContamination"],"maxLength":null,"format":null},
    {"uid":"1800.0117","rfid":"22.03.44","context":"sales_comparable_site_environmental","name":"EnvironmentalConditionTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"1800.0243","rfid":"22.03.46","context":"sales_comparable_site_view","name":"ViewType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Bay","Canal","CityStreet","Commercial","Cove","Creek","GolfCourse","Gulf","HighDensityResidential","Highway","Industrial","Lake","Marsh","Mountain","Ocean","Other","Park","ParkingLot","Pastoral","Pond","Reservoir","Residential","River","School","Skyline","Sound","TrafficWallBarriers","Valley","Woods"],"maxLength":null,"format":null},
    {"uid":"1800.0244","rfid":"22.03.46","context":"sales_comparable_site_view","name":"ViewTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":27,"format":"27"},
    {"uid":"1800.0242","rfid":"22.03.46","context":"sales_comparable_site_view","name":"ViewRangeType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Full","Other","Partial","Seasonal"],"maxLength":null,"format":null},
    {"uid":"1800.0250","rfid":"22.03.46","context":"sales_comparable_site_view","name":"ViewRangeTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":9,"format":"9"}
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
         'phase', 21, 'subphase', '22C-site', 'options', options,
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

WITH adjustment(context, report_field_id, adjustment_type) AS (
  VALUES
    ('sales_comparable_adjustment_site_owned_common','22.03.19','LandOwnedInCommon'),
    ('sales_comparable_adjustment_site_size','22.03.21','SiteSize'),
    ('sales_comparable_adjustment_neighborhood','22.03.23','NeighborhoodName'),
    ('sales_comparable_adjustment_zoning','22.03.25','ZoningCompliance'),
    ('sales_comparable_adjustment_hazard','22.03.27','HazardZone'),
    ('sales_comparable_adjustment_primary_access','22.03.29','PropertyPrimaryAccess'),
    ('sales_comparable_adjustment_street','22.03.31','PropertyStreetAccessAndSurface'),
    ('sales_comparable_adjustment_restriction','22.03.33','PropertyRestriction'),
    ('sales_comparable_adjustment_easement','22.03.35','Easement'),
    ('sales_comparable_adjustment_topography','22.03.37','Topography'),
    ('sales_comparable_adjustment_drainage','22.03.39','SiteDrainage'),
    ('sales_comparable_adjustment_site_characteristic','22.03.41','SiteCharacteristic'),
    ('sales_comparable_adjustment_site_influence','22.03.43','SiteInfluence'),
    ('sales_comparable_adjustment_environmental','22.03.45','ApparentEnvironmentalCondition'),
    ('sales_comparable_adjustment_view','22.03.47','View')
), catalog AS (
  SELECT '1800.0317'::text AS uid, report_field_id AS rfid, context,
         'ComparableAdjustmentAmount'::text AS name, 'Amount'::text AS type,
         '0:1'::text AS cardinality, NULL::jsonb AS options, '±9.0'::text AS format
    FROM adjustment
  UNION ALL
  SELECT '1800.0318', 'Does Not Display', context,
         'ComparableAdjustmentType', 'Enumerated', '1:1',
         jsonb_build_array(adjustment_type), NULL
    FROM adjustment
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, 'Conditional', cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 21, 'subphase', '22C-site', 'options', options, 'format', format,
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
       '{"phase":21,"subphase":"22C-site","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'phase' = '21'
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label, location_role) AS (
  VALUES
    ('0100.0047','subject','22.03.01','Subject Site Owned in Common','redisplay'),
    ('1500.0093','site','22.03.02','Subject Site Size','redisplay'),
    ('0100.0017','subject','22.03.03','Subject Neighborhood Name','redisplay'),
    ('1500.0125','site_zoning','22.03.04','Subject Zoning Compliance','redisplay'),
    ('1500.0042','site_hazard','22.03.05','Subject Hazard Zone','redisplay'),
    ('1500.0043','site_hazard','22.03.05','Subject Other Hazard Zone','redisplay'),
    ('1500.0045','site_hazard','22.03.05','Subject Lava Flow Zone','redisplay'),
    ('1500.0055','site_access','22.03.06','Subject Primary Access','redisplay'),
    ('1500.0056','site_access','22.03.06','Subject Other Primary Access','redisplay'),
    ('1500.0049','site_access','22.03.07','Subject Street Type','redisplay'),
    ('1500.0050','site_access','22.03.07','Subject Other Street Type','redisplay'),
    ('1500.0047','site_access','22.03.07','Subject Street Surface','redisplay'),
    ('1500.0048','site_access','22.03.07','Subject Other Street Surface','redisplay'),
    ('1500.0002','site_restriction','22.03.08','Subject Property Restriction','redisplay'),
    ('1500.0003','site_restriction','22.03.08','Subject Other Property Restriction','redisplay'),
    ('1500.0004','site_easement','22.03.09','Subject Easement','redisplay'),
    ('1500.0005','site_easement','22.03.09','Subject Other Easement','redisplay'),
    ('1500.0065','site_feature','22.03.10','Subject Topography','redisplay'),
    ('1500.0066','site_feature','22.03.10','Subject Other Topography','redisplay'),
    ('1500.0060','site_feature','22.03.11','Subject Drainage','redisplay'),
    ('1500.0061','site_feature','22.03.11','Subject Other Drainage','redisplay'),
    ('1500.0062','site_feature','22.03.12','Subject Site Characteristic','redisplay'),
    ('1500.0063','site_feature','22.03.12','Subject Other Site Characteristic','redisplay'),
    ('1500.0087','site_influence','22.03.13','Subject Site Influence','redisplay'),
    ('1500.0088','site_influence','22.03.13','Subject Other Site Influence','redisplay'),
    ('1500.0073','site_influence','22.03.13','Subject Body of Water','redisplay'),
    ('1500.0074','site_influence','22.03.13','Subject Other Body of Water','redisplay'),
    ('1500.0016','site_environmental','22.03.14','Subject Environmental Condition','redisplay'),
    ('1500.0017','site_environmental','22.03.14','Subject Other Environmental Condition','redisplay'),
    ('1500.0120','site_view','22.03.15','Subject View','redisplay'),
    ('1500.0121','site_view','22.03.15','Subject Other View','redisplay'),
    ('1500.0118','site_view','22.03.15','Subject View Range','redisplay'),
    ('1500.0119','site_view','22.03.15','Subject Other View Range','redisplay'),
    ('1800.0277','sales_comparable_site','22.03.18','Comparable Site Owned in Common','primary'),
    ('1800.0317','sales_comparable_adjustment_site_owned_common','22.03.19','Site Owned in Common Adjustment','primary'),
    ('1800.0239','sales_comparable_site','22.03.20','Comparable Site Size','primary'),
    ('1800.0317','sales_comparable_adjustment_site_size','22.03.21','Site Size Adjustment','primary'),
    ('1800.0193','sales_comparable_site','22.03.22','Comparable Neighborhood Name','primary'),
    ('1800.0317','sales_comparable_adjustment_neighborhood','22.03.23','Neighborhood Name Adjustment','primary'),
    ('1800.0245','sales_comparable_site','22.03.24','Comparable Zoning Compliance','primary'),
    ('1800.0317','sales_comparable_adjustment_zoning','22.03.25','Zoning Compliance Adjustment','primary'),
    ('1800.0212','sales_comparable_site_hazard','22.03.26','Comparable Hazard Zone','primary'),
    ('1800.0213','sales_comparable_site_hazard','22.03.26','Comparable Other Hazard Zone','primary'),
    ('1800.0367','sales_comparable_site_hazard','22.03.26','Comparable Lava Flow Zone','primary'),
    ('1800.0317','sales_comparable_adjustment_hazard','22.03.27','Hazard Zone Adjustment','primary'),
    ('1800.0218','sales_comparable_site','22.03.28','Comparable Primary Access','primary'),
    ('1800.0219','sales_comparable_site','22.03.28','Comparable Other Primary Access','primary'),
    ('1800.0317','sales_comparable_adjustment_primary_access','22.03.29','Primary Access Adjustment','primary'),
    ('1800.0216','sales_comparable_site_street','22.03.30','Comparable Street Type','primary'),
    ('1800.0217','sales_comparable_site_street','22.03.30','Comparable Other Street Type','primary'),
    ('1800.0214','sales_comparable_site_street','22.03.30','Comparable Street Surface','primary'),
    ('1800.0215','sales_comparable_site_street','22.03.30','Comparable Other Street Surface','primary'),
    ('1800.0317','sales_comparable_adjustment_street','22.03.31','Street Type and Surface Adjustment','primary'),
    ('1800.0068','sales_comparable_site_restriction','22.03.32','Comparable Property Restriction','primary'),
    ('1800.0069','sales_comparable_site_restriction','22.03.32','Comparable Other Property Restriction','primary'),
    ('1800.0317','sales_comparable_adjustment_restriction','22.03.33','Property Restriction Adjustment','primary'),
    ('1800.0070','sales_comparable_site_easement','22.03.34','Comparable Easement','primary'),
    ('1800.0071','sales_comparable_site_easement','22.03.34','Comparable Other Easement','primary'),
    ('1800.0317','sales_comparable_adjustment_easement','22.03.35','Easement Adjustment','primary'),
    ('1800.0225','sales_comparable_site_feature','22.03.36','Comparable Topography','primary'),
    ('1800.0226','sales_comparable_site_feature','22.03.36','Comparable Other Topography','primary'),
    ('1800.0317','sales_comparable_adjustment_topography','22.03.37','Topography Adjustment','primary'),
    ('1800.0220','sales_comparable_site_feature','22.03.38','Comparable Drainage','primary'),
    ('1800.0221','sales_comparable_site_feature','22.03.38','Comparable Other Drainage','primary'),
    ('1800.0317','sales_comparable_adjustment_drainage','22.03.39','Drainage Adjustment','primary'),
    ('1800.0222','sales_comparable_site_feature','22.03.40','Comparable Site Characteristic','primary'),
    ('1800.0223','sales_comparable_site_feature','22.03.40','Comparable Other Site Characteristic','primary'),
    ('1800.0317','sales_comparable_adjustment_site_characteristic','22.03.41','Site Characteristics Adjustment','primary'),
    ('1800.0233','sales_comparable_site_influence','22.03.42','Comparable Site Influence','primary'),
    ('1800.0234','sales_comparable_site_influence','22.03.42','Comparable Other Site Influence','primary'),
    ('1800.0228','sales_comparable_site_influence','22.03.42','Comparable Body of Water','primary'),
    ('1800.0229','sales_comparable_site_influence','22.03.42','Comparable Other Body of Water','primary'),
    ('1800.0317','sales_comparable_adjustment_site_influence','22.03.43','Site Influence Adjustment','primary'),
    ('1800.0116','sales_comparable_site_environmental','22.03.44','Comparable Environmental Condition','primary'),
    ('1800.0117','sales_comparable_site_environmental','22.03.44','Comparable Other Environmental Condition','primary'),
    ('1800.0317','sales_comparable_adjustment_environmental','22.03.45','Environmental Conditions Adjustment','primary'),
    ('1800.0243','sales_comparable_site_view','22.03.46','Comparable View','primary'),
    ('1800.0244','sales_comparable_site_view','22.03.46','Comparable Other View','primary'),
    ('1800.0242','sales_comparable_site_view','22.03.46','Comparable View Range','primary'),
    ('1800.0250','sales_comparable_site_view','22.03.46','Comparable Other View Range','primary'),
    ('1800.0317','sales_comparable_adjustment_view','22.03.47','View and Range Adjustment','primary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 21, 'subphase', '22C-site',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1398','fatal','sales_comparable_site_restriction','Provide the type of property restriction that could impact value or use.','Every included restriction requires RestrictionType.',ARRAY['22.03.32'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1399','fatal','sales_comparable_site_restriction','Provide a description when property restriction is Other.','RestrictionTypeOtherDescription is required when RestrictionType is Other.',ARRAY['22.03.32'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1400','fatal','sales_comparable_site_easement','Provide the easement type.','Every included easement requires EasementType.',ARRAY['22.03.34'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1401','fatal','sales_comparable_site_easement','Provide a description when Easement is Other.','EasementTypeOtherDescription is required when EasementType is Other.',ARRAY['22.03.34'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1445','fatal','sales_comparable_site_hazard','Provide the hazard zone type; select None when no hazard zone is identified.','Every sales comparable requires at least one HAZARD_ZONE with HazardZoneType.',ARRAY['22.03.26'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1446','fatal','sales_comparable_site_hazard','Provide a description when hazard zone type is Other.','HazardZoneTypeOtherDescription is required when HazardZoneType is Other.',ARRAY['22.03.26'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1447','fatal','sales_comparable_site_street','Provide a description when street surface material is Other.','ImprovedSurfaceMaterialTypeOtherDescription is required when ImprovedSurfaceMaterialType is Other.',ARRAY['22.03.30'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1448','fatal','sales_comparable_site_feature','Provide a description when site drainage reason is Other.','SiteDrainageReasonTypeOtherDescription is required when SiteDrainageReasonType is Other.',ARRAY['22.03.38'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1449','fatal','sales_comparable_site','Provide the total site size when the comparable site is not owned in common.','LotSizeAreaMeasure is required when LandOwnedInCommonIndicator is false.',ARRAY['22.03.20'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1450','fatal','sales_comparable_site_view','Provide the view type.','Every sales comparable requires at least one SITE_VIEW with ViewType.',ARRAY['22.03.46'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1451','fatal','sales_comparable_site_view','Provide a description when view type is Other.','ViewTypeOtherDescription is required when ViewType is Other.',ARRAY['22.03.46'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1452','fatal','sales_comparable_site','Indicate whether the site is owned in common.','LandOwnedInCommonIndicator is required for every sales comparable.',ARRAY['22.03.18'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1476','fatal','sales_comparable_site_hazard','Provide the lava flow zone.','LavaFlowZoneCode is required when HazardZoneType is USGSLavaFlowZone.',ARRAY['22.03.26'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1769','fatal','sales_comparable_site_influence','Provide Site Influence (Location) for the sales comparable.','Every sales comparable requires at least one SITE_INFLUENCE_DETAIL with SiteInfluenceType.',ARRAY['22.03.42'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1770','fatal','sales_comparable_site_influence','Provide a description when Site Influence (Location) is Other.','SiteInfluenceTypeOtherDescription is required when SiteInfluenceType is Other.',ARRAY['22.03.42'],'{"phase":21,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SITE-001','fatal','sales_comparable_site','Comparable site ownership controls site size and primary-access fields.','Site size is required when not owned in common; stale conditional fields are rejected.',ARRAY['22.03.18','22.03.20','22.03.28'],'{"phase":21,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SITE-002','fatal','sales_comparable_site','Hazard, influence, and view records are required and must belong to the comparable.','Required Section 22C child records must be present and parent-linked.',ARRAY['22.03.26','22.03.42','22.03.46'],'{"phase":21,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SITE-003','fatal','sales_comparable_site_feature','Comparable Site child selections must be unique and None is exclusive.','Duplicate enumerations and mixed None selections are rejected.',ARRAY['22.03.26','22.03.40','22.03.44'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SITE-004','fatal','sales_comparable_site','Conditional Other, lava-flow, topography, drainage, water, and range details must agree with controlling values.','Stale or contradictory conditional details are rejected.',ARRAY['22.03.26','22.03.28','22.03.30','22.03.32','22.03.34','22.03.36','22.03.38','22.03.40','22.03.42','22.03.44','22.03.46'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SITE-005','warning','sales_comparable_adjustment_site_owned_common','Site adjustments retain explicit typed contexts for deterministic MISMO generation.','Each predefined row maps ComparableAdjustmentAmount to its official ComparableAdjustmentType.',ARRAY['22.03.19','22.03.21','22.03.23','22.03.25','22.03.27','22.03.29','22.03.31','22.03.33','22.03.35','22.03.37','22.03.39','22.03.41','22.03.43','22.03.45','22.03.47'],'{"phase":21,"source":"Appendix A-1 v1.4","implementation":"derived_xml_value"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
