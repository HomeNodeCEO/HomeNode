import assert from "node:assert/strict";
import test from "node:test";

import {
  incomeApproachReadinessErrors,
  normalizeIncomeApproachSection,
} from "../src/services/incomeApproach.js";

function supportedInput(overrides = {}) {
  return {
    as_of_date: "2026-08-19",
    analysis_method: "both",
    conclusion_method: "reconciled",
    rent_source_name: "NTREIS rental comparables",
    rental_comparables: [
      { address: "100 Example St", monthly_rent: 2_400, living_area_sqft: 1_600, selected: true },
      { address: "200 Example St", monthly_rent: 2_600, living_area_sqft: 2_000, selected: true },
    ],
    market_rent: 2_500,
    other_income_monthly: 100,
    vacancy_rate: 5,
    expense_lines: [
      { description: "Taxes", annual_amount: 6_000 },
      { description: "Insurance", annual_amount: 2_000 },
      { description: "Reserves", annual_amount: 1_000 },
    ],
    grm: 120,
    cap_rate: 6,
    reconciled_indicated_value_input: 367_000,
    methodology: "Market rent is supported by selected rental comparables; GRM and direct capitalization are reconciled.",
    ...overrides,
  };
}

test("calculates market rent support, GRM, direct capitalization, and reconciliation", () => {
  const result = normalizeIncomeApproachSection(supportedInput());
  assert.equal(result.recommended_market_rent_median, 2_500);
  assert.equal(result.recommended_market_rent_average, 2_500);
  assert.equal(result.potential_gross_income, 31_200);
  assert.equal(result.vacancy_collection_loss, 1_560);
  assert.equal(result.effective_gross_income, 29_640);
  assert.equal(result.operating_expenses, 9_000);
  assert.equal(result.net_operating_income, 20_640);
  assert.equal(result.grm_indicated_value, 300_000);
  assert.equal(result.direct_cap_indicated_value, 344_000);
  assert.equal(result.indicated_value, 367_000);
  assert.equal(result.rounded_indicated_value, 367_000);
  assert.equal(result.developed, true);
  assert.deepEqual(incomeApproachReadinessErrors(result), []);
});

test("uses the selected calculated method and never trusts browser totals", () => {
  const result = normalizeIncomeApproachSection(supportedInput({
    analysis_method: "grm",
    conclusion_method: "grm",
    grm: 125,
    cap_rate: null,
    indicated_value: 99_000_000,
    net_operating_income: 99_000_000,
  }));
  assert.equal(result.indicated_value, 312_500);
  assert.equal(result.net_operating_income, 20_640);
  assert.equal(result.developed, true);
});

test("retains incomplete drafts and rejects unsafe numeric inputs", () => {
  const incomplete = normalizeIncomeApproachSection({ market_rent: 2_000 });
  assert.equal(incomplete.developed, false);
  assert.ok(incomeApproachReadinessErrors(incomplete).some((error) => /rental comparable/i.test(error)));
  assert.throws(() => normalizeIncomeApproachSection({ vacancy_rate: 101 }), /invalid_income_approach_number/);
  assert.throws(() => normalizeIncomeApproachSection({ market_rent: -1 }), /invalid_income_approach_number/);
});

test("requires identifiable rental evidence and a developed selected method", () => {
  const unidentified = normalizeIncomeApproachSection(supportedInput({
    rental_comparables: [{ address: "", monthly_rent: 2_500, selected: true }],
  }));
  assert.equal(unidentified.selected_rental_count, 0);
  assert.ok(incomeApproachReadinessErrors(unidentified).some((error) => /rental comparable/i.test(error)));

  const inconsistent = normalizeIncomeApproachSection(supportedInput({
    analysis_method: "grm",
    conclusion_method: "direct_capitalization",
  }));
  assert.ok(incomeApproachReadinessErrors(inconsistent).some((error) => /direct capitalization/i.test(error)));
  assert.equal(inconsistent.developed, false);
});
