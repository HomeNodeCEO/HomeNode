-- URAR Section 22A: Sales Comparison Approach general information.
-- This additive migration extends the isolated UAD schemas only. It creates
-- canonical comparable child records and reference/catalog data without
-- changing HomeNode custom-appraisal or property-tax data.

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
    'sales_comparable_right_not_included'
  ));

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1000.0032","rfid":"Does Not Display","context":"sales_comparison_scope","name":"SalesComparisonApproachIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0001","rfid":"22.01.17","context":"sales_comparable_address","name":"AddressLineText","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":100,"format":"100"},
    {"uid":"1800.0002","rfid":"22.01.17","context":"sales_comparable_address","name":"AddressUnitIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":12,"format":"12"},
    {"uid":"1800.0400","rfid":"22.01.17","context":"sales_comparable_address","name":"AddressUnitDesignatorType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Unit"],"maxLength":null,"format":null},
    {"uid":"1800.0003","rfid":"22.01.17","context":"sales_comparable_address","name":"CityName","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":50,"format":"50"},
    {"uid":"1800.0005","rfid":"22.01.17","context":"sales_comparable_address","name":"StateCode","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":2,"format":"2"},
    {"uid":"1800.0004","rfid":"22.01.17","context":"sales_comparable_address","name":"PostalCode","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":10,"format":"10"},
    {"uid":"0100.0059","rfid":"Does Not Display","context":"sales_comparable_property","name":"AccessoryDwellingUnitTotalCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+1.0"},
    {"uid":"1800.0065","rfid":"22.01.19","context":"sales_comparable_proximity","name":"ProximityToSubjectDistanceLinearMeasure","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":["Kilometers","Miles"],"maxLength":null,"format":"+3.2"},
    {"uid":"1800.0066","rfid":"22.01.19","context":"sales_comparable_proximity","name":"ComparableToSubjectDirectionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["East","North","NorthEast","NorthWest","South","SouthEast","SouthWest","West"],"maxLength":null,"format":null},
    {"uid":"1800.0074","rfid":"22.01.20","context":"sales_comparable_listing","name":"FinalListPriceAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0075","rfid":"22.01.21","context":"sales_comparable_listing","name":"ListingStatusType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Active","OffMarket","Pending","SettledSale"],"maxLength":null,"format":null},
    {"uid":"1800.0384","rfid":"22.01.22","context":"sales_comparable_contract","name":"ContractAmountUnknownIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0271","rfid":"22.01.22","context":"sales_comparable_contract","name":"SalesContractAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0272","rfid":"22.01.23","context":"sales_comparable_sale","name":"OwnershipTransferTransactionAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0274","rfid":"22.01.24","context":"sales_comparable_sale","name":"SaleType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["CourtOrderedNonForeclosureSale","EstateSale","ForeclosureSale","LandSale","Other","PreSubdivisionSale","RelocationSale","REOSale","SaleBetweenRelatedParties","ShortSale","TypicallyMotivated"],"maxLength":null,"format":null},
    {"uid":"1800.0275","rfid":"22.01.24","context":"sales_comparable_sale","name":"SaleTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0381","rfid":"22.01.26","context":"sales_comparable_financing","name":"NoFinancingTransactionIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0063","rfid":"22.01.26","context":"sales_comparable_financing","name":"MortgageType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Conventional","FHA","Other","Private","USDARuralDevelopment","VA"],"maxLength":null,"format":null},
    {"uid":"1800.0064","rfid":"22.01.26","context":"sales_comparable_financing","name":"MortgageTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":21,"format":"21"},
    {"uid":"1800.0370","rfid":"22.01.28","context":"sales_comparable_concessions","name":"SalesConcessionIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0369","rfid":"22.01.28","context":"sales_comparable_concessions","name":"SalesConcessionAmountKnownIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0203","rfid":"22.01.28","context":"sales_comparable_concessions","name":"TotalSalesConcessionAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0385","rfid":"22.01.30","context":"sales_comparable_contract","name":"ContractDateUnknownIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0202","rfid":"22.01.30","context":"sales_comparable_contract","name":"SalesContractDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"1800.0342","rfid":"22.01.32","context":"sales_comparable_sale","name":"OwnershipTransferDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"1800.0189","rfid":"22.01.34","context":"sales_comparable_listing","name":"DaysOnMarketCount","type":"Numeric","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1800.0316","rfid":"22.01.35","context":"sales_comparable_listing","name":"SaleToListPriceRatioPercent","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+3.0"},
    {"uid":"1800.0195","rfid":"22.01.37","context":"sales_comparable_property","name":"AttachmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["Attached","Detached"],"maxLength":null,"format":null},
    {"uid":"1800.0337","rfid":"22.01.39","context":"sales_comparable_property","name":"PropertyEstateType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["FeeSimple","Leasehold","Other"],"maxLength":null,"format":null},
    {"uid":"1800.0338","rfid":"22.01.39","context":"sales_comparable_property","name":"PropertyEstateTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0077","rfid":"22.01.41","context":"sales_comparable_property","name":"PropertyGroundLeaseAnnualAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"1800.0357","rfid":"22.01.42","context":"sales_comparable_property","name":"NativeAmericanLandsIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0358","rfid":"22.01.42","context":"sales_comparable_property","name":"NativeAmericanLandsType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["AlaskaNativeCorporationLand","HawaiianHomeLands","Other","TribalTrustLand"],"maxLength":null,"format":null},
    {"uid":"1800.0359","rfid":"22.01.42","context":"sales_comparable_property","name":"NativeAmericanLandsTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0201","rfid":"22.01.44","context":"sales_comparable_property","name":"AllPropertyRightsAppraisedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0082","rfid":"22.01.47","context":"sales_comparable_property","name":"SameBuilderAsSubjectIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1800.0317","rfid":"22.01.25","context":"sales_comparable_adjustment_transfer_terms","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.27","context":"sales_comparable_adjustment_financing","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.29","context":"sales_comparable_adjustment_concessions","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.31","context":"sales_comparable_adjustment_contract_date","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.33","context":"sales_comparable_adjustment_sale_date","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.36","context":"sales_comparable_adjustment_sale_list_ratio","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.38","context":"sales_comparable_adjustment_attachment","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.40","context":"sales_comparable_adjustment_property_rights","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.43","context":"sales_comparable_adjustment_native_lands","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0317","rfid":"22.01.45","context":"sales_comparable_adjustment_all_rights","name":"ComparableAdjustmentAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±9.0"},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_transfer_terms","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["PropertyOwnershipTransferTerms"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_financing","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["FinancingMethod"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_concessions","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["SalesConcessions"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_contract_date","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["ContractDate"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_sale_date","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["SaleDate"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_sale_list_ratio","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["SaleToListPriceRatio"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_attachment","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AttachedOrDetached"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_property_rights","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["PropertyRightsAppraised"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_native_lands","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["NativeAmericanLands"],"maxLength":null,"format":null},
    {"uid":"1800.0318","rfid":"Does Not Display","context":"sales_comparable_adjustment_all_rights","name":"ComparableAdjustmentType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["OwnershipRightsConveyed"],"maxLength":null,"format":null},
    {"uid":"0700.0125","rfid":"22.01.18","context":"sales_comparable_data_source","name":"DataSourceType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AssessorRecord","BuilderOrDeveloper","CondominiumQuestionnaire","CooperativeBoard","CooperativeQuestionnaire","DataAggregator","ExteriorInspection","HomeownersAssociation","InteriorInspection","LandSurvey","MLS","Other","PreviousAppraisalFile","PropertyManagementCompany","PropertyOwner","RealEstateAgent"],"maxLength":null,"format":null},
    {"uid":"1800.0347","rfid":"22.01.18","context":"sales_comparable_data_source","name":"DataSourceIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":45,"format":"45"},
    {"uid":"0700.0126","rfid":"22.01.18","context":"sales_comparable_data_source","name":"DataSourceTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":66,"format":"66"},
    {"uid":"1800.0340","rfid":"22.01.46","context":"sales_comparable_right_not_included","name":"PropertyPartialInterestType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["AirRights","MineralRights","Other","TimberRights","WaterRights"],"maxLength":null,"format":null},
    {"uid":"1800.0341","rfid":"22.01.46","context":"sales_comparable_right_not_included","name":"PropertyPartialInterestTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"1800.0273","rfid":"Does Not Display","context":"sales_comparable_sale_xml","name":"OwnershipTransferTransactionType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["Sale"],"maxLength":null,"format":null},
    {"uid":"1800.0339","rfid":"22.01.46","context":"sales_comparable_right_not_included_xml","name":"AppraisedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"1:1","options":["false"],"maxLength":null,"format":null},
    {"uid":"1800.0374","rfid":"Does Not Display","context":"sales_comparable_data_source_relationship_xml","name":"xlink:arcrole","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["urn:fdc:mismo.org:2009:residential/DATA_SOURCE_IsDataSourceFor_PROPERTY"],"maxLength":null,"format":null},
    {"uid":"1800.0375","rfid":"Does Not Display","context":"sales_comparable_data_source_relationship_xml","name":"xlink:from","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["DATA_SOURCE_n"],"maxLength":null,"format":null},
    {"uid":"1800.0376","rfid":"Does Not Display","context":"sales_comparable_data_source_relationship_xml","name":"xlink:to","type":"Attribute","requirement":"Conditional","cardinality":"0:1","options":["PROPERTY_n"],"maxLength":null,"format":null},
    {"uid":"1400.0628","rfid":"Does Not Display","context":"sales_comparable_photo","name":"ImageCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"1:1","options":["PropertyPhoto"],"maxLength":null,"format":null},
    {"uid":"1400.0629","rfid":"Does Not Display","context":"sales_comparable_photo","name":"AltitudeElevationLinearMeasure","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":["Feet","Meters"],"maxLength":null,"format":"+6.0"},
    {"uid":"1400.0631","rfid":"Does Not Display","context":"sales_comparable_photo","name":"ImageDatetime","type":"Datetime","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DDThh:mm:ssZ"},
    {"uid":"1400.0634","rfid":"Does Not Display","context":"sales_comparable_photo","name":"ImageFileLocationIdentifier","type":"String","requirement":"Conditional","cardinality":"1:1","options":null,"maxLength":50,"format":"50"},
    {"uid":"1400.0632","rfid":"Does Not Display","context":"sales_comparable_photo","name":"LatitudeIdentifier","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±2.6"},
    {"uid":"1400.0633","rfid":"Does Not Display","context":"sales_comparable_photo","name":"LongitudeIdentifier","type":"Numeric","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"±3.6"},
    {"uid":"1400.0901","rfid":"Does Not Display","context":"sales_comparable_photo","name":"MIMETypeIdentifier","type":"String","requirement":"Conditional","cardinality":"1:1","options":["image/avif","image/bmp","image/gif","image/heic","image/heif","image/jpeg","image/png","image/tiff","image/webp"],"maxLength":30,"format":"30"},
    {"uid":"1400.0638","rfid":"22.19.01.1","context":"sales_comparison_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Optional","cardinality":"0:unbounded","options":["SalesComparisonApproachExhibit"],"maxLength":null,"format":null},
    {"uid":"1400.0640","rfid":"22.19.01.2","context":"sales_comparison_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"format":"100"}
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
    'phase', 19, 'subphase', '22A-general-information', 'options', options,
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
       '{"phase":19,"subphase":"22A-general-information","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 22
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0192','sales_comparable','22.01.16','Comparable Number'),
    ('1800.0001','sales_comparable_address','22.01.17','Property Address'),
    ('1800.0002','sales_comparable_address','22.01.17','Property Address Unit'),
    ('1800.0400','sales_comparable_address','22.01.17','Property Address Unit Designator'),
    ('1800.0003','sales_comparable_address','22.01.17','Property Address City'),
    ('1800.0005','sales_comparable_address','22.01.17','Property Address State'),
    ('1800.0004','sales_comparable_address','22.01.17','Property Address ZIP Code'),
    ('0700.0125','sales_comparable_data_source','22.01.18','Data Source'),
    ('1800.0347','sales_comparable_data_source','22.01.18','Data Source Identifier'),
    ('0700.0126','sales_comparable_data_source','22.01.18','Other Data Source'),
    ('1800.0065','sales_comparable_proximity','22.01.19','Proximity to Subject'),
    ('1800.0066','sales_comparable_proximity','22.01.19','Direction from Subject'),
    ('1800.0074','sales_comparable_listing','22.01.20','List Price'),
    ('1800.0075','sales_comparable_listing','22.01.21','Listing Status'),
    ('1800.0384','sales_comparable_contract','22.01.22','Contract Price Unknown'),
    ('1800.0271','sales_comparable_contract','22.01.22','Contract Price'),
    ('1800.0272','sales_comparable_sale','22.01.23','Sale Price'),
    ('1800.0274','sales_comparable_sale','22.01.24','Transfer Terms'),
    ('1800.0275','sales_comparable_sale','22.01.24','Other Transfer Terms'),
    ('1800.0317','sales_comparable_adjustment_transfer_terms','22.01.25','Transfer Terms Adjustment'),
    ('1800.0381','sales_comparable_financing','22.01.26','No Financing Transaction'),
    ('1800.0063','sales_comparable_financing','22.01.26','Financing Type'),
    ('1800.0064','sales_comparable_financing','22.01.26','Other Financing Type'),
    ('1800.0317','sales_comparable_adjustment_financing','22.01.27','Financing Adjustment'),
    ('1800.0370','sales_comparable_concessions','22.01.28','Sales Concessions'),
    ('1800.0369','sales_comparable_concessions','22.01.28','Concession Amount Known'),
    ('1800.0203','sales_comparable_concessions','22.01.28','Total Sales Concessions'),
    ('1800.0317','sales_comparable_adjustment_concessions','22.01.29','Sales Concessions Adjustment'),
    ('1800.0385','sales_comparable_contract','22.01.30','Contract Date Unknown'),
    ('1800.0202','sales_comparable_contract','22.01.30','Contract Date'),
    ('1800.0317','sales_comparable_adjustment_contract_date','22.01.31','Contract Date Adjustment'),
    ('1800.0342','sales_comparable_sale','22.01.32','Sale Date'),
    ('1800.0317','sales_comparable_adjustment_sale_date','22.01.33','Sale Date Adjustment'),
    ('1800.0189','sales_comparable_listing','22.01.34','Days on Market'),
    ('1800.0316','sales_comparable_listing','22.01.35','Sale to List Price Ratio'),
    ('1800.0317','sales_comparable_adjustment_sale_list_ratio','22.01.36','Sale to List Price Ratio Adjustment'),
    ('1800.0195','sales_comparable_property','22.01.37','Attached or Detached'),
    ('1800.0317','sales_comparable_adjustment_attachment','22.01.38','Attached or Detached Adjustment'),
    ('1800.0337','sales_comparable_property','22.01.39','Property Rights Appraised'),
    ('1800.0338','sales_comparable_property','22.01.39','Other Property Rights'),
    ('1800.0317','sales_comparable_adjustment_property_rights','22.01.40','Property Rights Adjustment'),
    ('1800.0077','sales_comparable_property','22.01.41','Annual Ground Rent'),
    ('1800.0357','sales_comparable_property','22.01.42','Native American Lands'),
    ('1800.0358','sales_comparable_property','22.01.42','Native American Lands Type'),
    ('1800.0359','sales_comparable_property','22.01.42','Other Native American Lands Type'),
    ('1800.0317','sales_comparable_adjustment_native_lands','22.01.43','Native American Lands Adjustment'),
    ('1800.0201','sales_comparable_property','22.01.44','All Rights Included'),
    ('1800.0317','sales_comparable_adjustment_all_rights','22.01.45','All Rights Included Adjustment'),
    ('1800.0340','sales_comparable_right_not_included','22.01.46','Right Not Included'),
    ('1800.0341','sales_comparable_right_not_included','22.01.46','Other Right Not Included'),
    ('1800.0339','sales_comparable_right_not_included_xml','22.01.46','Right Appraised Indicator'),
    ('1800.0082','sales_comparable_property','22.01.47','Same Builder as Subject'),
    ('1400.0638','sales_comparison_asset','22.01.16.1','Comparable Sales Comparison Exhibit'),
    ('1400.0640','sales_comparison_asset','22.01.16.2','Comparable Sales Comparison Exhibit Caption'),
    ('1400.0638','sales_comparison_asset','22.19.01.1','Sales Comparison Approach Exhibit'),
    ('1400.0640','sales_comparison_asset','22.19.01.2','Sales Comparison Approach Exhibit Caption')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach',
       CASE WHEN report_field_id IN ('22.01.16.1','22.01.16.2') THEN 'redisplay' ELSE 'primary' END,
       jsonb_build_object(
         'label', label, 'phase', 19, 'subphase', '22A-general-information',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1218','fatal','sales_comparison_scope','Indicate whether the Sales Comparison Approach was developed.','SalesComparisonApproachIndicator is required.',ARRAY['Does Not Display'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1275','fatal','sales_comparable_photo','Provide a property photo for each sales comparable.','A PropertyPhoto image is required for every included sales comparable.',ARRAY['22.01.17'],'{"phase":19,"source":"Appendix H-1 v1.5","implementation":"server_asset_validation"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1390','fatal','sales_comparable_address','Provide the address line for the sales comparable.','AddressLineText is required.',ARRAY['22.01.17'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1391','fatal','sales_comparable_address','Provide the city name for the sales comparable.','CityName is required.',ARRAY['22.01.17'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1392','fatal','sales_comparable_address','Provide the ZIP code for the sales comparable.','PostalCode is required.',ARRAY['22.01.17'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1393','fatal','sales_comparable_address','Provide the state code for the sales comparable.','StateCode is required.',ARRAY['22.01.17'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1394','warning','sales_comparable_financing','Provide Financing Type when the transaction was financed.','MortgageType is conditionally required.',ARRAY['22.01.26'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1395','fatal','sales_comparable_financing','Provide a description when Financing Type is Other.','MortgageTypeOtherDescription is conditionally required.',ARRAY['22.01.26'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1396','fatal','sales_comparable_proximity','Provide the Proximity to Subject distance.','ProximityToSubjectDistanceLinearMeasure is required.',ARRAY['22.01.19'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1397','fatal','sales_comparable_proximity','Provide the Proximity to Subject direction when distance is greater than zero.','ComparableToSubjectDirectionType is conditionally required.',ARRAY['22.01.19'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1402','fatal','sales_comparable_listing','Provide Listing Status for the sales comparable.','ListingStatusType is required.',ARRAY['22.01.21'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1403','fatal','sales_comparable_listing','Only one listing status may be delivered for a sales comparable.','One LISTING_INFORMATION instance is permitted.',ARRAY['22.01.21'],'{"phase":19,"source":"Appendix H-1 v1.5","implementation":"canonical_single_value"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1404','fatal','sales_comparable','Provide at least one sales comparable when the approach is developed.','At least one included sales comparable is required.',ARRAY['22.01.16'],'{"phase":19,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1428','fatal','sales_comparable_listing','Provide total days on market.','DaysOnMarketCount is required.',ARRAY['22.01.34'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1433','fatal','sales_comparable_property','Indicate whether the sales comparable is attached or detached.','AttachmentType is required.',ARRAY['22.01.37'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1469','fatal','sales_comparable_property','Provide a description when Native American Lands is Other.','NativeAmericanLandsTypeOtherDescription is conditionally required.',ARRAY['22.01.42'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1477','fatal','sales_comparable_data_source_relationship_xml','Provide at least one data source for each sales comparable.','A DATA_SOURCE relationship to the comparable PROPERTY is required.',ARRAY['22.01.18'],'{"phase":19,"source":"Appendix H-1 v1.5","implementation":"server_cross_entity_and_xml_relationship"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1481','fatal','sales_comparable_contract','Indicate whether the contract date is known.','ContractDateUnknownIndicator is conditionally required.',ARRAY['22.01.30'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1731','fatal','sales_comparable_contract','Provide the date the sales contract was fully executed.','SalesContractDate is required when the unknown indicator is false.',ARRAY['22.01.30'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1771','fatal','sales_comparable_sale','Provide Transfer Terms for the associated transaction.','SaleType is required for a settled sale.',ARRAY['22.01.24'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1773','fatal','sales_comparable_property','Provide Property Rights Appraised for the sales comparable.','PropertyEstateType is required when applicable.',ARRAY['22.01.39'],'{"phase":19,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-001','fatal','sales_comparison_scope','The approach decision must agree with comparable records.','Yes requires at least one comparable; No cannot retain comparable records.',ARRAY['Does Not Display','22.01.16'],'{"phase":19,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-002','fatal','sales_comparable','Each comparable must reconcile listing, contract, sale, financing, and concession fields.','Conditional transaction fields must agree with ListingStatusType.',ARRAY['22.01.21','22.01.22','22.01.23','22.01.24','22.01.26','22.01.28','22.01.30','22.01.32'],'{"phase":19,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-003','fatal','sales_comparable_data_source','Comparable sources and property-right exclusions must be parent-linked and unique.','Child records must resolve to the canonical sales comparable.',ARRAY['22.01.18','22.01.44','22.01.46'],'{"phase":19,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-004','fatal','sales_comparable_photo','Comparable photos must be verified entity-linked images; general exhibits must remain workfile-level.','Section 22 asset ownership and captions are enforced.',ARRAY['22.01.17','22.19.01.1','22.19.01.2'],'{"phase":19,"source":"Appendix F-1 v1.4","implementation":"server_asset_validation"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
