import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRecommendationPolicy,
  classifySaleAge,
  haversineMiles,
  polygonCentroid,
  scoreComparable,
} from "../src/util/comparableScoring.js";

test("haversine distance is zero for the same parcel center", () => {
  assert.equal(haversineMiles(32.947, -96.656, 32.947, -96.656), 0);
});

test("a ten-percent living-area difference is a soft score, not a filter", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
  });
  assert.equal(score.squareFootageDifferencePercent, 10);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.comparableScore, 80);
});

test("even a large living-area difference remains scoreable", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.948,
    comparableLongitude: -96.657,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 2400,
  });
  assert.ok(score);
  assert.equal(score.squareFootageDifferencePercent, 60);
  assert.ok(score.squareFootageScore > 0);
});

test("location contributes sixty percent and living area forty percent", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.comparableScore, 80);
});

test("polygon centroid returns the center of a parcel", () => {
  const centroid = polygonCentroid([
    [
      [-97, 32],
      [-96, 32],
      [-96, 33],
      [-97, 33],
      [-97, 32],
    ],
  ]);
  assert.ok(centroid);
  assert.ok(Math.abs(centroid.longitude + 96.5) < 1e-9);
  assert.ok(Math.abs(centroid.latitude - 32.5) < 1e-9);
});

test("sales are flagged only after they are more than two years old", () => {
  const referenceDate = new Date("2026-07-24T12:00:00.000Z");
  assert.equal(
    classifySaleAge("2024-07-23T12:00:00.000Z", referenceDate).soldOverTwoYears,
    true,
  );
  assert.equal(
    classifySaleAge("2024-07-24T12:00:00.000Z", referenceDate).soldOverTwoYears,
    false,
  );
});

test("older sales are excluded when six recent sales score above 70", () => {
  const recentSales = Array.from({ length: 6 }, (_, index) => ({
    source_record_id: `recent-${index}`,
    closing_date: "2026-01-15",
    comparableScore: 90 - index,
  }));
  const olderSale = {
    source_record_id: "older",
    closing_date: "2023-06-01",
    comparableScore: 99,
  };
  const result = applyRecommendationPolicy([olderSale, ...recentSales], {
    referenceDate: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.equal(result.policy.olderSaleExclusionApplied, true);
  assert.equal(result.recommendedSales.length, 6);
  assert.equal(result.recommendedSales.some((sale) => sale.source_record_id === "older"), false);
  const decoratedOlderSale = result.sales.find(
    (sale) => sale.source_record_id === "older",
  );
  assert.equal(decoratedOlderSale.soldOverTwoYears, true);
  assert.equal(
    decoratedOlderSale.recommendationExclusionReason,
    "six_recent_high_score_sales_available",
  );
});

test("older sales remain eligible when no sale scores above 70", () => {
  const result = applyRecommendationPolicy(
    [
      {
        source_record_id: "older",
        closing_date: "2023-06-01",
        comparableScore: 70,
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        source_record_id: `recent-${index}`,
        closing_date: "2026-01-15",
        comparableScore: 69 - index,
      })),
    ],
    { referenceDate: new Date("2026-07-24T12:00:00.000Z") },
  );

  assert.equal(result.policy.scoreAboveThresholdCount, 0);
  assert.equal(result.policy.olderSaleExclusionApplied, false);
  assert.equal(result.recommendedSales[0].source_record_id, "older");
  assert.equal(result.recommendedSales[0].soldOverTwoYears, true);
});
