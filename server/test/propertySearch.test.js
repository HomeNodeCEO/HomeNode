import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePropertyCity,
  normalizeSearchText,
  parsePropertySearch,
} from "../src/util/propertySearch.js";

test("normalizes address punctuation and whitespace", () => {
  assert.equal(normalizeSearchText("  1909  Snowmass Ln. "), "1909 SNOWMASS LN");
});

test("parses a full address into house number, street, and city", () => {
  assert.deepEqual(parsePropertySearch("1909 Snowmass Ln, Garland, TX 75044"), {
    raw: "1909 Snowmass Ln, Garland, TX 75044",
    isAccountId: false,
    normalizedAddress: "1909 SNOWMASS LN",
    houseNumber: "1909",
    streetName: "SNOWMASS LN",
    city: "GARLAND",
    hasHouseNumber: true,
    isAddressPrefix: true,
  });
});

test("keeps a street-only query broad", () => {
  assert.deepEqual(parsePropertySearch("Snowmass"), {
    raw: "Snowmass",
    isAccountId: false,
    normalizedAddress: "SNOWMASS",
    houseNumber: null,
    streetName: "SNOWMASS",
    city: null,
    hasHouseNumber: false,
    isAddressPrefix: false,
  });
});

test("keeps a house-number-only query as an address prefix", () => {
  assert.deepEqual(parsePropertySearch("1909"), {
    raw: "1909",
    isAccountId: false,
    normalizedAddress: "1909",
    houseNumber: null,
    streetName: "1909",
    city: null,
    hasHouseNumber: false,
    isAddressPrefix: true,
  });
});

test("recognizes exact account IDs", () => {
  assert.equal(parsePropertySearch("26272500060150000").isAccountId, true);
});

test("recognizes native Collin CAD IDs without removing their formatting", () => {
  const parsed = parsePropertySearch("R-0033-003-0080-1");
  assert.equal(parsed.isAccountId, true);
  assert.equal(parsed.raw, "R-0033-003-0080-1");
});

test("does not mistake a numeric house-number prefix for an account ID", () => {
  assert.equal(parsePropertySearch("1909").isAccountId, false);
});

test("removes county annotations from DCAD city names", () => {
  assert.equal(normalizePropertyCity("GARLAND (DALLAS CO)"), "GARLAND");
});

test("normalizes a standalone city filter independently of an address query", () => {
  assert.equal(normalizePropertyCity("Duncanville, TX"), "DUNCANVILLE");
});

