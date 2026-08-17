ALTER TABLE appraisal.uad_entities
  DROP CONSTRAINT IF EXISTS uad_entities_entity_type_check;

ALTER TABLE appraisal.uad_entities
  ADD CONSTRAINT uad_entities_entity_type_check
  CHECK (entity_type IN (
    'property', 'dwelling', 'manufactured_home', 'unit', 'adu', 'outbuilding',
    'vehicle_storage', 'amenity', 'sales_comparable', 'rental_comparable',
    'grm_comparable', 'land_comparable', 'analyzed_not_used',
    'site_parcel', 'site_influence', 'site_view', 'site_encumbrance',
    'site_feature', 'site_utility', 'site_defect'
  ));

WITH catalog(uid, rfid, context_key, entity_type, data_type, requirement) AS (
  VALUES
    ('1500.0093','4.000','site',NULL,'Measurement','Conditional'),
    ('1500.0160','4.001','site',NULL,'String','Conditional'),
    ('1500.0094','4.002','site',NULL,'Numeric','Conditional'),
    ('1500.0095','4.003','site',NULL,'Boolean','Conditional'),
    ('1500.0020','4.004','site',NULL,'Enumerated','Conditional'),
    ('1500.0021','4.004','site',NULL,'String','Conditional'),
    ('1500.0125','4.008','site_zoning',NULL,'Enumerated','Required'),
    ('1500.0122','4.009','site_zoning',NULL,'String','Conditional'),
    ('1500.0123','4.010','site_zoning',NULL,'String','Conditional'),
    ('1500.0127','4.013','site_zoning',NULL,'Boolean','Conditional'),
    ('1500.0124','4.014','site_zoning',NULL,'String','Conditional'),
    ('1500.0034','4.017','site_mixed_use',NULL,'Boolean','Required'),
    ('1500.0036','4.015','site_mixed_use',NULL,'Boolean','Conditional'),
    ('1500.0037','4.016','site_mixed_use',NULL,'Numeric','Conditional'),
    ('1500.0039','4.017','site_mixed_use',NULL,'Enumerated','Conditional'),
    ('1500.0040','4.017','site_mixed_use',NULL,'String','Conditional'),
    ('1500.0032','4.018','site_mixed_use',NULL,'Boolean','Conditional'),
    ('1500.0033','4.019','site_mixed_use',NULL,'String','Conditional'),
    ('1500.0055','4.020','site_access',NULL,'Enumerated','Required'),
    ('1500.0056','4.020','site_access',NULL,'String','Conditional'),
    ('1500.0047','4.021','site_access',NULL,'Enumerated','Conditional'),
    ('1500.0049','4.021','site_access',NULL,'Enumerated','Conditional'),
    ('1500.0052','4.022','site_access',NULL,'Boolean','Conditional'),
    ('1500.0054','4.023','site_access',NULL,'Boolean','Required'),
    ('1500.0053','4.024','site_access',NULL,'String','Conditional'),
    ('1500.0166','4.067','site',NULL,'Boolean','Required'),
    ('1500.0178','4.099','site',NULL,'Boolean','Required'),
    ('0100.0044','4.116','site_commentary',NULL,'String','Conditional'),
    ('1500.0027','4.005','site_parcel','site_parcel','String','Required'),
    ('1500.0023','4.006','site_parcel','site_parcel','Enumerated','Required'),
    ('1500.0024','4.006','site_parcel','site_parcel','String','Conditional'),
    ('1500.0022','4.007','site_parcel','site_parcel','Measurement','Required'),
    ('1500.0087','4.025','site_influence','site_influence','Enumerated','Required'),
    ('1500.0088','4.025','site_influence','site_influence','String','Conditional'),
    ('1500.0086','4.026','site_influence','site_influence','Enumerated','Required'),
    ('1500.0015','4.026','site_influence','site_influence','Measurement','Conditional'),
    ('1500.0182','4.028','site_influence','site_influence','Enumerated','Required'),
    ('1500.0181','4.029','site_influence','site_influence','String','Required'),
    ('1500.0117','4.039','site_view','site_view','Boolean','Required'),
    ('1500.0120','4.039','site_view','site_view','Enumerated','Required'),
    ('1500.0121','4.039','site_view','site_view','String','Conditional'),
    ('1500.0118','4.040','site_view','site_view','Enumerated','Required'),
    ('1500.0184','4.041','site_view','site_view','Enumerated','Required'),
    ('1500.0012','4.050','site_encumbrance','site_encumbrance','Enumerated','Required'),
    ('1500.0171','4.053','site_encumbrance','site_encumbrance','Enumerated','Required'),
    ('1500.0170','4.054','site_encumbrance','site_encumbrance','String','Required'),
    ('1500.0062','4.063','site_feature','site_feature','Enumerated','Required'),
    ('1500.0063','4.063','site_feature','site_feature','String','Conditional'),
    ('1500.0180','4.064','site_feature','site_feature','Enumerated','Required'),
    ('1500.0179','4.065','site_feature','site_feature','String','Required'),
    ('1500.0104','4.069','site_utility','site_utility','Enumerated','Required'),
    ('1500.0102','4.070','site_utility','site_utility','Enumerated','Required'),
    ('1500.0103','4.071','site_utility','site_utility','Boolean','Required'),
    ('1500.0183','4.072','site_utility','site_utility','Enumerated','Required'),
    ('1500.0132','4.073','site_utility','site_utility','String','Conditional'),
    ('3900.0123','4.100','site_defect','site_defect','String','Required'),
    ('3900.0159','4.101','site_defect','site_defect','String','Required'),
    ('3900.0125','4.102','site_defect','site_defect','String','Required'),
    ('3900.0124','4.103','site_defect','site_defect','Boolean','Required'),
    ('3900.0128','4.104','site_defect','site_defect','Enumerated','Required')
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 4, 'Site', context_key,
  NULL, data_type, requirement,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 2,
    'entity_type', entity_type,
    'source', 'Appendix A-1 URAR Delivery Specification 1.4'
  ))
FROM catalog
ON CONFLICT (release_key, uid, property_context) DO UPDATE
SET report_field_id = EXCLUDED.report_field_id,
    section_number = EXCLUDED.section_number,
    section_name = EXCLUDED.section_name,
    data_type = EXCLUDED.data_type,
    requirement = EXCLUDED.requirement,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  (
    'uad-3.6-2026-08-13-h1.5', 'HN-UAD-SITE-001', 'fatal', 'site',
    'Parcel count must match the number of parcel entities.',
    'field(1500.0094) = count(entity:site_parcel)', ARRAY['4.002','4.005'],
    '{"implementation":"server_cross_field","phase":2}'::jsonb
  ),
  (
    'uad-3.6-2026-08-13-h1.5', 'HN-UAD-SITE-002', 'fatal', 'site',
    'Site defect records must agree with the site-defects indicator.',
    'field(1500.0178) = exists(entity:site_defect)', ARRAY['4.099','4.100'],
    '{"implementation":"server_cross_field","phase":2}'::jsonb
  )
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
