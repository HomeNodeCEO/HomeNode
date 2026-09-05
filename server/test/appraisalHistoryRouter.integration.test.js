import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAppraisalHistoryRouter } from "../src/modules/accounts/appraisalHistoryRouter.js";

const identity = Object.freeze({
  userId: "user-1",
  organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
});

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [{ table_name: "app.appraisal_cases" }] }) },
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    authenticationRequired: false,
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    buildAccessScope: () => ({ userId: "user-1", organizationIds: ["org-1"] }),
    authorizeReportFile: async () => ({ organization_id: "org-1" }),
    hasPermission: () => true,
    listHistory: async () => { throw new Error("unexpected_history_list"); },
    loadCompletion: async () => { throw new Error("unexpected_completion_load"); },
    replicateFile: async () => { throw new Error("unexpected_replication"); },
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
  app.use(createAppraisalHistoryRouter(options));
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

function replicate(baseUrl, accountId, reportFileId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/appraisal-history/${reportFileId}/replicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("appraisal-history gates preserve their original validation order", async (context) => {
  let resolutionCalls = 0;
  let editorCalls = 0;
  let workflowCalls = 0;
  const shared = {
    resolveAccountId: async () => { resolutionCalls += 1; return "unexpected"; },
    requireEditor: () => { editorCalls += 1; return true; },
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

  const deniedList = await fetch(`${denied.baseUrl}/api/accounts/123/appraisal-history`);
  assert.equal(deniedList.status, 403);
  assert.deepEqual(await deniedList.json(), { error: "workflow_access_denied" });

  const invalidCompletion = await fetch(
    `${accepted.baseUrl}/api/accounts/bad%20id/appraisal-history/file-1/completion`,
  );
  assert.equal(invalidCompletion.status, 400);
  assert.deepEqual(await invalidCompletion.json(), { error: "invalid_account_id" });

  const invalidReplication = await replicate(accepted.baseUrl, "bad%20id", "file-1");
  assert.equal(invalidReplication.status, 400);
  assert.deepEqual(await invalidReplication.json(), { error: "invalid_account_id" });
  assert.equal(workflowCalls, 2);
  assert.equal(editorCalls, 0);
  assert.equal(resolutionCalls, 0);
});

test("enforced history listing scopes results after schema readiness", async (context) => {
  const calls = [];
  const accessScope = { customAssignedUserId: "user-1", uadAssignedUserId: "user-1" };
  const history = { account_id: "CANONICAL_1", files: [{ id: "file-1" }] };
  const options = baseOptions({
    authenticationRequired: true,
    pool: {
      async query(sql) {
        calls.push({ type: "schema", sql });
        return { rows: [{ table_name: "app.appraisal_cases" }] };
      },
    },
    resolveAccountId: async (pool, value) => {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    buildAccessScope(auth) {
      calls.push({ type: "scope", auth });
      return accessScope;
    },
    listHistory: async (pool, accountId, scope) => {
      calls.push({ type: "list", pool, accountId, scope });
      return history;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/legacy_1/appraisal-history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), history);
  assert.deepEqual(calls.map(({ type }) => type), ["resolve", "schema", "scope", "list"]);
  assert.equal(calls[0].pool, options.pool);
  assert.equal(calls[0].value, "legacy_1");
  assert.equal(calls[2].auth, identity);
  assert.equal(calls[3].scope, accessScope);
  assert.equal(calls[3].accountId, "CANONICAL_1");
});

test("rollout history remains scoped and fails closed when schema is unavailable", async (context) => {
  let scopeCalls = 0;
  let listCalls = 0;
  const rollout = await startRouter(baseOptions({
    buildAccessScope: () => { scopeCalls += 1; return { organizationIds: ["org-1"] }; },
    listHistory: async (_pool, accountId, scope) => {
      listCalls += 1;
      assert.equal(accountId, "123");
      assert.deepEqual(scope, { organizationIds: ["org-1"] });
      return { files: [] };
    },
  }), identity);
  const unavailable = await startRouter(baseOptions({
    pool: { query: async () => ({ rows: [{ table_name: null }] }) },
    listHistory: async () => { listCalls += 1; throw new Error("unexpected_list"); },
  }));
  context.after(async () => Promise.all([rollout.close(), unavailable.close()]));

  const rolloutResponse = await fetch(`${rollout.baseUrl}/api/accounts/123/appraisal-history`);
  assert.equal(rolloutResponse.status, 200);
  assert.deepEqual(await rolloutResponse.json(), { files: [] });
  assert.equal(scopeCalls, 1);

  const unavailableResponse = await fetch(
    `${unavailable.baseUrl}/api/accounts/123/appraisal-history`,
  );
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    error: "appraisal_history_schema_unavailable",
  });
  assert.equal(listCalls, 1);
});

test("completion authorization precedes immutable snapshot loading in enforced mode", async (context) => {
  const calls = [];
  const completion = { adapter_version: "1", subject: { identity: { account_id: "CANONICAL_1" } } };
  const options = baseOptions({
    authenticationRequired: true,
    resolveAccountId: async (_pool, value) => {
      assert.equal(value, "legacy_1");
      return "CANONICAL_1";
    },
    authorizeReportFile: async (pool, auth, input) => {
      calls.push({ type: "authorize", pool, auth, input });
      return { organization_id: "org-1" };
    },
    loadCompletion: async (pool, input) => {
      calls.push({ type: "load", pool, input });
      return completion;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/legacy_1/appraisal-history/file-1/completion`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, account_id: "CANONICAL_1", completion });
  assert.deepEqual(calls.map(({ type }) => type), ["authorize", "load"]);
  assert.equal(calls[0].pool, options.pool);
  assert.equal(calls[0].auth, identity);
  assert.deepEqual(calls[0].input, {
    accountId: "CANONICAL_1",
    reportFileId: "file-1",
    permission: "read",
  });
  assert.deepEqual(calls[1].input, {
    accountId: "CANONICAL_1",
    reportFileId: "file-1",
  });
});

test("completion failures retain denial, conflict, and diagnostic-safe responses", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    loadCompletion: async (_pool, { reportFileId }) => {
      const messages = {
        denied: "appraisal_report_file_access_denied",
        missing: "shared_appraisal_completion_source_not_found",
        absent: "appraisal_report_file_not_found",
        invalid: "invalid_report_file_id",
        failed: "database_password=secret",
      };
      throw Object.assign(new Error(messages[reportFileId]), { code: "XX000" });
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  for (const [reportFileId, status, error] of [
    ["denied", 403, "appraisal_report_file_access_denied"],
    ["missing", 404, "shared_appraisal_completion_source_not_found"],
    ["absent", 404, "appraisal_report_file_not_found"],
    ["invalid", 400, "invalid_report_file_id"],
    ["failed", 500, "shared_appraisal_completion_load_failed"],
  ]) {
    const response = await fetch(
      `${server.baseUrl}/api/accounts/123/appraisal-history/${reportFileId}/completion`,
    );
    assert.equal(response.status, status);
    const body = await response.json();
    assert.deepEqual(body, { error });
    assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  }
  assert.equal(errors.length, 1);
});

test("enforced replication binds source access, target permission, actor, and organization", async (context) => {
  const calls = [];
  const result = { report_file_id: "new-file", replication_mode: "same_assignment_alternate" };
  const options = baseOptions({
    authenticationRequired: true,
    resolveAccountId: async () => "CANONICAL_1",
    authorizeReportFile: async (pool, auth, input) => {
      calls.push({ type: "authorize", pool, auth, input });
      return { organization_id: "org-1" };
    },
    hasPermission(auth, workflow, permission, organizationId) {
      calls.push({ type: "permission", auth, workflow, permission, organizationId });
      return true;
    },
    replicateFile: async (pool, input) => {
      calls.push({ type: "replicate", pool, input });
      return result;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const body = {
    mode: "same_assignment_alternate",
    target_workflow_type: " uad_3_6 ",
    same_assignment_confirmed: true,
  };
  const response = await replicate(server.baseUrl, "legacy_1", "source-file", body);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, ...result });
  assert.deepEqual(calls.map(({ type }) => type), ["authorize", "permission", "replicate"]);
  assert.deepEqual(calls[0].input, {
    accountId: "CANONICAL_1",
    reportFileId: "source-file",
    permission: "write",
  });
  assert.deepEqual(calls[1], {
    type: "permission",
    auth: identity,
    workflow: "uad_3_6",
    permission: "write",
    organizationId: "org-1",
  });
  assert.equal(calls[2].pool, options.pool);
  assert.deepEqual(calls[2].input, {
    accountId: "CANONICAL_1",
    sourceReportFileId: "source-file",
    input: body,
    actorUserId: "user-1",
    organizationId: "org-1",
  });
});

test("replication denies unauthorized target workflows before creating a report", async (context) => {
  let replicationCalls = 0;
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    authorizeReportFile: async () => ({ organization_id: "org-1" }),
    hasPermission: () => false,
    replicateFile: async () => { replicationCalls += 1; throw new Error("unexpected_replication"); },
  }), identity);
  context.after(server.close);

  const response = await replicate(server.baseUrl, "123", "source-file", {
    target_workflow_type: "custom_appraisal",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "appraisal_replication_access_denied" });
  assert.equal(replicationCalls, 0);
});

test("rollout replication preserves authenticated ownership and status semantics", async (context) => {
  const replicationCalls = [];
  const errors = [];
  const server = await startRouter(baseOptions({
    replicateFile: async (pool, input) => {
      replicationCalls.push({ pool, input });
      const messages = {
        missing: "appraisal_report_file_not_found",
        confirm: "same_assignment_confirmation_required",
        conflict: "appraisal_replication_conflict",
        failed: "database_password=secret",
      };
      if (messages[input.sourceReportFileId]) throw new Error(messages[input.sourceReportFileId]);
      return { report_file_id: "new-file" };
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const success = await replicate(server.baseUrl, "123", "source", { mode: "new_assignment_template" });
  assert.equal(success.status, 201);
  assert.deepEqual(await success.json(), { ok: true, report_file_id: "new-file" });
  assert.deepEqual(replicationCalls[0].input, {
    accountId: "123",
    sourceReportFileId: "source",
    input: { mode: "new_assignment_template" },
    actorUserId: "user-1",
    organizationId: "org-1",
  });

  for (const [reportFileId, status, error] of [
    ["missing", 404, "appraisal_report_file_not_found"],
    ["confirm", 400, "same_assignment_confirmation_required"],
    ["conflict", 409, "appraisal_replication_conflict"],
    ["failed", 500, "appraisal_file_replication_failed"],
  ]) {
    const response = await replicate(server.baseUrl, "123", reportFileId);
    assert.equal(response.status, status);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, { error });
    assert.doesNotMatch(JSON.stringify(responseBody), /password|secret/);
  }
  assert.equal(errors.length, 1);
});

test("appraisal-history composition and route position remain explicit", () => {
  assert.throws(() => createAppraisalHistoryRouter(), /appraisal_history_pool_required/);
  assert.throws(
    () => createAppraisalHistoryRouter(baseOptions({ requireWorkflowAccess: null })),
    /appraisal_history_workflow_policy_required/,
  );
  assert.throws(
    () => createAppraisalHistoryRouter(baseOptions({ requireEditor: null })),
    /appraisal_history_editor_policy_required/,
  );
  assert.throws(
    () => createAppraisalHistoryRouter(baseOptions({ authenticationRequired: null })),
    /appraisal_history_authentication_mode_required/,
  );
  assert.throws(
    () => createAppraisalHistoryRouter(baseOptions({ authorizeReportFile: null })),
    /appraisal_history_access_policy_required/,
  );
  assert.throws(
    () => createAppraisalHistoryRouter(baseOptions({ replicateFile: null })),
    /appraisal_history_service_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const reportFiles = source.indexOf("app.use(createDesktopReportFilesRouter(");
  const history = source.indexOf("app.use(createAppraisalHistoryRouter(");
  const sketches = source.indexOf("app.use(createDesktopAssignmentSketchRouter(");
  assert.ok(history > reportFiles);
  assert.ok(sketches > history);
  assert.equal(source.includes('app.get("/api/accounts/:id/appraisal-history"'), false);
  assert.equal(source.includes("/appraisal-history/:reportFileId/completion"), false);
  assert.equal(source.includes("/appraisal-history/:reportFileId/replicate"), false);
});
