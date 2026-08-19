export const UAD_SUBJECT_LISTING_CAPTION_TYPES = Object.freeze([
  "SubjectListingExhibit",
]);

export const UAD_SUBJECT_LISTING_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SUBJECT_LISTING_DATA_SOURCE_TYPES = Object.freeze([
  "AssessorRecord", "BuilderOrDeveloper", "CondominiumQuestionnaire", "CooperativeBoard",
  "CooperativeQuestionnaire", "DataAggregator", "HomeownersAssociation", "LandSurvey", "MLS",
  "Other", "PreviousAppraisalFile", "PropertyManagementCompany", "PropertyOwner",
  "PropertyTenant", "RealEstateAgent",
]);

export const UAD_SUBJECT_LISTING_STATUS_TYPES = Object.freeze([
  "Active", "OffMarket", "Pending",
]);

export const UAD_SUBJECT_LISTING_TYPES = Object.freeze([
  "Auction", "ForSaleByOwner", "MLS", "Other",
]);

const relevantListingsExist = Object.freeze({
  key: "subject_listing_summary:0900.0004",
  equals: true,
});

const noRelevantListings = Object.freeze({
  key: "subject_listing_summary:0900.0004",
  equals: false,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "subject_listing_information",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const listingField = (uid, reportFieldId, label, dataType, options = {}) => field(
  "Information for each listing",
  "subject_listing",
  uid,
  reportFieldId,
  label,
  dataType,
  {
    entityType: "subject_listing",
    showWhen: relevantListingsExist,
    ...options,
  },
);

export const UAD_SUBJECT_LISTING_FIELDS = Object.freeze([
  field(
    "Relevant listings",
    "subject_listing_summary",
    "0900.0004",
    "19.000",
    "Current or relevant listings",
    "boolean",
    {
      required: true,
      guidance: "Use a minimum one-year lookback. Do not include listings that resulted in a settled sale; report those in Prior Sale and Transfer History.",
    },
  ),

  field(
    "No relevant listings data sources",
    "subject_listing_data_source",
    "0700.0125",
    "19.001",
    "Data source",
    "enum",
    {
      entityType: "subject_listing_data_source",
      required: true,
      options: UAD_SUBJECT_LISTING_DATA_SOURCE_TYPES,
      showWhen: noRelevantListings,
    },
  ),
  field(
    "No relevant listings data sources",
    "subject_listing_data_source",
    "0700.0126",
    "19.001",
    "Other data source",
    "string",
    {
      entityType: "subject_listing_data_source",
      maxLength: 66,
      showWhen: { all: [noRelevantListings, { key: "subject_listing_data_source:0700.0125", equals: "Other" }] },
      requiredWhen: { key: "subject_listing_data_source:0700.0125", equals: "Other" },
    },
  ),

  listingField("0900.0013", "19.002", "Listing status", "enum", {
    required: true,
    options: UAD_SUBJECT_LISTING_STATUS_TYPES,
  }),
  listingField("0900.0015", "19.003", "Listing type", "enum", {
    required: true,
    options: UAD_SUBJECT_LISTING_TYPES,
  }),
  listingField("0900.0016", "19.003", "Other listing type", "string", {
    maxLength: 45,
    showWhen: { all: [relevantListingsExist, { key: "subject_listing:0900.0015", equals: "Other" }] },
    requiredWhen: { key: "subject_listing:0900.0015", equals: "Other" },
  }),
  listingField("0900.0011", "19.004", "Listing ID", "string", {
    maxLength: 45,
    requiredWhen: { key: "subject_listing:0900.0015", equals: "MLS" },
    guidance: "MLS listings require the MLS number when available. Non-MLS third-party identifiers may also be recorded.",
  }),
  listingField("0900.0012", "19.005", "Start date", "date"),
  listingField("0900.0010", "19.006", "End date", "date"),
  listingField("0900.0007", "19.007", "Days on market", "integer", {
    required: true,
    minimum: 0,
    maximum: 9999,
    guidance: "Use 0 when the property was not exposed through a publicly available source and 1 when it was listed and placed under contract the same day.",
  }),
  listingField("0900.0009", "19.008", "Starting list price", "currency", {
    minimum: 0,
    maximum: 999999999.99,
  }),
  listingField("0900.0008", "19.009", "Current or final list price", "currency", {
    required: true,
    minimum: 0,
    maximum: 999999999.99,
  }),

  field(
    "Total days on market",
    "subject_listing_summary",
    "0900.0003",
    "19.010",
    "Total days on market",
    "integer",
    {
      showWhen: relevantListingsExist,
      requiredWhen: relevantListingsExist,
      minimum: 0,
      maximum: 9999,
      guidance: "Enter the sum of Days on Market for all listing rows. Do not include breaks within or between listing periods.",
    },
  ),
  field(
    "Listing history analysis",
    "subject_listing_commentary",
    "0900.0020",
    "19.011",
    "Analysis of subject property listing history",
    "text",
    {
      showWhen: relevantListingsExist,
      requiredWhen: relevantListingsExist,
      maxLength: 5000,
      guidance: "Analyze relevant listing history not captured in the discrete fields, including atypical exposure or multiple periods on and off the market.",
    },
  ),
]);

export const UAD_SUBJECT_LISTING_ENTITY_GROUPS = Object.freeze({
  subject_listing_data_source: Object.freeze({
    title: "No relevant listings data sources",
    addLabel: "Add data source",
    minItems: 0,
    maxItems: UAD_SUBJECT_LISTING_DATA_SOURCE_TYPES.length,
    showWhen: noRelevantListings,
  }),
  subject_listing: Object.freeze({
    title: "Information for each listing",
    addLabel: "Add listing",
    minItems: 0,
    maxItems: 6,
    showWhen: relevantListingsExist,
  }),
});

export const UAD_SUBJECT_LISTING_FIELD_KEYS = Object.freeze({
  relevantListings: "subject_listing_summary:0900.0004",
  dataSource: "subject_listing_data_source:0700.0125",
  listingStatus: "subject_listing:0900.0013",
  listingType: "subject_listing:0900.0015",
  listingId: "subject_listing:0900.0011",
  listingStartDate: "subject_listing:0900.0012",
  listingEndDate: "subject_listing:0900.0010",
  daysOnMarket: "subject_listing:0900.0007",
  totalDaysOnMarket: "subject_listing_summary:0900.0003",
});

export function isVerifiedSubjectListingAsset(asset) {
  return asset?.section_number === 19
    && asset?.status === "verified"
    && UAD_SUBJECT_LISTING_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_SUBJECT_LISTING_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export { noRelevantListings, relevantListingsExist };
