export const UAD_CERTIFICATION_INSPECTION_TYPES = Object.freeze([
  "Exterior",
  "InteriorAndExterior",
  "NoPhysicalInspection",
]);

export const UAD_CERTIFICATION_SIGNATURE_CAPTION_TYPES = Object.freeze([
  "AppraiserSignature",
  "SupervisoryAppraiserSignature",
]);

export const UAD_CERTIFICATION_SIGNATURE_CONTENT_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const UAD_CERTIFICATION_FIELD_KEYS = Object.freeze({
  governmentAgency: "certification_scope:1000.0028",
  additionalScope: "certification_scope:2200.0062",
  additionalScopeDescription: "certification_scope:2200.0003",
  additionalIntendedUse: "certification_intended_use:2200.0005",
  additionalIntendedUser: "certification_intended_user:2200.0037",
  additionalIntendedUserDescription: "certification_intended_user:2200.0004",
  additionalAppraiserCertification: "certification_report:2200.0034",
  additionalAppraiserCertificationText: "certification_appraiser:2200.0087",
  priorServices: "certification_report:2200.0017",
  priorServicesDescription: "certification_report:2200.0016",
  inspectionCertification: "certification_report:2200.0038",
});

const federalAgencySelected = Object.freeze({
  key: "assignment:1000.0029",
  present: true,
});
const additionalScopeSelected = Object.freeze({
  key: UAD_CERTIFICATION_FIELD_KEYS.additionalScope,
  equals: true,
});
const additionalIntendedUserSelected = Object.freeze({
  key: UAD_CERTIFICATION_FIELD_KEYS.additionalIntendedUser,
  equals: true,
});
const additionalAppraiserCertificationSelected = Object.freeze({
  key: UAD_CERTIFICATION_FIELD_KEYS.additionalAppraiserCertification,
  equals: true,
});
const priorServicesSelected = Object.freeze({
  key: UAD_CERTIFICATION_FIELD_KEYS.priorServices,
  equals: true,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "certifications",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_CERTIFICATION_FIELDS = Object.freeze([
  field(
    "Scope of Work",
    "certification_scope",
    "1000.0028",
    "Does Not Display",
    "Federal agency appraisal",
    "boolean",
    {
      required: true,
      readOnly: true,
      calculated: true,
      initialValue: false,
      guidance: "HomeNode derives this delivery indicator from the Government Agency Appraisal selection in Assignment Information.",
    },
  ),
  field(
    "Scope of Work",
    "certification_scope",
    "2200.0062",
    "Does Not Display",
    "Additional scope of work was necessary",
    "boolean",
    {
      required: true,
      initialValue: false,
      guidance: "Select Yes only for assignment-specific scope beyond the predefined minimum scope. Do not repeat or contradict the predefined scope language.",
    },
  ),
  field(
    "Scope of Work",
    "certification_scope",
    "2200.0003",
    "29.003",
    "Additional scope of work",
    "text",
    {
      maxLength: 2500,
      showWhen: additionalScopeSelected,
      requiredWhen: additionalScopeSelected,
    },
  ),
  field(
    "Intended Use",
    "certification_intended_use",
    "2200.0005",
    "29.007",
    "Additional intended use for the federal agency",
    "text",
    {
      maxLength: 2500,
      showWhen: federalAgencySelected,
      guidance: "Optional agency-specific intended-use text. Do not repeat or contradict the predefined government-agency intended use.",
    },
  ),
  field(
    "Intended Users",
    "certification_intended_user",
    "2200.0037",
    "Does Not Display",
    "Additional intended users exist",
    "boolean",
    {
      required: true,
      initialValue: false,
    },
  ),
  field(
    "Intended Users",
    "certification_intended_user",
    "2200.0004",
    "29.011",
    "Additional intended user",
    "string",
    {
      maxLength: 180,
      showWhen: additionalIntendedUserSelected,
      requiredWhen: additionalIntendedUserSelected,
      guidance: "Identify only assignment-specific intended users not already covered by the predefined certification language.",
    },
  ),
  field(
    "Appraiser Certifications",
    "certification_report",
    "2200.0038",
    "29.030",
    "Inspection certification",
    "enum",
    {
      required: true,
      options: UAD_CERTIFICATION_INSPECTION_TYPES,
      initialValue: "InteriorAndExterior",
      guidance: "This attestation must agree with the valuation method and the exterior/interior inspection methods recorded in Assignment Information.",
    },
  ),
  field(
    "Appraiser Certifications",
    "certification_report",
    "2200.0017",
    "29.050",
    "Prior services performed for the subject within the preceding three years",
    "boolean",
    {
      required: true,
      initialValue: false,
    },
  ),
  field(
    "Appraiser Certifications",
    "certification_report",
    "2200.0016",
    "29.051",
    "Description of prior services",
    "text",
    {
      maxLength: 1250,
      showWhen: priorServicesSelected,
      requiredWhen: priorServicesSelected,
    },
  ),
  field(
    "Appraiser Certifications",
    "certification_report",
    "2200.0034",
    "Does Not Display",
    "Additional appraiser certifications exist",
    "boolean",
    {
      required: true,
      initialValue: false,
    },
  ),
  field(
    "Appraiser Certifications",
    "certification_appraiser",
    "2200.0087",
    "29.053",
    "Additional appraiser certification",
    "text",
    {
      maxLength: 360,
      showWhen: additionalAppraiserCertificationSelected,
      requiredWhen: additionalAppraiserCertificationSelected,
      guidance: "Add only an assignment-specific certification. The standard URAR certifications remain predefined and are not re-entered here.",
    },
  ),
]);

export function buildUadCertificationWarnings(editor) {
  const values = new Map((editor?.values || []).map((value) => (
    [`${value.entity_id || "root"}:${value.context_key}:${value.uid}`, value.value]
  )));
  const get = (key) => values.get(`root:${key}`);
  const valuationMethod = get("assignment:1000.0158");
  const exteriorInspection = get("appraiser_inspection:2400.0081");
  const interiorInspection = get("appraiser_inspection:2400.0082");
  const certification = get(UAD_CERTIFICATION_FIELD_KEYS.inspectionCertification);
  if (!certification) return [];

  let expected = null;
  let ruleId = null;
  if (valuationMethod === "TraditionalAppraisal") {
    expected = "InteriorAndExterior";
    ruleId = "UAD1512";
  } else if (valuationMethod === "ExteriorAppraisal") {
    expected = "Exterior";
    ruleId = "UAD1513";
  } else if (["DesktopAppraisal", "HybridAppraisal"].includes(valuationMethod)) {
    expected = "NoPhysicalInspection";
    ruleId = valuationMethod === "DesktopAppraisal" ? "UAD1514" : "UAD1515";
  }
  if (expected && certification !== expected) {
    return [{
      severity: "warning",
      rule_id: ruleId,
      uad_uid: "2200.0038",
      report_field_id: "29.030",
      entity_id: null,
      message: `Inspection certification ${certification} does not match ${valuationMethod}; ${expected} is expected.`,
      metadata: {
        section: "certifications",
        context_key: "certification_report",
        code: "inspection_certification_method_mismatch",
        valuation_method: valuationMethod,
        exterior_inspection_method: exteriorInspection || null,
        interior_inspection_method: interiorInspection || null,
        expected_certification: expected,
      },
    }];
  }
  return [];
}
