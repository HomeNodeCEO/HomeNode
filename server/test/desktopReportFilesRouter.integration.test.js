import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createDesktopReportFilesRouter,
  desktopReportFileErrorStatus,
} from "../src/modules/accounts/reportFilesRouter.js";

const identity = Object.freeze({
  userId: "user-1",
  organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
});

function baseOptions(overrides = {}) {
  return {
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => { throw new Error("unexpected_connect"); },
    },
    requireWorkflowAccess: () => true,
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    listFiles: async () => { throw new Error("unexpected_list"); },
    createFile: async () => { throw new Error("unexpected_create"); },
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
  app.use(createDesktopReportFilesRouter(options));
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

function postReportFile(baseUrl, accountId, body) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/report-files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("desktop report files enforce workflow permission and authentication before services", async (context) => {
  let resolutionCalls = 0;
  let serviceCalls = 0;
  const common = {
    resolveAccountId: async () => { resolutionCalls += 1; return "unexpected"; },
    listFiles: async () => { serviceCalls += 1; throw new Error("unexpected_list"); },
    createFile: async () => { serviceCalls += 1; throw new Error("unexpected_create"); },
  };
  const denied = await startRouter(baseOptions({
    ...common,
    requireWorkflowAccess(_req, res) {
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }), identity);
  const anonymous = await startRouter(baseOptions(common));
  context.after(async () => Promise.all([denied.close(), anonymous.close()]));

  const deniedResponse = await fetch(
    `${denied.baseUrl}/api/accounts/123/report-files?workflow_type=custom_appraisal`,
  );
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "workflow_access_denied" });

  const anonymousList = await fetch(
    `${anonymous.baseUrl}/api/accounts/123/report-files?workflow_type=custom_appraisal`,
  );
  assert.equal(anonymousList.status, 401);
  assert.deepEqual(await anonymousList.json(), { error: "authentication_required" });

  const anonymousCreate = await postReportFile(anonymous.baseUrl, "123", {
    workflow_type: "custom_appraisal",
  });
  assert.equal(anonymousCreate.status, 401);
  assert.deepEqual(await anonymousCreate.json(), { error: "authentication_required" });
  assert.equal(resolutionCalls, 0);
  assert.equal(serviceCalls, 0);
});

test("desktop report-file listing preserves canonicalization, policy, and response contract", async (context) => {
  const policyCalls = [];
  const resolutions = [];
  const serviceCalls = [];
  const file = { id: "file-1", workflow_type: "custom_appraisal" };
  const options = baseOptions({
    requireWorkflowAccess(_req, _res, workflowType, permission) {
      policyCalls.push({ workflowType, permission });
      return true;
    },
    resolveAccountId: async (pool, value) => {
      resolutions.push({ pool, value });
      return "CANONICAL_1";
    },
    listFiles: async (pool, auth, input) => {
      serviceCalls.push({ pool, auth, input });
      return {
        accountId: "CANONICAL_1",
        workflowType: "custom_appraisal",
        files: [file],
        recommended: file,
        requiresCreation: false,
      };
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/legacy_1/report-files?workflow_type=%20custom_appraisal%20`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "CANONICAL_1",
    workflow_type: "custom_appraisal",
    files: [file],
    recommended_file: file,
    requires_creation: false,
  });
  assert.deepEqual(policyCalls, [{ workflowType: "custom_appraisal", permission: "read" }]);
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].pool, options.pool);
  assert.equal(resolutions[0].value, "legacy_1");
  assert.equal(serviceCalls.length, 1);
  assert.equal(serviceCalls[0].pool, resolutions[0].pool);
  assert.equal(serviceCalls[0].auth, identity);
  assert.deepEqual(serviceCalls[0].input, {
    accountId: "CANONICAL_1",
    workflowType: "custom_appraisal",
    recentDays: 365,
  });
});

test("desktop report-file creation preserves canonical inputs and idempotent status codes", async (context) => {
  const policyCalls = [];
  const serviceCalls = [];
  const reportFile = { id: "file-1", account_id: "CANONICAL_1" };
  const options = baseOptions({
    requireWorkflowAccess(_req, _res, workflowType, permission) {
      policyCalls.push({ workflowType, permission });
      return true;
    },
    resolveAccountId: async (_pool, value) => {
      assert.equal(value, "legacy_1");
      return "CANONICAL_1";
    },
    createFile: async (pool, auth, input) => {
      serviceCalls.push({ pool, auth, input });
      return { reportFile, created: serviceCalls.length === 1 };
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const requestBody = {
    workflow_type: " custom_appraisal ",
    account_id: "ATTACKER_ACCOUNT",
    organization_id: "org-1",
    client_request_id: "request-1",
  };
  const created = await postReportFile(server.baseUrl, "legacy_1", requestBody);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { report_file: reportFile, created: true });

  const retried = await postReportFile(server.baseUrl, "legacy_1", requestBody);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { report_file: reportFile, created: false });
  assert.deepEqual(policyCalls, [
    { workflowType: "custom_appraisal", permission: "write" },
    { workflowType: "custom_appraisal", permission: "write" },
  ]);
  assert.equal(serviceCalls.length, 2);
  assert.ok(serviceCalls.every(({ pool }) => pool === options.pool));
  assert.ok(serviceCalls.every(({ auth }) => auth === identity));
  assert.ok(serviceCalls.every(({ input }) => (
    input.account_id === "CANONICAL_1"
    && input.workflow_type === "custom_appraisal"
    && input.organization_id === "org-1"
    && input.client_request_id === "request-1"
  )));
});

test("desktop report-file error mapping preserves stable client and conflict statuses", () => {
  assert.equal(desktopReportFileErrorStatus(new Error("report_file_not_found")), 404);
  assert.equal(desktopReportFileErrorStatus(new Error("organization_access_denied")), 403);
  assert.equal(desktopReportFileErrorStatus(new Error("creation_request_conflict")), 409);
  assert.equal(desktopReportFileErrorStatus({ code: "23505" }), 409);
  assert.equal(desktopReportFileErrorStatus(new Error("invalid_workflow_type")), 400);
  assert.equal(desktopReportFileErrorStatus(new Error("organization_required")), 400);
  assert.equal(desktopReportFileErrorStatus(new Error("database_password=secret")), 500);
});

test("desktop report-file failures remain bounded and omit diagnostics", async (context) => {
  const errors = [];
  const failedList = await startRouter(baseOptions({
    listFiles: async () => {
      throw Object.assign(new Error("database_password=secret"), { code: "XX000" });
    },
    logger: { error(...args) { errors.push(args); } },
  }), identity);
  const failedCreate = await startRouter(baseOptions({
    createFile: async () => { throw new Error("creation_request_conflict"); },
  }), identity);
  context.after(async () => Promise.all([failedList.close(), failedCreate.close()]));

  const listResponse = await fetch(
    `${failedList.baseUrl}/api/accounts/123/report-files?workflow_type=custom_appraisal`,
  );
  assert.equal(listResponse.status, 500);
  const listBody = await listResponse.json();
  assert.deepEqual(listBody, { error: "report_file_list_failed" });
  assert.doesNotMatch(JSON.stringify(listBody), /password|secret|XX000/);
  assert.equal(errors.length, 1);

  const createResponse = await postReportFile(failedCreate.baseUrl, "123", {
    workflow_type: "custom_appraisal",
  });
  assert.equal(createResponse.status, 409);
  assert.deepEqual(await createResponse.json(), { error: "creation_request_conflict" });
});

test("desktop report-file composition and route position remain explicit", () => {
  assert.throws(() => createDesktopReportFilesRouter(), /desktop_report_files_pool_required/);
  assert.throws(
    () => createDesktopReportFilesRouter(baseOptions({ requireWorkflowAccess: null })),
    /desktop_report_files_workflow_policy_required/,
  );
  assert.throws(
    () => createDesktopReportFilesRouter(baseOptions({ resolveAccountId: null })),
    /desktop_report_files_resolver_required/,
  );
  assert.throws(
    () => createDesktopReportFilesRouter(baseOptions({ listFiles: null })),
    /desktop_report_files_list_service_required/,
  );
  assert.throws(
    () => createDesktopReportFilesRouter(baseOptions({ createFile: null })),
    /desktop_report_files_create_service_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const assignmentFiles = source.indexOf("app.use(createAssignmentFileListRouter(");
  const reportFiles = source.indexOf("app.use(createDesktopReportFilesRouter(");
  const history = source.indexOf("app.use(createAppraisalHistoryRouter(");
  assert.ok(reportFiles > assignmentFiles);
  assert.ok(history > reportFiles);
  assert.equal(source.includes('app.get("/api/accounts/:id/report-files"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/report-files"'), false);
});
