import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createAssignmentWorkfileMutationRouter,
} from "../src/modules/assignmentFiles/workfileMutationRouter.js";

const identity = Object.freeze({
  userId: "user-1",
  displayName: "Authenticated Appraiser",
  organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
});

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
    objectStorage: { name: "test-storage" },
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    saveSection: async () => { throw new Error("unexpected_section_save"); },
    signWorkfile: async () => { throw new Error("unexpected_workfile_sign"); },
    getSigningSecret: () => "signing-secret",
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
  app.use(createAssignmentWorkfileMutationRouter(options));
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

function saveSection(baseUrl, accountId, fileId, sectionKey, body = {}) {
  return fetch(
    `${baseUrl}/api/accounts/${accountId}/assignment-files/${fileId}/workfile/sections/${sectionKey}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function signWorkfile(baseUrl, accountId, fileId, body = {}, headers = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/assignment-files/${fileId}/workfile/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("workfile mutation gates account, editor, signer identity, and file ID before services", async (context) => {
  let editorCalls = 0;
  let schemaCalls = 0;
  const acceptedOptions = baseOptions({
    authenticationRequired: true,
    requireEditor: () => { editorCalls += 1; return true; },
    ensureCustomAppraisalWorkfilesAvailable: async () => { schemaCalls += 1; },
  });
  const accepted = await startRouter(acceptedOptions);
  const authenticated = await startRouter(acceptedOptions, identity);
  const denied = await startRouter(baseOptions({
    requireEditor(_req, res) {
      editorCalls += 1;
      res.status(403).json({ error: "editor_required" });
      return false;
    },
  }));
  context.after(async () => Promise.all([accepted.close(), authenticated.close(), denied.close()]));

  const invalidAccount = await saveSection(accepted.baseUrl, "bad%20id", 41, "subject", {});
  assert.equal(invalidAccount.status, 400);
  const deniedSection = await saveSection(denied.baseUrl, "A-1", 41, "subject", {});
  assert.equal(deniedSection.status, 403);
  const unauthenticatedSign = await signWorkfile(accepted.baseUrl, "A-1", 41, {});
  assert.equal(unauthenticatedSign.status, 401);
  assert.deepEqual(await unauthenticatedSign.json(), { error: "authenticated_signer_required" });
  const invalidFile = await signWorkfile(authenticated.baseUrl, "A-1", "bad", {});
  assert.equal(invalidFile.status, 400);
  assert.deepEqual(await invalidFile.json(), { error: "invalid_assignment_file_id" });
  assert.equal(editorCalls, 3);
  assert.equal(schemaCalls, 0);
});

test("section saves bind canonical assignment, version input, and write authorization", async (context) => {
  const calls = [];
  const section = { section_key: "subject", revision: 4, value: { address: "123 Main" } };
  const options = baseOptions({
    ensureCustomAppraisalWorkfilesAvailable: async () => { calls.push({ type: "schema" }); },
    resolveAccountId: async (pool, value) => {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    requireAssignmentAccess: async (req, res, accountId, fileId, permission) => {
      calls.push({ type: "access", req, res, accountId, fileId, permission });
      return true;
    },
    saveSection: async (pool, input) => {
      calls.push({ type: "save", pool, input });
      return section;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await saveSection(server.baseUrl, "account_1", 41, "subject", {
    value: { address: "123 Main" },
    expected_revision: 3,
    save_reason: "autosave",
    reviewer: "Reviewer",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, account_id: "CANONICAL_1", assignment_file_id: 41, section,
  });
  const access = calls.find(({ type }) => type === "access");
  assert.deepEqual({
    accountId: access.accountId, fileId: access.fileId, permission: access.permission,
  }, { accountId: "CANONICAL_1", fileId: 41, permission: "write" });
  assert.deepEqual(calls.find(({ type }) => type === "save"), {
    type: "save",
    pool: options.pool,
    input: {
      accountId: "CANONICAL_1",
      assignmentFileId: 41,
      sectionKey: "subject",
      sectionValue: { address: "123 Main" },
      expectedRevision: 3,
      saveReason: "autosave",
      reviewer: "Reviewer",
    },
  });
  assert.deepEqual(calls.map(({ type }) => type), ["schema", "resolve", "access", "save"]);
});

test("section assignment denial stops the save service", async (context) => {
  let saveCalls = 0;
  const server = await startRouter(baseOptions({
    async requireAssignmentAccess(_req, res) {
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" });
      return false;
    },
    saveSection: async () => { saveCalls += 1; },
  }), identity);
  context.after(server.close);

  const response = await saveSection(server.baseUrl, "A-1", 41, "subject", { value: {} });
  assert.equal(response.status, 403);
  assert.equal(saveCalls, 0);
});

test("section save failures preserve not-found, conflict, validation, and bounded diagnostics", async (context) => {
  const diagnostic = new Error("postgres db.internal secret-token");
  const cases = [
    { error: new Error("assignment_file_not_found"), status: 404, body: { error: "assignment_file_not_found" } },
    {
      error: Object.assign(new Error("custom_appraisal_section_revision_conflict"), {
        currentRevision: 8,
      }),
      status: 409,
      body: { error: "custom_appraisal_section_revision_conflict", current_revision: 8 },
    },
    { error: new Error("custom_appraisal_workfile_signed"), status: 409, body: { error: "custom_appraisal_workfile_signed" } },
    { error: new Error("invalid_section_key"), status: 400, body: { error: "invalid_section_key" } },
    { error: new Error("custom_appraisal_section_too_large"), status: 400, body: { error: "custom_appraisal_section_too_large" } },
    { error: diagnostic, status: 500, body: { error: "custom_appraisal_workfile_save_failed" } },
  ];
  const logs = [];
  const running = [];
  for (const item of cases) {
    const server = await startRouter(baseOptions({
      saveSection: async () => { throw item.error; },
      logger: { error: (...args) => logs.push(args) },
    }), identity);
    running.push({ ...item, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await saveSection(item.server.baseUrl, "A-1", 41, "subject", { value: {} });
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), item.body);
  }
  assert.deepEqual(logs, [["custom appraisal workfile section save failed", diagnostic]]);
});

test("enforced signing derives identity and audit inputs exclusively from the session", async (context) => {
  const calls = [];
  const workfile = { assignment_file_id: 41, status: "signed" };
  const options = baseOptions({
    authenticationRequired: true,
    getSigningSecret: () => "secret-1",
    requireAssignmentAccess: async (req, res, accountId, fileId, permission) => {
      calls.push({ type: "access", req, res, accountId, fileId, permission });
      return true;
    },
    signWorkfile: async (pool, input) => {
      calls.push({ type: "sign", pool, input });
      return workfile;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await signWorkfile(server.baseUrl, "account_1", 41, {
    signed_by: "Spoofed Browser Signer",
    reviewer: "Spoofed Reviewer",
    signature_event_id: "10000000-0000-4000-8000-000000000001",
    acknowledged_warning_codes: ["warning-1"],
  }, { "user-agent": "HomeNode-Test-Agent" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, account_id: "ACCOUNT_1", workfile });
  const access = calls.find(({ type }) => type === "access");
  assert.deepEqual({
    accountId: access.accountId, fileId: access.fileId, permission: access.permission,
  }, { accountId: "ACCOUNT_1", fileId: 41, permission: "sign" });
  const sign = calls.find(({ type }) => type === "sign");
  assert.equal(sign.pool, options.pool);
  assert.equal(sign.input.signedBy, "Authenticated Appraiser");
  assert.equal(sign.input.signerUserId, "user-1");
  assert.equal(sign.input.signatureEventId, "10000000-0000-4000-8000-000000000001");
  assert.match(sign.input.signedFromIp, /127\.0\.0\.1/);
  assert.equal(sign.input.signedUserAgent, "HomeNode-Test-Agent");
  assert.equal(sign.input.signingSecret, "secret-1");
  assert.deepEqual(sign.input.acknowledgedWarningCodes, ["warning-1"]);
  assert.equal(sign.input.objectStorage, options.objectStorage);
});

test("rollout signing preserves the legacy signer-name fallback without inventing a user ID", async (context) => {
  const inputs = [];
  const server = await startRouter(baseOptions({
    signWorkfile: async (_pool, input) => { inputs.push(input); return { status: "signed" }; },
  }));
  context.after(server.close);

  const response = await signWorkfile(server.baseUrl, "A-1", 41, {
    signed_by: "Legacy Appraiser",
    reviewer: "Fallback Reviewer",
  });
  assert.equal(response.status, 200);
  assert.equal(inputs[0].signedBy, "Legacy Appraiser");
  assert.equal(inputs[0].signerUserId, null);
});

test("sign assignment denial stops immutable snapshot creation", async (context) => {
  let signCalls = 0;
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    async requireAssignmentAccess(_req, res) {
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" });
      return false;
    },
    signWorkfile: async () => { signCalls += 1; },
  }), identity);
  context.after(server.close);

  const response = await signWorkfile(server.baseUrl, "A-1", 41, {});
  assert.equal(response.status, 403);
  assert.equal(signCalls, 0);
});

test("sign failures retain signer, readiness, conflict, availability, and diagnostic contracts", async (context) => {
  const incomplete = Object.assign(new Error("custom_appraisal_eo_incomplete"), {
    readinessErrors: ["missing_subject"],
    readiness: { ready: false },
  });
  const warnings = Object.assign(new Error("custom_appraisal_eo_warnings_unacknowledged"), {
    readinessWarnings: ["review_adjustment"],
    readiness: { ready: false, warnings: 1 },
  });
  const diagnostic = new Error("storage.internal secret-token");
  const cases = [
    { error: new Error("assignment_file_not_found"), status: 404, body: { error: "assignment_file_not_found" } },
    { error: new Error("custom_appraisal_workfile_signed"), status: 409, body: { error: "custom_appraisal_workfile_signed" } },
    { error: new Error("custom_appraisal_workfile_empty"), status: 409, body: { error: "custom_appraisal_workfile_empty" } },
    { error: new Error("custom_appraisal_signature_event_conflict"), status: 409, body: { error: "custom_appraisal_signature_event_conflict" } },
    { error: new Error("custom_appraisal_signer_not_assigned"), status: 403, body: { error: "custom_appraisal_signer_not_assigned" } },
    { error: new Error("custom_appraisal_signing_secret_not_configured"), status: 503, body: { error: "custom_appraisal_signing_secret_not_configured" } },
    {
      error: incomplete,
      status: 422,
      body: {
        error: "custom_appraisal_eo_incomplete",
        readiness_errors: ["missing_subject"],
        readiness: { ready: false },
      },
    },
    {
      error: warnings,
      status: 422,
      body: {
        error: "custom_appraisal_eo_warnings_unacknowledged",
        readiness_warnings: ["review_adjustment"],
        readiness: { ready: false, warnings: 1 },
      },
    },
    { error: new Error("invalid_signer"), status: 400, body: { error: "invalid_signer" } },
    { error: diagnostic, status: 500, body: { error: "custom_appraisal_workfile_sign_failed" } },
  ];
  const logs = [];
  const running = [];
  for (const item of cases) {
    const server = await startRouter(baseOptions({
      authenticationRequired: true,
      signWorkfile: async () => { throw item.error; },
      logger: { error: (...args) => logs.push(args) },
    }), identity);
    running.push({ ...item, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await signWorkfile(item.server.baseUrl, "A-1", 41, {});
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), item.body);
  }
  assert.deepEqual(logs, [["custom appraisal workfile signing failed", diagnostic]]);
});

test("workfile mutation composition is explicit and inline handlers are absent", () => {
  assert.throws(
    () => createAssignmentWorkfileMutationRouter(baseOptions({ pool: null })),
    /assignment_workfile_mutation_pool_required/,
  );
  assert.throws(
    () => createAssignmentWorkfileMutationRouter(baseOptions({ requireEditor: null })),
    /assignment_workfile_mutation_access_policy_required/,
  );
  assert.throws(
    () => createAssignmentWorkfileMutationRouter(baseOptions({ authenticationRequired: null })),
    /assignment_workfile_mutation_authentication_mode_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const accessGuards = source.indexOf("createApplicationAccessGuards({");
  const reads = source.indexOf("app.use(createAssignmentWorkfileReadRouter(");
  const mutations = source.indexOf("app.use(createAssignmentWorkfileMutationRouter(");
  assert.ok(reads > accessGuards);
  assert.ok(mutations > reads);
  assert.equal(source.includes("workfile/sections/:sectionKey"), false);
  assert.equal(source.includes("workfile/sign"), false);
});
