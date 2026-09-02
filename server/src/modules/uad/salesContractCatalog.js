export const UAD_SALES_CONTRACT_CAPTION_TYPES = Object.freeze([
  "SalesContractExhibit",
]);

export const UAD_SALES_CONTRACT_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_SALES_CONTRACT_TRANSFER_TERMS = Object.freeze([
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

const contractExists = Object.freeze({
  key: "sales_contract:0600.0016",
  equals: true,
});

const contractReviewed = Object.freeze({
  key: "sales_contract:0600.0010",
  equals: true,
});

const field = (group, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "sales_contract",
  group,
  contextKey: options.contextKey || "sales_contract",
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

export const UAD_SALES_CONTRACT_FIELDS = Object.freeze([
  field("Contract availability", "0600.0016", "20.000", "Is there a sales contract?", "boolean", {
    required: true,
    guidance: "Answer Yes only when an active sales contract is associated with the subject property. The report section does not display when the answer is No.",
  }),
  field("Contract review", "0600.0010", "20.001", "Was sales contract information analyzed?", "boolean", {
    showWhen: contractExists,
    requiredWhen: contractExists,
  }),
  field("Contract review", "0600.0002", "20.002", "Does this appear to be an arm's length transaction?", "boolean", {
    showWhen: contractExists,
    requiredWhen: contractExists,
    guidance: "This conclusion always requires the appraiser's manual review and is never selected from document extraction.",
  }),
  field("Contract review", "0600.0003", "20.003", "Non-arm's length commentary", "text", {
    maxLength: 1250,
    showWhen: { all: [contractExists, { key: "sales_contract:0600.0002", equals: false }] },
    requiredWhen: { key: "sales_contract:0600.0002", equals: false },
  }),
  field("Contract terms", "0600.0008", "20.004", "Contract price", "currency", {
    minimum: 0.01,
    maximum: 999999999.99,
    showWhen: contractReviewed,
    requiredWhen: contractReviewed,
  }),
  field("Contract terms", "0600.0009", "20.005", "Contract date", "date", {
    showWhen: contractReviewed,
    requiredWhen: contractReviewed,
    guidance: "Use the date the sales contract was fully executed. It must use YYYY-MM-DD.",
  }),
  field("Contract terms", "0600.0017", "20.006", "Transfer terms", "enum", {
    options: UAD_SALES_CONTRACT_TRANSFER_TERMS,
    showWhen: contractReviewed,
    requiredWhen: contractReviewed,
    guidance: "If more than one transfer term applies, select the most applicable term.",
  }),
  field("Contract terms", "0600.0018", "20.006", "Other transfer terms", "string", {
    maxLength: 33,
    showWhen: { all: [contractReviewed, { key: "sales_contract:0600.0017", equals: "Other" }] },
    requiredWhen: { key: "sales_contract:0600.0017", equals: "Other" },
  }),
  field("Contract terms", "0600.0004", "20.007", "Personal property conveyed", "boolean", {
    showWhen: contractReviewed,
    requiredWhen: contractReviewed,
    guidance: "Personal property conveyed in the contract is not included in the appraiser's final opinion of value. Describe included personal property in Sales Contract Analysis.",
  }),
  field("Financial sales concessions", "0600.0006", "20.008", "Known sales concessions", "boolean", {
    showWhen: contractReviewed,
    requiredWhen: contractReviewed,
    guidance: "Financial assistance paid by or on behalf of the seller as an inducement to purchase the subject property.",
  }),
  field("Financial sales concessions", "0600.0005", "20.009", "Total sales concessions known", "boolean", {
    showWhen: { all: [contractReviewed, { key: "sales_contract:0600.0006", equals: true }] },
    requiredWhen: { key: "sales_contract:0600.0006", equals: true },
  }),
  field("Financial sales concessions", "0600.0011", "20.009", "Total sales concessions", "currency", {
    minimum: 0.01,
    maximum: 999999999.99,
    showWhen: { key: "sales_contract:0600.0005", equals: true },
    requiredWhen: { key: "sales_contract:0600.0005", equals: true },
  }),
  field("Financial sales concessions", "0600.0007", "20.010", "Sales concessions typical for market", "boolean", {
    showWhen: { key: "sales_contract:0600.0005", equals: true },
    requiredWhen: { key: "sales_contract:0600.0005", equals: true },
  }),
  field("Sales contract analysis", "0600.0014", "20.011", "Sales contract analysis", "text", {
    contextKey: "sales_contract_commentary",
    maxLength: 5000,
    showWhen: contractExists,
    requiredWhen: {
      any: [
        { key: "sales_contract:0600.0010", equals: false },
        { key: "sales_contract:0600.0004", equals: true },
      ],
    },
    guidance: "When the contract was not analyzed, identify the transaction-information source, efforts made to obtain the contract, and why it was not provided. Also describe personal property conveyed and any other relevant analysis.",
  }),
]);

export const UAD_SALES_CONTRACT_FIELD_KEYS = Object.freeze({
  exists: "sales_contract:0600.0016",
  reviewed: "sales_contract:0600.0010",
  armsLength: "sales_contract:0600.0002",
  contractPrice: "sales_contract:0600.0008",
  contractDate: "sales_contract:0600.0009",
  transferTerms: "sales_contract:0600.0017",
  personalProperty: "sales_contract:0600.0004",
  concessions: "sales_contract:0600.0006",
  concessionAmountKnown: "sales_contract:0600.0005",
  totalConcessions: "sales_contract:0600.0011",
  typicalConcessions: "sales_contract:0600.0007",
  analysis: "sales_contract_commentary:0600.0014",
  appraisalEffectiveDate: "reconciliation_summary:1300.0012",
});

export function isVerifiedSalesContractAsset(asset) {
  return asset?.section_number === 20
    && asset?.status === "verified"
    && UAD_SALES_CONTRACT_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_SALES_CONTRACT_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export { contractExists, contractReviewed };
