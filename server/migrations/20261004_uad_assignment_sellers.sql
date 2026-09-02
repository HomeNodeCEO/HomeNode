-- URAR Section 2 seller parties.
-- Sellers are repeatable MISMO PARTY records. Existing root seller values are
-- moved into one seller entity without changing their values or provenance.

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
    'assignment_contact', 'assignment_seller'
  ));

WITH seller_workfiles AS (
  SELECT DISTINCT value.workfile_id
    FROM appraisal.uad_field_values value
   WHERE value.entity_id IS NULL
     AND value.field_context = 'seller'
     AND value.uad_uid IN (
       '1000.0018', '1000.0172', '1000.0019', '1000.0173',
       '1000.0020', '1000.0021', '1000.0116'
     )
)
INSERT INTO appraisal.uad_entities (
  id, workfile_id, parent_entity_id, entity_type, entity_identifier,
  ordinal, label, data
)
SELECT
  gen_random_uuid(),
  workfile.workfile_id,
  NULL,
  'assignment_seller',
  'assignment-seller-migrated-root',
  COALESCE((
    SELECT MAX(existing.ordinal)
      FROM appraisal.uad_entities existing
     WHERE existing.workfile_id = workfile.workfile_id
       AND existing.entity_type = 'assignment_seller'
  ), 0) + 1,
  'Seller 1',
  '{"source":"migrated_root_seller"}'::jsonb
FROM seller_workfiles workfile
ON CONFLICT (workfile_id, entity_type, entity_identifier) DO NOTHING;

UPDATE appraisal.uad_field_values value
   SET entity_id = seller.id,
       updated_at = now()
  FROM appraisal.uad_entities seller
 WHERE value.workfile_id = seller.workfile_id
   AND seller.entity_type = 'assignment_seller'
   AND seller.entity_identifier = 'assignment-seller-migrated-root'
   AND value.entity_id IS NULL
   AND value.field_context = 'seller'
   AND value.uad_uid IN (
     '1000.0018', '1000.0172', '1000.0019', '1000.0173',
     '1000.0020', '1000.0021', '1000.0116'
   );

UPDATE uad_ref.fields
   SET metadata = metadata || '{"repeatable_entity_type":"assignment_seller"}'::jsonb
 WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
   AND property_context = 'seller'
   AND uid IN (
     '1000.0018', '1000.0172', '1000.0019', '1000.0173',
     '1000.0020', '1000.0021', '1000.0116'
   );
