import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createHousingProfileRouter } from "../src/modules/accounts/housingProfileRouter.js";

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
  assert.equal(errors.length, 1);
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
  const reportManualValues = source.indexOf('app.patch("/api/accounts/:id/report-manual-values"');
  assert.ok(housingProfile > accountPhotos);
  assert.ok(reportManualValues > housingProfile);
});
