import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createHousingProfileRouter } from "../src/modules/accounts/housingProfileRouter.js";
import { normalizeHousingProfileUpdate } from "../src/util/housingProfileEdit.js";

const normalizedUpdate = Object.freeze({
  structuralStyle: "One Story",
  housingType: "Single Family Detached",
  attachmentType: "Detached",
  architecturalStyle: "Ranch",
  sourceUrl: "https://example.com/source",
  sourceRecordReference: "MLS-123",
  notes: "Verified comparable review",
});

function baseOptions(overrides = {}) {
  return {
    pool: { connect: async () => { throw new Error("unexpected_connect"); } },
    accountIdAllowed: (value) => /^\d+$/.test(value),
    requireWorkflowAccess: () => true,
    normalizeUpdate: () => normalizedUpdate,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json());
  app.use(createHousingProfileRouter(options));
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

function patchProfile(baseUrl, accountId = "123", body = { housing_type: "SFD" }) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/housing-profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("housing profile rejects invalid identifiers, authorization denial, and invalid input before connecting", async (context) => {
  let connectCalls = 0;
  let authorizationCalls = 0;
  const invalidId = await startRouter(baseOptions({
    pool: { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } },
    requireWorkflowAccess: () => { authorizationCalls += 1; return true; },
  }));
  const denied = await startRouter(baseOptions({
    pool: { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } },
    requireWorkflowAccess(req, res, workflow, permission) {
      authorizationCalls += 1;
      assert.equal(workflow, "custom_appraisal");
      assert.equal(permission, "write");
      res.status(403).json({ error: "workflow_access_denied" });
      return false;
    },
  }));
  const invalidBody = await startRouter(baseOptions({
    pool: { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } },
    requireWorkflowAccess: () => { authorizationCalls += 1; return true; },
    normalizeUpdate: () => { throw new Error("invalid_housing_type"); },
  }));
  context.after(async () => Promise.all([invalidId.close(), denied.close(), invalidBody.close()]));

  const invalidIdResponse = await patchProfile(invalidId.baseUrl, "not-valid");
  assert.equal(invalidIdResponse.status, 400);
  assert.deepEqual(await invalidIdResponse.json(), { error: "invalid_account_id" });

  const deniedResponse = await patchProfile(denied.baseUrl);
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "workflow_access_denied" });

  const invalidBodyResponse = await patchProfile(invalidBody.baseUrl);
  assert.equal(invalidBodyResponse.status, 400);
  assert.deepEqual(await invalidBodyResponse.json(), { error: "invalid_housing_type" });
  assert.equal(connectCalls, 0);
  assert.equal(authorizationCalls, 2);
});

test("housing profile keeps real input codes while bounding unexpected validator failures", async (context) => {
  let connectCalls = 0;
  const logs = [];
  const pool = { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } };
  const real = await startRouter(baseOptions({ pool, normalizeUpdate: normalizeHousingProfileUpdate }));
  const unexpected = await startRouter(baseOptions({
    pool,
    normalizeUpdate() { throw new Error("invalid_housing_type_private_password"); },
    logger: { error: (...args) => logs.push(args) },
  }));
  const hostile = await startRouter(baseOptions({
    pool,
    normalizeUpdate() { throw { get message() { throw new Error("private_getter"); } }; },
    logger: { error() { throw new Error("private_logger"); } },
  }));
  context.after(async () => Promise.all([real.close(), unexpected.close(), hostile.close()]));

  for (const input of [
    {},
    { housing_type: "x".repeat(121) },
    { housing_type: "SFD", attachment_type: "other" },
    { housing_type: "SFD", source_url: "file:///private" },
    { housing_type: "SFD", architectural_style: "x".repeat(121) },
    { housing_type: "SFD", source_record_reference: "x".repeat(201) },
    { housing_type: "SFD", notes: "x".repeat(2001) },
  ]) {
    let expectedCode;
    try { normalizeHousingProfileUpdate(input); }
    catch (error) { expectedCode = error.message; }
    assert.ok(expectedCode);
    const response = await patchProfile(real.baseUrl, "123", input);
    assert.equal(response.status, 400, expectedCode);
    assert.deepEqual(await response.json(), { error: expectedCode });
  }
  const arrayResponse = await patchProfile(real.baseUrl, "123", []);
  assert.equal(arrayResponse.status, 400);
  assert.deepEqual(await arrayResponse.json(), { error: "invalid_housing_profile" });
  for (const server of [unexpected, hostile]) {
    const response = await patchProfile(server.baseUrl);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "housing_profile_update_failed" });
  }
  assert.equal(connectCalls, 0);
  assert.deepEqual(logs, [["housing profile validation failed", "unknown"]]);
  assert.doesNotMatch(JSON.stringify(logs), /private_password|private_getter|private_logger/);
});

test("housing profile preserves transaction order, upsert values, canonical view, and response", async (context) => {
  const calls = [];
  let releases = 0;
  const profile = {
    structural_style: "One Story",
    housing_type: "Single Family Detached",
    attachment_type: "Detached",
    architectural_style: "Ranch",
    source_name: "HomeNode manual comparable review",
    profile_source: "verified",
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/INSERT INTO core\.account_housing_profiles/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM core\.v_account_housing_profiles/.test(sql)) return { rows: [profile], rowCount: 1 };
      throw new Error(`unexpected_query:${sql}`);
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
  }));
  context.after(server.close);

  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, housing_profile: profile });
  assert.equal(releases, 1);
  assert.deepEqual(calls.map(({ sql }) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return sql;
    if (/SELECT 1 FROM core\.accounts/.test(sql)) return "ACCOUNT";
    if (/INSERT INTO core\.account_housing_profiles/.test(sql)) return "UPSERT";
    if (/FROM core\.v_account_housing_profiles/.test(sql)) return "PROFILE";
    return "UNKNOWN";
  }), ["BEGIN", "ACCOUNT", "UPSERT", "PROFILE", "COMMIT"]);
  assert.deepEqual(calls[2].params, [
    "123",
    normalizedUpdate.structuralStyle,
    normalizedUpdate.housingType,
    normalizedUpdate.attachmentType,
    normalizedUpdate.architecturalStyle,
    normalizedUpdate.sourceUrl,
    normalizedUpdate.sourceRecordReference,
    normalizedUpdate.notes,
  ]);
  assert.match(calls[2].sql, /ON CONFLICT \(account_id\) DO UPDATE/);
  assert.match(calls[2].sql, /'HomeNode manual comparable review'/);
  assert.deepEqual(calls[3].params, ["123"]);
});

test("housing profile missing accounts roll back and release without writing", async (context) => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [], rowCount: 0 };
      throw new Error("unexpected_write");
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({ pool: { connect: async () => client } }));
  context.after(server.close);

  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "account_not_found" });
  assert.deepEqual(calls, ["BEGIN", "SELECT 1 FROM core.accounts WHERE account_id = $1", "ROLLBACK"]);
  assert.equal(releases, 1);
});

test("housing profile transaction failures roll back, release, and stay bounded", async (context) => {
  const calls = [];
  const errors = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      throw Object.assign(new Error("database_password=secret"), { code: "XX000" });
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "housing_profile_update_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
  assert.deepEqual(errors, [["/api/accounts/:id/housing-profile failed", "XX000"]]);
  assert.doesNotMatch(JSON.stringify(errors), /database_password|secret/);
});

test("throwing housing-profile logger cannot replace fixed write-failure response", async (context) => {
  let releases = 0;
  const client = {
    async query() { throw new Error("private_database_password"); },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
    logger: { error() { throw new Error("private_logger_password"); } },
  }));
  context.after(server.close);
  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "housing_profile_update_failed" });
  assert.equal(releases, 1);
});

test("housing-profile connection failure returns a fixed response and bounded diagnostic", async (context) => {
  const logs = [];
  const server = await startRouter(baseOptions({
    pool: { connect: async () => { throw new Error("private_connection_password"); } },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);
  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "housing_profile_update_failed" });
  assert.deepEqual(logs, [["/api/accounts/:id/housing-profile failed", "unknown"]]);
  assert.doesNotMatch(JSON.stringify(logs), /private_connection_password/);
});

test("synchronous rollback and release failures cannot replace the fixed response", async (context) => {
  const logs = [];
  const client = {
    query(sql) {
      throw new Error(sql === "ROLLBACK" ? "private_rollback_password" : "private_query_password");
    },
    release() { throw new Error("private_release_password"); },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);
  const response = await patchProfile(server.baseUrl);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "housing_profile_update_failed" });
  assert.deepEqual(logs, [
    ["/api/accounts/:id/housing-profile failed", "unknown"],
    ["housing profile client release failed", "unknown"],
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private_.*password/);
});

test("housing profile composition and legacy route position remain explicit", () => {
  assert.throws(() => createHousingProfileRouter(), /housing_profile_pool_required/);
  assert.throws(
    () => createHousingProfileRouter(baseOptions({ accountIdAllowed: null })),
    /housing_profile_account_policy_required/,
  );
  assert.throws(
    () => createHousingProfileRouter(baseOptions({ requireWorkflowAccess: null })),
    /housing_profile_workflow_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const accountPhotos = source.indexOf("app.use(createAccountPhotosRouter(");
  const housingProfile = source.indexOf("app.use(createHousingProfileRouter(");
  const reportManualValues = source.indexOf("app.use(createReportManualValuesRouter(");
  assert.ok(housingProfile > accountPhotos);
  assert.ok(reportManualValues > housingProfile);
});
