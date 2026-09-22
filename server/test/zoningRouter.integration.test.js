import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createZoningRouter } from "../src/modules/accounts/zoningRouter.js";

const pool = { query: async () => ({ rows: [] }) };

const AUTHENTICATED_REVIEWER = Object.freeze({
  userId: "appraiser-1",
  email: "appraiser@example.test",
  displayName: "Authenticated Appraiser",
});

function options(overrides = {}) {
  return {
    pool,
    ensureAvailable: async () => {},
    requireWorkflowAccess: (req) => {
      req.mobileAuth ||= AUTHENTICATED_REVIEWER;
      return true;
    },
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
    requireAssignmentAccess: async (
      req,
      _res,
      accountId,
      assignmentFileId,
      permission,
    ) => {
      calls.push(["authorize", req.mobileAuth, accountId, assignmentFileId, permission]);
      return true;
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
    ["authorize", AUTHENTICATED_REVIEWER, "canonical-42", "file-7", "read"],
    ["evidence", pool, { accountId: "canonical-42", assignmentFileId: "file-7" }],
  ]);
});

test("zoning evidence requires exact assignment scope and stops after denial", async (context) => {
  let evidenceCount = 0;
  const server = await startRouter(createZoningRouter(options({
    requireAssignmentAccess: async (_req, res, accountId, assignmentFileId, permission) => {
      assert.equal(accountId, "canonical-42");
      assert.equal(assignmentFileId, "file-7");
      assert.equal(permission, "read");
      res.status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
    getEvidence: async () => { evidenceCount += 1; },
  })));
  context.after(server.close);

  const missing = await fetch(`${server.baseUrl}/api/accounts/42/zoning-evidence`);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "assignment_file_required" });

  const denied = await fetch(
    `${server.baseUrl}/api/accounts/42/zoning-evidence?assignment_file_id=7`,
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "assignment_file_access_denied" });
  assert.equal(evidenceCount, 0);
});

test("zoning read routes enforce Custom Appraisal read permission", async (context) => {
  let dependencyCalls = 0;
  const server = await startRouter(createZoningRouter(options({
    requireWorkflowAccess: (_req, res, workflow, permission) => {
      assert.equal(workflow, "custom_appraisal");
      assert.equal(permission, "read");
      res.status(403).json({ error: "application_access_denied" });
      return false;
    },
    ensureAvailable: async () => { dependencyCalls += 1; },
    getDocumentContent: async () => { dependencyCalls += 1; },
    getDescriptionSuggestion: async () => { dependencyCalls += 1; },
  })));
  context.after(server.close);

  for (const path of [
    "/api/accounts/42/zoning-evidence?assignment_file_id=7",
    "/api/zoning-source-documents/8/content",
    "/api/zoning-source-documents/8/description-suggestion?zoning_code=PD-1",
  ]) {
    const response = await fetch(`${server.baseUrl}${path}`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "application_access_denied" });
  }
  assert.equal(dependencyCalls, 0);
});

test("zoning evidence preserves not-found and bounds failure responses and logs", async (context) => {
  const logs = [];
  const server = await startRouter(createZoningRouter(options({
    resolveAccountId: async (_pool, accountId) => {
      throw new Error(accountId === "missing" ? "account_not_found" : "database_diagnostic");
    },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const missing = await fetch(
    `${server.baseUrl}/api/accounts/missing/zoning-evidence?assignment_file_id=7`,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "account_not_found" });

  const failed = await fetch(
    `${server.baseUrl}/api/accounts/failure/zoning-evidence?assignment_file_id=7`,
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "zoning_evidence_lookup_failed" });
  assert.deepEqual(logs, [["zoning_evidence_lookup_failed"]]);
  assert.doesNotMatch(JSON.stringify(logs), /database_diagnostic/);
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

test("zoning document stream failures stay bounded and log stable codes", async (context) => {
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
  assert.deepEqual(logs, [["zoning_document_stream_failed"]]);
  assert.doesNotMatch(JSON.stringify(logs), /object_store_diagnostic/);
});

test("zoning description suggestions preserve trimmed codes and error mapping", async (context) => {
  const inputs = [];
  const logs = [];
  const server = await startRouter(createZoningRouter(options({
    getDescriptionSuggestion: async (receivedPool, input) => {
      inputs.push([receivedPool, input]);
      if (input.documentId === "404") throw new Error("zoning_document_not_found");
      if (input.documentId === "bad") throw new Error("invalid_zoning_document_id");
      if (input.documentId === "failure") throw new Error("database_diagnostic");
      return { description: "Planned Development District" };
    },
    logger: { error: (...args) => logs.push(args) },
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

  const failed = await fetch(
    `${server.baseUrl}/api/zoning-source-documents/failure/description-suggestion`,
  );
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "zoning_description_suggestion_failed" });
  assert.deepEqual(logs, [["zoning_description_suggestion_failed"]]);
  assert.doesNotMatch(JSON.stringify(logs), /database_diagnostic/);
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

test("zoning verification fails closed when workflow policy omits authenticated identity", async (context) => {
  let ensureCount = 0;
  let saveCount = 0;
  const server = await startRouter(createZoningRouter(options({
    requireWorkflowAccess: () => true,
    ensureAvailable: async () => { ensureCount += 1; },
    saveVerification: async () => { saveCount += 1; },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: "7", zoning_code: "PD-1" }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(ensureCount, 0);
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
  const body = {
    assignment_file_id: "7",
    zoning_code: "PD-1",
    reviewer: "Impersonated Reviewer",
  };
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
    reviewer: "Authenticated Appraiser",
    input: body,
  }]]);
});

test("zoning verification bounds unexpected failures and logs stable codes", async (context) => {
  const logs = [];
  const server = await startRouter(createZoningRouter(options({
    saveVerification: async () => { throw new Error("private database diagnostic"); },
    logger: { error: (...args) => logs.push(args) },
  })));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/42/zoning-verification`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignment_file_id: "7", zoning_code: "PD-1" }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "zoning_verification_failed" });
  assert.deepEqual(logs, [["zoning_verification_failed"]]);
  assert.doesNotMatch(JSON.stringify(logs), /private database diagnostic/);
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
