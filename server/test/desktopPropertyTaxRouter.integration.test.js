import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createDesktopPropertyTaxRouter } from "../src/modules/mobile/desktopPropertyTaxRouter.js";
import { jsonErrorHandler } from "../src/security/httpSecurity.js";
import { PROPERTY_TAX_DOCUMENT_UPLOAD_QUOTA } from "../src/services/assignmentDocuments.js";

const identity = Object.freeze({
  userId: "user-1",
  displayName: "Taylor Appraiser",
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
    hasPermission: () => true,
    decideAccess: () => true,
    getFile: async () => { throw new Error("unexpected_get_file"); },
    getEvidenceVersion: async () => { throw new Error("unexpected_evidence_version"); },
    saveFile: async () => { throw new Error("unexpected_save_file"); },
    saveSketch: async () => { throw new Error("unexpected_save_sketch"); },
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options, auth = identity) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (auth) {
    app.use((req, _res, next) => {
      req.mobileAuth = auth;
      next();
    });
  }
  app.use(createDesktopPropertyTaxRouter(options));
  app.use(jsonErrorHandler);
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

function uploadDocument(baseUrl, accountId, fileId, body = Buffer.from("%PDF-test"), headers = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/property-tax-protest/${fileId}/documents`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-document-type": "district_evidence",
      "x-document-title": encodeURIComponent("District evidence.pdf"),
      "x-document-file-name": encodeURIComponent("district evidence.pdf"),
      ...headers,
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
  assert.equal(deniedLoad.headers.get("cache-control"), "no-store");
  assert.deepEqual(await deniedLoad.json(), { error: "workflow_access_denied" });

  const invalidLoad = await fetch(`${accepted.baseUrl}/api/accounts/bad%20id/property-tax-protest`);
  assert.equal(invalidLoad.status, 400);
  assert.equal(invalidLoad.headers.get("cache-control"), "no-store");
  assert.deepEqual(await invalidLoad.json(), { error: "invalid_account_id" });

  const invalidSave = await patchFile(accepted.baseUrl, "bad%20id", "file-1");
  assert.equal(invalidSave.status, 400);
  assert.deepEqual(await invalidSave.json(), { error: "invalid_account_id" });
  const deniedSave = await patchFile(denied.baseUrl, "123", "file-1");
  assert.equal(deniedSave.status, 403);
  assert.deepEqual(await deniedSave.json(), { error: "workflow_access_denied" });
  const deniedSketch = await patchSketch(denied.baseUrl, "123", "file-1");
  assert.equal(deniedSketch.status, 403);
  assert.deepEqual(await deniedSketch.json(), { error: "workflow_access_denied" });
  assert.equal(workflowCalls, 5);
  assert.equal(editorCalls, 0);
  assert.equal(resolutionCalls, 0);
});

test("enforced Property Tax latest loads prefilter organizations and exact loads verify file-level access", async (context) => {
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

  const response = await fetch(`${server.baseUrl}/api/accounts/legacy_1/property-tax-protest`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { account_id: "CANONICAL_1", file });
  const get = calls.find((call) => call.type === "get");
  assert.equal(get.pool, options.pool);
  assert.deepEqual({ accountId: get.accountId, fileId: get.fileId, settings: get.settings }, {
    accountId: "CANONICAL_1",
    fileId: null,
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

  const exactResponse = await fetch(
    `${server.baseUrl}/api/accounts/legacy_1/property-tax-protest?file_id=file-1`,
  );
  assert.equal(exactResponse.status, 200);
  assert.equal(exactResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await exactResponse.json(), { account_id: "CANONICAL_1", file });
  const gets = calls.filter((call) => call.type === "get");
  assert.deepEqual(gets[1].settings, { organizationIds: null });
});

test("Property Tax loads remain tenant-scoped in rollout and enforced modes", async (context) => {
  let accessCalls = 0;
  let permissionCalls = 0;
  const file = { tax_protest_file_id: "file-1", organization_id: "org-denied" };
  const rollout = await startRouter(baseOptions({
    getFile: async (_pool, _accountId, _fileId, settings) => {
      assert.deepEqual(settings, { organizationIds: ["org-allowed", "org-denied"] });
      return file;
    },
    hasPermission: () => { permissionCalls += 1; return true; },
    decideAccess: () => { accessCalls += 1; return true; },
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
  assert.equal(permissionCalls, 2);
  assert.equal(accessCalls, 1);

  const deniedResponse = await fetch(
    `${denied.baseUrl}/api/accounts/123/property-tax-protest?file_id=file-1`,
  );
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "property_tax_protest_access_denied" });
});

test("evidence-version reads preserve exact identity, no-store, absence, and denial", async (context) => {
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
  assert.deepEqual(serviceCalls[0].settings, { organizationIds: null });

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
    saveFile: async (pool, accountId, fileId, input, actor) => {
      calls.push({ type: "save", pool, accountId, fileId, input, actor });
      return savedFile;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "legacy_1", "file-1", body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
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
    actor: calls[2].actor,
  }, {
    accountId: "LEGACY_1",
    fileId: "file-1",
    input: body,
    actor: {
      actorUserId: "user-1",
      actorLabel: "Taylor Appraiser",
      actorAuth: identity,
      authorizationRequired: true,
    },
  });
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
    getFile: async () => ({
      tax_protest_file_id: "file-1",
      organization_id: "org-allowed",
      assigned_appraiser_user_id: "user-1",
    }),
    saveFile: async (_pool, _accountId, fileId) => {
      const messages = {
        conflict: "property_tax_protest_revision_conflict",
        operation: "property_tax_protest_save_operation_conflict",
        missing: "property_tax_protest_file_not_found",
        denied: "property_tax_protest_access_denied",
        attestation: "property_tax_comparable_attestation_required",
        invalid: "invalid_property_tax_protest_update",
        leaky: "invalid_database_password=secret",
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
    ["operation", 409, { error: "property_tax_protest_save_operation_conflict" }],
    ["missing", 404, { error: "property_tax_protest_file_not_found" }],
    ["denied", 403, { error: "property_tax_protest_access_denied" }],
    ["attestation", 403, { error: "property_tax_comparable_attestation_required" }],
    ["invalid", 400, { error: "invalid_property_tax_protest_update" }],
    ["leaky", 500, { error: "property_tax_protest_save_failed" }],
    ["failed", 500, { error: "property_tax_protest_save_failed" }],
  ]) {
    const response = await patchFile(server.baseUrl, "123", fileId);
    assert.equal(response.status, status);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, body);
    assert.doesNotMatch(JSON.stringify(responseBody), /password|secret/);
  }
  assert.deepEqual(errors, [
    ["property tax protest save failed", "unknown"],
    ["property tax protest save failed", "unknown"],
  ]);
});

test("Property Tax sketch saves bind the authenticated actor and retain sketch error contracts", async (context) => {
  const calls = [];
  const errors = [];
  const body = {
    expected_revision: 4,
    reviewer: "Forged Browser Reviewer",
    sketch: { areas: [], rooms: [] },
  };
  const options = baseOptions({
    getFile: async () => ({
      tax_protest_file_id: "file-1",
      organization_id: "org-allowed",
      assigned_appraiser_user_id: "user-1",
    }),
    saveSketch: async (pool, accountId, fileId, input, actorAuth, confirmationAuthorized) => {
      calls.push({ pool, accountId, fileId, input, actorAuth, confirmationAuthorized });
      const messages = {
        missing: "property_tax_protest_sketch_not_found",
        conflict: "sketch_revision_conflict",
        invalid: "invalid_sketch_expected_revision",
        duplicate: "duplicate_room_id",
        leakyInvalid: "invalid_database_password=secret",
        leakyDuplicate: "duplicate_database_password=secret",
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
    actorAuth: calls[0].actorAuth,
    confirmationAuthorized: calls[0].confirmationAuthorized,
  }, {
    accountId: "LEGACY_1",
    fileId: "file-1",
    input: body,
    actorAuth: identity,
    confirmationAuthorized: true,
  });

  for (const [fileId, status, responseBody] of [
    ["missing", 404, { error: "property_tax_protest_sketch_not_found" }],
    ["conflict", 409, { error: "sketch_revision_conflict", current_revision: 12 }],
    ["invalid", 400, { error: "invalid_sketch_expected_revision" }],
    ["duplicate", 400, { error: "duplicate_room_id" }],
    ["leakyInvalid", 500, { error: "property_tax_protest_sketch_update_failed" }],
    ["leakyDuplicate", 500, { error: "property_tax_protest_sketch_update_failed" }],
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
  assert.equal(errors.length, 3);
  assert.ok(errors.every(([, code]) => code === "unknown"));
  assert.doesNotMatch(JSON.stringify(errors), /password|secret/);
});

test("Property Tax sketch updates require an authenticated server identity", async (context) => {
  let getFileCalls = 0;
  let saveCalls = 0;
  const server = await startRouter(baseOptions({
    getFile: async () => { getFileCalls += 1; return null; },
    saveSketch: async () => { saveCalls += 1; return {}; },
  }), null);
  context.after(server.close);

  const response = await patchSketch(server.baseUrl, "123", "file-1", {
    expected_revision: 1,
    reviewer: "Forged Browser Reviewer",
    sketch: { review_status: "draft" },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
  assert.equal(getFileCalls, 0);
  assert.equal(saveCalls, 0);
});

test("appraiser-confirmed Property Tax sketches require sign authority before saving", async (context) => {
  const permissions = [];
  let saveCalls = 0;
  const existingFile = {
    tax_protest_file_id: "file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "another-user",
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    getFile: async () => existingFile,
    decideAccess: (_auth, file, permission) => {
      assert.equal(file, existingFile);
      permissions.push(permission);
      return false;
    },
    saveSketch: async () => {
      saveCalls += 1;
      return { sketch: { id: "unexpected" } };
    },
  }), identity);
  context.after(server.close);

  const response = await patchSketch(server.baseUrl, "123", "file-1", {
    expected_revision: 1,
    sketch: { review_status: "appraiser_confirmed" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "property_tax_protest_access_denied" });
  const whitespaceResponse = await patchSketch(server.baseUrl, "123", "file-1", {
    expected_revision: 1,
    sketch: { review_status: " appraiser_confirmed " },
  });
  assert.equal(whitespaceResponse.status, 403);
  assert.deepEqual(await whitespaceResponse.json(), {
    error: "property_tax_protest_access_denied",
  });
  assert.deepEqual(permissions, ["sign", "sign"]);
  assert.equal(saveCalls, 0);
});

test("Property Tax read failures remain validation-aware and diagnostic-safe", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getFile: async (_pool, _accountId, fileId) => {
      if (fileId === "invalid") throw new Error("invalid_property_tax_protest_file_id");
      if (fileId === "leaky") throw new Error("invalid_database_password=secret");
      throw new Error("database_password=secret");
    },
    getEvidenceVersion: async (_pool, _accountId, fileId) => {
      if (fileId === "invalid") throw new Error("invalid_property_tax_protest_file_id");
      if (fileId === "leaky") throw new Error("invalid_database_password=secret");
      throw new Error("database_password=secret");
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  for (const [url, status, error] of [
    ["/api/accounts/123/property-tax-protest?file_id=invalid", 400, "invalid_property_tax_protest_file_id"],
    ["/api/accounts/123/property-tax-protest?file_id=failed", 500, "property_tax_protest_load_failed"],
    ["/api/accounts/123/property-tax-protest?file_id=leaky", 500, "property_tax_protest_load_failed"],
    ["/api/accounts/123/property-tax-protest/invalid/evidence/version", 400, "invalid_property_tax_protest_file_id"],
    ["/api/accounts/123/property-tax-protest/failed/evidence/version", 500, "property_tax_protest_evidence_version_failed"],
    ["/api/accounts/123/property-tax-protest/leaky/evidence/version", 500, "property_tax_protest_evidence_version_failed"],
  ]) {
    const response = await fetch(server.baseUrl + url);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error });
    assert.doesNotMatch(JSON.stringify(body), /password|secret/);
  }
  assert.equal(errors.length, 4);
  assert.ok(errors.every(([, code]) => code === "unknown"));
  assert.doesNotMatch(JSON.stringify(errors), /password|secret/);
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
      settings: { organizationIds: null },
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

  const response = await uploadDocument(
    server.baseUrl,
    "legacy_1",
    "tax-file-1",
    Buffer.from("%PDF-test"),
    { "x-document-uploaded-by": encodeURIComponent("Forged Uploader") },
  );
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
  assert.equal(calls[1].options.uploadQuota, PROPERTY_TAX_DOCUMENT_UPLOAD_QUOTA);
  assert.deepEqual(calls[2], {
    type: "process",
    documentId: 42,
    options: { storage, ocrProvider },
  });
  assert.equal(calls[1].options.uploadedBy, identity.userId);
});

test("Property Tax uploads authorize before buffering and reject compressed bodies", async (context) => {
  const file = {
    tax_protest_file_id: "tax-file-1",
    report_file_id: "report-file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  let deniedCreates = 0;
  const deniedServer = await startRouter(baseOptions({
    getFile: async () => file,
    decideAccess: () => false,
    createDocument: async () => { deniedCreates += 1; },
  }));
  context.after(deniedServer.close);
  const denied = await uploadDocument(
    deniedServer.baseUrl,
    "123",
    "tax-file-1",
    Buffer.from("not-a-gzip-stream"),
    { "content-encoding": "gzip" },
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "property_tax_protest_access_denied" });
  assert.equal(deniedCreates, 0);

  let allowedCreates = 0;
  const allowedServer = await startRouter(baseOptions({
    getFile: async () => file,
    createDocument: async () => { allowedCreates += 1; },
  }));
  context.after(allowedServer.close);
  const compressed = await uploadDocument(
    allowedServer.baseUrl,
    "123",
    "tax-file-1",
    Buffer.from("not-a-gzip-stream"),
    { "content-encoding": "gzip" },
  );
  assert.equal(compressed.status, 415);
  assert.deepEqual(await compressed.json(), { error: "unsupported_request_encoding" });
  assert.equal(allowedCreates, 0);
});

test("Property Tax uploads return bounded conflicts when aggregate quotas are exhausted", async (context) => {
  const file = {
    tax_protest_file_id: "tax-file-1",
    report_file_id: "report-file-1",
    organization_id: "org-allowed",
    assigned_appraiser_user_id: "user-1",
  };
  const servers = await Promise.all([
    "assignment_document_storage_quota_exceeded",
    "assignment_document_processing_capacity_exceeded",
  ].map((message) => startRouter(baseOptions({
    getFile: async () => file,
    createDocument: async () => { throw new Error(message); },
  }))));
  context.after(async () => Promise.all(servers.map((server) => server.close())));

  for (const [index, error] of [
    "assignment_document_storage_quota_exceeded",
    "assignment_document_processing_capacity_exceeded",
  ].entries()) {
    const response = await uploadDocument(
      servers[index].baseUrl,
      "123",
      "tax-file-1",
    );
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error });
  }
});

test("Property Tax document failures return bounded diagnostics", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getFile: async (_pool, _accountId, fileId) => {
      throw new Error(fileId === "leaky" ? "invalid_database_password=secret" : "database_password=secret");
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const response = await listDocuments(server.baseUrl, "123", "tax-file-1");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "property_tax_documents_lookup_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret/);
  const leakyResponse = await listDocuments(server.baseUrl, "123", "leaky");
  assert.equal(leakyResponse.status, 500);
  assert.deepEqual(await leakyResponse.json(), { error: "property_tax_documents_lookup_failed" });
  assert.deepEqual(errors, [
    ["property_tax_documents_lookup_failed", "unknown"],
    ["property_tax_documents_lookup_failed", "unknown"],
  ]);
});

test("throwing Property Tax diagnostics and loggers preserve fixed error responses", async (context) => {
  const failure = {
    get message() { throw new Error("private_password"); },
    get code() { throw new Error("private_code"); },
  };
  const logger = {
    error() { throw new Error("logger_private_password"); },
    warn() { throw new Error("logger_private_password"); },
  };
  const readServer = await startRouter(baseOptions({
    getFile: async () => { throw failure; },
    logger,
  }));
  const writeServer = await startRouter(baseOptions({
    getFile: async () => ({
      tax_protest_file_id: "tax-file-1",
      report_file_id: "report-file-1",
      organization_id: "org-allowed",
      assigned_appraiser_user_id: "user-1",
    }),
    saveFile: async () => { throw failure; },
    saveSketch: async () => { throw failure; },
    logger,
  }));
  context.after(async () => Promise.all([readServer.close(), writeServer.close()]));

  const load = await fetch(`${readServer.baseUrl}/api/accounts/123/property-tax-protest`);
  assert.equal(load.status, 500);
  assert.deepEqual(await load.json(), { error: "property_tax_protest_load_failed" });

  const documents = await listDocuments(readServer.baseUrl, "123", "tax-file-1");
  assert.equal(documents.status, 500);
  assert.deepEqual(await documents.json(), { error: "property_tax_documents_lookup_failed" });

  const save = await patchFile(writeServer.baseUrl, "123", "tax-file-1");
  assert.equal(save.status, 500);
  assert.deepEqual(await save.json(), { error: "property_tax_protest_save_failed" });

  const sketch = await patchSketch(writeServer.baseUrl, "123", "tax-file-1");
  assert.equal(sketch.status, 500);
  assert.deepEqual(await sketch.json(), { error: "property_tax_protest_sketch_update_failed" });
});

test("Property Tax PDF bytes stay identical but HTTP storage and stale conditional access are denied", async (context) => {
  let accessAllowed = true;
  let authenticated = true;
  let documentCalls = 0;
  const content = Buffer.from("%PDF-private-tax-evidence");
  const file = { tax_protest_file_id: "tax-file-1", report_file_id: "report-file-1" };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    requireWorkflowAccess(_req, res) {
      if (authenticated) return true;
      res.status(401).json({ error: "authentication_required" });
      return false;
    },
    getFile: async () => file,
    decideAccess: () => accessAllowed,
    pool: { query: async () => ({ rows: [{ id: 41 }] }) },
    getDocument: async (_pool, id, options) => {
      documentCalls += 1;
      assert.equal(id, 41);
      assert.equal(options.includeContent, true);
      return { id, content, checksum_sha256: "pdf-checksum", file_name: 'evidence"\r\n.pdf' };
    },
  }));
  context.after(server.close);

  const prefix = `${server.baseUrl}/api/accounts/123/property-tax-protest`;
  for (const suffix of ["?file_id=tax-file-1", "/tax-file-1/documents/41/content"]) {
    authenticated = true;
    accessAllowed = true;
    const response = await fetch(prefix + suffix);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const etag = response.headers.get("etag");
    assert.ok(etag);
    if (suffix.endsWith("/content")) {
      assert.equal(response.headers.get("content-type"), "application/pdf");
      assert.equal(response.headers.get("content-disposition"), 'inline; filename="evidence___.pdf"');
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(etag, '"pdf-checksum"');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    } else {
      assert.deepEqual(await response.json(), { account_id: "123", file });
    }
    const head = await fetch(prefix + suffix, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-store");
    assert.equal(await head.text(), "");
    const authorizedDocumentCalls = documentCalls;
    accessAllowed = false;
    for (const method of ["GET", "HEAD"]) {
      const denied = await fetch(prefix + suffix, {
        method, headers: { "if-none-match": etag },
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store");
      await denied.arrayBuffer();
    }
    authenticated = false;
    const anonymous = await fetch(prefix + suffix, { headers: { "if-none-match": etag } });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    await anonymous.arrayBuffer();
    assert.equal(documentCalls, authorizedDocumentCalls);
  }
  const unrelated = await fetch(`${prefix}-public`);
  assert.equal(unrelated.headers.get("cache-control"), null);
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
