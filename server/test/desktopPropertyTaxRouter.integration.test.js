import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createDesktopPropertyTaxRouter } from "../src/modules/mobile/desktopPropertyTaxRouter.js";

const identity = Object.freeze({
  userId: "user-1",
  organizations: [
    { organizationId: "org-allowed", roles: ["appraiser"] },
    { organizationId: "org-denied", roles: ["read_only"] },
  ],
});

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountQualityReady: Promise.resolve(),
    propertyEnrichmentReady: Promise.resolve(),
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    authenticationRequired: false,
    ensureDocuments: async () => {},
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    hasPermission: () => { throw new Error("unexpected_permission_check"); },
    decideAccess: () => { throw new Error("unexpected_access_check"); },
    getFile: async () => { throw new Error("unexpected_get_file"); },
    getEvidenceVersion: async () => { throw new Error("unexpected_evidence_version"); },
    saveFile: async () => { throw new Error("unexpected_save_file"); },
    saveSketch: async () => { throw new Error("unexpected_save_sketch"); },
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options, auth = null) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (auth) {
    app.use((req, _res, next) => {
      req.mobileAuth = auth;
      next();
    });
  }
  app.use(createDesktopPropertyTaxRouter(options));
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

function patchFile(baseUrl, accountId, fileId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/property-tax-protest/${fileId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchSketch(baseUrl, accountId, fileId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/property-tax-protest/${fileId}/sketch`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function listDocuments(baseUrl, accountId, fileId) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/property-tax-protest/${fileId}/documents`);
}

function uploadDocument(baseUrl, accountId, fileId, body = Buffer.from("%PDF-test")) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/property-tax-protest/${fileId}/documents`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-document-type": "district_evidence",
      "x-document-title": encodeURIComponent("District evidence.pdf"),
      "x-document-file-name": encodeURIComponent("district evidence.pdf"),
    },
    body,
  });
}

test("Property Tax desktop gates preserve workflow and account validation order", async (context) => {
  let workflowCalls = 0;
  let editorCalls = 0;
  let resolutionCalls = 0;
  const shared = {
    requireEditor: () => { editorCalls += 1; return true; },
    resolveAccountId: async () => { resolutionCalls += 1; return "unexpected"; },
  };
  const accepted = await startRouter(baseOptions({
    ...shared,
    requireWorkflowAccess: () => { workflowCalls += 1; return true; },
  }));
  const denied = await startRouter(baseOptions({
    ...shared,
    requireWorkflowAccess(_req, res) {
      workflowCalls += 1;
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }));
  context.after(async () => Promise.all([accepted.close(), denied.close()]));

  const deniedLoad = await fetch(`${denied.baseUrl}/api/accounts/123/property-tax-protest`);
  assert.equal(deniedLoad.status, 403);
  assert.deepEqual(await deniedLoad.json(), { error: "workflow_access_denied" });

  const invalidLoad = await fetch(`${accepted.baseUrl}/api/accounts/bad%20id/property-tax-protest`);
  assert.equal(invalidLoad.status, 400);
  assert.deepEqual(await invalidLoad.json(), { error: "invalid_account_id" });

  const invalidSave = await patchFile(accepted.baseUrl, "bad%20id", "file-1");
  assert.equal(invalidSave.status, 400);
  assert.deepEqual(await invalidSave.json(), { error: "invalid_account_id" });
  assert.equal(workflowCalls, 2);
  assert.equal(editorCalls, 0);
  assert.equal(resolutionCalls, 0);
});

test("enforced Property Tax loads prefilter organizations and verify file-level access", async (context) => {
  const calls = [];
  const file = {
    tax_protest_file_id: "file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  const options = baseOptions({
    authenticationRequired: true,
    resolveAccountId: async (pool, value) => {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    hasPermission(auth, workflow, permission, organizationId) {
      calls.push({ type: "permission", auth, workflow, permission, organizationId });
      return organizationId === "org-allowed";
    },
    getFile: async (pool, accountId, fileId, settings) => {
      calls.push({ type: "get", pool, accountId, fileId, settings });
      return file;
    },
    decideAccess(auth, receivedFile, permission) {
      calls.push({ type: "access", auth, receivedFile, permission });
      return true;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/legacy_1/property-tax-protest?file_id=file-1`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account_id: "CANONICAL_1", file });
  const get = calls.find((call) => call.type === "get");
  assert.equal(get.pool, options.pool);
  assert.deepEqual({ accountId: get.accountId, fileId: get.fileId, settings: get.settings }, {
    accountId: "CANONICAL_1",
    fileId: "file-1",
    settings: { organizationIds: ["org-allowed"] },
  });
  const permissions = calls.filter((call) => call.type === "permission");
  assert.equal(permissions.length, 2);
  assert.ok(permissions.every(({ auth, workflow, permission }) => (
    auth === identity && workflow === "property_tax_protest" && permission === "read"
  )));
  const access = calls.find((call) => call.type === "access");
  assert.deepEqual(
    { auth: access.auth, receivedFile: access.receivedFile, permission: access.permission },
    { auth: identity, receivedFile: file, permission: "read" },
  );
});

test("rollout Property Tax loads remain unscoped while enforced denials remain bounded", async (context) => {
  let accessCalls = 0;
  let permissionCalls = 0;
  const file = { tax_protest_file_id: "file-1", organization_id: "org-denied" };
  const rollout = await startRouter(baseOptions({
    getFile: async (_pool, _accountId, _fileId, settings) => {
      assert.deepEqual(settings, { organizationIds: null });
      return file;
    },
    hasPermission: () => { permissionCalls += 1; return false; },
    decideAccess: () => { accessCalls += 1; return false; },
  }), identity);
  const denied = await startRouter(baseOptions({
    authenticationRequired: true,
    hasPermission: () => true,
    getFile: async () => file,
    decideAccess: () => false,
  }), identity);
  context.after(async () => Promise.all([rollout.close(), denied.close()]));

  const rolloutResponse = await fetch(`${rollout.baseUrl}/api/accounts/123/property-tax-protest`);
  assert.equal(rolloutResponse.status, 200);
  assert.deepEqual(await rolloutResponse.json(), { account_id: "123", file });
  assert.equal(permissionCalls, 0);
  assert.equal(accessCalls, 0);

  const deniedResponse = await fetch(`${denied.baseUrl}/api/accounts/123/property-tax-protest`);
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "property_tax_protest_access_denied" });
});

test("evidence-version reads preserve organization scope, no-store, absence, and denial", async (context) => {
  const serviceCalls = [];
  const version = {
    tax_protest_file_id: "allowed",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
    evidence_version: "v1",
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    hasPermission: (_auth, _workflow, _permission, organizationId) => (
      organizationId === "org-allowed"
    ),
    getEvidenceVersion: async (pool, accountId, fileId, settings) => {
      serviceCalls.push({ pool, accountId, fileId, settings });
      if (fileId === "missing") return null;
      return { ...version, tax_protest_file_id: fileId };
    },
    decideAccess: (_auth, file) => file.tax_protest_file_id !== "denied",
  }), identity);
  context.after(server.close);

  const allowed = await fetch(
    `${server.baseUrl}/api/accounts/123/property-tax-protest/allowed/evidence/version`,
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await allowed.json(), { account_id: "123", file: version });
  assert.deepEqual(serviceCalls[0].settings, { organizationIds: ["org-allowed"] });

  const missing = await fetch(
    `${server.baseUrl}/api/accounts/123/property-tax-protest/missing/evidence/version`,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "property_tax_protest_file_not_found" });

  const denied = await fetch(
    `${server.baseUrl}/api/accounts/123/property-tax-protest/denied/evidence/version`,
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "property_tax_protest_access_denied" });
});

test("Property Tax saves authorize the existing file before preserving revision input", async (context) => {
  const calls = [];
  const existingFile = {
    tax_protest_file_id: "file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  const savedFile = { ...existingFile, revision: 3 };
  const body = { expected_revision: 2, workfile_data: { requested_value: 300000 } };
  const options = baseOptions({
    authenticationRequired: true,
    getFile: async (pool, accountId, fileId) => {
      calls.push({ type: "get", pool, accountId, fileId });
      return existingFile;
    },
    decideAccess(auth, file, permission) {
      calls.push({ type: "access", auth, file, permission });
      return true;
    },
    saveFile: async (pool, accountId, fileId, input) => {
      calls.push({ type: "save", pool, accountId, fileId, input });
      return savedFile;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "legacy_1", "file-1", body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, file: savedFile });
  assert.deepEqual(calls.map(({ type }) => type), ["get", "access", "save"]);
  assert.deepEqual(calls[1], {
    type: "access",
    auth: identity,
    file: existingFile,
    permission: "write",
  });
  assert.equal(calls[2].pool, options.pool);
  assert.deepEqual({
    accountId: calls[2].accountId,
    fileId: calls[2].fileId,
    input: calls[2].input,
  }, { accountId: "LEGACY_1", fileId: "file-1", input: body });
});

test("enforced Property Tax writes conceal missing files and deny unauthorized files before save", async (context) => {
  let saveCalls = 0;
  const missing = await startRouter(baseOptions({
    authenticationRequired: true,
    getFile: async () => null,
    saveFile: async () => { saveCalls += 1; throw new Error("unexpected_save"); },
  }), identity);
  const denied = await startRouter(baseOptions({
    authenticationRequired: true,
    getFile: async () => ({ organization_id: "org-denied" }),
    decideAccess: () => false,
    saveFile: async () => { saveCalls += 1; throw new Error("unexpected_save"); },
  }), identity);
  context.after(async () => Promise.all([missing.close(), denied.close()]));

  const missingResponse = await patchFile(missing.baseUrl, "123", "missing");
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "property_tax_protest_file_not_found" });

  const deniedResponse = await patchFile(denied.baseUrl, "123", "denied");
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "property_tax_protest_access_denied" });
  assert.equal(saveCalls, 0);
});

test("Property Tax file failures preserve revision status and bounded diagnostics", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getFile: async () => null,
    saveFile: async (_pool, _accountId, fileId) => {
      const messages = {
        conflict: "property_tax_protest_revision_conflict",
        missing: "property_tax_protest_file_not_found",
        invalid: "invalid_property_tax_protest_update",
        failed: "database_password=secret",
      };
      const error = new Error(messages[fileId]);
      if (fileId === "conflict") error.currentRevision = 9;
      throw error;
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  for (const [fileId, status, body] of [
    ["conflict", 409, { error: "property_tax_protest_revision_conflict", current_revision: 9 }],
    ["missing", 404, { error: "property_tax_protest_file_not_found" }],
    ["invalid", 400, { error: "invalid_property_tax_protest_update" }],
    ["failed", 500, { error: "property_tax_protest_save_failed" }],
  ]) {
    const response = await patchFile(server.baseUrl, "123", fileId);
    assert.equal(response.status, status);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, body);
    assert.doesNotMatch(JSON.stringify(responseBody), /password|secret/);
  }
  assert.equal(errors.length, 1);
});

test("Property Tax sketch saves bind the authenticated actor and retain sketch error contracts", async (context) => {
  const calls = [];
  const errors = [];
  const body = { expected_revision: 4, sketch: { areas: [], rooms: [] } };
  const options = baseOptions({
    getFile: async () => null,
    saveSketch: async (pool, accountId, fileId, input, actorUserId) => {
      calls.push({ pool, accountId, fileId, input, actorUserId });
      const messages = {
        missing: "property_tax_protest_sketch_not_found",
        conflict: "sketch_revision_conflict",
        invalid: "invalid_sketch_expected_revision",
        duplicate: "duplicate_room_id",
        unready: "sketch_not_ready_for_confirmation",
        operation: "sketch_operation_conflict",
        failed: "database_password=secret",
      };
      if (!messages[fileId]) return { sketch: { id: "sketch-1", revision: 5 } };
      const error = new Error(messages[fileId]);
      if (fileId === "conflict") error.currentRevision = 12;
      throw error;
    },
    logger: { error(...args) { errors.push(args); } },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const success = await patchSketch(server.baseUrl, "legacy_1", "file-1", body);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true, sketch: { id: "sketch-1", revision: 5 } });
  assert.equal(calls[0].pool, options.pool);
  assert.deepEqual({
    accountId: calls[0].accountId,
    fileId: calls[0].fileId,
    input: calls[0].input,
    actorUserId: calls[0].actorUserId,
  }, { accountId: "LEGACY_1", fileId: "file-1", input: body, actorUserId: "user-1" });

  for (const [fileId, status, responseBody] of [
    ["missing", 404, { error: "property_tax_protest_sketch_not_found" }],
    ["conflict", 409, { error: "sketch_revision_conflict", current_revision: 12 }],
    ["invalid", 400, { error: "invalid_sketch_expected_revision" }],
    ["duplicate", 400, { error: "duplicate_room_id" }],
    ["unready", 400, { error: "sketch_not_ready_for_confirmation" }],
    ["operation", 409, { error: "sketch_operation_conflict" }],
    ["failed", 500, { error: "property_tax_protest_sketch_update_failed" }],
  ]) {
    const response = await patchSketch(server.baseUrl, "123", fileId);
    assert.equal(response.status, status);
    const received = await response.json();
    assert.deepEqual(received, responseBody);
    assert.doesNotMatch(JSON.stringify(received), /password|secret/);
  }
  assert.equal(errors.length, 1);
});

test("Property Tax read failures remain validation-aware and diagnostic-safe", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getFile: async (_pool, _accountId, fileId) => {
      if (fileId === "invalid") throw new Error("invalid_property_tax_protest_file_id");
      throw new Error("database_password=secret");
    },
    getEvidenceVersion: async (_pool, _accountId, fileId) => {
      if (fileId === "invalid") throw new Error("invalid_property_tax_protest_file_id");
      throw new Error("database_password=secret");
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  for (const [url, status, error] of [
    ["/api/accounts/123/property-tax-protest?file_id=invalid", 400, "invalid_property_tax_protest_file_id"],
    ["/api/accounts/123/property-tax-protest?file_id=failed", 500, "property_tax_protest_load_failed"],
    ["/api/accounts/123/property-tax-protest/invalid/evidence/version", 400, "invalid_property_tax_protest_file_id"],
    ["/api/accounts/123/property-tax-protest/failed/evidence/version", 500, "property_tax_protest_evidence_version_failed"],
  ]) {
    const response = await fetch(server.baseUrl + url);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.deepEqual(body, { error });
    assert.doesNotMatch(JSON.stringify(body), /password|secret/);
  }
  assert.equal(errors.length, 2);
});

test("Property Tax document lists use the authenticated canonical file scope", async (context) => {
  const calls = [];
  const file = {
    tax_protest_file_id: "tax-file-1",
    report_file_id: "report-file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  const documents = [{ id: 41, tax_protest_file_id: "tax-file-1" }];
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    hasPermission: (_auth, _workflow, _permission, organizationId) => (
      organizationId === "org-allowed"
    ),
    getFile: async (_pool, accountId, fileId, settings) => {
      calls.push({ type: "file", accountId, fileId, settings });
      return file;
    },
    decideAccess: (_auth, receivedFile, permission) => {
      calls.push({ type: "access", receivedFile, permission });
      return true;
    },
    listDocuments: async (_pool, options) => {
      calls.push({ type: "list", options });
      return documents;
    },
  }), identity);
  context.after(server.close);

  const response = await listDocuments(server.baseUrl, "legacy_1", "tax-file-1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "LEGACY_1",
    documents,
  });
  assert.deepEqual(calls, [
    {
      type: "file",
      accountId: "LEGACY_1",
      fileId: "tax-file-1",
      settings: { organizationIds: ["org-allowed"] },
    },
    { type: "access", receivedFile: file, permission: "read" },
    {
      type: "list",
      options: {
        accountId: "LEGACY_1",
        taxProtestFileId: "tax-file-1",
        reportFileId: "report-file-1",
        includePropertyEvidence: false,
      },
    },
  ]);
});

test("Property Tax document reads require matching protest and report identities", async (context) => {
  let getDocumentCalls = 0;
  const file = {
    tax_protest_file_id: "tax-file-1",
    report_file_id: "report-file-1",
  };
  const options = baseOptions({
    pool: {
      query: async (sql, values) => {
        assert.match(sql, /tax_protest_file_id = \$2 AND report_file_id = \$3/);
        assert.deepEqual(values, [41, "tax-file-1", "report-file-1"]);
        return { rows: [{ id: 41 }] };
      },
    },
    getFile: async () => file,
    getDocument: async (_pool, documentId) => {
      getDocumentCalls += 1;
      return { id: documentId, tax_protest_file_id: "tax-file-1" };
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/123/property-tax-protest/tax-file-1/documents/41`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    document: { id: 41, tax_protest_file_id: "tax-file-1" },
  });
  assert.equal(getDocumentCalls, 1);
});

test("Property Tax uploads bind only the canonical protest and report files", async (context) => {
  const calls = [];
  const file = {
    tax_protest_file_id: "tax-file-1",
    report_file_id: "report-file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  const storage = { configured: false };
  const ocrProvider = { configured: true };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    documentStorage: storage,
    documentOcrProvider: ocrProvider,
    hasPermission: () => true,
    getFile: async () => file,
    decideAccess: (_auth, receivedFile, permission) => {
      calls.push({ type: "access", receivedFile, permission });
      return true;
    },
    createDocument: async (_pool, options) => {
      calls.push({ type: "create", options });
      return { id: 42, processing_status: "uploaded" };
    },
    processDocument: async (_pool, documentId, options) => {
      calls.push({ type: "process", documentId, options });
      return { id: documentId, processing_status: "review_required" };
    },
  }), identity);
  context.after(server.close);

  const response = await uploadDocument(server.baseUrl, "legacy_1", "tax-file-1");
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "LEGACY_1",
    document: { id: 42, processing_status: "uploaded" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].type, "access");
  assert.equal(calls[0].permission, "write");
  assert.equal(calls[1].type, "create");
  assert.equal(calls[1].options.organizationId, "org-allowed");
  assert.equal(calls[1].options.accountId, "LEGACY_1");
  assert.equal(calls[1].options.taxProtestFileId, "tax-file-1");
  assert.equal(calls[1].options.reportFileId, "report-file-1");
  assert.equal(calls[1].options.assignmentFileId, undefined);
  assert.equal(calls[1].options.uadWorkfileId, undefined);
  assert.equal(calls[1].options.documentType, "district_evidence");
  assert.ok(Buffer.isBuffer(calls[1].options.content));
  assert.equal(calls[1].options.storage, storage);
  assert.deepEqual(calls[2], {
    type: "process",
    documentId: 42,
    options: { storage, ocrProvider },
  });
});

test("Property Tax document failures return bounded diagnostics", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getFile: async () => {
      throw new Error("database_password=secret");
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const response = await listDocuments(server.baseUrl, "123", "tax-file-1");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "property_tax_documents_lookup_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret/);
  assert.equal(errors.length, 1);
});

test("Property Tax desktop composition and route position remain explicit", () => {
  assert.throws(() => createDesktopPropertyTaxRouter(), /desktop_property_tax_pool_required/);
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ accountQualityReady: null })),
    /desktop_property_tax_account_readiness_required/,
  );
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ requireWorkflowAccess: null })),
    /desktop_property_tax_workflow_policy_required/,
  );
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ ensureDocuments: null })),
    /desktop_property_tax_document_readiness_required/,
  );
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ authenticationRequired: null })),
    /desktop_property_tax_authentication_mode_required/,
  );
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ decideAccess: null })),
    /desktop_property_tax_access_policy_required/,
  );
  assert.throws(
    () => createDesktopPropertyTaxRouter(baseOptions({ saveSketch: null })),
    /desktop_property_tax_service_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const sketches = source.indexOf("app.use(createDesktopAssignmentSketchRouter(");
  const propertyTax = source.indexOf("app.use(createDesktopPropertyTaxRouter(");
  const assignmentCreate = source.indexOf("app.use(createAssignmentFileMutationRouter(");
  assert.ok(propertyTax > sketches);
  assert.ok(assignmentCreate > propertyTax);
  assert.equal(source.includes('app.get("/api/accounts/:id/property-tax-protest"'), false);
  assert.equal(source.includes("/property-tax-protest/:fileId/evidence/version"), false);
  assert.equal(source.includes('app.patch("/api/accounts/:id/property-tax-protest/:fileId"'), false);
  assert.equal(source.includes("/property-tax-protest/:fileId/sketch"), false);
  assert.equal(source.includes("/property-tax-protest/:fileId/documents"), false);
});
