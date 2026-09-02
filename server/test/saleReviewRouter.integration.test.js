import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createSaleReviewRouter } from "../src/modules/appraisalRatings/saleReviewRouter.js";

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
    ratingsReady: Promise.resolve(),
    requireEditor: () => true,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(createSaleReviewRouter(options));
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

function saveReview(baseUrl, sourceRecordId, body = {}) {
  return fetch(`${baseUrl}/api/sales/${sourceRecordId}/review`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("sale review batch reads deduplicate, validate, cap, and preserve SQL scope", async (context) => {
  const reviews = [{ source_record_id: "1", condition_rating: "C3", revision: 2 }];
  const database = createDatabase({ query: async () => ({ rows: reviews }) });
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const requested = [...Array.from({ length: 205 }, (_, index) => String(index + 1)), "2", "bad"];
  const response = await fetch(
    `${server.baseUrl}/api/sales/reviews?source_record_ids=${requested.join(",")}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reviews });
  assert.equal(database.poolQueries.length, 1);
  assert.deepEqual(database.poolQueries[0].params, [
    Array.from({ length: 200 }, (_, index) => String(index + 1)),
  ]);
  assert.ok(database.poolQueries[0].sql.includes("source_record_id = ANY($1::bigint[])"));
  assert.ok(database.poolQueries[0].sql.includes("ORDER BY source_record_id"));

  const empty = await fetch(`${server.baseUrl}/api/sales/reviews?source_record_ids=bad,%20`);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { reviews: [] });
  assert.equal(database.poolQueries.length, 1);
});

test("sale review validation and editor denial happen before connection acquisition", async (context) => {
  const database = createDatabase();
  let editorCalls = 0;
  const denied = await startRouter(baseOptions(database, {
    requireEditor(_req, res) {
      editorCalls += 1;
      res.status(403).json({ error: "editor_required" });
      return false;
    },
  }));
  const validationDatabase = createDatabase();
  const validation = await startRouter(baseOptions(validationDatabase));
  context.after(async () => Promise.all([denied.close(), validation.close()]));

  const invalidId = await saveReview(denied.baseUrl, "bad-id", { condition_rating: "C3" });
  assert.equal(invalidId.status, 400);
  assert.deepEqual(await invalidId.json(), { error: "invalid_source_record_id" });
  assert.equal(editorCalls, 0);

  const deniedResponse = await saveReview(denied.baseUrl, "71", { condition_rating: "C3" });
  assert.equal(deniedResponse.status, 403);
  assert.deepEqual(await deniedResponse.json(), { error: "editor_required" });
  assert.equal(editorCalls, 1);
  assert.equal(database.clients.length, 0);

  const invalidRating = await saveReview(validation.baseUrl, "71", { condition_rating: "C7" });
  assert.equal(invalidRating.status, 400);
  assert.deepEqual(await invalidRating.json(), { error: "invalid_condition_rating" });
  assert.equal(validationDatabase.clients.length, 0);
});

test("valid comparable rating updates use the shared normalizer and preserve audited writes", async (context) => {
  const review = {
    source_record_id: "71",
    listing_id: "MLS-71",
    condition_rating: "C3",
    quality_rating: "Q4",
    notes: "Verified at inspection",
    reviewer: "Appraiser One",
    revision: 3,
  };
  const database = createDatabase({
    clientQuery: async (sql) => {
      if (sql.includes("FROM core.sales_source_records")) {
        return { rows: [{ id: "71", listing_id: "MLS-71" }] };
      }
      if (sql.includes("SELECT * FROM app.sale_characteristic_reviews")) {
        return { rows: [{ revision: 2 }] };
      }
      if (sql.includes("INSERT INTO app.sale_characteristic_reviews")) {
        return { rows: [review] };
      }
      return { rows: [] };
    },
  });
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const response = await saveReview(server.baseUrl, "71", {
    condition_rating: " c3 ",
    quality_rating: " q4 ",
    notes: "  Verified at inspection  ",
    reviewer: "  Appraiser One  ",
    expected_revision: 2,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, review });
  const client = database.clients[0];
  assert.equal(client.released, true);
  assert.deepEqual(client.queries.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" ")), [
    "BEGIN",
    "SELECT id, listing_id",
    "SELECT * FROM",
    "INSERT INTO app.sale_characteristic_reviews",
    "INSERT INTO app.sale_characteristic_review_history",
    "COMMIT",
  ]);
  assert.deepEqual(client.queries[3].params, [
    "71",
    "MLS-71",
    "C3",
    "Q4",
    "Verified at inspection",
    "Appraiser One",
    3,
  ]);
  assert.deepEqual(client.queries[4].params, [
    review.source_record_id,
    review.listing_id,
    review.condition_rating,
    review.quality_rating,
    review.notes,
    review.reviewer,
    review.revision,
  ]);
});

test("missing sources and revision conflicts roll back without writing review history", async (context) => {
  const missingDatabase = createDatabase({
    clientQuery: async (sql) => (
      sql.includes("FROM core.sales_source_records") ? { rows: [] } : { rows: [] }
    ),
  });
  const conflictDatabase = createDatabase({
    clientQuery: async (sql) => {
      if (sql.includes("FROM core.sales_source_records")) {
        return { rows: [{ id: "71", listing_id: "MLS-71" }] };
      }
      if (sql.includes("SELECT * FROM app.sale_characteristic_reviews")) {
        return { rows: [{ revision: 5 }] };
      }
      return { rows: [] };
    },
  });
  const missing = await startRouter(baseOptions(missingDatabase));
  const conflict = await startRouter(baseOptions(conflictDatabase));
  context.after(async () => Promise.all([missing.close(), conflict.close()]));

  const missingResponse = await saveReview(missing.baseUrl, "71", { condition_rating: "C3" });
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "sale_source_record_not_found" });
  assert.equal(missingDatabase.clients[0].queries.at(-1).sql, "ROLLBACK");
  assert.equal(missingDatabase.clients[0].released, true);

  const conflictResponse = await saveReview(conflict.baseUrl, "71", {
    condition_rating: "C3",
    expected_revision: 4,
  });
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    error: "rating_revision_conflict",
    current_revision: 5,
  });
  assert.equal(conflictDatabase.clients[0].queries.at(-1).sql, "ROLLBACK");
  assert.equal(
    conflictDatabase.clients[0].queries.some(({ sql }) => sql.includes("review_history")),
    false,
  );
  assert.equal(conflictDatabase.clients[0].released, true);
});

test("sale review update failures roll back, release, and keep diagnostics out of responses", async (context) => {
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const database = createDatabase({
    clientQuery: async (sql) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      throw diagnostic;
    },
  });
  const server = await startRouter(baseOptions(database, {
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const response = await saveReview(server.baseUrl, "71", { condition_rating: "C3" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "sale_review_update_failed" });
  assert.deepEqual(logs, [["/api/sales/:sourceRecordId/review failed", diagnostic]]);
  assert.deepEqual(database.clients[0].queries.map(({ sql }) => sql), [
    "BEGIN",
    "SELECT id, listing_id FROM core.sales_source_records WHERE id = $1 FOR SHARE",
    "ROLLBACK",
  ]);
  assert.equal(database.clients[0].released, true);
});

test("sale review history validates IDs and returns only the requested source record", async (context) => {
  const history = [{ source_record_id: "71", revision: 3, condition_rating: "C3" }];
  const database = createDatabase({ query: async () => ({ rows: history }) });
  const server = await startRouter(baseOptions(database));
  context.after(server.close);

  const invalid = await fetch(`${server.baseUrl}/api/sales/bad-id/review-history`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_source_record_id" });
  assert.equal(database.poolQueries.length, 0);

  const response = await fetch(`${server.baseUrl}/api/sales/71/review-history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { history });
  assert.equal(database.poolQueries.length, 1);
  assert.deepEqual(database.poolQueries[0].params, ["71"]);
  assert.ok(database.poolQueries[0].sql.includes("WHERE source_record_id = $1"));
  assert.ok(database.poolQueries[0].sql.includes("ORDER BY revision DESC, changed_at DESC"));
});

test("sale review read failures return stable codes and bounded diagnostics", async (context) => {
  const diagnostic = new Error("database db.internal secret-token");
  const logs = [];
  const database = createDatabase({ query: async () => { throw diagnostic; } });
  const server = await startRouter(baseOptions(database, {
    logger: { error: (...args) => logs.push(args) },
  }));
  context.after(server.close);

  const batch = await fetch(`${server.baseUrl}/api/sales/reviews?source_record_ids=71`);
  assert.equal(batch.status, 500);
  assert.deepEqual(await batch.json(), { error: "sale_reviews_failed" });
  const history = await fetch(`${server.baseUrl}/api/sales/71/review-history`);
  assert.equal(history.status, 500);
  assert.deepEqual(await history.json(), { error: "sale_review_history_failed" });
  assert.deepEqual(logs, [
    ["/api/sales/reviews failed", diagnostic],
    ["sale review history failed", diagnostic],
  ]);
});

test("sale review composition is explicit and inline handlers are absent", () => {
  const database = createDatabase();
  assert.throws(
    () => createSaleReviewRouter(baseOptions(database, { pool: null })),
    /sale_review_pool_required/,
  );
  assert.throws(
    () => createSaleReviewRouter(baseOptions(database, { ratingsReady: null })),
    /sale_review_readiness_required/,
  );
  assert.throws(
    () => createSaleReviewRouter(baseOptions(database, { requireEditor: null })),
    /sale_review_editor_policy_required/,
  );

  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const reconciliation = source.indexOf("app.use(createSalesReconciliationRouter(");
  const reviews = source.indexOf("app.use(createSaleReviewRouter(");
  const ratings = source.indexOf("app.use(createAppraisalRatingsRouter(");
  assert.ok(reviews > reconciliation);
  assert.ok(ratings > reviews);
  assert.equal(source.includes('app.get("/api/sales/reviews"'), false);
  assert.equal(source.includes('app.patch("/api/sales/:sourceRecordId/review"'), false);
  assert.equal(source.includes('app.get("/api/sales/:sourceRecordId/review-history"'), false);
});
