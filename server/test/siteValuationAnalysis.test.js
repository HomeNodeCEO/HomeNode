import assert from "node:assert/strict";
import test from "node:test";

import { buildSiteValuationAnalysis } from "../src/util/siteValuationAnalysis.js";

test("allocates actual sale prices by CAD land ratio and normalizes by site size", () => {
  const analysis = buildSiteValuationAnalysis([
    { sale_id: 1, sale_price: 300_000, cad_land_value: 60_000, cad_improvement_value: 240_000, site_size: 10_000 },
    { sale_id: 2, sale_price: 400_000, cad_land_value: 100_000, cad_improvement_value: 300_000, site_size: 10_000 },
    { sale_id: 3, sale_price: 360_000, cad_land_value: 90_000, cad_improvement_value: 270_000, site_size: 10_000 },
  ]);
  assert.equal(analysis.population.analyzedSaleCount, 3);
  assert.equal(analysis.statistics.medianSiteValuePerSquareFoot, 9);
  assert.equal(analysis.options[0].amount, 9);
  assert.equal(analysis.evidence[0].allocationRatio, 0.2);
});

test("converts MLS acreage and audits records missing required inputs", () => {
  const analysis = buildSiteValuationAnalysis([
    { sale_id: 1, sale_price: 435_600, cad_land_value: 100_000, cad_improvement_value: 335_600, site_size: 1 },
    { sale_id: 2, sale_price: 200_000, cad_land_value: null, cad_improvement_value: 150_000, site_size: 8_000 },
    { sale_id: 3, sale_price: 200_000, cad_land_value: 50_000, cad_improvement_value: 150_000, site_size: null },
  ]);
  assert.equal(analysis.evidence[0].siteSizeSquareFeet, 43_560);
  assert.equal(analysis.evidence[0].siteValuePerSquareFoot, 2.2957);
  assert.equal(analysis.population.missingAllocationCount, 1);
  assert.equal(analysis.population.missingSiteSizeCount, 1);
});

test("returns a disclosed limited result when no allocation evidence exists", () => {
  const analysis = buildSiteValuationAnalysis([{ sale_price: 100_000 }]);
  assert.equal(analysis.statistics, null);
  assert.equal(analysis.reliability, "limited");
  assert.equal(analysis.options.length, 0);
});
