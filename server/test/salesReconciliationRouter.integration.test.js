import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createSalesReconciliationRouter } from "../src/modules/operations/salesReconciliationRouter.js";

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    salesReconciliationReady: Promise.resolve(),
    locationBackfillReady: Promise.resolve(),
    requireEditor: () => true,
    ensurePropertyContextAvailable: async () => {},
    listQueue: async () => { throw new Error("unexpected_reconciliation_queue"); },
    reconcileSourceRecord: async () => { throw new Error("unexpected_reconciliation"); },
    ensureLocationSchema: async () => {},
    enqueueLocationAccounts: async () => {},
    enqueueInfluenceAccounts: async () => {},
    logger: { error() {}, warn() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createSalesReconciliationRouter(options));
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

function reconcile(baseUrl, sourceRecordId, body = {}) {
  return fetch(`${baseUrl}/api/sales/${sourceRecordId}/reconcile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const successfulResult = Object.freeze({
  account: {
    account_id: "ACCOUNT_1",
    address: "123 Main St",
    county: "Dallas",
  },
  sale: { id: 71, source_record_id: 55 },
});

test("reconciliation queue forwards pagination and returns the service response", async (context) => {
  const calls = [];
  const queue = { rows: [{ source_record_id: 55 }], total: 1 };
  const options = baseOptions({
    listQueue: async (pool, input) => { calls.push({ pool, input }); return queue; },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/sales/reconciliation-queue?limit=25&offset=50`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), queue);
  assert.deepEqual(calls, [{ pool: options.pool, input: { limit: "25", offset: "50" } }]);
});

test("reconciliation remains editor-gated before the primary write service", async (context) => {
  let reconcileCalls = 0;
  const server = await startRouter(baseOptions({
    requireEditor(_req, res) {
      res.status(403).json({ error: "editor_required" });
      return false;
    },
    reconcileSourceRecord: async () => { reconcileCalls += 1; },
  }));
  context.after(server.close);

  const response = await reconcile(server.baseUrl, 55, { account_id: "ACCOUNT_1" });
  assert.equal(response.status, 403);
  assert.equal(reconcileCalls, 0);
});

test("successful reconciliation preserves primary input and both durable queue requests", async (context) => {
  const calls = [];
  const requestBody = { account_id: "ACCOUNT_1", reviewer: "Reviewer" };
  const options = baseOptions({
    reconcileSourceRecord: async (pool, sourceRecordId, body) => {
      calls.push({ type: "reconcile", pool, sourceRecordId, body });
      return successfulResult;
    },
    ensureLocationSchema: async (pool) => { calls.push({ type: "location-schema", pool }); },
    enqueueLocationAccounts: async (pool, accounts, settings) => {
      calls.push({ type: "location", pool, accounts, settings });
    },
    ensurePropertyContextAvailable: async () => { calls.push({ type: "context-schema" }); },
    enqueueInfluenceAccounts: async (pool, accountIds, settings) => {
      calls.push({ type: "influence", pool, accountIds, settings });
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await reconcile(server.baseUrl, 55, requestBody);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ...successfulResult });
  assert.deepEqual(calls, [
    {
      type: "reconcile",
      pool: options.pool,
      sourceRecordId: "55",
      body: requestBody,
    },
    { type: "location-schema", pool: options.pool },
    {
      type: "location",
      pool: options.pool,
      accounts: [{ account_id: "ACCOUNT_1", address: "123 Main St", county: "Dallas" }],
      settings: { reason: "sales_reconciliation", priority: 200 },
    },
    { type: "context-schema" },
    {
      type: "influence",
      pool: options.pool,
      accountIds: ["ACCOUNT_1"],
      settings: { reason: "sales_reconciliation", priority: 200 },
    },
  ]);
});

test("location queue failure is soft and does not suppress influence queueing", async (context) => {
  const locationError = new Error("location queue unavailable");
  const warnings = [];
  let influenceCalls = 0;
  const server = await startRouter(baseOptions({
    reconcileSourceRecord: async () => successfulResult,
    ensureLocationSchema: async () => { throw locationError; },
    enqueueInfluenceAccounts: async () => { influenceCalls += 1; },
    logger: { error() {}, warn: (...args) => warnings.push(args) },
  }));
  context.after(server.close);

  const response = await reconcile(server.baseUrl, 55, {});
  assert.equal(response.status, 200);
  assert.equal(influenceCalls, 1);
  assert.deepEqual(warnings, [[
    "manual sale link saved; location queueing deferred",
    "location queue unavailable",
  ]]);
});

test("influence queue failure is soft after the confirmed sale and location queue", async (context) => {
  const influenceError = new Error("influence queue unavailable");
  const warnings = [];
  let locationCalls = 0;
  const server = await startRouter(baseOptions({
    reconcileSourceRecord: async () => successfulResult,
    enqueueLocationAccounts: async () => { locationCalls += 1; },
    ensurePropertyContextAvailable: async () => { throw influenceError; },
    logger: { error() {}, warn: (...args) => warnings.push(args) },
  }));
  context.after(server.close);

  const response = await reconcile(server.baseUrl, 55, {});
  assert.equal(response.status, 200);
  assert.equal(locationCalls, 1);
  assert.deepEqual(warnings, [[
    "manual sale link saved; influence queueing deferred",
    "influence queue unavailable",
  ]]);
});

test("reconciliation errors retain not-found, conflict, validation, and bounded diagnostics", async (context) => {
  const diagnostic = new Error("database db.internal secret-token");
  const cases = [
    { message: "source_record_not_found", status: 404 },
    { message: "account_not_found", status: 404 },
    { message: "ambiguous_collin_account_id", status: 409 },
    { message: "county_account_identifier_conflict", status: 409 },
    { message: "invalid_account_identifier", status: 400 },
    { message: "source_record_not_closed_sale", status: 400 },
    { message: "account_county_mismatch", status: 400 },
    { message: "account_identifier_mismatch", status: 400 },
    { error: diagnostic, message: diagnostic.message, status: 500 },
  ];
  const errors = [];
  const running = [];
  for (const item of cases) {
    const error = item.error || new Error(item.message);
    const server = await startRouter(baseOptions({
      reconcileSourceRecord: async () => { throw error; },
      logger: { warn() {}, error: (...args) => errors.push(args) },
    }));
    running.push({ ...item, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await reconcile(item.server.baseUrl, 55, {});
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), { error: item.message });
  }
  assert.deepEqual(errors, [["sales reconciliation failed", diagnostic]]);
});

test("queue failures and reconciliation diagnostics use stable response codes", async (context) => {
  const diagnostic = new Error("queue db.internal secret-token");
  const errors = [];
  const server = await startRouter(baseOptions({
    listQueue: async () => { throw diagnostic; },
    logger: { warn() {}, error: (...args) => errors.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/sales/reconciliation-queue`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "sales_reconciliation_queue_failed" });
  assert.deepEqual(errors, [["sales reconciliation queue failed", diagnostic]]);
});

test("sales reconciliation composition is explicit and inline handlers are absent", () => {
  assert.throws(
    () => createSalesReconciliationRouter(baseOptions({ pool: null })),
    /sales_reconciliation_pool_required/,
  );
  assert.throws(
    () => createSalesReconciliationRouter(baseOptions({ requireEditor: null })),
    /sales_reconciliation_editor_policy_required/,
  );
  assert.throws(
    () => createSalesReconciliationRouter(baseOptions({ ensurePropertyContextAvailable: null })),
    /sales_reconciliation_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const geography = source.indexOf("app.use(createGeographyOperationsRouter(");
  const reconciliation = source.indexOf("app.use(createSalesReconciliationRouter(");
  const reviews = source.indexOf("app.use(createSaleReviewRouter(");
  assert.ok(reconciliation > geography);
  assert.ok(reviews > reconciliation);
  assert.equal(source.includes('app.get("/api/sales/reconciliation-queue"'), false);
  assert.equal(source.includes('app.patch("/api/sales/:sourceRecordId/reconcile"'), false);
});
