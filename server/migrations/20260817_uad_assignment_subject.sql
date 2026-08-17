ALTER TABLE appraisal.uad_field_values
  ADD COLUMN IF NOT EXISTS field_context text;

UPDATE appraisal.uad_field_values
   SET field_context = 'subject'
 WHERE field_context IS NULL;

ALTER TABLE appraisal.uad_field_values
  ALTER COLUMN field_context SET DEFAULT 'subject',
  ALTER COLUMN field_context SET NOT NULL;

ALTER TABLE appraisal.uad_field_values
  DROP CONSTRAINT IF EXISTS uad_field_values_workfile_id_entity_id_uad_uid_key;

DROP INDEX IF EXISTS appraisal.uad_field_values_entity_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS uad_field_values_context_uidx
  ON appraisal.uad_field_values (
    workfile_id,
    COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    field_context,
    uad_uid
  );

ALTER TABLE appraisal.uad_field_values
  DROP CONSTRAINT IF EXISTS uad_field_values_context_check;

ALTER TABLE appraisal.uad_field_values
  ADD CONSTRAINT uad_field_values_context_check
  CHECK (char_length(trim(field_context)) BETWEEN 1 AND 80);

WITH catalog AS (
  SELECT *
    FROM jsonb_to_recordset($catalog$
    [
      {"uid":"1000.0034","rfid":"2.000","section":2,"context":"assignment","name":"ValuationAssignmentType","type":"Enumerated","required":true,"options":["Construction","DeedInLieu","HomeEquity","LoanModification","Other","PortfolioEvaluation","Preforeclosure","Purchase","Refinance","REO","ShortSale"]},
      {"uid":"1000.0035","rfid":"2.000","section":2,"context":"assignment","name":"ValuationAssignmentTypeOtherDescription","type":"String"},
      {"uid":"1000.0158","rfid":"2.004","section":2,"context":"assignment","name":"PropertyValuationMethodType","type":"Enumerated","required":true,"options":["DesktopAppraisal","ExteriorAppraisal","HybridAppraisal","TraditionalAppraisal"]},
      {"uid":"1000.0043","rfid":"2.005","section":2,"context":"assignment","name":"PropertyDataReportIndicator","type":"Boolean","required":true},
      {"uid":"1000.0029","rfid":"2.008","section":2,"context":"assignment","name":"GovernmentAgencyAppraisalType","type":"Enumerated","options":["FHA","USDA","VA"]},
      {"uid":"1000.0038","rfid":"2.009","section":2,"context":"assignment","name":"InvestorRequestedIdentificationCode","type":"String"},
      {"uid":"1000.0101","rfid":"2.001","section":2,"context":"borrower","name":"FirstName","type":"String"},
      {"uid":"1000.0170","rfid":"2.001","section":2,"context":"borrower","name":"MiddleName","type":"String"},
      {"uid":"1000.0102","rfid":"2.001","section":2,"context":"borrower","name":"LastName","type":"String"},
      {"uid":"1000.0171","rfid":"2.001","section":2,"context":"borrower","name":"NameSuffixType","type":"String"},
      {"uid":"1000.0104","rfid":"2.001","section":2,"context":"borrower","name":"FullName","type":"String"},
      {"uid":"1000.0018","rfid":"2.002","section":2,"context":"seller","name":"FirstName","type":"String"},
      {"uid":"1000.0172","rfid":"2.002","section":2,"context":"seller","name":"MiddleName","type":"String"},
      {"uid":"1000.0019","rfid":"2.002","section":2,"context":"seller","name":"LastName","type":"String"},
      {"uid":"1000.0173","rfid":"2.002","section":2,"context":"seller","name":"NameSuffixType","type":"String"},
      {"uid":"1000.0020","rfid":"2.002","section":2,"context":"seller","name":"FullName","type":"String"},
      {"uid":"1000.0022","rfid":"2.003","section":2,"context":"owner","name":"FirstName","type":"String"},
      {"uid":"1000.0174","rfid":"2.003","section":2,"context":"owner","name":"MiddleName","type":"String"},
      {"uid":"1000.0023","rfid":"2.003","section":2,"context":"owner","name":"LastName","type":"String"},
      {"uid":"1000.0175","rfid":"2.003","section":2,"context":"owner","name":"NameSuffixType","type":"String"},
      {"uid":"1000.0024","rfid":"2.003","section":2,"context":"owner","name":"FullName","type":"String"},
      {"uid":"2400.0081","rfid":"2.021","section":2,"context":"appraiser_inspection","name":"PropertyInspectionExteriorMethodType","type":"Enumerated","required":true,"options":["NoInspection","Physical","Virtual"]},
      {"uid":"2400.0082","rfid":"2.022","section":2,"context":"appraiser_inspection","name":"PropertyInspectionInteriorMethodType","type":"Enumerated","required":true,"options":["NoInspection","Physical","Virtual"]},
      {"uid":"2400.0080","rfid":"2.023","section":2,"context":"appraiser_inspection","name":"PropertyInspectionDate","type":"Date","required":true},
      {"uid":"0100.0044","rfid":"2.061","section":2,"context":"assignment_commentary","name":"AdditionalSectionCommentaryText","type":"String"},
      {"uid":"0100.0007","rfid":"3.000","section":3,"context":"subject_address","name":"AddressLineText","type":"String","required":true},
      {"uid":"1200.0052","rfid":"3.000","section":3,"context":"subject_address","name":"AddressUnitDesignatorType","type":"Enumerated","options":["Unit"]},
      {"uid":"0100.0008","rfid":"3.000","section":3,"context":"subject_address","name":"AddressUnitIdentifier","type":"String"},
      {"uid":"0100.0009","rfid":"3.000","section":3,"context":"subject_address","name":"CityName","type":"String","required":true},
      {"uid":"0100.0012","rfid":"3.000","section":3,"context":"subject_address","name":"StateCode","type":"String","required":true},
      {"uid":"0100.0011","rfid":"3.000","section":3,"context":"subject_address","name":"PostalCode","type":"String","required":true},
      {"uid":"0100.0010","rfid":"3.002","section":3,"context":"subject","name":"CountyName","type":"String","required":true},
      {"uid":"0100.0017","rfid":"3.003","section":3,"context":"subject","name":"NeighborhoodName","type":"String"},
      {"uid":"0100.0020","rfid":"3.004","section":3,"context":"subject","name":"AttachmentType","type":"Enumerated","required":true,"options":["Attached","Detached"]},
      {"uid":"0100.0022","rfid":"3.005","section":3,"context":"subject","name":"LivingUnitExcludingADUCount","type":"Numeric","required":true},
      {"uid":"0100.0019","rfid":"3.006","section":3,"context":"subject","name":"AccessoryDwellingUnitTotalCount","type":"Numeric","required":true},
      {"uid":"0100.0021","rfid":"3.007","section":3,"context":"subject","name":"DwellingCount","type":"Numeric","required":true},
      {"uid":"0100.0033","rfid":"3.008","section":3,"context":"subject","name":"SpecialTaxAssessmentsIndicator","type":"Boolean","required":true},
      {"uid":"0100.0050","rfid":"3.009","section":3,"context":"subject","name":"SpecialTaxAssessmentsDescription","type":"String"},
      {"uid":"0100.0026","rfid":"3.010","section":3,"context":"subject","name":"PUDIndicator","type":"Boolean","required":true},
      {"uid":"2500.0168","rfid":"3.011","section":3,"context":"subject","name":"ProjectLegalStructureType","type":"Enumerated","options":["Condominium","Condop","Cooperative"]},
      {"uid":"0100.0054","rfid":"3.014","section":3,"context":"subject","name":"NativeAmericanLandsIndicator","type":"Boolean","required":true},
      {"uid":"0100.0047","rfid":"3.015","section":3,"context":"subject","name":"LandOwnedInCommonIndicator","type":"Boolean","required":true},
      {"uid":"0100.0046","rfid":"3.016","section":3,"context":"subject","name":"HomeownerResponsibleForExteriorMaintenanceIndicator","type":"Boolean","required":true},
      {"uid":"0300.0010","rfid":"3.017","section":3,"context":"subject","name":"NewConstructionIndicator","type":"Boolean","required":true},
      {"uid":"0300.0066","rfid":"3.018","section":3,"context":"subject","name":"ConstructionStatusType","type":"Enumerated","options":["Complete","Proposed","UnderConstruction"]},
      {"uid":"0100.0024","rfid":"3.019","section":3,"context":"subject_ownership","name":"PropertyEstateType","type":"Enumerated","required":true,"options":["FeeSimple","Leasehold","Other"]},
      {"uid":"0100.0053","rfid":"3.019","section":3,"context":"subject_ownership","name":"PropertyEstateTypeOtherDescription","type":"String"},
      {"uid":"0100.0034","rfid":"3.027","section":3,"context":"subject_ownership","name":"AllPropertyRightsAppraisedIndicator","type":"Boolean","required":true},
      {"uid":"0100.0036","rfid":"3.028","section":3,"context":"subject_ownership","name":"PropertyPartialInterestType","type":"Enumerated","options":["AirRights","MineralRights","Other","TimberRights","WaterRights"]},
      {"uid":"0100.0037","rfid":"3.028","section":3,"context":"subject_ownership","name":"PropertyPartialInterestTypeOtherDescription","type":"String"},
      {"uid":"0100.0023","rfid":"3.029","section":3,"context":"subject_ownership","name":"MineralRightsLeasedIndicator","type":"Boolean"},
      {"uid":"0100.0038","rfid":"3.030","section":3,"context":"subject_ownership","name":"PropertyRightsNotAppraisedDescription","type":"String"},
      {"uid":"0100.0067","rfid":"3.031","section":3,"context":"subject_legal","name":"ParcelsLegalDescription","type":"String","required":true},
      {"uid":"0100.0044","rfid":"3.032","section":3,"context":"subject_commentary","name":"AdditionalSectionCommentaryText","type":"String"}
    ]
    $catalog$::jsonb
  ) AS item(
    uid text,
    rfid text,
    section integer,
    context text,
    name text,
    type text,
    required boolean,
    options jsonb
  )
)
INSERT INTO uad_ref.fields (
  release_key, uid, report_field_id, section_number, section_name,
  property_context, data_point_name, data_type, requirement, metadata
)
SELECT
  'uad-3.6-2026-08-13-h1.5',
  uid,
  rfid,
  section,
  CASE section WHEN 2 THEN 'Assignment Information' ELSE 'Subject Property' END,
  context,
  name,
  type,
  CASE WHEN COALESCE(required, false) THEN 'Required' ELSE 'Conditional' END,
  jsonb_strip_nulls(jsonb_build_object('phase', 1, 'options', options))
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
  '{"phase":1}'::jsonb
FROM uad_ref.fields field
CROSS JOIN LATERAL jsonb_array_elements_text(field.metadata->'options')
  WITH ORDINALITY AS option(value, ordinality)
WHERE field.release_key = 'uad-3.6-2026-08-13-h1.5'
  AND field.section_number IN (2, 3)
  AND jsonb_typeof(field.metadata->'options') = 'array'
ON CONFLICT (release_key, uid, property_context, value) DO UPDATE
SET display_label = EXCLUDED.display_label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;
