import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createAssignmentFileMutationRouter,
} from "../src/modules/assignmentFiles/mutationRouter.js";

const identity = Object.freeze({
  userId: "user-1",
  email: "appraiser@example.com",
  displayName: "Authenticated Appraiser",
  organizations: [
    { organizationId: "org-1", roles: ["appraiser"] },
    { organizationId: "org-2", roles: ["appraiser"] },
  ],
});

function createDatabase(handler) {
  const queries = [];
  let connectCalls = 0;
  let releaseCalls = 0;
  const client = {
    async query(text, params = []) {
      const sql = String(text);
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      return handler(sql, params, queries);
    },
    release() {
      releaseCalls += 1;
    },
  };
  return {
    client,
    pool: {
      async connect() {
        connectCalls += 1;
        return client;
      },
    },
    queries,
    get connectCalls() { return connectCalls; },
    get releaseCalls() { return releaseCalls; },
  };
}

function baseOptions(database, overrides = {}) {
  return {
    pool: database.pool,
    accountQualityReady: Promise.resolve(),
    propertyEnrichmentReady: Promise.resolve(),
    ensureAssignmentFilesAvailable: async () => {},
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
    decideAccess: () => true,
    resolveAccountId: async (_client, value) => value.toUpperCase(),
    hasPermission: () => false,
    presentAssignmentFile: (row) => row,
    registerOriginalReport: async () => {
      throw new Error("unexpected_original_report_registration");
    },
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
  app.use(createAssignmentFileMutationRouter(options));
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

function createFile(baseUrl, accountId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/assignment-files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchFile(baseUrl, accountId, fileId, body = {}) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/assignment-files/${fileId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function successfulCreateHandler({
  assignmentId = 41,
  accountExists = true,
  inheritedSource,
  latestSource,
  legacyDetails,
  reportRegistry = false,
  appraisalRegistry = false,
} = {}) {
  return async (sql) => {
    if (sql.includes("SELECT 1 FROM core.accounts")) {
      return { rows: accountExists ? [{ exists: 1 }] : [], rowCount: accountExists ? 1 : 0 };
    }
    if (sql.includes("WHERE id = $1 AND account_id = $2")) {
      return { rows: inheritedSource ? [inheritedSource] : [], rowCount: inheritedSource ? 1 : 0 };
    }
    if (sql.includes("ORDER BY created_at DESC, id DESC")) {
      return { rows: latestSource ? [latestSource] : [], rowCount: latestSource ? 1 : 0 };
    }
    if (sql.includes("attribute_key = 'report.assignment_details'")) {
      return { rows: legacyDetails === undefined ? [] : [{ attribute_value: legacyDetails }] };
    }
    if (sql.includes("INSERT INTO app.assignment_files (")) {
      return { rows: [{ id: assignmentId }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO app.custom_appraisal_workfiles")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("to_regclass('app.report_files')")) {
      return { rows: [{ table_name: reportRegistry ? "app.report_files" : null }] };
    }
    if (sql.includes("SELECT id FROM app.report_files")) {
      return { rows: [{ id: 301 }], rowCount: 1 };
    }
    if (sql.includes("UPDATE app.report_files")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO app.report_files (")) {
      return { rows: [{ id: 501 }], rowCount: 1 };
    }
    if (sql.includes("to_regclass('app.appraisal_cases')")) {
      return { rows: [{ table_name: appraisalRegistry ? "app.appraisal_cases" : null }] };
    }
    if (sql.includes("INSERT INTO app.assignment_file_history")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT revision FROM app.property_attribute_manual_values")) {
      return { rows: [{ revision: 2 }], rowCount: 1 };
    }
    if (
      sql.includes("INSERT INTO app.property_attribute_manual_values")
      || sql.includes("INSERT INTO app.property_attribute_manual_history")
    ) return { rows: [], rowCount: 1 };
    if (sql.includes("WHERE f.id = $1")) {
      return {
        rows: [{ id: assignmentId, account_id: "CANONICAL", file_number: "F-1", revision: 1 }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
  };
}

function successfulUpdateHandler(existing) {
  return async (sql) => {
    if (sql.includes("FOR UPDATE OF assignment_file")) {
      return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
    }
    if (sql.includes("FROM app.custom_appraisal_workfiles") && sql.includes("FOR UPDATE")) {
      return {
        rows: existing ? [{ status: existing.workfile_status }] : [],
        rowCount: existing ? 1 : 0,
      };
    }
    if (sql.includes("UPDATE app.assignment_files")) return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO app.assignment_file_history")) return { rows: [], rowCount: 1 };
    if (sql.includes("SELECT revision FROM app.property_attribute_manual_values")) {
      return { rows: [{ revision: 7 }], rowCount: 1 };
    }
    if (
      sql.includes("INSERT INTO app.property_attribute_manual_values")
      || sql.includes("INSERT INTO app.property_attribute_manual_history")
    ) return { rows: [], rowCount: 1 };
    if (sql.includes("WHERE f.id = $1")) {
      return {
        rows: [{ id: 41, account_id: "ACCOUNT_1", file_number: "F-1", revision: 3 }],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
  };
}

test("assignment mutation routes preserve account, editor, and payload gate order", async (context) => {
  const database = createDatabase(async () => { throw new Error("unexpected_query"); });
  let editorCalls = 0;
  const accepted = await startRouter(baseOptions(database, {
    requireEditor: () => { editorCalls += 1; return true; },
  }));
  const denied = await startRouter(baseOptions(database, {
    requireEditor(_req, res) {
      editorCalls += 1;
      res.status(403).json({ error: "editor_required" });
      return false;
    },
  }));
  context.after(async () => Promise.all([accepted.close(), denied.close()]));

  const invalidAccount = await createFile(accepted.baseUrl, "bad%20id", { file_number: "F-1" });
  assert.equal(invalidAccount.status, 400);
  assert.deepEqual(await invalidAccount.json(), { error: "invalid_account_id" });
  const deniedCreate = await createFile(denied.baseUrl, "A-1", { file_number: "F-1" });
  assert.equal(deniedCreate.status, 403);
  const invalidCreate = await createFile(accepted.baseUrl, "A-1", { file_number: "" });
  assert.equal(invalidCreate.status, 400);
  assert.deepEqual(await invalidCreate.json(), { error: "invalid_file_number" });
  const invalidPatch = await patchFile(accepted.baseUrl, "A-1", "bad", {
    assignment_details: {}, expected_revision: 1,
  });
  assert.equal(invalidPatch.status, 400);
  assert.deepEqual(await invalidPatch.json(), { error: "invalid_assignment_file_id" });
  assert.equal(editorCalls, 3);
  assert.equal(database.connectCalls, 0);
});

test("enforced creation selects one writable organization and attributes the authenticated user", async (context) => {
  const database = createDatabase(successfulCreateHandler());
  const permissionCalls = [];
  const options = baseOptions(database, {
    authenticationRequired: true,
    hasPermission(auth, workflow, permission, organizationId) {
      permissionCalls.push({ auth, workflow, permission, organizationId });
      return organizationId === "org-1";
    },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await createFile(server.baseUrl, "account_1", {
    file_number: "F-1",
    assignment_details: {},
    reviewer: " Reviewer ",
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).assignment_file.id, 41);
  const insert = database.queries.find(({ sql }) => sql.includes("INSERT INTO app.assignment_files ("));
  assert.deepEqual(insert.params, [
    "ACCOUNT_1", "F-1", "{}", null, "Authenticated Appraiser", "org-1", "user-1",
  ]);
  assert.equal(permissionCalls.length, 2);
  assert.ok(permissionCalls.every(({ auth, workflow, permission }) => (
    auth === identity && workflow === "custom_appraisal" && permission === "write"
  )));
  assert.equal(database.queries.some(({ sql }) => (
    sql.includes("property_attribute_manual_values")
  )), false);
  assert.equal(database.queries.at(-1).sql, "COMMIT");
  assert.equal(database.releaseCalls, 1);
});

test("enforced creation requires an explicit choice when multiple organizations are writable", async (context) => {
  const database = createDatabase(async () => { throw new Error("unexpected_query"); });
  const server = await startRouter(baseOptions(database, {
    authenticationRequired: true,
    hasPermission: () => true,
  }), identity);
  context.after(server.close);

  const response = await createFile(server.baseUrl, "account_1", { file_number: "F-1" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "organization_selection_required" });
  assert.equal(database.connectCalls, 0);
});

test("inherited creation scopes the source and registry lineage to the selected organization", async (context) => {
  const database = createDatabase(successfulCreateHandler({
    inheritedSource: { id: 7, assignment_details: { inherited: true } },
    reportRegistry: true,
    appraisalRegistry: true,
  }));
  const registrations = [];
  const server = await startRouter(baseOptions(database, {
    authenticationRequired: true,
    hasPermission: (_auth, _workflow, _permission, organizationId) => organizationId === "org-2",
    registerOriginalReport: async (client, reportFileId, settings) => {
      registrations.push({ client, reportFileId, settings });
    },
  }), identity);
  context.after(server.close);

  const response = await createFile(server.baseUrl, "account_1", {
    file_number: "F-2",
    inherited_from_file_id: 7,
    organization_id: "org-2",
  });
  assert.equal(response.status, 201);
  const source = database.queries.find(({ sql }) => sql.includes("WHERE id = $1 AND account_id = $2"));
  assert.deepEqual(source.params, [7, "ACCOUNT_1", "org-2"]);
  const insert = database.queries.find(({ sql }) => sql.includes("INSERT INTO app.assignment_files ("));
  assert.deepEqual(insert.params.slice(0, 7), [
    "ACCOUNT_1", "F-2", '{"inherited":true}', 7, "Authenticated Appraiser", "org-2", "user-1",
  ]);
  const registryInsert = database.queries.find(({ sql }) => sql.includes("INSERT INTO app.report_files ("));
  assert.deepEqual(registryInsert.params, ["ACCOUNT_1", "F-2", 301, 41, "org-2", "user-1"]);
  assert.deepEqual(registrations, [{
    client: database.client,
    reportFileId: 501,
    settings: { captureReason: "desktop_custom_appraisal_created" },
  }]);
});

test("rollout creation preserves latest and legacy inheritance plus manual-value mirroring", async (context) => {
  const database = createDatabase(successfulCreateHandler({ legacyDetails: { legacy: true } }));
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const response = await createFile(server.baseUrl, "account_1", { file_number: "F-3" });
  assert.equal(response.status, 201);
  const insert = database.queries.find(({ sql }) => sql.includes("INSERT INTO app.assignment_files ("));
  assert.deepEqual(insert.params.slice(0, 5), [
    "ACCOUNT_1", "F-3", '{"legacy":true}', null, "HomeNode editor",
  ]);
  const mirror = database.queries.find(({ sql }) => (
    sql.includes("INSERT INTO app.property_attribute_manual_values")
  ));
  assert.deepEqual(mirror.params, [
    "ACCOUNT_1",
    "report.assignment_details",
    '{"legacy":true}',
    "Current assignment file F-3",
    "HomeNode editor",
    3,
  ]);
});

test("creation rolls back missing accounts, invalid inheritance, duplicate numbers, and validation errors", async (context) => {
  const missingDb = createDatabase(successfulCreateHandler({ accountExists: false }));
  const inheritedDb = createDatabase(successfulCreateHandler());
  const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
  const duplicateDb = createDatabase(async (sql) => {
    if (sql.includes("SELECT 1 FROM core.accounts")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("INSERT INTO app.assignment_files (")) throw duplicate;
    throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
  });
  const validationDb = createDatabase(successfulCreateHandler());
  const missing = await startRouter(baseOptions(missingDb));
  const inherited = await startRouter(baseOptions(inheritedDb));
  const duplicates = await startRouter(baseOptions(duplicateDb));
  const validation = await startRouter(baseOptions(validationDb, {
    validateAssignmentDetails() { throw new Error("neighborhood_search_profile_required"); },
  }));
  context.after(async () => Promise.all([
    missing.close(), inherited.close(), duplicates.close(), validation.close(),
  ]));

  const missingResponse = await createFile(missing.baseUrl, "A-1", {
    file_number: "F-1", assignment_details: {},
  });
  assert.equal(missingResponse.status, 404);
  const inheritedResponse = await createFile(inherited.baseUrl, "A-1", {
    file_number: "F-1", inherited_from_file_id: 9,
  });
  assert.equal(inheritedResponse.status, 400);
  assert.deepEqual(await inheritedResponse.json(), { error: "invalid_inherited_assignment_file" });
  const duplicateResponse = await createFile(duplicates.baseUrl, "A-1", {
    file_number: "F-1", assignment_details: {},
  });
  assert.equal(duplicateResponse.status, 409);
  assert.deepEqual(await duplicateResponse.json(), { error: "assignment_file_number_exists" });
  const validationResponse = await createFile(validation.baseUrl, "A-1", {
    file_number: "F-1", assignment_details: {},
  });
  assert.equal(validationResponse.status, 400);
  assert.deepEqual(await validationResponse.json(), { error: "neighborhood_search_profile_required" });
  for (const database of [missingDb, inheritedDb, duplicateDb, validationDb]) {
    assert.ok(database.queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(database.releaseCalls, 1);
  }
});

test("assignment updates authorize the canonical file before locking and retain audit mirrors", async (context) => {
  const database = createDatabase(successfulUpdateHandler({
    id: 41,
    file_number: "F-1",
    revision: 2,
    workfile_status: "draft",
  }));
  const accessCalls = [];
  const options = baseOptions(database, {
    requireAssignmentAccess: async (...args) => { accessCalls.push(args); return true; },
  });
  const server = await startRouter(options, identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "account_1", 41, {
    assignment_details: { changed: true },
    expected_revision: 2,
    reviewer: "Reviewer",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).assignment_file.revision, 3);
  assert.deepEqual(accessCalls.map(([, , accountId, fileId, permission]) => ({
    accountId, fileId, permission,
  })), [{ accountId: "ACCOUNT_1", fileId: 41, permission: "write" }]);
  const beginIndex = database.queries.findIndex(({ sql }) => sql === "BEGIN");
  assert.ok(beginIndex >= 0);
  const update = database.queries.find(({ sql }) => sql.includes("UPDATE app.assignment_files"));
  assert.deepEqual(update.params, ['{"changed":true}', "Reviewer", 3, 41]);
  const history = database.queries.find(({ sql }) => sql.includes("INSERT INTO app.assignment_file_history"));
  assert.deepEqual(history.params, [
    41, "ACCOUNT_1", "F-1", '{"changed":true}', "Reviewer", 3,
  ]);
  assert.equal(database.queries.at(-1).sql, "COMMIT");
  assert.equal(database.releaseCalls, 1);
});

test("enforced assignment updates derive the reviewer and do not mutate the legacy global mirror", async (context) => {
  const database = createDatabase(successfulUpdateHandler({
    id: 41,
    file_number: "F-1",
    revision: 2,
    workfile_status: "draft",
  }));
  const server = await startRouter(baseOptions(database, {
    authenticationRequired: true,
  }), identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "account_1", 41, {
    assignment_details: { changed: true },
    expected_revision: 2,
    reviewer: "Spoofed Browser Reviewer",
  });
  assert.equal(response.status, 200);
  const update = database.queries.find(({ sql }) => sql.includes("UPDATE app.assignment_files"));
  assert.deepEqual(update.params, [
    '{"changed":true}', "Authenticated Appraiser", 3, 41,
  ]);
  const history = database.queries.find(({ sql }) => (
    sql.includes("INSERT INTO app.assignment_file_history")
  ));
  assert.deepEqual(history.params, [
    41, "ACCOUNT_1", "F-1", '{"changed":true}', "Authenticated Appraiser", 3,
  ]);
  assert.equal(database.queries.some(({ sql }) => (
    sql.includes("property_attribute_manual_values")
    || sql.includes("property_attribute_manual_history")
  )), false);
});

test("enforced assignment updates recheck ownership after locking the file", async (context) => {
  const database = createDatabase(successfulUpdateHandler({
    id: 41,
    file_number: "F-1",
    revision: 2,
    organization_id: "changed-org",
    workfile_status: "draft",
  }));
  const server = await startRouter(baseOptions(database, {
    authenticationRequired: true,
    decideAccess: () => false,
  }), identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "account_1", 41, {
    assignment_details: { changed: true },
    expected_revision: 2,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "assignment_file_access_denied" });
  assert.equal(database.queries.some(({ sql }) => (
    sql.includes("FROM app.custom_appraisal_workfiles")
    || sql.includes("UPDATE app.assignment_files")
  )), false);
  assert.equal(database.queries.at(-1).sql, "ROLLBACK");
});

test("denied updates stop before transactions and still release the borrowed client", async (context) => {
  const database = createDatabase(async () => { throw new Error("unexpected_query"); });
  const server = await startRouter(baseOptions(database, {
    async requireAssignmentAccess(_req, res) {
      res.status(403).json({ error: "custom_appraisal_assignment_access_denied" });
      return false;
    },
  }), identity);
  context.after(server.close);

  const response = await patchFile(server.baseUrl, "account_1", 41, {
    assignment_details: {}, expected_revision: 1,
  });
  assert.equal(response.status, 403);
  assert.equal(database.queries.length, 0);
  assert.equal(database.releaseCalls, 1);
});

test("updates reject missing, signed, and stale files without mutating history", async (context) => {
  const cases = [
    { existing: null, status: 404, body: { error: "assignment_file_not_found" } },
    {
      existing: { file_number: "F-1", revision: 2, workfile_status: "signed" },
      status: 409,
      body: { error: "custom_appraisal_workfile_signed" },
    },
    {
      existing: { file_number: "F-1", revision: 5, workfile_status: "draft" },
      status: 409,
      body: { error: "assignment_file_revision_conflict", current_revision: 5 },
    },
  ];
  const running = [];
  for (const item of cases) {
    const database = createDatabase(successfulUpdateHandler(item.existing));
    const server = await startRouter(baseOptions(database));
    running.push({ ...item, database, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await patchFile(item.server.baseUrl, "account_1", 41, {
      assignment_details: {}, expected_revision: 2,
    });
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), item.body);
    assert.ok(item.database.queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(item.database.queries.some(({ sql }) => (
      sql.includes("INSERT INTO app.assignment_file_history")
    )), false);
    assert.equal(item.database.releaseCalls, 1);
  }
});

test("database diagnostics remain server-side for create and update failures", async (context) => {
  const secret = new Error("postgres at db.internal.example leaked-token");
  const createDb = createDatabase(async (sql) => {
    if (sql.includes("SELECT 1 FROM core.accounts")) return { rows: [{}], rowCount: 1 };
    throw secret;
  });
  const updateDb = createDatabase(async () => { throw secret; });
  const logs = [];
  const logger = { error: (...args) => logs.push(args) };
  const createServer = await startRouter(baseOptions(createDb, { logger }));
  const updateServer = await startRouter(baseOptions(updateDb, { logger }));
  context.after(async () => Promise.all([createServer.close(), updateServer.close()]));

  const createResponse = await createFile(createServer.baseUrl, "A-1", {
    file_number: "F-1", assignment_details: {},
  });
  assert.equal(createResponse.status, 500);
  assert.deepEqual(await createResponse.json(), { error: "assignment_file_create_failed" });
  const updateResponse = await patchFile(updateServer.baseUrl, "A-1", 41, {
    assignment_details: {}, expected_revision: 1,
  });
  assert.equal(updateResponse.status, 500);
  assert.deepEqual(await updateResponse.json(), { error: "assignment_file_update_failed" });
  assert.equal(logs.length, 2);
  assert.ok(logs.every(([, error]) => error === secret));
});

test("assignment mutation composition is explicit and inline handlers are absent", () => {
  const database = createDatabase(async () => ({ rows: [] }));
  assert.throws(
    () => createAssignmentFileMutationRouter(baseOptions(database, { pool: null })),
    /assignment_file_mutation_pool_required/,
  );
  assert.throws(
    () => createAssignmentFileMutationRouter(baseOptions(database, { requireEditor: null })),
    /assignment_file_mutation_access_policy_required/,
  );
  assert.throws(
    () => createAssignmentFileMutationRouter(baseOptions(database, { authenticationRequired: null })),
    /assignment_file_mutation_authentication_mode_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const propertyTax = source.indexOf("app.use(createDesktopPropertyTaxRouter(");
  const mutations = source.indexOf("app.use(createAssignmentFileMutationRouter(");
  const workfile = source.indexOf("app.use(createAssignmentWorkfileReadRouter(");
  assert.ok(mutations > propertyTax);
  assert.ok(workfile > mutations);
  assert.equal(source.includes('app.post("/api/accounts/:id/assignment-files"'), false);
  assert.equal(source.includes('app.patch("/api/accounts/:id/assignment-files/:fileId"'), false);
});
