import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import {
  createReportManualValuesRouter,
  REPORT_MANUAL_SECTION_KEYS,
} from "../src/modules/accounts/reportManualValuesRouter.js";

const normalizedHousing = Object.freeze({
  structuralStyle: "One Story",
  housingType: "Single Family Detached",
  attachmentType: "Detached",
  architecturalStyle: "Ranch",
  notes: "Review notes",
});

const authenticatedIdentity = Object.freeze({
  userId: "user-1",
  email: "appraiser@example.com",
  displayName: "Authenticated Appraiser",
});

function baseOptions(overrides = {}) {
  return {
    pool: { connect: async () => { throw new Error("unexpected_connect"); } },
    propertyEnrichmentReady: Promise.resolve(),
    ensureCustomAppraisalWorkfilesAvailable: async () => {},
    requireWorkflowAccess: () => true,
    requireEditor: () => true,
    requireAssignmentAccess: async () => true,
    authenticationRequired: false,
    decideAccess: () => true,
    resolveAccountId: async (_client, value) => value.toUpperCase(),
    validateSection: () => {},
    normalizeHousingProfile: () => normalizedHousing,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options, auth = authenticatedIdentity) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (auth) {
    app.use((req, _res, next) => {
      req.mobileAuth = auth;
      next();
    });
  }
  app.use(createReportManualValuesRouter(options));
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

function patchManualValues(baseUrl, accountId, body) {
  return fetch(`${baseUrl}/api/accounts/${accountId}/report-manual-values`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("report manual values preserve the exact seven-section contract", () => {
  assert.deepEqual([...REPORT_MANUAL_SECTION_KEYS], [
    "report.subject_identification",
    "report.exemptions",
    "report.sales_history",
    "report.property_characteristics",
    "report.land_details",
    "report.appraisal_values",
    "report.assignment_details",
  ]);
});

test("manual-value validation and authorization finish before database acquisition", async (context) => {
  let connectCalls = 0;
  let editorCalls = 0;
  const common = baseOptions({
    pool: { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } },
    requireEditor: () => { editorCalls += 1; return true; },
  });
  const accepted = await startRouter(common);
  const denied = await startRouter(baseOptions({
    pool: common.pool,
    requireEditor(_req, res) {
      editorCalls += 1;
      res.status(403).json({ error: "editor_required" });
      return false;
    },
  }));
  context.after(async () => Promise.all([accepted.close(), denied.close()]));

  const invalidId = await patchManualValues(accepted.baseUrl, "bad%20id", {
    sections: { "report.subject_identification": {} },
  });
  assert.equal(invalidId.status, 400);
  assert.deepEqual(await invalidId.json(), { error: "invalid_account_id" });

  const deniedResponse = await patchManualValues(denied.baseUrl, "123", {
    sections: { "report.subject_identification": {} },
  });
  assert.equal(deniedResponse.status, 403);

  for (const sections of [null, [], {}, { "report.unknown": {} }]) {
    const response = await patchManualValues(accepted.baseUrl, "123", { sections });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_report_sections" });
  }
  assert.equal(connectCalls, 0);
  assert.equal(editorCalls, 5);
});

test("manual-value size and section validation remain bounded before connecting", async (context) => {
  let connectCalls = 0;
  const pool = { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } };
  const sized = await startRouter(baseOptions({ pool }));
  const invalidSection = await startRouter(baseOptions({
    pool,
    validateSection: () => { throw new Error("invalid_subject_value"); },
  }));
  context.after(async () => Promise.all([
    sized.close(), invalidSection.close(),
  ]));

  const tooLarge = await patchManualValues(sized.baseUrl, "123", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { notes: "x".repeat(250_001) } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: "report_sections_too_large" });

  const invalidSectionResponse = await patchManualValues(invalidSection.baseUrl, "123", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(invalidSectionResponse.status, 400);
  assert.deepEqual(await invalidSectionResponse.json(), { error: "invalid_subject_value" });

  assert.equal(connectCalls, 0);
});

test("rollout manual-value saves use assignment-scoped revisions and authenticated identity", async (context) => {
  const calls = [];
  const validated = [];
  const normalizedInputs = [];
  let releases = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: 41, organization_id: "org-1" }], rowCount: 1 };
      }
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        return { rows: [{ status: "draft" }], rowCount: 1 };
      }
      if (/SELECT section_key, revision/.test(sql)) {
        return { rows: [{ section_key: "report.subject_identification", revision: 2 }] };
      }
      if (/INSERT INTO app\.custom_appraisal_sections/.test(sql)) {
        return {
          rows: [{
            attribute_key: params[1],
            section_value: JSON.parse(params[2]),
            revision: params[1] === "report.subject_identification" ? 3 : 1,
            updated_at: "2026-09-02T12:00:00Z",
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO app\.custom_appraisal_section_history/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
    resolveAccountId: async (receivedClient, requestedId) => {
      assert.equal(receivedClient, client);
      assert.equal(requestedId, "legacy_1");
      return "CANONICAL_1";
    },
    validateSection(key, value) { validated.push([key, value]); },
    normalizeHousingProfile(value) {
      normalizedInputs.push(value);
      return normalizedHousing;
    },
  }));
  context.after(server.close);

  const sectionValues = {
    "report.subject_identification": { county: "Dallas" },
    "report.property_characteristics": {
      housing_profile: { housing_type: "Single Family Detached" },
    },
  };
  const response = await patchManualValues(server.baseUrl, "legacy_1", {
    assignment_file_id: 41,
    sections: sectionValues,
    reviewer: "  Reviewer Name  ",
    notes: "  Review notes  ",
    expected_revisions: {
      "report.subject_identification": 2,
      "report.property_characteristics": 0,
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "CANONICAL_1",
    assignment_file_id: 41,
    manual_values: {
      "report.subject_identification": {
        value: sectionValues["report.subject_identification"],
        revision: 3,
        reviewer: "Authenticated Appraiser",
        notes: "Review notes",
        updated_at: "2026-09-02T12:00:00Z",
      },
      "report.property_characteristics": {
        value: sectionValues["report.property_characteristics"],
        revision: 1,
        reviewer: "Authenticated Appraiser",
        notes: "Review notes",
        updated_at: "2026-09-02T12:00:00Z",
      },
    },
  });
  assert.deepEqual(validated, Object.entries(sectionValues));
  assert.deepEqual(normalizedInputs, []);
  assert.equal(releases, 1);

  const sequence = calls.map(({ sql }) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return sql;
    if (/SELECT 1 FROM core\.accounts/.test(sql)) return "ACCOUNT";
    if (/FROM app\.assignment_files assignment_file/.test(sql)) return "ASSIGNMENT";
    if (/FROM app\.custom_appraisal_workfiles/.test(sql)) return "WORKFILE";
    if (/SELECT section_key, revision/.test(sql)) return "REVISIONS";
    if (/INSERT INTO app\.custom_appraisal_sections/.test(sql)) return "VALUE";
    if (/INSERT INTO app\.custom_appraisal_section_history/.test(sql)) return "HISTORY";
    return "UNKNOWN";
  });
  assert.deepEqual(sequence, [
    "ACCOUNT", "BEGIN", "ASSIGNMENT", "WORKFILE", "REVISIONS",
    "VALUE", "HISTORY", "VALUE", "HISTORY",
    "COMMIT",
  ]);
  assert.equal(calls.some(({ sql }) => (
    /property_attribute_manual|account_housing_profiles/.test(sql)
  )), false);
});

test("enforced saves require an assignment and reject assignment-detail mirroring before connecting", async (context) => {
  let connectCalls = 0;
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } },
  }), authenticatedIdentity);
  context.after(server.close);

  const missing = await patchManualValues(server.baseUrl, "A-1", {
    sections: { "report.subject_identification": { county: "Dallas" } },
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "assignment_file_required" });

  const invalid = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: "not-a-file",
    sections: { "report.subject_identification": { county: "Dallas" } },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_assignment_file_id" });

  const assignmentDetails = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.assignment_details": {} },
  });
  assert.equal(assignmentDetails.status, 400);
  assert.deepEqual(await assignmentDetails.json(), {
    error: "assignment_details_require_assignment_file_api",
  });
  const missingRevision = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
  });
  assert.equal(missingRevision.status, 400);
  assert.deepEqual(await missingRevision.json(), { error: "report_section_revision_required" });
  assert.equal(connectCalls, 0);
});

test("enforced saves authorize, lock, revision, and audit the exact assignment only", async (context) => {
  const calls = [];
  const accessCalls = [];
  let schemaChecks = 0;
  let releases = 0;
  const sectionValue = { county: "Dallas" };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: 41 }], rowCount: 1 };
      }
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        return { rows: [{ status: "draft" }], rowCount: 1 };
      }
      if (/SELECT section_key, revision/.test(sql)) {
        return {
          rows: [{ section_key: "report.subject_identification", revision: 3 }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO app\.custom_appraisal_sections/.test(sql)) {
        return {
          rows: [{
            section_key: params[1],
            section_value: JSON.parse(params[2]),
            revision: 4,
            updated_at: "2026-09-04T10:00:00Z",
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO app\.custom_appraisal_section_history/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => client },
    ensureCustomAppraisalWorkfilesAvailable: async () => { schemaChecks += 1; },
    resolveAccountId: async (_client, value) => value.toUpperCase(),
    requireAssignmentAccess: async (...args) => { accessCalls.push(args); return true; },
  }), authenticatedIdentity);
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "account_1", {
    assignment_file_id: 41,
    reviewer: "Spoofed Browser Reviewer",
    notes: "Authenticated desktop correction",
    sections: { "report.subject_identification": sectionValue },
    expected_revisions: { "report.subject_identification": 3 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "ACCOUNT_1",
    assignment_file_id: 41,
    manual_values: {
      "report.subject_identification": {
        value: sectionValue,
        revision: 4,
        reviewer: "Authenticated Appraiser",
        notes: "Authenticated desktop correction",
        updated_at: "2026-09-04T10:00:00Z",
      },
    },
  });
  assert.equal(schemaChecks, 1);
  assert.equal(releases, 1);
  assert.deepEqual(accessCalls.map(([, , accountId, fileId, permission]) => ({
    accountId, fileId, permission,
  })), [{ accountId: "ACCOUNT_1", fileId: 41, permission: "write" }]);

  const sectionInsert = calls.find(({ sql }) => /INSERT INTO app\.custom_appraisal_sections/.test(sql));
  assert.deepEqual(sectionInsert.params, [
    41,
    "report.subject_identification",
    JSON.stringify(sectionValue),
    "user-1",
  ]);
  const historyInsert = calls.find(({ sql }) => (
    /INSERT INTO app\.custom_appraisal_section_history/.test(sql)
  ));
  assert.deepEqual(historyInsert.params, [
    41,
    "report.subject_identification",
    JSON.stringify(sectionValue),
    4,
    "user-1",
  ]);
  assert.equal(calls.some(({ sql }) => /property_attribute_manual|account_housing_profiles/.test(sql)), false);
  assert.equal(calls.at(-1).sql, "COMMIT");
});

test("enforced assignment denial stops before a transaction or section write", async (context) => {
  const calls = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      throw new Error(`unexpected_query:${sql}`);
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => client },
    async requireAssignmentAccess(_req, res) {
      res.status(403).json({ error: "assignment_file_access_denied" });
      return false;
    },
  }), authenticatedIdentity);
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, ["SELECT 1 FROM core.accounts WHERE account_id = $1"]);
  assert.equal(releases, 1);
});

test("enforced saves recheck assignment ownership under the database lock", async (context) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: 41, organization_id: "changed-org" }], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() {},
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => client },
    decideAccess: () => false,
  }), authenticatedIdentity);
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "assignment_file_access_denied" });
  assert.equal(calls.some((sql) => /FROM app\.custom_appraisal_workfiles/.test(sql)), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("enforced saves reject signed workfiles without changing section history", async (context) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: 41 }], rowCount: 1 };
      }
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        return { rows: [{ status: "signed" }], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() {},
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => client },
  }), authenticatedIdentity);
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "custom_appraisal_workfile_signed" });
  assert.equal(calls.some((sql) => /INSERT INTO app\.custom_appraisal_section/.test(sql)), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("enforced saves return the current assignment revision instead of overwriting a race", async (context) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM app\.assignment_files assignment_file/.test(sql)) {
        return { rows: [{ id: 41 }], rowCount: 1 };
      }
      if (/FROM app\.custom_appraisal_workfiles/.test(sql)) {
        return { rows: [{ status: "draft" }], rowCount: 1 };
      }
      if (/SELECT section_key, revision/.test(sql)) {
        return {
          rows: [{ section_key: "report.subject_identification", revision: 5 }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() {},
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool: { connect: async () => client },
  }), authenticatedIdentity);
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "A-1", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 4 },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "report_section_revision_conflict",
    current_revisions: { "report.subject_identification": 5 },
  });
  assert.equal(calls.some((sql) => /INSERT INTO app\.custom_appraisal_section/.test(sql)), false);
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("manual-value missing accounts release before starting a transaction", async (context) => {
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

  const response = await patchManualValues(server.baseUrl, "123", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "account_not_found" });
  assert.deepEqual(calls, ["SELECT 1 FROM core.accounts WHERE account_id = $1"]);
  assert.equal(releases, 1);
});

test("manual-value failures roll back, release, and return no diagnostics", async (context) => {
  const calls = [];
  const errors = [];
  let releases = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT revision FROM app\.property_attribute_manual_values/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      throw Object.assign(new Error("database_password=secret"), { code: "XX000" });
    },
    release() { releases += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { connect: async () => client },
    logger: { error(...args) { errors.push(args); } },
  }));
  context.after(server.close);

  const response = await patchManualValues(server.baseUrl, "123", {
    assignment_file_id: 41,
    sections: { "report.subject_identification": { county: "Dallas" } },
    expected_revisions: { "report.subject_identification": 0 },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "report_manual_values_update_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret|XX000/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
  assert.equal(errors.length, 1);
});

test("manual-value composition and route position remain explicit", () => {
  assert.throws(() => createReportManualValuesRouter(), /report_manual_values_pool_required/);
  assert.throws(
    () => createReportManualValuesRouter(baseOptions({ propertyEnrichmentReady: null })),
    /report_manual_values_readiness_required/,
  );
  assert.throws(
    () => createReportManualValuesRouter(baseOptions({ requireEditor: null })),
    /report_manual_values_access_policy_required/,
  );
  assert.throws(
    () => createReportManualValuesRouter(baseOptions({ authenticationRequired: null })),
    /report_manual_values_authentication_mode_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const housingProfile = source.indexOf("app.use(createHousingProfileRouter(");
  const reportManualValues = source.indexOf("app.use(createReportManualValuesRouter(");
  const assignmentFiles = source.indexOf("app.use(createAssignmentFileListRouter(");
  assert.ok(reportManualValues > housingProfile);
  assert.ok(assignmentFiles > reportManualValues);
  const mount = source.slice(reportManualValues, assignmentFiles);
  assert.match(mount, /ensureCustomAppraisalWorkfilesAvailable/);
  assert.match(mount, /requireAssignmentAccess: requireCustomAssignmentAccess/);
  assert.match(mount, /authenticationRequired: applicationAuthenticationRequired/);
});
