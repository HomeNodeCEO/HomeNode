import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createComparableRecommendationsRouter } from "../src/modules/sales/comparableRecommendationsRouter.js";

function subject(overrides = {}) {
  return {
    account_id: "A-1",
    address: "100 Main Street",
    city: "Dallas",
    county: "Dallas",
    postal_code: "75201",
    neighborhood_code: "N-1",
    structural_style: "Traditional",
    housing_type: "Single Family",
    attachment_type: "Detached",
    living_area_sqft: "2000",
    year_built: 2005,
    manual_land_value: { land_detail: [{ area_sqft: "1,000" }, { area_sqft: 500 }] },
    cad_site_size_sqft: "12000",
    latitude: "32.78",
    longitude: "-96.8",
    location_status: "matched",
    location_source: "dcad_gis",
    location_precision: "parcel",
    location_confidence: "high",
    location_review_required: false,
    location_review_reason: null,
    geocoded_at: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    sale_id: 10,
    source_record_id: 20,
    listing_id: "MLS-20",
    primary_account_id: "C-1",
    county: "Dallas",
    account_county: "Dallas",
    address: "200 Main Street",
    city: "Dallas",
    zip: "75201",
    closing_date: "2026-07-01",
    sale_price: "425000",
    cad_living_area_sqft: "2100",
    cad_year_built: 2004,
    manual_land_value: { land_detail: [{ area_sqft: "8,000" }] },
    mls_lot_size_area: "0.5",
    latitude: "32.79",
    longitude: "-96.79",
    location_status: "matched",
    location_review_required: false,
    requires_additional_review: false,
    candidate_influence_signature: { material_influence_present: false },
    ...overrides,
  };
}

function defaultInfluencePolicy(sales) {
  return {
    sales,
    policy: {
      measured_sale_count: sales.length,
      eligible_sale_count: sales.length,
    },
  };
}

function defaultRecommendationPolicy(sales) {
  return {
    sales,
    policy: {
      housingTypeMismatchCount: 0,
      recentHighScoreCount: sales.length,
    },
  };
}

function routerOptions(overrides = {}) {
  return {
    pool: { query: async () => { throw new Error("unexpected_query"); } },
    accountIdAllowed: () => true,
    locationsReady: Promise.resolve(),
    enrichmentReady: Promise.resolve(),
    backfillReady: Promise.resolve(),
    distanceSqlBuilder: () => "distance_miles_sql",
    resolveSearchProfile: () => ({
      key: "standard",
      label: "Standard",
      geography: "radius",
      complexity: "typical",
      radiusMiles: 5,
    }),
    resolveAnalysisWindow: () => ({
      analysisStartDate: "2025-09-03",
      analysisAsOf: "2026-09-02",
    }),
    parseBreakdowns: () => [{ key: "city", scope: "city", radiusMiles: null }],
    refreshLocations: async () => { throw new Error("unexpected_location_refresh"); },
    loadInfluenceContexts: async () => new Map([["A-1", {
      influence_signature: { material_influence_present: false },
    }]]),
    enqueueInfluences: async () => {},
    enqueueLocationBackfill: async () => {},
    scoreCandidate: () => ({
      comparableScore: 90,
      distanceMiles: 1,
      squareFootageDifferenceRatio: 0.05,
      ageDataAvailable: true,
      siteDataAvailable: true,
    }),
    filterForMarket: (sales) => sales,
    rankByInfluence: (sales) => defaultInfluencePolicy(sales),
    applyPolicy: (sales) => defaultRecommendationPolicy(sales),
    analyzeOutliers: (sales) => ({ sales, analysis: { available: false } }),
    summarizeResults: (sales) => ({
      recommendedSales: sales,
      secondarySales: [],
      olderThanOneYearCount: 0,
      olderThanTwoYearsCount: 0,
    }),
    currentDate: () => "2026-09-02",
    requireCustomAccountScope: async () => true,
    requirePropertyTaxAccountScope: async () => true,
    logger: { error() {}, warn() {} },
    ...overrides,
  };
}

test("recommendations require exact custom or property-tax workfile scope before readiness", async (context) => {
  let readinessReleased = false;
  let customScope;
  let propertyTaxScope;
  const options = routerOptions({
    locationsReady: {
      then() {
        readinessReleased = true;
      },
    },
    requireCustomAccountScope: async (...values) => {
      customScope = values;
      values[1].status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
    requirePropertyTaxAccountScope: async (...values) => {
      propertyTaxScope = values;
      values[1].status(403).json({ error: "property_tax_protest_file_access_denied" });
      return false;
    },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const custom = await get(server.baseUrl, {
    subject_account_id: "A-1",
    assignment_file_id: "42",
  });
  assert.equal(custom.status, 403);
  assert.deepEqual(await custom.json(), { error: "assignment_file_access_denied" });
  assert.equal(customScope[2], "A-1");
  assert.equal(customScope[3], "42");
  assert.equal(customScope[4], "read");

  const propertyTax = await get(server.baseUrl, {
    subject_account_id: "A-1",
    property_tax_file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(propertyTax.status, 403);
  assert.deepEqual(await propertyTax.json(), { error: "property_tax_protest_file_access_denied" });
  assert.equal(propertyTaxScope[2], "A-1");
  assert.equal(propertyTaxScope[3], "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(propertyTaxScope[4], "read");
  assert.equal(readinessReleased, false);
});

test("recommendations reject ambiguous workfile scope before authorization", async (context) => {
  let accessCalls = 0;
  const options = routerOptions({
    requireCustomAccountScope: async () => { accessCalls += 1; return true; },
    requirePropertyTaxAccountScope: async () => { accessCalls += 1; return true; },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);
  const response = await get(server.baseUrl, {
    subject_account_id: "A-1",
    assignment_file_id: "42",
    property_tax_file_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "ambiguous_recommendation_scope" });
  assert.equal(accessCalls, 0);
});

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
  const url = new URL("/api/sales/recommendations", baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetch(url);
}

test("recommendations reject malformed policy and market inputs before database access", async (context) => {
  let queries = 0;
  const options = routerOptions({
    pool: { query: async () => { queries += 1; return { rows: [] }; } },
    accountIdAllowed: (value) => value === "A-1",
    resolveSearchProfile: (value) => value === "bad" ? null : {
      key: "standard",
      label: "Standard",
      geography: "radius",
      complexity: "typical",
      radiusMiles: 5,
    },
    parseBreakdowns: () => [
      { key: "city", scope: "city", radiusMiles: null },
      { key: "zip", scope: "zip", radiusMiles: null },
    ],
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const cases = [
    [{ subject_account_id: "A-1", search_profile: "bad" }, "invalid_comparable_search_profile"],
    [{ subject_account_id: "bad" }, "invalid_subject_account_id"],
    [{ subject_account_id: "A-1", date_from: "09/01/2026" }, "invalid_date_from"],
    [{ subject_account_id: "A-1", date_to: "09/02/2026" }, "invalid_date_to"],
    [{ subject_account_id: "A-1", analysis_as_of: "bad" }, "invalid_analysis_as_of"],
    [{ subject_account_id: "A-1", period_months: "18" }, "invalid_analysis_period"],
    [{ subject_account_id: "A-1", market_breakdown: "city,zip" }, "invalid_market_breakdown"],
    [{ subject_account_id: "A-1", location_weight: "2" }, "invalid_scoring_configuration"],
    [{
      subject_account_id: "A-1",
      location_weight: "0",
      square_footage_weight: "0",
      year_built_weight: "0",
      site_size_weight: "0",
      sales_date_weight: "0",
    }, "invalid_scoring_configuration"],
  ];
  for (const [query, error] of cases) {
    const response = await get(server.baseUrl, query);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(queries, 0);
});

test("missing subjects and incomplete subject evidence stop before candidate selection", async (context) => {
  let rows = [];
  let queries = 0;
  const options = routerOptions({
    pool: {
      query: async (sql) => {
        queries += 1;
        assert.match(sql, /FROM core\.accounts account/);
        return { rows };
      },
    },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const missing = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "subject_not_found" });

  rows = [subject({ living_area_sqft: null })];
  const incomplete = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(incomplete.status, 422);
  assert.deepEqual(await incomplete.json(), {
    error: "subject_living_area_unavailable",
    subject_account_id: "A-1",
  });
  assert.equal(queries, 2);
});

test("unmatched subjects are refreshed and retain a bounded location failure", async (context) => {
  const unmatched = subject({
    latitude: null,
    longitude: null,
    location_status: "unmatched",
  });
  let queries = 0;
  let refreshCall;
  const options = routerOptions({
    pool: {
      query: async () => {
        queries += 1;
        return { rows: [unmatched] };
      },
    },
    refreshLocations: async (...args) => { refreshCall = args; },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "subject_location_unavailable",
    subject_account_id: "A-1",
  });
  assert.deepEqual(refreshCall, [options.pool, [unmatched], { batchSize: 1 }]);
  assert.equal(queries, 2);
});

test("recommendations preserve bounded SQL, site evidence precedence, ranking, and response contracts", async (context) => {
  const subjectRow = subject();
  const candidateRow = candidate();
  const queries = [];
  const calls = [];
  const subjectSignature = {
    material_influence_present: true,
    material_categories: ["highway"],
  };
  const options = routerOptions({
    pool: {
      query: async (sql, parameters) => {
        queries.push({ sql, parameters });
        if (sql.includes("FROM core.accounts account")) return { rows: [subjectRow] };
        if (sql.includes("FROM core.v_sales_enriched sale")) return { rows: [candidateRow] };
        if (sql.includes("FROM core.land_detail land")) {
          return { rows: [{ account_id: "C-1", site_size_sqft: "9000" }] };
        }
        throw new Error("unexpected_query");
      },
    },
    distanceSqlBuilder: (input) => {
      calls.push({ type: "distance", input });
      return "distance_miles_sql";
    },
    loadInfluenceContexts: async (pool, accountIds) => {
      calls.push({ type: "influence", pool, accountIds });
      return new Map([["A-1", { influence_signature: subjectSignature }]]);
    },
    scoreCandidate: (input, config) => {
      calls.push({ type: "score", input, config });
      return {
        comparableScore: 91,
        distanceMiles: 1.25,
        squareFootageDifferenceRatio: 0.05,
        ageDataAvailable: true,
        siteDataAvailable: true,
      };
    },
    filterForMarket: (sales, inputSubject, market) => {
      calls.push({ type: "filter", sales, subject: inputSubject, market });
      return sales;
    },
    rankByInfluence: (sales, signature, signatureFor) => {
      calls.push({
        type: "rank",
        sales,
        signature,
        candidateSignature: signatureFor(sales[0]),
      });
      return defaultInfluencePolicy(sales);
    },
    applyPolicy: (sales, input) => {
      calls.push({ type: "policy", sales, input });
      return defaultRecommendationPolicy(sales);
    },
    analyzeOutliers: (sales, input) => {
      calls.push({ type: "outliers", sales, input });
      return { sales, analysis: { available: true, sample_size: 1 } };
    },
    summarizeResults: (sales) => ({
      recommendedSales: sales,
      secondarySales: sales,
      olderThanOneYearCount: 0,
      olderThanTwoYearsCount: 0,
    }),
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: " A-1 ", limit: "1" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.subject.account_id, "A-1");
  assert.equal(body.subject.site_size_sqft, 1500);
  assert.deepEqual(body.subject.influence_signature, subjectSignature);
  assert.equal(body.search_profile.key, "standard");
  assert.deepEqual(body.analysis_period, {
    analysis_as_of: "2026-09-02",
    date_from: "2025-09-03",
    period_months: 12,
  });
  assert.equal(body.coverage.candidate_count, 1);
  assert.equal(body.coverage.eligible_count, 1);
  assert.equal(body.coverage.recommended_count, 1);
  assert.equal(body.recommended_sales.length, 1);
  assert.equal(body.secondary_sales.length, 1);
  assert.equal(body.competitive_sales.length, 1);
  assert.equal(body.sales.length, 1);
  assert.equal(body.statistical_analysis.available, true);
  assert.equal(body.study_market.label, "All eligible sales");

  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].parameters, ["A-1"]);
  assert.match(queries[1].sql, /sale\.record_type = 'closed_sale'/);
  assert.match(queries[1].sql, /location\.status = 'matched'/);
  assert.match(queries[1].sql, /distance_miles_sql/);
  assert.match(queries[1].sql, /candidate_influence\.material_categories &&/);
  assert.match(queries[1].sql, /LIMIT 10000/);
  assert.deepEqual(queries[1].parameters.slice(0, 3), [
    "A-1",
    "2025-09-03",
    "2026-09-02",
  ]);
  assert.deepEqual(queries[1].parameters.at(-1), ["highway"]);
  assert.deepEqual(queries[2].parameters, [["C-1"]]);

  const distanceCall = calls.find((call) => call.type === "distance");
  assert.match(distanceCall.input.subjectLatitude, /^\$\d+::double precision$/);
  assert.equal(distanceCall.input.comparableLatitude, "location.latitude::double precision");
  const scoreCall = calls.find((call) => call.type === "score");
  assert.equal(scoreCall.input.subjectSiteSize, 1500);
  assert.equal(scoreCall.input.comparableSiteSize, 8000);
  assert.equal(scoreCall.input.referenceDate, "2026-09-02");
  assert.equal(scoreCall.config.locationWeight, 0.4);
  assert.equal(candidateRow.manual_land_value, undefined);
  assert.equal(calls.find((call) => call.type === "filter").market, null);
  assert.deepEqual(calls.find((call) => call.type === "rank").signature, subjectSignature);
});

test("missing cached evidence is queued without delaying an empty recommendation response", async (context) => {
  const missingCandidate = candidate({
    primary_account_id: "C-2",
    location_status: "missing",
    latitude: null,
    longitude: null,
    candidate_influence_signature: null,
  });
  const influenceQueues = [];
  const locationQueues = [];
  const options = routerOptions({
    pool: {
      query: async (sql) => {
        if (sql.includes("FROM core.accounts account")) return { rows: [subject()] };
        if (sql.includes("FROM core.v_sales_enriched sale")) return { rows: [missingCandidate] };
        if (sql.includes("FROM core.land_detail land")) return { rows: [] };
        throw new Error("unexpected_query");
      },
    },
    loadInfluenceContexts: async () => new Map(),
    enqueueInfluences: async (...args) => { influenceQueues.push(args); },
    enqueueLocationBackfill: async (...args) => { locationQueues.push(args); },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).sales, []);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(influenceQueues, [
    [options.pool, ["A-1"], { reason: "comparable_subject", priority: 120 }],
    [options.pool, ["C-2"], { reason: "comparable_recommendation", priority: 110 }],
  ]);
  assert.deepEqual(locationQueues, [[
    options.pool,
    [{ account_id: "C-2", address: "200 Main Street", county: "Dallas" }],
    { reason: "comparable_recommendation", priority: 100 },
  ]]);
});

test("unexpected recommendation failures remain bounded and server-side", async (context) => {
  const failure = new Error("database_connection_failed");
  const logs = [];
  const options = routerOptions({
    pool: { query: async () => { throw failure; } },
    logger: { error: (...args) => logs.push(args), warn() {} },
  });
  const server = await startRouter(createComparableRecommendationsRouter(options));
  context.after(server.close);

  const response = await get(server.baseUrl, { subject_account_id: "A-1" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "comparable_recommendations_failed" });
  assert.deepEqual(logs, [["/api/sales/recommendations failed", failure]]);
});

test("recommendation composition is explicit and replaces the final inline route", () => {
  assert.throws(
    () => createComparableRecommendationsRouter(routerOptions({ pool: null })),
    /comparable_recommendations_pool_required/,
  );
  assert.throws(
    () => createComparableRecommendationsRouter(routerOptions({ accountIdAllowed: null })),
    /comparable_recommendations_account_policy_required/,
  );
  assert.throws(
    () => createComparableRecommendationsRouter(routerOptions({ locationsReady: null })),
    /comparable_recommendations_readiness_required/,
  );
  assert.throws(
    () => createComparableRecommendationsRouter(routerOptions({ distanceSqlBuilder: null })),
    /comparable_recommendations_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const propertySearch = source.indexOf("app.use(createPropertySearchRouter(");
  const recommendations = source.indexOf("app.use(createComparableRecommendationsRouter(");
  const salesList = source.indexOf("app.use(createSalesListRouter(");
  assert.ok(recommendations > propertySearch);
  assert.ok(salesList > recommendations);
  assert.match(
    source,
    /createComparableRecommendationsRouter\(\{[\s\S]*?accountIdAllowed: legacyAccountIdAllowed,[\s\S]*?locationsReady: accountLocationsReady,[\s\S]*?enrichmentReady: propertyEnrichmentReady,[\s\S]*?backfillReady: locationBackfillReady,[\s\S]*?distanceSqlBuilder: greatCircleDistanceMilesSql,[\s\S]*?requireCustomAccountScope,[\s\S]*?requirePropertyTaxAccountScope/,
  );
  assert.equal(source.includes('app.get("/api/sales/recommendations"'), false);
  assert.doesNotMatch(source, /app\.(get|post|put|patch|delete)\(/);
});
