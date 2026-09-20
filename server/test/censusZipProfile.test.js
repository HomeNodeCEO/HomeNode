import assert from "node:assert/strict";
import test from "node:test";

import {
  censusZipProfileInternals,
  fetchCensusCityProfile,
  fetchCensusZipProfile,
  normalizeCensusCity,
  normalizeCensusZip,
} from "../src/services/censusZipProfile.js";

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

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
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return jsonResponse([
        ["NAME", "DP03_0009PE", "zip code tabulation area"],
        ["ZCTA5 75044", "4.2", "75044"],
      ]);
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
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      return jsonResponse([
        ["NAME", "DP03_0009PE", "state", "place"],
        ["Dallas city, Texas", "4.8", "48", "19000"],
        ["Garland city, Texas", "4.1", "48", "29000"],
      ]);
    },
  });
  assert.match(requestedUrl, /place%3A\*/);
  assert.match(requestedUrl, /state%3A48/);
  assert.equal(profile.geography_name, "Garland city, Texas");
  assert.equal(profile.place_code, "29000");
  assert.equal(profile.unemployment_percent, 4.1);
});

test("bounds the Census ZIP response before parsing it", async () => {
  const { MAX_ZIP_RESPONSE_BYTES } = censusZipProfileInternals;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(MAX_ZIP_RESPONSE_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  }));

  await assert.rejects(
    () => fetchCensusZipProfile("75044", {
      apiKey: "test-key",
      useCache: false,
      fetchImpl: async () => response,
    }),
    (error) => error?.code === "census_zip_profile_response_too_large" && error?.status === 502,
  );
  assert.equal(cancelled, true);
});

test("bounds the statewide Census place table before parsing it", async () => {
  const { MAX_PLACE_TABLE_RESPONSE_BYTES } = censusZipProfileInternals;
  const response = new Response("[]", {
    headers: { "content-length": String(MAX_PLACE_TABLE_RESPONSE_BYTES + 1) },
  });

  await assert.rejects(
    () => fetchCensusCityProfile("Garland", "TX", {
      apiKey: "test-key",
      useCache: false,
      fetchImpl: async () => response,
    }),
    (error) => error?.code === "census_city_profile_response_too_large" && error?.status === 502,
  );
});

test("normalizes Census transport and malformed JSON failures", async () => {
  await assert.rejects(
    () => fetchCensusZipProfile("75044", {
      apiKey: "test-key",
      useCache: false,
      fetchImpl: async () => {
        throw new Error("provider socket details");
      },
    }),
    (error) => error?.code === "census_zip_profile_unavailable" && error?.status === 502,
  );

  await assert.rejects(
    () => fetchCensusCityProfile("Garland", "TX", {
      apiKey: "test-key",
      useCache: false,
      fetchImpl: async () => new Response("not-json"),
    }),
    (error) => error?.code === "census_city_profile_invalid_response" && error?.status === 502,
  );
});
