import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createMarketValueHistoryRouter } from "../src/modules/accounts/marketValueHistoryRouter.js";

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

async function startRouter(options) {
  const app = express();
  app.use(createMarketValueHistoryRouter(options));
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

test("market value history rejects missing account IDs before querying", async (context) => {
  const database = createPool(async () => { throw new Error("unexpected_query"); });
  const server = await startRouter({ pool: database.pool, logger: { error() {} } });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/%20/market_value_history`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "missing_id" });
  assert.equal(database.queries.length, 0);
});

test("market value history selects the strongest likely value column", async (context) => {
  const rows = [
    { account_id: "A-1", tax_year: 2026, assessed_value: 200000, market_value: 250000 },
    { account_id: "A-1", tax_year: 2025, assessed_value: 190000, market_value: 240000 },
  ];
  const database = createPool(async () => ({ rows }));
  const server = await startRouter({ pool: database.pool, logger: { error() {} } });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/market_value_history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { tax_year: 2026, market_value: 250000 },
    { tax_year: 2025, market_value: 240000 },
  ]);
  assert.equal(database.queries.length, 1);
  assert.ok(database.queries[0].sql.includes("FROM core.market_value_history"));
  assert.deepEqual(database.queries[0].params, ["A-1"]);
});

test("market value history emits null values when no candidate column exists", async (context) => {
  const database = createPool(async () => ({
    rows: [
      { account_id: "A-1", tax_year: 2026 },
      { account_id: "A-1", tax_year: 2025 },
    ],
  }));
  const server = await startRouter({ pool: database.pool, logger: { error() {} } });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/market_value_history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { tax_year: 2026, market_value: null },
    { tax_year: 2025, market_value: null },
  ]);
});

test("an empty primary history table returns empty without querying the legacy fallback", async (context) => {
  const database = createPool(async () => ({ rows: [] }));
  const server = await startRouter({ pool: database.pool, logger: { error() {} } });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/market_value_history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(database.queries.length, 1);
  assert.ok(database.queries[0].sql.includes("FROM core.market_value_history"));
});

test("undefined primary table falls back to legacy market values with the same mapping", async (context) => {
  const database = createPool(async (sql) => {
    if (sql.includes("FROM core.market_value_history")) {
      throw Object.assign(new Error("missing relation"), { code: "42P01" });
    }
    return {
      rows: [
        { account_id: "A-1", tax_year: 2026, total_value: "255000" },
        { account_id: "A-1", tax_year: 2025, total_value: "245000" },
      ],
    };
  });
  const server = await startRouter({ pool: database.pool, logger: { error() {} } });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/market_value_history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { tax_year: 2026, market_value: "255000" },
    { tax_year: 2025, market_value: "245000" },
  ]);
  assert.equal(database.queries.length, 2);
  assert.ok(database.queries[1].sql.includes("FROM core.market_values"));
  assert.deepEqual(database.queries[1].params, ["A-1"]);
});

test("non-schema history failures preserve the legacy response and logging behavior", async (context) => {
  const diagnostic = Object.assign(new Error("database unavailable"), { code: "XX000" });
  const logs = [];
  const database = createPool(async () => { throw diagnostic; });
  const server = await startRouter({
    pool: database.pool,
    logger: { error: (...args) => logs.push(args) },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/market_value_history`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "database unavailable" });
  assert.deepEqual(logs, [[diagnostic]]);
  assert.equal(database.queries.length, 1);
});

test("market value history composition is explicit and its inline handler is absent", () => {
  assert.throws(
    () => createMarketValueHistoryRouter(),
    /market_value_history_pool_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const mutations = source.indexOf("app.use(createEnrichmentMutationRouter(");
  const history = source.indexOf("app.use(createMarketValueHistoryRouter(");
  const search = source.indexOf('app.get("/api/search"');
  assert.ok(history > mutations);
  assert.ok(search > history);
  assert.equal(source.includes('app.get("/api/accounts/:id/market_value_history"'), false);
});
