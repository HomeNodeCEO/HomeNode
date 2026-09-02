import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createAssignmentWorkfileReadRouter,
} from "../src/modules/assignmentFiles/workfileReadRouter.js";

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireWorkflowAccess: () => true,
    requireAssignmentAccess: async () => true,
    objectStorage: { name: "test-storage" },
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    getWorkfile: async () => { throw new Error("unexpected_workfile_load"); },
    getReadiness: async () => { throw new Error("unexpected_readiness_load"); },
    getDownload: async () => { throw new Error("unexpected_download_load"); },
    getReportPdf: async () => { throw new Error("unexpected_report_load"); },
    getSigningSecret: () => "signing-secret",
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(createAssignmentWorkfileReadRouter(options));
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

function endpoint(baseUrl, suffix = "") {
  return `${baseUrl}/api/accounts/account_1/assignment-files/41/workfile${suffix}`;
}

test("workfile read gates preserve the legacy per-route validation order", async (context) => {
  let deniedWorkflowCalls = 0;
  let acceptedWorkflowCalls = 0;
  const denied = await startRouter(baseOptions({
    requireWorkflowAccess(_req, res) {
      deniedWorkflowCalls += 1;
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }));
  const accepted = await startRouter(baseOptions({
    requireWorkflowAccess() { acceptedWorkflowCalls += 1; return true; },
  }));
  context.after(async () => Promise.all([denied.close(), accepted.close()]));

  const deniedLoad = await fetch(
    `${denied.baseUrl}/api/accounts/bad%20id/assignment-files/41/workfile`,
  );
  assert.equal(deniedLoad.status, 403);
  const invalidReadiness = await fetch(
    `${denied.baseUrl}/api/accounts/bad%20id/assignment-files/41/workfile/readiness`,
  );
  assert.equal(invalidReadiness.status, 400);
  assert.equal(deniedWorkflowCalls, 1);

  const invalidLoad = await fetch(
    `${accepted.baseUrl}/api/accounts/bad%20id/assignment-files/41/workfile`,
  );
  assert.equal(invalidLoad.status, 400);
  assert.equal(acceptedWorkflowCalls, 1);
});

test("workfile and readiness reads bind canonical account, assignment, and access policy", async (context) => {
  const calls = [];
  const workfile = { assignment_file_id: 41, status: "draft" };
  const readiness = { ready: false, blocking_errors: ["missing_signature"] };
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
    getWorkfile: async (pool, input) => {
      calls.push({ type: "workfile", pool, input });
      return workfile;
    },
    getReadiness: async (pool, input) => {
      calls.push({ type: "readiness", pool, input });
      return readiness;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const loadResponse = await fetch(endpoint(server.baseUrl));
  assert.equal(loadResponse.status, 200);
  assert.deepEqual(await loadResponse.json(), {
    ok: true, account_id: "CANONICAL_1", workfile,
  });
  const readinessResponse = await fetch(endpoint(server.baseUrl, "/readiness"));
  assert.equal(readinessResponse.status, 200);
  assert.deepEqual(await readinessResponse.json(), {
    ok: true, account_id: "CANONICAL_1", readiness,
  });
  assert.deepEqual(calls.filter(({ type }) => type === "access").map((call) => ({
    accountId: call.accountId,
    fileId: call.fileId,
    permission: call.permission,
  })), [
    { accountId: "CANONICAL_1", fileId: 41, permission: "read" },
    { accountId: "CANONICAL_1", fileId: 41, permission: "read" },
  ]);
  assert.deepEqual(calls.find(({ type }) => type === "workfile").input, {
    accountId: "CANONICAL_1", assignmentFileId: 41,
  });
  assert.deepEqual(calls.find(({ type }) => type === "readiness").input, {
    accountId: "CANONICAL_1", assignmentFileId: 41,
  });
  const callTypes = calls.map(({ type }) => type);
  assert.ok(callTypes.indexOf("schema") < callTypes.indexOf("resolve"));
  assert.ok(callTypes.indexOf("access") < callTypes.indexOf("workfile"));
});

test("assignment denials stop all four workfile services", async (context) => {
  const serviceCalls = [];
  const server = await startRouter(baseOptions({
    async requireAssignmentAccess(_req, res) {
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" });
      return false;
    },
    getWorkfile: async () => { serviceCalls.push("workfile"); },
    getReadiness: async () => { serviceCalls.push("readiness"); },
    getDownload: async () => { serviceCalls.push("download"); },
    getReportPdf: async () => { serviceCalls.push("report"); },
  }));
  context.after(server.close);

  for (const suffix of ["", "/readiness", "/download", "/report.pdf"]) {
    const response = await fetch(endpoint(server.baseUrl, suffix));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "custom_appraisal_assignment_access_denied",
    });
  }
  assert.deepEqual(serviceCalls, []);
});

test("snapshot downloads preserve immutable headers, checksum, and safe filenames", async (context) => {
  const calls = [];
  const options = baseOptions({
    getSigningSecret: () => "secret-1",
    getDownload: async (pool, input) => {
      calls.push({ pool, input });
      return {
        canonical_file_name: 'unsafe"\r\nfile.json',
        immutable: true,
        checksum_sha256: "abc123",
        snapshot: { status: "signed", revision: 9 },
      };
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(endpoint(server.baseUrl, "/download"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="unsafe___file.json"',
  );
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-homenode-immutable"), "true");
  assert.equal(response.headers.get("etag"), '"abc123"');
  assert.equal(await response.text(), '{\n  "status": "signed",\n  "revision": 9\n}\n');
  assert.deepEqual(calls, [{
    pool: options.pool,
    input: { accountId: "ACCOUNT_1", assignmentFileId: 41, signingSecret: "secret-1" },
  }]);
});

test("draft downloads remain no-store and retain Express weak ETags without a checksum", async (context) => {
  const server = await startRouter(baseOptions({
    getDownload: async () => ({
      canonical_file_name: "draft.json",
      immutable: false,
      checksum_sha256: null,
      snapshot: { status: "draft" },
    }),
  }));
  context.after(server.close);

  const response = await fetch(endpoint(server.baseUrl, "/download"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-homenode-immutable"), "false");
  assert.match(response.headers.get("etag"), /^W\/"/);
});

test("PDF reads pass the authorized snapshot and storage into fixed-layout generation", async (context) => {
  const calls = [];
  const download = { immutable: true, snapshot: { status: "signed" } };
  const report = {
    canonical_file_name: 'report"\r.pdf',
    immutable: true,
    content: Buffer.from([1, 2, 3, 4]),
    page_count: 7,
    content_sha256: "pdf-sha",
  };
  const options = baseOptions({
    getDownload: async (pool, input) => {
      calls.push({ type: "download", pool, input });
      return download;
    },
    getReportPdf: async (pool, input) => {
      calls.push({ type: "report", pool, input });
      return report;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await fetch(endpoint(server.baseUrl, "/report.pdf"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report__.pdf"');
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-homenode-immutable"), "true");
  assert.equal(response.headers.get("x-homenode-report-pages"), "7");
  assert.equal(response.headers.get("etag"), '"pdf-sha"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), report.content);
  assert.deepEqual(calls[0].input, {
    accountId: "ACCOUNT_1", assignmentFileId: 41, signingSecret: "signing-secret",
  });
  assert.deepEqual(calls[1], {
    type: "report",
    pool: options.pool,
    input: {
      accountId: "ACCOUNT_1",
      assignmentFileId: 41,
      download,
      objectStorage: options.objectStorage,
    },
  });
});

test("workfile read error contracts remain bounded and diagnostic-safe", async (context) => {
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const missing = await startRouter(baseOptions({
    getWorkfile: async () => { throw new Error("assignment_file_not_found"); },
    getReadiness: async () => { throw new Error("invalid_readiness_state"); },
  }));
  const unavailable = await startRouter(baseOptions({
    getDownload: async () => {
      throw new Error("custom_appraisal_signing_secret_not_configured");
    },
  }));
  const failed = await startRouter(baseOptions({
    getWorkfile: async () => { throw diagnostic; },
    getDownload: async () => ({ immutable: false, snapshot: {} }),
    getReportPdf: async () => { throw diagnostic; },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(async () => Promise.all([missing.close(), unavailable.close(), failed.close()]));

  const missingResponse = await fetch(endpoint(missing.baseUrl));
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "assignment_file_not_found" });
  const invalidResponse = await fetch(endpoint(missing.baseUrl, "/readiness"));
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: "invalid_readiness_state" });
  for (const suffix of ["/download", "/report.pdf"]) {
    const response = await fetch(endpoint(unavailable.baseUrl, suffix));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "custom_appraisal_signing_secret_not_configured",
    });
  }
  const failedLoad = await fetch(endpoint(failed.baseUrl));
  assert.equal(failedLoad.status, 500);
  assert.deepEqual(await failedLoad.json(), { error: "custom_appraisal_workfile_load_failed" });
  const failedReport = await fetch(endpoint(failed.baseUrl, "/report.pdf"));
  assert.equal(failedReport.status, 500);
  assert.deepEqual(await failedReport.json(), { error: "custom_appraisal_report_pdf_failed" });
  assert.equal(logs.length, 2);
  assert.ok(logs.every(([, error]) => error === diagnostic));
});

test("workfile read composition is explicit and inline handlers are absent", () => {
  assert.throws(
    () => createAssignmentWorkfileReadRouter(baseOptions({ pool: null })),
    /assignment_workfile_read_pool_required/,
  );
  assert.throws(
    () => createAssignmentWorkfileReadRouter(baseOptions({ requireWorkflowAccess: null })),
    /assignment_workfile_read_access_policy_required/,
  );
  assert.throws(
    () => createAssignmentWorkfileReadRouter(baseOptions({ getDownload: null })),
    /assignment_workfile_read_dependency_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const mutations = source.indexOf("app.use(createAssignmentFileMutationRouter(");
  const reads = source.indexOf("app.use(createAssignmentWorkfileReadRouter(");
  const sections = source.indexOf("app.use(createAssignmentWorkfileMutationRouter(");
  assert.ok(reads > mutations);
  assert.ok(sections > reads);
  assert.equal(source.includes('app.get("/api/accounts/:id/assignment-files/:fileId/workfile"'), false);
  assert.equal(source.includes("workfile/readiness"), false);
  assert.equal(source.includes("workfile/download"), false);
  assert.equal(source.includes("workfile/report.pdf"), false);
});
