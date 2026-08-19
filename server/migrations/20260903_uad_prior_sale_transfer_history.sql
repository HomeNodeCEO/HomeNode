-- URAR Section 21: Prior Sale and Transfer History.
-- Additive UAD-only reference data, repeatable transfer/source records, and
-- compliance rules. Existing HomeNode sales, custom-appraisal, and property-tax
-- data are not changed.

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
    'comparable_prior_transfer_data_source'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"0800.0005","rfid":"21.000","context":"subject_prior_transfer_summary","name":"PriorSalesOrTransfersIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"0700.0125","rfid":"21.001","context":"subject_no_prior_transfer_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CooperativeBoard","DataAggregator","Deed","HomeownersAssociation","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","PropertyTenant"],"maxLength":null,"format":null},
    {"uid":"0700.0126","rfid":"21.001","context":"subject_no_prior_transfer_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"0800.0037","rfid":"Does Not Display","context":"subject_prior_transfer_xml","name":"xlink:label","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["SALES_HISTORY_n"],"maxLength":null,"format":null},
    {"uid":"0800.0018","rfid":"21.002","context":"subject_prior_transfer","name":"OwnershipTransferTransactionType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["DeedTransferOnly","Sale"],"maxLength":null,"format":null},
    {"uid":"0800.0013","rfid":"21.002","context":"subject_prior_transfer","name":"SaleType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["CourtOrderedNonForeclosureSale","EstateSale","ForeclosureSale","LandSale","Other","PreSubdivisionSale","RelocationSale","REOSale","SaleBetweenRelatedParties","ShortSale","TypicallyMotivated"],"maxLength":null,"format":null},
    {"uid":"0800.0014","rfid":"21.002","context":"subject_prior_transfer","name":"SaleTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"0800.0011","rfid":"21.003","context":"subject_prior_transfer","name":"OwnershipTransferDate","type":"Date","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"0800.0012","rfid":"21.004","context":"subject_prior_transfer","name":"OwnershipTransferTransactionAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"0800.0009","rfid":"21.004","context":"subject_prior_transfer","name":"OwnershipTransferAmountNotAvailableReasonType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["NotDisclosed","NotRecorded","Other"],"maxLength":null,"format":null},
    {"uid":"0800.0010","rfid":"21.004","context":"subject_prior_transfer","name":"OwnershipTransferAmountNotAvailableReasonTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"0700.0125","rfid":"21.005","context":"subject_prior_transfer_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CooperativeBoard","DataAggregator","Deed","HomeownersAssociation","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","PropertyTenant"],"maxLength":null,"format":null},
    {"uid":"0700.0126","rfid":"21.005","context":"subject_prior_transfer_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"1600.0008","rfid":"21.006","context":"subject_prior_transfer_commentary","name":"ValuationCommentText","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":5000,"format":"5000"},
    {"uid":"1600.0009","rfid":"Does Not Display","context":"subject_prior_transfer_commentary_xml","name":"ValuationAnalysisCategoryType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["SubjectPriorSalesAndTransferHistory"],"maxLength":null,"format":null},
    {"uid":"1800.0192","rfid":"21.007","context":"sales_comparable","name":"PropertyOrdinalNumber","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+2.0"},
    {"uid":"1800.0198","rfid":"21.008","context":"comparable_prior_transfer_summary","name":"PriorSalesOrTransfersIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"0800.0038","rfid":"Does Not Display","context":"comparable_prior_transfer_xml","name":"xlink:label","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["SALES_HISTORY_n"],"maxLength":null,"format":null},
    {"uid":"1800.0209","rfid":"21.008","context":"comparable_prior_transfer","name":"OwnershipTransferTransactionType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["DeedTransferOnly","Sale"],"maxLength":null,"format":null},
    {"uid":"1800.0210","rfid":"21.008","context":"comparable_prior_transfer","name":"SaleType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["CourtOrderedNonForeclosureSale","EstateSale","ForeclosureSale","LandSale","Other","PreSubdivisionSale","RelocationSale","REOSale","SaleBetweenRelatedParties","ShortSale","TypicallyMotivated"],"maxLength":null,"format":null},
    {"uid":"1800.0211","rfid":"21.008","context":"comparable_prior_transfer","name":"SaleTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0207","rfid":"21.009","context":"comparable_prior_transfer","name":"OwnershipTransferDate","type":"Date","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"1800.0208","rfid":"21.010","context":"comparable_prior_transfer","name":"OwnershipTransferTransactionAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0205","rfid":"21.010","context":"comparable_prior_transfer","name":"OwnershipTransferAmountNotAvailableReasonType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["NotDisclosed","NotRecorded","Other"],"maxLength":null,"format":null},
    {"uid":"1800.0206","rfid":"21.010","context":"comparable_prior_transfer","name":"OwnershipTransferAmountNotAvailableReasonTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"0700.0125","rfid":"21.011","context":"comparable_no_prior_transfer_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CooperativeBoard","DataAggregator","Deed","HomeownersAssociation","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","PropertyTenant"],"maxLength":null,"format":null},
    {"uid":"0700.0126","rfid":"21.011","context":"comparable_no_prior_transfer_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"0700.0125","rfid":"21.011","context":"comparable_prior_transfer_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CooperativeBoard","DataAggregator","Deed","HomeownersAssociation","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","PropertyTenant"],"maxLength":null,"format":null},
    {"uid":"0700.0126","rfid":"21.011","context":"comparable_prior_transfer_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"1600.0008","rfid":"21.012","context":"comparable_prior_transfer_commentary","name":"ValuationCommentText","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":5000,"format":"5000"},
    {"uid":"1600.0009","rfid":"Does Not Display","context":"comparable_prior_transfer_commentary_xml","name":"ValuationAnalysisCategoryType","type":"Enumerated","requirement":"Required","cardinality":"1:1","options":["ComparablesPriorSalesAndTransferHistory"],"maxLength":null,"format":null},
    {"uid":"1400.0638","rfid":"21.013.1","context":"prior_sale_transfer_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Optional","cardinality":"0:unbounded","options":["PriorSaleAndTransferHistoryExhibit"],"maxLength":null,"format":null},
    {"uid":"1400.0640","rfid":"21.013.2","context":"prior_sale_transfer_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"0800.0031","rfid":"Does Not Display","context":"comparable_no_prior_transfer_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_PriorSalesOrTransfersIndicator"],"maxLength":null,"format":null},
    {"uid":"0800.0032","rfid":"Does Not Display","context":"comparable_no_prior_transfer_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"0800.0033","rfid":"Does Not Display","context":"comparable_no_prior_transfer_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["PriorSalesOrTransfersIndicator_n"],"maxLength":null,"format":null},
    {"uid":"0800.0034","rfid":"Does Not Display","context":"subject_no_prior_transfer_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_PriorSalesOrTransfersIndicator"],"maxLength":null,"format":null},
    {"uid":"0800.0035","rfid":"Does Not Display","context":"subject_no_prior_transfer_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"0800.0036","rfid":"Does Not Display","context":"subject_no_prior_transfer_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["PriorSalesOrTransfersIndicator_n"],"maxLength":null,"format":null},
    {"uid":"0800.0039","rfid":"Does Not Display","context":"comparable_prior_transfer_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_SALES_HISTORY"],"maxLength":null,"format":null},
    {"uid":"0800.0040","rfid":"Does Not Display","context":"comparable_prior_transfer_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"0800.0041","rfid":"Does Not Display","context":"comparable_prior_transfer_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["SALES_HISTORY_n"],"maxLength":null,"format":null},
    {"uid":"0800.0042","rfid":"Does Not Display","context":"subject_prior_transfer_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_SALES_HISTORY"],"maxLength":null,"format":null},
    {"uid":"0800.0043","rfid":"Does Not Display","context":"subject_prior_transfer_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"0800.0044","rfid":"Does Not Display","context":"subject_prior_transfer_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["SALES_HISTORY_n"],"maxLength":null,"format":null}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 21, 'Prior Sale and Transfer History',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 18, 'options', options, 'max_length', "maxLength", 'format', format,
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
  '{"phase":18,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 21
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0800.0005','subject_prior_transfer_summary','21.000','Subject Prior Sales or Transfers'),
    ('0700.0125','subject_no_prior_transfer_data_source','21.001','Subject No-Transfer Data Source'),
    ('0700.0126','subject_no_prior_transfer_data_source','21.001','Other Subject No-Transfer Data Source'),
    ('0800.0018','subject_prior_transfer','21.002','Subject Ownership Transfer Type'),
    ('0800.0013','subject_prior_transfer','21.002','Subject Prior Sale Type'),
    ('0800.0014','subject_prior_transfer','21.002','Other Subject Prior Sale Type'),
    ('0800.0011','subject_prior_transfer','21.003','Subject Transfer Date'),
    ('0800.0012','subject_prior_transfer','21.004','Subject Transfer Amount'),
    ('0800.0009','subject_prior_transfer','21.004','Subject Amount Unavailable Reason'),
    ('0800.0010','subject_prior_transfer','21.004','Other Subject Amount Unavailable Reason'),
    ('0700.0125','subject_prior_transfer_data_source','21.005','Subject Transfer Data Source'),
    ('0700.0126','subject_prior_transfer_data_source','21.005','Other Subject Transfer Data Source'),
    ('1600.0008','subject_prior_transfer_commentary','21.006','Analysis of Subject Prior Sale and Transfer History'),
    ('1800.0192','sales_comparable','21.007','Comparable Number'),
    ('1800.0198','comparable_prior_transfer_summary','21.008','Comparable Prior Sales or Transfers'),
    ('1800.0209','comparable_prior_transfer','21.008','Comparable Ownership Transfer Type'),
    ('1800.0210','comparable_prior_transfer','21.008','Comparable Prior Sale Type'),
    ('1800.0211','comparable_prior_transfer','21.008','Other Comparable Prior Sale Type'),
    ('1800.0207','comparable_prior_transfer','21.009','Comparable Transfer Date'),
    ('1800.0208','comparable_prior_transfer','21.010','Comparable Transfer Amount'),
    ('1800.0205','comparable_prior_transfer','21.010','Comparable Amount Unavailable Reason'),
    ('1800.0206','comparable_prior_transfer','21.010','Other Comparable Amount Unavailable Reason'),
    ('0700.0125','comparable_no_prior_transfer_data_source','21.011','Comparable No-Transfer Data Source'),
    ('0700.0126','comparable_no_prior_transfer_data_source','21.011','Other Comparable No-Transfer Data Source'),
    ('0700.0125','comparable_prior_transfer_data_source','21.011','Comparable Transfer Data Source'),
    ('0700.0126','comparable_prior_transfer_data_source','21.011','Other Comparable Transfer Data Source'),
    ('1600.0008','comparable_prior_transfer_commentary','21.012','Analysis of Comparable Prior Sale and Transfer History'),
    ('1400.0638','prior_sale_transfer_asset','21.013.1','Prior Sale and Transfer History Exhibit'),
    ('1400.0640','prior_sale_transfer_asset','21.013.2','Prior Sale and Transfer History Exhibit Caption')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  21, 'Prior Sale and Transfer History', 'primary',
  jsonb_build_object(
    'label', label, 'phase', 18,
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
  ('uad-3.6-2026-08-13-h1.5','UAD1191','fatal','subject_prior_transfer_summary','Indicate whether the subject property has a prior sale or transfer.','PriorSalesOrTransfersIndicator is required for the subject.',ARRAY['21.000'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1192','fatal','subject_prior_transfer','Provide the ownership transfer transaction type.','Every subject SALES_HISTORY requires OwnershipTransferTransactionType.',ARRAY['21.002'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1193','fatal','subject_prior_transfer','Provide the Transfer Terms.','SaleType is required for each subject sale.',ARRAY['21.002'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1194','fatal','subject_prior_transfer','Provide a description when Transfer Terms is Other.','SaleTypeOtherDescription is required when SaleType is Other.',ARRAY['21.002'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1195','fatal','subject_prior_transfer','Provide the ownership transfer date.','Every subject SALES_HISTORY requires OwnershipTransferDate.',ARRAY['21.003'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1196','fatal','subject_prior_transfer','The subject prior transfer date must include year, month, and day.','OwnershipTransferDate must use YYYY-MM-DD.',ARRAY['21.003'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1197','fatal','subject_prior_transfer','The subject transfer amount must be greater than or equal to zero.','OwnershipTransferTransactionAmount must be at least zero.',ARRAY['21.004'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1198','fatal','subject_prior_transfer','Provide a description when the amount-unavailable reason is Other.','OwnershipTransferAmountNotAvailableReasonTypeOtherDescription is conditionally required.',ARRAY['21.004'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1199','fatal','comparable_no_prior_transfer_relationship_xml','Provide at least one data source when a comparable has no prior transfer.','A DATA_SOURCE relationship to the comparable indicator is required.',ARRAY['21.008','21.011'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1200','fatal','subject_no_prior_transfer_relationship_xml','Provide at least one data source when the subject has no prior transfer.','A DATA_SOURCE relationship to the subject indicator is required.',ARRAY['21.000','21.001'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1201','fatal','comparable_prior_transfer_relationship_xml','Provide a data source for each comparable prior transfer.','A DATA_SOURCE relationship to each comparable SALES_HISTORY is required.',ARRAY['21.008','21.011'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1202','fatal','subject_prior_transfer_relationship_xml','Provide a data source for each subject prior transfer.','A DATA_SOURCE relationship to each subject SALES_HISTORY is required.',ARRAY['21.002','21.005'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1431','fatal','sales_comparable','Assign a numeric identifier to every sales comparable.','PropertyOrdinalNumber is required for each sales comparable.',ARRAY['21.007','22.01.16'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1432','fatal','sales_comparable','Comparable numbers must be unique.','PropertyOrdinalNumber is unique across sales comparables.',ARRAY['21.007','22.01.16'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1436','fatal','comparable_prior_transfer_summary','Indicate whether each sales comparable has a prior sale or transfer.','PriorSalesOrTransfersIndicator is required for every sales comparable.',ARRAY['21.008'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1439','fatal','comparable_prior_transfer','Provide either the comparable transfer amount or the unavailable reason.','Exactly one amount representation is required.',ARRAY['21.010'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1440','fatal','comparable_prior_transfer','Provide a description when the amount-unavailable reason is Other.','The Other description is conditionally required.',ARRAY['21.010'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1442','fatal','comparable_prior_transfer','The comparable transfer amount must be greater than or equal to zero.','OwnershipTransferTransactionAmount must be at least zero.',ARRAY['21.010'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1444','fatal','comparable_prior_transfer','Provide a description when Transfer Terms is Other.','SaleTypeOtherDescription is conditionally required.',ARRAY['21.008'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1698','fatal','subject_prior_transfer','Provide either the subject transfer amount or the unavailable reason.','Exactly one amount representation is required.',ARRAY['21.004'],'{"phase":18,"source":"Appendix H-1 v1.5","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1734','fatal','comparable_prior_transfer','Provide the ownership transfer transaction type for each comparable history.','OwnershipTransferTransactionType is required.',ARRAY['21.008'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1735','fatal','comparable_prior_transfer','Provide the ownership transfer date for each comparable history.','OwnershipTransferDate is required.',ARRAY['21.009'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1744','fatal','comparable_prior_transfer','The comparable prior transfer date must include year, month, and day.','OwnershipTransferDate must use YYYY-MM-DD.',ARRAY['21.009'],'{"phase":18,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-PRIOR-TRANSFER-001','fatal','subject_prior_transfer_summary','The subject transfer decision must agree with its supporting records.','Yes requires transfer records; No requires data-source records.',ARRAY['21.000','21.001','21.002'],'{"phase":18,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-PRIOR-TRANSFER-002','fatal','subject_prior_transfer','Each subject transfer must have exactly one amount representation and at least one data source.','Transfer amount/reason and DATA_SOURCE relationships are reconciled.',ARRAY['21.004','21.005'],'{"phase":18,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-PRIOR-TRANSFER-003','fatal','comparable_prior_transfer_summary','Each comparable transfer decision must agree with its supporting records.','Comparable Yes requires transfers; No requires data sources.',ARRAY['21.008','21.011'],'{"phase":18,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-PRIOR-TRANSFER-004','fatal','prior_sale_transfer_asset','Prior sale and transfer exhibits must be verified workfile-level images.','Only captioned image assets may be attached to Section 21.',ARRAY['21.013.1','21.013.2'],'{"phase":18,"source":"Appendix F-1 v1.4","implementation":"server_asset_validation"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
