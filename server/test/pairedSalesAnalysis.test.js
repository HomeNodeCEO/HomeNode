import test from "node:test";
import assert from "node:assert/strict";
import { buildPairedSalesAnalysis } from "../src/util/pairedSalesAnalysis.js";

function sale(overrides = {}) {
  return {
    sale_id: overrides.sale_id,
    source_record_id: overrides.source_record_id,
    primary_account_id: overrides.primary_account_id,
    address: overrides.address,
    city: "Garland",
    closing_date: "2026-06-01",
    sale_price: 250000,
    bedrooms: 3,
    bathrooms: 2,
    garage_spaces: 2,
    pool_yn: false,
    living_area: 1500,
    site_size: 7500,
    year_built: 1972,
    housing_type: "Single Detached",
    attachment_type: "detached",
    structural_style: "Single Detached",
    latitude: 32.96,
    longitude: -96.64,
    ...overrides,
  };
}

test("bathroom pairs retain negative and positive market differences", () => {
  const analysis = buildPairedSalesAnalysis([
    sale({ source_record_id: 1, address: "100 Alpha", bathrooms: 1, sale_price: 250000 }),
    sale({ source_record_id: 2, address: "102 Alpha", bathrooms: 2, sale_price: 270000, latitude: 32.961 }),
    sale({ source_record_id: 3, address: "200 Beta", bathrooms: 1, sale_price: 290000, latitude: 32.97 }),
    sale({ source_record_id: 4, address: "202 Beta", bathrooms: 2, sale_price: 280000, latitude: 32.971 }),
  ]);

  const bathroomRange = analysis.dimensions
    .find((dimension) => dimension.key === "bathrooms")
    .ranges.find((range) => range.id === "bath-1-to-2");

  assert.equal(bathroomRange.pairs.length, 2);
  assert.deepEqual(
    bathroomRange.pairs.map((pair) => pair.salePriceDifference).sort((a, b) => a - b),
    [-10000, 20000],
  );
  assert.equal(bathroomRange.statistics.mean, 5000);
  assert.equal(bathroomRange.statistics.median, 5000);
  assert.equal(bathroomRange.statistics.recommendedAdjustment, 5000);
  assert.ok(bathroomRange.statistics.standardDeviation > 0);
  assert.ok(bathroomRange.statistics.coefficientOfVariation > 0);
  assert.ok(bathroomRange.statistics.coefficientOfDispersion > 0);
});

test("living-area pairs normalize the result per square foot", () => {
  const analysis = buildPairedSalesAnalysis([
    sale({ source_record_id: 10, living_area: 1400, sale_price: 240000 }),
    sale({ source_record_id: 11, living_area: 1600, sale_price: 260000, latitude: 32.961 }),
  ]);

  const livingRange = analysis.dimensions
    .find((dimension) => dimension.key === "living_area")
    .ranges.find((range) => range.id === "200-to-299-sf-difference");

  assert.equal(livingRange.pairs.length, 1);
  assert.equal(livingRange.pairs[0].salePriceDifference, 20000);
  assert.equal(livingRange.pairs[0].unitPriceDifference, 100);
  assert.equal(livingRange.statistics.recommendedAdjustment, 100);
  assert.equal(livingRange.unit, "per_square_foot");
});

test("sales outside the practical similarity safeguards do not form pairs", () => {
  const analysis = buildPairedSalesAnalysis([
    sale({ source_record_id: 20, bathrooms: 1, living_area: 1400 }),
    sale({
      source_record_id: 21,
      bathrooms: 2,
      living_area: 2000,
      latitude: 33.2,
      longitude: -96.9,
    }),
  ]);

  const bathroomDimension = analysis.dimensions.find(
    (dimension) => dimension.key === "bathrooms",
  );
  assert.equal(bathroomDimension.ranges.length, 0);
});

test("equivalent detached housing labels can pair while attached housing cannot", () => {
  const analysis = buildPairedSalesAnalysis([
    sale({
      source_record_id: 30,
      bathrooms: 1,
      housing_type: "Single Family Detached",
      attachment_type: "Detached",
      structural_style: "Traditional",
    }),
    sale({
      source_record_id: 31,
      bathrooms: 2,
      housing_type: "Single Family",
      attachment_type: "Detached",
      structural_style: "Single Detached",
      latitude: 32.961,
    }),
    sale({
      source_record_id: 32,
      bathrooms: 2,
      housing_type: "Townhouse",
      attachment_type: "Attached",
      latitude: 32.962,
    }),
  ]);

  const bathroomRange = analysis.dimensions
    .find((dimension) => dimension.key === "bathrooms")
    .ranges.find((range) => range.id === "bath-1-to-2");

  assert.equal(bathroomRange.pairs.length, 1);
  assert.equal(bathroomRange.pairs[0].superior.sourceRecordId, "31");
});

test("a missing non-target characteristic cannot be treated as an identical control", () => {
  const analysis = buildPairedSalesAnalysis([
    sale({ source_record_id: 40, bathrooms: 1, garage_spaces: null }),
    sale({
      source_record_id: 41,
      bathrooms: 2,
      garage_spaces: null,
      latitude: 32.961,
    }),
  ]);

  const bathroomDimension = analysis.dimensions.find(
    (dimension) => dimension.key === "bathrooms",
  );
  assert.equal(bathroomDimension.ranges.length, 0);
});
