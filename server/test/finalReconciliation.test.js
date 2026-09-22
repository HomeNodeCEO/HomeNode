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

/** Return whether readiness reported a missing or invalid effective date. */
function includesEffectiveDateError(errors) {
  return errors.some((message) => /effective date/i.test(message));
}

/** Verify strict calendar semantics without accepting truncated date prefixes. */
function testStrictEffectiveDateValidation() {
  const completeInput = {
    weights: {
      sales_comparison: 60,
      income_approach: 20,
      cost_approach: 20,
    },
    explanation: "All developed approaches support the final opinion of value.",
    certification_confirmed: true,
  };

  for (const effectiveDate of [
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-08-20T00:00:00.000Z",
    "2026-08-20junk",
  ]) {
    const result = normalizeFinalReconciliationSection({
      ...completeInput,
      effective_date: effectiveDate,
    }, sources);
    assert.equal(result.developed, false, effectiveDate);
    assert.equal(result.effective_date, effectiveDate);
    assert.ok(includesEffectiveDateError(finalReconciliationReadinessErrors(result)), effectiveDate);
  }

  const leapDay = normalizeFinalReconciliationSection({
    ...completeInput,
    effective_date: "2024-02-29",
  }, sources);
  assert.equal(leapDay.developed, true);
  assert.equal(includesEffectiveDateError(finalReconciliationReadinessErrors(leapDay)), false);
}

test("rejects impossible calendar dates while accepting a valid leap day", testStrictEffectiveDateValidation);
