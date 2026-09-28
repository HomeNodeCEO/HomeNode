import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";
import { createCorsMiddleware } from "../src/security/httpSecurity.js";

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

async function startRouter(options, { cors = false } = {}) {
  const app = express();
  if (cors) app.use(createCorsMiddleware({ corsOrigins: ["https://frontend.example"] }));
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
  assert.equal(loadResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await loadResponse.json(), {
    ok: true, account_id: "CANONICAL_1", workfile,
  });
  const readinessResponse = await fetch(endpoint(server.baseUrl, "/readiness"));
  assert.equal(readinessResponse.status, 200);
  assert.equal(readinessResponse.headers.get("cache-control"), "no-store");
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
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: "custom_appraisal_assignment_access_denied",
    });
  }
  assert.deepEqual(serviceCalls, []);
});

test("signed snapshot downloads are no-store while preserving immutability, checksum, and filenames", async (context) => {
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
  assert.equal(response.headers.get("cache-control"), "no-store");
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
  assert.equal(response.headers.get("cache-control"), "no-store");
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

test("draft PDF overload is retryable while signed reads remain available", { timeout: 5_000 }, async (context) => {
  let releaseRenders;
  const pausedRenders = new Promise((resolve) => { releaseRenders = resolve; });
  let markTwoStarted;
  const twoStarted = new Promise((resolve) => { markTwoStarted = resolve; });
  let active = 0;
  let peak = 0;
  const pdf = {
    canonical_file_name: "report.pdf",
    content: Buffer.from("pdf-test"),
    page_count: 1,
    content_sha256: "test-sha",
  };
  const server = await startRouter(baseOptions({
    getDownload: async (_pool, { assignmentFileId }) => ({
      immutable: assignmentFileId === 42,
      snapshot: {},
    }),
    getReportPdf: async (_pool, { download }) => {
      if (download.immutable) return { ...pdf, immutable: true };
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) markTwoStarted();
      await pausedRenders;
      active -= 1;
      return { ...pdf, immutable: false };
    },
  }));
  context.after(async () => { releaseRenders(); await server.close(); });

  const first = fetch(endpoint(server.baseUrl, "/report.pdf"));
  const second = fetch(endpoint(server.baseUrl, "/report.pdf"));
  await twoStarted;
  const busy = await fetch(endpoint(server.baseUrl, "/report.pdf"));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "2");
  assert.equal(busy.headers.get("cache-control"), "no-store");
  assert.equal(busy.headers.get("content-disposition"), null);
  assert.deepEqual(await busy.json(), { error: "custom_appraisal_report_busy" });
  assert.equal(peak, 2);

  const signed = await fetch(`${server.baseUrl}/api/accounts/account_1/assignment-files/42/workfile/report.pdf`);
  assert.equal(signed.status, 200);
  assert.equal(signed.headers.get("x-homenode-immutable"), "true");
  releaseRenders();
  assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200]);
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 200);
});

test("failed draft PDF renders release overload slots", async (context) => {
  let calls = 0;
  const server = await startRouter(baseOptions({
    getDownload: async () => ({ immutable: false, snapshot: {} }),
    getReportPdf: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("private renderer diagnostic");
      return {
        canonical_file_name: "report.pdf",
        immutable: false,
        content: Buffer.from("pdf-test"),
        page_count: 1,
        content_sha256: "test-sha",
      };
    },
  }));
  context.after(server.close);
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 500);
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 500);
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 200);
  assert.equal(calls, 3);
});

test("disconnect before draft admission does not render or occupy a slot", { timeout: 5_000 }, async (context) => {
  let releaseLookup;
  const pendingLookup = new Promise((resolve) => { releaseLookup = resolve; });
  let markLookupStarted;
  const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve; });
  let markResponseClosed;
  const responseClosed = new Promise((resolve) => { markResponseClosed = resolve; });
  let firstAccess = true;
  let firstLookup = true;
  let renders = 0;
  const server = await startRouter(baseOptions({
    requireAssignmentAccess: async (_req, res) => {
      if (firstAccess) {
        firstAccess = false;
        res.once("close", markResponseClosed);
      }
      return true;
    },
    getDownload: async () => {
      if (firstLookup) {
        firstLookup = false;
        markLookupStarted();
        await pendingLookup;
      }
      return { immutable: false, snapshot: {} };
    },
    getReportPdf: async () => {
      renders += 1;
      return {
        canonical_file_name: "report.pdf",
        immutable: false,
        content: Buffer.from("pdf-test"),
        page_count: 1,
        content_sha256: "test-sha",
      };
    },
  }));
  context.after(async () => { releaseLookup(); await server.close(); });
  const controller = new AbortController();
  const cancelled = fetch(endpoint(server.baseUrl, "/report.pdf"), { signal: controller.signal });
  await lookupStarted;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  await responseClosed;
  releaseLookup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renders, 0);
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 200);
  assert.equal(renders, 1);
});

test("disconnect during draft rendering releases its slot after rendering settles", { timeout: 5_000 }, async (context) => {
  let releaseAborted;
  const abortedRender = new Promise((resolve) => { releaseAborted = resolve; });
  let releaseFresh;
  const freshRender = new Promise((resolve) => { releaseFresh = resolve; });
  let markAbortedStarted;
  const abortedStarted = new Promise((resolve) => { markAbortedStarted = resolve; });
  let markFreshStarted;
  const freshStarted = new Promise((resolve) => { markFreshStarted = resolve; });
  let markResponseClosed;
  const responseClosed = new Promise((resolve) => { markResponseClosed = resolve; });
  let firstAccess = true;
  let renders = 0;
  const pdf = {
    canonical_file_name: "report.pdf",
    immutable: false,
    content: Buffer.from("pdf-test"),
    page_count: 1,
    content_sha256: "test-sha",
  };
  const server = await startRouter(baseOptions({
    requireAssignmentAccess: async (_req, res) => {
      if (firstAccess) {
        firstAccess = false;
        res.once("close", markResponseClosed);
      }
      return true;
    },
    getDownload: async () => ({ immutable: false, snapshot: {} }),
    getReportPdf: async () => {
      const currentRender = ++renders;
      if (currentRender === 1) { markAbortedStarted(); await abortedRender; }
      if (currentRender === 2) { markFreshStarted(); await freshRender; }
      return pdf;
    },
  }));
  context.after(async () => { releaseAborted(); releaseFresh(); await server.close(); });
  const controller = new AbortController();
  const cancelled = fetch(endpoint(server.baseUrl, "/report.pdf"), { signal: controller.signal });
  await abortedStarted;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  await responseClosed;
  const firstFresh = fetch(endpoint(server.baseUrl, "/report.pdf"));
  await freshStarted;
  const busy = await fetch(endpoint(server.baseUrl, "/report.pdf"));
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: "custom_appraisal_report_busy" });
  releaseAborted();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await fetch(endpoint(server.baseUrl, "/report.pdf"))).status, 200);
  releaseFresh();
  assert.equal((await firstFresh).status, 200);
  assert.equal(renders, 3);
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
  assert.equal(missingResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missingResponse.json(), { error: "assignment_file_not_found" });
  const invalidResponse = await fetch(endpoint(missing.baseUrl, "/readiness"));
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalidResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await invalidResponse.json(), { error: "invalid_readiness_state" });
  for (const suffix of ["/download", "/report.pdf"]) {
    const response = await fetch(endpoint(unavailable.baseUrl, suffix));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: "custom_appraisal_signing_secret_not_configured",
    });
  }
  const failedLoad = await fetch(endpoint(failed.baseUrl));
  assert.equal(failedLoad.status, 500);
  assert.equal(failedLoad.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failedLoad.json(), { error: "custom_appraisal_workfile_load_failed" });
  const failedReport = await fetch(endpoint(failed.baseUrl, "/report.pdf"));
  assert.equal(failedReport.status, 500);
  assert.equal(failedReport.headers.get("cache-control"), "no-store");
  assert.deepEqual(await failedReport.json(), { error: "custom_appraisal_report_pdf_failed" });
  assert.deepEqual(logs, [
    ["custom appraisal workfile load failed", "unknown"],
    ["custom appraisal report PDF failed", "unknown"],
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /secret-token/);
});

test("workfile read responses capture exact error messages only once", async (context) => {
  const privateDetail = "PRIVATE_DATABASE_AND_SIGNING_SECRET";
  for (const [suffix, firstCode, status, dependency] of [
    ["", "assignment_file_not_found", 404, "getWorkfile"],
    ["/readiness", "invalid_readiness_state", 400, "getReadiness"],
    ["/download", "custom_appraisal_signing_secret_not_configured", 503, "getDownload"],
    ["/report.pdf", "custom_appraisal_signing_secret_not_configured", 503, "getDownload"],
  ]) {
    await context.test(suffix || "workfile", async (child) => {
      let reads = 0;
      const failure = {
        get message() {
          reads += 1;
          return reads === 1 ? firstCode : privateDetail;
        },
      };
      const server = await startRouter(baseOptions({
        [dependency]: async () => { throw failure; },
      }));
      child.after(server.close);
      const response = await fetch(endpoint(server.baseUrl, suffix));
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: firstCode });
      assert.equal(reads, 1);
    });
  }
});

test("unexpected invalid-prefixed failures stay private even when logging fails", async (context) => {
  const diagnostic = new Error("invalid_internal_database secret-token");
  const logger = { error() { throw new Error("logger_unavailable"); } };
  const readServer = await startRouter(baseOptions({
    getWorkfile: async () => { throw diagnostic; },
    getReadiness: async () => { throw diagnostic; },
    logger,
  }));
  const downloadServer = await startRouter(baseOptions({
    getDownload: async () => { throw diagnostic; },
    logger,
  }));
  const pdfServer = await startRouter(baseOptions({
    getDownload: async () => ({ immutable: false, snapshot: {} }),
    getReportPdf: async () => { throw diagnostic; },
    logger,
  }));
  context.after(async () => Promise.all([
    readServer.close(), downloadServer.close(), pdfServer.close(),
  ]));

  for (const [server, suffix, code] of [
    [readServer, "", "custom_appraisal_workfile_load_failed"],
    [readServer, "/readiness", "custom_appraisal_workfile_readiness_failed"],
    [downloadServer, "/download", "custom_appraisal_workfile_download_failed"],
    [pdfServer, "/report.pdf", "custom_appraisal_report_pdf_failed"],
  ]) {
    const response = await fetch(endpoint(server.baseUrl, suffix));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: code });
    assert.doesNotMatch(JSON.stringify(body), /secret-token|logger_unavailable/);
  }
});

test("workfile conditional requests reauthorize after access changes and HEAD remains no-store", async (context) => {
  let accessAllowed = true;
  let authenticated = true;
  let serviceCalls = 0;
  const server = await startRouter(baseOptions({
    requireWorkflowAccess(_req, res) {
      if (authenticated) return true;
      res.status(401).json({ error: "authentication_required" });
      return false;
    },
    async requireAssignmentAccess(_req, res) {
      if (accessAllowed) return true;
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" });
      return false;
    },
    getWorkfile: async () => { serviceCalls += 1; return { status: "signed" }; },
    getReadiness: async () => { serviceCalls += 1; return { ready: true }; },
    getDownload: async () => {
      serviceCalls += 1;
      return {
        canonical_file_name: "signed.json", immutable: true,
        checksum_sha256: "signed-checksum", snapshot: { status: "signed" },
      };
    },
    getReportPdf: async () => {
      serviceCalls += 1;
      return {
        canonical_file_name: "signed.pdf", immutable: true,
        content: Buffer.from("%PDF-signed"), content_sha256: "pdf-checksum", page_count: 1,
      };
    },
  }));
  context.after(server.close);

  for (const suffix of ["", "/readiness", "/download", "/report.pdf"]) {
    accessAllowed = true;
    authenticated = true;
    const allowed = await fetch(endpoint(server.baseUrl, suffix));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    const etag = allowed.headers.get("etag");
    assert.ok(etag);
    await allowed.arrayBuffer();
    const head = await fetch(endpoint(server.baseUrl, suffix), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("cache-control"), "no-store");
    assert.equal(await head.text(), "");
    const authorizedCalls = serviceCalls;
    accessAllowed = false;
    for (const method of ["GET", "HEAD"]) {
      const denied = await fetch(endpoint(server.baseUrl, suffix), {
        method, headers: { "if-none-match": etag },
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("cache-control"), "no-store");
      await denied.arrayBuffer();
    }
    authenticated = false;
    const anonymous = await fetch(endpoint(server.baseUrl, suffix), {
      headers: { "if-none-match": etag },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    await anonymous.arrayBuffer();
    assert.equal(serviceCalls, authorizedCalls);
  }
  const unrelated = await fetch(`${server.baseUrl}/api/accounts/account_1/assignment-files/41/workfile-public`);
  assert.equal(unrelated.headers.get("cache-control"), null);
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
  const composition = fs.readFileSync(new URL("../src/modules/assignmentFiles/workfileRouter.js", import.meta.url), "utf8");
  const mutations = source.indexOf("app.use(createAssignmentFileMutationRouter(");
  const workfiles = source.indexOf("app.use(createAssignmentWorkfileRouter(");
  const reads = composition.indexOf("router.use(createAssignmentWorkfileReadRouter(");
  const sections = composition.indexOf("router.use(createAssignmentWorkfileMutationRouter(");
  assert.ok(workfiles > mutations);
  assert.ok(sections > reads);
  assert.equal(source.includes('app.get("/api/accounts/:id/assignment-files/:fileId/workfile"'), false);
  assert.equal(source.includes("workfile/readiness"), false);
  assert.equal(source.includes("workfile/download"), false);
  assert.equal(source.includes("workfile/report.pdf"), false);
});

const DOWNLOAD_EXPOSURE = "Content-Disposition, X-HomeNode-Immutable";
const PDF_EXPOSURE = `${DOWNLOAD_EXPOSURE}, X-HomeNode-Report-Pages`;
const originHeaders = { Origin: "https://frontend.example" };
function assertNoDownloadMetadata(response) {
  for (const name of ["access-control-expose-headers", "content-disposition", "x-homenode-immutable", "x-homenode-report-pages"]) {
    assert.equal(response.headers.get(name), null, name);
  }
}

for (const immutable of [false, true]) for (const suffix of ["/download", "/report.pdf"]) {
  test(`${immutable ? "signed" : "draft"} ${suffix} exposes only its fixed metadata through allowed CORS`, async context => {
    const download = { canonical_file_name: 'canonical"\r\n-41.json', immutable, checksum_sha256: "original-json-sha",
      snapshot: { status: immutable ? "signed" : "draft", original: "retained UTF-8 École" } };
    const report = { canonical_file_name: 'canonical"\r\n-41.pdf', immutable, content: Buffer.from("%PDF-original-bytes"),
      content_sha256: "original-pdf-sha", page_count: 17 };
    const calls = [];
    const server = await startRouter(baseOptions({
      requireWorkflowAccess(_req, _res, workflow, permission) {
        assert.equal(workflow, "custom_appraisal"); assert.equal(permission, "read"); calls.push("workflow"); return true;
      },
      requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
        assert.equal(accountId, "ACCOUNT_1"); assert.equal(fileId, 41); assert.equal(permission, "read"); calls.push("assignment"); return true;
      },
      getDownload: async () => { calls.push("download"); return download; },
      getReportPdf: async () => { calls.push("pdf"); return report; },
    }), { cors: true });
    context.after(server.close);
    const response = await fetch(endpoint(server.baseUrl, suffix), { headers: originHeaders });
    const pdf = suffix === "/report.pdf";
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example");
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("vary"), /(?:^|,\s*)Origin(?:,|$)/i);
    // Node fetch does not enforce browser header filtering. Assert the explicit
    // wire exposure contract, not just headers that Node could read regardless.
    assert.equal(response.headers.get("access-control-expose-headers"), pdf ? PDF_EXPOSURE : DOWNLOAD_EXPOSURE);
    assert.doesNotMatch(response.headers.get("access-control-expose-headers"), /\*|etag|authorization|cookie/i);
    assert.equal(response.headers.get("content-disposition"), `attachment; filename="canonical___-41.${pdf ? "pdf" : "json"}"`);
    assert.equal(response.headers.get("x-homenode-immutable"), String(immutable));
    assert.equal(response.headers.get("x-homenode-report-pages"), pdf ? "17" : null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("etag"), pdf ? '"original-pdf-sha"' : '"original-json-sha"');
    assert.equal(response.headers.get("content-type"), pdf ? "application/pdf" : "application/json; charset=utf-8");
    if (pdf) {
      assert.equal(response.headers.get("content-length"), String(report.content.length));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), report.content);
    } else assert.equal(await response.text(), `${JSON.stringify(download.snapshot, null, 2)}\n`);
    assert.deepEqual(calls, pdf ? ["workflow", "assignment", "download", "pdf"] : ["workflow", "assignment", "download"]);
  });
}

test("download metadata exposure does not widen origins, preflight, or ordinary responses", async context => {
  const calls = [];
  const server = await startRouter(baseOptions({
    requireWorkflowAccess() { calls.push("workflow"); return true; },
    getWorkfile: async () => { calls.push("workfile"); return { status: "draft" }; },
    getReadiness: async () => { calls.push("readiness"); return { ready: false }; },
  }), { cors: true });
  context.after(server.close);
  for (const suffix of ["/download", "/report.pdf"]) {
    const denied = await fetch(endpoint(server.baseUrl, suffix), { headers: { Origin: "https://untrusted.example" } });
    assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: "cors_origin_denied" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null); assertNoDownloadMetadata(denied);
    const preflight = await fetch(endpoint(server.baseUrl, suffix), { method: "OPTIONS", headers: {
      ...originHeaders, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Authorization",
    } });
    assert.equal(preflight.status, 204); assertNoDownloadMetadata(preflight);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://frontend.example");
    assert.match(preflight.headers.get("access-control-allow-headers"), /(?:^|,\s*)Authorization(?:,|$)/i);
  }
  assert.deepEqual(calls, []);
  for (const suffix of ["", "/readiness"]) {
    const response = await fetch(endpoint(server.baseUrl, suffix), { headers: originHeaders });
    assert.equal(response.status, 200); assertNoDownloadMetadata(response);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example");
    assert.equal(response.headers.get("cache-control"), "no-store"); await response.json();
  }
  const unrelated = await fetch(`${server.baseUrl}/unrelated`, { headers: originHeaders });
  assert.equal(unrelated.status, 404); assertNoDownloadMetadata(unrelated); await unrelated.text();
  assert.deepEqual(calls, ["workflow", "workfile", "workflow", "readiness"]);
});

for (const deniedAt of ["workflow", "assignment"]) test(`allowed CORS cannot expose download metadata after ${deniedAt} denial`, async context => {
  let serviceCalls = 0;
  const server = await startRouter(baseOptions({
    requireWorkflowAccess(_req, res) {
      if (deniedAt !== "workflow") return true;
      res.status(401).json({ error: "authentication_required" }); return false;
    },
    requireAssignmentAccess: async (_req, res) => {
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" }); return false;
    },
    getDownload: async () => { serviceCalls++; throw new Error("must not read a denied file"); },
    getReportPdf: async () => { serviceCalls++; throw new Error("must not render a denied file"); },
  }), { cors: true });
  context.after(server.close);
  for (const suffix of ["/download", "/report.pdf"]) for (const method of ["GET", "HEAD"]) {
    const response = await fetch(endpoint(server.baseUrl, suffix), { method, headers: originHeaders });
    assert.equal(response.status, deniedAt === "workflow" ? 401 : 403); assertNoDownloadMetadata(response);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://frontend.example");
    assert.equal(response.headers.get("cache-control"), "no-store"); await response.arrayBuffer();
  }
  assert.equal(serviceCalls, 0);
});

for (const suffix of ["/download", "/report.pdf"]) test(`${suffix} service failure exposes no success metadata or private error text`, async context => {
  const error = new Error("private database hostname and token");
  const server = await startRouter(baseOptions({
    getDownload: async () => { if (suffix === "/download") throw error; return { immutable: false, snapshot: {} }; },
    getReportPdf: async () => { throw error; },
  }), { cors: true });
  context.after(server.close);
  const response = await fetch(endpoint(server.baseUrl, suffix), { headers: originHeaders });
  assert.equal(response.status, 500); assertNoDownloadMetadata(response);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: suffix === "/download" ? "custom_appraisal_workfile_download_failed" : "custom_appraisal_report_pdf_failed" });
});
