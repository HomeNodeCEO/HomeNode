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
  const client = new TrestleClient({
    env: {
      TRESTLE_ENABLED: "true",
      TRESTLE_CLIENT_ID: "client",
      TRESTLE_CLIENT_SECRET: "secret",
      TRESTLE_RETRY_ATTEMPTS: "3",
    },
    fetchImpl: async () => {
      attempts += 1;
      return {
        ok: attempts > 1,
        status: attempts > 1 ? 200 : 429,
        headers: { get: (name) => name === "retry-after" ? "0" : null },
        async json() { return { value: [] }; },
      };
    },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  client.token = "cached";
  client.tokenExpiresAt = Date.now() + 3_600_000;
  assert.deepEqual(await client.requestNextLink(
    "https://api.cotality.com/trestle/odata/Property?$skip=1000",
  ), { value: [] });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [0]);
  await assert.rejects(
    client.requestNextLink("https://example.com/steal-token"),
    /trestle_untrusted_next_link/,
  );
});
