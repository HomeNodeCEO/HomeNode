import assert from "node:assert/strict";
import test from "node:test";

import { buildRegressionAnalysis } from "../src/util/regressionAnalysis.js";

function deterministicRows(count = 80) {
  return Array.from({ length: count }, (_, index) => {
    const livingArea = 1_200 + ((index * 37) % 1_000);
    const bathrooms = 1 + (index % 4);
    const garage = index % 3;
    const pool = index % 5 === 0;
    const age = 5 + ((index * 7) % 45);
    const site = 5_000 + ((index * 211) % 8_000);
    return {
      sale_price: 50_000 + (livingArea * 100) + (bathrooms * 10_000) + (garage * 5_000) + (pool ? 20_000 : 0) - (age * 1_000) + (site * 2),
      living_area: livingArea,
      bathrooms,
      garage_spaces: garage,
      pool_yn: pool,
      age_years: age,
      site_size: site,
    };
  });
}

test("recovers stable multi-variable market coefficients without time adjustment", () => {
  const result = buildRegressionAnalysis(deterministicRows());
  assert.equal(result.population.modelSaleCount, 80);
  assert.equal(result.methodology.salePricesTimeAdjusted, false);
  assert.ok(result.model.rSquared > 0.999);
  const byKey = Object.fromEntries(result.coefficients.map((item) => [item.key, item]));
  assert.ok(Math.abs(byKey.living_area.coefficient - 100) < 0.01);
  assert.ok(Math.abs(byKey.bathrooms.coefficient - 10_000) < 1);
  assert.ok(Math.abs(byKey.garage.coefficient - 5_000) < 1);
  assert.ok(Math.abs(byKey.pool.coefficient - 20_000) < 1);
  assert.ok(Math.abs(byKey.age.coefficient + 1_000) < 1);
  assert.ok(Math.abs(byKey.site_size.coefficient - 2) < 0.01);
});

test("returns a limited non-applicable result when complete evidence is insufficient", () => {
  const result = buildRegressionAnalysis([{ sale_price: 300_000, living_area: 1_500 }]);
  assert.equal(result.model, null);
  assert.equal(result.coefficients.length, 0);
  assert.ok(result.warnings[0].includes("Insufficient"));
});

test("drops low-coverage predictors instead of silently zero-filling them", () => {
  const rows = deterministicRows().map((row, index) => ({ ...row, site_size: index < 20 ? row.site_size : null }));
  const result = buildRegressionAnalysis(rows);
  assert.equal(result.coefficients.some((item) => item.key === "site_size"), false);
  assert.ok(result.coverage.find((item) => item.key === "site_size").percent < 70);
});
