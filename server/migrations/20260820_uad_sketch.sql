CREATE UNIQUE INDEX IF NOT EXISTS uad_sketches_workfile_root_unique
  ON appraisal.uad_sketches (workfile_id)
  WHERE entity_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uad_sketches_workfile_entity_unique
  ON appraisal.uad_sketches (workfile_id, entity_id)
  WHERE entity_id IS NOT NULL;

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
    [
      {"uid":"3300.0002","rfid":"7.000","context":"sketch","name":"SketchExistsIndicator","type":"Boolean","requirement":"Required","cardinality":"1:1"},
      {"uid":"3300.0007","rfid":"7.001","context":"sketch","name":"MeasurementStandardPublisherType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"3300.0008","rfid":"7.001","context":"sketch","name":"MeasurementStandardPublisherTypeOtherDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0638","rfid":"7.002.1","context":"sketch_asset","name":"ImageCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:unbounded"},
      {"uid":"1400.0640","rfid":"7.002.2","context":"sketch_asset","name":"ImageCaptionCommentDescription","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0644","rfid":"Does Not Display","context":"sketch_asset","name":"ImageFileLocationIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0641","rfid":"Does Not Display","context":"sketch_asset","name":"ImageDatetime","type":"Datetime","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0642","rfid":"Does Not Display","context":"sketch_asset","name":"LatitudeIdentifier","type":"Numeric","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0643","rfid":"Does Not Display","context":"sketch_asset","name":"LongitudeIdentifier","type":"Numeric","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"1400.0889","rfid":"Does Not Display","context":"sketch_asset","name":"MIMETypeIdentifier","type":"String","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"3300.0009","rfid":"Does Not Display","context":"sketch_commentary","name":"ValuationAnalysisCategoryType","type":"Enumerated","requirement":"Conditional","cardinality":"0:1"},
      {"uid":"3300.0010","rfid":"7.003","context":"sketch_commentary","name":"ValuationCommentText","type":"String","requirement":"Conditional","cardinality":"0:1"}
    ]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    context text,
    name text,
    type text,
    requirement text,
    cardinality text
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, cardinality, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, rfid, 7, 'Sketch',
  context, name, type, requirement, cardinality,
  jsonb_build_object(
    'phase', 4,
    'source', 'Appendix A-1 URAR Delivery Specification 1.4'
  )
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

WITH enumerations(uid, context, value, display_label, sort_order) AS (
  VALUES
    ('3300.0007','sketch','AmericanNationalStandardsInstitute','ANSI',1),
    ('3300.0007','sketch','AmericanMeasurementStandard','AMS',2),
    ('3300.0007','sketch','Other','Other (Describe)',3),
    ('1400.0638','sketch_asset','SubjectPropertyImprovementSketch','Sketch',1),
    ('1400.0638','sketch_asset','FloorPlan','Floor Plan',2),
    ('3300.0009','sketch_commentary','Sketch','Sketch',1)
)
INSERT INTO uad_ref.enumerations (
  release_key, uid, property_context, value, display_label, sort_order, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5', uid, context, value, display_label, sort_order,
  '{"phase":4,"source":"Appendix A-1 URAR Delivery Specification 1.4"}'::jsonb
FROM enumerations
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

INSERT INTO uad_ref.compliance_rules (
  release_key, rule_id, severity, property_context, message, expression, report_field_ids, metadata
)
VALUES
  ('uad-3.6-2026-08-13-h1.5','UAD1676','fatal','sketch','Indicate whether a sketch or floor plan has been included in the appraisal.','SketchExistsIndicator is provided',ARRAY['7.000'],'{"phase":4,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1677','fatal','sketch','Provide the measurement standard used for the appraisal.','IF SketchExistsIndicator = true THEN MeasurementStandardPublisherType is provided',ARRAY['7.001'],'{"phase":4,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','UAD1678','fatal','sketch','Provide a description when Measurement Standard is Other.','IF MeasurementStandardPublisherType = Other THEN other description is provided',ARRAY['7.001'],'{"phase":4,"source":"Appendix H-1 v1.5"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SKETCH-001','fatal','sketch','A verified sketch or floor plan report image is required when one is reported as provided.','IF SketchExistsIndicator = true THEN verified section 7 Sketch or FloorPlan asset exists',ARRAY['7.000','7.002.1'],'{"phase":4,"source":"Appendix F-1 v1.4","implementation":"server_cross_record"}'::jsonb),
  ('uad-3.6-2026-08-13-h1.5','HN-UAD-SKETCH-002','fatal','sketch','Explain why a sketch or floor plan was not provided.','IF SketchExistsIndicator = false THEN Sketch Commentary is provided',ARRAY['7.000','7.003'],'{"phase":4,"source":"Appendix F-1 v1.4","implementation":"field_required_when"}'::jsonb)
ON CONFLICT (release_key, rule_id) DO UPDATE
SET severity = EXCLUDED.severity,
    property_context = EXCLUDED.property_context,
    message = EXCLUDED.message,
    expression = EXCLUDED.expression,
    report_field_ids = EXCLUDED.report_field_ids,
    metadata = EXCLUDED.metadata;
