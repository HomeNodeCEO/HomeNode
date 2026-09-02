import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createNeighborhoodAnalysisRouter } from "../src/modules/sales/neighborhoodAnalysisRouter.js";

function createPool() {
  return { query: async () => ({ rows: [] }) };
}

function routerOptions(overrides = {}) {
  return {
    pool: createPool(),
    accountIdAllowed: () => true,
    buildMarketAnalyses: async () => { throw new Error("unexpected_market_analysis"); },
    marketErrorStatus: () => 400,
    loadBoundaryStreets: async () => { throw new Error("unexpected_boundary_streets"); },
    compactProfileResponse: (response) => response,
    isProfileBusyError: () => false,
    profileRequestKey: () => "profile-key",
    runProfileOperation: async (_key, operation) => operation(),
    buildLandUseAnalysis: async () => { throw new Error("unexpected_land_use_analysis"); },
    landUseErrorStatus: () => 400,
    logger: { error() {}, warn() {} },
    ...overrides,
  };
}

async function startRouter(router) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
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

function post(baseUrl, path, body = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("neighborhood profile preserves every analysis, gate, and boundary input", async (context) => {
  const calls = [];
  const geometry = { type: "Polygon", coordinates: [] };
  const override = { city: "Plano" };
  const market = { subject: { account_id: "A-1" }, analyses: [{ market: { key: "custom" } }] };
  const streets = { north: "Main Street" };
  const options = routerOptions({
    profileRequestKey: (request) => {
      calls.push({ type: "key", request });
      return "request-key";
    },
    runProfileOperation: async (key, operation, settings) => {
      calls.push({ type: "gate", key, settings });
      return operation();
    },
    buildMarketAnalyses: async (pool, input) => {
      calls.push({ type: "market", pool, input });
      return market;
    },
    loadBoundaryStreets: async (pool, inputGeometry) => {
      calls.push({ type: "streets", pool, geometry: inputGeometry });
      return streets;
    },
    compactProfileResponse: (input) => {
      calls.push({ type: "compact", input });
      return { compact: input };
    },
  });
  const server = await startRouter(createNeighborhoodAnalysisRouter(options));
  context.after(server.close);

  const response = await post(server.baseUrl, "/api/sales/neighborhood-profile", {
    subject_account_id: "  A-1  ",
    as_of: "  2026-09-02  ",
    period_months: 0,
    custom_geometry: geometry,
    context_override: override,
    force_refresh: true,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    compact: {
      ...market,
      boundary_streets: streets,
      boundary_street_warning: null,
    },
  });
  const request = {
    subjectAccountId: "A-1",
    asOfDate: "2026-09-02",
    periodMonths: 0,
    customGeometry: geometry,
    marketContextOverride: override,
    forceRefresh: true,
  };
  assert.deepEqual(calls, [
    { type: "key", request },
    { type: "gate", key: "request-key", settings: { allowCached: false } },
    {
      type: "market",
      pool: options.pool,
      input: {
        subjectAccountId: "A-1",
        areaKeys: ["custom", "city"],
        asOfDate: "2026-09-02",
        periodMonths: 0,
        customGeometry: geometry,
        marketContextOverride: override,
        accountIdAllowed: options.accountIdAllowed,
      },
    },
    { type: "streets", pool: options.pool, geometry },
    {
      type: "compact",
      input: {
        ...market,
        boundary_streets: streets,
        boundary_street_warning: null,
      },
    },
  ]);
});

test("street lookup failure degrades the profile without discarding market evidence", async (context) => {
  const streetError = new Error("boundary_provider_unavailable");
  const warnings = [];
  const options = routerOptions({
    buildMarketAnalyses: async () => ({ subject: { account_id: "A-1" }, analyses: [] }),
    loadBoundaryStreets: async () => { throw streetError; },
    logger: { error() {}, warn: (...args) => warnings.push(args) },
  });
  const server = await startRouter(createNeighborhoodAnalysisRouter(options));
  context.after(server.close);

  const response = await post(server.baseUrl, "/api/sales/neighborhood-profile");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    subject: { account_id: "A-1" },
    analyses: [],
    boundary_streets: null,
    boundary_street_warning: streetError.message,
  });
  assert.deepEqual(warnings, [[
    "/api/sales/neighborhood-profile street lookup failed",
    streetError,
  ]]);
});

test("profile capacity and domain failures retain bounded response contracts", async (context) => {
  const domainError = Object.assign(new Error("invalid_market_area"), {
    detail: { area: "custom" },
  });
  const logs = [];
  let failure = new Error("neighborhood_profile_capacity_exceeded");
  const options = routerOptions({
    runProfileOperation: async () => { throw failure; },
    isProfileBusyError: (message) => message === "neighborhood_profile_capacity_exceeded",
    marketErrorStatus: (message) => {
      assert.equal(message, domainError.message);
      return 422;
    },
    logger: { error: (...args) => logs.push(args), warn() {} },
  });
  const server = await startRouter(createNeighborhoodAnalysisRouter(options));
  context.after(server.close);

  const busy = await post(server.baseUrl, "/api/sales/neighborhood-profile");
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "10");
  assert.deepEqual(await busy.json(), { error: "neighborhood_profile_busy" });
  assert.deepEqual(logs, []);

  failure = domainError;
  const invalid = await post(server.baseUrl, "/api/sales/neighborhood-profile");
  assert.equal(invalid.status, 422);
  assert.deepEqual(await invalid.json(), {
    error: domainError.message,
    detail: domainError.detail,
  });
  assert.deepEqual(logs, [["/api/sales/neighborhood-profile failed", domainError]]);
});

test("neighborhood land use preserves subject and polygon scope", async (context) => {
  const calls = [];
  const geometry = { type: "Polygon", coordinates: [] };
  const result = { residential: 72.5, commercial: 27.5 };
  const options = routerOptions({
    buildLandUseAnalysis: async (pool, input) => {
      calls.push({ pool, input });
      return result;
    },
  });
  const server = await startRouter(createNeighborhoodAnalysisRouter(options));
  context.after(server.close);

  const response = await post(server.baseUrl, "/api/sales/neighborhood-land-use", {
    subject_account_id: "  A-1  ",
    custom_geometry: geometry,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [{
    pool: options.pool,
    input: { subjectAccountId: "A-1", customGeometry: geometry },
  }]);
});

test("land-use failures retain domain status, detail, and server diagnostics", async (context) => {
  const failure = Object.assign(new Error("invalid_custom_geometry"), {
    detail: { reason: "polygon_required" },
  });
  const logs = [];
  const options = routerOptions({
    buildLandUseAnalysis: async () => { throw failure; },
    landUseErrorStatus: (message) => {
      assert.equal(message, failure.message);
      return 422;
    },
    logger: { error: (...args) => logs.push(args), warn() {} },
  });
  const server = await startRouter(createNeighborhoodAnalysisRouter(options));
  context.after(server.close);

  const response = await post(server.baseUrl, "/api/sales/neighborhood-land-use");
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: failure.message,
    detail: failure.detail,
  });
  assert.deepEqual(logs, [["/api/sales/neighborhood-land-use failed", failure]]);
});

test("neighborhood analysis composition is explicit and replaces both inline routes", () => {
  assert.throws(
    () => createNeighborhoodAnalysisRouter(routerOptions({ pool: null })),
    /neighborhood_analysis_pool_required/,
  );
  assert.throws(
    () => createNeighborhoodAnalysisRouter(routerOptions({ accountIdAllowed: null })),
    /neighborhood_analysis_account_policy_required/,
  );
  assert.throws(
    () => createNeighborhoodAnalysisRouter(routerOptions({ runProfileOperation: null })),
    /neighborhood_analysis_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const valuation = source.indexOf("app.use(createValuationStudyRouter(");
  const analysis = source.indexOf("app.use(createNeighborhoodAnalysisRouter(");
  const propertyContext = source.indexOf("app.use(createPropertyContextStatusRouter(");
  assert.ok(analysis > valuation);
  assert.ok(propertyContext > analysis);
  assert.equal(source.includes('app.post("/api/sales/neighborhood-profile"'), false);
  assert.equal(source.includes('app.post("/api/sales/neighborhood-land-use"'), false);
});
