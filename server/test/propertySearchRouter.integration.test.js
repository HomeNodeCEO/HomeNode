import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createPropertySearchRouter } from "../src/modules/accounts/propertySearchRouter.js";

function createPool(handler = async () => ({ rows: [] })) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(text, params = []) {
        const sql = String(text);
        queries.push({ sql, params });
        return handler(sql, params);
      },
    },
  };
}

function baseOptions(database, overrides = {}) {
  return {
    pool: database.pool,
    accountQualityReady: Promise.resolve(),
    salesReconciliationReady: Promise.resolve(),
    normalizeCity: (value) => String(value || "").trim().toUpperCase(),
    parseSearch: () => { throw new Error("unexpected_search_parse"); },
    findCountyAccount: async () => null,
    resolveAccountId: async () => { throw new Error("unexpected_account_resolution"); },
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(createPropertySearchRouter(options));
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

test("empty property searches return before parsing or querying", async (context) => {
  const database = createPool(async () => { throw new Error("unexpected_query"); });
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(database.queries.length, 0);
});

test("city-only searches remain canonical-only, ordered, capped, and paginated", async (context) => {
  const rows = [{ account_id: "A-1", city: "PLANO", search_match: "city_prefix" }];
  const database = createPool(async () => ({ rows }));
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search?city=plano&limit=500&offset=-9`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), rows);
  assert.equal(database.queries.length, 1);
  const [{ sql, params }] = database.queries;
  assert.deepEqual(params, ["PLANO%", 100, 0]);
  assert.ok(sql.includes("a.canonical_account_id IS NULL"));
  assert.ok(sql.includes("'city_prefix' AS search_match"));
  assert.ok(sql.includes("LIMIT $2 OFFSET $3"));
  assert.ok(sql.includes("FROM app.county_account_identifiers identifier"));
  assert.ok(sql.includes("LEFT JOIN core.value_summary_current"));
  assert.ok(sql.includes("SELECT m.* FROM core.market_values"));
});

test("native county identifiers resolve to canonical accounts and retain legacy-request metadata", async (context) => {
  const row = { account_id: "COLLIN_CANONICAL", data_quality_status: "verified" };
  const database = createPool(async () => ({ rows: [row] }));
  const calls = [];
  const options = baseOptions(database, {
    parseSearch: (query) => {
      calls.push({ type: "parse", query });
      return { isAccountId: true, normalizedAddress: query, city: "PLANO" };
    },
    findCountyAccount: async (pool, query) => {
      calls.push({ type: "county", pool, query });
      return { account_id: "COLLIN_CANONICAL" };
    },
    resolveAccountId: async () => { throw new Error("unexpected_fallback_resolution"); },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/search?q=r-0033-003-0080-1&city=frisco`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{
    ...row,
    requested_account_id: "r-0033-003-0080-1",
    resolved_from_legacy: true,
    data_quality_status: "legacy_resolved",
  }]);
  assert.deepEqual(calls, [
    { type: "parse", query: "r-0033-003-0080-1" },
    { type: "county", pool: database.pool, query: "r-0033-003-0080-1" },
  ]);
  assert.deepEqual(database.queries[0].params, [
    "COLLIN_CANONICAL",
    "PLANO",
    "FRISCO%",
    25,
    0,
  ]);
  assert.ok(database.queries[0].sql.includes("'exact_account' AS search_match"));
});

test("canonical account searches use fallback resolution without legacy decoration", async (context) => {
  const row = { account_id: "ACCOUNT_1", data_quality_status: "verified" };
  const database = createPool(async () => ({ rows: [row] }));
  const calls = [];
  const server = await startRouter(baseOptions(database, {
    parseSearch: () => ({ isAccountId: true, normalizedAddress: "ACCOUNT_1", city: null }),
    findCountyAccount: async () => null,
    resolveAccountId: async (pool, query) => {
      calls.push({ pool, query });
      return "ACCOUNT_1";
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search?q=account_1&limit=10&offset=7`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [row]);
  assert.deepEqual(calls, [{ pool: database.pool, query: "account_1" }]);
  assert.deepEqual(database.queries[0].params, ["ACCOUNT_1", 10, 7]);
});

test("numbered address prefixes preserve exact-match ranking and both city filters", async (context) => {
  const database = createPool(async () => ({ rows: [] }));
  const server = await startRouter(baseOptions(database, {
    normalizeCity: () => "GARLAND",
    parseSearch: () => ({
      isAccountId: false,
      isAddressPrefix: true,
      normalizedAddress: "1909 SNOWMASS LN",
      streetName: "SNOWMASS LN",
      city: "GARLAND",
    }),
  }));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/search?q=1909%20Snowmass%20Ln&city=garland&limit=12&offset=3`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(database.queries[0].params, [
    "1909 SNOWMASS LN",
    "1909 SNOWMASS LN%",
    "GARLAND",
    "GARLAND%",
    12,
    3,
  ]);
  const { sql } = database.queries[0];
  assert.ok(sql.includes("THEN 'exact_address'"));
  assert.ok(sql.includes("ELSE 'address_prefix'"));
  assert.ok(sql.includes("upper(a.city) = $3"));
  assert.ok(sql.includes("LIKE $4"));
});

test("street-prefix searches preserve canonical filtering and deterministic ordering", async (context) => {
  const database = createPool(async () => ({ rows: [] }));
  const server = await startRouter(baseOptions(database, {
    parseSearch: () => ({
      isAccountId: false,
      isAddressPrefix: false,
      normalizedAddress: "SNOWMASS",
      streetName: "SNOWMASS",
      city: null,
    }),
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search?q=Snowmass`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(database.queries[0].params, ["SNOWMASS%", 25, 0]);
  const { sql } = database.queries[0];
  assert.ok(sql.includes("a.street_name IS NOT NULL"));
  assert.ok(sql.includes("a.canonical_account_id IS NULL"));
  assert.ok(sql.includes("'same_street' AS search_match"));
  assert.ok(sql.includes("upper(a.street_name) COLLATE \"C\""));
});

test("unrecognized parsed searches return empty without database access", async (context) => {
  const database = createPool(async () => { throw new Error("unexpected_query"); });
  const server = await startRouter(baseOptions(database, {
    parseSearch: () => ({ isAccountId: false, normalizedAddress: "" }),
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search?q=%2A%2A%2A`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(database.queries.length, 0);
});

test("property search failures return a stable code and bounded diagnostics", async (context) => {
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const database = createPool(async () => { throw diagnostic; });
  const server = await startRouter(baseOptions(database, {
    normalizeCity: () => "PLANO",
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/search?city=plano`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "search_failed" });
  assert.deepEqual(logs, [[diagnostic]]);
});

test("property search composition is explicit and its inline handler is absent", () => {
  const database = createPool();
  assert.throws(
    () => createPropertySearchRouter(baseOptions(database, { pool: null })),
    /property_search_pool_required/,
  );
  assert.throws(
    () => createPropertySearchRouter(baseOptions(database, { accountQualityReady: null })),
    /property_search_account_readiness_required/,
  );
  assert.throws(
    () => createPropertySearchRouter(baseOptions(database, { parseSearch: null })),
    /property_search_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const history = source.indexOf("app.use(createMarketValueHistoryRouter(");
  const search = source.indexOf("app.use(createPropertySearchRouter(");
  const recommendations = source.indexOf('app.get("/api/sales/recommendations"');
  assert.ok(search > history);
  assert.ok(recommendations > search);
  assert.equal(source.includes('app.get("/api/search"'), false);
});
