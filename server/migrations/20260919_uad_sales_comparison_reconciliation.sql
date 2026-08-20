-- URAR Sections 22P and 22Q: Reconciliation of Sales Comparison Approach and
-- Additional Properties Analyzed Not Used. Additive UAD-only migration. It
-- introduces a narrative conclusion and independent analyzed-property records;
-- existing HomeNode properties and selected sales comparables remain unchanged.

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
    'sales_comparable_amenity', 'sales_comparable_vehicle_storage',
    'sales_comparison_additional_property'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0278","rfid":"22.16.01","context":"sales_comparison_reconciliation","name":"SalesComparisonCommentDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":10000,"format":"10000","implementation":"appraiser_input"},
    {"uid":"1900.0015","rfid":"Does Not Display","context":"sales_comparison_additional_property","name":"ValuationUseType","type":"Enumerated","requirement":"Conditional Required","cardinality":"1:1","options":["PropertyAnalyzedNotUsed"],"maxLength":null,"format":null,"implementation":"derived_from_typed_context"},
    {"uid":"1900.0017","rfid":"22.17.01","context":"sales_comparison_additional_property","name":"PropertyOrdinalNumber","type":"Numeric","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0","implementation":"server_calculated"},
    {"uid":"1900.0001","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"AddressLineText","type":"String","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":100,"format":"100","implementation":"appraiser_input"},
    {"uid":"1900.0018","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"AddressUnitDesignatorType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Unit"],"maxLength":null,"format":null,"implementation":"appraiser_input"},
    {"uid":"1900.0002","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"AddressUnitIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"format":"12","implementation":"appraiser_input"},
    {"uid":"1900.0003","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"CityName","type":"String","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":50,"format":"50","implementation":"appraiser_input"},
    {"uid":"1900.0004","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"PostalCode","type":"String","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":10,"format":"5 or ZIP+4","implementation":"appraiser_input"},
    {"uid":"1900.0005","rfid":"22.17.02","context":"sales_comparison_additional_property","name":"StateCode","type":"String","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":2,"format":"2","implementation":"appraiser_input"},
    {"uid":"1900.0007","rfid":"22.17.04","context":"sales_comparison_additional_property","name":"ListingStatusType","type":"Enumerated","requirement":"Conditional Required","cardinality":"1:1","options":["Active","OffMarket","Pending","SettledSale"],"maxLength":null,"format":null,"implementation":"appraiser_input"},
    {"uid":"1900.0009","rfid":"22.17.06","context":"sales_comparison_additional_property","name":"AdditionalPropertyAnalyzedNotUsedText","type":"String","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":360,"format":"360","implementation":"appraiser_input"},
    {"uid":"1900.0010","rfid":"Does Not Display","context":"sales_comparison_additional_property","name":"ConsiderationRequestedIndicator","type":"Boolean","requirement":"Conditional Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null,"implementation":"appraiser_input"},
    {"uid":"1900.0011","rfid":"22.17.05","context":"sales_comparison_additional_property","name":"ReasonPropertyNotUsedType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:22","options":["AccessoryDwellingUnit","Age","Amenities","AreaBelowGrade","BathroomCount","BedroomCount","Condition","DatedSale","DesignOrStyleVariance","GrossBuildingArea","GrossLivingArea","LotSize","Other","Outbuildings","Proximity","Quality","SaleOrTransferType","SiteInfluence"],"maxLength":null,"format":null,"implementation":"appraiser_input"},
    {"uid":"1900.0012","rfid":"22.17.05","context":"sales_comparison_additional_property","name":"ReasonPropertyNotUsedTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":27,"format":"27","implementation":"appraiser_input"},
    {"uid":"1900.0013","rfid":"22.17.03","context":"sales_comparison_additional_property","name":"OwnershipTransferDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD","implementation":"appraiser_input"},
    {"uid":"1900.0016","rfid":"Does Not Display","context":"sales_comparison_additional_property","name":"OwnershipTransferTransactionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Sale"],"maxLength":null,"format":null,"implementation":"derived_when_sale_date_present"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text, implementation text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22,
         'subphase', CASE WHEN context = 'sales_comparison_reconciliation' THEN '22P-reconciliation' ELSE '22Q-additional-properties-not-used' END,
         'options', options, 'max_length', "maxLength", 'format', format,
         'implementation', implementation,
         'entity_cardinality', CASE WHEN context = 'sales_comparison_additional_property' THEN '0:25' ELSE NULL END,
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
       CASE option.value
         WHEN 'OffMarket' THEN 'Off Market'
         WHEN 'SettledSale' THEN 'Settled Sale'
         WHEN 'PropertyAnalyzedNotUsed' THEN 'Property Analyzed Not Used'
         WHEN 'AccessoryDwellingUnit' THEN 'Accessory Dwelling Unit'
         WHEN 'AreaBelowGrade' THEN 'Area Below Grade'
         WHEN 'BathroomCount' THEN 'Bathroom Count'
         WHEN 'BedroomCount' THEN 'Bedroom Count'
         WHEN 'DatedSale' THEN 'Dated Sale'
         WHEN 'DesignOrStyleVariance' THEN 'Design or Style Variance'
         WHEN 'GrossBuildingArea' THEN 'Gross Building Area'
         WHEN 'GrossLivingArea' THEN 'Finished Area'
         WHEN 'SaleOrTransferType' THEN 'Sale or Transfer Type'
         WHEN 'SiteInfluence' THEN 'Site Influence'
         ELSE regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g')
       END,
       option.ordinality,
       jsonb_build_object('phase', 22, 'subphase', field.metadata->>'subphase', 'source', 'Appendix A-1 URAR Delivery Specification 1.4')
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.metadata->>'subphase' IN ('22P-reconciliation', '22Q-additional-properties-not-used')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label, location_role) AS (
  VALUES
    ('1800.0278','sales_comparison_reconciliation','22.16.01','Reconciliation of Sales Comparison Approach','primary'),
    ('1900.0015','sales_comparison_additional_property','Does Not Display','Valuation Use Type','primary'),
    ('1900.0017','sales_comparison_additional_property','22.17.01','Property Number','primary'),
    ('1900.0001','sales_comparison_additional_property','22.17.02','Address Line','primary'),
    ('1900.0018','sales_comparison_additional_property','22.17.02','Unit Designator','primary'),
    ('1900.0002','sales_comparison_additional_property','22.17.02','Unit Identifier','primary'),
    ('1900.0003','sales_comparison_additional_property','22.17.02','City','primary'),
    ('1900.0004','sales_comparison_additional_property','22.17.02','ZIP Code','primary'),
    ('1900.0005','sales_comparison_additional_property','22.17.02','State','primary'),
    ('1900.0007','sales_comparison_additional_property','22.17.04','Status','primary'),
    ('1900.0009','sales_comparison_additional_property','22.17.06','Comment','primary'),
    ('1900.0010','sales_comparison_additional_property','Does Not Display','Reconsideration Requested','primary'),
    ('1900.0011','sales_comparison_additional_property','22.17.05','Reason Not Used','primary'),
    ('1900.0012','sales_comparison_additional_property','22.17.05','Other Reason','primary'),
    ('1900.0013','sales_comparison_additional_property','22.17.03','Sale Date','primary'),
    ('1900.0016','sales_comparison_additional_property','Does Not Display','Ownership Transfer Transaction Type','primary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', location_role,
       jsonb_build_object(
         'label', label, 'phase', 22,
         'subphase', CASE WHEN property_context = 'sales_comparison_reconciliation' THEN '22P-reconciliation' ELSE '22Q-additional-properties-not-used' END,
         'source', 'Appendix A-1 v1.4 and Appendix F-1 URAR Reference Guide v1.4'
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
  ('uad-3.6-2026-08-13-h1.5','UAD1485','fatal','sales_comparison_additional_property','The Property Number must be unique across all Additional Properties Analyzed Not Used.','PropertyOrdinalNumber is unique within every PropertyAnalyzedNotUsed collection.',ARRAY['22.17.01'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1704','warning','sales_comparison_additional_property','Only the most recent sale for the additional property may be delivered.','At most one OwnershipTransferDate is delivered for each PropertyAnalyzedNotUsed.',ARRAY['22.17.03'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"single_canonical_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1760','fatal','sales_comparison_reconciliation','Provide the reconciliation for the Sales Comparison Approach.','If SalesComparisonApproachIndicator is true, SalesComparisonCommentDescription is provided.',ARRAY['22.16.01'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"catalog_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-RECONCILIATION-001','fatal','sales_comparison_reconciliation','The reconciliation must support the appraiser conclusion and comparable weighting.','The narrative explains the analysis supporting the indicated value and how ComparableWeightType was determined.',ARRAY['22.15.14','22.15.15','22.16.01'],'{"phase":22,"source":"Appendix F-1 URAR Reference Guide v1.4","implementation":"appraiser_narrative"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADDITIONAL-PROPERTY-001','fatal','sales_comparison_additional_property','No more than 25 additional analyzed properties may be delivered.','PropertyAnalyzedNotUsed has cardinality 0:25 and each record contains the required address, status, reason, reconsideration answer, and comment.',ARRAY['22.17.01','22.17.02','22.17.04','22.17.05','22.17.06'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"catalog_and_entity_limit"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADDITIONAL-PROPERTY-002','fatal','sales_comparison_additional_property','Additional property numbers are assigned by the server and remain unique.','PropertyOrdinalNumber equals the owning UAD entity ordinal and is unique across the collection.',ARRAY['22.17.01'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADDITIONAL-PROPERTY-003','fatal','sales_comparison_additional_property','Conditional additional-property details must be internally consistent.','A sale date appears only for Settled Sale; an Other description appears only when Other is selected. Land sales are reported in Site Valuation Methodology or Cost Approach.',ARRAY['22.17.03','22.17.04','22.17.05'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
