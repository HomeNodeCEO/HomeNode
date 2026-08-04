import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeComparableOutliers,
  analysisWindow,
  applyRecommendationPolicy,
  classifySaleAge,
  filterComparablesForMarket,
  haversineMiles,
  polygonCentroid,
  scoreComparable,
} from "../src/util/comparableScoring.js";

function statisticalSale(index, pricePerSquareFoot, overrides = {}) {
  const month = String((index % 10) + 1).padStart(2, "0");
  return {
    source_record_id: `sale-${index}`,
    closing_date: `2026-${month}-15`,
    comparableScore: 75 + (index % 10),
    soldWithinOneYear: true,
    comparable_square_feet: 1500,
    sale_price: pricePerSquareFoot * 1500,
    ...overrides,
  };
}

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
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.squareFootageDifferencePercent, 10);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.salesDateScore, 100);
  assert.equal(score.comparableScore, 81.5);
});

test("even a large living-area difference remains scoreable", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.948,
    comparableLongitude: -96.657,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 2400,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.ok(score);
  assert.equal(score.squareFootageDifferencePercent, 60);
  assert.ok(score.squareFootageScore > 0);
});

test("location, living area, year built, site size, and sale date use the approved forty, thirty-seven, ten, five, and eight percent weights", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.ageScore, 100);
  assert.equal(score.siteSizeScore, 100);
  assert.equal(score.salesDateScore, 100);
  assert.equal(score.comparableScore, 81.5);
});

test("a known housing-type mismatch receives zero score and cannot enter the top six", () => {
  const mismatch = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    subjectHousingType: "Single Family Residence",
    subjectAttachmentType: "detached",
    comparableHousingType: "Condominium",
    comparableAttachmentType: "attached",
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(mismatch.comparableScore, 0);
  assert.equal(mismatch.housingTypeScore, 0);
  assert.equal(mismatch.housingTypeCompatible, false);

  const result = applyRecommendationPolicy([
    { source_record_id: "condo", closing_date: "2026-07-24", ...mismatch },
    {
      source_record_id: "detached",
      closing_date: "2026-07-24",
      comparableScore: 80,
      housingTypeCompatible: true,
    },
  ], { referenceDate: "2026-07-24" });
  assert.deepEqual(
    result.recommendedSales.map((sale) => sale.source_record_id),
    ["detached"],
  );
  assert.equal(
    result.sales.find((sale) => sale.source_record_id === "condo")
      .recommendationExclusionReason,
    "housing_type_mismatch",
  );
  assert.equal(result.policy.housingTypeMismatchCount, 1);
});

test("unknown housing classifications remain eligible but explicit matching types score normally", () => {
  const unknown = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    subjectHousingType: "Single Family Detached",
    comparableHousingType: null,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(unknown.housingTypeKnown, false);
  assert.equal(unknown.housingTypeCompatible, true);
  assert.equal(unknown.comparableScore, 100);
});

test("a one-year-old sale receives half of the sale-date component", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2025-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 100);
  assert.equal(score.salesDateScore, 50);
  assert.equal(score.comparableScore, 96);
});

test("a ten-year year-built difference receives half of the age component", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1995,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.ageDataAvailable, true);
  assert.equal(score.yearBuiltDifference, 10);
  assert.equal(score.ageScore, 50);
  assert.equal(score.comparableScore, 95);
});

test("missing year-built data remains eligible but receives no age points", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: null,
    subjectSiteSize: 7500,
    comparableSiteSize: 7500,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.ageDataAvailable, false);
  assert.equal(score.ageScore, 0);
  assert.equal(score.comparableScore, 90);
});

test("a ten-percent site-size difference receives half of the site component", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: 8250,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.siteDataAvailable, true);
  assert.equal(score.siteSizeDifferencePercent, 10);
  assert.equal(score.siteSizeScore, 50);
  assert.equal(score.comparableScore, 97.5);
});

test("missing site size remains eligible but receives no site-size points", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1500,
    subjectYearBuilt: 1985,
    comparableYearBuilt: 1985,
    subjectSiteSize: 7500,
    comparableSiteSize: null,
    closingDate: "2026-07-24",
    referenceDate: "2026-07-24",
  });
  assert.equal(score.siteDataAvailable, false);
  assert.equal(score.siteSizeScore, 0);
  assert.equal(score.comparableScore, 95);
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

test("outlier analysis flags a price-per-square-foot extreme when three methods agree", () => {
  const sales = Array.from({ length: 40 }, (_, index) =>
    statisticalSale(index, 195 + (index % 11)),
  );
  sales[7] = statisticalSale(7, 500);

  const result = analyzeComparableOutliers(sales, { scoreThreshold: 70 });
  const outlier = result.sales.find((sale) => sale.source_record_id === "sale-7");

  assert.equal(result.analysis.sample_sufficient, true);
  assert.equal(result.analysis.qualified_sale_count, 40);
  assert.equal(result.analysis.distinct_sale_months, 10);
  assert.equal(result.analysis.outlier_count, 1);
  assert.equal(outlier.statistical_outlier, true);
  assert.equal(outlier.statistical_outlier_direction, "high");
  assert.ok(outlier.statistical_outlier_methods.includes("standard_deviation"));
  assert.ok(outlier.statistical_outlier_methods.includes("median_absolute_deviation"));
  assert.ok(outlier.statistical_outlier_methods.includes("interquartile_range"));
});

test("outlier analysis does not flag sales when fewer than thirty qualify", () => {
  const sales = Array.from({ length: 29 }, (_, index) =>
    statisticalSale(index, index === 3 ? 500 : 200 + (index % 7)),
  );

  const result = analyzeComparableOutliers(sales, { scoreThreshold: 70 });

  assert.equal(result.analysis.sample_sufficient, false);
  assert.equal(result.analysis.outlier_count, 0);
  assert.ok(result.analysis.warnings.some(
    (warning) => warning.code === "minimum_sample_not_met",
  ));
  assert.equal(
    result.sales.some((sale) => sale.statistical_outlier),
    false,
  );
});
