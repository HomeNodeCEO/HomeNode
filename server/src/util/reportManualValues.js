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

export function validateReportManualSection(key, value) {
  if (key === "report.assignment_details") return validateAssignmentDetails(value);
  if (value === undefined) throw new Error("invalid_report_section_value");
  return true;
}
