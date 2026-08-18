export const UAD_QUALITY_RATINGS = Object.freeze(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);

export const UAD_CONDITION_RATINGS = Object.freeze(["C1", "C2", "C3", "C4", "C5", "C6"]);

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "overall_quality_condition",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_OVERALL_QUALITY_CONDITION_FIELDS = Object.freeze([
  field(
    "Overall ratings",
    "subject",
    "1600.0007",
    "15.000",
    "Overall quality",
    "enum",
    {
      required: true,
      options: UAD_QUALITY_RATINGS,
      guidance: "Reconcile the quality of every dwelling and living unit used in the value conclusion.",
    },
  ),
  field(
    "Overall ratings",
    "subject",
    "1600.0006",
    "15.005",
    "Overall condition",
    "enum",
    {
      required: true,
      options: UAD_CONDITION_RATINGS,
      guidance: "For a subject-to appraisal, rate the property as if required items were satisfactorily completed.",
    },
  ),
  field(
    "Reconciliation of overall quality and condition",
    "overall_quality_condition_commentary",
    "1600.0008",
    "15.010",
    "Reconciliation of overall quality and condition",
    "text",
    {
      required: true,
      maxLength: 5000,
      guidance: "Explain how the exterior and non-ADU interior ratings support the overall conclusions.",
    },
  ),
]);

export const UAD_OVERALL_QUALITY_CONDITION_REDISPLAY_FIELDS = Object.freeze([
  Object.freeze({
    sourceSection: 8,
    entityType: "dwelling",
    contextKey: "dwelling",
    uid: "0300.0101",
    reportFieldIds: Object.freeze(["15.001", "15.006"]),
    label: "Structure identifier",
  }),
  Object.freeze({
    sourceSection: 8,
    entityType: "dwelling",
    contextKey: "dwelling",
    uid: "1600.0005",
    reportFieldIds: Object.freeze(["15.002"]),
    label: "Exterior quality",
  }),
  Object.freeze({
    sourceSection: 8,
    entityType: "dwelling",
    contextKey: "dwelling",
    uid: "1600.0004",
    reportFieldIds: Object.freeze(["15.007"]),
    label: "Exterior condition",
  }),
  Object.freeze({
    sourceSection: 10,
    entityType: "unit",
    contextKey: "unit",
    uid: "0700.0114",
    reportFieldIds: Object.freeze(["15.003", "15.008"]),
    label: "Unit identifier",
    excludesAccessoryDwellingUnits: true,
  }),
  Object.freeze({
    sourceSection: 10,
    entityType: "unit",
    contextKey: "unit",
    uid: "0700.0067",
    reportFieldIds: Object.freeze(["15.004"]),
    label: "Interior quality",
    excludesAccessoryDwellingUnits: true,
  }),
  Object.freeze({
    sourceSection: 10,
    entityType: "unit",
    contextKey: "unit",
    uid: "0700.0066",
    reportFieldIds: Object.freeze(["15.009"]),
    label: "Interior condition",
    excludesAccessoryDwellingUnits: true,
  }),
]);

export const UAD_OVERALL_QUALITY_CONDITION_FIELD_KEYS = Object.freeze({
  overallQuality: "subject:1600.0007",
  overallCondition: "subject:1600.0006",
  reconciliation: "overall_quality_condition_commentary:1600.0008",
  homeownerMaintainsExterior: "subject:0100.0046",
  exteriorQuality: "dwelling:1600.0005",
  exteriorCondition: "dwelling:1600.0004",
  accessoryDwellingUnit: "unit:0700.0089",
  interiorQuality: "unit:0700.0067",
  interiorCondition: "unit:0700.0066",
});
