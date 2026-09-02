const HOA_FREQUENCIES = new Set([
  "",
  "per_year",
  "per_quarter",
  "per_month",
  "other",
]);
const OCCUPANCIES = new Set(["", "owner", "tenant", "vacant", "unknown"]);
const ASSIGNMENT_TYPES = new Set([
  "purchase_transaction",
  "refinance",
  "heloc",
  "rtl",
  "bridge_loan",
  "new_construction",
  "rehab",
  "dscr",
  "other",
]);
const CONTRACT_PROPERTY_CONDITIONS = new Set(["", "as_is", "seller_repairs"]);
const CONDITION_RATINGS = new Set([
  "",
  "C1",
  "C2-C1",
  "C2",
  "C3-C2",
  "C3",
  "C4-C3",
  "C4",
  "C5-C4",
  "C5",
  "C6-C5",
  "C6",
]);
const SUBJECT_NONCONFORMITY_TYPES = new Set([
  "",
  "under_improvement",
  "over_improvement",
  "functional_obsolescence",
  "other",
]);
const NEIGHBORHOOD_SELECTIONS = {
  neighborhood_location_type: new Set(["", "urban", "suburban", "rural"]),
  neighborhood_built_up: new Set(["", "over_75", "25_to_75", "under_25"]),
  neighborhood_growth: new Set(["", "rapid", "stable", "slow"]),
  neighborhood_market_trend: new Set(["", "increasing", "stable", "declining"]),
  neighborhood_demand_supply: new Set(["", "shortage", "in_balance", "over_supply"]),
  neighborhood_marketing_time: new Set(["", "under_3_months", "3_to_6_months", "over_6_months"]),
};
const NEIGHBORHOOD_LAND_USE_FIELDS = [
  "neighborhood_land_use_one_unit_pct",
  "neighborhood_land_use_two_to_four_unit_pct",
  "neighborhood_land_use_multifamily_pct",
  "neighborhood_land_use_commercial_pct",
  "neighborhood_land_use_other_vacant_pct",
];
const NEIGHBORHOOD_LAND_USE_CONFIDENCE = new Set(["", "high", "moderate", "limited"]);
const HIGHEST_BEST_USE_CONCLUSIONS = new Set(["", "current_use", "investigation_required"]);
const NEIGHBORHOOD_VALUE_POSITIONS = new Set([
  "",
  "above_predominant",
  "below_predominant",
  "at_predominant",
]);
const NEIGHBORHOOD_RANGE_GROUPS = [
  ["neighborhood_house_price_low", "neighborhood_house_price_predominant", "neighborhood_house_price_high"],
  ["neighborhood_ppsf_low", "neighborhood_ppsf_predominant", "neighborhood_ppsf_high"],
  ["neighborhood_age_low", "neighborhood_age_predominant", "neighborhood_age_high"],
  ["neighborhood_gla_low", "neighborhood_gla_predominant", "neighborhood_gla_high"],
  ["neighborhood_all_house_price_low", "neighborhood_all_house_price_predominant", "neighborhood_all_house_price_high"],
  ["neighborhood_all_ppsf_low", "neighborhood_all_ppsf_predominant", "neighborhood_all_ppsf_high"],
  ["neighborhood_all_age_low", "neighborhood_all_age_predominant", "neighborhood_all_age_high"],
  ["neighborhood_all_gla_low", "neighborhood_all_gla_predominant", "neighborhood_all_gla_high"],
];
const NEIGHBORHOOD_PROFILE_COUNT_FIELDS = [
  "neighborhood_sale_count",
  "neighborhood_all_property_count",
  "neighborhood_all_value_count",
  "neighborhood_all_ppsf_count",
  "neighborhood_all_age_count",
  "neighborhood_all_gla_count",
];
const NEIGHBORHOOD_CITY_NUMERIC_FIELDS = [
  "neighborhood_city_sale_count",
  "neighborhood_city_average_sale_price",
  "neighborhood_city_average_ppsf",
  "neighborhood_city_average_age",
  "neighborhood_city_average_gla",
];

function text(value) {
  return String(value ?? "").trim();
}

function positiveAmount(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
export function validateAssignmentDetails(value, { requireCompletion = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_assignment_details");
  }
  if (value.pud !== undefined && typeof value.pud !== "boolean") {
    throw new Error("invalid_pud_value");
  }
  if (value.assignment_types !== undefined && !Array.isArray(value.assignment_types)) {
    throw new Error("invalid_assignment_type");
  }
  for (const field of ["significant_physical_deficiencies", "subject_conforms_to_neighborhood"]) {
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      typeof value[field] !== "boolean"
    ) {
      throw new Error(`invalid_${field}`);
    }
  }
  if (
    value.highest_best_use_zoning_compatible !== undefined &&
    value.highest_best_use_zoning_compatible !== null &&
    typeof value.highest_best_use_zoning_compatible !== "boolean"
  ) {
    throw new Error("invalid_highest_best_use_zoning_compatible");
  }
  if (value.highest_best_use_flags !== undefined && !Array.isArray(value.highest_best_use_flags)) {
    throw new Error("invalid_highest_best_use_flags");
  }
  if (
    value.subject_under_contract !== undefined &&
    typeof value.subject_under_contract !== "boolean"
  ) {
    throw new Error("invalid_subject_under_contract");
  }
  if (
    value.contract_arms_length !== undefined &&
    value.contract_arms_length !== null &&
    typeof value.contract_arms_length !== "boolean"
  ) {
    throw new Error("invalid_contract_arms_length");
  }
  if (
    value.seller_matches_public_records !== undefined &&
    value.seller_matches_public_records !== null &&
    typeof value.seller_matches_public_records !== "boolean"
  ) {
    throw new Error("invalid_seller_match_value");
  }
  if (
    value.neighborhood_boundary_confirmed !== undefined &&
    typeof value.neighborhood_boundary_confirmed !== "boolean"
  ) {
    throw new Error("invalid_neighborhood_boundary_confirmation");
  }
  if (
    value.neighborhood_boundary_engine_warnings !== undefined &&
    (!Array.isArray(value.neighborhood_boundary_engine_warnings) ||
      value.neighborhood_boundary_engine_warnings.length > 20 ||
      value.neighborhood_boundary_engine_warnings.some(
        (warning) => typeof warning !== "string" || warning.length > 1000,
      ))
  ) {
    throw new Error("invalid_neighborhood_boundary_engine_warnings");
  }
  for (const field of [
    "neighborhood_relevance_removed_pocket_ids",
    "neighborhood_relevance_added_pocket_ids",
  ]) {
    if (
      value[field] !== undefined &&
      (!Array.isArray(value[field]) ||
        value[field].length > 5000 ||
        value[field].some((id) => typeof id !== "string" || id.length > 100))
    ) {
      throw new Error(`invalid_${field}`);
    }
  }
  const pud = value.pud === true;
  const hoaFrequency = text(value.hoa_frequency).toLowerCase();
  const hoaExplanation = text(value.hoa_explanation);
  const occupancy = text(value.occupancy).toLowerCase();
  const occupancyExplanation = text(value.occupancy_explanation);
  const assignmentTypes = Array.isArray(value.assignment_types)
    ? [...new Set(value.assignment_types.map((item) => text(item).toLowerCase()).filter(Boolean))]
    : [];
  const assignmentExplanation = text(value.assignment_explanation);
  const lenderClientName = text(value.lender_client_name);
  const lenderClientAddress = text(value.lender_client_address);
  const subjectUnderContract = value.subject_under_contract === true;
  const sellerMismatchExplanation = text(value.seller_mismatch_explanation);
  const contractTextFields = [
    ["contract_buyer_names", 1000],
    ["contract_seller_names", 1000],
    ["contract_date", 100],
    ["contract_closing_date", 100],
    ["contract_property_condition", 100],
    ["contract_repairs", 5000],
    ["contract_analysis_summary", 5000],
    ["seller_mismatch_explanation", 3000],
  ];
  const subjectConditionTextFields = [
    ["subject_condition_notes", 5000],
    ["subject_nonconformity_explanation", 5000],
  ];
  const neighborhoodTextFields = [
    ["neighborhood_unemployment_zip", 10],
    ["neighborhood_unemployment_source", 500],
    ["neighborhood_unemployment_variable", 100],
    ["neighborhood_city_unemployment_name", 300],
    ["neighborhood_city_unemployment_source", 500],
    ["neighborhood_city_unemployment_variable", 100],
    ["neighborhood_city_name", 200],
    ["neighborhood_city_comparison_as_of", 100],
    ["neighborhood_boundary_label", 1000],
    ["neighborhood_boundary_source", 200],
    ["neighborhood_boundary_saved_at", 100],
    ["neighborhood_boundary_streets", 4000],
    ["neighborhood_boundary_north", 500],
    ["neighborhood_boundary_east", 500],
    ["neighborhood_boundary_south", 500],
    ["neighborhood_boundary_west", 500],
    ["neighborhood_boundary_exclusions", 3000],
    ["neighborhood_boundary_streets_source", 500],
    ["neighborhood_boundary_streets_retrieved_at", 100],
    ["neighborhood_boundary_confirmed_at", 100],
    ["neighborhood_boundary_engine_confidence", 20],
    ["neighborhood_boundary_engine_disclosure", 5000],
    ["neighborhood_relevance_override_updated_at", 100],
    ["neighborhood_land_use_analysis_source", 500],
    ["neighborhood_land_use_analyzed_at", 100],
    ["neighborhood_land_use_boundary_signature", 128],
    ["highest_best_use_summary", 5000],
    ["highest_best_use_source", 500],
    ["highest_best_use_analyzed_at", 100],
    ["neighborhood_value_conclusion", 5000],
    ["neighborhood_value_conclusion_auto", 5000],
    ["neighborhood_value_conclusion_signature", 4000],
    ["neighborhood_value_conclusion_generated_at", 100],
    ["neighborhood_value_source", 500],
  ];

  if (!HOA_FREQUENCIES.has(hoaFrequency)) throw new Error("invalid_hoa_frequency");
  if (!CONDITION_RATINGS.has(text(value.subject_condition_rating).toUpperCase())) {
    throw new Error("invalid_subject_condition_rating");
  }
  if (!SUBJECT_NONCONFORMITY_TYPES.has(text(value.subject_nonconformity_type).toLowerCase())) {
    throw new Error("invalid_subject_nonconformity_type");
  }
  if (!OCCUPANCIES.has(occupancy)) throw new Error("invalid_occupancy");
  if (assignmentTypes.some((item) => !ASSIGNMENT_TYPES.has(item))) {
    throw new Error("invalid_assignment_type");
  }
  if (!CONTRACT_PROPERTY_CONDITIONS.has(text(value.contract_property_condition).toLowerCase())) {
    throw new Error("invalid_contract_property_condition");
  }
  if (value.lender_client_name !== undefined && typeof value.lender_client_name !== "string") {
    throw new Error("invalid_lender_client_name");
  }
  if (
    value.lender_client_address !== undefined &&
    typeof value.lender_client_address !== "string"
  ) {
    throw new Error("invalid_lender_client_address");
  }
  if (lenderClientName.length > 500) throw new Error("lender_client_name_too_long");
  if (lenderClientAddress.length > 2000) throw new Error("lender_client_address_too_long");
  for (const [field, maxLength] of contractTextFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`invalid_${field}`);
    }
    if (text(value[field]).length > maxLength) throw new Error(`${field}_too_long`);
  }
  for (const [field, maxLength] of subjectConditionTextFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`invalid_${field}`);
    }
    if (text(value[field]).length > maxLength) throw new Error(`${field}_too_long`);
  }
  for (const [field, maxLength] of neighborhoodTextFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(`invalid_${field}`);
    }
    if (text(value[field]).length > maxLength) throw new Error(`${field}_too_long`);
  }
  for (const [field, allowed] of Object.entries(NEIGHBORHOOD_SELECTIONS)) {
    if (!allowed.has(text(value[field]).toLowerCase())) throw new Error(`invalid_${field}`);
  }
  const landUseValues = NEIGHBORHOOD_LAND_USE_FIELDS.map((field) => optionalNumber(value[field]));
  if (landUseValues.some((item) => Number.isNaN(item) || (item !== null && (item < 0 || item > 100)))) {
    throw new Error("invalid_neighborhood_land_use_percentage");
  }
  if (landUseValues.every((item) => item !== null)) {
    const total = landUseValues.reduce((sum, item) => sum + item, 0);
    if (Math.abs(total - 100) > 0.1) throw new Error("neighborhood_land_use_must_total_100");
  }
  if (!NEIGHBORHOOD_LAND_USE_CONFIDENCE.has(text(value.neighborhood_land_use_confidence).toLowerCase())) {
    throw new Error("invalid_neighborhood_land_use_confidence");
  }
  if (!HIGHEST_BEST_USE_CONCLUSIONS.has(text(value.highest_best_use_conclusion).toLowerCase())) {
    throw new Error("invalid_highest_best_use_conclusion");
  }
  if (!NEIGHBORHOOD_VALUE_POSITIONS.has(text(value.neighborhood_value_position).toLowerCase())) {
    throw new Error("invalid_neighborhood_value_position");
  }
  if (
    Array.isArray(value.highest_best_use_flags) &&
    (value.highest_best_use_flags.length > 20 || value.highest_best_use_flags.some(
      (item) => typeof item !== "string" || text(item).length > 2000,
    ))
  ) {
    throw new Error("invalid_highest_best_use_flags");
  }
  const landUseAnalysisNumbers = [
    optionalNumber(value.neighborhood_land_use_parcel_count),
    optionalNumber(value.neighborhood_land_use_review_count),
    optionalNumber(value.neighborhood_land_use_coverage_percent),
    optionalNumber(value.neighborhood_built_up_pct),
  ];
  if (
    landUseAnalysisNumbers.some((item) => Number.isNaN(item) || (item !== null && item < 0)) ||
    (landUseAnalysisNumbers[2] !== null && landUseAnalysisNumbers[2] > 100) ||
    (landUseAnalysisNumbers[3] !== null && landUseAnalysisNumbers[3] > 100)
  ) {
    throw new Error("invalid_neighborhood_land_use_analysis_metadata");
  }
  const unemployment = optionalNumber(value.neighborhood_unemployment_pct);
  if (Number.isNaN(unemployment) || (unemployment !== null && (unemployment < 0 || unemployment > 100))) {
    throw new Error("invalid_neighborhood_unemployment_percentage");
  }
  const cityUnemployment = optionalNumber(value.neighborhood_city_unemployment_pct);
  if (
    Number.isNaN(cityUnemployment) ||
    (cityUnemployment !== null && (cityUnemployment < 0 || cityUnemployment > 100))
  ) {
    throw new Error("invalid_neighborhood_city_unemployment_percentage");
  }
  for (const fields of NEIGHBORHOOD_RANGE_GROUPS) {
    const numbers = fields.map((field) => optionalNumber(value[field]));
    if (numbers.some((item) => Number.isNaN(item) || (item !== null && item < 0))) {
      throw new Error("invalid_neighborhood_range_value");
    }
    if (numbers.every((item) => item !== null)) {
      const [low, predominant, high] = numbers;
      if (low > predominant || predominant > high) throw new Error("invalid_neighborhood_range_order");
    }
  }
  const profileCounts = NEIGHBORHOOD_PROFILE_COUNT_FIELDS.map((field) => optionalNumber(value[field]));
  if (profileCounts.some((item) => Number.isNaN(item) || (item !== null && item < 0))) {
    throw new Error("invalid_neighborhood_profile_count");
  }
  const cityValues = NEIGHBORHOOD_CITY_NUMERIC_FIELDS.map((field) => optionalNumber(value[field]));
  if (cityValues.some((item) => Number.isNaN(item) || (item !== null && item < 0))) {
    throw new Error("invalid_neighborhood_city_comparison");
  }
  const medianDom = optionalNumber(value.neighborhood_median_dom);
  if (Number.isNaN(medianDom) || (medianDom !== null && medianDom < 0)) {
    throw new Error("invalid_neighborhood_median_dom");
  }
  const marketChange = optionalNumber(value.neighborhood_market_change_pct);
  if (Number.isNaN(marketChange)) throw new Error("invalid_neighborhood_market_change");
  const highestBestUseNumbers = [
    optionalNumber(value.highest_best_use_subject_site_area_sqft),
    optionalNumber(value.highest_best_use_comparison_min_site_area_sqft),
    optionalNumber(value.highest_best_use_comparison_median_site_area_sqft),
    optionalNumber(value.highest_best_use_comparison_parcel_count),
  ];
  if (highestBestUseNumbers.some((item) => Number.isNaN(item) || (item !== null && item < 0))) {
    throw new Error("invalid_highest_best_use_site_comparison");
  }
  const subjectConcludedValue = optionalNumber(value.subject_concluded_value);
  const neighborhoodValueDifference = optionalNumber(value.neighborhood_value_difference);
  const neighborhoodValueDifferencePercent = optionalNumber(value.neighborhood_value_difference_pct);
  if (
    Number.isNaN(subjectConcludedValue) ||
    (subjectConcludedValue !== null && subjectConcludedValue < 0) ||
    Number.isNaN(neighborhoodValueDifference) ||
    Number.isNaN(neighborhoodValueDifferencePercent)
  ) {
    throw new Error("invalid_neighborhood_value_comparison");
  }
  if (
    value.neighborhood_boundary_geometry !== undefined &&
    value.neighborhood_boundary_geometry !== null &&
    !validBoundaryGeometry(value.neighborhood_boundary_geometry)
  ) {
    throw new Error("invalid_neighborhood_boundary_geometry");
  }
  if (value.neighborhood_boundary_confirmed === true && !validBoundaryGeometry(value.neighborhood_boundary_geometry)) {
    throw new Error("neighborhood_boundary_confirmation_requires_geometry");
  }
  const unemploymentZip = text(value.neighborhood_unemployment_zip);
  if (unemploymentZip && !/^\d{5}$/.test(unemploymentZip)) {
    throw new Error("invalid_neighborhood_unemployment_zip");
  }
  if (requireCompletion) {
    if (pud && !((positiveAmount(value.hoa_dues_amount) && hoaFrequency) || hoaExplanation)) {
      throw new Error("pud_requires_hoa_dues_or_explanation");
    }
    if (pud && hoaFrequency === "other" && !hoaExplanation) {
      throw new Error("other_hoa_frequency_requires_explanation");
    }
    if (occupancy === "unknown" && !occupancyExplanation) {
      throw new Error("unknown_occupancy_requires_explanation");
    }
    if (assignmentTypes.includes("other") && !assignmentExplanation) {
      throw new Error("other_assignment_type_requires_explanation");
    }
    if (subjectUnderContract && !assignmentTypes.includes("purchase_transaction")) {
      throw new Error("contract_requires_purchase_transaction");
    }
    if (subjectUnderContract && typeof value.contract_arms_length !== "boolean") {
      throw new Error("contract_requires_arms_length_selection");
    }
    if (subjectUnderContract && typeof value.seller_matches_public_records !== "boolean") {
      throw new Error("contract_requires_seller_match_selection");
    }
    if (subjectUnderContract && value.seller_matches_public_records === false && !sellerMismatchExplanation) {
      throw new Error("seller_mismatch_requires_explanation");
    }
  }
  return true;
}
function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[$,%\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function validBoundaryGeometry(value) {
  if (!value || typeof value !== "object" || value.type !== "Polygon") return false;
  const ring = value.coordinates?.[0];
  if (!Array.isArray(ring) || ring.length < 4) return false;
  if (ring.some((point) => !Array.isArray(point) || point.length < 2 ||
    !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])))) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return Number(first[0]) === Number(last[0]) && Number(first[1]) === Number(last[1]);
}

export function validateReportManualSection(key, value) {
  if (key === "report.assignment_details") return validateAssignmentDetails(value);
  if (value === undefined) throw new Error("invalid_report_section_value");
  return true;
}
