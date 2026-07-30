import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisWindow,
  applyRecommendationPolicy,
  classifySaleAge,
  filterComparablesForMarket,
  haversineMiles,
  polygonCentroid,
  scoreComparable,
} from "../src/util/comparableScoring.js";

test("market studies keep only sales inside the selected city, ZIP, or radius", () => {
  const sales = [
    { id: "garland-near", city: "Garland", zip: "75044-1234", distanceMiles: 0.8 },
    { id: "garland-far", city: "GARLAND", zip: "75043", distanceMiles: 4.2 },
    { id: "plano", city: "Plano", zip: "75074", distanceMiles: 2.5 },
  ];
  const subject = { city: " Garland ", postal_code: "75044" };

  assert.deepEqual(
    filterComparablesForMarket(sales, subject, { scope: "city" })
      .map((sale) => sale.id),
    ["garland-near", "garland-far"],
  );
  assert.deepEqual(
    filterComparablesForMarket(sales, subject, { scope: "zip" })
      .map((sale) => sale.id),
    ["garland-near"],
  );
  assert.deepEqual(
    filterComparablesForMarket(
      sales,
      subject,
      { scope: "radius", radiusMiles: 3 },
    ).map((sale) => sale.id),
    ["garland-near", "plano"],
  );
});

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
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.squareFootageDifferencePercent, 10);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.salesDateScore, 100);
  assert.equal(score.comparableScore, 85);
});

test("even a large living-area difference remains scoreable", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.948,
    comparableLongitude: -96.657,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 2400,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.ok(score);
  assert.equal(score.squareFootageDifferencePercent, 60);
  assert.ok(score.squareFootageScore > 0);
});

test("location, living area, and sale date contribute forty, thirty, and thirty percent", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.salesDateScore, 100);
  assert.equal(score.comparableScore, 85);
});

test("a one-year-old sale receives half of the sale-date component", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    closingDate: "2025-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 100);
  assert.equal(score.salesDateScore, 50);
  assert.equal(score.comparableScore, 85);
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

test("sale age flags distinguish one-year and two-year thresholds", () => {
  const referenceDate = new Date("2026-07-24T12:00:00.000Z");
  assert.equal(
    classifySaleAge("2025-07-23T12:00:00.000Z", referenceDate).soldOverOneYear,
    true,
  );
  assert.equal(
    classifySaleAge("2025-07-24T12:00:00.000Z", referenceDate).soldOverOneYear,
    false,
  );
  assert.equal(
    classifySaleAge("2024-07-23T12:00:00.000Z", referenceDate).soldOverTwoYears,
    true,
  );
  assert.equal(
    classifySaleAge("2024-07-24T12:00:00.000Z", referenceDate).soldOverTwoYears,
    false,
  );
});

test("the default twelve-month policy excludes every sale over one year old", () => {
  const result = applyRecommendationPolicy([
    {
      source_record_id: "older-high-score",
      closing_date: "2025-07-23",
      comparableScore: 99,
    },
    {
      source_record_id: "recent",
      closing_date: "2026-01-15",
      comparableScore: 80,
    },
  ], {
    referenceDate: new Date("2026-07-24T12:00:00.000Z"),
  });

  assert.deepEqual(
    result.recommendedSales.map((sale) => sale.source_record_id),
    ["recent"],
  );
  const decoratedOlderSale = result.sales.find((sale) =>
    sale.source_record_id === "older-high-score");
  assert.equal(decoratedOlderSale.soldOverOneYear, true);
  assert.equal(
    decoratedOlderSale.recommendationExclusionReason,
    "outside_analysis_period",
  );
  assert.equal(result.policy.periodMonths, 12);
  assert.equal(result.policy.outsideAnalysisPeriodCount, 1);
});

test("selecting twenty-four months explicitly includes older fallback sales", () => {
  const result = applyRecommendationPolicy(
    [
      {
        source_record_id: "recent",
        closing_date: "2026-01-15",
        comparableScore: 80,
      },
      {
        source_record_id: "older",
        closing_date: "2025-01-15",
        comparableScore: 70,
      },
    ],
    {
      referenceDate: new Date("2026-07-24T12:00:00.000Z"),
      policy: { count: 6, periodMonths: 24 },
    },
  );

  assert.deepEqual(
    result.recommendedSales.map((sale) => sale.source_record_id),
    ["recent", "older"],
  );
  assert.equal(result.recommendedSales[1].soldOverOneYear, true);
  assert.equal(result.policy.periodMonths, 24);
  assert.equal(result.policy.expandedHistoricalPeriod, true);
  assert.equal(result.policy.olderThanOneYearCount, 1);
});

test("analysis windows clamp month-end dates safely", () => {
  assert.deepEqual(
    analysisWindow("2026-02-28", 12),
    {
      analysisAsOf: "2026-02-28",
      analysisStartDate: "2025-02-28",
      periodMonths: 12,
    },
  );
  assert.deepEqual(
    analysisWindow("2024-02-29", 12),
    {
      analysisAsOf: "2024-02-29",
      analysisStartDate: "2023-02-28",
      periodMonths: 12,
    },
  );
});
