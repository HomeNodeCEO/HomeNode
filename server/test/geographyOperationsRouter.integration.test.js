import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createGeographyOperationsRouter } from "../src/modules/operations/geographyRouter.js";

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    locationBackfillReady: Promise.resolve(),
    censusGeographyReady: Promise.resolve(),
    accountQualityReady: Promise.resolve(),
    requireEditor: () => true,
    ensureLocationSchema: async () => {},
    getLocationStatus: async () => { throw new Error("unexpected_location_status"); },
    seedLocationQueue: async () => { throw new Error("unexpected_location_seed"); },
    runLocationBatch: async () => { throw new Error("unexpected_location_run"); },
    ensureCensusSchema: async () => {},
    getCensusStatus: async () => { throw new Error("unexpected_census_status"); },
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    lookupAccountCensus: async () => { throw new Error("unexpected_census_lookup"); },
    getZipProfile: async () => { throw new Error("unexpected_zip_profile"); },
    getCityProfile: async () => { throw new Error("unexpected_city_profile"); },
    seedCensusQueue: async () => { throw new Error("unexpected_census_seed"); },
    runCensusBatch: async () => { throw new Error("unexpected_census_run"); },
    getLocationMaximumAttempts: () => "5",
    getCensusMaximumAttempts: () => "7",
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createGeographyOperationsRouter(options));
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

function postJson(url, body = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("location and census status routes ensure schemas before loading status", async (context) => {
  const calls = [];
  const locationStatus = { queued: 3, complete: 90 };
  const censusStatus = { queued: 2, mapped: 120 };
  const options = baseOptions({
    ensureLocationSchema: async (pool) => { calls.push({ type: "location-schema", pool }); },
    getLocationStatus: async (pool) => { calls.push({ type: "location-status", pool }); return locationStatus; },
    ensureCensusSchema: async (pool) => { calls.push({ type: "census-schema", pool }); },
    getCensusStatus: async (pool) => { calls.push({ type: "census-status", pool }); return censusStatus; },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const location = await fetch(`${server.baseUrl}/api/location-backfill/status`);
  assert.equal(location.status, 200);
  assert.deepEqual(await location.json(), locationStatus);
  const census = await fetch(`${server.baseUrl}/api/census-geography/status`);
  assert.equal(census.status, 200);
  assert.deepEqual(await census.json(), censusStatus);
  assert.deepEqual(calls.map(({ type }) => type), [
    "location-schema", "location-status", "census-schema", "census-status",
  ]);
  assert.ok(calls.every(({ pool }) => pool === options.pool));
});

test("location maintenance remains editor-gated and preserves queue controls", async (context) => {
  const calls = [];
  let deniedSeedCalls = 0;
  const options = baseOptions({
    ensureLocationSchema: async (pool) => { calls.push({ type: "schema", pool }); },
    seedLocationQueue: async (pool, input) => {
      calls.push({ type: "seed", pool, input });
      return { seeded: 11 };
    },
    runLocationBatch: async (pool, input) => {
      calls.push({ type: "run", pool, input });
      return { processed: 4 };
    },
    getLocationMaximumAttempts: () => "9",
  });
  const accepted = await startRouter(options);
  const denied = await startRouter(baseOptions({
    requireEditor(_req, res) {
      res.status(403).json({ error: "editor_required" });
      return false;
    },
    seedLocationQueue: async () => { deniedSeedCalls += 1; },
  }));
  context.after(async () => Promise.all([accepted.close(), denied.close()]));

  const deniedResponse = await postJson(`${denied.baseUrl}/api/location-backfill/run`, {});
  assert.equal(deniedResponse.status, 403);
  assert.equal(deniedSeedCalls, 0);
  const response = await postJson(`${accepted.baseUrl}/api/location-backfill/run`, {
    seed_limit: 25,
    batch_size: 6,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, seed: { seeded: 11 }, result: { processed: 4 },
  });
  assert.deepEqual(calls, [
    { type: "schema", pool: options.pool },
    { type: "seed", pool: options.pool, input: { limit: 25 } },
    {
      type: "run",
      pool: options.pool,
      input: { batchSize: 6, maximumAttempts: "9" },
    },
  ]);
});

test("census maintenance remains editor-gated and preserves queue controls", async (context) => {
  const calls = [];
  const options = baseOptions({
    ensureCensusSchema: async (pool) => { calls.push({ type: "schema", pool }); },
    seedCensusQueue: async (pool, input) => {
      calls.push({ type: "seed", pool, input });
      return { seeded: 8 };
    },
    runCensusBatch: async (pool, input) => {
      calls.push({ type: "run", pool, input });
      return { processed: 5 };
    },
    getCensusMaximumAttempts: () => "12",
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await postJson(`${server.baseUrl}/api/census-geography/run`, {
    seed_limit: 30,
    batch_size: 7,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, seed: { seeded: 8 }, result: { processed: 5 },
  });
  assert.deepEqual(calls, [
    { type: "schema", pool: options.pool },
    { type: "seed", pool: options.pool, input: { limit: 30 } },
    {
      type: "run",
      pool: options.pool,
      input: { batchSize: 7, maximumAttempts: "12" },
    },
  ]);
});

test("on-demand census lookup validates before editor and binds the canonical account", async (context) => {
  const calls = [];
  let editorCalls = 0;
  const geography = { tract_geoid: "48113000100", source: "census" };
  const options = baseOptions({
    requireEditor: () => { editorCalls += 1; return true; },
    resolveAccountId: async (pool, value) => {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    lookupAccountCensus: async (pool, accountId) => {
      calls.push({ type: "lookup", pool, accountId });
      return geography;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const invalid = await postJson(
    `${server.baseUrl}/api/accounts/bad%20id/census-geography/lookup`,
  );
  assert.equal(invalid.status, 400);
  assert.equal(editorCalls, 0);
  const response = await postJson(
    `${server.baseUrl}/api/accounts/account_1/census-geography/lookup`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, account_id: "CANONICAL_1", census_geography: geography,
  });
  assert.equal(editorCalls, 1);
  assert.deepEqual(calls, [
    { type: "resolve", pool: options.pool, value: "account_1" },
    { type: "lookup", pool: options.pool, accountId: "CANONICAL_1" },
  ]);
});

test("on-demand census lookup retains absence, missing-input, and bounded upstream errors", async (context) => {
  const diagnostic = new Error("census upstream secret-token");
  const cases = [
    { error: Object.assign(new Error("missing"), { code: "account_not_found" }), status: 404, body: { error: "account_not_found" } },
    { error: new Error("census_lookup_input_missing"), status: 422, body: { error: "census_lookup_input_missing" } },
    { error: diagnostic, status: 502, body: { error: "census_geography_lookup_failed" } },
  ];
  const logs = [];
  const running = [];
  for (const item of cases) {
    const server = await startRouter(baseOptions({
      lookupAccountCensus: async () => { throw item.error; },
      logger: { error: (...args) => logs.push(args) },
    }));
    running.push({ ...item, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await postJson(
      `${item.server.baseUrl}/api/accounts/A-1/census-geography/lookup`,
    );
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), item.body);
  }
  assert.deepEqual(logs, [["on-demand census geography lookup failed", diagnostic]]);
});

test("ZIP and city profile routes preserve request arguments and upstream status codes", async (context) => {
  const calls = [];
  const logs = [];
  const accepted = await startRouter(baseOptions({
    getZipProfile: async (postalCode) => { calls.push({ type: "zip", postalCode }); return { postal_code: postalCode }; },
    getCityProfile: async (city, state) => { calls.push({ type: "city", city, state }); return { city, state }; },
  }));
  const clientError = Object.assign(new Error("invalid_postal_code"), { status: 400 });
  const failed = await startRouter(baseOptions({
    getZipProfile: async () => { throw clientError; },
    getCityProfile: async () => { throw Object.assign(new Error("acs_unavailable"), { status: 503 }); },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(async () => Promise.all([accepted.close(), failed.close()]));

  const zip = await fetch(`${accepted.baseUrl}/api/census/zip-profile/75201`);
  assert.equal(zip.status, 200);
  assert.deepEqual(await zip.json(), { postal_code: "75201" });
  const city = await fetch(`${accepted.baseUrl}/api/census/city-profile?city=Dallas&state=TX`);
  assert.equal(city.status, 200);
  assert.deepEqual(await city.json(), { city: "Dallas", state: "TX" });
  assert.deepEqual(calls, [
    { type: "zip", postalCode: "75201" },
    { type: "city", city: "Dallas", state: "TX" },
  ]);
  const invalid = await fetch(`${failed.baseUrl}/api/census/zip-profile/bad`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_postal_code" });
  const unavailable = await fetch(`${failed.baseUrl}/api/census/city-profile?city=Dallas&state=TX`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "acs_unavailable" });
  assert.deepEqual(logs, [["Census city profile lookup failed", "acs_unavailable"]]);
});

test("status and maintenance diagnostics remain server-side with stable failures", async (context) => {
  const diagnostic = new Error("queue db.internal secret-token");
  const logs = [];
  const server = await startRouter(baseOptions({
    getLocationStatus: async () => { throw diagnostic; },
    seedCensusQueue: async () => { throw diagnostic; },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const status = await fetch(`${server.baseUrl}/api/location-backfill/status`);
  assert.equal(status.status, 500);
  assert.deepEqual(await status.json(), { error: "location_backfill_status_failed" });
  const run = await postJson(`${server.baseUrl}/api/census-geography/run`, {});
  assert.equal(run.status, 500);
  assert.deepEqual(await run.json(), { error: "census_geography_run_failed" });
  assert.deepEqual(logs, [
    ["location backfill status failed", diagnostic],
    ["census geography maintenance run failed", diagnostic],
  ]);
});

test("geography operations composition is explicit and inline routes are absent", () => {
  assert.throws(
    () => createGeographyOperationsRouter(baseOptions({ pool: null })),
    /geography_operations_pool_required/,
  );
  assert.throws(
    () => createGeographyOperationsRouter(baseOptions({ censusGeographyReady: null })),
    /geography_operations_census_readiness_required/,
  );
  assert.throws(
    () => createGeographyOperationsRouter(baseOptions({ requireEditor: null })),
    /geography_operations_editor_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const workfiles = source.indexOf("app.use(createAssignmentWorkfileMutationRouter(");
  const geography = source.indexOf("app.use(createGeographyOperationsRouter(");
  const reconciliation = source.indexOf('app.get("/api/sales/reconciliation-queue"');
  assert.ok(geography > workfiles);
  assert.ok(reconciliation > geography);
  for (const route of [
    "/api/location-backfill/status",
    "/api/location-backfill/run",
    "/api/census-geography/status",
    "/api/accounts/:id/census-geography/lookup",
    "/api/census/zip-profile/:postalCode",
    "/api/census/city-profile",
    "/api/census-geography/run",
  ]) assert.equal(source.includes(route), false);
});
