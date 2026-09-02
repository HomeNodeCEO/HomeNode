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

function baseOptions(overrides = {}) {
  return {
    pool: { connect: async () => { throw new Error("unexpected_connect"); } },
    propertyEnrichmentReady: Promise.resolve(),
    requireEditor: () => true,
    resolveAccountId: async (_client, value) => value.toUpperCase(),
    validateSection: () => {},
    normalizeHousingProfile: () => normalizedHousing,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
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

test("manual-value size, section, and housing validation remain bounded before connecting", async (context) => {
  let connectCalls = 0;
  const pool = { connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); } };
  const sized = await startRouter(baseOptions({ pool }));
  const invalidSection = await startRouter(baseOptions({
    pool,
    validateSection: () => { throw new Error("invalid_subject_value"); },
  }));
  const invalidHousing = await startRouter(baseOptions({
    pool,
    normalizeHousingProfile: () => { throw new Error("invalid_housing_type"); },
  }));
  context.after(async () => Promise.all([
    sized.close(), invalidSection.close(), invalidHousing.close(),
  ]));

  const tooLarge = await patchManualValues(sized.baseUrl, "123", {
    sections: { "report.subject_identification": { notes: "x".repeat(250_001) } },
  });
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: "report_sections_too_large" });

  const invalidSectionResponse = await patchManualValues(invalidSection.baseUrl, "123", {
    sections: { "report.subject_identification": { county: "Dallas" } },
  });
  assert.equal(invalidSectionResponse.status, 400);
  assert.deepEqual(await invalidSectionResponse.json(), { error: "invalid_subject_value" });

  const invalidHousingResponse = await patchManualValues(invalidHousing.baseUrl, "123", {
    sections: {
      "report.property_characteristics": {
        housing_profile: { housing_type: "invalid" },
      },
    },
  });
  assert.equal(invalidHousingResponse.status, 400);
  assert.deepEqual(await invalidHousingResponse.json(), { error: "invalid_housing_type" });
  assert.equal(connectCalls, 0);
});

test("manual-value saves preserve canonicalization, housing sync, revisions, history, and commit order", async (context) => {
  const calls = [];
  const validated = [];
  const normalizedInputs = [];
  let releases = 0;
  let revisionReads = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/INSERT INTO core\.account_housing_profiles/.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT revision FROM app\.property_attribute_manual_values/.test(sql)) {
        revisionReads += 1;
        return revisionReads === 1
          ? { rows: [{ revision: 2 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO app\.property_attribute_manual_values/.test(sql)) {
        return {
          rows: [{
            attribute_key: params[1],
            attribute_value: JSON.parse(params[2]),
            revision: params[5],
            reviewer: params[4],
            notes: params[3],
            updated_at: "2026-09-02T12:00:00Z",
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO app\.property_attribute_manual_history/.test(sql)) {
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
    sections: sectionValues,
    reviewer: "  Reviewer Name  ",
    notes: "  Review notes  ",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    account_id: "CANONICAL_1",
    manual_values: {
      "report.subject_identification": {
        value: sectionValues["report.subject_identification"],
        revision: 3,
        reviewer: "Reviewer Name",
        notes: "Review notes",
        updated_at: "2026-09-02T12:00:00Z",
      },
      "report.property_characteristics": {
        value: sectionValues["report.property_characteristics"],
        revision: 1,
        reviewer: "Reviewer Name",
        notes: "Review notes",
        updated_at: "2026-09-02T12:00:00Z",
      },
    },
  });
  assert.deepEqual(validated, Object.entries(sectionValues));
  assert.deepEqual(normalizedInputs, [{
    housing_type: "Single Family Detached",
    notes: "Review notes",
  }]);
  assert.equal(releases, 1);

  const sequence = calls.map(({ sql }) => {
    if (["BEGIN", "COMMIT"].includes(sql)) return sql;
    if (/SELECT 1 FROM core\.accounts/.test(sql)) return "ACCOUNT";
    if (/INSERT INTO core\.account_housing_profiles/.test(sql)) return "HOUSING";
    if (/SELECT revision FROM app\.property_attribute_manual_values/.test(sql)) return "REVISION";
    if (/INSERT INTO app\.property_attribute_manual_values/.test(sql)) return "VALUE";
    if (/INSERT INTO app\.property_attribute_manual_history/.test(sql)) return "HISTORY";
    return "UNKNOWN";
  });
  assert.deepEqual(sequence, [
    "BEGIN", "ACCOUNT", "HOUSING",
    "REVISION", "VALUE", "HISTORY",
    "REVISION", "VALUE", "HISTORY",
    "COMMIT",
  ]);
  const housingCall = calls.find(({ sql }) => /INSERT INTO core\.account_housing_profiles/.test(sql));
  assert.deepEqual(housingCall.params, [
    "CANONICAL_1", "One Story", "Single Family Detached", "Detached", "Ranch", "Review notes",
  ]);
  const valueCalls = calls.filter(({ sql }) => /INSERT INTO app\.property_attribute_manual_values/.test(sql));
  assert.deepEqual(valueCalls.map(({ params }) => params.slice(0, 2)), [
    ["CANONICAL_1", "report.subject_identification"],
    ["CANONICAL_1", "report.property_characteristics"],
  ]);
  assert.deepEqual(valueCalls.map(({ params }) => params[5]), [3, 1]);
});

test("manual-value missing accounts roll back and release without value or history writes", async (context) => {
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
    sections: { "report.subject_identification": { county: "Dallas" } },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "account_not_found" });
  assert.deepEqual(calls, ["BEGIN", "SELECT 1 FROM core.accounts WHERE account_id = $1", "ROLLBACK"]);
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
    sections: { "report.subject_identification": { county: "Dallas" } },
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
    /report_manual_values_editor_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const housingProfile = source.indexOf("app.use(createHousingProfileRouter(");
  const reportManualValues = source.indexOf("app.use(createReportManualValuesRouter(");
  const assignmentFiles = source.indexOf('app.get("/api/accounts/:id/assignment-files"');
  assert.ok(reportManualValues > housingProfile);
  assert.ok(assignmentFiles > reportManualValues);
});
