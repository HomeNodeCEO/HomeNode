import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizedProviderAddress,
  normalizedProviderCounty,
  normalizedProviderParcelId,
} from "../src/services/providerIngestion.js";

test("provider parcel normalization handles Collin R prefixes and punctuation", () => {
  assert.equal(normalizedProviderCounty("Collin County"), "COLLIN");
  assert.equal(
    normalizedProviderParcelId("R-1234-567-890", "Collin County"),
    "1234567890",
  );
  assert.equal(
    normalizedProviderParcelId("26272500060150000", "Dallas County"),
    "26272500060150000",
  );
});

test("provider address keys tolerate common MLS/CAD street suffix differences", () => {
  assert.equal(
    normalizedProviderAddress("1909 Snowmass Lane, Garland, TX 75044"),
    "1909SNOWMASSLN",
  );
  assert.equal(normalizedProviderAddress("1909 SNOWMASS LN"), "1909SNOWMASSLN");
});
