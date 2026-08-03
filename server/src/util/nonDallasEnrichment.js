export const NON_DALLAS_ENRICHMENT_COUNTIES = Object.freeze([
  "COLLIN",
  "TARRANT",
  "DENTON",
  "ROCKWALL",
]);

export const PROPERTY_ATTRIBUTE_KEYS = Object.freeze([
  "bedrooms",
  "bathrooms_full",
  "bathrooms_half",
  "living_area_sqft",
  "site_size_sqft",
  "attachment_type",
  "housing_type",
  "garage_spaces",
  "pool",
  "year_built",
  "sale_price",
  "sale_date",
  "contract_date",
  "listing_date",
  "days_on_market",
  "concessions",
  "financing_type",
  "fireplaces",
  "air_conditioning",
  "heating",
  "stories",
  "architectural_style",
  "construction_type",
  "exterior_material",
]);

const PROPERTY_ATTRIBUTE_SET = new Set(PROPERTY_ATTRIBUTE_KEYS);

export function normalizeCounty(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+COUNTY$/, "");
}

export function isNonDallasEnrichmentCounty(value) {
  return NON_DALLAS_ENRICHMENT_COUNTIES.includes(normalizeCounty(value));
}

export function assertNonDallasEnrichmentCounty(value) {
  const county = normalizeCounty(value);
  if (county === "DALLAS") throw new Error("dallas_enrichment_isolated");
  if (!NON_DALLAS_ENRICHMENT_COUNTIES.includes(county)) {
    throw new Error("unsupported_enrichment_county");
  }
  return county;
}

export function hasSourceValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function assertPropertyAttributeKey(key) {
  const normalized = String(key ?? "").trim().toLowerCase();
  if (!PROPERTY_ATTRIBUTE_SET.has(normalized)) {
    throw new Error("unsupported_property_attribute");
  }
  return normalized;
}

/**
 * Resolution for non-Dallas property characteristics:
 * verified manual override > Trestle/MLS > CAD > manual review.
 * GIS site-area calculations remain suggestions until manually approved.
 */
export function resolveNonDallasAttribute({ manual, trestle, cad, gisSuggestion }) {
  if (hasSourceValue(manual)) {
    return { value: manual, source: "manual_verified", review_required: false };
  }
  if (hasSourceValue(trestle)) {
    return { value: trestle, source: "trestle", review_required: false };
  }
  if (hasSourceValue(cad)) {
    return { value: cad, source: "cad", review_required: false };
  }
  if (hasSourceValue(gisSuggestion)) {
    return {
      value: null,
      source: null,
      suggested_value: gisSuggestion,
      suggested_source: "official_county_gis",
      review_required: true,
      review_reason: "gis_site_area_requires_approval",
    };
  }
  return {
    value: null,
    source: null,
    review_required: true,
    review_reason: "missing_from_trestle_and_cad",
  };
}

export function resolveNonDallasProperty({ county, manual = {}, trestle = {}, cad = {}, gis = {} }) {
  const normalizedCounty = assertNonDallasEnrichmentCounty(county);
  const attributes = {};
  const manualReview = [];
  for (const key of PROPERTY_ATTRIBUTE_KEYS) {
    const resolved = resolveNonDallasAttribute({
      manual: manual[key],
      trestle: trestle[key],
      cad: cad[key],
      gisSuggestion: key === "site_size_sqft" ? gis[key] : null,
    });
    attributes[key] = resolved;
    if (resolved.review_required) {
      manualReview.push({ attribute_key: key, reason: resolved.review_reason });
    }
  }
  return { county: normalizedCounty, attributes, manual_review: manualReview };
}

