WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
[
  {
    "uid": "3600.0002",
    "rfid": "11.000",
    "context": "functional_obsolescence",
    "name": "FunctionalIssueType",
    "type": "Enumerated",
    "requirement": "Required",
    "cardinality": "1:10",
    "options": [
      "CeilingHeight",
      "FloorPlan",
      "NonConformity",
      "None",
      "Other",
      "Overimprovement",
      "Underimprovement"
    ],
    "maxLength": null
  },
  {
    "uid": "3600.0003",
    "rfid": "11.000",
    "context": "functional_obsolescence",
    "name": "FunctionalIssueTypeOtherDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:10",
    "options": null,
    "maxLength": 33
  },
  {
    "uid": "3600.0006",
    "rfid": "11.001",
    "context": "functional_obsolescence_commentary",
    "name": "FunctionalIssueDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 5000
  },
  {
    "uid": "1400.0640",
    "rfid": "11.002.2",
    "context": "functional_obsolescence_asset",
    "name": "ImageCaptionCommentDescription",
    "type": "String",
    "requirement": "Conditional",
    "cardinality": "0:1",
    "options": null,
    "maxLength": 100
  }
]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    context text,
    name text,
    type text,
    requirement text,
    cardinality text,
    options jsonb,
    "maxLength" integer
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 11, 'Functional Obsolescence',
  context, name, type, requirement, cardinality,
  jsonb_strip_nulls(jsonb_build_object(
    'phase', 8,
    'options', options,
    'max_length', "maxLength",
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
  field.release_key,
  field.uid,
  field.property_context,
  option.value,
  regexp_replace(option.value, '([a-z])([A-Z])', '\1 \2', 'g'),
  option.ordinality,
  '{"phase":8,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number = 11
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1680','fatal','functional_obsolescence','The type of functional issue must be included. Select ''None'' if there are no functional issues.','At least one FUNCTIONAL_ISSUE must be provided and FunctionalIssueType must be supplied in every instance.',ARRAY['11.000'],'{"phase":8,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1681','fatal','functional_obsolescence','Provide a description when ''Functional Issues'' = ''Other''.','If FunctionalIssueType = "Other", FunctionalIssueTypeOtherDescription must be provided in that instance of FUNCTIONAL_ISSUE.',ARRAY['11.000'],'{"phase":8,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-FUNCTIONAL-001','fatal','functional_obsolescence','Select ''None'' by itself when there are no functional issues.','FunctionalIssueType None is exclusive.',ARRAY['11.000'],'{"phase":8,"source":"Appendix A-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-FUNCTIONAL-002','fatal','functional_obsolescence_commentary','Describe every apparent functional issue associated with the property.','FunctionalIssueDescription is required when FunctionalIssueType is not None.',ARRAY['11.000','11.001'],'{"phase":8,"source":"Appendix A-1 v1.4","implementation":"server_conditional"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
