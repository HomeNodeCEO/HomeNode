import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAssignmentFileListRouter } from "../src/modules/assignmentFiles/listRouter.js";

function assignmentRow(overrides = {}) {
  return {
    id: "1",
    account_id: "CANONICAL_1",
    file_number: "2026-001",
    assignment_details: { purpose: "purchase" },
    organization_id: "org-1",
    assigned_appraiser_user_id: "user-1",
    supervisory_appraiser_user_id: null,
    inherited_from_file_id: null,
    inherited_from_file_number: null,
    reviewer: "Reviewer",
    revision: "2",
    created_at: "2026-09-02T10:00:00.000Z",
    updated_at: "2026-09-02T11:00:00.000Z",
    workfile_key: null,
    canonical_file_name: null,
    workfile_status: null,
    workfile_signed_at: null,
    workfile_signed_by: null,
    workfile_updated_at: null,
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    accountQualityReady: Promise.resolve(),
    propertyEnrichmentReady: Promise.resolve(),
    ensureAssignmentFilesAvailable: async () => {},
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireWorkflowAccess: () => true,
    authenticationRequired: false,
    sharedObjectStorage: { configured: false },
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    decideAccess: () => true,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options, identity = null) {
  const app = express();
  if (identity) {
    app.use((req, _res, next) => {
      req.mobileAuth = identity;
      next();
    });
  }
  app.use(createAssignmentFileListRouter(options));
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

test("assignment-file list authorizes and validates before database access", async (context) => {
  let queryCalls = 0;
  let workflowCalls = 0;
  const pool = {
    async query() {
      queryCalls += 1;
      throw new Error("unexpected_query");
    },
  };
  const accepted = await startRouter(baseOptions({
    pool,
    requireWorkflowAccess() {
      workflowCalls += 1;
      return true;
    },
  }));
  const invalidAssignment = await startRouter(baseOptions({
    pool,
    normalizeAssignmentId: () => null,
    requireWorkflowAccess() {
      workflowCalls += 1;
      return true;
    },
  }));
  const denied = await startRouter(baseOptions({
    pool,
    requireWorkflowAccess(_req, res) {
      workflowCalls += 1;
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }));
  context.after(async () => Promise.all([
    accepted.close(), invalidAssignment.close(), denied.close(),
  ]));

  const invalidAccountResponse = await fetch(
    `${accepted.baseUrl}/api/accounts/bad%20id/assignment-files`,
  );
  assert.equal(invalidAccountResponse.status, 400);
  assert.deepEqual(await invalidAccountResponse.json(), { error: "invalid_account_id" });

  const invalidAssignmentResponse = await fetch(
    `${invalidAssignment.baseUrl}/api/accounts/123/assignment-files?assignment_file_id=bad`,
  );
  assert.equal(invalidAssignmentResponse.status, 400);
  assert.deepEqual(await invalidAssignmentResponse.json(), { error: "invalid_assignment_file_id" });

  const deniedResponse = await fetch(`${denied.baseUrl}/api/accounts/123/assignment-files`);
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "workflow_access_denied" });
  assert.equal(workflowCalls, 3);
  assert.equal(queryCalls, 0);
});

test("enforced assignment-file listing filters before loading details and signs only authorized photos", async (context) => {
  const queries = [];
  const accessChecks = [];
  const signedObjects = [];
  const authorized = assignmentRow();
  const denied = assignmentRow({
    id: "2",
    file_number: "2026-002",
    organization_id: "org-2",
    assigned_appraiser_user_id: "user-2",
  });
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files f/.test(sql)) {
        return { rows: [authorized, denied], rowCount: 2 };
      }
      if (/FROM app\.custom_appraisal_sections/.test(sql)) {
        return { rows: [{
          assignment_file_id: "1",
          section_key: "subject",
          section_value: { address: "100 Main" },
          revision: "3",
          last_applied_session_id: "session-1",
          updated_at: "2026-09-02T11:00:00.000Z",
        }] };
      }
      if (/JOIN app\.inspection_photos/.test(sql)) {
        return { rows: [{
          assignment_file_id: "1",
          id: "photo-1",
          client_photo_id: "client-photo-1",
          origin_channel: "mobile",
          category: "subject_front",
          room_ref: null,
          room_label: null,
          caption: "Front",
          position: "1",
          captured_at: "2026-09-02T09:00:00.000Z",
          status: "verified",
          revision: "2",
          verified_at: "2026-09-02T09:05:00.000Z",
          retention_until: "2031-09-02",
          required_retention_years: "5",
          view_object_key: "photos/photo-1.jpg",
        }] };
      }
      if (/JOIN app\.inspection_sketches/.test(sql)) {
        return { rows: [{
          assignment_file_id: "1",
          id: "sketch-1",
          revision: "4",
          document: { rooms: [] },
          summary: { area: 1800 },
          measurement_standard: "ANSI",
          measurement_method: "laser",
          review_status: "confirmed",
          confirmed_at: "2026-09-02T10:30:00.000Z",
          updated_at: "2026-09-02T10:30:00.000Z",
        }] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const identity = { userId: "user-1", organizations: [] };
  const server = await startRouter(baseOptions({
    pool,
    authenticationRequired: true,
    resolveAccountId: async (receivedPool, requestedId) => {
      assert.equal(receivedPool, pool);
      assert.equal(requestedId, "legacy_1");
      return "CANONICAL_1";
    },
    decideAccess(receivedIdentity, row, permission) {
      accessChecks.push({ receivedIdentity, id: row.id, permission });
      return row.id === "1";
    },
    sharedObjectStorage: {
      configured: true,
      createDownloadUrl(input) {
        signedObjects.push(input);
        return { url: "https://signed.example/photo-1", expires_in_seconds: 300 };
      },
    },
  }), identity);
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/legacy_1/assignment-files`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.account_id, "CANONICAL_1");
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].id, 1);
  assert.deepEqual(body.files[0].custom_appraisal_sections.subject, {
    value: { address: "100 Main" },
    revision: 3,
    last_applied_session_id: "session-1",
    updated_at: "2026-09-02T11:00:00.000Z",
  });
  assert.equal(body.files[0].mobile_inspection_sketch.id, "sketch-1");
  assert.deepEqual(body.files[0].mobile_inspection_photos, [{
    id: "photo-1",
    client_photo_id: "client-photo-1",
    origin_channel: "mobile",
    category: "subject_front",
    room_ref: null,
    room_label: null,
    caption: "Front",
    position: 1,
    captured_at: "2026-09-02T09:00:00.000Z",
    status: "verified",
    revision: 2,
    verified_at: "2026-09-02T09:05:00.000Z",
    retention_until: "2031-09-02",
    required_retention_years: 5,
    view_url: "https://signed.example/photo-1",
    view_url_expires_in_seconds: 300,
  }]);
  assert.equal(body.latest_file.id, 1);
  assert.equal(body.legacy_assignment_details, null);
  assert.deepEqual(accessChecks, [
    { receivedIdentity: identity, id: "1", permission: "read" },
    { receivedIdentity: identity, id: "2", permission: "read" },
  ]);
  assert.deepEqual(signedObjects, [{ objectKey: "photos/photo-1.jpg", expiresInSeconds: 300 }]);
  assert.equal(
    queries.some(({ sql }) => /property_attribute_manual_values/.test(sql)),
    false,
  );
  const detailQueries = queries.filter(({ params }) => Array.isArray(params?.[0]));
  assert.equal(detailQueries.length, 3);
  assert.ok(detailQueries.every(({ params }) => JSON.stringify(params) === "[[1]]"));
});

test("enforced assignment-file filtering does not disclose or hydrate a denied requested file", async (context) => {
  let detailQueries = 0;
  let legacyQueries = 0;
  const pool = {
    async query(sql) {
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files f/.test(sql)) {
        return { rows: [assignmentRow({ id: "2", organization_id: "org-2" })] };
      }
      if (/property_attribute_manual_values/.test(sql)) legacyQueries += 1;
      if (/custom_appraisal_sections|inspection_photos|inspection_sketches/.test(sql)) detailQueries += 1;
      throw new Error("unexpected_query");
    },
  };
  const server = await startRouter(baseOptions({
    pool,
    authenticationRequired: true,
    decideAccess: () => false,
  }), { userId: "user-1" });
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/accounts/123/assignment-files?assignment_file_id=2`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "123",
    files: [],
    latest_file: null,
    legacy_assignment_details: null,
  });
  assert.equal(detailQueries, 0);
  assert.equal(legacyQueries, 0);
});

test("rollout-mode listing still applies identity filtering and hides legacy details", async (context) => {
  let accessChecks = 0;
  const pool = {
    async query(sql) {
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files f/.test(sql)) return { rows: [assignmentRow()] };
      if (/property_attribute_manual_values/.test(sql)) {
        return { rows: [{ attribute_value: { legacy: true } }] };
      }
      if (/custom_appraisal_sections|inspection_photos|inspection_sketches/.test(sql)) {
        return { rows: [] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const server = await startRouter(baseOptions({
    pool,
    decideAccess: () => { accessChecks += 1; return false; },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/abc/assignment-files`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.files.length, 0);
  assert.equal(body.legacy_assignment_details, null);
  assert.equal(accessChecks, 1);
});

test("missing optional mobile detail tables leave the assignment list usable", async (context) => {
  const pool = {
    async query(sql) {
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files f/.test(sql)) return { rows: [assignmentRow()] };
      if (/property_attribute_manual_values/.test(sql)) return { rows: [] };
      if (/FROM app\.custom_appraisal_sections/.test(sql)) {
        throw Object.assign(new Error("missing optional table"), { code: "42P01" });
      }
      if (/inspection_photos|inspection_sketches/.test(sql)) return { rows: [] };
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const server = await startRouter(baseOptions({ pool }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/assignment-files`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.files.length, 1);
  assert.deepEqual(body.files[0].custom_appraisal_sections, {});
  assert.deepEqual(body.files[0].mobile_inspection_photos, []);
  assert.equal(body.files[0].mobile_inspection_sketch, null);
});

test("assignment-file listing returns not found and bounded database failures", async (context) => {
  const notFound = await startRouter(baseOptions({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  }));
  const errors = [];
  const failed = await startRouter(baseOptions({
    pool: {
      async query() {
        throw Object.assign(new Error("database_password=secret"), { code: "XX000" });
      },
    },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(async () => Promise.all([notFound.close(), failed.close()]));

  const missingResponse = await fetch(`${notFound.baseUrl}/api/accounts/404/assignment-files`);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "account_not_found" });

  const failedResponse = await fetch(`${failed.baseUrl}/api/accounts/123/assignment-files`);
  assert.equal(failedResponse.status, 500);
  const body = await failedResponse.json();
  assert.deepEqual(body, { error: "assignment_file_list_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  assert.equal(errors.length, 1);
});

test("assignment-file list composition and route position remain explicit", () => {
  assert.throws(() => createAssignmentFileListRouter(), /assignment_file_list_pool_required/);
  assert.throws(
    () => createAssignmentFileListRouter(baseOptions({ accountQualityReady: null })),
    /assignment_file_list_account_readiness_required/,
  );
  assert.throws(
    () => createAssignmentFileListRouter(baseOptions({ propertyEnrichmentReady: null })),
    /assignment_file_list_enrichment_readiness_required/,
  );
  assert.throws(
    () => createAssignmentFileListRouter(baseOptions({ requireWorkflowAccess: null })),
    /assignment_file_list_workflow_policy_required/,
  );
  assert.throws(
    () => createAssignmentFileListRouter(baseOptions({ authenticationRequired: null })),
    /assignment_file_list_authentication_mode_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const reportManualValues = source.indexOf("app.use(createReportManualValuesRouter(");
  const assignmentFiles = source.indexOf("app.use(createAssignmentFileListRouter(");
  const reportFiles = source.indexOf("app.use(createDesktopReportFilesRouter(");
  assert.ok(assignmentFiles > reportManualValues);
  assert.ok(reportFiles > assignmentFiles);
  assert.equal(source.includes('app.get("/api/accounts/:id/assignment-files"'), false);
});
