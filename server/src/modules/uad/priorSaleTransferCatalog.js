export const UAD_PRIOR_TRANSFER_CAPTION_TYPES = Object.freeze([
  "PriorSaleAndTransferHistoryExhibit",
]);

export const UAD_PRIOR_TRANSFER_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES = Object.freeze([
  "AssessorRecord",
  "BuilderOrDeveloper",
  "CooperativeBoard",
  "DataAggregator",
  "Deed",
  "HomeownersAssociation",
  "MLS",
  "Other",
  "PreviousAppraisalFile",
  "PropertyManagementCompany",
  "PropertyOwner",
  "PropertyTenant",
]);

export const UAD_OWNERSHIP_TRANSFER_TYPES = Object.freeze([
  "DeedTransferOnly",
  "Sale",
]);

export const UAD_PRIOR_SALE_TYPES = Object.freeze([
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

export const UAD_TRANSFER_AMOUNT_UNAVAILABLE_REASONS = Object.freeze([
  "NotDisclosed",
  "NotRecorded",
  "Other",
]);

const subjectHasTransfers = Object.freeze({
  key: "subject_prior_transfer_summary:0800.0005",
  equals: true,
});

const subjectHasNoTransfers = Object.freeze({
  key: "subject_prior_transfer_summary:0800.0005",
  equals: false,
});

const comparableHasTransfers = Object.freeze({
  key: "comparable_prior_transfer_summary:1800.0198",
  equals: true,
});

const comparableHasNoTransfers = Object.freeze({
  key: "comparable_prior_transfer_summary:1800.0198",
  equals: false,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "prior_sale_transfer_history",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const dataSourceFields = ({ group, contextKey, entityType, reportFieldId }) => [
  field(group, contextKey, "0700.0125", reportFieldId, "Data source", "enum", {
    entityType,
    options: UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES,
    required: true,
  }),
  field(group, contextKey, "0700.0126", reportFieldId, "Other data source", "string", {
    entityType,
    maxLength: 66,
    showWhen: { key: `${contextKey}:0700.0125`, equals: "Other" },
    requiredWhen: { key: `${contextKey}:0700.0125`, equals: "Other" },
  }),
];

const transferFields = ({
  group,
  contextKey,
  entityType,
  uidPrefix,
  reportFieldIds,
}) => {
  const transactionTypeUid = uidPrefix === "0800" ? "0800.0018" : "1800.0209";
  const saleTypeUid = uidPrefix === "0800" ? "0800.0013" : "1800.0210";
  const saleTypeOtherUid = uidPrefix === "0800" ? "0800.0014" : "1800.0211";
  const dateUid = uidPrefix === "0800" ? "0800.0011" : "1800.0207";
  const amountUid = uidPrefix === "0800" ? "0800.0012" : "1800.0208";
  const unavailableUid = uidPrefix === "0800" ? "0800.0009" : "1800.0205";
  const unavailableOtherUid = uidPrefix === "0800" ? "0800.0010" : "1800.0206";
  const transactionTypeKey = `${contextKey}:${transactionTypeUid}`;
  const saleTypeKey = `${contextKey}:${saleTypeUid}`;
  const amountKey = `${contextKey}:${amountUid}`;
  const unavailableKey = `${contextKey}:${unavailableUid}`;
  const saleTransaction = { key: transactionTypeKey, equals: "Sale" };
  return [
    field(group, contextKey, transactionTypeUid, reportFieldIds.terms, "Ownership transfer type", "enum", {
      entityType,
      options: UAD_OWNERSHIP_TRANSFER_TYPES,
      required: true,
    }),
    field(group, contextKey, saleTypeUid, reportFieldIds.terms, "Prior sale type", "enum", {
      entityType,
      options: UAD_PRIOR_SALE_TYPES,
      showWhen: saleTransaction,
      requiredWhen: saleTransaction,
      guidance: "If more than one prior sale type applies, select the most applicable and explain the others in the applicable analysis field.",
    }),
    field(group, contextKey, saleTypeOtherUid, reportFieldIds.terms, "Other prior sale type", "string", {
      entityType,
      maxLength: 33,
      showWhen: { all: [saleTransaction, { key: saleTypeKey, equals: "Other" }] },
      requiredWhen: { key: saleTypeKey, equals: "Other" },
    }),
    field(group, contextKey, dateUid, reportFieldIds.date, "Transfer date", "date", {
      entityType,
      required: true,
    }),
    field(group, contextKey, amountUid, reportFieldIds.amount, "Transfer amount", "currency", {
      entityType,
      minimum: 0,
      maximum: 999999999.99,
      requiredWhen: { key: unavailableKey, present: false },
      guidance: "Enter zero for a transfer with no monetary consideration. Otherwise provide either the amount or a reason it is unavailable.",
    }),
    field(group, contextKey, unavailableUid, reportFieldIds.amount, "Amount unavailable reason", "enum", {
      entityType,
      options: UAD_TRANSFER_AMOUNT_UNAVAILABLE_REASONS,
      showWhen: { key: amountKey, present: false },
      requiredWhen: { key: amountKey, present: false },
    }),
    field(group, contextKey, unavailableOtherUid, reportFieldIds.amount, "Other amount unavailable reason", "string", {
      entityType,
      maxLength: 66,
      showWhen: { key: unavailableKey, equals: "Other" },
      requiredWhen: { key: unavailableKey, equals: "Other" },
    }),
  ];
};

export const UAD_PRIOR_SALE_TRANSFER_FIELDS = Object.freeze([
  field(
    "Subject transfer history",
    "subject_prior_transfer_summary",
    "0800.0005",
    "21.000",
    "Prior sales or transfers",
    "boolean",
    {
      required: true,
      guidance: "Report every relevant subject sale or transfer during the three years before the appraisal effective date, and older transactions when relevant. Do not repeat the current subject sale.",
    },
  ),
  ...dataSourceFields({
    group: "Subject no-transfer data sources",
    contextKey: "subject_no_prior_transfer_data_source",
    entityType: "subject_no_prior_transfer_data_source",
    reportFieldId: "21.001",
  }),
  ...transferFields({
    group: "Subject prior sales or transfers",
    contextKey: "subject_prior_transfer",
    entityType: "subject_prior_transfer",
    uidPrefix: "0800",
    reportFieldIds: { terms: "21.002", date: "21.003", amount: "21.004" },
  }),
  ...dataSourceFields({
    group: "Subject transfer data sources",
    contextKey: "subject_prior_transfer_data_source",
    entityType: "subject_prior_transfer_data_source",
    reportFieldId: "21.005",
  }),
  field(
    "Subject transfer analysis",
    "subject_prior_transfer_commentary",
    "1600.0008",
    "21.006",
    "Analysis of subject prior sale and transfer history",
    "text",
    {
      required: true,
      maxLength: 5000,
      guidance: "Explain the research performed, transaction details, differences among transactions, and the effect of the subject's prior sale or transfer history.",
    },
  ),
  field(
    "Comparable transfer history",
    "sales_comparable",
    "1800.0192",
    "21.007",
    "Comparable number",
    "integer",
    {
      entityType: "sales_comparable",
      required: true,
      minimum: 1,
      maximum: 99,
      guidance: "This is the same appraiser-assigned comparable number used in the Sales Comparison Approach.",
    },
  ),
  field(
    "Comparable transfer history",
    "comparable_prior_transfer_summary",
    "1800.0198",
    "21.008",
    "Prior sales or transfers for comparable",
    "boolean",
    {
      entityType: "sales_comparable",
      required: true,
      guidance: "Use a one-year lookback before the comparable sale date for settled comparables, or before the appraisal effective date for non-settled comparables.",
    },
  ),
  ...dataSourceFields({
    group: "Comparable no-transfer data sources",
    contextKey: "comparable_no_prior_transfer_data_source",
    entityType: "comparable_no_prior_transfer_data_source",
    reportFieldId: "21.011",
  }),
  ...transferFields({
    group: "Comparable prior sales or transfers",
    contextKey: "comparable_prior_transfer",
    entityType: "comparable_prior_transfer",
    uidPrefix: "1800",
    reportFieldIds: { terms: "21.008", date: "21.009", amount: "21.010" },
  }),
  ...dataSourceFields({
    group: "Comparable transfer data sources",
    contextKey: "comparable_prior_transfer_data_source",
    entityType: "comparable_prior_transfer_data_source",
    reportFieldId: "21.011",
  }),
  field(
    "Comparable transfer analysis",
    "comparable_prior_transfer_commentary",
    "1600.0008",
    "21.012",
    "Analysis of comparable prior sale and transfer history",
    "text",
    {
      required: true,
      maxLength: 5000,
      guidance: "Explain the research performed, details of the comparable transactions, and any differences among them. The field is required even when no sales comparables have been selected yet.",
    },
  ),
]);

export const UAD_PRIOR_SALE_TRANSFER_ENTITY_GROUPS = Object.freeze({
  subject_no_prior_transfer_data_source: Object.freeze({
    title: "Subject no-transfer data sources",
    addLabel: "Add subject data source",
    minItems: 0,
    maxItems: UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES.length,
    showWhen: subjectHasNoTransfers,
  }),
  subject_prior_transfer: Object.freeze({
    title: "Subject prior sales or transfers",
    addLabel: "Add subject transfer",
    minItems: 0,
    maxItems: 12,
    showWhen: subjectHasTransfers,
  }),
  subject_prior_transfer_data_source: Object.freeze({
    title: "Subject transfer data sources",
    addLabel: "Add transfer data source",
    minItems: 0,
    maxItems: UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES.length,
    parentEntityType: "subject_prior_transfer",
  }),
  sales_comparable: Object.freeze({
    title: "Sales comparables",
    addLabel: "Add sales comparable",
    minItems: 0,
    maxItems: 99,
    createEnabled: false,
    variants: Object.freeze({
      "Sales comparables — general information": Object.freeze({
        addLabel: "Add sales comparable",
        createEnabled: true,
        showWhen: Object.freeze({ key: "sales_comparison_scope:1000.0032", equals: true }),
      }),
    }),
  }),
  comparable_no_prior_transfer_data_source: Object.freeze({
    title: "Comparable no-transfer data sources",
    addLabel: "Add comparable data source",
    minItems: 0,
    maxItems: UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES.length,
    parentEntityType: "sales_comparable",
    showWhen: comparableHasNoTransfers,
  }),
  comparable_prior_transfer: Object.freeze({
    title: "Comparable prior sales or transfers",
    addLabel: "Add comparable transfer",
    minItems: 0,
    maxItems: 12,
    parentEntityType: "sales_comparable",
    showWhen: comparableHasTransfers,
  }),
  comparable_prior_transfer_data_source: Object.freeze({
    title: "Comparable transfer data sources",
    addLabel: "Add transfer data source",
    minItems: 0,
    maxItems: UAD_PRIOR_TRANSFER_DATA_SOURCE_TYPES.length,
    parentEntityType: "comparable_prior_transfer",
  }),
});

export const UAD_PRIOR_TRANSFER_FIELD_KEYS = Object.freeze({
  subjectHasTransfers: "subject_prior_transfer_summary:0800.0005",
  subjectNoTransferDataSource: "subject_no_prior_transfer_data_source:0700.0125",
  subjectTransactionType: "subject_prior_transfer:0800.0018",
  subjectSaleType: "subject_prior_transfer:0800.0013",
  subjectSaleTypeOther: "subject_prior_transfer:0800.0014",
  subjectDate: "subject_prior_transfer:0800.0011",
  subjectAmount: "subject_prior_transfer:0800.0012",
  subjectAmountUnavailable: "subject_prior_transfer:0800.0009",
  subjectAmountUnavailableOther: "subject_prior_transfer:0800.0010",
  subjectTransferDataSource: "subject_prior_transfer_data_source:0700.0125",
  comparableOrdinal: "sales_comparable:1800.0192",
  comparableHasTransfers: "comparable_prior_transfer_summary:1800.0198",
  comparableNoTransferDataSource: "comparable_no_prior_transfer_data_source:0700.0125",
  comparableTransactionType: "comparable_prior_transfer:1800.0209",
  comparableSaleType: "comparable_prior_transfer:1800.0210",
  comparableSaleTypeOther: "comparable_prior_transfer:1800.0211",
  comparableDate: "comparable_prior_transfer:1800.0207",
  comparableAmount: "comparable_prior_transfer:1800.0208",
  comparableAmountUnavailable: "comparable_prior_transfer:1800.0205",
  comparableAmountUnavailableOther: "comparable_prior_transfer:1800.0206",
  comparableTransferDataSource: "comparable_prior_transfer_data_source:0700.0125",
});

export function isVerifiedPriorSaleTransferAsset(asset) {
  return asset?.section_number === 21
    && asset?.status === "verified"
    && UAD_PRIOR_TRANSFER_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_PRIOR_TRANSFER_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export {
  comparableHasNoTransfers,
  comparableHasTransfers,
  subjectHasNoTransfers,
  subjectHasTransfers,
};
