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
    'additional_requested_conditional_valuation',
    'assignment_contact'
  ));

WITH catalog(uid, rfid, context, name, type, required, options) AS (
  VALUES
    ('1000.0103', '2.001', 'borrower', 'PartyRoleType', 'Enumerated', false, '["Borrower"]'::jsonb),
    ('1000.0105', '2.001', 'borrower', 'PartyRoleType', 'Enumerated', false, '["Borrower"]'::jsonb),
    ('1000.0021', '2.002', 'seller', 'PartyRoleType', 'Enumerated', false, '["PropertySeller"]'::jsonb),
    ('1000.0116', '2.002', 'seller', 'PartyRoleType', 'Enumerated', false, '["PropertySeller"]'::jsonb),
    ('2400.0018', '2.010', 'assignment_client_primary_role', 'PartyRoleType', 'Enumerated', true, '["Client"]'::jsonb),
    ('2400.0017', '2.011', 'assignment_client_type_role', 'PartyRoleType', 'Enumerated', true, '["Attorney","Investor","Lender","ManagementCompany","Other"]'::jsonb),
    ('2400.0077', '2.011', 'assignment_client_type_role', 'PartyRoleTypeOtherDescription', 'String', false, NULL::jsonb),
    ('2400.0013', '2.012', 'assignment_client_name', 'FullName', 'String', true, NULL::jsonb),
    ('2400.0001', '2.013', 'assignment_client_address', 'AddressLineText', 'String', true, NULL::jsonb),
    ('2400.0002', '2.013', 'assignment_client_address', 'CityName', 'String', true, NULL::jsonb),
    ('2400.0004', '2.013', 'assignment_client_address', 'StateCode', 'String', true, NULL::jsonb),
    ('2400.0003', '2.013', 'assignment_client_address', 'PostalCode', 'String', true, NULL::jsonb)
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 2, 'Assignment Information',
  context, name, type, CASE WHEN required THEN 'Required' ELSE 'Conditional' END,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 'document_evidence',
    'options', options,
    'official_source', 'Appendix B-1 URAR Implementation Guide v1.4'
  ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_point_name = EXCLUDED.data_point_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
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
  '{"phase":"document_evidence"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.uid IN ('1000.0103', '1000.0105', '1000.0021', '1000.0116', '2400.0018', '2400.0017')
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;
