import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeContractPriceSupport,
  loadComparableContractContext,
} from "../src/services/contractPriceSupport.js";

function sale(id, price, distance, score = 70, overrides = {}) {
  return {
    source_record_id: id,
    sale_price: price,
    distanceMiles: distance,
    comparableScore: score,
    squareFootageDifferenceRatio: 0.1,
    insideAnalysisPeriod: true,
    housingTypeCompatible: true,
    influence_support_candidate: false,
    ...overrides,
  };
}

test("contract price support is an independent local screen with an upper-tier review set", () => {
  const result = analyzeContractPriceSupport({
    contractPrice: 300000,
    subjectCondition: "C2",
    subjectConditionNotes: "Completely remodeled",
    radiusMiles: 5,
    sales: [
      sale(1, 295000, 0.4, 82),
      sale(2, 310000, 1.2, 79),
      sale(3, 275000, 2.5, 74),
      sale(4, 240000, 1.0, 90),
      sale(5, 360000, 2.8, 68),
      sale(6, 305000, 4.1, 95),
      sale(7, 298000, 1.1, 20),
    ],
  });

  assert.equal(result.available, true);
  assert.equal(result.local_radius_miles, 3);
  assert.equal(result.local_sale_count, 5);
  assert.equal(result.within_5_percent_count, 2);
  assert.equal(result.within_10_percent_count, 3);
  assert.equal(result.strong_physical_support_count, 3);
  assert.equal(result.support_status, "supported");
  assert.equal(result.upper_tier_review, true);
  assert.equal(result.methodology.primary_recommendations_unchanged, true);
  assert.deepEqual(result.support_sales.map((item) => item.source_record_id), [1, 2, 3]);
  assert.equal(result.review_set_sales.length, 4);
});

test("contract price support reports limited and unsupported evidence without manufacturing support", () => {
  const limited = analyzeContractPriceSupport({
    contractPrice: 300000,
    radiusMiles: 3,
    sales: [sale(1, 285000, 0.8), sale(2, 220000, 1.2)],
  });
  assert.equal(limited.support_status, "limited");
  assert.equal(limited.within_10_percent_count, 1);

  const unsupported = analyzeContractPriceSupport({
    contractPrice: 300000,
    radiusMiles: 3,
    sales: [sale(1, 220000, 0.8), sale(2, 200000, 1.2)],
  });
  assert.equal(unsupported.support_status, "unsupported");
  assert.equal(unsupported.review_set_sales.length, 0);
  assert.match(unsupported.reconciliation, /should not anchor/i);
});

test("price-band counts remain limited when physical similarity is weak", () => {
  const result = analyzeContractPriceSupport({
    contractPrice: 300000,
    radiusMiles: 3,
    sales: [
      sale(1, 295000, 0.3, 49),
      sale(2, 300000, 0.6, 80, { squareFootageDifferenceRatio: 0.5 }),
      sale(3, 305000, 1.1, 45),
    ],
  });
  assert.equal(result.within_10_percent_count, 3);
  assert.equal(result.strong_physical_support_count, 0);
  assert.equal(result.support_status, "limited");
  assert.match(result.reconciliation, /stronger physical-similarity screen/i);
});

test("remodeled-subject review sets reserve capacity for upper-tier sales", () => {
  const result = analyzeContractPriceSupport({
    contractPrice: 300000,
    subjectCondition: "C2",
    radiusMiles: 3,
    sales: [
      sale(1, 286000, 0.2, 90),
      sale(2, 290000, 0.3, 89),
      sale(3, 294000, 0.4, 88),
      sale(4, 298000, 0.5, 87),
      sale(5, 302000, 0.6, 86),
      sale(6, 306000, 0.7, 85),
      sale(7, 420000, 0.8, 84),
      sale(8, 410000, 0.9, 83),
    ],
  });

  assert.equal(result.review_set_sales.length, 6);
  assert.ok(result.review_set_sales.some((item) => item.source_record_id === 7));
  assert.ok(result.review_set_sales.some((item) => item.source_record_id === 8));
});

test("missing contract price remains a bounded not-analyzed result", () => {
  const result = analyzeContractPriceSupport({ sales: [sale(1, 300000, 1)] });
  assert.deepEqual(result, {
    available: false,
    reason: "contract_price_unavailable",
    contract_price: null,
    support_status: "not_analyzed",
    local_radius_miles: 3,
    support_sales: [],
    upper_tier_sales: [],
    review_set_sales: [],
  });
});

test("assignment contract context is file- and account-scoped", async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ assignment_details: {
        contract_price: "$282,500",
        subject_condition_rating: "C2",
        subject_condition_notes: "Completely remodeled",
      } }] };
    },
  };
  const result = await loadComparableContractContext(pool, {
    accountId: "A-1",
    assignmentFileId: "8",
  });
  assert.deepEqual(result, {
    contractPrice: 282500,
    subjectCondition: "C2",
    subjectConditionNotes: "Completely remodeled",
  });
  assert.match(calls[0].sql, /WHERE id = \$1 AND account_id = \$2/);
  assert.deepEqual(calls[0].params, [8, "A-1"]);
});
