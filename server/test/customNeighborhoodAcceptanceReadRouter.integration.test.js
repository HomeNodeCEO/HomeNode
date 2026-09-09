import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";

import express from "express";

import { createAssignmentWorkfileReadRouter } from "../src/modules/assignmentFiles/workfileReadRouter.js";
import { normalizeAssignmentFileId } from "../src/services/assignmentFiles.js";

// HTTP orchestration tests only. The injected reader's representation is not
// evidence of native storage integrity, real authentication, or signing authority.
const AUTH = Object.freeze({
  userId: "abcdef01-0000-4000-8000-000000000001",
  sessionId: "trusted-server-session",
  organizations: Object.freeze([Object.freeze({
    organizationId: "abcdef02-0000-4000-8000-000000000002",
    roles: Object.freeze(["appraiser"]),
  })]),
});
const REPORT = "abcdef03-0000-4000-8000-000000000003";
const OPERATION = "abcdef04-0000-4000-8000-000000000004";
const ABSENT = Object.freeze({
  status: "not_accepted", account_id: "CANONICAL_1", assignment_file_id: 41,
  report_file_id: REPORT, acceptance: null,
});

function optionsFor(calls, overrides = {}) {
  const unexpected = name => async () => {
    calls.push({ type: name });
    assert.fail(`Unexpected dependency: ${name}`);
  };
  return {
    pool: { query: unexpected("query"), connect: unexpected("connect") },
    objectStorage: null,
    requireWorkflowAccess(req, _res, workflow, permission) {
      calls.push({ type: "workflow", auth: req.mobileAuth, workflow, permission });
      return true;
    },
    normalizeFileId(value, options) {
      calls.push({ type: "normalize", value, options });
      return normalizeAssignmentFileId(value, options);
    },
    async ensureCustomAppraisalWorkfilesAvailable() { calls.push({ type: "schema" }); },
    async resolveAccountId(pool, value) {
      calls.push({ type: "resolve", pool, value });
      return "CANONICAL_1";
    },
    async requireAssignmentAccess(req, _res, accountId, assignmentFileId, permission) {
      calls.push({ type: "assignment", auth: req.mobileAuth, accountId, assignmentFileId, permission });
      return true;
    },
    async getNeighborhood(pool, input) {
      calls.push({ type: "neighborhood", pool, input });
      return ABSENT;
    },
    getWorkfile: unexpected("workfile"),
    getReadiness: unexpected("readiness"),
    getDownload: unexpected("download"),
    getReportPdf: unexpected("report"),
    getSigningSecret: unexpected("signing-secret"),
    logger: { error(...args) { calls.push({ type: "log", args }); } },
    ...overrides,
  };
}

async function startRouter(context, options, auth = AUTH) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // A test stand-in for server middleware; never derive this from the request.
    if (auth !== null) req.mobileAuth = auth;
    next();
  });
  app.use(createAssignmentWorkfileReadRouter(options));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  context.after(() => new Promise((resolve, reject) => server.close(error => (
    error ? reject(error) : resolve()
  ))));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

function endpoint(baseUrl, account = "account_1", assignment = "41") {
  return `${baseUrl}/api/accounts/${encodeURIComponent(account)}/assignment-files/${encodeURIComponent(assignment)}/workfile/neighborhood`;
}

function getJson(url, body) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // node:http deliberately permits a GET body so this verifies that neither
    // query-string nor parsed-body identity can replace authenticated scope.
    const request = httpRequest(url, {
      method: "GET", agent: false,
      headers: serialized === undefined ? {} : {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(serialized),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode, headers: response.headers, text, body: JSON.parse(text) });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(serialized);
  });
}

function responseIs(response, status, body) {
  assert.equal(response.status, status);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"], /^application\/json\b/);
  assert.deepEqual(response.body, body);
}

test("neighborhood read rejects missing session identity before every dependency", async context => {
  for (const [name, auth] of [["absent authentication", null], ["missing user", {}], ["empty user", { userId: "" }]]) {
    await context.test(name, async child => {
      const calls = [], options = optionsFor(calls);
      const baseUrl = await startRouter(child, options, auth);
      const response = await getJson(`${endpoint(baseUrl, "bad account", "not-a-file")}?userId=forged`, {
        auth: AUTH, mobileAuth: AUTH, userId: AUTH.userId,
      });
      responseIs(response, 401, { error: "authentication_required" });
      assert.deepEqual(calls, []);
    });
  }
});

test("neighborhood workflow denial precedes account validation and storage dependencies", async context => {
  const calls = [];
  const baseUrl = await startRouter(context, optionsFor(calls, {
    requireWorkflowAccess(req, res, workflow, permission) {
      calls.push({ type: "workflow", auth: req.mobileAuth, workflow, permission });
      res.status(403).json({ error: "application_access_denied" });
      return false;
    },
  }));
  responseIs(await getJson(endpoint(baseUrl, "bad account", "not-a-file")), 403,
    { error: "application_access_denied" });
  assert.deepEqual(calls, [{ type: "workflow", auth: AUTH, workflow: "custom_appraisal", permission: "read" }]);
});

test("neighborhood assignment denial prevents the exact acceptance read", async context => {
  const calls = [];
  const baseUrl = await startRouter(context, optionsFor(calls, {
    async requireAssignmentAccess(req, res, accountId, assignmentFileId, permission) {
      calls.push({ type: "assignment", auth: req.mobileAuth, accountId, assignmentFileId, permission });
      res.status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
  }));
  responseIs(await getJson(endpoint(baseUrl)), 403, { error: "assignment_file_access_denied" });
  assert.deepEqual(calls.map(call => call.type), ["workflow", "normalize", "schema", "resolve", "assignment"]);
  assert.deepEqual(calls.at(-1), {
    type: "assignment", auth: AUTH, accountId: "CANONICAL_1", assignmentFileId: 41, permission: "read",
  });
});

test("neighborhood read binds canonical account, exact path file, and original server auth only", async context => {
  const calls = [], options = optionsFor(calls);
  const baseUrl = await startRouter(context, options);
  const forged = {
    accountId: "OTHER_ACCOUNT", account_id: "OTHER_ACCOUNT", assignmentFileId: 99, assignment_file_id: 99,
    organizationId: "OTHER_ORGANIZATION", reportFileId: "OTHER_REPORT", operationId: "OTHER_OPERATION",
    actorUserId: "OTHER_ACTOR", auth: { userId: "OTHER_USER" }, mobileAuth: { userId: "OTHER_USER" },
  };
  const query = new URLSearchParams(Object.entries(forged).map(([key, value]) => [key,
    typeof value === "object" ? JSON.stringify(value) : String(value)]));
  responseIs(await getJson(`${endpoint(baseUrl)}?${query}`, forged), 200,
    { ok: true, account_id: "CANONICAL_1", neighborhood: ABSENT });
  assert.deepEqual(calls.map(call => call.type), ["workflow", "normalize", "schema", "resolve", "assignment", "neighborhood"]);
  assert.deepEqual(calls.find(call => call.type === "normalize"), { type: "normalize", value: "41", options: { required: true } });
  assert.deepEqual(calls.find(call => call.type === "resolve"), { type: "resolve", pool: options.pool, value: "account_1" });
  const read = calls.at(-1);
  assert.equal(read.pool, options.pool);
  assert.equal(read.input.auth, AUTH, "Pass the original server session object, not reconstructed request identity");
  assert.deepEqual(read.input, { accountId: "CANONICAL_1", assignmentFileId: 41, auth: AUTH });
  assert.deepEqual(calls.find(call => call.type === "assignment"), {
    type: "assignment", auth: AUTH, accountId: "CANONICAL_1", assignmentFileId: 41, permission: "read",
  });
});

test("neighborhood accepted envelope passes through without rewriting stored group or actor", async context => {
  const accepted = {
    ...ABSENT, status: "accepted", acceptance: {
      id: "abcdef05-0000-4000-8000-000000000005", organizationId: AUTH.organizations[0].organizationId,
      reportFileId: REPORT, assignmentFileId: 41, operationId: OPERATION,
      actorUserId: "abcdef06-0000-4000-8000-000000000006", sectionHistoryId: "9007199254740993",
      acceptedEditorRevision: 6,
      snapshot: {
        section_key: "neighborhood_assessment",
        section_value: { operation_id: OPERATION, accepted_editor_revision: 6,
          mapped_values: { zero: { target_key: "synthetic:zero", value: 0 },
            text: { target_key: "synthetic:text", value: "North Road" } },
          decision: { applied: { zero: true, text: true }, reused: {} } },
        section_value_sha256: "a".repeat(64),
        receipt: { receipt_version: 1, accepted_editor_revision: 6, receipt_digest_sha256: "b".repeat(64) },
      },
    },
  };
  const original = structuredClone(accepted), calls = [];
  const baseUrl = await startRouter(context, optionsFor(calls, {
    async getNeighborhood() { calls.push({ type: "neighborhood" }); return accepted; },
  }));
  responseIs(await getJson(endpoint(baseUrl)), 200,
    { ok: true, account_id: "CANONICAL_1", neighborhood: original });
  assert.deepEqual(accepted, original);
  assert.equal(calls.filter(call => call.type === "neighborhood").length, 1);
});

test("neighborhood invalid account and file responses remain non-cacheable", async context => {
  for (const [name, account, file, error, expectedCalls] of [
    ["account", "bad account", "41", "invalid_account_id", ["workflow"]],
    ["assignment", "account_1", "not-a-file", "invalid_assignment_file_id", ["workflow", "normalize"]],
  ]) {
    await context.test(name, async child => {
      const calls = [], baseUrl = await startRouter(child, optionsFor(calls));
      responseIs(await getJson(endpoint(baseUrl, account, file)), 400, { error });
      assert.deepEqual(calls.map(call => call.type), expectedCalls);
    });
  }
});

test("neighborhood failures retain bounded status, error and no-store semantics", async context => {
  const privateDetail = "PRIVATE_EVIDENCE_ACCOUNT_AND_DATABASE_PASSWORD";
  const failures = [
    ["signed snapshot required", new Error("custom_neighborhood_signed_snapshot_required"), 409,
      "custom_neighborhood_signed_snapshot_required"],
    ["acceptance corruption", new Error(`custom_neighborhood_acceptance_stored_group_mismatch:${privateDetail}`), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["attachment corruption", new Error(`neighborhood_application_scope_mismatch:${privateDetail}`), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["persisted assessment corruption", new TypeError(`invalid_neighborhood_assessment:${privateDetail}`), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["persisted JSONB corruption", new TypeError(`neighborhood_jsonb_storage_invalid:${privateDetail}`), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["persisted JSON syntax error", new SyntaxError(`Unexpected token in ${privateDetail}`), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["unavailable group", new Error("custom_neighborhood_saved_group_unavailable"), 409,
      "custom_neighborhood_saved_group_unavailable"],
    ["missing storage", Object.assign(new Error(`relation missing: ${privateDetail}`), { code: "42P01" }), 503,
      "custom_neighborhood_storage_unavailable"],
    ["unexpected database error", Object.assign(new Error(privateDetail), { detail: privateDetail }), 500,
      "custom_neighborhood_load_failed"],
    ["unknown invalid error is not exposed as client input", new Error(`invalid_internal_state:${privateDetail}`), 500,
      "custom_neighborhood_load_failed"],
    ["missing assignment", new Error("assignment_file_not_found"), 404, "assignment_file_not_found"],
    ["snapshot assignment denial", new Error("assignment_file_access_denied"), 403, "assignment_file_access_denied"],
    ["snapshot authentication denial", new Error("authentication_required"), 401, "authentication_required"],
  ];
  for (const [name, failure, status, error] of failures) {
    await context.test(name, async child => {
      const calls = [];
      const baseUrl = await startRouter(child, optionsFor(calls, {
        async getNeighborhood() { calls.push({ type: "neighborhood" }); throw failure; },
      }));
      const response = await getJson(endpoint(baseUrl));
      responseIs(response, status, { error });
      assert.equal(response.text.includes(privateDetail), false);
      assert.equal(calls.filter(call => call.type === "neighborhood").length, 1);
      assert.equal(Object.hasOwn(response.body, "neighborhood"), false, "Never turn failures into an empty or accepted group");
    });
  }
});
