import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createSalesListRouter } from "../src/modules/sales/salesListRouter.js";

function options(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountIdAllowed: () => true,
    distanceSqlBuilder: () => "distance_formula",
    resolveSearchProfile: () => null,
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

test("sales list preserves default closed-sale query and response", async (context) => {
  const calls = [];
  const rows = [{ sale_id: "sale-1", sale_price: 325000 }];
  const server = await startRouter(createSalesListRouter(options({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows };
      },
    },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/sales`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), rows);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ["closed_sale", 25, 0]);
  assert.match(calls[0].sql, /v\.record_type = \$1/);
  assert.match(calls[0].sql, /NULL::double precision AS "distanceMiles"/);
  assert.match(calls[0].sql, /LIMIT \$2 OFFSET \$3/);
  assert.doesNotMatch(calls[0].sql, /account_locations subject_location/);
});

test("sales list rejects malformed filters before database access", async (context) => {
  let queryCount = 0;
  const server = await startRouter(createSalesListRouter(options({
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
    accountIdAllowed: (value) => value !== "BAD",
    resolveSearchProfile: (value) => (
      String(value).trim() === "radius_3mi" ? { radiusMiles: 3 } : null
    ),
  })));
  context.after(server.close);

  const cases = [
    ["search_profile=unknown", "invalid_comparable_search_profile"],
    ["matched=maybe", "invalid_matched"],
    ["review=maybe", "invalid_review"],
    ["include_attached=maybe", "invalid_include_attached"],
    ["date_from=09-02-2026", "invalid_date_from"],
    ["date_to=tomorrow", "invalid_date_to"],
    ["multi_parcel=merged", "invalid_multi_parcel"],
    ["record_type=pending", "invalid_record_type"],
    ["subject_account_id=BAD", "invalid_subject_account_id"],
    ["search_profile=radius_3mi", "search_profile_requires_subject"],
    ["min_price=-1", "invalid_min_price"],
    ["max_price=unknown", "invalid_max_price"],
    ["min_price=300000&max_price=200000", "invalid_price_range"],
  ];
  for (const [query, error] of cases) {
    const response = await fetch(`${server.baseUrl}/api/sales?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error }, query);
  }
  assert.equal(queryCount, 0);
});

test("sales list parameterizes the complete filtered geographic query", async (context) => {
  const queries = [];
  const policyCalls = [];
  const distanceCalls = [];
  const profileCalls = [];
  const server = await startRouter(createSalesListRouter(options({
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
    },
    accountIdAllowed: (value) => {
      policyCalls.push(value);
      return value === "A-1";
    },
    distanceSqlBuilder: (input) => {
      distanceCalls.push(input);
      return "SAFE_DISTANCE_SQL";
    },
    resolveSearchProfile: (value, settings) => {
      profileCalls.push({ value, settings });
      return { radiusMiles: 3 };
    },
  })));
  context.after(server.close);

  const params = new URLSearchParams({
    subject_account_id: " A-1 ",
    search_profile: "radius_3mi",
    account_id: "A-2",
    exclude_account_id: "A-3",
    neighborhood_code: "N-1",
    q: "%Maple_",
    record_type: "ALL",
    date_from: "2025-09-02",
    date_to: "2026-09-02",
    min_price: "$100,000",
    max_price: "300000",
    matched: "false",
    review: "yes",
    multi_parcel: "confirmed",
    include_attached: "no",
    limit: "999",
    offset: "-5",
  });
  const response = await fetch(`${server.baseUrl}/api/sales?${params}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(profileCalls, [{ value: "radius_3mi", settings: { useDefault: false } }]);
  assert.deepEqual(policyCalls, ["A-1", "%Maple_"]);
  assert.deepEqual(distanceCalls, [{
    subjectLatitude: "subject_location.latitude::double precision",
    subjectLongitude: "subject_location.longitude::double precision",
    comparableLatitude: "sale_location.latitude::double precision",
    comparableLongitude: "sale_location.longitude::double precision",
  }]);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, [
    "A-1",
    "A-2",
    "A-3",
    "N-1",
    "%Maple%",
    "2025-09-02",
    "2026-09-02",
    100000,
    300000,
    true,
    "confirmed",
    3,
    200,
    0,
  ]);
  assert.match(queries[0].sql, /subject_location\.account_id = \$1/);
  assert.match(queries[0].sql, /v\.primary_account_id = \$2/);
  assert.match(queries[0].sql, /v\.primary_account_id IS DISTINCT FROM \$3/);
  assert.match(queries[0].sql, /sale_account\.neighborhood_code = \$4/);
  assert.match(queries[0].sql, /v\.address ILIKE \$5/);
  assert.match(
    queries[0].sql,
    /COALESCE\(v\.closing_date, v\.listing_contract_date\) >= \$6::date/,
  );
  assert.match(queries[0].sql, /v\.primary_account_id IS NULL/);
  assert.match(queries[0].sql, /v\.requires_additional_review = \$10/);
  assert.match(queries[0].sql, /v\.multi_parcel_status = \$11/);
  assert.match(queries[0].sql, /SAFE_DISTANCE_SQL/);
  assert.match(queries[0].sql, /sale_location\.status = 'matched'/);
  assert.match(queries[0].sql, /<= \$12::double precision/);
  assert.match(queries[0].sql, /v\.attachment_type NOT IN \('attached', 'mixed'\)/);
  assert.match(queries[0].sql, /ORDER BY "distanceMiles" ASC NULLS LAST/);
  assert.match(queries[0].sql, /LIMIT \$13 OFFSET \$14/);
  assert.doesNotMatch(queries[0].sql, /v\.record_type =/);
});

test("listing searches use account matching and listing activity dates", async (context) => {
  const calls = [];
  const server = await startRouter(createSalesListRouter(options({
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
    accountIdAllowed: (value) => value === "A-9",
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/sales?q=A-9&record_type=listing&date_from=2026-01-01&date_to=2026-09-02`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].params, [
    "A-9",
    "2026-01-01",
    "2026-09-02",
    "listing",
    25,
    0,
  ]);
  assert.match(calls[0].sql, /v\.primary_account_id = \$1/);
  assert.match(calls[0].sql, /v\.listing_contract_date >= \$2::date/);
  assert.match(calls[0].sql, /v\.listing_contract_date <= \$3::date/);
  assert.match(calls[0].sql, /v\.record_type = \$4/);
});

test("sales list retains bounded validation and database failure responses", async (context) => {
  const failure = new Error("database_offline");
  const logs = [];
  const server = await startRouter(createSalesListRouter(options({
    pool: { query: async () => { throw failure; } },
    resolveSearchProfile: () => { throw new Error("invalid_profile_policy"); },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const validation = await fetch(`${server.baseUrl}/api/sales?search_profile=radius_3mi`);
  assert.equal(validation.status, 400);
  assert.deepEqual(await validation.json(), { error: "invalid_profile_policy" });

  const database = await fetch(`${server.baseUrl}/api/sales`);
  assert.equal(database.status, 500);
  assert.deepEqual(await database.json(), { error: "sales_search_failed" });
  assert.deepEqual(logs, [["/api/sales failed", failure]]);
});

test("sales list router validates collaborators and remains between recommendations and studies", () => {
  assert.throws(
    () => createSalesListRouter(options({ pool: null })),
    /sales_list_pool_required/,
  );
  assert.throws(
    () => createSalesListRouter(options({ accountIdAllowed: null })),
    /sales_list_account_policy_required/,
  );
  assert.throws(
    () => createSalesListRouter(options({ distanceSqlBuilder: null })),
    /sales_list_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const recommendations = source.indexOf("app.use(createComparableRecommendationsRouter(");
  const salesList = source.indexOf("app.use(createSalesListRouter(");
  const grouped = source.indexOf("app.use(createGroupedAnalysisRouter(");
  assert.ok(recommendations > 0);
  assert.ok(salesList > recommendations);
  assert.ok(grouped > salesList);
  assert.match(
    source,
    /createSalesListRouter\(\{[\s\S]*?accountIdAllowed: legacyAccountIdAllowed,[\s\S]*?distanceSqlBuilder: greatCircleDistanceMilesSql/,
  );
  assert.equal(source.includes('app.get("/api/sales",'), false);
});
