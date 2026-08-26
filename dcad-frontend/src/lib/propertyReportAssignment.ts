import type { AssignmentDetailsPayload } from "./api";
import {
  DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
  neighborhoodLandUseTotal,
} from "./neighborhoodCharacteristics.ts";
import { parseNumber } from "./propertyReportPresentation.ts";

export function cloneEditorValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

export function assignmentDraftFromDetail(value?: AssignmentDetails): AssignmentDetails {
  return {
    subject_condition_rating: value?.subject_condition_rating || "",
    subject_condition_notes: value?.subject_condition_notes || "",
    significant_physical_deficiencies:
      typeof value?.significant_physical_deficiencies === "boolean"
        ? value.significant_physical_deficiencies
        : null,
    subject_conforms_to_neighborhood:
      typeof value?.subject_conforms_to_neighborhood === "boolean"
        ? value.subject_conforms_to_neighborhood
        : null,
    subject_nonconformity_type: value?.subject_nonconformity_type || "",
    subject_nonconformity_explanation: value?.subject_nonconformity_explanation || "",
    pud: Boolean(value?.pud),
    hoa_dues_amount: value?.hoa_dues_amount || "",
    hoa_frequency: value?.hoa_frequency || "",
    hoa_explanation: value?.hoa_explanation || "",
    occupancy: value?.occupancy || "",
    occupancy_explanation: value?.occupancy_explanation || "",
    assignment_types: cloneEditorValue(value?.assignment_types || []),
    assignment_explanation: value?.assignment_explanation || "",
    lender_client_name: value?.lender_client_name || "",
    lender_client_address: value?.lender_client_address || "",
    subject_under_contract: Boolean(value?.subject_under_contract),
    contract_arms_length: typeof value?.contract_arms_length === "boolean"
      ? value.contract_arms_length
      : true,
    contract_seller_names: value?.contract_seller_names || "",
    contract_price: value?.contract_price || "",
    contract_date: value?.contract_date || "",
    loan_amount: value?.loan_amount || "",
    down_payment: value?.down_payment || "",
    earnest_money: value?.earnest_money || "",
    seller_concessions: value?.seller_concessions || "",
    seller_matches_public_records:
      typeof value?.seller_matches_public_records === "boolean"
        ? value.seller_matches_public_records
        : null,
    seller_mismatch_explanation: value?.seller_mismatch_explanation || "",
    neighborhood_land_use_one_unit_pct: value?.neighborhood_land_use_one_unit_pct ?? "",
    neighborhood_land_use_two_to_four_unit_pct:
      value?.neighborhood_land_use_two_to_four_unit_pct ?? "",
    neighborhood_land_use_multifamily_pct: value?.neighborhood_land_use_multifamily_pct ?? "",
    neighborhood_land_use_commercial_pct: value?.neighborhood_land_use_commercial_pct ?? "",
    neighborhood_land_use_other_vacant_pct:
      value?.neighborhood_land_use_other_vacant_pct ?? "",
    neighborhood_land_use_analysis_source:
      value?.neighborhood_land_use_analysis_source || "",
    neighborhood_land_use_analyzed_at: value?.neighborhood_land_use_analyzed_at || "",
    neighborhood_land_use_parcel_count: value?.neighborhood_land_use_parcel_count ?? "",
    neighborhood_land_use_review_count: value?.neighborhood_land_use_review_count ?? "",
    neighborhood_land_use_coverage_percent:
      value?.neighborhood_land_use_coverage_percent ?? "",
    neighborhood_land_use_confidence: value?.neighborhood_land_use_confidence || "",
    neighborhood_land_use_boundary_signature:
      value?.neighborhood_land_use_boundary_signature || "",
    neighborhood_built_up_pct: value?.neighborhood_built_up_pct ?? "",
    neighborhood_location_type: value?.neighborhood_location_type || "",
    neighborhood_built_up: value?.neighborhood_built_up || "",
    neighborhood_growth: value?.neighborhood_growth || "",
    neighborhood_unemployment_pct: value?.neighborhood_unemployment_pct ?? "",
    neighborhood_unemployment_zip: value?.neighborhood_unemployment_zip || "",
    neighborhood_unemployment_source: value?.neighborhood_unemployment_source || "",
    neighborhood_unemployment_dataset_year:
      value?.neighborhood_unemployment_dataset_year ?? "",
    neighborhood_unemployment_variable: value?.neighborhood_unemployment_variable || "",
    neighborhood_city_unemployment_pct: value?.neighborhood_city_unemployment_pct ?? "",
    neighborhood_city_unemployment_name: value?.neighborhood_city_unemployment_name || "",
    neighborhood_city_unemployment_source:
      value?.neighborhood_city_unemployment_source || "",
    neighborhood_city_unemployment_dataset_year:
      value?.neighborhood_city_unemployment_dataset_year ?? "",
    neighborhood_city_unemployment_variable:
      value?.neighborhood_city_unemployment_variable || "",
    neighborhood_market_trend: value?.neighborhood_market_trend || "",
    neighborhood_market_change_pct: value?.neighborhood_market_change_pct ?? "",
    neighborhood_median_dom: value?.neighborhood_median_dom ?? "",
    neighborhood_demand_supply: value?.neighborhood_demand_supply || "",
    neighborhood_marketing_time: value?.neighborhood_marketing_time || "",
    neighborhood_house_price_low: value?.neighborhood_house_price_low ?? "",
    neighborhood_house_price_high: value?.neighborhood_house_price_high ?? "",
    neighborhood_house_price_predominant: value?.neighborhood_house_price_predominant ?? "",
    neighborhood_ppsf_low: value?.neighborhood_ppsf_low ?? "",
    neighborhood_ppsf_high: value?.neighborhood_ppsf_high ?? "",
    neighborhood_ppsf_predominant: value?.neighborhood_ppsf_predominant ?? "",
    neighborhood_age_low: value?.neighborhood_age_low ?? "",
    neighborhood_age_high: value?.neighborhood_age_high ?? "",
    neighborhood_age_predominant: value?.neighborhood_age_predominant ?? "",
    neighborhood_gla_low: value?.neighborhood_gla_low ?? "",
    neighborhood_gla_high: value?.neighborhood_gla_high ?? "",
    neighborhood_gla_predominant: value?.neighborhood_gla_predominant ?? "",
    neighborhood_sale_count: value?.neighborhood_sale_count ?? "",
    neighborhood_all_property_count: value?.neighborhood_all_property_count ?? "",
    neighborhood_all_house_price_low: value?.neighborhood_all_house_price_low ?? "",
    neighborhood_all_house_price_high: value?.neighborhood_all_house_price_high ?? "",
    neighborhood_all_house_price_predominant:
      value?.neighborhood_all_house_price_predominant ?? "",
    neighborhood_all_ppsf_low: value?.neighborhood_all_ppsf_low ?? "",
    neighborhood_all_ppsf_high: value?.neighborhood_all_ppsf_high ?? "",
    neighborhood_all_ppsf_predominant: value?.neighborhood_all_ppsf_predominant ?? "",
    neighborhood_all_age_low: value?.neighborhood_all_age_low ?? "",
    neighborhood_all_age_high: value?.neighborhood_all_age_high ?? "",
    neighborhood_all_age_predominant: value?.neighborhood_all_age_predominant ?? "",
    neighborhood_all_gla_low: value?.neighborhood_all_gla_low ?? "",
    neighborhood_all_gla_high: value?.neighborhood_all_gla_high ?? "",
    neighborhood_all_gla_predominant: value?.neighborhood_all_gla_predominant ?? "",
    neighborhood_all_value_count: value?.neighborhood_all_value_count ?? "",
    neighborhood_all_ppsf_count: value?.neighborhood_all_ppsf_count ?? "",
    neighborhood_all_age_count: value?.neighborhood_all_age_count ?? "",
    neighborhood_all_gla_count: value?.neighborhood_all_gla_count ?? "",
    neighborhood_city_name: value?.neighborhood_city_name || "",
    neighborhood_city_sale_count: value?.neighborhood_city_sale_count ?? "",
    neighborhood_city_average_sale_price: value?.neighborhood_city_average_sale_price ?? "",
    neighborhood_city_average_ppsf: value?.neighborhood_city_average_ppsf ?? "",
    neighborhood_city_average_age: value?.neighborhood_city_average_age ?? "",
    neighborhood_city_average_gla: value?.neighborhood_city_average_gla ?? "",
    neighborhood_city_comparison_as_of: value?.neighborhood_city_comparison_as_of || "",
    neighborhood_boundary_geometry: value?.neighborhood_boundary_geometry || null,
    neighborhood_boundary_label: value?.neighborhood_boundary_label || "",
    neighborhood_boundary_source: value?.neighborhood_boundary_source || "",
    neighborhood_boundary_saved_at: value?.neighborhood_boundary_saved_at || "",
    neighborhood_boundary_streets: value?.neighborhood_boundary_streets || "",
    neighborhood_boundary_north: value?.neighborhood_boundary_north || "",
    neighborhood_boundary_east: value?.neighborhood_boundary_east || "",
    neighborhood_boundary_south: value?.neighborhood_boundary_south || "",
    neighborhood_boundary_west: value?.neighborhood_boundary_west || "",
    neighborhood_boundary_exclusions:
      typeof value?.neighborhood_boundary_exclusions === "string" &&
      value.neighborhood_boundary_exclusions.trim()
        ? value.neighborhood_boundary_exclusions
        : DEFAULT_NEIGHBORHOOD_BOUNDARY_NARRATIVE,
    neighborhood_boundary_streets_source: value?.neighborhood_boundary_streets_source || "",
    neighborhood_boundary_streets_retrieved_at:
      value?.neighborhood_boundary_streets_retrieved_at || "",
    neighborhood_boundary_confirmed: Boolean(value?.neighborhood_boundary_confirmed),
    neighborhood_boundary_confirmed_at: value?.neighborhood_boundary_confirmed_at || "",
    neighborhood_boundary_engine_assessment_id:
      value?.neighborhood_boundary_engine_assessment_id ?? "",
    neighborhood_boundary_engine_assignment_file_id:
      value?.neighborhood_boundary_engine_assignment_file_id ?? "",
    neighborhood_boundary_engine_methodology_version:
      value?.neighborhood_boundary_engine_methodology_version ?? "",
    neighborhood_boundary_engine_confidence:
      value?.neighborhood_boundary_engine_confidence || "",
    neighborhood_boundary_engine_disclosure:
      value?.neighborhood_boundary_engine_disclosure || "",
    neighborhood_boundary_engine_warnings: cloneEditorValue(
      value?.neighborhood_boundary_engine_warnings || [],
    ),
    neighborhood_relevance_assessment_id:
      value?.neighborhood_relevance_assessment_id ?? "",
    neighborhood_relevance_methodology_version:
      value?.neighborhood_relevance_methodology_version ?? "",
    neighborhood_relevance_confidence:
      value?.neighborhood_relevance_confidence || "",
    neighborhood_relevance_candidate_count:
      value?.neighborhood_relevance_candidate_count ?? "",
    neighborhood_relevance_included_count:
      value?.neighborhood_relevance_included_count ?? "",
    neighborhood_relevance_excluded_count:
      value?.neighborhood_relevance_excluded_count ?? "",
    neighborhood_relevance_insufficient_data_count:
      value?.neighborhood_relevance_insufficient_data_count ?? "",
    neighborhood_relevance_generated_at:
      value?.neighborhood_relevance_generated_at || "",
    highest_best_use_conclusion: value?.highest_best_use_conclusion || "",
    highest_best_use_summary: value?.highest_best_use_summary || "",
    highest_best_use_zoning_compatible:
      typeof value?.highest_best_use_zoning_compatible === "boolean"
        ? value.highest_best_use_zoning_compatible
        : null,
    highest_best_use_flags: cloneEditorValue(value?.highest_best_use_flags || []),
    highest_best_use_source: value?.highest_best_use_source || "",
    highest_best_use_analyzed_at: value?.highest_best_use_analyzed_at || "",
    highest_best_use_subject_site_area_sqft:
      value?.highest_best_use_subject_site_area_sqft ?? "",
    highest_best_use_comparison_min_site_area_sqft:
      value?.highest_best_use_comparison_min_site_area_sqft ?? "",
    highest_best_use_comparison_median_site_area_sqft:
      value?.highest_best_use_comparison_median_site_area_sqft ?? "",
    highest_best_use_comparison_parcel_count:
      value?.highest_best_use_comparison_parcel_count ?? "",
    subject_concluded_value: value?.subject_concluded_value ?? "",
    neighborhood_value_position: value?.neighborhood_value_position || "",
    neighborhood_value_difference: value?.neighborhood_value_difference ?? "",
    neighborhood_value_difference_pct: value?.neighborhood_value_difference_pct ?? "",
    neighborhood_value_conclusion: value?.neighborhood_value_conclusion || "",
    neighborhood_value_conclusion_auto: value?.neighborhood_value_conclusion_auto || "",
    neighborhood_value_conclusion_signature:
      value?.neighborhood_value_conclusion_signature || "",
    neighborhood_value_conclusion_generated_at:
      value?.neighborhood_value_conclusion_generated_at || "",
    neighborhood_value_source: value?.neighborhood_value_source || "",
    lender_revision_count: Math.max(0, Number(value?.lender_revision_count) || 0),
    lender_revision_last_requested_at: value?.lender_revision_last_requested_at || "",
    lender_revision_note: value?.lender_revision_note || "",
  };
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
