export const UAD_SALES_COMPARISON_CAPTION_TYPES = Object.freeze([
  "PropertyPhoto",
  "SalesComparisonApproachExhibit",
]);

export const UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES = Object.freeze([
  "AssessorRecord",
  "BuilderOrDeveloper",
  "CondominiumQuestionnaire",
  "CooperativeBoard",
  "CooperativeQuestionnaire",
  "DataAggregator",
  "ExteriorInspection",
  "HomeownersAssociation",
  "InteriorInspection",
  "LandSurvey",
  "MLS",
  "Other",
  "PreviousAppraisalFile",
  "PropertyManagementCompany",
  "PropertyOwner",
  "RealEstateAgent",
]);

export const UAD_SALES_COMPARABLE_LISTING_STATUSES = Object.freeze([
  "Active",
  "OffMarket",
  "Pending",
  "SettledSale",
]);

export const UAD_SALES_COMPARABLE_DIRECTIONS = Object.freeze([
  "East", "North", "NorthEast", "NorthWest", "South", "SouthEast", "SouthWest", "West",
]);

export const UAD_SALES_COMPARABLE_FINANCING_TYPES = Object.freeze([
  "Conventional", "FHA", "Other", "Private", "USDARuralDevelopment", "VA",
]);

export const UAD_SALES_COMPARABLE_TRANSFER_TYPES = Object.freeze([
  "CourtOrderedNonForeclosureSale",
  "EstateSale",
  "ForeclosureSale",
  "LandSale",
  "Other",
  "PreSubdivisionSale",
  "RelocationSale",
  "REOSale",
  "SaleBetweenRelatedParties",
  "ShortSale",
  "TypicallyMotivated",
]);

export const UAD_SALES_COMPARABLE_PROPERTY_RIGHTS = Object.freeze([
  "FeeSimple", "Leasehold", "Other",
]);

export const UAD_NATIVE_AMERICAN_LAND_TYPES = Object.freeze([
  "AlaskaNativeCorporationLand", "HawaiianHomeLands", "Other", "TribalTrustLand",
]);

export const UAD_PROPERTY_RIGHTS_NOT_INCLUDED = Object.freeze([
  "AirRights", "MineralRights", "Other", "TimberRights", "WaterRights",
]);

export const salesComparisonIncluded = Object.freeze({
  key: "sales_comparison_scope:1000.0032",
  equals: true,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "sales_comparison",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const comparableGroup = "Sales comparables — general information";
const comp = (contextKey, uid, reportFieldId, label, dataType, options = {}) => field(
  comparableGroup,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  { entityType: "sales_comparable", showWhen: salesComparisonIncluded, ...options },
);
const includedAnd = (condition) => Object.freeze({ all: [salesComparisonIncluded, condition] });
const statusIs = (value) => Object.freeze({
  key: "sales_comparable_listing:1800.0075",
  equals: value,
});
const pendingOrSettled = Object.freeze({
  any: [statusIs("Pending"), statusIs("SettledSale")],
});
const settled = statusIs("SettledSale");
const notSettled = Object.freeze({
  key: "sales_comparable_listing:1800.0075",
  notEquals: "SettledSale",
});

const adjustment = (contextKey, reportFieldId, label, condition = salesComparisonIncluded) => comp(
  contextKey,
  "1800.0317",
  reportFieldId,
  label,
  "currency",
  { showWhen: condition, maximum: 999999999 },
);

export const UAD_SALES_COMPARISON_FIELDS = Object.freeze([
  field(
    "Approach scope",
    "sales_comparison_scope",
    "1000.0032",
    "Does Not Display",
    "Sales Comparison Approach developed by appraiser",
    "boolean",
    {
      required: true,
      guidance: "Choose Yes when this assignment will include the Sales Comparison Approach and its comparable grid.",
    },
  ),

  comp("sales_comparable_address", "1800.0001", "22.01.17", "Address line", "string", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 100,
  }),
  comp("sales_comparable_address", "1800.0002", "22.01.17", "Unit identifier", "string", {
    maxLength: 12,
  }),
  comp("sales_comparable_address", "1800.0400", "22.01.17", "Unit designator", "enum", {
    options: ["Unit"],
    showWhen: includedAnd({ key: "sales_comparable_address:1800.0002", present: true }),
    requiredWhen: { key: "sales_comparable_address:1800.0002", present: true },
  }),
  comp("sales_comparable_address", "1800.0003", "22.01.17", "City", "string", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 50,
  }),
  comp("sales_comparable_address", "1800.0005", "22.01.17", "State", "state", {
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_address", "1800.0004", "22.01.17", "ZIP code", "postal_code", {
    requiredWhen: salesComparisonIncluded,
    maxLength: 10,
  }),
  comp("sales_comparable_property", "0100.0059", "Does Not Display", "Number of ADUs on property", "integer", {
    requiredWhen: salesComparisonIncluded,
    minimum: 0,
    maximum: 9,
    guidance: "Enter 0 when the comparable has no accessory dwelling units.",
  }),
  comp("sales_comparable_proximity", "1800.0065", "22.01.19", "Proximity to subject", "measurement", {
    requiredWhen: salesComparisonIncluded,
    units: ["Miles", "Kilometers"],
    minimum: 0,
    maximum: 999.99,
  }),
  comp("sales_comparable_proximity", "1800.0066", "22.01.19", "Direction from subject", "enum", {
    options: UAD_SALES_COMPARABLE_DIRECTIONS,
    showWhen: includedAnd({ key: "sales_comparable_proximity:1800.0065", greaterThan: 0 }),
    requiredWhen: { key: "sales_comparable_proximity:1800.0065", greaterThan: 0 },
  }),
  comp("sales_comparable_listing", "1800.0074", "22.01.20", "Last known list price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
  }),
  comp("sales_comparable_listing", "1800.0075", "22.01.21", "Listing status", "enum", {
    options: UAD_SALES_COMPARABLE_LISTING_STATUSES,
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_contract", "1800.0384", "22.01.22", "Contract price unknown", "boolean", {
    showWhen: includedAnd(statusIs("Pending")),
    requiredWhen: statusIs("Pending"),
  }),
  comp("sales_comparable_contract", "1800.0271", "22.01.22", "Contract price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ all: [statusIs("Pending"), { key: "sales_comparable_contract:1800.0384", equals: false }] }),
    requiredWhen: { all: [statusIs("Pending"), { key: "sales_comparable_contract:1800.0384", equals: false }] },
  }),
  comp("sales_comparable_sale", "1800.0272", "22.01.23", "Sale price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_sale", "1800.0274", "22.01.24", "Transfer terms", "enum", {
    options: UAD_SALES_COMPARABLE_TRANSFER_TYPES,
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_sale", "1800.0275", "22.01.24", "Other transfer terms", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_sale:1800.0274", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_sale:1800.0274", equals: "Other" },
  }),
  comp("sales_comparable_financing", "1800.0381", "22.01.26", "Transaction executed without financing", "boolean", {
    showWhen: includedAnd(settled),
  }),
  comp("sales_comparable_financing", "1800.0063", "22.01.26", "Primary financing type", "enum", {
    options: UAD_SALES_COMPARABLE_FINANCING_TYPES,
    showWhen: includedAnd({ key: "sales_comparable_financing:1800.0381", equals: false }),
    requiredWhen: { key: "sales_comparable_financing:1800.0381", equals: false },
  }),
  comp("sales_comparable_financing", "1800.0064", "22.01.26", "Other financing type", "string", {
    maxLength: 21,
    showWhen: includedAnd({ key: "sales_comparable_financing:1800.0063", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_financing:1800.0063", equals: "Other" },
  }),
  comp("sales_comparable_concessions", "1800.0370", "22.01.28", "Known sales concessions", "boolean", {
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_concessions", "1800.0369", "22.01.28", "Sales concession amount known", "boolean", {
    showWhen: includedAnd({ key: "sales_comparable_concessions:1800.0370", equals: true }),
    requiredWhen: { key: "sales_comparable_concessions:1800.0370", equals: true },
  }),
  comp("sales_comparable_concessions", "1800.0203", "22.01.28", "Total sales concessions", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ key: "sales_comparable_concessions:1800.0369", equals: true }),
    requiredWhen: { key: "sales_comparable_concessions:1800.0369", equals: true },
  }),
  comp("sales_comparable_contract", "1800.0385", "22.01.30", "Contract date unknown", "boolean", {
    showWhen: includedAnd(pendingOrSettled),
    requiredWhen: pendingOrSettled,
  }),
  comp("sales_comparable_contract", "1800.0202", "22.01.30", "Contract date", "date", {
    showWhen: includedAnd({ all: [pendingOrSettled, { key: "sales_comparable_contract:1800.0385", equals: false }] }),
    requiredWhen: { all: [pendingOrSettled, { key: "sales_comparable_contract:1800.0385", equals: false }] },
  }),
  comp("sales_comparable_sale", "1800.0342", "22.01.32", "Sale date", "date", {
    showWhen: includedAnd(settled),
    requiredWhen: settled,
  }),
  comp("sales_comparable_listing", "1800.0189", "22.01.34", "Days on market", "integer", {
    requiredWhen: salesComparisonIncluded,
    minimum: 0,
    maximum: 9999,
  }),
  comp("sales_comparable_listing", "1800.0316", "22.01.35", "Sale to list price ratio", "percentage", {
    minimum: 0,
    maximum: 999,
    showWhen: includedAnd(notSettled),
  }),
  comp("sales_comparable_property", "1800.0195", "22.01.37", "Attached or detached", "enum", {
    options: ["Attached", "Detached"],
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_property", "1800.0337", "22.01.39", "Property rights appraised", "enum", {
    options: UAD_SALES_COMPARABLE_PROPERTY_RIGHTS,
    requiredWhen: salesComparisonIncluded,
  }),
  comp("sales_comparable_property", "1800.0338", "22.01.39", "Other property rights", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0337", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_property:1800.0337", equals: "Other" },
  }),
  comp("sales_comparable_property", "1800.0077", "22.01.41", "Annual ground rent", "currency", {
    minimum: 0,
    maximum: 999999999.99,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0337", equals: "Leasehold" }),
    requiredWhen: { key: "sales_comparable_property:1800.0337", equals: "Leasehold" },
  }),
  comp("sales_comparable_property", "1800.0357", "22.01.42", "Property on Native American lands", "boolean"),
  comp("sales_comparable_property", "1800.0358", "22.01.42", "Native American lands type", "enum", {
    options: UAD_NATIVE_AMERICAN_LAND_TYPES,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0357", equals: true }),
    requiredWhen: { key: "sales_comparable_property:1800.0357", equals: true },
  }),
  comp("sales_comparable_property", "1800.0359", "22.01.42", "Other Native American lands type", "string", {
    maxLength: 33,
    showWhen: includedAnd({ key: "sales_comparable_property:1800.0358", equals: "Other" }),
    requiredWhen: { key: "sales_comparable_property:1800.0358", equals: "Other" },
  }),
  comp("sales_comparable_property", "1800.0201", "22.01.44", "All property rights included", "boolean"),
  comp("sales_comparable_property", "1800.0082", "22.01.47", "Same builder as subject", "boolean", {
    showWhen: includedAnd({ key: "subject:0300.0010", equals: true }),
    requiredWhen: { key: "subject:0300.0010", equals: true },
  }),

  adjustment("sales_comparable_adjustment_transfer_terms", "22.01.25", "Transfer terms adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_financing", "22.01.27", "Financing adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_concessions", "22.01.29", "Sales concessions adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_contract_date", "22.01.31", "Contract date adjustment", includedAnd(pendingOrSettled)),
  adjustment("sales_comparable_adjustment_sale_date", "22.01.33", "Sale date adjustment", includedAnd(settled)),
  adjustment("sales_comparable_adjustment_sale_list_ratio", "22.01.36", "Sale to list price ratio adjustment", includedAnd(notSettled)),
  adjustment("sales_comparable_adjustment_attachment", "22.01.38", "Attached or detached adjustment"),
  adjustment("sales_comparable_adjustment_property_rights", "22.01.40", "Property rights adjustment"),
  adjustment("sales_comparable_adjustment_native_lands", "22.01.43", "Native American lands adjustment", includedAnd({ key: "sales_comparable_property:1800.0357", present: true })),
  adjustment("sales_comparable_adjustment_all_rights", "22.01.45", "All rights included adjustment", includedAnd({ key: "sales_comparable_property:1800.0201", present: true })),

  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "0700.0125",
    "22.01.18",
    "Data source",
    "enum",
    {
      entityType: "sales_comparable_data_source",
      options: UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES,
      required: true,
    },
  ),
  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "1800.0347",
    "22.01.18",
    "Data source identifier",
    "string",
    {
      entityType: "sales_comparable_data_source",
      maxLength: 45,
      requiredWhen: { key: "sales_comparable_data_source:0700.0125", equals: "MLS" },
      guidance: "The MLS number is required for MLS sources. Report an identifier for any other source that provides one.",
    },
  ),
  field(
    "Comparable data sources",
    "sales_comparable_data_source",
    "0700.0126",
    "22.01.18",
    "Other data source",
    "string",
    {
      entityType: "sales_comparable_data_source",
      maxLength: 66,
      showWhen: { key: "sales_comparable_data_source:0700.0125", equals: "Other" },
      requiredWhen: { key: "sales_comparable_data_source:0700.0125", equals: "Other" },
    },
  ),
  field(
    "Comparable rights not included",
    "sales_comparable_right_not_included",
    "1800.0340",
    "22.01.46",
    "Right not included",
    "enum",
    {
      entityType: "sales_comparable_right_not_included",
      options: UAD_PROPERTY_RIGHTS_NOT_INCLUDED,
      required: true,
    },
  ),
  field(
    "Comparable rights not included",
    "sales_comparable_right_not_included",
    "1800.0341",
    "22.01.46",
    "Other right not included",
    "string",
    {
      entityType: "sales_comparable_right_not_included",
      maxLength: 33,
      showWhen: { key: "sales_comparable_right_not_included:1800.0340", equals: "Other" },
      requiredWhen: { key: "sales_comparable_right_not_included:1800.0340", equals: "Other" },
    },
  ),
]);

export const UAD_SALES_COMPARISON_ENTITY_GROUPS = Object.freeze({
  sales_comparable_data_source: Object.freeze({
    title: "Comparable data sources",
    addLabel: "Add comparable data source",
    minItems: 0,
    maxItems: UAD_SALES_COMPARABLE_DATA_SOURCE_TYPES.length,
    parentEntityType: "sales_comparable",
    showWhen: salesComparisonIncluded,
  }),
  sales_comparable_right_not_included: Object.freeze({
    title: "Comparable rights not included",
    addLabel: "Add excluded right",
    minItems: 0,
    maxItems: UAD_PROPERTY_RIGHTS_NOT_INCLUDED.length,
    parentEntityType: "sales_comparable",
    showWhen: { key: "sales_comparable_property:1800.0201", equals: false },
  }),
});

export const UAD_SALES_COMPARISON_FIELD_KEYS = Object.freeze({
  included: "sales_comparison_scope:1000.0032",
  ordinal: "sales_comparable:1800.0192",
  dataSourceType: "sales_comparable_data_source:0700.0125",
  dataSourceIdentifier: "sales_comparable_data_source:1800.0347",
  dataSourceOther: "sales_comparable_data_source:0700.0126",
  listingStatus: "sales_comparable_listing:1800.0075",
  contractPriceUnknown: "sales_comparable_contract:1800.0384",
  contractPrice: "sales_comparable_contract:1800.0271",
  salePrice: "sales_comparable_sale:1800.0272",
  saleType: "sales_comparable_sale:1800.0274",
  saleTypeOther: "sales_comparable_sale:1800.0275",
  noFinancing: "sales_comparable_financing:1800.0381",
  financingType: "sales_comparable_financing:1800.0063",
  financingOther: "sales_comparable_financing:1800.0064",
  concessions: "sales_comparable_concessions:1800.0370",
  concessionAmountKnown: "sales_comparable_concessions:1800.0369",
  concessionAmount: "sales_comparable_concessions:1800.0203",
  contractDateUnknown: "sales_comparable_contract:1800.0385",
  contractDate: "sales_comparable_contract:1800.0202",
  saleDate: "sales_comparable_sale:1800.0342",
  propertyRights: "sales_comparable_property:1800.0337",
  propertyRightsOther: "sales_comparable_property:1800.0338",
  nativeLands: "sales_comparable_property:1800.0357",
  nativeLandsType: "sales_comparable_property:1800.0358",
  nativeLandsOther: "sales_comparable_property:1800.0359",
  allRightsIncluded: "sales_comparable_property:1800.0201",
  rightNotIncluded: "sales_comparable_right_not_included:1800.0340",
});

export function isVerifiedSalesComparisonAsset(asset, captionType = null, entityId = undefined) {
  return asset?.section_number === 22
    && asset?.status === "verified"
    && UAD_SALES_COMPARISON_CAPTION_TYPES.includes(asset?.caption_type)
    && (!captionType || asset?.caption_type === captionType)
    && (entityId === undefined || asset?.entity_id === entityId)
    && UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}
