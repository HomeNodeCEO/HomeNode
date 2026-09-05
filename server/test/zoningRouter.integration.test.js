import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createZoningRouter } from "../src/modules/accounts/zoningRouter.js";

const pool = { query: async () => ({ rows: [] }) };

function options(overrides = {}) {
  return {
    pool,
    ensureAvailable: async () => {},
    requireWorkflowAccess: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
    resolveAccountId: async (_pool, accountId) => `canonical-${accountId}`,
    normalizeFileId: (value) => value ? `file-${value}` : null,
    getEvidence: async () => null,
    getDocumentContent: async () => null,
    getDescriptionSuggestion: async () => ({}),
    saveVerification: async () => null,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(router, { mobileAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  if (mobileAuth) {
    app.use((req, _res, next) => {
      req.mobileAuth = { userId: "mobile-user" };
      next();
    });
  }
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

test("zoning evidence preserves canonical account and assignment scope", async (context) => {
  const calls = [];
  const evidence = { zoning_code: "PD-1" };
  const server = await startRouter(createZoningRouter(options({
    ensureAvailable: async () => { calls.push("ensure"); },
    resolveAccountId: async (receivedPool, accountId) => {
      calls.push(["resolve", receivedPool, accountId]);
      return "canonical-42";
    },
    normalizeFileId: (value) => {
      calls.push(["normalize", value]);
      return "file-7";
    },
    getEvidence: async (receivedPool, input) => {
      calls.push(["evidence", receivedPool, input]);
      return evidence;
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/%2042%20/zoning-evidence?assignment_file_id=7`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, account_id: "canonical-42", evidence });
  assert.deepEqual(calls, [
    "ensure",
    ["resolve", pool, "42"],
    ["normalize", "7"],
    ["evidence", pool, { accountId: "canonical-42", assignmentFileId: "file-7" }],
  ]);
});

test("zoning evidence preserves not-found and bounded failure responses", async (context) => {
  const server = await startRouter(createZoningRouter(options({
    resolveAccountId: async (_pool, accountId) => {
      throw new Error(accountId === "missing" ? "account_not_found" : "database_diagnostic");
    },
  })));
  context.after(server.close);

  const missing = await fetch(`${server.baseUrl}/api/accounts/missing/zoning-evidence`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "account_not_found" });

  const failed = await fetch(`${server.baseUrl}/api/accounts/failure/zoning-evidence`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "database_diagnostic" });
});

test("zoning document content validates before readiness and preserves immutable headers", async (context) => {
  let ensureCount = 0;
  const calls = [];
  const document = {
    id: 8,
    content_type: "application/pdf",
    checksum_sha256: "abc123",
    content: Buffer.from("pdf-bytes"),
  };
  const server = await startRouter(createZoningRouter(options({
    ensureAvailable: async () => { ensureCount += 1; },
    getDocumentContent: async (receivedPool, documentId) => {
      calls.push([receivedPool, documentId]);
      return documentId === 8 ? document : null;
    },
  })));
  context.after(server.close);

  const invalid = await fetch(`${server.baseUrl}/api/zoning-source-documents/0/content`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_zoning_document_id" });
  assert.equal(ensureCount, 0);

  const missing = await fetch(`${server.baseUrl}/api/zoning-source-documents/9/content`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "zoning_document_not_found" });

  const response = await fetch(`${server.baseUrl}/api/zoning-source-documents/8/content`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "pdf-bytes");
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="zoning-evidence-8.pdf"');
  assert.equal(response.headers.get("etag"), '"abc123"');
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ensureCount, 2);
  assert.deepEqual(calls, [[pool, 9], [pool, 8]]);
});

test("zoning document stream failures stay bounded and log diagnostics", async (context) => {
  const failure = new Error("object_store_diagnostic");
  const logs = [];
  const server = await startRouter(createZoningRouter(options({
    getDocumentContent: async () => { throw failure; },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/zoning-source-documents/8/content`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "zoning_document_stream_failed" });
  assert.deepEqual(logs, [["zoning document stream failed", failure]]);
});

test("zoning description suggestions preserve trimmed codes and error mapping", async (context) => {
  const inputs = [];
  const server = await startRouter(createZoningRouter(options({
    getDescriptionSuggestion: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      if (input.documentId === "404") throw new Error("zoning_document_not_found");
      if (input.documentId === "bad") throw new Error("invalid_zoning_document_id");
      return { description: "Planned Development District" };
    },
  })));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/zoning-source-documents/8/description-suggestion?zoning_code=%20PD-1%20`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    description: "Planned Development District",
  });
  assert.deepEqual(inputs[0], [pool, { documentId: "8", zoningCode: "PD-1" }]);

  const missing = await fetch(
    `${server.baseUrl}/api/zoning-source-documents/404/description-suggestion`,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "zoning_document_not_found" });

  const invalid = await fetch(
    `${server.baseUrl}/api/zoning-source-documents/bad/description-suggestion`,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_zoning_document_id" });
});

test("zoning verification stops before readiness when workflow access is denied", async (context) => {
  let ensureCount = 0;
  let saveCount = 0;
  const server = await startRouter(createZoningRouter(options({
    ensureAvailable: async () => { ensureCount += 1; },
    requireWorkflowAccess: (_req, res, workflow, permission) => {
      assert.equal(workflow, "custom_appraisal");
      assert.equal(permission, "write");
      res.status(403).json({ error: "workflow_forbidden" });
      return false;
    },
    saveVerification: async () => { saveCount += 1; },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: 7 }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "workflow_forbidden" });
  assert.equal(ensureCount, 0);
  assert.equal(saveCount, 0);
});

test("authenticated mobile zoning verification requires an assignment file", async (context) => {
  let accessCount = 0;
  let saveCount = 0;
  const server = await startRouter(createZoningRouter(options({
    authenticationRequired: true,
    requireAssignmentAccess: async () => { accessCount += 1; return true; },
    saveVerification: async () => { saveCount += 1; },
  })), { mobileAuth: true });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ zoning_code: "PD-1" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "assignment_file_required" });
  assert.equal(accessCount, 0);
  assert.equal(saveCount, 0);
});

test("zoning verification stops after assignment denial and preserves successful inputs", async (context) => {
  let saveCount = 0;
  const deniedServer = await startRouter(createZoningRouter(options({
    requireAssignmentAccess: async (_req, res, accountId, assignmentFileId, permission) => {
      assert.equal(accountId, "canonical-42");
      assert.equal(assignmentFileId, "file-7");
      assert.equal(permission, "write");
      res.status(403).json({ error: "assignment_forbidden" });
      return false;
    },
    saveVerification: async () => { saveCount += 1; },
  })));
  context.after(deniedServer.close);

  const denied = await fetch(`${deniedServer.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: "7" }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "assignment_forbidden" });
  assert.equal(saveCount, 0);

  const inputs = [];
  const verification = { zoning_code: "PD-1", review_status: "confirmed" };
  const body = { assignment_file_id: "7", zoning_code: "PD-1", reviewer: "Appraiser" };
  const successServer = await startRouter(createZoningRouter(options({
    saveVerification: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      return verification;
    },
  })));
  context.after(successServer.close);

  const success = await fetch(`${successServer.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), {
    ok: true,
    account_id: "canonical-42",
    verification,
  });
  assert.deepEqual(inputs, [[pool, {
    accountId: "canonical-42",
    assignmentFileId: "file-7",
    input: body,
  }]]);
});

test("zoning verification retains client-error mapping and validates composition", async (context) => {
  const server = await startRouter(createZoningRouter(options({
    saveVerification: async () => { throw new Error("zoning_code_required"); },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: "file-7" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "zoning_code_required" });

  assert.throws(() => createZoningRouter(), /zoning_pool_required/);
  assert.throws(
    () => createZoningRouter(options({ authenticationRequired: undefined })),
    /zoning_dependency_required/,
  );
  assert.throws(
    () => createZoningRouter(options({ requireAssignmentAccess: null })),
    /zoning_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const propertyContext = source.indexOf("app.use(createAccountPropertyContextRouter(");
  const zoning = source.indexOf("app.use(createZoningRouter(");
  const assignmentPhotos = source.indexOf("app.use(createAssignmentPhotoRouter(");
  assert.ok(propertyContext > 0);
  assert.ok(zoning > propertyContext);
  assert.ok(assignmentPhotos > zoning);
  assert.equal(source.includes('app.get("/api/accounts/:id/zoning-evidence"'), false);
  assert.equal(source.includes('app.get("/api/zoning-source-documents/:id/content"'), false);
  assert.equal(
    source.includes('app.get("/api/zoning-source-documents/:id/description-suggestion"'),
    false,
  );
  assert.equal(source.includes('app.put("/api/accounts/:id/zoning-verification"'), false);
});
