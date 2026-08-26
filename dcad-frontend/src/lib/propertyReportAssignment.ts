import type { AssignmentDetailsPayload } from "./api";
import { neighborhoodLandUseTotal } from "./neighborhoodCharacteristics.ts";
import { parseNumber } from "./propertyReportPresentation.ts";

export function cloneEditorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

export const HOA_FREQUENCY_OPTIONS = [
  ["per_year", "Per Year"],
  ["per_quarter", "Per Quarter"],
  ["per_month", "Per Month"],
  ["other", "Other"],
] as const;

export const OCCUPANCY_OPTIONS = [
  ["owner", "Owner"],
  ["tenant", "Tenant"],
  ["vacant", "Vacant"],
  ["unknown", "Unknown"],
] as const;

export const ASSIGNMENT_TYPE_OPTIONS = [
  ["purchase_transaction", "Purchase Transaction"],
  ["refinance", "Refinance"],
  ["heloc", "HELOC"],
  ["rtl", "RTL"],
  ["bridge_loan", "Bridge Loan"],
  ["new_construction", "New Construction"],
  ["rehab", "Rehab"],
  ["dscr", "DSCR"],
  ["other", "Other"],
] as const;

export function assignmentValidationErrors(
  assignment: AssignmentDetailsPayload,
): string[] {
  const errors: string[] = [];
  const hoaAmount = parseNumber(assignment.hoa_dues_amount);
  const hoaExplanation = String(assignment.hoa_explanation || "").trim();
  const assignmentTypes = Array.isArray(assignment.assignment_types)
    ? assignment.assignment_types
    : [];
  if (
    assignment.pud &&
    !((hoaAmount !== null && hoaAmount > 0 && assignment.hoa_frequency) || hoaExplanation)
  ) {
    errors.push("Enter HOA dues and a frequency, or explain why they are unavailable.");
  }
  if (assignment.pud && assignment.hoa_frequency === "other" && !hoaExplanation) {
    errors.push("Explain the Other HOA dues frequency.");
  }
  if (
    assignment.occupancy === "unknown" &&
    !String(assignment.occupancy_explanation || "").trim()
  ) {
    errors.push("Explain why occupancy is unknown.");
  }
  if (
    assignmentTypes.includes("other") &&
    !String(assignment.assignment_explanation || "").trim()
  ) {
    errors.push("Explain the Other assignment type.");
  }
  if (assignment.subject_under_contract && !assignmentTypes.includes("purchase_transaction")) {
    errors.push("Subject Under Contract requires Purchase Transaction in Assignment Details.");
  }
  if (assignment.subject_under_contract && typeof assignment.contract_arms_length !== "boolean") {
    errors.push("Select Yes or No for Arms Length.");
  }
  if (
    assignment.subject_under_contract &&
    !((parseNumber(assignment.contract_price) || 0) > 0)
  ) {
    errors.push("Enter the subject contract price.");
  }
  if (
    assignment.subject_under_contract &&
    !/^\d{4}-\d{2}-\d{2}$/.test(String(assignment.contract_date || ""))
  ) {
    errors.push("Enter a valid subject contract date.");
  }
  if (
    assignment.subject_under_contract &&
    typeof assignment.seller_matches_public_records !== "boolean"
  ) {
    errors.push("Select Yes or No for whether the seller matches public records.");
  }
  if (
    assignment.subject_under_contract &&
    assignment.seller_matches_public_records === false &&
    !String(assignment.seller_mismatch_explanation || "").trim()
  ) {
    errors.push("Explain the difference between the contract seller and public records.");
  }
  if (
    assignment.subject_conforms_to_neighborhood === false &&
    !String(assignment.subject_nonconformity_type || "").trim()
  ) {
    errors.push("Select the subject's neighborhood nonconformity type.");
  }
  if (
    assignment.subject_conforms_to_neighborhood === false &&
    !String(assignment.subject_nonconformity_explanation || "").trim()
  ) {
    errors.push("Explain why the subject does not conform to the neighborhood.");
  }
  const landUseTotal = neighborhoodLandUseTotal(assignment);
  if (landUseTotal !== null && Math.abs(landUseTotal - 100) > 0.1) {
    errors.push("Present land use percentages must total 100%.");
  }
  return errors;
}
