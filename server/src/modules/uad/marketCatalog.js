export const UAD_MARKET_CAPTION_TYPES = Object.freeze([
  "AbsorptionRateGraph",
  "MedianDaysOnMarketGraph",
  "PercentOfDistressedSalesGraph",
  "PriceTrendGraph",
  "YearBuiltOfSalesGraph",
  "MarketAnalysisExhibit",
]);

export const UAD_MARKET_IMAGE_CONTENT_TYPES = Object.freeze([
  "image/avif", "image/bmp", "image/gif", "image/heic", "image/heif", "image/jpeg",
  "image/png", "image/tiff", "image/webp",
]);

export const UAD_MARKET_SUPPLY_TRENDS = Object.freeze([
  "InBalance", "OverSupply", "Shortage",
]);

export const UAD_MARKETING_TIMES = Object.freeze([
  "UnderThreeMonths", "ThreeToSixMonths", "OverSixMonths",
]);

const activeListingsExist = Object.freeze({
  key: "market_active_listings:3000.0018",
  greaterThan: 0,
});

const salesExist = Object.freeze({
  key: "market_total_sales:3000.0026",
  greaterThan: 0,
});

const field = (group, contextKey, uid, reportFieldId, label, dataType, options = {}) => ({
  section: "market",
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  dataType,
  ...options,
});

const conditionalCurrency = (group, contextKey, uid, reportFieldId, label, condition) => field(
  group,
  contextKey,
  uid,
  reportFieldId,
  label,
  "currency",
  {
    showWhen: condition,
    requiredWhen: condition,
    minimumExclusive: 0,
    maximum: 999999999.99,
  },
);

export const UAD_MARKET_FIELDS = Object.freeze([
  field("Market area and search", "market", "3000.0008", "17.003", "Market area boundary", "text", {
    required: true,
    maxLength: 1250,
    guidance: "Describe the north, east, south, and west boundaries used for the market analysis. The appraiser must review any HomeNode boundary suggestion.",
  }),
  field("Market area and search", "market", "3000.0010", "17.004", "Search criteria", "text", {
    required: true,
    maxLength: 1250,
    guidance: "Describe the property, geography, date, and other filters used to analyze this market.",
  }),

  field("Active listings", "market_active_listings", "3000.0018", "17.005", "Active listings", "integer", {
    required: true,
    minimum: 0,
    maximum: 999,
  }),
  field("Active listings", "market_active_listings", "3000.0021", "17.006", "Median days on market", "integer", {
    showWhen: activeListingsExist,
    requiredWhen: activeListingsExist,
    minimum: 0,
    maximum: 9999,
  }),
  conditionalCurrency("Active listings", "market_active_listings", "3000.0020", "17.007", "Lowest list price", activeListingsExist),
  conditionalCurrency("Active listings", "market_active_listings", "3000.0022", "17.008", "Median list price", activeListingsExist),
  conditionalCurrency("Active listings", "market_active_listings", "3000.0019", "17.009", "Highest list price", activeListingsExist),

  field("Pending sales", "market_pending_sales", "3000.0024", "17.010", "Pending sales", "integer", {
    required: true,
    minimum: 0,
    maximum: 999,
  }),

  field("Sales within lookback period", "market", "3000.0009", "17.011", "Lookback period (months)", "integer", {
    required: true,
    minimum: 1,
    maximum: 99,
  }),
  field("Sales within lookback period", "market_total_sales", "3000.0026", "17.012", "Sales in lookback period", "integer", {
    required: true,
    minimum: 0,
    maximum: 999,
  }),
  conditionalCurrency("Sales within lookback period", "market_total_sales", "3000.0028", "17.013", "Lowest sale price", salesExist),
  conditionalCurrency("Sales within lookback period", "market_total_sales", "3000.0029", "17.014", "Median sale price", salesExist),
  conditionalCurrency("Sales within lookback period", "market_total_sales", "3000.0027", "17.015", "Highest sale price", salesExist),

  field("Price trend sources", "market_price_trend_source", "3000.0051", "17.018", "Price trend source", "string", {
    entityType: "market_price_trend_source",
    required: true,
    maxLength: 33,
    guidance: "Add each source used to determine the price trend as a separate record.",
  }),
  field("Price trend analysis", "market_price_trend_commentary", "3000.0040", "17.019", "Price trend analysis commentary", "text", {
    maxLength: 2500,
    guidance: "Required unless a verified Price Trend Graph is attached. Explain how the trend was determined and reconcile multiple sources.",
  }),

  field("Housing trends", "market", "3000.0034", "17.016", "Distressed sales compete with the subject", "boolean", {
    required: true,
  }),
  field("Housing trends", "market", "3000.0033", "17.021", "Demand and supply", "enum", {
    required: true,
    options: UAD_MARKET_SUPPLY_TRENDS,
  }),
  field("Housing trends", "market", "3000.0031", "17.022", "Typical marketing time", "enum", {
    required: true,
    options: UAD_MARKETING_TIMES,
  }),

  field("Market commentary", "market_commentary", "0100.0044", "17.023", "Market commentary", "text", {
    maxLength: 5000,
    guidance: "Optional narrative supporting market characteristics, trends, or reconciliation not captured above.",
  }),
]);

export const UAD_MARKET_ENTITY_GROUPS = Object.freeze({
  market_price_trend_source: Object.freeze({
    title: "Price trend sources",
    addLabel: "Add price trend source",
    minItems: 1,
    maxItems: 10,
  }),
});

export const UAD_MARKET_FIELD_KEYS = Object.freeze({
  activeListingCount: "market_active_listings:3000.0018",
  activeLowestPrice: "market_active_listings:3000.0020",
  activeMedianPrice: "market_active_listings:3000.0022",
  activeHighestPrice: "market_active_listings:3000.0019",
  salesCount: "market_total_sales:3000.0026",
  salesLowestPrice: "market_total_sales:3000.0028",
  salesMedianPrice: "market_total_sales:3000.0029",
  salesHighestPrice: "market_total_sales:3000.0027",
  priceTrendCommentary: "market_price_trend_commentary:3000.0040",
  priceTrendSource: "market_price_trend_source:3000.0051",
});

export function isVerifiedMarketAsset(asset, captionType = null) {
  return asset?.section_number === 17
    && asset?.status === "verified"
    && (!captionType || asset?.caption_type === captionType)
    && UAD_MARKET_CAPTION_TYPES.includes(asset?.caption_type)
    && UAD_MARKET_IMAGE_CONTENT_TYPES.includes(String(asset?.content_type || "").toLowerCase());
}

export { activeListingsExist, salesExist };
