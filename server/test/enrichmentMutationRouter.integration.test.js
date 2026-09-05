import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createEnrichmentMutationRouter } from "../src/modules/operations/enrichmentMutationRouter.js";

const identity = Object.freeze({
  userId: "appraiser-1",
  displayName: "Authenticated Appraiser",
});

function createDatabase({
  query = async () => ({ rows: [] }),
  clientQuery = async () => ({ rows: [] }),
} = {}) {
  const poolQueries = [];
  const clients = [];
  const pool = {
    async query(text, params = []) {
      const sql = String(text);
      poolQueries.push({ sql, params });
      return query(sql, params);
    },
    async connect() {
      const state = { queries: [], released: false };
      clients.push(state);
      return {
        async query(text, params = []) {
          const sql = String(text);
          state.queries.push({ sql, params });
          return clientQuery(sql, params, state);
        },
        release() {
          state.released = true;
        },
      };
    },
  };
  return { pool, poolQueries, clients };
}

function baseOptions(database, overrides = {}) {
  return {
    pool: database.pool,
    propertyEnrichmentReady: Promise.resolve(),
    trestleClient: { findProperty: async () => { throw new Error("unexpected_trestle"); } },
    getNonDallasAccount: async () => { throw new Error("unexpected_account_load"); },
    requireEditor: () => true,
    fetchParcelSuggestion: async () => { throw new Error("unexpected_gis"); },
    assertAttributeKey: (value) => String(value || ""),
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options, auth = identity) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  if (auth) {
    app.use((req, _res, next) => {
      req.mobileAuth = auth;
      next();
    });
  }
  app.use(createEnrichmentMutationRouter(options));
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

function mutate(baseUrl, path, method, body = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("enrichment mutations validate targets and retain editor gating before side effects", async (context) => {
  const database = createDatabase();
  let editorCalls = 0;
  const server = await startRouter(baseOptions(database, {
    requireEditor(_req, res) {
      editorCalls += 1;
      res.status(403).json({ error: "editor_required" });
      return false;
    },
  }));
  context.after(server.close);

  const invalid = await mutate(server.baseUrl, "/api/accounts/bad%20id/verified-attribute", "PATCH");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_account_id" });
  assert.equal(editorCalls, 0);

  const denied = await mutate(server.baseUrl, "/api/accounts/A-1/verified-attribute", "PATCH");
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "editor_required" });
  assert.equal(editorCalls, 1);
  assert.equal(database.clients.length, 0);

  const invalidSuggestion = await mutate(
    server.baseUrl,
    "/api/accounts/A-1/parcel-area-suggestions/not-a-number/decision",
    "POST",
    { decision: "approved" },
  );
  assert.equal(invalidSuggestion.status, 400);
  assert.deepEqual(await invalidSuggestion.json(), { error: "invalid_suggestion_target" });
  assert.equal(editorCalls, 1);
});

test("verified attribute writes preserve revision, history, resolution, and transaction order", async (context) => {
  const manualValue = { account_id: "A-1", attribute_key: "living_area", revision: 3 };
  const database = createDatabase({
    clientQuery: async (sql) => {
      if (sql.includes("SELECT revision FROM app.property_attribute_manual_values")) {
        return { rows: [{ revision: 2 }] };
      }
      if (sql.includes("INSERT INTO app.property_attribute_manual_values")) {
        return { rows: [manualValue] };
      }
      return { rows: [] };
    },
  });
  const options = baseOptions(database, {
    assertAttributeKey(value) {
      assert.equal(value, "living_area");
      return "living_area";
    },
    getNonDallasAccount: async (client, id) => {
      assert.equal(id, "A-1");
      assert.ok(client);
      return { normalized_county: "Collin" };
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await mutate(server.baseUrl, "/api/accounts/A-1/verified-attribute", "PATCH", {
    attribute_key: "living_area",
    attribute_value: { square_feet: 2010 },
    notes: "  Confirmed from plans  ",
    reviewer: "  Appraiser One  ",
    expected_revision: 2,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, manual_value: manualValue });

  const client = database.clients[0];
  assert.equal(client.released, true);
  assert.deepEqual(client.queries.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" ")), [
    "BEGIN",
    "SELECT revision FROM",
    "INSERT INTO app.property_attribute_manual_values",
    "INSERT INTO app.property_attribute_manual_history",
    "UPDATE app.enrichment_review_queue SET",
    "COMMIT",
  ]);
  assert.deepEqual(client.queries[2].params, [
    "A-1",
    "living_area",
    JSON.stringify({ square_feet: 2010 }),
    "Confirmed from plans",
    "Authenticated Appraiser",
    3,
  ]);
  assert.deepEqual(client.queries[3].params, client.queries[2].params);
  assert.deepEqual(client.queries[4].params, ["A-1", "living_area"]);
});

test("verified attribute conflicts and failures roll back, release, and use bounded diagnostics", async (context) => {
  const conflictDatabase = createDatabase({
    clientQuery: async (sql) => (
      sql.includes("SELECT revision") ? { rows: [{ revision: 4 }] } : { rows: [] }
    ),
  });
  const failedDatabase = createDatabase();
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const conflict = await startRouter(baseOptions(conflictDatabase, {
    getNonDallasAccount: async () => ({ normalized_county: "Collin" }),
  }));
  const failed = await startRouter(baseOptions(failedDatabase, {
    getNonDallasAccount: async () => { throw diagnostic; },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(async () => Promise.all([conflict.close(), failed.close()]));

  const conflictResponse = await mutate(conflict.baseUrl, "/api/accounts/A-1/verified-attribute", "PATCH", {
    attribute_key: "year_built",
    attribute_value: 2004,
    expected_revision: 3,
  });
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    error: "attribute_revision_conflict",
    current_revision: 4,
  });
  assert.deepEqual(
    conflictDatabase.clients[0].queries.map(({ sql }) => sql.trim().split(/\s+/)[0]),
    ["BEGIN", "SELECT", "ROLLBACK"],
  );
  assert.equal(conflictDatabase.clients[0].released, true);

  const failedResponse = await mutate(failed.baseUrl, "/api/accounts/A-1/verified-attribute", "PATCH", {
    attribute_key: "year_built",
    attribute_value: 2004,
  });
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(await failedResponse.json(), { error: "verified_attribute_update_failed" });
  assert.deepEqual(logs, [["verified attribute update failed", diagnostic]]);
  assert.equal(failedDatabase.clients[0].released, true);
});

test("parcel-area suggestion remains review-only and stores exact GIS evidence", async (context) => {
  const storedSuggestion = {
    id: 17,
    account_id: "A-1",
    county: "Collin",
    area_square_feet: 8750,
    status: "pending",
  };
  const database = createDatabase({
    query: async (sql) => (
      sql.includes("INSERT INTO app.parcel_geometry_suggestions")
        ? { rows: [storedSuggestion] }
        : { rows: [] }
    ),
  });
  const gisSuggestion = {
    county: "Collin",
    source_url: "https://gis.example/parcel/1",
    geometry: { type: "Polygon", coordinates: [] },
    area_square_feet: 8750,
    area_acres: 0.2009,
    source_attributes: { OBJECTID: 1 },
  };
  const options = baseOptions(database, {
    getNonDallasAccount: async (pool, id) => {
      assert.equal(pool, database.pool);
      assert.equal(id, "A-1");
      return { normalized_county: "Collin" };
    },
    fetchParcelSuggestion: async (input) => {
      assert.deepEqual(input, { county: "Collin", accountId: "A-1" });
      return gisSuggestion;
    },
  });
  const server = await startRouter(options);
  context.after(server.close);

  const response = await mutate(server.baseUrl, "/api/accounts/A-1/parcel-area-suggestion", "POST");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, suggestion: storedSuggestion });
  assert.equal(database.poolQueries.length, 2);
  assert.deepEqual(database.poolQueries[0].params, [
    "A-1",
    "Collin",
    gisSuggestion.source_url,
    JSON.stringify(gisSuggestion.geometry),
    8750,
    0.2009,
    JSON.stringify(gisSuggestion.source_attributes),
  ]);
  assert.deepEqual(database.poolQueries[1].params, [
    "A-1",
    "Collin",
    JSON.stringify({ suggestion_id: 17 }),
  ]);
  assert.ok(database.poolQueries[1].sql.includes("gis_site_area_requires_approval"));
});

test("parcel suggestion approval materializes site size and rejection avoids manual-value writes", async (context) => {
  function decisionDatabase() {
    return createDatabase({
      clientQuery: async (sql) => {
        if (sql.includes("SELECT * FROM app.parcel_geometry_suggestions")) {
          return { rows: [{ id: 17, status: "pending", area_square_feet: "8750" }] };
        }
        if (sql.includes("SELECT revision FROM app.property_attribute_manual_values")) {
          return { rows: [{ revision: 6 }] };
        }
        return { rows: [] };
      },
    });
  }
  const approvedDatabase = decisionDatabase();
  const rejectedDatabase = decisionDatabase();
  const approved = await startRouter(baseOptions(approvedDatabase, {
    getNonDallasAccount: async () => ({ normalized_county: "Collin" }),
  }));
  const rejected = await startRouter(baseOptions(rejectedDatabase, {
    getNonDallasAccount: async () => ({ normalized_county: "Collin" }),
  }));
  context.after(async () => Promise.all([approved.close(), rejected.close()]));

  const approvedResponse = await mutate(
    approved.baseUrl,
    "/api/accounts/A-1/parcel-area-suggestions/17/decision",
    "POST",
    { decision: " APPROVED ", reviewer: "  Appraiser One  " },
  );
  assert.equal(approvedResponse.status, 200);
  assert.deepEqual(await approvedResponse.json(), { ok: true, decision: "approved" });
  const approvedQueries = approvedDatabase.clients[0].queries;
  assert.equal(approvedDatabase.clients[0].released, true);
  assert.ok(approvedQueries.some(({ sql }) => sql.includes("property_attribute_manual_values")));
  assert.ok(approvedQueries.some(({ sql }) => sql.includes("property_attribute_manual_history")));
  const manualWrite = approvedQueries.find(({ sql }) => sql.includes("INSERT INTO app.property_attribute_manual_values"));
  assert.deepEqual(manualWrite.params, [
    "A-1",
    JSON.stringify(8750),
    "Approved official county GIS suggestion 17.",
    "Authenticated Appraiser",
    7,
  ]);
  assert.deepEqual(approvedQueries.at(-2).params, ["A-1", "approved"]);
  assert.equal(approvedQueries.at(-1).sql, "COMMIT");

  const rejectedResponse = await mutate(
    rejected.baseUrl,
    "/api/accounts/A-1/parcel-area-suggestions/17/decision",
    "POST",
    { decision: "rejected" },
  );
  assert.equal(rejectedResponse.status, 200);
  assert.deepEqual(await rejectedResponse.json(), { ok: true, decision: "rejected" });
  const rejectedQueries = rejectedDatabase.clients[0].queries;
  assert.equal(
    rejectedQueries.some(({ sql }) => sql.includes("property_attribute_manual_values")),
    false,
  );
  assert.deepEqual(rejectedQueries.at(-2).params, ["A-1", "rejected"]);
  assert.equal(rejectedDatabase.clients[0].released, true);
});

test("parcel decision terminal states roll back without changing review data", async (context) => {
  const cases = [
    { rows: [], status: 404, error: "parcel_suggestion_not_found" },
    { rows: [{ status: "approved" }], status: 409, error: "parcel_suggestion_already_reviewed" },
  ];
  const running = [];
  for (const item of cases) {
    const database = createDatabase({
      clientQuery: async (sql) => (
        sql.includes("SELECT * FROM app.parcel_geometry_suggestions")
          ? { rows: item.rows }
          : { rows: [] }
      ),
    });
    const server = await startRouter(baseOptions(database, {
      getNonDallasAccount: async () => ({ normalized_county: "Collin" }),
    }));
    running.push({ ...item, database, server });
  }
  context.after(async () => Promise.all(running.map(({ server }) => server.close())));

  for (const item of running) {
    const response = await mutate(
      item.server.baseUrl,
      "/api/accounts/A-1/parcel-area-suggestions/17/decision",
      "POST",
      { decision: "approved" },
    );
    assert.equal(response.status, item.status);
    assert.deepEqual(await response.json(), { error: item.error });
    assert.equal(item.database.clients[0].queries.at(-1).sql, "ROLLBACK");
    assert.equal(item.database.clients[0].released, true);
  }
});

test("Trestle preview forwards licensed identifiers and preserves activation errors", async (context) => {
  const database = createDatabase();
  const calls = [];
  const preview = { ListingKey: "key-1", ListPrice: 425000 };
  const options = baseOptions(database, {
    getNonDallasAccount: async () => ({ normalized_county: "Denton" }),
    trestleClient: {
      findProperty: async (input) => { calls.push(input); return preview; },
    },
  });
  const success = await startRouter(options);
  const disabled = await startRouter(baseOptions(database, {
    getNonDallasAccount: async () => ({ normalized_county: "Denton" }),
    trestleClient: { findProperty: async () => { throw new Error("trestle_disabled"); } },
  }));
  context.after(async () => Promise.all([success.close(), disabled.close()]));

  const response = await mutate(success.baseUrl, "/api/accounts/A-1/trestle-preview", "POST", {
    listing_key: "key-1",
    listing_id: "MLS-1",
    originating_system_name: "NTREIS",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account_id: "A-1",
    county: "Denton",
    preview,
  });
  assert.deepEqual(calls, [{
    listingKey: "key-1",
    listingId: "MLS-1",
    originatingSystemName: "NTREIS",
  }]);

  const disabledResponse = await mutate(
    disabled.baseUrl,
    "/api/accounts/A-1/trestle-preview",
    "POST",
    { listing_key: "key-1" },
  );
  assert.equal(disabledResponse.status, 409);
  assert.deepEqual(await disabledResponse.json(), { error: "trestle_disabled" });
});

test("enrichment mutation composition is explicit and inline handlers are absent", () => {
  const database = createDatabase();
  assert.throws(
    () => createEnrichmentMutationRouter(baseOptions(database, { pool: null })),
    /enrichment_mutation_pool_required/,
  );
  assert.throws(
    () => createEnrichmentMutationRouter(baseOptions(database, { requireEditor: null })),
    /enrichment_mutation_editor_policy_required/,
  );
  assert.throws(
    () => createEnrichmentMutationRouter(baseOptions(database, { trestleClient: null })),
    /enrichment_mutation_trestle_client_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const reads = source.indexOf("app.use(createEnrichmentReadRouter(");
  const mutations = source.indexOf("app.use(createEnrichmentMutationRouter(");
  const history = source.indexOf("app.use(createMarketValueHistoryRouter(");
  assert.ok(mutations > reads);
  assert.ok(history > mutations);
  assert.equal(source.includes('app.patch("/api/accounts/:id/verified-attribute"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/parcel-area-suggestion"'), false);
  assert.equal(source.includes('app.post("/api/accounts/:id/trestle-preview"'), false);
});
