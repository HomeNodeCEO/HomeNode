-- URAR Section 19: Subject Listing Information.
-- Additive UAD-only reference data, repeatable subject listing records,
-- optional exhibits, and compliance rules. Existing HomeNode sales, custom
-- appraisal, and property-tax data are not changed.

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
    'subject_listing_data_source', 'subject_listing'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"0900.0004","rfid":"19.000","context":"subject_listing_summary","name":"ListedWithinPreviousYearIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":null},
    {"uid":"0700.0125","rfid":"19.001","context":"subject_listing_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CondominiumQuestionnaire","CooperativeBoard","CooperativeQuestionnaire","DataAggregator","HomeownersAssociation","LandSurvey","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","PropertyTenant","RealEstateAgent"],"maxLength":null,"format":null},
    {"uid":"0700.0126","rfid":"19.001","context":"subject_listing_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"0900.0013","rfid":"19.002","context":"subject_listing","name":"ListingStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Active","OffMarket","Pending"],"maxLength":null,"format":null},
    {"uid":"0900.0015","rfid":"19.003","context":"subject_listing","name":"ListingType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Auction","ForSaleByOwner","MLS","Other"],"maxLength":null,"format":null},
    {"uid":"0900.0016","rfid":"19.003","context":"subject_listing","name":"ListingTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"0900.0011","rfid":"19.004","context":"subject_listing","name":"ListingIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"0900.0012","rfid":"19.005","context":"subject_listing","name":"ListingStartDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"0900.0010","rfid":"19.006","context":"subject_listing","name":"ListingEndDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"0900.0007","rfid":"19.007","context":"subject_listing","name":"DaysOnMarketCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"0900.0009","rfid":"19.008","context":"subject_listing","name":"InitialListPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"0900.0008","rfid":"19.009","context":"subject_listing","name":"FinalListPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"0900.0003","rfid":"19.010","context":"subject_listing_summary","name":"CumulativeDaysOnMarketCount","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"0900.0020","rfid":"19.011","context":"subject_listing_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000,"format":"5000"},
    {"uid":"0900.0032","rfid":"Does Not Display","context":"subject_listing_summary_xml","name":"xlink:label","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["LISTING_INFORMATION_SUMMARY_n"],"maxLength":null,"format":null},
    {"uid":"0900.0021","rfid":"Does Not Display","context":"subject_listing_commentary_xml","name":"ValuationAnalysisCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["SubjectListing"],"maxLength":null,"format":null},
    {"uid":"0900.0033","rfid":"Does Not Display","context":"subject_listing_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_LISTING_INFORMATION_SUMMARY"],"maxLength":null,"format":null},
    {"uid":"0900.0034","rfid":"Does Not Display","context":"subject_listing_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"0900.0035","rfid":"Does Not Display","context":"subject_listing_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["LISTING_INFORMATION_SUMMARY_n"],"maxLength":null,"format":null},
    {"uid":"1400.0638","rfid":"19.012.1","context":"subject_listing_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Optional","cardinality":"0:unbounded","options":["SubjectListingExhibit"],"maxLength":null,"format":null},
    {"uid":"1400.0640","rfid":"19.012.2","context":"subject_listing_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"format":"100"}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 19, 'Subject Listing Information',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 16, 'options', options, 'max_length', "maxLength", 'format', format,
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
  field.release_key, field.uid, field.property_context, option.value,
  regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
  option.ordinality,
  '{"phase":16,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 19
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, location_role, label) AS (
  VALUES
    ('0900.0004','subject_listing_summary','19.000','primary','Current or Relevant Listings'),
    ('0700.0125','subject_listing_data_source','19.001','primary','Data Source'),
    ('0700.0126','subject_listing_data_source','19.001','primary','Other Data Source'),
    ('0900.0013','subject_listing','19.002','primary','Listing Status'),
    ('0900.0015','subject_listing','19.003','primary','Listing Type'),
    ('0900.0016','subject_listing','19.003','primary','Other Listing Type'),
    ('0900.0011','subject_listing','19.004','primary','Listing ID'),
    ('0900.0012','subject_listing','19.005','primary','Start Date'),
    ('0900.0010','subject_listing','19.006','primary','End Date'),
    ('0900.0007','subject_listing','19.007','primary','DOM'),
    ('0900.0009','subject_listing','19.008','primary','Starting List Price'),
    ('0900.0008','subject_listing','19.009','primary','Current or Final List Price'),
    ('0900.0003','subject_listing_summary','19.010','primary','Total DOM'),
    ('0900.0020','subject_listing_commentary','19.011','primary','Analysis of Subject Property Listing History'),
    ('1400.0638','subject_listing_asset','19.012.1','primary','Subject Listing Exhibit'),
    ('1400.0640','subject_listing_asset','19.012.2','primary','Subject Listing Exhibit Caption')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  19, 'Subject Listing Information', location_role,
  jsonb_build_object(
    'label', label, 'phase', 16,
    'source', 'Appendix C-1 v1.3 and Appendix F-1 v1.4'
  )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1203','fatal','subject_listing_summary','Indicate whether the property has been listed within the previous twelve months.','ListedWithinPreviousYearIndicator is required.',ARRAY['19.000'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1204','fatal','subject_listing','Provide the total number of days the property has been on the market.','DaysOnMarketCount is required for every listing.',ARRAY['19.007'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1205','fatal','subject_listing','Provide the current or final list price.','FinalListPriceAmount is required for every listing.',ARRAY['19.009'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1206','fatal','subject_listing','The listing start date cannot be after the listing end date.','ListingStartDate must be less than or equal to ListingEndDate.',ARRAY['19.005','19.006'],'{"phase":16,"source":"Appendix H-1 v1.5","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1207','fatal','subject_listing','Provide the listing status and at least one listing.','ListingStatusType is required for every listing.',ARRAY['19.002'],'{"phase":16,"source":"Appendix H-1 v1.5","implementation":"server_repeatable_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1208','fatal','subject_listing','Provide a description when Listing Type is Other.','ListingTypeOtherDescription is required when ListingType is Other.',ARRAY['19.003'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1209','fatal','subject_listing_relationship_xml','Provide at least one data source when the subject property was not listed within the previous year.','A DATA_SOURCE relationship to LISTING_INFORMATION_SUMMARY is required when ListedWithinPreviousYearIndicator is false.',ARRAY['19.000','19.001'],'{"phase":16,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1725','fatal','subject_listing','The listing start date must include year, month, and day.','ListingStartDate must use YYYY-MM-DD.',ARRAY['19.005'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1726','fatal','subject_listing','The listing end date must include year, month, and day.','ListingEndDate must use YYYY-MM-DD.',ARRAY['19.006'],'{"phase":16,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-LISTING-001','fatal','subject_listing_summary','The listing decision must agree with its supporting records.','Yes requires listing records; No requires data-source records.',ARRAY['19.000','19.001','19.002'],'{"phase":16,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-LISTING-002','fatal','subject_listing_summary','Total DOM must equal the sum of the listing rows.','CumulativeDaysOnMarketCount equals the sum of DaysOnMarketCount.',ARRAY['19.007','19.010'],'{"phase":16,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-LISTING-003','fatal','subject_listing','Days on market must agree with the provided start and end dates.','DOM equals End Date minus Start Date plus one when both dates are present.',ARRAY['19.005','19.006','19.007'],'{"phase":16,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SUBJECT-LISTING-004','fatal','subject_listing','Listing IDs must be unique within the subject history.','No duplicate nonblank ListingIdentifier values.',ARRAY['19.004'],'{"phase":16,"source":"HomeNode cross-record integrity","implementation":"server_cross_entity"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
