import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createGroupedAnalysisRouter } from "../src/modules/sales/groupedAnalysisRouter.js";

function defaultSubject(overrides = {}) {
  return {
    account_id: "A-1",
    address: "100 Main Street",
    city: "Dallas",
    county: "Dallas",
    postal_code: "75201",
    latitude: "32.78",
    longitude: "-96.8",
    location_status: "matched",
    ...overrides,
  };
}

function routerOptions(overrides = {}) {
  return {
    pool: { query: async () => { throw new Error("unexpected_query"); } },
    accountIdAllowed: () => true,
    locationsReady: Promise.resolve(),
    refreshLocations: async () => { throw new Error("unexpected_location_refresh"); },
    parseBreakdowns: () => [{ key: "city", scope: "city", radiusMiles: null }],
    buildDimensions: () => [],
    debugEnabled: () => false,
    logger: { error() {}, warn() {} },
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

function get(baseUrl, query = {}) {
  const url = new URL("/api/sales/grouped-analysis", baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetch(url);
}

test("grouped analysis rejects invalid inputs before schema or database access", async (context) => {
  let queries = 0;
  let parsed = 0;
  const options = routerOptions({
    pool: { query: async () => { queries += 1; return { rows: [] }; } },
    accountIdAllowed: (value) => value === "A-1",
    parseBreakdowns: (value) => {
      parsed += 1;
      if (value === "bad") throw new Error("invalid_grouped_analysis_breakdown");
      return [{ key: "city", scope: "city", radiusMiles: null }];
    },
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const invalidSubject = await get(server.baseUrl, { subject_account_id: "bad" });
  assert.equal(invalidSubject.status, 400);
  assert.deepEqual(await invalidSubject.json(), { error: "invalid_subject_account_id" });

  const invalidDate = await get(server.baseUrl, {
    subject_account_id: "A-1",
    as_of: "09/02/2026",
  });
  assert.equal(invalidDate.status, 400);
  assert.deepEqual(await invalidDate.json(), { error: "invalid_as_of" });

  const invalidBreakdown = await get(server.baseUrl, {
    subject_account_id: "A-1",
    breakdowns: "bad",
  });
  assert.equal(invalidBreakdown.status, 400);
  assert.deepEqual(await invalidBreakdown.json(), {
    error: "invalid_grouped_analysis_breakdown",
  });
  assert.equal(parsed, 1);
  assert.equal(queries, 0);
});

test("a missing subject stops before grouped-sale queries", async (context) => {
  let queries = 0;
  const options = routerOptions({
    pool: {
      query: async (sql, parameters) => {
        queries += 1;
        assert.match(sql, /FROM core\.accounts account/);
        assert.deepEqual(parameters, ["A-1"]);
        return { rows: [] };
      },
    },
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "subject_not_found" });
  assert.equal(queries, 1);
});

test("city analysis preserves SQL scope, coverage, dimensions, and legacy response shape", async (context) => {
  const subject = defaultSubject();
  const rows = [{
    dimension: "bathrooms",
    group_value: "2",
    sample_size: 8,
    eligible_sale_count: "12",
    bathroom_sale_count: "10",
    garage_sale_count: "9",
    pool_sale_count: "11",
    living_area_sale_count: "12",
    period_start: "2025-09-02",
    period_end: "2026-09-02",
  }];
  const queries = [];
  const dimensions = [{ key: "bathrooms", groups: [{ value: 2 }] }];
  let dimensionInput;
  const options = routerOptions({
    pool: {
      query: async (sql, parameters) => {
        queries.push({ sql, parameters });
        return queries.length === 1 ? { rows: [subject] } : { rows };
      },
    },
    parseBreakdowns: (value) => {
      assert.equal(value, undefined);
      return [{ key: "city", scope: "city", radiusMiles: null }];
    },
    buildDimensions: (input) => { dimensionInput = input; return dimensions; },
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, {
    subject_account_id: " A-1 ",
    as_of: "2026-09-02",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    subject: { account_id: "A-1", address: "100 Main Street" },
    market: {
      key: "city",
      scope: "city",
      city: "Dallas",
      county: "Dallas",
      postal_code: "75201",
      radius_miles: null,
      label: "Dallas, Dallas",
    },
    period: { start: "2025-09-02", end: "2026-09-02" },
    population: {
      eligible_sale_count: 12,
      bathroom_sale_count: 10,
      garage_sale_count: 9,
      pool_sale_count: 11,
      living_area_sale_count: 12,
    },
    filters: {
      record_type: "closed_sale",
      minimum_sale_price: null,
      review_flagged_sales_included: true,
      multi_parcel_sales_included: true,
      attached_housing_included: true,
      period_years: 1,
    },
    dimensions,
  });
  assert.equal(dimensionInput, rows);
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /FROM core\.accounts account/);
  assert.match(queries[0].sql, /LEFT JOIN core\.account_locations location/);
  assert.deepEqual(queries[0].parameters, ["A-1"]);
  assert.match(queries[1].sql, /sale\.record_type = 'closed_sale'/);
  assert.match(queries[1].sql, /INTERVAL '1 year'/);
  assert.match(queries[1].sql, /NTILE\(10\)/);
  assert.match(queries[1].sql, /sale\.mls_garage_yn = false/);
  assert.match(queries[1].sql, /'bathrooms'::text/);
  assert.match(queries[1].sql, /'garage'::text/);
  assert.match(queries[1].sql, /'pool'::text/);
  assert.match(queries[1].sql, /'living_area'::text/);
  assert.deepEqual(queries[1].parameters, [
    "2026-09-02",
    "Dallas",
    "Dallas",
    "75201",
    32.78,
    -96.8,
    "city",
    null,
  ]);
});

test("multiple breakdowns report unavailable areas while retaining usable studies", async (context) => {
  const subject = defaultSubject({
    postal_code: null,
    latitude: null,
    longitude: null,
    location_status: "unmatched",
  });
  const warnings = [];
  const refreshFailure = new Error("geocoder_unavailable");
  let queryCount = 0;
  const options = routerOptions({
    pool: {
      query: async () => {
        queryCount += 1;
        return queryCount === 1
          ? { rows: [subject] }
          : { rows: [{ eligible_sale_count: 3 }] };
      },
    },
    parseBreakdowns: () => [
      { key: "city", scope: "city", radiusMiles: null },
      { key: "zip", scope: "zip", radiusMiles: null },
      { key: "radius_2", scope: "radius", radiusMiles: 2 },
    ],
    refreshLocations: async (pool, subjects, settings) => {
      assert.equal(pool, options.pool);
      assert.deepEqual(subjects, [subject]);
      assert.deepEqual(settings, { batchSize: 1 });
      throw refreshFailure;
    },
    logger: { error() {}, warn: (...args) => warnings.push(args) },
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, {
    subject_account_id: "A-1",
    breakdowns: "city,zip,radius_2",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.analyses.length, 1);
  assert.equal(body.analyses[0].market.key, "city");
  assert.deepEqual(body.unavailable_breakdowns, [
    {
      key: "zip",
      label: "Subject ZIP code",
      reason: "The subject ZIP code is unavailable.",
    },
    {
      key: "radius_2",
      label: "Within 2 miles",
      reason: "The subject parcel location is unavailable.",
    },
  ]);
  assert.deepEqual(body.subject, {
    account_id: "A-1",
    address: "100 Main Street",
    city: "Dallas",
    county: "Dallas",
    postal_code: null,
    latitude: null,
    longitude: null,
  });
  assert.deepEqual(warnings, [[
    "[grouped-analysis] subject location refresh failed; radius studies may be unavailable",
    refreshFailure.message,
  ]]);
  assert.equal(queryCount, 2);
});

test("a successful location refresh reloads the subject before radius analysis", async (context) => {
  const unmatched = defaultSubject({
    latitude: null,
    longitude: null,
    location_status: "unmatched",
  });
  const matched = defaultSubject();
  const queries = [];
  let refreshCall;
  const options = routerOptions({
    pool: {
      query: async (sql, parameters) => {
        queries.push({ sql, parameters });
        if (queries.length === 1) return { rows: [unmatched] };
        if (queries.length === 2) return { rows: [matched] };
        return { rows: [{ eligible_sale_count: 1 }] };
      },
    },
    parseBreakdowns: () => [{ key: "radius_1", scope: "radius", radiusMiles: 1 }],
    refreshLocations: async (...args) => { refreshCall = args; },
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, {
    subject_account_id: "A-1",
    breakdowns: "radius_1",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.analyses[0].market.key, "radius_1");
  assert.deepEqual(refreshCall, [options.pool, [unmatched], { batchSize: 1 }]);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[2].parameters.slice(4), [32.78, -96.8, "radius", 1]);
});

test("a single unavailable market retains the established 422 contract", async (context) => {
  const subject = defaultSubject({ postal_code: null });
  let queries = 0;
  const options = routerOptions({
    pool: { query: async () => { queries += 1; return { rows: [subject] }; } },
    parseBreakdowns: () => [{ key: "zip", scope: "zip", radiusMiles: null }],
  });
  const server = await startRouter(createGroupedAnalysisRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "subject_market_area_unavailable",
    subject_account_id: "A-1",
  });
  assert.equal(queries, 1);
});

test("grouped analysis failures are bounded unless the explicit debug switch is active", async (context) => {
  const failure = Object.assign(new Error("database_connection_failed"), { code: "08006" });
  const logs = [];
  const base = routerOptions({
    pool: { query: async () => { throw failure; } },
    logger: { error: (...args) => logs.push(args), warn() {} },
  });
  const boundedServer = await startRouter(createGroupedAnalysisRouter(base));
  context.after(boundedServer.close);
  const bounded = await get(boundedServer.baseUrl, { subject_account_id: "A-1" });
  assert.equal(bounded.status, 500);
  assert.deepEqual(await bounded.json(), { error: "grouped_analysis_failed" });

  const debugServer = await startRouter(createGroupedAnalysisRouter({
    ...base,
    debugEnabled: () => true,
  }));
  context.after(debugServer.close);
  const debug = await get(debugServer.baseUrl, { subject_account_id: "A-1" });
  assert.equal(debug.status, 500);
  assert.deepEqual(await debug.json(), {
    error: "grouped_analysis_failed",
    detail: failure.message,
    database_code: failure.code,
  });
  assert.deepEqual(logs, [
    ["/api/sales/grouped-analysis failed", failure],
    ["/api/sales/grouped-analysis failed", failure],
  ]);
});

test("grouped-analysis composition is explicit and replaces the inline route", () => {
  assert.throws(
    () => createGroupedAnalysisRouter(routerOptions({ pool: null })),
    /grouped_analysis_pool_required/,
  );
  assert.throws(
    () => createGroupedAnalysisRouter(routerOptions({ accountIdAllowed: null })),
    /grouped_analysis_account_policy_required/,
  );
  assert.throws(
    () => createGroupedAnalysisRouter(routerOptions({ locationsReady: null })),
    /grouped_analysis_locations_ready_required/,
  );
  assert.throws(
    () => createGroupedAnalysisRouter(routerOptions({ buildDimensions: null })),
    /grouped_analysis_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const salesList = source.indexOf("app.use(createSalesListRouter(");
  const grouped = source.indexOf("app.use(createGroupedAnalysisRouter(");
  const comparison = source.indexOf("app.use(createComparisonStudyRouter(");
  assert.ok(grouped > salesList);
  assert.ok(comparison > grouped);
  assert.match(
    source,
    /createGroupedAnalysisRouter\(\{[\s\S]*?accountIdAllowed: legacyAccountIdAllowed,[\s\S]*?locationsReady: accountLocationsReady/,
  );
  assert.equal(source.includes('app.get("/api/sales/grouped-analysis"'), false);
});
