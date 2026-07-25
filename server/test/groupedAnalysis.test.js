import test from "node:test";
import assert from "node:assert/strict";
import { buildGroupedAnalysis } from "../src/util/groupedAnalysis.js";

function row(
  dimension,
  groupValue,
  sampleSize,
  average,
  median,
  livingArea = 1850,
  minimumLivingArea = livingArea,
  maximumLivingArea = livingArea,
) {
  return {
    dimension,
    group_value: String(groupValue),
    sample_size: String(sampleSize),
    minimum_sale_price: "100000",
    maximum_sale_price: "500000",
    average_sale_price: String(average),
    median_sale_price: String(median),
    lower_quartile_sale_price: "200000",
    upper_quartile_sale_price: "400000",
    sale_price_standard_deviation: "50000",
    average_price_per_square_foot: "180",
    median_price_per_square_foot: "175",
    average_living_area: String(livingArea),
    median_living_area: String(livingArea),
    minimum_living_area: String(minimumLivingArea),
    maximum_living_area: String(maximumLivingArea),
    average_days_on_market: "30",
    median_days_on_market: "22",
  };
}

test("bathroom analysis fills every whole-number group through the maximum", () => {
  const [bathrooms] = buildGroupedAnalysis([
    row("bathrooms", 1, 40, 250000, 245000),
    row("bathrooms", 3, 35, 350000, 340000),
  ]);

  assert.deepEqual(
    bathrooms.groups.map((group) => [group.groupValue, group.sampleSize]),
    [
      [1, 40],
      [2, 0],
      [3, 35],
    ],
  );
  assert.equal(bathrooms.transitions[0].options.length, 0);
  assert.equal(bathrooms.transitions[1].options.length, 0);
});

test("adjacent groups offer rounded median and average price adjustments", () => {
  const [bathrooms] = buildGroupedAnalysis([
    row("bathrooms", 1, 45, 250040, 245050),
    row("bathrooms", 2, 50, 267960, 260080),
  ]);
  const options = bathrooms.transitions[0].options;

  assert.equal(options[0].basis, "median_sale_price_difference");
  assert.equal(options[0].rawAmount, 15030);
  assert.equal(options[0].amount, 15000);
  assert.equal(options[0].reliability, "strong");
  assert.equal(options[0].recommended, true);
  assert.equal(options[1].basis, "average_sale_price_difference");
  assert.equal(options[1].amount, 17900);
});

test("garage analysis starts at zero and pool analysis always shows both groups", () => {
  const dimensions = buildGroupedAnalysis([
    row("garage", 2, 20, 300000, 295000),
    row("pool", false, 100, 300000, 290000),
  ]);
  const garage = dimensions[1];
  const pool = dimensions[2];

  assert.deepEqual(
    garage.groups.map((group) => group.groupValue),
    [0, 1, 2],
  );
  assert.deepEqual(
    pool.groups.map((group) => [group.groupValue, group.sampleSize]),
    [
      [false, 100],
      [true, 0],
    ],
  );
  assert.equal(pool.transitions[0].options.length, 0);
});

test("small comparison groups remain selectable but are marked limited", () => {
  const dimensions = buildGroupedAnalysis([
    row("pool", false, 100, 300000, 290000),
    row("pool", true, 4, 350000, 340000),
  ]);
  const option = dimensions[2].transitions[0].options[0];
  assert.equal(option.reliability, "limited");
  assert.equal(option.amount, 50000);
});

test("living-area analysis creates ten bands and normalizes adjustments to 100 square feet", () => {
  const dimensions = buildGroupedAnalysis([
    row("living_area", 1, 40, 250000, 245000, 1100, 1000, 1199),
    row("living_area", 2, 42, 280000, 275000, 1300, 1200, 1399),
  ]);
  const livingArea = dimensions[3];

  assert.equal(livingArea.key, "living_area");
  assert.equal(livingArea.groups.length, 10);
  assert.equal(livingArea.groups[0].label, "1,000 - 1,200 sf");
  assert.equal(livingArea.groups[1].label, "1,200 - 1,400 sf");
  assert.equal(livingArea.groups[9].sampleSize, 0);
  assert.equal(livingArea.transitions.length, 9);
  assert.equal(livingArea.transitions[0].options[0].rawAmount, 15000);
  assert.equal(livingArea.transitions[0].options[0].amount, 15000);
  assert.match(livingArea.transitions[0].options[0].label, /per 100 sf/);
  assert.equal(livingArea.transitions[1].options.length, 0);
});
