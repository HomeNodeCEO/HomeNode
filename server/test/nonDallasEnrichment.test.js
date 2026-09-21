import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNonDallasEnrichmentCounty,
  hasSourceValue,
  resolveNonDallasAttribute,
} from "../src/util/nonDallasEnrichment.js";
import {
  mapTrestleProperty,
  TrestleClient,
  trestleClientInternals,
  trestleConfiguration,
} from "../src/services/trestleClient.js";
import { getNonDallasAccount } from "../src/services/propertyEnrichment.js";

test("Dallas is hard-isolated from non-Dallas enrichment", () => {
  assert.throws(() => assertNonDallasEnrichmentCounty("Dallas County"), /dallas_enrichment_isolated/);
  // The worker keys off the account's county, so a Garland or Richardson
  // address recorded with county = Dallas County is protected the same way.
  assert.throws(() => assertNonDallasEnrichmentCounty("DALLAS"), /dallas_enrichment_isolated/);
  assert.equal(assertNonDallasEnrichmentCounty("Collin County"), "COLLIN");
});

test("non-Dallas account loading is parameterized and normalizes county", async () => {
  const calls = [];
  const account = await getNonDallasAccount({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ account_id: "A-1", county: "Collin County" }] };
    },
  }, "A-1");
  assert.deepEqual(account, {
    account_id: "A-1",
    county: "Collin County",
    normalized_county: "COLLIN",
  });
  assert.equal(calls[0].sql.includes("account_id = $1"), true);
  assert.deepEqual(calls[0].params, ["A-1"]);
  assert.equal(await getNonDallasAccount({
    async query() { return { rows: [] }; },
  }, "missing"), null);
});

test("manual then Trestle then CAD resolution preserves zero and false", () => {
  assert.deepEqual(
    resolveNonDallasAttribute({ manual: 0, trestle: 2, cad: 3 }),
    { value: 0, source: "manual_verified", review_required: false },
  );
  assert.deepEqual(
    resolveNonDallasAttribute({ manual: null, trestle: false, cad: true }),
    { value: false, source: "trestle", review_required: false },
  );
  assert.deepEqual(
    resolveNonDallasAttribute({ manual: null, trestle: "", cad: 1985 }),
    { value: 1985, source: "cad", review_required: false },
  );
  assert.equal(hasSourceValue(0), true);
  assert.equal(hasSourceValue(false), true);
});

test("missing sources create review and GIS remains only a suggestion", () => {
  assert.equal(
    resolveNonDallasAttribute({}).review_reason,
    "missing_from_trestle_and_cad",
  );
  const result = resolveNonDallasAttribute({ gisSuggestion: 8712 });
  assert.equal(result.value, null);
  assert.equal(result.suggested_value, 8712);
  assert.equal(result.review_required, true);
});

test("Trestle is disabled until credentials and explicit activation exist", () => {
  assert.deepEqual(trestleConfiguration({}), {
    enabled: false,
    replicationEnabled: false,
    mediaEnabled: false,
    configured: false,
    baseUrl: "https://api.cotality.com/trestle/odata",
    tokenUrl: "https://api.cotality.com/trestle/oidc/connect/token",
    clientId: "",
    clientSecret: "",
    scope: "api",
    originatingSystemName: "",
    counties: [],
    pageSize: 1000,
    maximumPages: 25,
    initialLookbackDays: 730,
    overlapMinutes: 10,
    requestTimeoutMs: 45000,
    retryAttempts: 5,
    retryBaseMs: 1000,
  });
});

test("maps RESO fields without treating false as missing", () => {
  const mapped = mapTrestleProperty({
    ListingId: "123",
    BedroomsTotal: 3,
    BathroomsFull: 2,
    PoolPrivateYN: false,
    LotSizeSquareFeet: 9000,
  });
  assert.equal(mapped.bedrooms, 3);
  assert.equal(mapped.bathrooms_full, 2);
  assert.equal(mapped.pool, false);
  assert.equal(mapped.site_size_sqft, 9000);
});

test("ListingKey is preferred and a non-unique ListingId is rejected", async () => {
  const client = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
    },
  });
  let capturedFilter = "";
  client.request = async (_path, params) => {
    capturedFilter = params.$filter;
    return { value: [{ ListingKey: "key-1" }] };
  };
  await client.findProperty({ listingKey: "key-1", listingId: "123" });
  assert.equal(capturedFilter, "ListingKey eq 'key-1'");

  client.request = async () => ({
    value: [{ ListingKey: "key-1" }, { ListingKey: "key-2" }],
  });
  await assert.rejects(
    client.findProperty({ listingId: "123" }),
    /ambiguous_listing_id/,
  );
});

test("incremental Property queries use ModificationTimestamp and optional county scope", () => {
  const client = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_COUNTIES: "Dallas, Collin",
    },
  });
  assert.equal(
    client.propertyChangesFilter({ modifiedAfter: "2026-08-01T00:00:00Z" }),
    "ModificationTimestamp gt 2026-08-01T00:00:00.000Z and (CountyOrParish eq 'Dallas' or CountyOrParish eq 'Collin')",
  );
});

test("Trestle retries quota responses and accepts only same-service next links", async () => {
  const sleeps = [];
  let attempts = 0;
  let rejectedBodyCancelled = false;
  const client = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "3",
    },
    fetchImpl: async (_url, options) => {
      attempts += 1;
      assert.equal(options.redirect, "manual");
      if (attempts > 1) {
        return new Response(JSON.stringify({ value: [] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("quota exceeded"));
        },
        cancel() {
          rejectedBodyCancelled = true;
        },
      }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  client.token = "cached";
  client.tokenExpiresAt = Date.now() + 3_600_000;
  assert.deepEqual(await client.requestNextLink(
    "https://api.cotality.com/trestle/odata/Property?$skip=1000",
  ), { value: [] });
  assert.equal(attempts, 2);
  assert.equal(rejectedBodyCancelled, true);
  assert.deepEqual(sleeps, [0]);
  await assert.rejects(
    client.requestNextLink("https://example.com/steal-token"),
    /trestle_untrusted_next_link/,
  );
});

test("Trestle rejects unsafe configured endpoints before sending credentials", async () => {
  let fetchCalls = 0;
  const tokenClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_TOKEN_URL: "http://metadata.internal/token",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("unexpected_fetch");
    },
  });
  await assert.rejects(
    tokenClient.accessToken(),
    { message: "trestle_token_endpoint_invalid" },
  );

  const apiClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_BASE_URL: "http://metadata.internal/odata",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("unexpected_fetch");
    },
  });
  apiClient.token = "cached";
  apiClient.tokenExpiresAt = Date.now() + 3_600_000;
  await assert.rejects(
    apiClient.request("Property"),
    { message: "trestle_base_url_invalid" },
  );

  const pathClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("unexpected_fetch");
    },
  });
  pathClient.token = "cached";
  pathClient.tokenExpiresAt = Date.now() + 3_600_000;
  await assert.rejects(
    pathClient.request("https://example.com/steal-token"),
    { message: "trestle_untrusted_path" },
  );
  assert.equal(fetchCalls, 0);
});

test("Trestle refuses redirects and sanitizes transport failures", async () => {
  let redirectCalls = 0;
  const redirectClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "1",
    },
    fetchImpl: async (_url, options) => {
      redirectCalls += 1;
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.com/steal-credentials" },
      });
    },
  });
  await assert.rejects(
    redirectClient.accessToken(),
    { message: "trestle_token_http_302" },
  );
  assert.equal(redirectCalls, 1);

  const transportDetail = "socket failure exposing a private hostname";
  const transportClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "1",
    },
    fetchImpl: async () => {
      throw new Error(transportDetail);
    },
  });
  transportClient.token = "cached";
  transportClient.tokenExpiresAt = Date.now() + 3_600_000;
  await assert.rejects(
    transportClient.request("Property"),
    (error) => {
      assert.equal(error.message, "trestle_unavailable");
      assert.equal(error.message.includes(transportDetail), false);
      return true;
    },
  );
});

test("Trestle bounds token and OData JSON responses", async () => {
  let tokenBodyCancelled = false;
  const tokenClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "1",
    },
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() {
        tokenBodyCancelled = true;
      },
    }), {
      headers: {
        "content-length": String(
          trestleClientInternals.MAX_TRESTLE_TOKEN_RESPONSE_BYTES + 1,
        ),
      },
    }),
  });
  await assert.rejects(
    tokenClient.accessToken(),
    { message: "trestle_token_response_too_large" },
  );
  assert.equal(tokenBodyCancelled, true);

  let apiBodyCancelled = false;
  const apiClient = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "1",
    },
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() {
        apiBodyCancelled = true;
      },
    }), {
      headers: {
        "content-length": String(
          trestleClientInternals.MAX_TRESTLE_API_RESPONSE_BYTES + 1,
        ),
      },
    }),
  });
  apiClient.token = "cached";
  apiClient.tokenExpiresAt = Date.now() + 3_600_000;
  await assert.rejects(
    apiClient.request("Property"),
    { message: "trestle_response_too_large" },
  );
  assert.equal(apiBodyCancelled, true);
});
