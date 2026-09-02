import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import {
  buildPropertyClassWhere,
  createPropertyCatalogRouter,
} from "../src/modules/propertyCatalog/router.js";

async function startRouter({ query, logger = { error() {} } }) {
  const app = express();
  app.use(createPropertyCatalogRouter({ pool: { query }, logger }));
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

test("property class filters preserve numeric, label, county, and neighborhood parameters", () => {
  assert.deepEqual(buildPropertyClassWhere({
    classes: "14; 2-3; condominium",
    county: "Dallas, Tarrant",
    neighborhoods: "A1, B2",
  }), {
    whereSql: "WHERE (matches_classes_lohi(c.building_class_int, $1::int[], $2::int[], $3::int[]) OR UPPER(c.building_class) = ANY($4::text[])) AND p.county = ANY($5::text[]) AND p.neighborhood_code = ANY($6::text[])",
    params: [[14], [2], [3], ["CONDOMINIUM"], ["Dallas", "Tarrant"], ["A1", "B2"]],
  });
  assert.deepEqual(buildPropertyClassWhere(), { whereSql: "", params: [] });
});

test("property search preserves response shape and caps the requested limit", async (context) => {
  const calls = [];
  const rows = [{ account_id: "123", county: "Dallas" }];
  const server = await startRouter({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  });
  context.after(server.close);

  const response = await fetch(
    `${server.baseUrl}/api/properties/search?classes=14&county=Dallas&neighborhoods=A1&limit=5000`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { count: 1, rows });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM properties p/);
  assert.match(calls[0].sql, /ORDER BY p\.account_id/);
  assert.deepEqual(calls[0].params, [[14], [], [], ["Dallas"], ["A1"], 1000]);
});

test("class distribution preserves grouped query and stable failure contracts", async (context) => {
  const successfulCalls = [];
  const successful = await startRouter({
    async query(sql, params) {
      successfulCalls.push({ sql, params });
      return { rows: [{ class_label: "CONDOMINIUM", class_code_int: 14, n: "2" }] };
    },
  });
  const failures = [];
  const failing = await startRouter({
    async query() { throw new Error("database secret"); },
    logger: { error(message) { failures.push(message); } },
  });
  context.after(async () => Promise.all([successful.close(), failing.close()]));

  const response = await fetch(`${successful.baseUrl}/api/stats/class-distribution?classes=condominium`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    count: 1,
    rows: [{ class_label: "CONDOMINIUM", class_code_int: 14, n: "2" }],
  });
  assert.match(successfulCalls[0].sql, /GROUP BY c\.building_class, c\.building_class_int/);
  assert.deepEqual(successfulCalls[0].params, [["CONDOMINIUM"]]);

  const searchFailure = await fetch(`${failing.baseUrl}/api/properties/search`);
  assert.equal(searchFailure.status, 500);
  assert.deepEqual(await searchFailure.json(), { error: "query_failed" });
  const statsFailure = await fetch(`${failing.baseUrl}/api/stats/class-distribution`);
  assert.equal(statsFailure.status, 500);
  assert.deepEqual(await statsFailure.json(), { error: "stats_failed" });
  assert.deepEqual(failures, [
    "[property-catalog] property search failed",
    "[property-catalog] class distribution failed",
  ]);
});

test("property catalog router rejects a missing query dependency", () => {
  assert.throws(
    () => createPropertyCatalogRouter(),
    /property_catalog_query_client_required/,
  );
});
