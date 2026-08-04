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
    cityFirstPrefix: null,
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
    cityFirstPrefix: "SNOWMASS",
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
    cityFirstPrefix: "1909",
    hasHouseNumber: false,
    isAddressPrefix: true,
  });
});

test("supports city-first autocomplete followed by a street", () => {
  assert.deepEqual(parsePropertySearch("Duncanville Main"), {
    raw: "Duncanville Main",
    isAccountId: false,
    normalizedAddress: "DUNCANVILLE MAIN",
    houseNumber: null,
    streetName: "DUNCANVILLE MAIN",
    city: null,
    cityFirstPrefix: "DUNCANVILLE MAIN",
    hasHouseNumber: false,
    isAddressPrefix: false,
  });
});

test("supports city-first autocomplete followed by a house number", () => {
  assert.equal(
    parsePropertySearch("Duncanville 123 Main").cityFirstPrefix,
    "DUNCANVILLE 123 MAIN",
  );
});

test("recognizes exact account IDs", () => {
  assert.equal(parsePropertySearch("26272500060150000").isAccountId, true);
});

test("removes county annotations from DCAD city names", () => {
  assert.equal(normalizePropertyCity("GARLAND (DALLAS CO)"), "GARLAND");
});

