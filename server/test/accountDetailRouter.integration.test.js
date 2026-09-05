import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAccountDetailRouter } from "../src/modules/accounts/detailRouter.js";

function sections(overrides = {}) {
  return {
    primaryImprovement: { living_area_sqft: 1840 },
    housingProfile: { housing_type: "Single Family Detached" },
    owner: {
      owner_name: "OWNER NAME",
      mailing_address: "100 MAIN ST",
      tax_year: 2026,
      owner_parties: [{ owner_name: "OWNER NAME" }],
    },
    legalCurrent: { legal_text: "LOT 1" },
    legalHistory: [{ legal_text: "PRIOR LOT" }],
    exemptionYear: 2026,
    exemptions: [{ exemption_code: "HS" }],
    homesteadYes: true,
    landRows: [{ number: 1, area_sqft: 9000 }],
    additionalImprovements: [{ improvement_type: "Garage" }],
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    pool: { query: async () => ({ rows: [] }) },
    accountQualityReady: Promise.resolve(),
    censusGeographyReady: Promise.resolve(),
    propertyEnrichmentReady: Promise.resolve(),
    ensurePropertyContextAvailable: async () => {},
    authenticationRequired: false,
    hasPermission: () => true,
    resolveAccountId: async (_pool, value) => value.toUpperCase(),
    loadPropertyActivity: async () => [],
    loadDetailSections: async () => sections(),
    ensureCensusSchema: async () => {},
    loadPropertyContext: async () => null,
    logger: { warn() {}, error() {} },
    ...overrides,
  };
}

async function startRouter(options, { auth = { userId: "reader-1" } } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    if (auth) req.mobileAuth = auth;
    next();
  });
  app.use(createAccountDetailRouter(options));
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

test("account detail preserves canonical resolution, response shape, and sales derivation", async (context) => {
  const queries = [];
  const resolutions = [];
  const census = { tract_geoid: "48113014125", status: "ready" };
  const propertyContext = { assessment_id: "context-1", status: "reviewed" };
  const activity = [
    { record_type: "listing", listing_id: "LIST-1" },
    { record_type: "closed_sale", sale_id: 8, sale_price: "325000" },
  ];
  const account = { account_id: "CANONICAL-1", address: "100 MAIN ST", county: "Dallas" };
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM core\.accounts a/.test(sql)) return { rows: [account] };
      if (/FROM core\.account_census_geographies/.test(sql)) return { rows: [census] };
      if (/FROM app\.property_attribute_manual_values/.test(sql)) {
        return { rows: [{
          attribute_key: "report.subject_identification",
          attribute_value: { county: "Dallas" },
          revision: "3",
          reviewer: "Reviewer",
          notes: null,
          updated_at: "2026-09-02T12:00:00Z",
        }] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const server = await startRouter(baseOptions({
    pool,
    resolveAccountId: async (receivedPool, value) => {
      resolutions.push({ receivedPool, value });
      return "CANONICAL-1";
    },
    loadPropertyActivity: async (receivedPool, accountId) => {
      assert.equal(receivedPool, pool);
      assert.equal(accountId, "CANONICAL-1");
      return activity;
    },
    loadDetailSections: async (receivedPool, accountId) => {
      assert.equal(receivedPool, pool);
      assert.equal(accountId, "CANONICAL-1");
      return sections();
    },
    loadPropertyContext: async (receivedPool, options) => {
      assert.equal(receivedPool, pool);
      assert.deepEqual(options, { accountId: "CANONICAL-1" });
      return propertyContext;
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/legacy-1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(resolutions, [{ receivedPool: pool, value: "legacy-1" }]);
  assert.deepEqual(body.account, {
    ...account,
    requested_account_id: "legacy-1",
    resolved_from_legacy: true,
  });
  assert.deepEqual(body.primary_improvements, { living_area_sqft: 1840 });
  assert.deepEqual(body.housing_profile, { housing_type: "Single Family Detached" });
  assert.deepEqual(body.owner_summary, {
    owner_name: "OWNER NAME",
    mailing_address: "100 MAIN ST",
    tax_year: 2026,
  });
  assert.deepEqual(body.owner_parties, [{ owner_name: "OWNER NAME" }]);
  assert.deepEqual(body.property_activity_history, activity);
  assert.deepEqual(body.sales_history, [activity[1]]);
  assert.deepEqual(body.census_geography, census);
  assert.equal(body.property_context, null);
  assert.deepEqual(body.report_manual_values, {});
  const accountQuery = queries.find(({ sql }) => /FROM core\.accounts a/.test(sql));
  assert.deepEqual(accountQuery.params, ["CANONICAL-1"]);
  assert.match(accountQuery.sql, /LEFT JOIN LATERAL/);
});

test("account detail returns not found before launching optional loaders", async (context) => {
  let optionalCalls = 0;
  const unexpectedOptional = async () => { optionalCalls += 1; throw new Error("unexpected_optional"); };
  const server = await startRouter(baseOptions({
    pool: { query: async () => ({ rows: [] }) },
    loadPropertyActivity: unexpectedOptional,
    loadDetailSections: unexpectedOptional,
    loadPropertyContext: unexpectedOptional,
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/404`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(optionalCalls, 0);
});

test("enforced account detail rejects identities without an application read role before database access", async (context) => {
  let queries = 0;
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    hasPermission: () => false,
    pool: {
      async query() {
        queries += 1;
        return { rows: [] };
      },
    },
  }), {
    auth: {
      userId: "user-no-role",
      organizations: [{ organizationId: "org-1", roles: [] }],
    },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123`);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "application_access_denied" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(queries, 0);
});

test("enforced account detail preserves property discovery but omits unscoped private overlays", async (context) => {
  const queries = [];
  let contextLoads = 0;
  const account = { account_id: "123", address: "100 MAIN ST", county: "Dallas" };
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (/FROM core\.accounts a/.test(sql)) return { rows: [account] };
      if (/FROM core\.account_census_geographies/.test(sql)) return { rows: [] };
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const server = await startRouter(baseOptions({
    authenticationRequired: true,
    pool,
    loadPropertyContext: async () => {
      contextLoads += 1;
      return { assessment_id: "private-context" };
    },
  }), {
    auth: {
      userId: "user-appraiser",
      organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
    },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.account.account_id, "123");
  assert.deepEqual(body.report_manual_values, {});
  assert.equal(body.property_context, null);
  assert.equal(contextLoads, 0);
  assert.equal(queries.some((sql) => /property_attribute_manual_values/.test(sql)), false);
});

test("optional account evidence failures preserve a bounded usable response", async (context) => {
  const warnings = [];
  const account = { account_id: "123", address: "100 MAIN ST" };
  const pool = {
    async query(sql) {
      if (/FROM core\.accounts a/.test(sql)) return { rows: [account] };
      if (/FROM core\.account_census_geographies/.test(sql)) {
        throw new Error("census_database_password");
      }
      if (/FROM app\.property_attribute_manual_values/.test(sql)) {
        throw Object.assign(new Error("manual_database_password"), { code: "XX000" });
      }
      throw new Error("unexpected_query");
    },
  };
  const server = await startRouter(baseOptions({
    pool,
    loadPropertyActivity: async () => {
      throw Object.assign(new Error("activity_database_password"), { code: "08006" });
    },
    ensurePropertyContextAvailable: async () => {
      throw new Error("context_database_password");
    },
    loadDetailSections: async () => sections({ owner: null }),
    logger: {
      warn(...args) { warnings.push(args); },
      error() {},
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.property_activity_history, []);
  assert.deepEqual(body.sales_history, []);
  assert.equal(body.census_geography, null);
  assert.deepEqual(body.report_manual_values, {});
  assert.equal(body.property_context, null);
  assert.equal(body.owner_summary, null);
  assert.deepEqual(body.owner_parties, []);
  assert.equal(warnings.length, 2);
  assert.doesNotMatch(JSON.stringify(body), /password|XX000|08006/);
});

test("required account failures retain the stable response without diagnostics", async (context) => {
  const errors = [];
  const pool = {
    async query(sql) {
      if (/FROM core\.accounts a/.test(sql)) return { rows: [{ account_id: "123" }] };
      return { rows: [] };
    },
  };
  const server = await startRouter(baseOptions({
    pool,
    loadDetailSections: async () => { throw new Error("database_password=secret"); },
    logger: {
      warn() {},
      error(...args) { errors.push(args); },
    },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123`);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: "accounts_failed" });
  assert.doesNotMatch(JSON.stringify(body), /password|secret/);
  assert.equal(errors.length, 1);
});

test("account detail composition fails fast for missing startup dependencies", () => {
  assert.throws(
    () => createAccountDetailRouter(),
    /account_detail_query_client_required/,
  );
  assert.throws(
    () => createAccountDetailRouter(baseOptions({ accountQualityReady: undefined })),
    /account_detail_quality_readiness_required/,
  );
  assert.throws(
    () => createAccountDetailRouter(baseOptions({ ensurePropertyContextAvailable: null })),
    /account_detail_context_readiness_required/,
  );
  assert.throws(
    () => createAccountDetailRouter(baseOptions({ authenticationRequired: undefined })),
    /account_detail_authentication_mode_required/,
  );
});

test("entrypoint mounts account detail after signup and before adjacent account routes", () => {
  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const signup = source.indexOf("app.use(createSignupRouter(");
  const accountDetail = source.indexOf("app.use(createAccountDetailRouter(");
  const accountPhotos = source.indexOf("app.use(createAccountPhotosRouter(");
  assert.ok(accountDetail > signup);
  assert.ok(accountPhotos > accountDetail);
});
