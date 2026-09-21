import assert from "node:assert/strict";
import test from "node:test";

import {
  countyGisConfiguration,
  fetchParcelAreaSuggestion,
  parcelGisInternals,
} from "../src/services/parcelGis.js";

const PARCEL_FEATURE = {
  attributes: { prop_id: "A-1" },
  geometry: {
    rings: [[
      [-96.700000, 32.900000],
      [-96.699673, 32.900000],
      [-96.699673, 32.900274],
      [-96.700000, 32.900274],
      [-96.700000, 32.900000],
    ]],
  },
};

function jsonResponse(value, init) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("county GIS configuration keeps only valid override field identifiers", () => {
  const config = countyGisConfiguration("Denton", {
    DENTON_GIS_QUERY_URL: "https://gis.example.test/FeatureServer/1/query",
    DENTON_GIS_ACCOUNT_FIELDS: "prop_id, ACCOUNT_2, invalid-name, 2bad",
  });
  assert.equal(config.configured, true);
  assert.equal(config.url, "https://gis.example.test/FeatureServer/1/query");
  assert.deepEqual(config.idFields, ["prop_id", "ACCOUNT_2"]);
});

test("fetches one county parcel with a deadline and preserves evidence shape", async () => {
  let requestedUrl;
  const result = await fetchParcelAreaSuggestion({
    county: "Denton",
    accountId: "A'1",
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.equal(options.headers.accept, "application/json");
      assert.equal(options.redirect, "manual");
      return jsonResponse({ features: [PARCEL_FEATURE] });
    },
  });

  assert.equal(requestedUrl.protocol, "https:");
  assert.match(requestedUrl.searchParams.get("where"), /A''1/);
  assert.equal(requestedUrl.searchParams.get("resultRecordCount"), "2");
  assert.equal(result.county, "DENTON");
  assert.equal(result.account_id, "A'1");
  assert.equal(result.status, "pending");
  assert.deepEqual(result.source_attributes, PARCEL_FEATURE.attributes);
  assert.equal(result.geometry.type, "Polygon");
  assert.ok(result.area_square_feet > 8_500 && result.area_square_feet < 12_000);
});

test("returns null when the county provider has no parcel", async () => {
  const result = await fetchParcelAreaSuggestion({
    county: "Collin",
    accountId: "A-1",
    fetchImpl: async () => jsonResponse({ features: [] }),
  });
  assert.equal(result, null);
});

test("rejects unsafe configured county GIS URLs before any request", async () => {
  let calls = 0;
  for (const configuredUrl of [
    "http://gis.example.test/query",
    "https://user:password@gis.example.test/query",
    "not a url",
  ]) {
    await assert.rejects(
      () => fetchParcelAreaSuggestion({
        county: "Rockwall",
        accountId: "A-1",
        env: { ROCKWALL_GIS_QUERY_URL: configuredUrl },
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse({ features: [] });
        },
      }),
      /county_gis_invalid_url/,
    );
  }
  assert.equal(calls, 0);
});

test("never follows county GIS redirects to cleartext or internal targets", async () => {
  for (const location of [
    "http://gis.example.test/query",
    "https://127.0.0.1/internal",
  ]) {
    let calls = 0;
    await assert.rejects(
      () => fetchParcelAreaSuggestion({
        county: "Denton",
        accountId: "A-1",
        fetchImpl: async (_url, options) => {
          calls += 1;
          assert.equal(options.redirect, "manual");
          return new Response(null, {
            status: 302,
            headers: { location },
          });
        },
      }),
      /county_gis_http_302/,
    );
    assert.equal(calls, 1);
  }
});

test("cancels a county GIS response that exceeds the byte ceiling", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(parcelGisInternals.MAX_RESPONSE_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  }));

  await assert.rejects(
    () => fetchParcelAreaSuggestion({
      county: "Tarrant",
      accountId: "A-1",
      fetchImpl: async () => response,
    }),
    /county_gis_response_too_large/,
  );
  assert.equal(cancelled, true);
});

test("normalizes county GIS transport, body, and provider failures", async () => {
  await assert.rejects(
    () => fetchParcelAreaSuggestion({
      county: "Collin",
      accountId: "A-1",
      fetchImpl: async () => {
        throw new Error("socket details");
      },
    }),
    /county_gis_unavailable/,
  );
  await assert.rejects(
    () => fetchParcelAreaSuggestion({
      county: "Collin",
      accountId: "A-1",
      fetchImpl: async () => new Response("not-json"),
    }),
    /county_gis_invalid_response/,
  );
  await assert.rejects(
    () => fetchParcelAreaSuggestion({
      county: "Collin",
      accountId: "A-1",
      fetchImpl: async () => jsonResponse({ error: { message: "provider secret" } }),
    }),
    /county_gis_query_failed/,
  );
});
