import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createRelatedParcelsRouter } from "../src/modules/accounts/relatedParcelsRouter.js";

function options(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountIdAllowed: () => true,
    requireCustomAccountScope: async () => true,
    findParcelsByAddress: async () => ({ query_address: "", parcels: [] }),
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(router) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("related parcel lookup rejects invalid account identifiers before database access", async (context) => {
  const policyCalls = [];
  let queryCount = 0;
  const server = await startRouter(createRelatedParcelsRouter(options({
    accountIdAllowed: (value) => { policyCalls.push(value); return false; },
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/not-allowed/related-parcels`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_account_id" });
  assert.deepEqual(policyCalls, ["not-allowed"]);
  assert.equal(queryCount, 0);
});

test("related parcel lookup stops before data access when assignment scope is denied", async (context) => {
  const accessCalls = [];
  let queryCount = 0;
  const server = await startRouter(createRelatedParcelsRouter(options({
    requireCustomAccountScope: async (_req, res, ...scope) => {
      accessCalls.push(scope);
      res.status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/A-1/related-parcels?assignment_file_id=42`,
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "assignment_file_access_denied" });
  assert.deepEqual(accessCalls, [["A-1", "42", "read"]]);
  assert.equal(queryCount, 0);
});

test("related parcel lookup preserves missing-account and missing-address responses", async (context) => {
  const responses = [
    { rows: [] },
    { rows: [{ account_id: "A-1", address: "  ", county: "Dallas" }] },
  ];
  const server = await startRouter(createRelatedParcelsRouter(options({
    pool: { query: async () => responses.shift() },
  })));
  context.after(server.close);

  const missing = await fetch(`${server.baseUrl}/api/accounts/A-1/related-parcels`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "account_not_found" });

  const address = await fetch(`${server.baseUrl}/api/accounts/A-1/related-parcels`);
  assert.equal(address.status, 422);
  assert.deepEqual(await address.json(), { error: "related_parcel_address_required" });
});

test("Dallas lookup combines GIS and local parcels without merging records", async (context) => {
  const queries = [];
  const lookupCalls = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (queries.length === 1) {
        return {
          rows: [{
            account_id: "SUBJECT",
            address: "123 Main St, Dallas, TX",
            city: "Dallas",
            postal_code: "75201",
            county: "Dallas County",
          }],
        };
      }
      return {
        rows: [
          {
            account_id: "SUBJECT",
            address: "123 Main St, Dallas, TX",
            city: "Dallas",
            postal_code: "75201",
            county: "Dallas County",
            neighborhood_code: "N-1",
            legal_description: "LOT 1",
            data_quality_status: "verified",
            living_area_sqft: "1800",
            land_value: "50000",
            improvement_value: "150000",
            total_value: "200000",
            latitude: "32.78",
            longitude: "-96.8",
          },
          {
            account_id: "LOCAL-2",
            address: "123 Main St, Dallas, TX",
            city: "Dallas",
            postal_code: "75201",
            county: "Dallas County",
            neighborhood_code: "N-1",
            legal_description: "LOT 2",
            data_quality_status: "review",
            living_area_sqft: "2100",
            land_value: "55000",
            improvement_value: "175000",
            total_value: "230000",
            latitude: "32.7801",
            longitude: "-96.8001",
          },
        ],
      };
    },
  };
  const server = await startRouter(createRelatedParcelsRouter(options({
    pool,
    findParcelsByAddress: async (address) => {
      lookupCalls.push(address);
      return {
        query_address: "123 MAIN ST",
        parcels: [
          {
            account_id: "SUBJECT",
            site_address: "123 MAIN ST",
            property_description: "LOT 1",
          },
          {
            account_id: "REMOTE-3",
            site_address: "123 MAIN ST",
            property_description: "LOT 3",
            living_area_sqft: 1800,
            land_value: 50000,
            improvement_value: 150000,
            total_value: 200000,
          },
        ],
      };
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/SUBJECT/related-parcels?address=%20123%20Main%20St,%20Dallas%20`,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(lookupCalls, ["123 Main St, Dallas"]);
  assert.deepEqual(queries[0].params, ["SUBJECT"]);
  assert.deepEqual(queries[1].params, [["SUBJECT", "REMOTE-3"], "123 MAIN ST"]);
  assert.equal(body.subject_account_id, "SUBJECT");
  assert.equal(body.query_address, "123 MAIN ST");
  assert.equal(body.live_query_status, "complete");
  assert.equal(body.live_query_error, null);
  assert.equal(body.merge_performed, false);
  assert.equal(body.review_required, true);
  assert.equal(body.material_difference_found, true);
  assert.deepEqual(body.parcels.map((parcel) => parcel.account_id), [
    "SUBJECT",
    "LOCAL-2",
    "REMOTE-3",
  ]);
  assert.equal(body.parcels[0].living_area_sqft, 1800);
  assert.equal(body.parcels[0].in_database, true);
  assert.equal(body.parcels[1].source, "database_address_match");
  assert.equal(body.parcels[1].total_value, 230000);
  assert.equal(body.parcels[1].materially_different, true);
  assert.equal(body.parcels[2].in_database, false);
});

test("non-Dallas lookup remains local-only and reports unsupported county", async (context) => {
  let lookupCount = 0;
  let queryCount = 0;
  const server = await startRouter(createRelatedParcelsRouter(options({
    pool: {
      query: async () => {
        queryCount += 1;
        return queryCount === 1
          ? { rows: [{ account_id: "A-1", address: "9 Oak St", county: "Collin" }] }
          : { rows: [] };
      },
    },
    findParcelsByAddress: async () => { lookupCount += 1; return { parcels: [] }; },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/related-parcels`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    subject_account_id: "A-1",
    query_address: "9 Oak St",
    live_query_status: "unsupported_county",
    live_query_error: null,
    review_required: false,
    material_difference_found: false,
    merge_performed: false,
    parcels: [],
  });
  assert.equal(lookupCount, 0);
});

test("DCAD outages degrade to a reviewable response instead of failing the route", async (context) => {
  let queryCount = 0;
  const server = await startRouter(createRelatedParcelsRouter(options({
    pool: {
      query: async () => {
        queryCount += 1;
        return queryCount === 1
          ? { rows: [{ account_id: "A-1", address: "9 Oak St", county: "Dallas" }] }
          : { rows: [] };
      },
    },
    findParcelsByAddress: async () => { throw new Error("dcad_temporarily_unavailable"); },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/related-parcels`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.query_address, "9 Oak St");
  assert.equal(body.live_query_status, "unavailable");
  assert.equal(body.live_query_error, "dcad_temporarily_unavailable");
  assert.deepEqual(body.parcels, []);
});

test("unexpected related parcel failures retain stable diagnostics and error code", async (context) => {
  const failure = new Error("database_offline");
  const logs = [];
  const server = await startRouter(createRelatedParcelsRouter(options({
    pool: { query: async () => { throw failure; } },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/related-parcels`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "related_parcel_lookup_failed" });
  assert.deepEqual(logs, [["related parcel lookup failed", failure]]);
});

test("related parcel router validates collaborators and is mounted at the original boundary", () => {
  assert.throws(
    () => createRelatedParcelsRouter(options({ pool: null })),
    /related_parcels_pool_required/,
  );
  assert.throws(
    () => createRelatedParcelsRouter(options({ accountIdAllowed: null })),
    /related_parcels_account_policy_required/,
  );
  assert.throws(
    () => createRelatedParcelsRouter(options({ findParcelsByAddress: null })),
    /related_parcels_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  assert.match(
    source,
    /createRelatedParcelsRouter\(\{[\s\S]*?accountIdAllowed: legacyAccountIdAllowed/,
  );
  assert.equal(source.includes('app.get("/api/accounts/:id/related-parcels"'), false);
});
