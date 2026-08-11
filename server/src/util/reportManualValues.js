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
const NEIGHBORHOOD_RANGE_GROUPS = [
  ["neighborhood_house_price_low", "neighborhood_house_price_predominant", "neighborhood_house_price_high"],
  ["neighborhood_ppsf_low", "neighborhood_ppsf_predominant", "neighborhood_ppsf_high"],
  ["neighborhood_age_low", "neighborhood_age_predominant", "neighborhood_age_high"],
  ["neighborhood_gla_low", "neighborhood_gla_predominant", "neighborhood_gla_high"],
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
export function validateAssignmentDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_assignment_details");
  }
  if (value.pud !== undefined && typeof value.pud !== "boolean") {
    throw new Error("invalid_pud_value");
  }
  if (value.assignment_types !== undefined && !Array.isArray(value.assignment_types)) {
    throw new Error("invalid_assignment_type");
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
    ["contract_seller_names", 1000],
    ["contract_date", 100],
    ["seller_mismatch_explanation", 3000],
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
  ];

  if (!HOA_FREQUENCIES.has(hoaFrequency)) throw new Error("invalid_hoa_frequency");
  if (!OCCUPANCIES.has(occupancy)) throw new Error("invalid_occupancy");
  if (assignmentTypes.some((item) => !ASSIGNMENT_TYPES.has(item))) {
    throw new Error("invalid_assignment_type");
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
  const cityValues = NEIGHBORHOOD_CITY_NUMERIC_FIELDS.map((field) => optionalNumber(value[field]));
  if (cityValues.some((item) => Number.isNaN(item) || (item !== null && item < 0))) {
    throw new Error("invalid_neighborhood_city_comparison");
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
