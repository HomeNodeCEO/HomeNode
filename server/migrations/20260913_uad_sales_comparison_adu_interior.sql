-- URAR Section 22J: ADU Interior Quality and Condition.
-- Additive UAD-only migration. Section 22J reuses the canonical Section 10
-- subject facts and the Section 22I comparable interior records, selecting
-- only units whose Accessory Dwelling Unit Indicator is true.

-- Every value below already has a canonical field definition. Section 22J
-- gives those values their ADU-specific URAR report locations rather than
-- creating duplicate database fields.
WITH locations(uid, property_context, report_field_id, label) AS (
  VALUES
    ('0300.0009','sales_comparison_subject_improvement','22.10.01','Subject ADU Improvement Type'),
    ('0300.0025','outbuilding','22.10.01','Subject ADU Outbuilding Type'),
    ('0300.0026','outbuilding','22.10.01','Subject ADU Other Outbuilding Type'),
    ('1800.0125','sales_comparable_dwelling','22.10.16','Comparable ADU Dwelling Improvement Type'),
    ('1800.0125','sales_comparable_outbuilding','22.10.16','Comparable ADU Outbuilding Improvement Type'),
    ('1800.0126','sales_comparable_outbuilding','22.10.16','Comparable ADU Outbuilding Type'),
    ('1800.0127','sales_comparable_outbuilding','22.10.16','Comparable ADU Other Outbuilding Type'),
    ('0700.0067','unit','22.10.02','Subject ADU Interior Quality Rating'),
    ('1800.0323','sales_comparison_subject_kitchen_summary','22.10.03','Subject ADU Kitchen Quality Summary'),
    ('1800.0294','sales_comparison_subject_unit_interior_summary','22.10.04','Subject ADU Overall Bathrooms Quality Summary'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.10.05','Subject ADU Overall Flooring Quality Summary'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.10.06','Subject ADU Walls and Ceiling Quality Summary'),
    ('0700.0047','unit_interior_feature','22.10.07','Subject ADU Other Interior Feature Label (Quality)'),
    ('1800.0293','sales_comparison_subject_interior_quality_summary','22.10.08','Subject ADU Other Interior Feature Quality Summary'),
    ('0700.0066','unit','22.10.09','Subject ADU Interior Condition Rating'),
    ('0700.0036','unit_room','22.10.10','Subject ADU Kitchen Update Status'),
    ('0700.0117','unit','22.10.11','Subject ADU Overall Bathrooms Update Status'),
    ('0700.0122','unit','22.10.12','Subject ADU Overall Flooring Update Status'),
    ('1800.0292','sales_comparison_subject_interior_condition_summary','22.10.13','Subject ADU Walls and Ceiling Condition Summary'),
    ('0700.0047','unit_interior_feature','22.10.14','Subject ADU Other Interior Feature Label (Condition)'),
    ('1800.0292','sales_comparison_subject_interior_condition_summary','22.10.15','Subject ADU Other Interior Feature Condition Summary'),
    ('1800.0158','sales_comparable_unit','22.10.17','Comparable ADU Interior Quality Rating'),
    ('1800.0327','sales_comparable_kitchen','22.10.18','Comparable ADU Kitchen Quality Summary'),
    ('1800.0329','sales_comparable_unit','22.10.19','Comparable ADU Overall Bathrooms Quality Summary'),
    ('1800.0146','sales_comparable_interior_component','22.10.20','Comparable ADU Overall Flooring Quality Summary'),
    ('1800.0146','sales_comparable_interior_component','22.10.21','Comparable ADU Walls and Ceiling Quality Summary'),
    ('1800.0148','sales_comparable_interior_component','22.10.07','Comparable ADU Other Interior Feature Label (Quality)'),
    ('1800.0146','sales_comparable_interior_component','22.10.22','Comparable ADU Other Interior Feature Quality Summary'),
    ('1800.0157','sales_comparable_unit','22.10.23','Comparable ADU Interior Condition Rating'),
    ('1800.0326','sales_comparable_kitchen','22.10.24','Comparable ADU Kitchen Update Status'),
    ('1800.0328','sales_comparable_unit','22.10.25','Comparable ADU Overall Bathrooms Update Status'),
    ('1800.0336','sales_comparable_interior_component','22.10.26','Comparable ADU Overall Flooring Update Status'),
    ('1800.0296','sales_comparable_interior_component','22.10.27','Comparable ADU Walls and Ceiling Condition Summary'),
    ('1800.0148','sales_comparable_interior_component','22.10.14','Comparable ADU Other Interior Feature Label (Condition)'),
    ('1800.0296','sales_comparable_interior_component','22.10.28','Comparable ADU Other Interior Feature Condition Summary')
)
INSERT INTO uad_ref.field_report_locations (
  release_key, uid, property_context, report_field_id,
  section_number, section_name, location_role, metadata
)
SELECT 'uad-3.6-2026-08-13-h1.5', uid, property_context, report_field_id,
       22, 'Sales Comparison Approach', 'redisplay',
       jsonb_build_object(
         'label', label, 'phase', 22, 'subphase', '22J-adu-interior-quality-condition',
         'source', 'Appendix A-1 v1.4, Appendix C-1 v1.3, and Appendix F-1 v1.4',
         'applicability', 'AccessoryDwellingUnitIndicator = true',
         'implementation', CASE
           WHEN property_context LIKE 'sales_comparison_subject_%' OR property_context IN ('unit','unit_room','unit_interior_feature','outbuilding')
             THEN 'canonical_subject_or_comparison_summary'
           ELSE 'canonical_comparable_structure_or_unit_child'
         END
       )
FROM locations
ON CONFLICT (release_key, uid, property_context, report_field_id) DO UPDATE
SET section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    location_role = EXCLUDED.location_role,
    metadata = EXCLUDED.metadata;

-- UAD1415 is the official comparable improvement-type rule that also drives
-- the Location of ADU row. UAD1419 and UAD1420 apply to both Sections 22I
-- and 22J; update their location arrays to make that shared scope explicit.
INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message,
  expression, report_field_ids, metadata
) VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1415','fatal','sales_comparable_structure','Indicate whether the structure is a Dwelling or Outbuilding.','ImprovementType is required for every sales-comparable structure.',ARRAY['22.07.18','22.10.16'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1419','fatal','sales_comparable_unit','Provide the interior condition rating.','InteriorConditionRatingCode is required for every applicable sales-comparable unit, including an ADU.',ARRAY['22.09.25','22.10.23'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1420','fatal','sales_comparable_unit','Provide the interior quality rating.','InteriorQualityRatingCode is required for every applicable sales-comparable unit, including an ADU.',ARRAY['22.09.19','22.10.17'],'{"phase":22,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADU-001','fatal','sales_comparable_unit','ADU interior rows must retain their structure and unit hierarchy.','An ADU belongs to a comparable dwelling or real-property outbuilding and uses the parent structure type as Location of ADU.',ARRAY['22.10.16'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADU-002','fatal','sales_comparable_unit','Every comparable ADU requires its complete interior comparison.','Require Q/C ratings, a kitchen row, and exactly one Flooring and Walls and Ceiling row for every unit marked as an ADU.',ARRAY['22.10.17','22.10.18','22.10.20','22.10.21','22.10.23'],'{"phase":22,"source":"Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SALES-COMPARISON-ADU-003','fatal','sales_comparison_subject_unit_interior_summary','Provide the subject ADU comparison-only summaries.','Attach bathroom, kitchen, component quality, and component condition summaries to the canonical Section 10 ADU records.',ARRAY['22.10.03','22.10.04','22.10.05','22.10.06','22.10.08','22.10.13','22.10.15'],'{"phase":22,"source":"Appendix A-1 v1.4 and Appendix F-1 v1.4","implementation":"server_cross_entity"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
