import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createSalesMediaRouter } from "../src/modules/sales/mediaRouter.js";

async function startRouter(router) {
  const app = express();
  app.use(router);
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

test("sales media returns the source record and ordered image gallery", async (context) => {
  const calls = [];
  const source = {
    source_record_id: "42",
    listing_key: "listing-key",
    listing_id: "MLS-42",
    source_name: "trestle",
  };
  const photos = [{ id: "photo-1", media_url: "https://example.test/photo.jpg" }];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return calls.length === 1 ? { rows: [source] } : { rows: photos };
    },
  };
  const server = await startRouter(createSalesMediaRouter({ pool }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/sales/42/photos`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...source, photos });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ params }) => params), [["42"], ["42"]]);
  assert.match(calls[0].sql, /FROM core\.sales_source_records/);
  assert.match(calls[1].sql, /FROM core\.sales_source_media/);
  assert.match(calls[1].sql, /media_category = 'image'/);
  assert.match(
    calls[1].sql,
    /preferred_photo_yn DESC,[\s\S]*order_number NULLS LAST,[\s\S]*id/,
  );
});

test("sales media rejects malformed source identifiers before database access", async (context) => {
  let queryCount = 0;
  const server = await startRouter(createSalesMediaRouter({
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
  }));
  context.after(server.close);

  for (const sourceRecordId of ["0", "-1", "1.5", "abc", "01"]) {
    const response = await fetch(
      `${server.baseUrl}/api/sales/${encodeURIComponent(sourceRecordId)}/photos`,
    );
    assert.equal(response.status, 400, sourceRecordId);
    assert.deepEqual(await response.json(), { error: "invalid_source_record_id" });
  }
  assert.equal(queryCount, 0);
});

test("sales media returns not found without querying the media table", async (context) => {
  let queryCount = 0;
  const server = await startRouter(createSalesMediaRouter({
    pool: { query: async () => { queryCount += 1; return { rows: [] }; } },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/sales/404/photos`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "sale_source_record_not_found" });
  assert.equal(queryCount, 1);
});

test("sales media preserves the stable database failure response", async (context) => {
  const failure = new Error("database_offline");
  const logs = [];
  const server = await startRouter(createSalesMediaRouter({
    pool: { query: async () => { throw failure; } },
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/sales/42/photos`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "sale_photos_failed" });
  assert.deepEqual(logs, [["/api/sales/:sourceRecordId/photos failed", failure]]);
});

test("sales media validates dependencies and remains before the property catalog", () => {
  assert.throws(() => createSalesMediaRouter(), /sales_media_pool_required/);

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const documentCandidates = source.indexOf(
    'app.patch("/api/documents/:documentId/candidates/:candidateId"',
  );
  const salesMedia = source.indexOf("app.use(createSalesMediaRouter({ pool }));");
  const propertyCatalog = source.indexOf("app.use(createPropertyCatalogRouter({ pool }));");
  assert.ok(documentCandidates > 0);
  assert.ok(salesMedia > documentCandidates);
  assert.ok(propertyCatalog > salesMedia);
  assert.equal(source.includes('app.get("/api/sales/:sourceRecordId/photos"'), false);
});
