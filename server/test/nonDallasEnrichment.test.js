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

test("Dallas is hard-isolated from non-Dallas enrichment", () => {
  assert.throws(() => assertNonDallasEnrichmentCounty("Dallas County"), /dallas_enrichment_isolated/);
  // The worker keys off the account's county, so a Garland or Richardson
  // address recorded with county = Dallas County is protected the same way.
  assert.throws(() => assertNonDallasEnrichmentCounty("DALLAS"), /dallas_enrichment_isolated/);
  assert.equal(assertNonDallasEnrichmentCounty("Collin County"), "COLLIN");
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
    configured: false,
    baseUrl: "https://api.cotality.com/trestle/odata",
    tokenUrl: "https://api.cotality.com/trestle/oidc/connect/token",
    clientId: "",
    clientSecret: "",
    scope: "api",
    originatingSystemName: "",
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
