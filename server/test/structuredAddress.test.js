import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStructuredAddress,
  structuredAddressSimilarity,
} from "../src/util/structuredAddress.js";

test("unit presentation words normalize to the same structured identity", () => {
  const variants = [
    "4831 Fuller Court #1104",
    "4831 FULLER CT Suite: 1104",
    "4831 Fuller Ct Apt. 1104",
    "4831 Fuller Ct Apartment 1104",
    "4831 Fuller Ct Unit No. 1104",
    "4831 Fuller Ct, Number 1104, Irving, TX 75038",
  ].map(parseStructuredAddress);

  for (const address of variants) {
    assert.equal(address.base_address_key, "4831 FULLER CT");
    assert.equal(address.house_number, "4831");
    assert.equal(address.street_key, "FULLER CT");
    assert.equal(address.unit_key, "1104");
  }
});

test("building and unit identifiers remain separate", () => {
  assert.deepEqual(
    parseStructuredAddress("100 Main Street Building 1 Apt 12").building_key,
    "1",
  );
  const parsed = parseStructuredAddress("100 Main St Bldg #1 Unit 12");
  assert.equal(parsed.base_address_key, "100 MAIN ST");
  assert.equal(parsed.building_key, "1");
  assert.equal(parsed.unit_key, "12");
});

test("unit labels are ignored but conflicting building identifiers are rejected", () => {
  const source = parseStructuredAddress("4831 Fuller Court #1104");
  const matching = structuredAddressSimilarity(
    source,
    parseStructuredAddress("4831 Fuller Ct Suite 1104"),
  );
  assert.equal(matching.eligible, true);
  assert.equal(matching.score, 1);

  const buildingSource = parseStructuredAddress("100 Main St Building 1 Apt 12");
  const wrongBuilding = structuredAddressSimilarity(
    buildingSource,
    parseStructuredAddress("100 Main St Building 2 Suite 12"),
  );
  assert.equal(wrongBuilding.eligible, false);
  assert.ok(wrongBuilding.reasons.includes("building_mismatch"));
});

test("small street-name typos remain candidates while house numbers stay strict", () => {
  const source = parseStructuredAddress("3901 Greensbro Circle");
  const candidate = structuredAddressSimilarity(
    source,
    parseStructuredAddress("3901 Greensboro Cir"),
  );
  assert.equal(candidate.eligible, true);
  assert.ok(candidate.street_score > 0.9);

  const wrongHouse = structuredAddressSimilarity(
    source,
    parseStructuredAddress("3902 Greensboro Cir"),
  );
  assert.equal(wrongHouse.eligible, false);
  assert.deepEqual(wrongHouse.reasons, ["house_number_mismatch"]);
});


