import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createComparisonStudyRouter } from "../src/modules/sales/comparisonStudyRouter.js";
import { createValuationStudyRouter } from "../src/modules/sales/valuationStudyRouter.js";

function createPool() {
  return { query: async () => ({ rows: [] }) };
}

function comparisonOptions(overrides = {}) {
  return {
    pool: createPool(),
    accountIdAllowed: () => true,
    buildPairedStudy: async () => { throw new Error("unexpected_paired_study"); },
    pairedErrorStatus: () => 400,
    loadMarketContext: async () => { throw new Error("unexpected_market_context"); },
    marketErrorStatus: () => 400,
    logger: { error() {} },
    ...overrides,
  };
}

function valuationOptions(overrides = {}) {
  return {
    pool: createPool(),
    accountIdAllowed: () => true,
    buildMarketAnalyses: async () => { throw new Error("unexpected_market_analysis"); },
    marketErrorStatus: () => 400,
    buildRegression: async () => { throw new Error("unexpected_regression"); },
    regressionErrorStatus: () => 400,
    calculateDepreciatedCost: () => { throw new Error("unexpected_depreciated_cost"); },
    depreciatedCostErrorStatus: () => 400,
    buildSiteValuation: async () => { throw new Error("unexpected_site_valuation"); },
    siteErrorStatus: () => 400,
    calculateQualitative: () => { throw new Error("unexpected_qualitative"); },
    qualitativeErrorStatus: () => 400,
    logger: { error() {} },
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

test("paired analysis forwards normalized study inputs and the account policy", async (context) => {
  const calls = [];
  const result = { pairs: [{ id: "pair-1" }], statistics: { mean: 12.5 } };
  const options = comparisonOptions({
    buildPairedStudy: async (pool, input) => { calls.push({ pool, input }); return result; },
  });
  const server = await startRouter(createComparisonStudyRouter(options));
  context.after(server.close);
  const geometry = { type: "Polygon", coordinates: [] };

  const response = await post(server.baseUrl, "/api/sales/paired-analysis", {
    subject_account_id: "  A-1  ",
    market_key: "  radius_3mi  ",
    as_of: "  2026-09-02  ",
    custom_geometry: geometry,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [{
    pool: options.pool,
    input: {
      subjectAccountId: "A-1",
      marketKey: "radius_3mi",
      asOfDate: "2026-09-02",
      customGeometry: geometry,
      accountIdAllowed: options.accountIdAllowed,
    },
  }]);
});

test("market context trims the subject and retains account-policy injection", async (context) => {
  const calls = [];
  const subject = { account_id: "A-1", city: "Plano" };
  const options = comparisonOptions({
    loadMarketContext: async (pool, accountId, settings) => {
      calls.push({ pool, accountId, settings });
      return subject;
    },
  });
  const server = await startRouter(createComparisonStudyRouter(options));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/sales/market-context?subject_account_id=%20A-1%20`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subject });
  assert.deepEqual(calls, [{
    pool: options.pool,
    accountId: "A-1",
    settings: { accountIdAllowed: options.accountIdAllowed },
  }]);
});

test("comparison study failures retain domain status mapping, detail, and diagnostics", async (context) => {
  const pairedError = new Error("insufficient_paired_sales");
  const contextError = Object.assign(new Error("market_context_unavailable"), {
    detail: { missing: ["latitude"] },
  });
  const logs = [];
  const options = comparisonOptions({
    buildPairedStudy: async () => { throw pairedError; },
    pairedErrorStatus: (message) => {
      assert.equal(message, pairedError.message);
      return 422;
    },
    loadMarketContext: async () => { throw contextError; },
    marketErrorStatus: (message) => {
      assert.equal(message, contextError.message);
      return 409;
    },
    logger: { error: (...args) => logs.push(args) },
  });
  const server = await startRouter(createComparisonStudyRouter(options));
  context.after(server.close);

  const paired = await post(server.baseUrl, "/api/sales/paired-analysis");
  assert.equal(paired.status, 422);
  assert.deepEqual(await paired.json(), { error: pairedError.message });
  const market = await fetch(`${server.baseUrl}/api/sales/market-context`);
  assert.equal(market.status, 409);
  assert.deepEqual(await market.json(), {
    error: contextError.message,
    detail: contextError.detail,
  });
  assert.deepEqual(logs, [
    ["/api/sales/paired-analysis failed", pairedError],
    ["/api/sales/market-context failed", contextError],
  ]);
});

test("market analysis preserves every selected analytical input", async (context) => {
  const calls = [];
  const result = { analyses: [{ area_key: "city" }] };
  const options = valuationOptions({
    buildMarketAnalyses: async (pool, input) => { calls.push({ pool, input }); return result; },
  });
  const server = await startRouter(createValuationStudyRouter(options));
  context.after(server.close);
  const geometry = { type: "Polygon", coordinates: [] };
  const override = { city: "Plano" };

  const response = await post(server.baseUrl, "/api/sales/market-analysis", {
    subject_account_id: " A-1 ",
    area_keys: ["city", "radius_3mi"],
    as_of: " 2026-09-02 ",
    period_months: 0,
    custom_geometry: geometry,
    context_override: override,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(calls, [{
    pool: options.pool,
    input: {
      subjectAccountId: "A-1",
      areaKeys: ["city", "radius_3mi"],
      asOfDate: "2026-09-02",
      periodMonths: 0,
      customGeometry: geometry,
      marketContextOverride: override,
      accountIdAllowed: options.accountIdAllowed,
    },
  }]);
});

test("regression and site studies preserve shared market inputs independently", async (context) => {
  const calls = [];
  const options = valuationOptions({
    buildRegression: async (pool, input) => {
      calls.push({ type: "regression", pool, input });
      return { model: "ols" };
    },
    buildSiteValuation: async (pool, input) => {
      calls.push({ type: "site", pool, input });
      return { site_value_per_square_foot: 12.5 };
    },
  });
  const server = await startRouter(createValuationStudyRouter(options));
  context.after(server.close);
  const body = {
    subject_account_id: " A-1 ",
    market_key: " radius_2mi ",
    as_of: " 2026-09-02 ",
    custom_geometry: { type: "Polygon", coordinates: [] },
  };

  const regression = await post(server.baseUrl, "/api/sales/regression-analysis", body);
  assert.equal(regression.status, 200);
  assert.deepEqual(await regression.json(), { model: "ols" });
  const site = await post(server.baseUrl, "/api/sales/site-valuation", body);
  assert.equal(site.status, 200);
  assert.deepEqual(await site.json(), { site_value_per_square_foot: 12.5 });
  const expectedInput = {
    subjectAccountId: "A-1",
    marketKey: "radius_2mi",
    asOfDate: "2026-09-02",
    customGeometry: body.custom_geometry,
    accountIdAllowed: options.accountIdAllowed,
  };
  assert.deepEqual(calls, [
    { type: "regression", pool: options.pool, input: expectedInput },
    { type: "site", pool: options.pool, input: expectedInput },
  ]);
});

test("cost and qualitative calculators receive the original request evidence", async (context) => {
  const calls = [];
  const options = valuationOptions({
    calculateDepreciatedCost: (body) => {
      calls.push({ type: "cost", body });
      return { adjustment: 12500 };
    },
    calculateQualitative: (body, comparables) => {
      calls.push({ type: "qualitative", body, comparables });
      return { reconciliation: "supported" };
    },
  });
  const server = await startRouter(createValuationStudyRouter(options));
  context.after(server.close);
  const costBody = { feature: "garage", replacement_cost_new: 25000 };
  const qualitativeBody = { subject_value: 425000, comparables: [{ id: "sale-1" }] };

  const cost = await post(server.baseUrl, "/api/sales/depreciated-cost-adjustment", costBody);
  assert.equal(cost.status, 200);
  assert.deepEqual(await cost.json(), { adjustment: 12500 });
  const qualitative = await post(server.baseUrl, "/api/sales/qualitative-analysis", qualitativeBody);
  assert.equal(qualitative.status, 200);
  assert.deepEqual(await qualitative.json(), { reconciliation: "supported" });
  assert.deepEqual(calls, [
    { type: "cost", body: costBody },
    { type: "qualitative", body: qualitativeBody, comparables: qualitativeBody.comparables },
  ]);
});

test("valuation failures retain each domain mapper and asynchronous diagnostics", async (context) => {
  const errors = {
    market: Object.assign(new Error("invalid_market_area"), { detail: { area: "bad" } }),
    regression: new Error("regression_sample_too_small"),
    cost: new Error("invalid_replacement_cost"),
    site: new Error("site_sales_unavailable"),
    qualitative: new Error("invalid_qualitative_bracketing"),
  };
  const logs = [];
  const options = valuationOptions({
    buildMarketAnalyses: async () => { throw errors.market; },
    marketErrorStatus: () => 422,
    buildRegression: async () => { throw errors.regression; },
    regressionErrorStatus: () => 409,
    calculateDepreciatedCost: () => { throw errors.cost; },
    depreciatedCostErrorStatus: () => 400,
    buildSiteValuation: async () => { throw errors.site; },
    siteErrorStatus: () => 404,
    calculateQualitative: () => { throw errors.qualitative; },
    qualitativeErrorStatus: () => 400,
    logger: { error: (...args) => logs.push(args) },
  });
  const server = await startRouter(createValuationStudyRouter(options));
  context.after(server.close);

  const cases = [
    ["/api/sales/market-analysis", 422, errors.market, { detail: errors.market.detail }],
    ["/api/sales/regression-analysis", 409, errors.regression, {}],
    ["/api/sales/depreciated-cost-adjustment", 400, errors.cost, {}],
    ["/api/sales/site-valuation", 404, errors.site, {}],
    ["/api/sales/qualitative-analysis", 400, errors.qualitative, {}],
  ];
  for (const [path, status, error, extra] of cases) {
    const response = await post(server.baseUrl, path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: error.message, ...extra });
  }
  assert.deepEqual(logs, [
    ["/api/sales/market-analysis failed", errors.market],
    ["/api/sales/regression-analysis failed", errors.regression],
    ["/api/sales/site-valuation failed", errors.site],
  ]);
});

test("sales study composition preserves route positions and removes inline handlers", () => {
  assert.throws(
    () => createComparisonStudyRouter(comparisonOptions({ pool: null })),
    /comparison_study_pool_required/,
  );
  assert.throws(
    () => createComparisonStudyRouter(comparisonOptions({ accountIdAllowed: null })),
    /comparison_study_account_policy_required/,
  );
  assert.throws(
    () => createValuationStudyRouter(valuationOptions({ pool: null })),
    /valuation_study_pool_required/,
  );
  assert.throws(
    () => createValuationStudyRouter(valuationOptions({ buildRegression: null })),
    /valuation_study_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const grouped = source.indexOf("app.use(createGroupedAnalysisRouter(");
  const comparison = source.indexOf("app.use(createComparisonStudyRouter(");
  const related = source.indexOf("app.use(createRelatedParcelsRouter(");
  const valuation = source.indexOf("app.use(createValuationStudyRouter(");
  const neighborhood = source.indexOf("app.use(createNeighborhoodAnalysisRouter(");
  assert.ok(comparison > grouped);
  assert.ok(related > comparison);
  assert.ok(valuation > related);
  assert.ok(neighborhood > valuation);
  for (const route of [
    'app.post("/api/sales/paired-analysis"',
    'app.get("/api/sales/market-context"',
    'app.post("/api/sales/market-analysis"',
    'app.post("/api/sales/regression-analysis"',
    'app.post("/api/sales/depreciated-cost-adjustment"',
    'app.post("/api/sales/site-valuation"',
    'app.post("/api/sales/qualitative-analysis"',
  ]) {
    assert.equal(source.includes(route), false);
  }
});
