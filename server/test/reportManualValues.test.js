import assert from "node:assert/strict";
import test from "node:test";

import { validateAssignmentDetails } from "../src/util/reportManualValues.js";

test("assignment details allow a PUD with complete dues", () => {
  assert.equal(validateAssignmentDetails({
    pud: true,
    hoa_dues_amount: "125",
    hoa_frequency: "per_month",
    hoa_explanation: "",
    occupancy: "owner",
    occupancy_explanation: "",
    assignment_types: ["purchase_transaction", "rehab"],
    assignment_explanation: "",
    lender_client_name: "Example National Bank",
    lender_client_address: "100 Main Street, Dallas, TX 75201",
  }), true);
});

test("assignment details allow a PUD explanation when dues are unavailable", () => {
  assert.equal(validateAssignmentDetails({
    pud: true,
    hoa_dues_amount: "",
    hoa_frequency: "",
    hoa_explanation: "HOA amount is pending confirmation.",
    occupancy: "tenant",
    assignment_types: ["refinance"],
  }), true);
});

test("assignment details enforce conditional explanations", () => {
  assert.throws(
    () => validateAssignmentDetails({ pud: true }),
    /pud_requires_hoa_dues_or_explanation/,
  );
  assert.throws(
    () => validateAssignmentDetails({ occupancy: "unknown" }),
    /unknown_occupancy_requires_explanation/,
  );
  assert.throws(
    () => validateAssignmentDetails({ assignment_types: ["other"] }),
    /other_assignment_type_requires_explanation/,
  );
  assert.throws(
    () => validateAssignmentDetails({ lender_client_name: 42 }),
    /invalid_lender_client_name/,
  );
  assert.throws(
    () => validateAssignmentDetails({ lender_client_address: "x".repeat(2001) }),
    /lender_client_address_too_long/,
  );
});

test("assignment details allow a purchase contract with seller verification", () => {
  assert.equal(validateAssignmentDetails({
    assignment_types: ["purchase_transaction"],
    subject_under_contract: true,
    contract_arms_length: true,
    contract_seller_names: "Pat Example",
    seller_matches_public_records: true,
  }), true);
});

test("assignment details accept subject condition and neighborhood conformity review", () => {
  assert.equal(validateAssignmentDetails({
    subject_condition_rating: "C4-C3",
    subject_condition_notes: "Average upkeep with limited recent updating.",
    significant_physical_deficiencies: false,
    subject_conforms_to_neighborhood: false,
    subject_nonconformity_type: "under_improvement",
    subject_nonconformity_explanation: "The subject is smaller than the predominant homes.",
  }), true);
});

test("assignment details reject invalid subject condition and conformity values", () => {
  assert.throws(
    () => validateAssignmentDetails({ subject_condition_rating: "C7" }),
    /invalid_subject_condition_rating/,
  );
  assert.throws(
    () => validateAssignmentDetails({ significant_physical_deficiencies: "no" }),
    /invalid_significant_physical_deficiencies/,
  );
  assert.throws(
    () => validateAssignmentDetails({ subject_nonconformity_type: "different" }),
    /invalid_subject_nonconformity_type/,
  );
});

test("assignment details enforce contract E&O safeguards", () => {
  assert.throws(
    () => validateAssignmentDetails({
      assignment_types: ["refinance"],
      subject_under_contract: true,
      contract_arms_length: true,
      seller_matches_public_records: true,
    }),
    /contract_requires_purchase_transaction/,
  );
  assert.throws(
    () => validateAssignmentDetails({
      assignment_types: ["purchase_transaction"],
      subject_under_contract: true,
      contract_arms_length: true,
    }),
    /contract_requires_seller_match_selection/,
  );
  assert.throws(
    () => validateAssignmentDetails({
      assignment_types: ["purchase_transaction"],
      subject_under_contract: true,
      contract_arms_length: true,
      seller_matches_public_records: false,
    }),
    /seller_mismatch_requires_explanation/,
  );
});

test("assignment details accept a complete neighborhood profile", () => {
  assert.equal(validateAssignmentDetails({
    neighborhood_land_use_one_unit_pct: 85,
    neighborhood_land_use_two_to_four_unit_pct: 2,
    neighborhood_land_use_multifamily_pct: 4,
    neighborhood_land_use_commercial_pct: 3,
    neighborhood_land_use_other_vacant_pct: 6,
    neighborhood_built_up_pct: 91.4,
    neighborhood_location_type: "suburban",
    neighborhood_built_up: "over_75",
    neighborhood_growth: "stable",
    neighborhood_unemployment_pct: 4.2,
    neighborhood_unemployment_zip: "75044",
    neighborhood_city_unemployment_pct: 4.1,
    neighborhood_city_unemployment_name: "Garland city, Texas",
    neighborhood_city_unemployment_source: "U.S. Census Bureau",
    neighborhood_city_unemployment_dataset_year: 2024,
    neighborhood_city_unemployment_variable: "DP03_0009PE",
    neighborhood_market_trend: "increasing",
    neighborhood_market_change_pct: 3.2,
    neighborhood_median_dom: 21,
    neighborhood_demand_supply: "in_balance",
    neighborhood_marketing_time: "under_3_months",
    neighborhood_house_price_low: 200000,
    neighborhood_house_price_predominant: 300000,
    neighborhood_house_price_high: 500000,
    neighborhood_city_name: "Garland",
    neighborhood_city_sale_count: 1250,
    neighborhood_city_average_sale_price: 342500,
    neighborhood_city_average_ppsf: 181.5,
    neighborhood_city_average_age: 38.2,
    neighborhood_city_average_gla: 1884,
    neighborhood_boundary_streets: "Snowmass Ln; Vail Dr",
    neighborhood_boundary_streets_source: "U.S. Census Bureau TIGERweb Transportation",
    neighborhood_boundary_geometry: {
      type: "Polygon",
      coordinates: [[[-96.7, 32.9], [-96.6, 32.9], [-96.6, 33], [-96.7, 32.9]]],
    },
    neighborhood_boundary_confirmed: true,
    highest_best_use_conclusion: "current_use",
    highest_best_use_summary: "The current residential use is consistent with zoning.",
    highest_best_use_zoning_compatible: true,
    highest_best_use_flags: [],
    highest_best_use_subject_site_area_sqft: 7578,
    highest_best_use_comparison_min_site_area_sqft: 7600,
    highest_best_use_comparison_parcel_count: 41,
  }), true);
});

test("assignment details enforce neighborhood totals and boundary confirmation", () => {
  assert.throws(() => validateAssignmentDetails({
    neighborhood_land_use_one_unit_pct: 80,
    neighborhood_land_use_two_to_four_unit_pct: 2,
    neighborhood_land_use_multifamily_pct: 4,
    neighborhood_land_use_commercial_pct: 3,
    neighborhood_land_use_other_vacant_pct: 6,
  }), /neighborhood_land_use_must_total_100/);
  assert.throws(() => validateAssignmentDetails({
    neighborhood_boundary_confirmed: true,
  }), /neighborhood_boundary_confirmation_requires_geometry/);
  assert.throws(() => validateAssignmentDetails({
    neighborhood_city_average_gla: -1,
  }), /invalid_neighborhood_city_comparison/);
  assert.throws(() => validateAssignmentDetails({
    neighborhood_city_unemployment_pct: 101,
  }), /invalid_neighborhood_city_unemployment_percentage/);
  assert.throws(() => validateAssignmentDetails({
    neighborhood_built_up_pct: 101,
  }), /invalid_neighborhood_land_use_analysis_metadata/);
  assert.throws(() => validateAssignmentDetails({
    highest_best_use_conclusion: "approved_without_review",
  }), /invalid_highest_best_use_conclusion/);
  assert.throws(() => validateAssignmentDetails({
    highest_best_use_flags: "review zoning",
  }), /invalid_highest_best_use_flags/);
});
