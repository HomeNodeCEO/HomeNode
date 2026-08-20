export const UAD_RECONCILIATION_VALUE_CONDITIONS = Object.freeze([
  "AsIs",
  "SubjectToCompletionPerPlans",
  "SubjectToInspection",
  "SubjectToRepair",
]);

export const UAD_RECONCILIATION_INCOME_EXCLUSION_REASONS = Object.freeze([
  "InsufficientData",
  "NotNecessaryForCredibleResults",
  "Other",
]);

export const UAD_RECONCILIATION_COST_EXCLUSION_REASONS = Object.freeze([
  "DifficultyEstimatingDepreciation",
  "LackOfLandSales",
  "NotNecessaryForCredibleResults",
  "Other",
]);

export const UAD_RECONCILIATION_CAPTION_TYPES = Object.freeze(["ReconciliationExhibit"]);
export const UAD_RECONCILIATION_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

export function isVerifiedReconciliationAsset(asset, captionType = null) {
  return asset?.section_number === 26
    && asset?.status === "verified"
    && UAD_RECONCILIATION_CAPTION_TYPES.includes(asset?.caption_type)
    && (!captionType || asset?.caption_type === captionType);
}

const salesDeveloped = Object.freeze({
  key: "sales_comparison_scope:1000.0032",
  equals: true,
});
const salesExcluded = Object.freeze({
  key: "sales_comparison_scope:1000.0032",
  equals: false,
});
const incomeDeveloped = Object.freeze({
  key: "scope_of_work:1000.0030",
  equals: true,
});
const incomeExcluded = Object.freeze({
  key: "scope_of_work:1000.0030",
  equals: false,
});
const costDeveloped = Object.freeze({
  key: "scope_of_work:1000.0027",
  equals: true,
});
const costExcluded = Object.freeze({
  key: "scope_of_work:1000.0027",
  equals: false,
});
const requestedConditionsExist = Object.freeze({
  key: "reconciliation:1300.0019",
  equals: true,
});
const itemizedRepairCosts = Object.freeze({
  key: "defect_summary:3900.0001",
  equals: "Itemized",
});
const repairCostsProvided = Object.freeze({
  any: [
    { key: "defect_summary:3900.0001", equals: "Itemized" },
    { key: "defect_summary:3900.0001", equals: "TotalCost" },
  ],
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "reconciliation",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const requestedCondition = (uid, reportFieldId, label, dataType, options = {}) => field(
  "Client requested conditions",
  "additional_requested_conditional_valuation",
  uid,
  reportFieldId,
  label,
  dataType,
  {
    entityType: "additional_requested_conditional_valuation",
    ...options,
  },
);

const defectCost = (contextKey, entityType, uid, reportFieldId, actionKey) => field(
  "Apparent defects, damages, and deficiencies",
  contextKey,
  uid,
  reportFieldId,
  "Estimated cost to repair",
  "currency",
  {
    entityType,
    minimum: 0,
    maximum: 9999999,
    showWhen: {
      all: [
        itemizedRepairCosts,
        { key: actionKey, equals: "Repair" },
      ],
    },
    requiredWhen: {
      all: [
        itemizedRepairCosts,
        { key: actionKey, equals: "Repair" },
      ],
    },
    guidance: "Required for this repair item when the reporting method is Itemized. The Section 26 total is calculated on the server.",
  },
);

export const UAD_RECONCILIATION_FIELDS = Object.freeze([
  field(
    "Approaches to value",
    "sales_comparison_exclusion",
    "1300.0007",
    "Does Not Display",
    "Sales Comparison Approach exclusion reason",
    "multi_enum",
    {
      options: ["Other"],
      showWhen: salesExcluded,
      requiredWhen: salesExcluded,
      guidance: "Fannie Mae permits only Other when the Sales Comparison Approach is not developed. Explain the assignment-specific reason below.",
    },
  ),
  field(
    "Approaches to value",
    "sales_comparison_exclusion",
    "1300.0008",
    "26.001",
    "Other Sales Comparison Approach exclusion reason",
    "string",
    {
      maxLength: 225,
      showWhen: salesExcluded,
      requiredWhen: salesExcluded,
    },
  ),
  field(
    "Approaches to value",
    "scope_of_work",
    "1000.0030",
    "Does Not Display",
    "Income Approach developed by appraiser",
    "boolean",
    {
      required: true,
      guidance: "This official Scope of Work indicator controls whether Section 26 redisplays an Income Approach value or requires an exclusion reason.",
    },
  ),
  field(
    "Approaches to value",
    "income_approach_summary",
    "1200.0004",
    "26.002",
    "Income Approach indicated value",
    "currency",
    {
      readOnly: true,
      minimumExclusive: 0,
      maximum: 999999999,
      showWhen: incomeDeveloped,
      requiredWhen: incomeDeveloped,
      guidance: "Canonical value produced by the Income Approach. Review and apply the same-assignment Custom Appraisal suggestion until the native UAD Section 24 editor is enabled.",
    },
  ),
  field(
    "Approaches to value",
    "income_approach_exclusion",
    "1300.0004",
    "26.003",
    "Income Approach exclusion reason",
    "multi_enum",
    {
      options: UAD_RECONCILIATION_INCOME_EXCLUSION_REASONS,
      showWhen: incomeExcluded,
      requiredWhen: incomeExcluded,
    },
  ),
  field(
    "Approaches to value",
    "income_approach_exclusion",
    "1300.0005",
    "26.003",
    "Other Income Approach exclusion reason",
    "string",
    {
      maxLength: 225,
      showWhen: { key: "income_approach_exclusion:1300.0004", contains: "Other" },
      requiredWhen: { key: "income_approach_exclusion:1300.0004", contains: "Other" },
    },
  ),
  field(
    "Approaches to value",
    "scope_of_work",
    "1000.0027",
    "Does Not Display",
    "Cost Approach developed by appraiser",
    "boolean",
    {
      required: true,
      guidance: "This official Scope of Work indicator controls whether Section 26 redisplays a Cost Approach value or requires an exclusion reason.",
    },
  ),
  field(
    "Approaches to value",
    "cost_approach_summary",
    "1300.0001",
    "26.004",
    "Cost Approach indicated value",
    "currency",
    {
      readOnly: true,
      minimumExclusive: 0,
      maximum: 999999999,
      showWhen: costDeveloped,
      requiredWhen: costDeveloped,
      guidance: "Canonical value produced by the Cost Approach. Review and apply the same-assignment Custom Appraisal suggestion until the native UAD Section 25 editor is enabled.",
    },
  ),
  field(
    "Approaches to value",
    "cost_approach_exclusion",
    "1300.0002",
    "26.005",
    "Cost Approach exclusion reason",
    "multi_enum",
    {
      options: UAD_RECONCILIATION_COST_EXCLUSION_REASONS,
      showWhen: costExcluded,
      requiredWhen: costExcluded,
    },
  ),
  field(
    "Approaches to value",
    "cost_approach_exclusion",
    "1300.0003",
    "26.005",
    "Other Cost Approach exclusion reason",
    "string",
    {
      maxLength: 225,
      showWhen: { key: "cost_approach_exclusion:1300.0002", contains: "Other" },
      requiredWhen: { key: "cost_approach_exclusion:1300.0002", contains: "Other" },
    },
  ),

  field("Appraisal summary", "reconciliation", "1300.0017", "26.007", "Opinion of Market Value", "currency", {
    required: true,
    minimumExclusive: 0,
    maximum: 999999999,
  }),
  field("Appraisal summary", "reconciliation", "1300.0033", "26.008", "Pro rata share calculation method", "enum", {
    options: ["Drawn", "Maximum"],
    guidance: "Required only for an applicable cooperative or condop blanket-financing line of credit.",
  }),
  field("Appraisal summary", "reconciliation", "1300.0010", "26.009", "Market Value Condition", "multi_enum", {
    required: true,
    options: UAD_RECONCILIATION_VALUE_CONDITIONS,
    guidance: "As Is must be the only selected condition. Repair, completion, and inspection conditions may be combined when supported by the assignment.",
  }),
  field("Appraisal summary", "reconciliation", "1300.0013", "26.010", "Reasonable exposure time (days)", "integer", {
    minimum: 0,
    maximum: 9999,
    guidance: "Enter either one supported duration or the low and high range below, never both.",
  }),
  field("Appraisal summary", "reconciliation", "1300.0015", "26.010", "Reasonable exposure time low (days)", "integer", {
    minimum: 0,
    maximum: 9999,
  }),
  field("Appraisal summary", "reconciliation", "1300.0014", "26.010", "Reasonable exposure time high (days)", "integer", {
    minimum: 0,
    maximum: 9999,
  }),
  field("Appraisal summary", "reconciliation", "1300.0012", "26.011", "Effective Date of Appraisal", "date", {
    required: true,
  }),
  field("Appraisal summary", "reconciliation", "1300.0020", "26.012", "FHA REO insurability level", "enum", {
    options: ["Insurable", "InsurableWithRepairEscrow", "Uninsurable"],
    showWhen: {
      all: [
        { key: "assignment:1000.0034", equals: "REO" },
        { key: "assignment:1000.0029", equals: "FHA" },
      ],
    },
    requiredWhen: {
      all: [
        { key: "assignment:1000.0034", equals: "REO" },
        { key: "assignment:1000.0029", equals: "FHA" },
      ],
    },
  }),

  field("Client requested conditions", "reconciliation", "1300.0019", "Does Not Display", "Additional client requested conditions", "boolean", {
    required: true,
    initialValue: false,
  }),
  requestedCondition("1300.0022", "26.014", "Value condition", "multi_enum", {
    required: true,
    options: UAD_RECONCILIATION_VALUE_CONDITIONS,
  }),
  requestedCondition("1300.0026", "26.015", "Marketing or exposure time", "enum", {
    required: true,
    options: ["ClientImposedRestrictedMarketingTime", "ReasonableExposureTime"],
  }),
  requestedCondition("1300.0023", "26.016", "Duration (days)", "integer", {
    minimum: 0,
    maximum: 9999,
  }),
  requestedCondition("1300.0025", "26.016", "Duration low (days)", "integer", {
    minimum: 0,
    maximum: 9999,
  }),
  requestedCondition("1300.0024", "26.016", "Duration high (days)", "integer", {
    minimum: 0,
    maximum: 9999,
  }),
  requestedCondition("1300.0027", "26.017", "Alternate Opinion of Value", "currency", {
    required: true,
    minimumExclusive: 0,
    maximum: 999999999,
  }),
  field("Client requested conditions", "reconciliation", "1300.0029", "26.018", "Requested condition commentary", "text", {
    maxLength: 2500,
    showWhen: requestedConditionsExist,
    requiredWhen: requestedConditionsExist,
  }),

  field("Reconciliation of Market Value", "reconciliation", "1300.0021", "26.019", "Reconciliation of Market Value", "text", {
    required: true,
    maxLength: 5000,
    guidance: "Reconcile the approaches developed, explain their relative reliability, and support the final opinion of market value.",
  }),
  field(
    "Apparent defects, damages, and deficiencies",
    "defect_summary",
    "3900.0001",
    "Does Not Display",
    "Cost to repair reporting method",
    "enum",
    {
      options: ["None", "TotalCost", "Itemized"],
      guidance: "Required when this workfile has any defect, damage, or deficiency. Choose None, one total cost, or itemized repair costs.",
    },
  ),
  defectCost("site_defect", "site_defect", "3900.0126", "26.026", "site_defect:3900.0128"),
  defectCost("dwelling_exterior_defect", "dwelling_exterior_defect", "3900.0014", "26.033", "dwelling_exterior_defect:3900.0059"),
  defectCost("unit_interior_defect", "unit_interior_defect", "3900.0134", "26.041 / 26.057", "unit_interior_defect:3900.0136"),
  defectCost("outbuilding_defect", "outbuilding_defect", "3900.0168", "26.049", "outbuilding_defect:3900.0171"),
  defectCost("vehicle_storage_defect", "vehicle_storage_defect", "3900.0182", "26.063", "vehicle_storage_defect:3900.0185"),
  defectCost("subject_property_amenity_defect", "amenity_defect", "3900.0140", "26.069", "subject_property_amenity_defect:3900.0142"),
  field(
    "Apparent defects, damages, and deficiencies",
    "defect_summary",
    "3900.0002",
    "26.070 / 26.072",
    "Total estimated cost to repair",
    "currency",
    {
      minimum: 0,
      maximum: 99999999,
      showWhen: repairCostsProvided,
      requiredWhen: { key: "defect_summary:3900.0001", equals: "TotalCost" },
      guidance: "Enter the lump sum for Total Cost. For Itemized, the server replaces this value with the exact sum of the saved repair items.",
    },
  ),
  field("Apparent defects, damages, and deficiencies", "reconciliation", "1300.0034", "26.071", "As Is Overall Condition Rating", "enum", {
    options: ["C1", "C2", "C3", "C4", "C5", "C6"],
    showWhen: {
      all: [
        { key: "subject:0300.0010", equals: false },
        {
          any: [
            { key: "reconciliation:1300.0010", contains: "SubjectToCompletionPerPlans" },
            { key: "reconciliation:1300.0010", contains: "SubjectToRepair" },
          ],
        },
      ],
    },
    requiredWhen: {
      all: [
        { key: "subject:0300.0010", equals: false },
        {
          any: [
            { key: "reconciliation:1300.0010", contains: "SubjectToCompletionPerPlans" },
            { key: "reconciliation:1300.0010", contains: "SubjectToRepair" },
          ],
        },
      ],
    },
  }),
]);

export const UAD_RECONCILIATION_ENTITY_GROUPS = Object.freeze({
  additional_requested_conditional_valuation: Object.freeze({
    title: "Client requested conditions",
    addLabel: "Add client requested condition",
    minItems: 0,
    showWhen: requestedConditionsExist,
  }),
});

export const UAD_RECONCILIATION_FIELD_KEYS = Object.freeze({
  salesDeveloped: "sales_comparison_scope:1000.0032",
  incomeDeveloped: "scope_of_work:1000.0030",
  costDeveloped: "scope_of_work:1000.0027",
  marketValue: "reconciliation:1300.0017",
  marketValueConditions: "reconciliation:1300.0010",
  exposureDays: "reconciliation:1300.0013",
  exposureLow: "reconciliation:1300.0015",
  exposureHigh: "reconciliation:1300.0014",
  effectiveDate: "reconciliation:1300.0012",
  additionalConditions: "reconciliation:1300.0019",
  reconciliationComment: "reconciliation:1300.0021",
  repairCostMethod: "defect_summary:3900.0001",
  repairCostTotal: "defect_summary:3900.0002",
  asIsCondition: "reconciliation:1300.0034",
});

export { costDeveloped, incomeDeveloped, salesDeveloped };
