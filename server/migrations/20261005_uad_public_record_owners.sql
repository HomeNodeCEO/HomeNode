-- URAR Section 2 current owners of public record.
-- Existing workfiles are repaired only when they do not already contain owner
-- values. New workfiles capture the same data in their immutable subject snapshot.

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
    'assignment_contact', 'assignment_seller', 'assignment_owner'
  ));

-- Preserve any owner values entered before the group became repeatable.
WITH owner_workfiles AS (
  SELECT DISTINCT value.workfile_id
    FROM appraisal.uad_field_values value
   WHERE value.entity_id IS NULL
     AND value.field_context = 'owner'
     AND value.uad_uid IN ('1000.0022', '1000.0174', '1000.0023', '1000.0175', '1000.0024')
)
INSERT INTO appraisal.uad_entities (
  id, workfile_id, parent_entity_id, entity_type, entity_identifier,
  ordinal, label, data
)
SELECT gen_random_uuid(), workfile.workfile_id, NULL, 'assignment_owner',
       'assignment-owner-migrated-root', 1, 'Current owner of public record',
       '{"source":"migrated_root_owner"}'::jsonb
  FROM owner_workfiles workfile
ON CONFLICT (workfile_id, entity_type, entity_identifier) DO NOTHING;

UPDATE appraisal.uad_field_values value
   SET entity_id = owner.id,
       updated_at = now()
  FROM appraisal.uad_entities owner
 WHERE value.workfile_id = owner.workfile_id
   AND owner.entity_type = 'assignment_owner'
   AND owner.entity_identifier = 'assignment-owner-migrated-root'
   AND value.entity_id IS NULL
   AND value.field_context = 'owner'
   AND value.uad_uid IN ('1000.0022', '1000.0174', '1000.0023', '1000.0175', '1000.0024');

CREATE TEMP TABLE uad_public_owner_backfill ON COMMIT DROP AS
WITH latest_party_year AS (
  SELECT workfile.id AS workfile_id, MAX(party.tax_year) AS tax_year
    FROM appraisal.uad_workfiles workfile
    JOIN core.owner_parties party ON party.account_id = workfile.account_id
   WHERE NULLIF(btrim(party.owner_name), '') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM appraisal.uad_entities existing
        WHERE existing.workfile_id = workfile.id
          AND existing.entity_type = 'assignment_owner'
     )
   GROUP BY workfile.id
), party_source AS (
  SELECT workfile.id AS workfile_id, party.id AS source_order,
         party.tax_year, party.owner_name, party.ownership_pct,
         'core.owner_parties:' || party.id::text AS source_reference
    FROM appraisal.uad_workfiles workfile
    JOIN latest_party_year latest ON latest.workfile_id = workfile.id
    JOIN core.owner_parties party
      ON party.account_id = workfile.account_id
     AND party.tax_year = latest.tax_year
   WHERE NULLIF(btrim(party.owner_name), '') IS NOT NULL
), summary_source AS (
  SELECT workfile.id AS workfile_id, part.ordinality::bigint AS source_order,
         summary.tax_year, part.owner_name, NULL::numeric AS ownership_pct,
         'core.owner_summary:' || summary.tax_year::text AS source_reference
    FROM appraisal.uad_workfiles workfile
    JOIN LATERAL (
      SELECT owner.tax_year, owner.owner_name
        FROM core.owner_summary owner
       WHERE owner.account_id = workfile.account_id
         AND NULLIF(btrim(owner.owner_name), '') IS NOT NULL
       ORDER BY owner.tax_year DESC
       LIMIT 1
    ) summary ON true
    CROSS JOIN LATERAL regexp_split_to_table(
      summary.owner_name,
      CASE
        WHEN summary.owner_name ~* '\m(bank|company|co\.?|corp(oration)?\.?|inc(orporated)?\.?|llc|l\.l\.c\.?|llp|lp|ltd\.?|trust|trustee|estate|association|holdings?|partners?|partnership|properties|foundation|church)\M'
          THEN '$^'
        ELSE '\s+(&|and)\s+|\s*/\s*|\s*;\s*'
      END,
      'i'
    ) WITH ORDINALITY AS part(owner_name, ordinality)
   WHERE NOT EXISTS (SELECT 1 FROM latest_party_year latest WHERE latest.workfile_id = workfile.id)
     AND NOT EXISTS (
       SELECT 1 FROM appraisal.uad_entities existing
        WHERE existing.workfile_id = workfile.id
          AND existing.entity_type = 'assignment_owner'
     )
), combined AS (
  SELECT * FROM party_source
  UNION ALL
  SELECT * FROM summary_source
), numbered AS (
  SELECT combined.*,
         row_number() OVER (PARTITION BY workfile_id ORDER BY source_order)::integer AS ordinal
    FROM combined
   WHERE NULLIF(btrim(owner_name), '') IS NOT NULL
)
SELECT numbered.*,
       regexp_split_to_array(
         regexp_replace(btrim(owner_name), '[^[:alnum:]''-]+', ' ', 'g'),
         '\s+'
       ) AS name_parts,
       owner_name ~* '\m(bank|company|co\.?|corp(oration)?\.?|inc(orporated)?\.?|llc|l\.l\.c\.?|llp|lp|ltd\.?|trust|trustee|estate|association|holdings?|partners?|partnership|properties|foundation|church)\M' AS is_legal_entity
  FROM numbered
 WHERE ordinal <= 20;

INSERT INTO appraisal.uad_entities (
  id, workfile_id, parent_entity_id, entity_type, entity_identifier,
  ordinal, label, data
)
SELECT gen_random_uuid(), source.workfile_id, NULL, 'assignment_owner',
       'public-record-owner-' || source.ordinal::text,
       source.ordinal, btrim(source.owner_name),
       jsonb_build_object(
         'source', 'homenodedb_public_record_backfill',
         'source_reference', source.source_reference,
         'source_tax_year', source.tax_year,
         'ownership_percent', source.ownership_pct
       )
  FROM uad_public_owner_backfill source
 WHERE source.is_legal_entity OR array_length(source.name_parts, 1) >= 2
ON CONFLICT (workfile_id, entity_type, entity_identifier) DO NOTHING;

-- Legal entities retain the exact public-record name.
INSERT INTO appraisal.uad_field_values (
  id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
  value, source_type, source_reference, source_observed_at, is_appraiser_confirmed
)
SELECT gen_random_uuid(), source.workfile_id, owner.id, 'owner', '1000.0024', '2.003',
       to_jsonb(btrim(source.owner_name)), 'public_record', source.source_reference, now(), false
  FROM uad_public_owner_backfill source
  JOIN appraisal.uad_entities owner
    ON owner.workfile_id = source.workfile_id
   AND owner.entity_type = 'assignment_owner'
   AND owner.entity_identifier = 'public-record-owner-' || source.ordinal::text
 WHERE source.is_legal_entity
ON CONFLICT DO NOTHING;

-- Appraisal-district individual names are normally LAST FIRST MIDDLE. Mixed-case
-- names are treated as FIRST MIDDLE LAST; every value remains appraiser-editable.
INSERT INTO appraisal.uad_field_values (
  id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
  value, source_type, source_reference, source_observed_at, is_appraiser_confirmed
)
SELECT gen_random_uuid(), source.workfile_id, owner.id, 'owner', mapped.uid, '2.003',
       to_jsonb(mapped.field_value), 'public_record', source.source_reference, now(), false
  FROM uad_public_owner_backfill source
  JOIN appraisal.uad_entities owner
    ON owner.workfile_id = source.workfile_id
   AND owner.entity_type = 'assignment_owner'
   AND owner.entity_identifier = 'public-record-owner-' || source.ordinal::text
  CROSS JOIN LATERAL (
    SELECT array_length(source.name_parts, 1) AS part_count,
           upper(source.name_parts[array_length(source.name_parts, 1)]) IN ('JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V') AS has_suffix
  ) shape
  CROSS JOIN LATERAL (
    SELECT CASE WHEN shape.has_suffix THEN shape.part_count - 1 ELSE shape.part_count END AS core_end
  ) parsed
  CROSS JOIN LATERAL (VALUES
    ('1000.0022', CASE WHEN source.owner_name <> upper(source.owner_name) THEN source.name_parts[1] ELSE source.name_parts[2] END),
    ('1000.0023', CASE WHEN source.owner_name <> upper(source.owner_name)
      THEN source.name_parts[parsed.core_end] ELSE source.name_parts[1] END),
    ('1000.0174', CASE
      WHEN source.owner_name <> upper(source.owner_name) AND parsed.core_end > 2
        THEN array_to_string(source.name_parts[2:(parsed.core_end - 1)], ' ')
      WHEN source.owner_name = upper(source.owner_name) AND parsed.core_end > 2
        THEN array_to_string(source.name_parts[3:parsed.core_end], ' ')
      ELSE NULL
    END),
    ('1000.0175', CASE WHEN shape.has_suffix THEN regexp_replace(source.name_parts[shape.part_count], '\.$', '') ELSE NULL END)
  ) mapped(uid, field_value)
 WHERE NOT source.is_legal_entity
   AND array_length(source.name_parts, 1) >= 2
   AND NULLIF(btrim(mapped.field_value), '') IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE uad_ref.fields
   SET metadata = metadata || '{"repeatable_entity_type":"assignment_owner"}'::jsonb
 WHERE release_key = 'uad-3.6-2026-08-13-h1.5'
   AND property_context = 'owner'
   AND uid IN ('1000.0022', '1000.0174', '1000.0023', '1000.0175', '1000.0024');
