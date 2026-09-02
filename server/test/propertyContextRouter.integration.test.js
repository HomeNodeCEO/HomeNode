import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createAccountPropertyContextRouter,
  createPropertyContextStatusRouter,
} from "../src/modules/accounts/propertyContextRouter.js";

const pool = { query: async () => ({ rows: [] }) };

async function startRouter(router) {
  const app = express();
  app.use(express.json());
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

function accountOptions(overrides = {}) {
  return {
    pool,
    ensureAvailable: async () => {},
    resolveAccountId: async (_pool, accountId) => `canonical-${accountId}`,
    normalizeFileId: (value) => value ? `file-${value}` : null,
    getStoredContext: async () => null,
    analyzeContext: async () => null,
    saveContextReview: async () => null,
    errorStatus: () => 500,
    logger: { error() {} },
    ...overrides,
  };
}

test("property-context status waits for schema readiness and returns mirror status", async (context) => {
  const calls = [];
  const status = { ready: true, sources: 4 };
  const server = await startRouter(createPropertyContextStatusRouter({
    pool,
    ensureAvailable: async () => { calls.push("ensure"); },
    getStatus: async (receivedPool) => {
      assert.equal(receivedPool, pool);
      calls.push("status");
      return status;
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/property-context/status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), status);
  assert.deepEqual(calls, ["ensure", "status"]);
});

test("property-context status keeps failures bounded and server-side", async (context) => {
  const failure = new Error("schema_diagnostic");
  const logs = [];
  const server = await startRouter(createPropertyContextStatusRouter({
    pool,
    ensureAvailable: async () => { throw failure; },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/property-context/status`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "property_context_status_failed" });
  assert.deepEqual(logs, [["/api/property-context/status failed", failure]]);
});

test("stored property context preserves canonical account and assignment scope", async (context) => {
  const calls = [];
  const assessment = { assessment_id: "assessment-1" };
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    ensureAvailable: async () => { calls.push("ensure"); },
    resolveAccountId: async (receivedPool, requestedId) => {
      calls.push(["resolve", receivedPool, requestedId]);
      return "canonical-42";
    },
    normalizeFileId: (value) => {
      calls.push(["normalize", value]);
      return "file-7";
    },
    getStoredContext: async (receivedPool, input) => {
      calls.push(["load", receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/%2042%20/property-context?assignment_file_id=7`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(calls, [
    "ensure",
    ["resolve", pool, "42"],
    ["normalize", "7"],
    ["load", pool, { accountId: "canonical-42", assignmentFileId: "file-7" }],
  ]);
});

test("property-context analysis preserves optional geometry and geography", async (context) => {
  const inputs = [];
  const assessment = { complexity: "complex" };
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    analyzeContext: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/property-context/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assignment_file_id: "7",
      custom_geometry: { type: "Polygon", coordinates: [] },
      geography: { city: "Duncanville" },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    customGeometry: { type: "Polygon", coordinates: [] },
    geography: { city: "Duncanville" },
  }]]);
});

test("property-context review passes the complete appraiser body unchanged", async (context) => {
  const inputs = [];
  const review = {
    assignment_file_id: "7",
    confirmed: true,
    notes: "Reviewed against local evidence",
  };
  const assessment = { review_status: "confirmed" };
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    saveContextReview: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return assessment;
    },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/property-context`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(review),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "canonical-42",
    assessment,
  });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    review,
  }]]);
});

test("account property-context routes preserve error mapping and logging", async (context) => {
  const failure = new Error("account_not_found");
  const logs = [];
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    resolveAccountId: async () => { throw failure; },
    errorStatus: (message) => message === "account_not_found" ? 404 : 500,
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const read = await fetch(`${server.baseUrl}/api/accounts/missing/property-context`);
  assert.equal(read.status, 404);
  assert.deepEqual(await read.json(), { error: "account_not_found" });

  const analyze = await fetch(`${server.baseUrl}/api/accounts/missing/property-context/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(analyze.status, 404);
  assert.deepEqual(await analyze.json(), { error: "account_not_found" });

  const review = await fetch(`${server.baseUrl}/api/accounts/missing/property-context`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(review.status, 404);
  assert.deepEqual(await review.json(), { error: "account_not_found" });
  assert.deepEqual(logs, [
    ["/api/accounts/:id/property-context/analyze failed", failure],
    ["/api/accounts/:id/property-context review failed", failure],
  ]);
});

test("property-context routers validate composition and retain both mount positions", () => {
  assert.throws(() => createPropertyContextStatusRouter(), /property_context_pool_required/);
  assert.throws(
    () => createPropertyContextStatusRouter({ pool }),
    /property_context_status_dependency_required/,
  );
  assert.throws(
    () => createAccountPropertyContextRouter({
      pool,
      ensureAvailable: async () => {},
      resolveAccountId: null,
    }),
    /account_property_context_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const landUse = source.indexOf('app.post("/api/sales/neighborhood-land-use"');
  const status = source.indexOf("app.use(createPropertyContextStatusRouter(");
  const readiness = source.indexOf('app.get("/api/neighborhood-engine/readiness"');
  const relevance = source.indexOf('app.post("/api/accounts/:id/neighborhood-relevance/generate"');
  const accountContext = source.indexOf("app.use(createAccountPropertyContextRouter(");
  const zoning = source.indexOf("app.use(createZoningRouter(");
  assert.ok(landUse > 0);
  assert.ok(status > landUse);
  assert.ok(readiness > status);
  assert.ok(relevance > readiness);
  assert.ok(accountContext > relevance);
  assert.ok(zoning > accountContext);
  assert.equal(source.includes('app.get("/api/property-context/status"'), false);
  assert.equal(source.includes('app.get("/api/accounts/:id/property-context"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/property-context/analyze"'), false);
  assert.equal(source.includes('app.patch("/api/accounts/:id/property-context"'), false);
});
