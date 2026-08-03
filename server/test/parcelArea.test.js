import assert from "node:assert/strict";
import test from "node:test";

import { geoJsonAreaSquareFeet } from "../src/util/parcelArea.js";
import { countyGisConfiguration } from "../src/services/parcelGis.js";

test("approximates a WGS84 parcel polygon area", () => {
  // A small North Texas rectangle, approximately 100 by 100 feet.
  const area = geoJsonAreaSquareFeet({
    type: "Polygon",
    coordinates: [[
      [-96.700000, 32.900000],
      [-96.699673, 32.900000],
      [-96.699673, 32.900274],
      [-96.700000, 32.900274],
      [-96.700000, 32.900000],
    ]],
  });
  assert.ok(area > 8_500 && area < 12_000, `unexpected area ${area}`);
});

test("GIS is configured for all four official county parcel services and isolates Dallas", () => {
  assert.equal(countyGisConfiguration("Collin").configured, true);
  assert.equal(countyGisConfiguration("Denton").configured, true);
  assert.equal(countyGisConfiguration("Rockwall").configured, true);
  assert.equal(countyGisConfiguration("Tarrant").configured, true);
  assert.throws(() => countyGisConfiguration("Dallas"), /dallas_enrichment_isolated/);
});
