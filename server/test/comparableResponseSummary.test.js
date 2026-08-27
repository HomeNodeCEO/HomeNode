import assert from "node:assert/strict";
import test from "node:test";

import { summarizeComparableResults } from "../src/services/comparableResponseSummary.js";

test("summarizes recommendation groups and age counts in one pass", () => {
  const recommended = { sale_id: 1, recommended: true, soldOverOneYear: true };
  const lowerScore = {
    sale_id: 2,
    recommended: false,
    insideAnalysisPeriod: true,
    housingTypeCompatible: true,
    comparableScore: 70,
  };
  const influenceSupport = {
    sale_id: 3,
    recommended: false,
    insideAnalysisPeriod: true,
    housingTypeCompatible: true,
    comparableScore: 60,
    influence_support_candidate: true,
    soldOverOneYear: true,
    soldOverTwoYears: true,
  };
  const incompatible = {
    sale_id: 4,
    recommended: false,
    insideAnalysisPeriod: true,
    housingTypeCompatible: false,
  };

  const result = summarizeComparableResults([
    recommended,
    lowerScore,
    influenceSupport,
    incompatible,
  ]);

  assert.deepEqual(result.recommendedSales, [recommended]);
  assert.deepEqual(result.secondarySales, [influenceSupport, lowerScore]);
  assert.equal(result.olderThanOneYearCount, 2);
  assert.equal(result.olderThanTwoYearsCount, 1);
});

test("returns empty collections and zero counts for no sales", () => {
  assert.deepEqual(summarizeComparableResults([]), {
    recommendedSales: [],
    secondarySales: [],
    olderThanOneYearCount: 0,
    olderThanTwoYearsCount: 0,
  });
});
