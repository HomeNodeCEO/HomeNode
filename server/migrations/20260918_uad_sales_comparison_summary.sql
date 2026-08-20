-- URAR Section 22O: Summary and Indicated Value by Sales Comparison Approach.
-- Additive UAD-only migration. Existing listing, contract, sale, adjustment,
-- unit, and area values remain canonical; Summary adds delivery locations and
-- server-calculated results without changing legacy HomeNode data.

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1800.0313","rfid":"22.15.08","name":"SalePriceNetTotalAdjustmentAmount","type":"Amount","requirement":"Conditional Required","cardinality":"1:1","options":null,"format":"±9.0","implementation":"server_calculated"},
    {"uid":"1800.0311","rfid":"22.15.09","name":"AdjustedSalesPricePerUnitAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"format":"+9.0","implementation":"server_calculated"},
    {"uid":"1800.0310","rfid":"22.15.10","name":"AdjustedSalesPricePerBedroomAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"format":"+9.0","implementation":"server_calculated"},
    {"uid":"1800.0314","rfid":"22.15.11","name":"PricePerUnitOfMeasureTypeForTotalFinishedAreaOfAllLivingUnitsIncludingADUAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"format":"+9.0","implementation":"server_calculated"},
    {"uid":"1800.0315","rfid":"22.15.12","name":"PricePerTotalStandardAboveGradeFinishedAreaAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"format":"+9.0","implementation":"server_calculated"},
    {"uid":"1800.0309","rfid":"22.15.13","name":"AdjustedSalesPriceAmount","type":"Amount","requirement":"Conditional Required","cardinality":"1:1","options":null,"format":"+9.2","implementation":"server_calculated"},
    {"uid":"1800.0312","rfid":"22.15.14","name":"ComparableWeightType","type":"Enumerated","requirement":"Conditional Required","cardinality":"1:1","options":["Most","Less","NoWeight"],"format":null,"implementation":"appraiser_input"}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, name text, type text, requirement text,
    cardinality text, options jsonb, format text, implementation text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 22, 'Sales Comparison Approach',
       'sales_comparable_summary', name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 22, 'subphase', '22O-summary', 'options', options,
         'format', format, 'implementation', implementation,
         'parent_entity_type', 'sales_comparable',
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

INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
) VALUES (
  'uad-3.6-2026-08-13-h1.5', '1300.0006', '22.15.15', 22,
  'Sales Comparison Approach', 'sales_comparison_summary',
  'ValueIndicatedBySalesComparisonAmount', 'Amount', 'Conditional Required', '0:1',
  '{"phase":22,"subphase":"22O-indicated-value","format":"+9.0","implementation":"appraiser_input","source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
)
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
       CASE option.value WHEN 'NoWeight' THEN 'No Weight' ELSE option.value END,
       option.ordinality,
       jsonb_build_object('phase', 22, 'subphase', '22O-summary', 'source', 'Appendix A-1 URAR Delivery Specification 1.4')
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.uid = '1800.0312'
  AND field.property_context = 'sales_comparable_summary'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

-- Summary redisplays canonical values from Sections 19, 20, and 22A. The
-- subject listing status accompanies the most recent list price for delivery
-- condition evaluation but does not introduce a separate editable grid value.
WITH locations(uid, property_context, report_field_id, label, canonical_section) AS (
  VALUES
    ('0900.0008','subject_listing','22.15.02','Subject List Price',19),
    ('0900.0013','subject_listing','22.15.02','Subject Listing Status',19),
    ('0600.0008','sales_contract','22.15.03','Subject Contract Price',20),
    ('1800.0074','sales_comparable_listing','22.15.05','Comparable List Price',22),
    ('1800.0384','sales_comparable_contract','22.15.06','Comparable Contract Price Unknown',22),
    ('1800.0271','sales_comparable_contract','22.15.06','Comparable Contract Price',22),
    ('1800.0272','sales_comparable_sale','22.15.07','Comparable Sale Price',22)
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22O-summary-redisplay',
         'canonical_section', canonical_section,
         'source', 'Appendix A-1 v1.4 and Appendix F-1 URAR Reference Guide v1.4'
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1800.0313','sales_comparable_summary','22.15.08','Net Adjustment Total'),
    ('1800.0311','sales_comparable_summary','22.15.09','Adjusted Price Per Unit'),
    ('1800.0310','sales_comparable_summary','22.15.10','Adjusted Price Per Bedroom'),
    ('1800.0314','sales_comparable_summary','22.15.11','Price Per Gross Building Finished Area'),
    ('1800.0315','sales_comparable_summary','22.15.12','Price Per Finished Area Above Grade'),
    ('1800.0309','sales_comparable_summary','22.15.13','Adjusted Price'),
    ('1800.0312','sales_comparable_summary','22.15.14','Comparable Weight'),
    ('1300.0006','sales_comparison_summary','22.15.15','Indicated Value')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'primary',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22O-summary',
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
  ('uad-3.6-2026-08-13-h1.5','UAD1253','fatal','sales_comparison_summary','Provide the value of the subject property as determined by the Sales Comparison Approach method of property valuation.','If SalesComparisonApproachIndicator is true, ValueIndicatedBySalesComparisonAmount is provided.',ARRAY['22.15.15'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"catalog_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1456','fatal','sales_comparable_summary','Provide the Adjusted Price for the sales comparable.','Each SalesComparable provides AdjustedSalesPriceAmount.',ARRAY['22.15.13'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1457','warning','sales_comparable_summary','The Adjusted Price Per Bedroom must be provided for a sales comparable with more than one living unit.','When LivingUnitExcludingADUCount is greater than one, AdjustedSalesPricePerBedroomAmount is provided.',ARRAY['22.15.10'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1458','warning','sales_comparable_summary','The Adjusted Price Per Unit must be provided for a sales comparable with more than one living unit.','When LivingUnitExcludingADUCount is greater than one, AdjustedSalesPricePerUnitAmount is provided.',ARRAY['22.15.09'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1459','fatal','sales_comparable_summary','Provide the Comparable Weight for the sales comparable.','Each SalesComparable provides ComparableWeightType.',ARRAY['22.15.14'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"catalog_required"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1460','fatal','sales_comparable_summary','Provide the Net Adjustment Total.','Each SalesComparable provides SalePriceNetTotalAdjustmentAmount, including zero.',ARRAY['22.15.08'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1461','fatal','sales_comparable_summary','The Net Adjustment Total must equal the sum of the individual adjustments.','SalePriceNetTotalAdjustmentAmount equals the sum of ComparableAdjustmentAmount across all adjustment instances.',ARRAY['22.15.08'],'{"phase":22,"source":"Appendix H-1 UAD Compliance Rules v1.5","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SUMMARY-001','fatal','sales_comparable_summary','Summary calculations are owned by the server and cannot diverge from their canonical inputs.','Net adjustment and adjusted-price fields are recomputed for every Section 22 save and editor read.',ARRAY['22.15.08','22.15.09','22.15.10','22.15.11','22.15.12','22.15.13'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SUMMARY-002','fatal','sales_comparable_summary','Adjusted Price must use the correct transaction basis.','Settled sales use Sale Price plus Net Adjustment Total; all other listing statuses use List Price plus Net Adjustment Total.',ARRAY['22.15.07','22.15.08','22.15.13'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SUMMARY-003','fatal','sales_comparable_summary','Price-per-area calculations must use the required transaction-price precedence and canonical areas.','Use Sale Price for settled sales, otherwise known Contract Price, otherwise List Price; divide by the applicable canonical finished area.',ARRAY['22.15.11','22.15.12'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_calculated"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-SUMMARY-004','fatal','sales_comparison_summary','Indicated Value is an appraiser conclusion and is not derived from a mechanical average.','The appraiser enters Indicated Value after assigning each comparable Most, Less, or No Weight.',ARRAY['22.15.14','22.15.15'],'{"phase":22,"source":"Appendix F-1 URAR Reference Guide v1.4","implementation":"server_cross_field"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
