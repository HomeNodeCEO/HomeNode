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
