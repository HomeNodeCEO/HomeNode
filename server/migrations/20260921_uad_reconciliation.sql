-- URAR Section 26: Reconciliation.
-- Additive UAD-only migration. Existing Custom Appraisal, property-search, and
-- Property Tax Protest records are not changed. Section 26 reads canonical
-- approach values and subject-defect records from their owning UAD sections.

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
    'sales_comparison_additional_property',
    'additional_requested_conditional_valuation'
  ));

WITH catalog AS (
  SELECT * FROM jsonb_to_recordset($catalog$
  [
    {"uid":"1300.0007","rfid":"Does Not Display","context":"sales_comparison_exclusion","name":"ValuationApproachExclusionReasonType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:unbounded","options":["Other"],"maxLength":null,"format":null},
    {"uid":"1300.0008","rfid":"26.001","context":"sales_comparison_exclusion","name":"ValuationApproachExclusionReasonTypeOtherDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":225,"format":"225"},
    {"uid":"1000.0030","rfid":"Does Not Display","context":"scope_of_work","name":"IncomeApproachIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1200.0004","rfid":"26.002","context":"income_approach_summary","name":"ValueIndicatedByIncomeApproachAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.0"},
    {"uid":"1300.0004","rfid":"26.003","context":"income_approach_exclusion","name":"ValuationApproachExclusionReasonType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:unbounded","options":["InsufficientData","NotNecessaryForCredibleResults","Other"],"maxLength":null,"format":null},
    {"uid":"1300.0005","rfid":"26.003","context":"income_approach_exclusion","name":"ValuationApproachExclusionReasonTypeOtherDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":225,"format":"225"},
    {"uid":"1000.0027","rfid":"Does Not Display","context":"scope_of_work","name":"CostApproachIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1300.0001","rfid":"26.004","context":"cost_approach_summary","name":"ValueIndicatedByCostApproachAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+9.0"},
    {"uid":"1300.0002","rfid":"26.005","context":"cost_approach_exclusion","name":"ValuationApproachExclusionReasonType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:unbounded","options":["DifficultyEstimatingDepreciation","LackOfLandSales","NotNecessaryForCredibleResults","Other"],"maxLength":null,"format":null},
    {"uid":"1300.0003","rfid":"26.005","context":"cost_approach_exclusion","name":"ValuationApproachExclusionReasonTypeOtherDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":225,"format":"225"},
    {"uid":"1300.0017","rfid":"26.007","context":"reconciliation","name":"OpinionOfValueAmount","type":"Amount","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+9.0"},
    {"uid":"1300.0033","rfid":"26.008","context":"reconciliation","name":"LineOfCreditProRataShareSelectionMethodType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:1","options":["Drawn","Maximum"],"maxLength":null,"format":null},
    {"uid":"1300.0010","rfid":"26.009","context":"reconciliation","name":"PropertyValuationConditionalConclusionType","type":"Enumerated","requirement":"Required","cardinality":"1:unbounded","options":["AsIs","SubjectToCompletionPerPlans","SubjectToInspection","SubjectToRepair"],"maxLength":null,"format":null},
    {"uid":"1300.0013","rfid":"26.010","context":"reconciliation","name":"MarketingOrExposureDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0014","rfid":"26.010","context":"reconciliation","name":"MarketingOrExposureHighRangeDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0015","rfid":"26.010","context":"reconciliation","name":"MarketingOrExposureLowRangeDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0012","rfid":"26.011","context":"reconciliation","name":"AppraisalReportEffectiveDate","type":"Date","requirement":"Required","cardinality":"1:1","options":null,"maxLength":null,"format":"YYYY-MM-DD"},
    {"uid":"1300.0020","rfid":"26.012","context":"reconciliation","name":"FHA_REOInsurabilityLevelCode","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":["Insurable","InsurableWithRepairEscrow","Uninsurable"],"maxLength":28,"format":"28"},
    {"uid":"1300.0019","rfid":"Does Not Display","context":"reconciliation","name":"AdditionalClientRequestedConditionsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1","options":["false","true"],"maxLength":null,"format":null},
    {"uid":"1300.0022","rfid":"26.014","context":"additional_requested_conditional_valuation","name":"PropertyValuationConditionalConclusionType","type":"Enumerated","requirement":"Conditional Required","cardinality":"1:unbounded","options":["AsIs","SubjectToCompletionPerPlans","SubjectToInspection","SubjectToRepair"],"maxLength":null,"format":null},
    {"uid":"1300.0026","rfid":"26.015","context":"additional_requested_conditional_valuation","name":"MarketingOrExposureTimeType","type":"Enumerated","requirement":"Conditional Required","cardinality":"1:1","options":["ClientImposedRestrictedMarketingTime","ReasonableExposureTime"],"maxLength":null,"format":null},
    {"uid":"1300.0023","rfid":"26.016","context":"additional_requested_conditional_valuation","name":"MarketingOrExposureDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0024","rfid":"26.016","context":"additional_requested_conditional_valuation","name":"MarketingOrExposureHighRangeDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0025","rfid":"26.016","context":"additional_requested_conditional_valuation","name":"MarketingOrExposureLowRangeDaysCount","type":"Numeric","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+4.0"},
    {"uid":"1300.0027","rfid":"26.017","context":"additional_requested_conditional_valuation","name":"AdditionalOpinionOfValueAmount","type":"Amount","requirement":"Conditional Required","cardinality":"1:1","options":null,"maxLength":null,"format":"+9.0"},
    {"uid":"1300.0029","rfid":"26.018","context":"reconciliation","name":"AdditionalClientRequestedConditionsCommentDescription","type":"String","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":2500,"format":"2500"},
    {"uid":"1300.0021","rfid":"26.019","context":"reconciliation","name":"ValuationReconciliationSummaryCommentDescription","type":"String","requirement":"Required","cardinality":"1:1","options":null,"maxLength":5000,"format":"5000"},
    {"uid":"3900.0001","rfid":"Does Not Display","context":"defect_summary","name":"CostToRepairType","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:1","options":["Itemized","None","TotalCost"],"maxLength":null,"format":null},
    {"uid":"3900.0126","rfid":"26.026","context":"site_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0014","rfid":"26.033","context":"dwelling_exterior_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0134","rfid":"26.041 / 26.057","context":"unit_interior_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0168","rfid":"26.049","context":"outbuilding_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0182","rfid":"26.063","context":"vehicle_storage_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0140","rfid":"26.069","context":"subject_property_amenity_defect","name":"DefectItemEstimatedCostToRepairAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+7.0"},
    {"uid":"3900.0002","rfid":"26.070 / 26.072","context":"defect_summary","name":"DefectCostToRepairTotalAmount","type":"Amount","requirement":"Conditional Required","cardinality":"0:1","options":null,"maxLength":null,"format":"+8.0"},
    {"uid":"1300.0034","rfid":"26.071","context":"reconciliation","name":"PropertyAsIsConditionRatingCode","type":"Enumerated","requirement":"Conditional Required","cardinality":"0:1","options":["C1","C2","C3","C4","C5","C6"],"maxLength":null,"format":null}
  ] $catalog$::jsonb) AS row(
    uid text, rfid text, context text, name text, type text, requirement text,
    cardinality text, options jsonb, "maxLength" integer, format text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, rfid, 26, 'Reconciliation',
       context, name, type, requirement, cardinality,
       jsonb_strip_nulls(jsonb_build_object(
         'phase', 26, 'options', options, 'max_length', "maxLength", 'format', format,
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
       '{"phase":26,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 26
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('1300.0007','sales_comparison_exclusion','Does Not Display','Sales Comparison Approach Exclusion Reason'),
    ('1300.0008','sales_comparison_exclusion','26.001','Other Sales Comparison Approach Exclusion Reason'),
    ('1000.0030','scope_of_work','Does Not Display','Income Approach Indicator'),
    ('1200.0004','income_approach_summary','26.002','Income Approach Indicated Value'),
    ('1300.0004','income_approach_exclusion','26.003','Income Approach Exclusion Reason'),
    ('1300.0005','income_approach_exclusion','26.003','Other Income Approach Exclusion Reason'),
    ('1000.0027','scope_of_work','Does Not Display','Cost Approach Indicator'),
    ('1300.0001','cost_approach_summary','26.004','Cost Approach Indicated Value'),
    ('1300.0002','cost_approach_exclusion','26.005','Cost Approach Exclusion Reason'),
    ('1300.0003','cost_approach_exclusion','26.005','Other Cost Approach Exclusion Reason'),
    ('1300.0017','reconciliation','26.007','Opinion of Market Value'),
    ('1300.0033','reconciliation','26.008','Pro Rata Share Calculation Method'),
    ('1300.0010','reconciliation','26.009','Market Value Condition'),
    ('1300.0013','reconciliation','26.010','Reasonable Exposure Time'),
    ('1300.0014','reconciliation','26.010','Reasonable Exposure Time High'),
    ('1300.0015','reconciliation','26.010','Reasonable Exposure Time Low'),
    ('1300.0012','reconciliation','26.011','Effective Date of Appraisal'),
    ('1300.0020','reconciliation','26.012','FHA REO Insurability Level'),
    ('1300.0019','reconciliation','Does Not Display','Additional Client Requested Conditions Indicator'),
    ('1300.0022','additional_requested_conditional_valuation','26.014','Client Requested Value Condition'),
    ('1300.0026','additional_requested_conditional_valuation','26.015','Client Requested Marketing or Exposure Time'),
    ('1300.0023','additional_requested_conditional_valuation','26.016','Client Requested Duration'),
    ('1300.0024','additional_requested_conditional_valuation','26.016','Client Requested Duration High'),
    ('1300.0025','additional_requested_conditional_valuation','26.016','Client Requested Duration Low'),
    ('1300.0027','additional_requested_conditional_valuation','26.017','Alternate Opinion of Value'),
    ('1300.0029','reconciliation','26.018','Requested Condition Commentary'),
    ('1300.0021','reconciliation','26.019','Reconciliation of Market Value'),
    ('3900.0001','defect_summary','Does Not Display','Cost to Repair Reporting Method'),
    ('3900.0126','site_defect','26.026','Site Estimated Cost to Repair'),
    ('3900.0014','dwelling_exterior_defect','26.033','Dwelling Exterior Estimated Cost to Repair'),
    ('3900.0134','unit_interior_defect','26.041','Dwelling Unit Interior Estimated Cost to Repair'),
    ('3900.0134','unit_interior_defect','26.057','Outbuilding Unit Interior Estimated Cost to Repair'),
    ('3900.0168','outbuilding_defect','26.049','Outbuilding Estimated Cost to Repair'),
    ('3900.0182','vehicle_storage_defect','26.063','Vehicle Storage Estimated Cost to Repair'),
    ('3900.0140','subject_property_amenity_defect','26.069','Amenity Estimated Cost to Repair'),
    ('3900.0002','defect_summary','26.070','Calculated Itemized Repair Total'),
    ('3900.0002','defect_summary','26.072','Total Estimated Cost of Items Requiring Repair'),
    ('1300.0034','reconciliation','26.071','As Is Overall Condition Rating')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       26, 'Reconciliation', 'primary',
       jsonb_build_object('label', label, 'phase', 26,
         'source', 'Appendix A-1 v1.4 and Appendix F-1 URAR Reference Guide v1.4')
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
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-RECONCILIATION-001','fatal','reconciliation','Provide one reasonable exposure duration or a complete low and high range.','MarketingOrExposureDaysCount is mutually exclusive with the low/high range; a range contains both values and Low <= High.',ARRAY['26.010'],'{"phase":26,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_field"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-RECONCILIATION-002','fatal','reconciliation','Market Value Condition must be consistent with every defect recommended action.','AsIs is exclusive; Completion, Inspection, and Repair actions require their corresponding subject-to condition; SubjectToInspection and SubjectToRepair require a matching defect action.',ARRAY['26.009','26.020','26.071'],'{"phase":26,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-RECONCILIATION-003','fatal','reconciliation','Every developed approach must have its canonical indicated value; every excluded approach must have an official exclusion reason.','Approach indicators control the mutually exclusive indicated-value and exclusion-reason branches.',ARRAY['26.000','26.001','26.002','26.003','26.004','26.005'],'{"phase":26,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_section"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-RECONCILIATION-004','fatal','additional_requested_conditional_valuation','Client requested conditions must agree with their indicator and contain a value condition, duration, alternate opinion, and commentary.','The indicator is true exactly when one or more complete additional requested conditional valuations are present.',ARRAY['26.014','26.015','26.016','26.017','26.018'],'{"phase":26,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-RECONCILIATION-005','fatal','defect_summary','Cost-to-repair fields must follow the selected official reporting method.','A defect record requires None, TotalCost, or Itemized. TotalCost requires one total; Itemized requires each Repair item amount and a server-calculated total.',ARRAY['26.026','26.033','26.041','26.049','26.057','26.063','26.069','26.070','26.072'],'{"phase":26,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity_calculation"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
