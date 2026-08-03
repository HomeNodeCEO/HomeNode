import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMarketContextOverride,
  buildMarketTrendRecommendation,
  calculateMarketStudyStatistics,
  completeCalendarMonthWindow,
  parseMarketAreaKeys,
  validateCustomMarketGeometry,
  weightedCompositeDispersion,
} from "../src/services/marketConditions.js";

test("market studies use the requested number of complete calendar months", () => {
  assert.deepEqual(completeCalendarMonthWindow("2026-08-03", 24), {
    analysisAsOf: "2026-08-03",
    start: "2024-08-01",
    end: "2026-07-31",
    periodMonths: 24,
    partialMonthExcluded: true,
  });
  assert.deepEqual(completeCalendarMonthWindow("2026-07-31", 12), {
    analysisAsOf: "2026-07-31",
    start: "2025-08-01",
    end: "2026-07-31",
    periodMonths: 12,
    partialMonthExcluded: false,
  });
});

test("partial first-month dates and invalid calendar dates are handled", () => {
  const window = completeCalendarMonthWindow("2026-07-30", 24);
  assert.equal(window.start, "2024-07-01");
  assert.equal(window.end, "2026-06-30");
  assert.throws(
    () => completeCalendarMonthWindow("2026-02-30", 24),
    /invalid_as_of/,
  );
});

test("market areas preserve the requested independent scopes", () => {
  const areas = parseMarketAreaKeys([
    "city",
    "zip",
    "radius_1",
    "radius_5",
    "custom",
    "city",
  ]);
  assert.deepEqual(
    areas.map((area) => area.key),
    ["city", "zip", "radius_1", "radius_5", "custom"],
  );
});

test("a valid closed DFW polygon is normalized", () => {
  const geometry = validateCustomMarketGeometry({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-96.67, 32.9],
          [-96.65, 32.9],
          [-96.65, 32.92],
          [-96.67, 32.9],
        ],
      ],
    },
  });
  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates[0].length, 4);
});

test("custom polygons must be closed and remain in the DFW guardrail", () => {
  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-96.67, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-96.66, 32.91],
          ],
        ],
      }),
    /custom_area_ring_not_closed/,
  );

  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-101, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-101, 32.9],
          ],
        ],
      }),
    /custom_area_outside_dfw_bounds/,
  );
});

test("market context can be overridden without changing subject identity", () => {
  const subject = {
    account_id: "005530000001A0000",
    address: "10010 STRAIT LN, DALLAS",
    city: "DALLAS",
    county: "DALLAS COUNTY",
    postal_code: null,
    latitude: 32.88,
    longitude: -96.82,
    location_status: "matched",
    location_source: "dcad_parcel_query",
    location_precision: "parcel_centroid",
    location_confidence: "high",
    location_review_required: false,
    location_review_reason: null,
  };
  const result = applyMarketContextOverride(subject, {
    source: "dcad_related_parcel",
    source_account_id: "00000416188000000",
    postal_code: "75229-1234",
    latitude: 32.881,
    longitude: -96.823,
    review_note: "Related land parcel selected as the study origin.",
  });
  assert.equal(result.account_id, subject.account_id);
  assert.equal(result.postal_code, "75229");
  assert.equal(result.context_override_active, true);
  assert.equal(result.context_source_account_id, "00000416188000000");
  assert.equal(result.location_source, "dcad_related_parcel_override");
  assert.equal(result.location_review_required, true);
  assert.deepEqual(result.context_overridden_fields, [
    "postal_code",
    "coordinates",
    "source_account_id",
  ]);
});

test("market context override coordinates must be complete and inside DFW", () => {
  const subject = { account_id: "005530000001A0000" };
  assert.throws(
    () => applyMarketContextOverride(subject, { latitude: 32.88 }),
    /market_context_coordinates_incomplete/,
  );
  assert.throws(
    () =>
      applyMarketContextOverride(subject, {
        latitude: 40,
        longitude: -96.8,
      }),
    /market_context_coordinates_outside_dfw/,
  );
});

test("market congruency gives living area 60 percent of the composite", () => {
  const factors = {
    living_area: { count: 50, cod: 20, cv: 20 },
    price_per_square_foot: { count: 50, cod: 30, cv: 30 },
    sale_price: { count: 50, cod: 40, cv: 40 },
    age: { count: 50, cod: 50, cv: 50 },
    housing_type: { count: 50, dispersion: 10 },
  };
  assert.deepEqual(weightedCompositeDispersion(factors, "cod"), {
    value: 25,
    available_weight: 1,
  });
  assert.deepEqual(weightedCompositeDispersion(factors, "cv"), {
    value: 25,
    available_weight: 1,
  });
});

test("missing congruency factors are omitted and remaining weights renormalize", () => {
  const factors = {
    living_area: { count: 50, cod: 20 },
    price_per_square_foot: { count: 0, cod: null },
    sale_price: { count: 50, cod: 40 },
    age: { count: 50, cod: 50 },
    housing_type: { count: 0, dispersion: null },
  };
  assert.deepEqual(weightedCompositeDispersion(factors, "cod"), {
    value: 26.25,
    available_weight: 0.8,
  });
});

test("market statistics annualize first-to-last complete monthly medians", () => {
  const statistics = calculateMarketStudyStatistics({
    monthlySeries: [
      { period_start: "2024-01-01", median_sale_price: 100 },
      { period_start: "2025-01-01", median_sale_price: 110 },
      { period_start: "2026-01-01", median_sale_price: 121 },
    ],
    eligibleSaleCount: 75,
    periodMonths: 25,
    congruencyFactors: {
      living_area: { count: 75, cod: 10, cv: 12 },
      price_per_square_foot: { count: 75, cod: 15, cv: 18 },
      sale_price: { count: 75, cod: 20, cv: 24 },
      age: { count: 75, cod: 25, cv: 30 },
      housing_type: { count: 75, dispersion: 8 },
    },
  });
  assert.equal(statistics.annualized_change_percent, 10);
  assert.equal(statistics.composite_cod, 12.8);
  assert.equal(statistics.composite_cv, 15.2);
  assert.equal(statistics.sample_sufficient, true);
});

test("market recommendation combines mean and median and applies one-percent threshold", () => {
  const analysis = (key, change, score, saleCount = 100) => ({
    market: { key, label: key.toUpperCase() },
    population: { eligible_sale_count: saleCount },
    statistics: {
      annualized_change_percent: change,
      reliability_score: score,
      sample_sufficient: saleCount >= 30,
      composite_cod: 10,
      composite_cv: 12,
    },
  });
  const increasing = buildMarketTrendRecommendation([
    analysis("city", 2, 80),
    analysis("zip", 4, 90),
    analysis("radius_1", 6, 85),
  ]);
  assert.equal(increasing.average_annualized_change_percent, 4);
  assert.equal(increasing.median_annualized_change_percent, 4);
  assert.equal(increasing.recommended_change_percent, 4);
  assert.equal(increasing.conclusion, "increasing");
  assert.equal(increasing.ranked_studies[0].key, "zip");

  const stable = buildMarketTrendRecommendation([
    analysis("city", -0.5, 80),
    analysis("zip", 0.8, 90),
  ]);
  assert.equal(stable.conclusion, "stable");

  const decreasing = buildMarketTrendRecommendation([
    analysis("city", -3, 80),
    analysis("zip", -2, 90),
  ]);
  assert.equal(decreasing.conclusion, "decreasing");
});
