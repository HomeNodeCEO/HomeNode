-- URAR Section 20: Sales Contract.
-- Additive UAD-only reference data and compliance rules. Existing HomeNode
-- custom-appraisal contracts, assignment files, and property-tax data are not changed.

WITH catalog AS (
  SELECT *
  FROM jsonb_to_recordset($catalog$
  [
    {"uid":"0600.0016","rfid":"20.000","context":"sales_contract","name":"SalesContractExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0010","rfid":"20.001","context":"sales_contract","name":"SalesContractReviewedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0002","rfid":"20.002","context":"sales_contract","name":"ArmsLengthIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0003","rfid":"20.003","context":"sales_contract","name":"NonArmsLengthCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":1250,"format":"1250"},
    {"uid":"0600.0008","rfid":"20.004","context":"sales_contract","name":"SalesContractAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"0600.0009","rfid":"20.005","context":"sales_contract","name":"SalesContractDate","type":"Date","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"0600.0017","rfid":"20.006","context":"sales_contract","name":"SaleType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["CourtOrderedNonForeclosureSale","EstateSale","ForeclosureSale","LandSale","Other","PreSubdivisionSale","RelocationSale","REOSale","SaleBetweenRelatedParties","ShortSale","TypicallyMotivated"],"maxLength":null,"format":null},
    {"uid":"0600.0018","rfid":"20.006","context":"sales_contract","name":"SaleTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":33,"format":"33"},
    {"uid":"0600.0004","rfid":"20.007","context":"sales_contract","name":"PersonalPropertyIncludedIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0006","rfid":"20.008","context":"sales_contract","name":"SalesConcessionIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0005","rfid":"20.009","context":"sales_contract","name":"SalesConcessionAmountKnownIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0011","rfid":"20.009","context":"sales_contract","name":"TotalSalesConcessionAmount","type":"Amount","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.2"},
    {"uid":"0600.0007","rfid":"20.010","context":"sales_contract","name":"SalesConcessionsTypicalToMarketIndicator","type":"Boolean","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":null,"format":null},
    {"uid":"0600.0014","rfid":"20.011","context":"sales_contract_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":5000,"format":"5000"},
    {"uid":"0600.0015","rfid":"Does Not Display","context":"sales_contract_commentary_xml","name":"ValuationAnalysisCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1","options":["SalesContract"],"maxLength":null,"format":null},
    {"uid":"1400.0638","rfid":"20.012.1","context":"sales_contract_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Optional","cardinality":"0:unbounded","options":["SalesContractExhibit"],"maxLength":null,"format":null},
    {"uid":"1400.0640","rfid":"20.012.2","context":"sales_contract_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1","options":null,"maxLength":100,"format":"100"}
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
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 20, 'Sales Contract', context,
  name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 17, 'options', options, 'max_length', "maxLength", 'format', format,
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
  '{"phase":17,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 20
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, location_role, label) AS (
  VALUES
    ('0600.0016','sales_contract','20.000','primary','Is There a Sales Contract'),
    ('0600.0010','sales_contract','20.001','primary','Sales Contract Information Analyzed'),
    ('0600.0002','sales_contract','20.002','primary','Arms Length Transaction'),
    ('0600.0003','sales_contract','20.003','primary','Non-Arms Length Commentary'),
    ('0600.0008','sales_contract','1.007','redisplay','Summary Contract Price'),
    ('0600.0008','sales_contract','20.004','primary','Contract Price'),
    ('0600.0008','sales_contract','22.01.04','redisplay','Sales Comparison Contract Price'),
    ('0600.0008','sales_contract','22.15.03','redisplay','Sales Comparison Summary Contract Price'),
    ('0600.0008','sales_contract','26.006','redisplay','Reconciliation Contract Price'),
    ('0600.0009','sales_contract','20.005','primary','Contract Date'),
    ('0600.0009','sales_contract','22.01.06','redisplay','Sales Comparison Contract Date'),
    ('0600.0017','sales_contract','20.006','primary','Transfer Terms'),
    ('0600.0018','sales_contract','20.006','primary','Other Transfer Terms'),
    ('0600.0004','sales_contract','20.007','primary','Personal Property Conveyed'),
    ('0600.0006','sales_contract','20.008','primary','Known Sales Concessions'),
    ('0600.0006','sales_contract','22.01.05','redisplay','Sales Comparison Sales Concessions Indicator'),
    ('0600.0005','sales_contract','20.009','primary','Total Sales Concessions Known'),
    ('0600.0005','sales_contract','22.01.05','redisplay','Sales Comparison Concession Amount Known'),
    ('0600.0011','sales_contract','20.009','primary','Total Sales Concessions'),
    ('0600.0011','sales_contract','22.01.05','redisplay','Sales Comparison Total Sales Concessions'),
    ('0600.0007','sales_contract','20.010','primary','Typical for Market'),
    ('0600.0014','sales_contract_commentary','20.011','primary','Sales Contract Analysis'),
    ('1400.0638','sales_contract_asset','20.012.1','primary','Sales Contract Exhibit'),
    ('1400.0640','sales_contract_asset','20.012.2','primary','Sales Contract Exhibit Caption')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
  CASE WHEN location_role = 'primary' THEN 20 ELSE split_part(report_field_id, '.', 1)::integer END,
  CASE WHEN location_role = 'primary' THEN 'Sales Contract'
       WHEN report_field_id LIKE '1.%' THEN 'Summary'
       WHEN report_field_id LIKE '22.%' THEN 'Sales Comparison Approach'
       ELSE 'Reconciliation' END,
  location_role,
  jsonb_build_object(
    'label', label, 'phase', 17,
    'source', 'Appendix A-1 v1.4, Appendix C-1 v1.3, and Appendix F-1 v1.4'
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
  ('uad-3.6-2026-08-13-h1.5','UAD1127','fatal','sales_contract','Indicate whether the total amount of sales concessions is known.','SalesConcessionAmountKnownIndicator is required when SalesConcessionIndicator is true.',ARRAY['20.009'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1128','fatal','sales_contract','Indicate the presence of sales concessions in the sales contract.','SalesConcessionIndicator is required when SalesContractReviewedIndicator is true.',ARRAY['20.008'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1129','fatal','sales_contract','Provide the Contract Price.','SalesContractAmount is required when SalesContractReviewedIndicator is true.',ARRAY['20.004'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1130','fatal','sales_contract','Provide the date the sales contract was fully executed.','SalesContractDate is required when SalesContractReviewedIndicator is true.',ARRAY['20.005'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1131','warning','sales_contract','The Contract Date cannot be after the Effective Date of Appraisal.','SalesContractDate must be less than or equal to AppraisalReportEffectiveDate.',ARRAY['20.005','26.011'],'{"phase":17,"source":"Appendix H-1 v1.5","implementation":"future_effective_date_cross_check"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1132','fatal','sales_contract','Indicate whether the appraiser reviewed and analyzed the sales contract.','SalesContractReviewedIndicator is required when SalesContractExistsIndicator is true.',ARRAY['20.001'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1133','fatal','sales_contract','Provide the Total Sales Concessions amount.','TotalSalesConcessionAmount is required when SalesConcessionAmountKnownIndicator is true.',ARRAY['20.009'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1134','fatal','sales_contract','Indicate whether there is a sales contract associated with the property.','SalesContractExistsIndicator is required.',ARRAY['20.000'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1135','fatal','sales_contract','Provide the Transfer Terms.','SaleType is required when SalesContractReviewedIndicator is true.',ARRAY['20.006'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1136','fatal','sales_contract','Provide a description when Transfer Terms is Other.','SaleTypeOtherDescription is required when SaleType is Other.',ARRAY['20.006'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1728','fatal','sales_contract','The Contract Date must include year, month, and day.','SalesContractDate must use YYYY-MM-DD.',ARRAY['20.005'],'{"phase":17,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-CONTRACT-001','fatal','sales_contract','A No contract answer cannot retain contract details.','Dependent contract values must be absent when SalesContractExistsIndicator is false.',ARRAY['20.000'],'{"phase":17,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-CONTRACT-002','fatal','sales_contract','Discrete contract terms require contract analysis.','Reviewed-only contract fields must be absent when SalesContractReviewedIndicator is false.',ARRAY['20.001','20.004','20.005','20.006','20.007','20.008'],'{"phase":17,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-CONTRACT-003','fatal','sales_contract','Concession details must agree with the concession indicators.','Amount-known, amount, and market-typical values follow the concession decision hierarchy.',ARRAY['20.008','20.009','20.010'],'{"phase":17,"source":"Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-CONTRACT-004','fatal','sales_contract_asset','Sales contract exhibits require an active sales contract.','Verified SalesContractExhibit images are not allowed when SalesContractExistsIndicator is false.',ARRAY['20.000','20.012.1'],'{"phase":17,"source":"Appendix F-1 v1.4","implementation":"server_asset_cross_check"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
