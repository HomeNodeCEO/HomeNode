import assert from "node:assert/strict";
import test from "node:test";

import {
  costApproachReadinessErrors,
  normalizeCostApproachSection,
} from "../src/services/costApproach.js";

test("calculates replacement cost, age-life depreciation, and the indicated value", () => {
  const result = normalizeCostApproachSection({
    as_of_date: "2026-08-19",
    source_name: "Marshall & Swift residential cost service",
    living_area_sqft: 2_000,
    cost_per_sqft: 150,
    local_multiplier: 1.05,
    other_improvements: [{ description: "Garage", quantity: 400, unit: "sf", unit_cost: 50 }],
    entrepreneurial_incentive_percent: 10,
    effective_age: 10,
    economic_life: 50,
    curable_physical_deterioration: 5_000,
    functional_obsolescence: 2_500,
    external_obsolescence: 7_500,
    site_value: 75_000,
    site_improvements_value: 10_000,
    methodology: "Replacement cost new less all forms of accrued depreciation, plus site value.",
  });
  assert.equal(result.dwelling_base_cost, 315_000);
  assert.equal(result.other_improvements_total, 20_000);
  assert.equal(result.replacement_cost_new, 368_500);
  assert.equal(result.physical_depreciation_percent, 20);
  assert.equal(result.incurable_physical_depreciation, 72_700);
  assert.equal(result.total_depreciation, 87_700);
  assert.equal(result.depreciated_improvement_value, 280_800);
  assert.equal(result.indicated_value, 365_800);
  assert.equal(result.rounded_indicated_value, 366_000);
  assert.equal(result.developed, true);
  assert.deepEqual(costApproachReadinessErrors(result), []);
});

test("recalculates browser-supplied totals and preserves an incomplete draft", () => {
  const result = normalizeCostApproachSection({
    replacement_cost_new: 99_000_000,
    indicated_value: 99_000_000,
    living_area_sqft: 1_000,
    cost_per_sqft: 100,
    site_value: 25_000,
    other_improvements: [{ description: "Porch", quantity: 1, unit: "lump_sum", unit_cost: 5_000 }],
  });
  assert.equal(result.replacement_cost_new, 105_000);
  assert.equal(result.indicated_value, 130_000);
  assert.equal(result.developed, false);
  assert.ok(costApproachReadinessErrors(result).some((error) => /cost-data source/i.test(error)));
});

test("rejects invalid negative and unbounded inputs", () => {
  assert.throws(
    () => normalizeCostApproachSection({ living_area_sqft: -1 }),
    /invalid_cost_approach_number/,
  );
  assert.throws(
    () => normalizeCostApproachSection({ entrepreneurial_incentive_percent: 101 }),
    /invalid_cost_approach_number/,
  );
});
