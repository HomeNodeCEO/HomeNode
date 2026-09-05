import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createAccountPropertyContextRouter,
  createPropertyContextStatusRouter,
} from "../src/modules/accounts/propertyContextRouter.js";

const pool = { query: async () => ({ rows: [] }) };

async function startRouter(router, { mobileAuth = {
  userId: "appraiser-1",
  displayName: "Authenticated Appraiser",
} } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (mobileAuth) req.mobileAuth = mobileAuth;
    next();
  });
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
    requireWorkflowAccess: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
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
    requirePlatformAdministrator: () => true,
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
    requirePlatformAdministrator: () => true,
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/property-context/status`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "property_context_status_failed" });
  assert.deepEqual(logs, [["/api/property-context/status failed", failure]]);
});

test("property-context status is administrator-only before readiness work", async (context) => {
  let readinessCalls = 0;
  const server = await startRouter(createPropertyContextStatusRouter({
    pool,
    ensureAvailable: async () => { readinessCalls += 1; },
    requirePlatformAdministrator: (_req, res) => {
      res.status(403).json({ error: "application_access_denied" });
      return false;
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/property-context/status`);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "application_access_denied" });
  assert.equal(readinessCalls, 0);
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
    ["normalize", "7"],
    "ensure",
    ["resolve", pool, "42"],
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
    review: { ...review, reviewer: "Authenticated Appraiser" },
  }]]);
});

test("enforced property-context routes require an authorized assignment for each operation", async (context) => {
  const accessCalls = [];
  const workflowCalls = [];
  const serviceCalls = [];
  const mobileAuth = {
    userId: "appraiser-1",
    email: "appraiser@example.test",
    displayName: "Authenticated Appraiser",
  };
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    authenticationRequired: true,
    requireWorkflowAccess: (_req, _res, workflow, permission) => {
      workflowCalls.push({ workflow, permission });
      return true;
    },
    requireAssignmentAccess: async (
      _req,
      _res,
      accountId,
      assignmentFileId,
      permission,
    ) => {
      accessCalls.push({ accountId, assignmentFileId, permission });
      return true;
    },
    getStoredContext: async () => { serviceCalls.push("read"); return { id: 1 }; },
    analyzeContext: async () => { serviceCalls.push("analyze"); return { id: 2 }; },
    saveContextReview: async (_pool, input) => {
      serviceCalls.push(["review", input.review]);
      return { id: 3 };
    },
  })), { mobileAuth });
  context.after(server.close);

  const read = await fetch(
    `${server.baseUrl}/api/accounts/42/property-context?assignment_file_id=7`,
  );
  const analyze = await fetch(`${server.baseUrl}/api/accounts/42/property-context/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: "7" }),
  });
  const review = await fetch(`${server.baseUrl}/api/accounts/42/property-context`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assignment_file_id: "7",
      complexity: "moderate",
      reviewer: "Spoofed Reviewer",
    }),
  });
  assert.equal(read.status, 200);
  assert.equal(analyze.status, 200);
  assert.equal(review.status, 200);
  assert.deepEqual(workflowCalls, [
    { workflow: "custom_appraisal", permission: "read" },
    { workflow: "custom_appraisal", permission: "write" },
    { workflow: "custom_appraisal", permission: "sign" },
  ]);
  assert.deepEqual(accessCalls, [
    { accountId: "canonical-42", assignmentFileId: "file-7", permission: "read" },
    { accountId: "canonical-42", assignmentFileId: "file-7", permission: "write" },
    { accountId: "canonical-42", assignmentFileId: "file-7", permission: "sign" },
  ]);
  assert.deepEqual(serviceCalls, [
    "read",
    "analyze",
    ["review", {
      assignment_file_id: "7",
      complexity: "moderate",
      reviewer: "Authenticated Appraiser",
    }],
  ]);
});

test("enforced property-context rejects missing assignment scope before readiness or services", async (context) => {
  let readinessCalls = 0;
  let serviceCalls = 0;
  const server = await startRouter(createAccountPropertyContextRouter(accountOptions({
    authenticationRequired: true,
    ensureAvailable: async () => { readinessCalls += 1; },
    getStoredContext: async () => { serviceCalls += 1; },
    analyzeContext: async () => { serviceCalls += 1; },
    saveContextReview: async () => { serviceCalls += 1; },
  })));
  context.after(server.close);

  const requests = [
    fetch(`${server.baseUrl}/api/accounts/42/property-context`),
    fetch(`${server.baseUrl}/api/accounts/42/property-context/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    fetch(`${server.baseUrl}/api/accounts/42/property-context`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  ];
  const responses = await Promise.all(requests);
  for (const response of responses) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "assignment_file_required" });
  }
  assert.equal(readinessCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("property-context stops after workflow or assignment denial", async (context) => {
  let resolutionCalls = 0;
  let serviceCalls = 0;
  const workflowDenied = await startRouter(createAccountPropertyContextRouter(accountOptions({
    requireWorkflowAccess: (_req, res) => {
      res.status(403).json({ error: "workflow_forbidden" });
      return false;
    },
    resolveAccountId: async () => { resolutionCalls += 1; },
  })));
  context.after(workflowDenied.close);
  const workflowResponse = await fetch(
    `${workflowDenied.baseUrl}/api/accounts/42/property-context?assignment_file_id=7`,
  );
  assert.equal(workflowResponse.status, 403);
  assert.equal(resolutionCalls, 0);

  const assignmentDenied = await startRouter(createAccountPropertyContextRouter(accountOptions({
    requireAssignmentAccess: async (_req, res) => {
      res.status(403).json({ error: "assignment_forbidden" });
      return false;
    },
    getStoredContext: async () => { serviceCalls += 1; },
  })));
  context.after(assignmentDenied.close);
  const assignmentResponse = await fetch(
    `${assignmentDenied.baseUrl}/api/accounts/42/property-context?assignment_file_id=7`,
  );
  assert.equal(assignmentResponse.status, 403);
  assert.equal(serviceCalls, 0);
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

  const read = await fetch(
    `${server.baseUrl}/api/accounts/missing/property-context?assignment_file_id=7`,
  );
  assert.equal(read.status, 404);
  assert.deepEqual(await read.json(), { error: "account_not_found" });

  const analyze = await fetch(`${server.baseUrl}/api/accounts/missing/property-context/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: 7 }),
  });
  assert.equal(analyze.status, 404);
  assert.deepEqual(await analyze.json(), { error: "account_not_found" });

  const review = await fetch(`${server.baseUrl}/api/accounts/missing/property-context`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: 7 }),
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
  assert.throws(
    () => createAccountPropertyContextRouter(accountOptions({ authenticationRequired: undefined })),
    /account_property_context_authentication_mode_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const landUse = source.indexOf("app.use(createNeighborhoodAnalysisRouter(");
  const status = source.indexOf("app.use(createPropertyContextStatusRouter(");
  const neighborhood = source.indexOf("app.use(createNeighborhoodRouter(");
  const accountContext = source.indexOf("app.use(createAccountPropertyContextRouter(");
  const zoning = source.indexOf("app.use(createZoningRouter(");
  assert.ok(landUse > 0);
  assert.ok(status > landUse);
  assert.ok(neighborhood > status);
  assert.ok(accountContext > neighborhood);
  assert.ok(zoning > accountContext);
  assert.equal(source.includes('app.get("/api/property-context/status"'), false);
  assert.equal(source.includes('app.get("/api/accounts/:id/property-context"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/property-context/analyze"'), false);
  assert.equal(source.includes('app.patch("/api/accounts/:id/property-context"'), false);
});
