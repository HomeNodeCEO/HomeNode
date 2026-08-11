import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchCensusCityProfile,
  fetchCensusZipProfile,
  normalizeCensusCity,
  normalizeCensusZip,
} from "../src/services/censusZipProfile.js";

test("normalizes a ZIP+4 for the Census ZCTA query", () => {
  assert.equal(normalizeCensusZip("75044-6751"), "75044");
  assert.throws(() => normalizeCensusZip("Dallas"), /invalid_census_zip/);
});

test("normalizes a Census city name", () => {
  assert.equal(normalizeCensusCity("  Garland  "), "Garland");
  assert.throws(() => normalizeCensusCity(""), /invalid_census_city/);
});

test("requires the Census API key now mandated for data queries", async () => {
  await assert.rejects(
    () => fetchCensusZipProfile("75044", { apiKey: "", useCache: false }),
    /census_api_key_not_configured/,
  );
});

test("maps the ACS unemployment rate for one ZIP", async () => {
  let requestedUrl = "";
  const profile = await fetchCensusZipProfile("75044", {
    apiKey: "test-key",
    datasetYear: "2024",
    useCache: false,
    now: Date.UTC(2026, 7, 11),
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        async json() {
          return [
            ["NAME", "DP03_0009PE", "zip code tabulation area"],
            ["ZCTA5 75044", "4.2", "75044"],
          ];
        },
      };
    },
  });
  assert.match(requestedUrl, /DP03_0009PE/);
  assert.match(requestedUrl, /key=test-key/);
  assert.equal(profile.unemployment_percent, 4.2);
  assert.equal(profile.dataset_year, 2024);
  assert.equal(profile.source, "U.S. Census Bureau");
});

test("maps the ACS unemployment rate for the matching Texas place", async () => {
  let requestedUrl = "";
  const profile = await fetchCensusCityProfile("Garland", "TX", {
    apiKey: "test-key",
    datasetYear: "2024",
    useCache: false,
    now: Date.UTC(2026, 7, 11),
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return {
        ok: true,
        async json() {
          return [
            ["NAME", "DP03_0009PE", "state", "place"],
            ["Dallas city, Texas", "4.8", "48", "19000"],
            ["Garland city, Texas", "4.1", "48", "29000"],
          ];
        },
      };
    },
  });
  assert.match(requestedUrl, /place%3A\*/);
  assert.match(requestedUrl, /state%3A48/);
  assert.equal(profile.geography_name, "Garland city, Texas");
  assert.equal(profile.place_code, "29000");
  assert.equal(profile.unemployment_percent, 4.1);
});
