import assert from "node:assert/strict";
import test from "node:test";

import { calculateDepreciatedCostAdjustment } from "../src/util/depreciatedCostAdjustment.js";

test("calculates replacement cost new less depreciation and factoring", () => {
  const result = calculateDepreciatedCostAdjustment({
    target_dimension: "pool",
    description: "In-ground pool",
    unit_cost: 50_000,
    local_multiplier: 1.1,
    entrepreneurial_incentive_percent: 10,
    depreciation_percent: 20,
    factor_percent: 75,
  });
  assert.equal(result.replacement_cost_new_per_unit, 60_500);
  assert.equal(result.depreciated_cost_per_unit, 48_400);
  assert.equal(result.recommended_adjustment, 36_300);
});

test("retains cents for a living-area rate", () => {
  const result = calculateDepreciatedCostAdjustment({
    target_dimension: "living_area",
    description: "Dwelling cost",
    unit_cost: 160,
    local_multiplier: 1.05,
    entrepreneurial_incentive_percent: 5,
    depreciation_percent: 25,
    factor_percent: 100,
  });
  assert.equal(result.recommended_adjustment, 132.3);
  assert.equal(result.unit, "per_square_foot");
});

test("rejects unsupported targets and invalid bounds", () => {
  assert.throws(() => calculateDepreciatedCostAdjustment({
    target_dimension: "site_size",
    description: "Land",
    unit_cost: 10,
  }), /invalid_depreciated_cost_target/);
  assert.throws(() => calculateDepreciatedCostAdjustment({
    target_dimension: "pool",
    description: "Pool",
    unit_cost: 10,
    depreciation_percent: 101,
  }), /invalid_depreciated_cost_number/);
});
