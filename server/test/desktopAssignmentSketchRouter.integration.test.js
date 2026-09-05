import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createDesktopAssignmentSketchRouter } from "../src/modules/mobile/desktopAssignmentSketchRouter.js";

const identity = Object.freeze({ userId: "user-1" });

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountQualityReady: Promise.resolve(),
    propertyEnrichmentReady: Promise.resolve(),
    ensureAssignmentFilesAvailable: async () => {},
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    normalizeAssignmentId: (value) => Number(value),
    getSketch: async () => { throw new Error("unexpected_get_sketch"); },
    saveSketch: async () => { throw new Error("unexpected_save_sketch"); },
    renderSvg: () => { throw new Error("unexpected_svg_render"); },
    renderPdf: async () => { throw new Error("unexpected_pdf_render"); },
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
  app.use(createDesktopAssignmentSketchRouter(options));
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

function patchSketch(baseUrl, accountId, fileId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/assignment-files/${fileId}/mobile-sketch`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("desktop assignment sketch gates preserve authorization and validation order", async (context) => {
  let normalizeCalls = 0;
  let editorCalls = 0;
  let workflowCalls = 0;
  let accessCalls = 0;
  const common = {
    normalizeAssignmentId: () => { normalizeCalls += 1; return 1; },
    requireEditor: () => { editorCalls += 1; return true; },
    requireAssignmentAccess: async () => { accessCalls += 1; return true; },
  };
  const accepted = await startRouter(baseOptions({
    ...common,
    requireWorkflowAccess: () => { workflowCalls += 1; return true; },
  }));
  const denied = await startRouter(baseOptions({
    ...common,
    requireWorkflowAccess(_req, res) {
      workflowCalls += 1;
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }));
  context.after(async () => Promise.all([accepted.close(), denied.close()]));

  const deniedPreview = await fetch(
    `${denied.baseUrl}/api/accounts/123/assignment-files/1/mobile-sketch/preview.svg`,
  );
  assert.equal(deniedPreview.status, 403);
  assert.deepEqual(await deniedPreview.json(), { error: "workflow_access_denied" });

  const invalidPreview = await fetch(
    `${accepted.baseUrl}/api/accounts/bad%20id/assignment-files/1/mobile-sketch/preview.svg`,
  );
  assert.equal(invalidPreview.status, 400);
  assert.deepEqual(await invalidPreview.json(), { error: "invalid_account_id" });

  const invalidUpdate = await patchSketch(accepted.baseUrl, "bad%20id", 1);
  assert.equal(invalidUpdate.status, 400);
  assert.deepEqual(await invalidUpdate.json(), { error: "invalid_account_id" });
  assert.equal(workflowCalls, 2);
  assert.equal(editorCalls, 0);
  assert.equal(normalizeCalls, 0);
  assert.equal(accessCalls, 0);
});

test("SVG preview preserves readiness, assignment authorization, rendering, and safe headers", async (context) => {
  const calls = [];
  const sketch = { id: "sketch-1", document: { areas: [], rooms: [] } };
  const artifactOptions = { fileNumber: "A / bad", revision: 3 };
  const options = baseOptions({
    ensureAssignmentFilesAvailable: async () => { calls.push("assignment-schema"); },
    ensureCustomAppraisalWorkfilesAvailable: async () => { calls.push("workfile-schema"); },
    resolveAccountId: async (pool, value) => {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    requireAssignmentAccess: async (req, res, accountId, fileId, permission) => {
      calls.push({ type: "access", req, res, accountId, fileId, permission });
      return true;
    },
    getSketch: async (pool, accountId, fileId) => {
      calls.push({ type: "get", pool, accountId, fileId });
      return { sketch, artifact_options: artifactOptions };
    },
    renderSvg: (receivedSketch, receivedOptions) => {
      calls.push({ type: "svg", receivedSketch, receivedOptions });
      return "<svg>safe</svg>";
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/legacy_1/assignment-files/7/mobile-sketch/preview.svg`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<svg>safe</svg>");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("content-disposition"),
    'inline; filename="A___bad-measured-sketch.svg"',
  );
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
  assert.equal(calls.filter((call) => call === "assignment-schema").length, 1);
  assert.equal(calls.filter((call) => call === "workfile-schema").length, 1);
  const access = calls.find((call) => call.type === "access");
  assert.deepEqual(
    { accountId: access.accountId, fileId: access.fileId, permission: access.permission },
    { accountId: "CANONICAL_1", fileId: 7, permission: "read" },
  );
  const loaded = calls.find((call) => call.type === "get");
  assert.equal(loaded.pool, options.pool);
  assert.deepEqual({ accountId: loaded.accountId, fileId: loaded.fileId }, {
    accountId: "CANONICAL_1",
    fileId: 7,
  });
  const rendered = calls.find((call) => call.type === "svg");
  assert.equal(rendered.receivedSketch, sketch);
  assert.equal(rendered.receivedOptions, artifactOptions);
});

test("PDF download preserves report rendering and attachment headers", async (context) => {
  const pdf = Buffer.from("%PDF-test");
  const sketch = { id: "sketch-1" };
  const artifactOptions = { fileNumber: "HN-2026.1" };
  let renderCall = null;
  const server = await startRouter(baseOptions({
    getSketch: async () => ({ sketch, artifact_options: artifactOptions }),
    renderPdf: async (receivedSketch, receivedOptions) => {
      renderCall = { receivedSketch, receivedOptions };
      return pdf;
    },
  }));
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/123/assignment-files/1/mobile-sketch/report.pdf`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="HN-2026.1-measured-sketch.pdf"',
  );
  assert.match(response.headers.get("content-type"), /^application\/pdf/);
  assert.deepEqual(renderCall, { receivedSketch: sketch, receivedOptions: artifactOptions });
});

test("artifact routes preserve not-found, validation, and diagnostic-safe failures", async (context) => {
  const errors = [];
  const missing = await startRouter(baseOptions({ getSketch: async () => null }));
  const invalid = await startRouter(baseOptions({
    normalizeAssignmentId: () => { throw new Error("invalid_assignment_file_id"); },
  }));
  const failed = await startRouter(baseOptions({
    getSketch: async () => ({ sketch: {}, artifact_options: { fileNumber: "file" } }),
    renderSvg: () => { throw Object.assign(new Error("database_password=secret"), { code: "XX000" }); },
    renderPdf: async () => { throw Object.assign(new Error("database_password=secret"), { code: "XX000" }); },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(async () => Promise.all([missing.close(), invalid.close(), failed.close()]));

  const missingResponse = await fetch(
    `${missing.baseUrl}/api/accounts/123/assignment-files/1/mobile-sketch/preview.svg`,
  );
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "assignment_sketch_not_found" });

  const invalidResponse = await fetch(
    `${invalid.baseUrl}/api/accounts/123/assignment-files/bad/mobile-sketch/preview.svg`,
  );
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: "invalid_assignment_file_id" });

  for (const [path, expectedError] of [
    ["preview.svg", "assignment_sketch_svg_failed"],
    ["report.pdf", "assignment_sketch_pdf_failed"],
  ]) {
    const response = await fetch(
      `${failed.baseUrl}/api/accounts/123/assignment-files/1/mobile-sketch/${path}`,
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: expectedError });
    assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  }
  assert.equal(errors.length, 2);
});

test("desktop sketch saves bind canonical assignment, request body, and authenticated actor", async (context) => {
  const calls = [];
  const body = { expected_revision: 2, reviewer: "Reviewer", sketch: { areas: [], rooms: [] } };
  const result = { sketch: { id: "sketch-1", revision: 3 }, report_registry_revision: 8 };
  const options = baseOptions({
    ensureAssignmentFilesAvailable: async () => { calls.push("assignment-schema"); },
    ensureCustomAppraisalWorkfilesAvailable: async () => { calls.push("unexpected-workfile-schema"); },
    resolveAccountId: async () => "CANONICAL_1",
    requireAssignmentAccess: async (_req, _res, accountId, fileId, permission) => {
      calls.push({ type: "access", accountId, fileId, permission });
      return true;
    },
    getSketch: async () => null,
    saveSketch: async (pool, accountId, fileId, input, actorUserId) => {
      calls.push({ type: "save", pool, accountId, fileId, input, actorUserId });
      return result;
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await patchSketch(server.baseUrl, "legacy_1", 9, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ...result });
  assert.equal(calls.includes("assignment-schema"), true);
  assert.equal(calls.includes("unexpected-workfile-schema"), false);
  assert.deepEqual(calls.find((call) => call.type === "access"), {
    type: "access",
    accountId: "CANONICAL_1",
    fileId: 9,
    permission: "write",
  });
  const saved = calls.find((call) => call.type === "save");
  assert.equal(saved.pool, options.pool);
  assert.deepEqual({
    accountId: saved.accountId,
    fileId: saved.fileId,
    input: saved.input,
    actorUserId: saved.actorUserId,
  }, {
    accountId: "CANONICAL_1",
    fileId: 9,
    input: body,
    actorUserId: "user-1",
  });
});

test("appraiser-confirmed assignment sketches require sign authority before saving", async (context) => {
  const permissions = [];
  let saveCalls = 0;
  const server = await startRouter(baseOptions({
    requireAssignmentAccess: async (_req, res, _accountId, _fileId, permission) => {
      permissions.push(permission);
      if (permission === "sign") {
        res.status(403).json({ error: "assignment_file_access_denied" });
        return false;
      }
      return true;
    },
    saveSketch: async () => {
      saveCalls += 1;
      return { sketch: { id: "unexpected" } };
    },
  }), identity);
  context.after(server.close);

  for (const reviewStatus of ["appraiser_confirmed", " appraiser_confirmed "]) {
    const response = await patchSketch(server.baseUrl, "123", 1, {
      expected_revision: 1,
      sketch: { review_status: reviewStatus },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "assignment_file_access_denied" });
  }
  assert.deepEqual(permissions, ["sign", "sign"]);
  assert.equal(saveCalls, 0);
});

test("reversing an appraiser-confirmed assignment sketch also requires sign authority", async (context) => {
  const permissions = [];
  let saveCalls = 0;
  const server = await startRouter(baseOptions({
    getSketch: async () => ({ sketch: { review_status: "appraiser_confirmed" } }),
    requireAssignmentAccess: async (_req, res, _accountId, _fileId, permission) => {
      permissions.push(permission);
      if (permission === "sign") {
        res.status(403).json({ error: "assignment_file_access_denied" });
        return false;
      }
      return true;
    },
    saveSketch: async () => {
      saveCalls += 1;
      return { sketch: { id: "unexpected" } };
    },
  }), identity);
  context.after(server.close);

  const response = await patchSketch(server.baseUrl, "123", 1, {
    expected_revision: 2,
    sketch: { review_status: "draft" },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "assignment_file_access_denied" });
  assert.deepEqual(permissions, ["write", "sign"]);
  assert.equal(saveCalls, 0);
});

test("desktop sketch save errors retain revision, operation, validation, and bounded responses", async (context) => {
  const errors = [];
  const server = await startRouter(baseOptions({
    getSketch: async () => null,
    saveSketch: async (_pool, _accountId, fileId) => {
      const messages = {
        1: "assignment_sketch_not_found",
        2: "sketch_revision_conflict",
        3: "invalid_sketch_expected_revision",
        4: "duplicate_room_id",
        5: "sketch_not_ready_for_confirmation",
        6: "sketch_operation_conflict",
        7: "database_password=secret",
      };
      const error = new Error(messages[fileId]);
      if (fileId === 2) error.currentRevision = 11;
      throw error;
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  for (const [fileId, status, body] of [
    [1, 404, { error: "assignment_sketch_not_found" }],
    [2, 409, { error: "sketch_revision_conflict", current_revision: 11 }],
    [3, 400, { error: "invalid_sketch_expected_revision" }],
    [4, 400, { error: "duplicate_room_id" }],
    [5, 400, { error: "sketch_not_ready_for_confirmation" }],
    [6, 409, { error: "sketch_operation_conflict" }],
    [7, 500, { error: "assignment_sketch_update_failed" }],
  ]) {
    const response = await patchSketch(server.baseUrl, "123", fileId);
    assert.equal(response.status, status);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, body);
    assert.doesNotMatch(JSON.stringify(responseBody), /password|secret/);
  }
  assert.equal(errors.length, 1);
});

test("desktop assignment sketch composition and route position remain explicit", () => {
  assert.throws(
    () => createDesktopAssignmentSketchRouter(),
    /desktop_assignment_sketch_pool_required/,
  );
  assert.throws(
    () => createDesktopAssignmentSketchRouter(baseOptions({ accountQualityReady: null })),
    /desktop_assignment_sketch_account_readiness_required/,
  );
  assert.throws(
    () => createDesktopAssignmentSketchRouter(baseOptions({ requireWorkflowAccess: null })),
    /desktop_assignment_sketch_workflow_policy_required/,
  );
  assert.throws(
    () => createDesktopAssignmentSketchRouter(baseOptions({ requireAssignmentAccess: null })),
    /desktop_assignment_sketch_assignment_policy_required/,
  );
  assert.throws(
    () => createDesktopAssignmentSketchRouter(baseOptions({ getSketch: null })),
    /desktop_assignment_sketch_service_required/,
  );
  assert.throws(
    () => createDesktopAssignmentSketchRouter(baseOptions({ renderSvg: null })),
    /desktop_assignment_sketch_renderer_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const history = source.indexOf("app.use(createAppraisalHistoryRouter(");
  const sketches = source.indexOf("app.use(createDesktopAssignmentSketchRouter(");
  const propertyTax = source.indexOf("app.use(createDesktopPropertyTaxRouter(");
  assert.ok(sketches > history);
  assert.ok(propertyTax > sketches);
  assert.equal(source.includes("/mobile-sketch/preview.svg"), false);
  assert.equal(source.includes("/mobile-sketch/report.pdf"), false);
  assert.equal(source.includes('app.patch("/api/accounts/:id/assignment-files/:fileId/mobile-sketch"'), false);
});
