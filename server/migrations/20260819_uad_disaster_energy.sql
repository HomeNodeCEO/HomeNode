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
    'green_efficiency_rating'
  ));

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
    [
      {"uid":"3700.0002","rfid":"5.000","section":5,"section_name":"Disaster Mitigation","context":"disaster_mitigation","name":"DisasterMitigationFeatureType","type":"Enumerated","requirement":"Required","cardinality":"1:17","options":["None","EnclosedSoffits","FireResistantDecking","FireResistantExteriorWalls","FloodVents","FortifiedRoof","FramingAnchorageOrBracing","ImpactResistantGlass","ImpactResistantShingles","NoncombustiblePerimeter","StormShelter","StormShutters","WaterHeaterStrapping","Other"]},
      {"uid":"3700.0003","rfid":"5.000","section":5,"section_name":"Disaster Mitigation","context":"disaster_mitigation","name":"DisasterMitigationFeatureTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"3700.0004","rfid":"5.001","section":5,"section_name":"Disaster Mitigation","context":"disaster_mitigation_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0005","rfid":"6.000","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green","name":"RenewableEnergyComponentExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1"},
      {"uid":"2600.0019","rfid":"6.001","section":6,"section_name":"Energy Efficient and Green Features","context":"renewable_energy_component","entity_type":"renewable_energy_component","name":"RenewableEnergyComponentType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded","options":["Geothermal","Solar","WindTurbine","Other"]},
      {"uid":"2600.0020","rfid":"6.001","section":6,"section_name":"Energy Efficient and Green Features","context":"renewable_energy_component","entity_type":"renewable_energy_component","name":"RenewableEnergyComponentTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0017","rfid":"6.002","section":6,"section_name":"Energy Efficient and Green Features","context":"renewable_energy_component","entity_type":"renewable_energy_component","name":"RenewableEnergyComponentOwnershipType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Leased","Owned","PowerPurchaseAgreement","Other"]},
      {"uid":"2600.0018","rfid":"6.002","section":6,"section_name":"Energy Efficient and Green Features","context":"renewable_energy_component","entity_type":"renewable_energy_component","name":"RenewableEnergyComponentOwnershipTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0016","rfid":"6.003","section":6,"section_name":"Energy Efficient and Green Features","context":"renewable_energy_component","entity_type":"renewable_energy_component","name":"RenewableEnergyComponentFinancedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0004","rfid":"6.004","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green","name":"GreenCertificationExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1"},
      {"uid":"2600.0006","rfid":"6.005","section":6,"section_name":"Energy Efficient and Green Features","context":"green_building_certification","entity_type":"green_building_certification","name":"GreenCertificationAssociationName","type":"String","requirement":"Conditional","cardinality":"0:unbounded"},
      {"uid":"2600.0009","rfid":"6.006","section":6,"section_name":"Energy Efficient and Green Features","context":"green_building_certification","entity_type":"green_building_certification","name":"GreenCertificationName","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0007","rfid":"6.007","section":6,"section_name":"Energy Efficient and Green Features","context":"green_building_certification","entity_type":"green_building_certification","name":"GreenCertificationLevelAwardedYear","type":"Date","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0010","rfid":"6.008","section":6,"section_name":"Energy Efficient and Green Features","context":"green_building_certification","entity_type":"green_building_certification","name":"GreenCertificationVersionIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0008","rfid":"6.009","section":6,"section_name":"Energy Efficient and Green Features","context":"green_building_certification","entity_type":"green_building_certification","name":"GreenCertificationLevelName","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0003","rfid":"6.010","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green","name":"EfficiencyRatingExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1"},
      {"uid":"2600.0013","rfid":"6.011","section":6,"section_name":"Energy Efficient and Green Features","context":"green_efficiency_rating","entity_type":"green_efficiency_rating","name":"EfficiencyRatingOrganizationName","type":"String","requirement":"Conditional","cardinality":"0:unbounded"},
      {"uid":"2600.0012","rfid":"6.012","section":6,"section_name":"Energy Efficient and Green Features","context":"green_efficiency_rating","entity_type":"green_efficiency_rating","name":"EfficiencyRatingName","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0014","rfid":"6.013","section":6,"section_name":"Energy Efficient and Green Features","context":"green_efficiency_rating","entity_type":"green_efficiency_rating","name":"EfficiencyRatingScoreValue","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0027","rfid":"6.014","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green","name":"ValueMarketabilityImpactType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Adverse","Beneficial","Neutral"]},
      {"uid":"2600.0026","rfid":"6.015","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green","name":"EnergyEfficientAndGreenDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"2600.0040","rfid":"6.016","section":6,"section_name":"Energy Efficient and Green Features","context":"energy_green_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1"}
    ]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    section integer,
    section_name text,
    context text,
    entity_type text,
    name text,
    type text,
    requirement text,
    cardinality text,
    options jsonb
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, section, section_name,
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 3,
    'entity_type', entity_type,
    'options', options,
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
  '{"phase":3,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number IN (5, 6)
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1616','fatal','energy_green','Indicate whether the property has obtained an efficiency rating.','EfficiencyRatingExistsIndicator is provided',ARRAY['6.010'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1617','fatal','energy_green','Indicate whether the property has obtained green, health or wellness certification.','GreenCertificationExistsIndicator is provided',ARRAY['6.004'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1618','fatal','energy_green','Indicate whether the property has any renewable energy components.','RenewableEnergyComponentExistsIndicator is provided',ARRAY['6.000'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1619','warning','renewable_energy_component','Indicate whether the renewable energy component is subject to a financing arrangement.','IF ownership = Owned THEN financed indicator is provided',ARRAY['6.003'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1620','fatal','renewable_energy_component','Provide a description when renewable energy component ownership type is Other.','IF ownership = Other THEN other description is provided',ARRAY['6.002'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1622','warning','renewable_energy_component','Provide the type of renewable energy component.','IF known renewable components = true THEN component type is provided',ARRAY['6.001'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1623','fatal','renewable_energy_component','Provide a description when renewable energy component type is Other.','IF component type = Other THEN other description is provided',ARRAY['6.001'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1683','fatal','disaster_mitigation','The type of disaster mitigation feature must be included. Select None if there are no disaster mitigation features.','at least one DisasterMitigationFeatureType is provided',ARRAY['5.000'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1684','fatal','disaster_mitigation','Provide a description when Mitigation Feature is Other.','IF mitigation feature = Other THEN other description is provided',ARRAY['5.000'],'{"phase":3,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-DISASTER-001','fatal','disaster_mitigation','None cannot be combined with another disaster mitigation feature.','None is exclusive within DisasterMitigationFeatureType',ARRAY['5.000'],'{"phase":3,"implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-ENERGY-001','fatal','energy_green','Known-feature indicators must agree with their repeatable detail records.','indicator = exists(corresponding entity)',ARRAY['6.000','6.004','6.010'],'{"phase":3,"implementation":"server_cross_record"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
