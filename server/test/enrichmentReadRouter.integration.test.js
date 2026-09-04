import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createEnrichmentReadRouter } from "../src/modules/operations/enrichmentReadRouter.js";

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
    propertyEnrichmentReady: Promise.resolve(),
    trestleClient: { status: () => ({ configured: true, endpoint: "test" }) },
    getNonDallasAccount: async () => { throw new Error("unexpected_account_load"); },
    requirePlatformAdministrator: () => true,
    supportedCounties: ["Collin", "Denton"],
    getGisConfiguration: () => ({ configured: false }),
    getReplicationStatus: async () => { throw new Error("unexpected_replication_status"); },
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(createEnrichmentReadRouter(options));
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

test("enrichment status exposes only configured activation metadata", async (context) => {
  const database = createPool();
  const calls = [];
  const trestleRuntime = { configured: true, connected: false };
  const trestleStatus = { cursor: "2026-09-01", lag_seconds: 12 };
  const options = baseOptions(database, {
    trestleClient: { status: () => { calls.push({ type: "client-status" }); return trestleRuntime; } },
    getGisConfiguration(county) {
      calls.push({ type: "gis", county });
      return { configured: county === "Collin", secret_url: "must-not-leak" };
    },
    getReplicationStatus: async (pool, runtime) => {
      calls.push({ type: "replication", pool, runtime });
      return trestleStatus;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/enrichment/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    dallas_county_isolated: true,
    supported_counties: ["Collin", "Denton"],
    trestle: trestleStatus,
    gis: { Collin: { configured: true }, Denton: { configured: false } },
    resolution_order: ["manual_verified", "trestle", "cad", "manual_review"],
  });
  assert.deepEqual(calls, [
    { type: "gis", county: "Collin" },
    { type: "gis", county: "Denton" },
    { type: "client-status" },
    { type: "replication", pool: options.pool, runtime: trestleRuntime },
  ]);
});

test("enrichment status failures remain bounded and diagnostic-safe", async (context) => {
  const database = createPool();
  const diagnostic = new Error("trestle internal secret-token");
  const logs = [];
  const server = await startRouter(baseOptions(database, {
    getReplicationStatus: async () => { throw diagnostic; },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/enrichment/status`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "enrichment_status_failed" });
  assert.deepEqual(logs, [["enrichment status failed", diagnostic]]);
});

test("account enrichment validates identifiers before readiness and account lookup", async (context) => {
  const database = createPool(async () => { throw new Error("unexpected_query"); });
  let accountCalls = 0;
  const server = await startRouter(baseOptions(database, {
    getNonDallasAccount: async () => { accountCalls += 1; return null; },
  }));
  context.after(server.close);

  const invalid = await fetch(`${server.baseUrl}/api/accounts/bad%20id/enrichment`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_account_id" });
  assert.equal(accountCalls, 0);
  const missing = await fetch(`${server.baseUrl}/api/accounts/A-1/enrichment`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "account_not_found" });
  assert.equal(accountCalls, 1);
  assert.equal(database.queries.length, 0);
});

test("account enrichment denies non-administrators before account or database access", async (context) => {
  const database = createPool(async () => { throw new Error("unexpected_query"); });
  let accountCalls = 0;
  let authorizationCalls = 0;
  const server = await startRouter(baseOptions(database, {
    requirePlatformAdministrator(_req, res) {
      authorizationCalls += 1;
      res.set("cache-control", "no-store")
        .status(403)
        .json({ error: "application_access_denied" });
      return false;
    },
    getNonDallasAccount: async () => { accountCalls += 1; return null; },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/enrichment`);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "application_access_denied" });
  assert.equal(authorizationCalls, 1);
  assert.equal(accountCalls, 0);
  assert.equal(database.queries.length, 0);
});

test("account enrichment loads manual values, review flags, and GIS suggestions in parallel", async (context) => {
  const manualValues = [{ attribute_key: "living_area", revision: 2 }];
  const reviewQueue = [{ attribute_key: "year_built", status: "open" }];
  const suggestions = [{ id: 7, area_square_feet: 9000, status: "pending" }];
  const database = createPool(async (sql) => {
    if (sql.includes("property_attribute_manual_values")) return { rows: manualValues };
    if (sql.includes("enrichment_review_queue")) return { rows: reviewQueue };
    if (sql.includes("parcel_geometry_suggestions")) return { rows: suggestions };
    throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
  });
  const account = { account_id: "A-1", county: "Collin", normalized_county: "Collin" };
  const options = baseOptions(database, {
    getNonDallasAccount: async (pool, id) => {
      assert.equal(pool, database.pool);
      assert.equal(id, "A-1");
      return account;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/A-1/enrichment`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "A-1",
    county: "Collin",
    manual_values: manualValues,
    review_queue: reviewQueue,
    parcel_area_suggestions: suggestions,
  });
  assert.equal(database.queries.length, 3);
  assert.ok(database.queries.every(({ params }) => params.length === 1 && params[0] === "A-1"));
  assert.ok(database.queries.some(({ sql }) => sql.includes("ORDER BY created_at DESC LIMIT 10")));
});

test("Dallas isolation and database failures preserve distinct account responses", async (context) => {
  const isolatedDatabase = createPool();
  const failedDatabase = createPool(async () => { throw new Error("database unavailable"); });
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const isolated = await startRouter(baseOptions(isolatedDatabase, {
    getNonDallasAccount: async () => { throw new Error("dallas_enrichment_isolated"); },
  }));
  const failed = await startRouter(baseOptions(failedDatabase, {
    getNonDallasAccount: async () => ({ normalized_county: "Collin" }),
    logger: { error: (...args) => logs.push(args) },
  }));
  failedDatabase.pool.query = async () => { throw diagnostic; };
  context.after(async () => Promise.all([isolated.close(), failed.close()]));

  const isolatedResponse = await fetch(`${isolated.baseUrl}/api/accounts/A-1/enrichment`);
  assert.equal(isolatedResponse.status, 409);
  assert.deepEqual(await isolatedResponse.json(), { error: "dallas_enrichment_isolated" });
  const failedResponse = await fetch(`${failed.baseUrl}/api/accounts/A-1/enrichment`);
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), { error: "account_enrichment_failed" });
  assert.deepEqual(logs, [["account enrichment load failed", diagnostic]]);
});

test("enrichment read composition is explicit and inline routes are absent", () => {
  const database = createPool();
  assert.throws(
    () => createEnrichmentReadRouter(baseOptions(database, { pool: null })),
    /enrichment_read_pool_required/,
  );
  assert.throws(
    () => createEnrichmentReadRouter(baseOptions(database, { trestleClient: null })),
    /enrichment_read_trestle_client_required/,
  );
  assert.throws(
    () => createEnrichmentReadRouter(baseOptions(database, { getNonDallasAccount: null })),
    /enrichment_read_dependency_required/,
  );
  assert.throws(
    () => createEnrichmentReadRouter(baseOptions(database, { requirePlatformAdministrator: null })),
    /enrichment_read_admin_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const ratings = source.indexOf("app.use(createAppraisalRatingsRouter(");
  const enrichment = source.indexOf("app.use(createEnrichmentReadRouter(");
  const verifiedWrite = source.indexOf("app.use(createEnrichmentMutationRouter(");
  assert.ok(enrichment > ratings);
  assert.ok(verifiedWrite > enrichment);
  assert.match(
    source,
    /createEnrichmentReadRouter\(\{[\s\S]*?requirePlatformAdministrator,[\s\S]*?\}\)\)/,
  );
  assert.equal(source.includes('app.get("/api/enrichment/status"'), false);
  assert.equal(source.includes('app.get("/api/accounts/:id/enrichment"'), false);
});
