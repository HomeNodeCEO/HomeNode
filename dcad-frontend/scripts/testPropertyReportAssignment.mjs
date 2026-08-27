import assert from "node:assert/strict";
import test from "node:test";

import {
  assignmentDraftFromDetail,
  assignmentValidationErrors,
} from "../src/lib/propertyReportAssignment.ts";

test("assignment hydration preserves explicit values and clones arrays", () => {
  const source = {
    pud: true,
    subject_conforms_to_neighborhood: false,
    assignment_types: ["purchase_transaction"],
    lender_revision_count: -2,
  };
  const draft = assignmentDraftFromDetail(source);
  assert.equal(draft.pud, true);
  assert.equal(draft.subject_conforms_to_neighborhood, false);
  assert.deepEqual(draft.assignment_types, ["purchase_transaction"]);
  assert.notEqual(draft.assignment_types, source.assignment_types);
  assert.equal(draft.lender_revision_count, 0);
});

test("assignment validation retains established PUD and explanation rules", () => {
  assert.deepEqual(
    assignmentValidationErrors({ pud: true }),
    ["Enter HOA dues and a frequency, or explain why they are unavailable."],
  );
  assert.deepEqual(
    assignmentValidationErrors({ pud: true, hoa_explanation: "Not provided by management" }),
    [],
  );
  assert.deepEqual(
    assignmentValidationErrors({ occupancy: "unknown" }),
    ["Explain why occupancy is unknown."],
  );
});

test("assignment validation retains established contract safeguards", () => {
  const errors = assignmentValidationErrors({
    subject_under_contract: true,
    assignment_types: [],
    contract_arms_length: null,
    contract_price: "",
    contract_date: "",
    seller_matches_public_records: null,
  });
  assert.deepEqual(errors, [
    "Subject Under Contract requires Purchase Transaction in Assignment Details.",
    "Select Yes or No for Arms Length.",
    "Enter the subject contract price.",
    "Enter a valid subject contract date.",
    "Select Yes or No for whether the seller matches public records.",
  ]);
});

test("assignment validation retains land-use and nonconformity checks", () => {
  const errors = assignmentValidationErrors({
    subject_conforms_to_neighborhood: false,
    neighborhood_land_use_one_unit_pct: 40,
    neighborhood_land_use_two_to_four_unit_pct: 10,
    neighborhood_land_use_multifamily_pct: 10,
    neighborhood_land_use_commercial_pct: 10,
    neighborhood_land_use_other_vacant_pct: 10,
  });
  assert.deepEqual(errors, [
    "Select the subject's neighborhood nonconformity type.",
    "Explain why the subject does not conform to the neighborhood.",
    "Present land use percentages must total 100%.",
  ]);
});
