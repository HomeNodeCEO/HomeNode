import assert from "node:assert/strict";
import test from "node:test";

import {
  finalReconciliationReadinessErrors,
  normalizeFinalReconciliationSection,
} from "../src/services/finalReconciliation.js";

const sources = {
  sales_comparison: {
    opinionOfValue: 300_000,
    opinionAfterCostToCure: 295_000,
    workspace: { search: { asOfDate: "2026-08-20" } },
  },
  sales_comparison_revision: 7,
  income_approach: {
    developed: true,
    rounded_indicated_value: 290_000,
  },
  income_approach_revision: 3,
  cost_approach: {
    developed: true,
    rounded_indicated_value: 310_000,
  },
  cost_approach_revision: 4,
};

test("rebuilds approach indications from authoritative workfile sections", () => {
  const result = normalizeFinalReconciliationSection({
    approaches: {
      sales_comparison: { indicated_value: 1 },
      income_approach: { indicated_value: 1 },
      cost_approach: { indicated_value: 1 },
    },
    weights: {
      sales_comparison: 60,
      income_approach: 20,
      cost_approach: 20,
    },
    explanation: "The Sales Comparison Approach receives primary weight, with secondary support from the developed Income and Cost approaches.",
    certification_confirmed: true,
  }, sources);

  assert.equal(result.approaches.sales_comparison.indicated_value, 295_000);
  assert.equal(result.approaches.income_approach.indicated_value, 290_000);
  assert.equal(result.approaches.cost_approach.indicated_value, 310_000);
  assert.equal(result.approaches.sales_comparison.source_revision, 7);
  assert.equal(result.calculated_weighted_value, 297_000);
  assert.equal(result.final_value, 297_000);
  assert.equal(result.effective_date, "2026-08-20");
  assert.equal(result.developed, true);
});

test("forces undeveloped approaches to zero weight", () => {
  const result = normalizeFinalReconciliationSection({
    effective_date: "2026-08-20",
    weights: {
      sales_comparison: 100,
      income_approach: 0,
      cost_approach: 40,
    },
    explanation: "Only the developed Sales Comparison Approach is relied upon.",
    certification_confirmed: true,
  }, {
    ...sources,
    cost_approach: { developed: false, rounded_indicated_value: 310_000 },
  });

  assert.equal(result.weights.cost_approach, 0);
  assert.equal(result.weight_total, 100);
  assert.equal(result.final_value, 295_000);
  assert.equal(result.developed, true);
});

test("requires support for a material override from the weighted indication", () => {
  const result = normalizeFinalReconciliationSection({
    effective_date: "2026-08-20",
    weights: {
      sales_comparison: 60,
      income_approach: 20,
      cost_approach: 20,
    },
    concluded_value_input: 350_000,
    explanation: "All developed approaches were considered.",
    certification_confirmed: true,
  }, sources);

  assert.ok(Math.abs(result.variance_from_weighted_percent) > 10);
  assert.match(
    finalReconciliationReadinessErrors(result).join(" "),
    /differs from the weighted indication/i,
  );
  assert.equal(result.developed, false);
});

test("requires weights totaling 100 percent and certification confirmation", () => {
  const result = normalizeFinalReconciliationSection({
    effective_date: "2026-08-20",
    weights: {
      sales_comparison: 80,
      income_approach: 0,
      cost_approach: 0,
    },
    explanation: "The Sales Comparison Approach is the only relied-upon approach.",
  }, sources);

  const errors = finalReconciliationReadinessErrors(result);
  assert.ok(errors.some((message) => /total 100%/i.test(message)));
  assert.ok(errors.some((message) => /confirm the appraiser certification/i.test(message)));
});
